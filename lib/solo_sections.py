"""Guitar-solo detection for feedpak charts.

Several practice features key off a song section named ``solo`` (the section
map colours it, section practice lists it), but charts imported from Guitar Pro
only get the sections the tab's author marked — many tabs carry no markers at
all, or don't mark the solo. This module finds the one guitar solo a song most
likely has and computes the section list with a ``solo`` section inserted.

It is pure: it takes parsed arrangement dicts (the feedpak wire shape, spec §6)
and song-level beats/sections and returns plain data. Reading and writing packs
is the caller's job (see ``scripts/solo_sections.py``).

Detection runs per bar of the *lead part* (see :func:`pick_lead`):

- a bar is **soloish** when at least ``SINGLE_FRAC`` of its events are single
  notes and those notes either sit up the neck (median fret ``>= HIGH_FRET``)
  or come fast (``>= FAST_NPS`` single notes per second);
- a bar is **unique** when its pitch content (the set of string/fret pairs,
  ignoring rhythm) occurs at most twice in the whole part — riffs repeat,
  solos rarely do;
- a **region** is a run of soloish+unique bars, allowing one-bar gaps.

A region is a solo *candidate* when it is at least ``MIN_BARS`` bars and
``MIN_SINGLES`` notes long, high (median fret ``>= SOLO_FRET``) or fast
(``>= SOLO_NPS``), starts between ``POS_MIN`` and ``POS_MAX`` of the song, is at
most ``MAX_BARS`` long, and — when there is a separate rhythm part — the rhythm
part is mostly chording underneath it rather than doubling the line. At most
one solo is chosen per song: the highest candidate on the neck, then the one
with the most notes.
"""

from __future__ import annotations

import re
import statistics
from collections import Counter

SINGLE_FRAC = 0.4   # share of a bar's events that must be single notes
HIGH_FRET = 9       # soloish bar: median single-note fret at/above this ...
FAST_NPS = 3.5      # ... or at least this many single notes per second
MIN_BARS = 4        # candidate region: at least this many bars ...
MIN_SINGLES = 12    # ... and this many single notes
SOLO_FRET = 10      # a solo (vs a lead line): median fret >= this ...
SOLO_NPS = 5.0      # ... or mean single notes per second >= this
POS_MIN, POS_MAX = 0.25, 0.92   # where in the song the solo may start (fraction)
MAX_BARS = 24       # longer "solos" are usually a whole lead part
RHYTHM_CHORD_FRAC = 0.3   # rhythm part chords at least this share under the solo

SOLO_SECTION_NAME = "solo"
_SOLO_RE = re.compile("solo", re.I)
_TIME_EPS = 1e-3


def bars_from_beats(beats: list[dict] | None) -> list[tuple[float, float]]:
    """``(start, end)`` of every bar, from the downbeats in a beats array.

    Downbeats are entries with ``measure >= 0`` (``-1`` marks a sub-beat, spec
    §6.8). The last bar is assumed as long as the one before it. Fewer than two
    downbeats → no bars.
    """
    starts = []
    for b in beats or []:
        if not isinstance(b, dict):
            continue
        try:
            if int(b.get("measure", -1)) >= 0:
                starts.append(float(b["time"]))
        except (KeyError, TypeError, ValueError):
            continue
    starts.sort()
    if len(starts) < 2:
        return []
    last = starts[-1] + (starts[-1] - starts[-2])
    return list(zip(starts, starts[1:] + [last]))


def _events(chart: dict) -> list[tuple[float, str, tuple]]:
    """Time-sorted ``(t, kind, ((string, fret), ...))``; kind ``n`` or ``c``.

    Fret-hand-muted single notes (``mt``) carry no pitch and are dropped.
    """
    ev = []
    for n in chart.get("notes") or []:
        if isinstance(n, dict) and not n.get("mt"):
            ev.append((float(n.get("t", 0)), "n", ((int(n.get("s", 0)), int(n.get("f", 0))),)))
    for c in chart.get("chords") or []:
        if not isinstance(c, dict):
            continue
        pitches = tuple(sorted((int(x.get("s", 0)), int(x.get("f", 0)))
                               for x in c.get("notes") or [] if isinstance(x, dict)))
        ev.append((float(c.get("t", 0)), "c", pitches))
    ev.sort()
    return ev


def bar_stats(chart: dict, bars: list[tuple[float, float]]) -> list[dict]:
    """Per-bar statistics of one arrangement over a bar grid.

    Each entry: ``a``/``b`` (bar start/end), ``n`` (events), ``singles``,
    ``chords``, ``nps`` (single notes per second), ``fret`` (median single-note
    fret, 0 when none), ``unique`` and ``soloish`` (see module docstring).
    """
    ev = _events(chart)
    out, i = [], 0
    sigs = []
    for a, b in bars:
        while i < len(ev) and ev[i][0] < a:
            i += 1
        j = i
        while j < len(ev) and ev[j][0] < b:
            j += 1
        seg = ev[i:j]
        dur = max(b - a, 1e-3)
        singles = [e for e in seg if e[1] == "n"]
        frets = [f for e in singles for _, f in e[2]]
        out.append({
            "a": a, "b": b, "n": len(seg), "singles": len(singles),
            "chords": len(seg) - len(singles), "nps": len(singles) / dur,
            "fret": statistics.median(frets) if frets else 0,
        })
        # Pitch content without timing: a riff repeats it (give or take small
        # rhythm variations), a solo doesn't.
        sigs.append(tuple(sorted({p for e in seg for p in e[2]})))
        i = j
    counts = Counter(sig for s, sig in zip(out, sigs) if s["n"])
    for s, sig in zip(out, sigs):
        s["unique"] = s["n"] > 0 and counts[sig] <= 2
        s["soloish"] = (s["singles"] >= 1 and s["singles"] / max(1, s["n"]) >= SINGLE_FRAC
                        and (s["fret"] >= HIGH_FRET or s["nps"] >= FAST_NPS))
    return out


def pick_lead(names: list[str]) -> str | None:
    """The part to look for a solo in: ``Lead``, else ``Combo``, else the first.

    Matching is case-insensitive on the arrangement name.
    """
    for want in ("lead", "combo"):
        for n in names:
            if str(n).strip().lower() == want:
                return n
    return names[0] if names else None


def _regions(good: list[bool]) -> list[tuple[int, int]]:
    """Index ranges of runs of True, bridging single False gaps."""
    regions, k = [], 0
    while k < len(good):
        if not good[k]:
            k += 1
            continue
        e = k
        while e + 1 < len(good) and (good[e + 1] or (e + 2 < len(good) and good[e + 2])):
            e += 1
        while not good[e]:
            e -= 1
        regions.append((k, e))
        k = e + 1
    return regions


def find_solos(charts: dict[str, dict], beats: list[dict] | None = None) -> tuple[list[dict], str | None]:
    """Find solo candidates in a song's guitar arrangements.

    ``charts`` maps arrangement name → parsed arrangement JSON (guitar parts
    only; the caller filters bass/drums/keys out). ``beats`` is the song-level
    beats array; when omitted, the lead chart's own ``beats`` are used.

    Returns ``(regions, lead_name)``. Each region is a dict with ``start``,
    ``end`` (seconds), ``bars``, ``singles``, ``nps``, ``fret``, ``pos``
    (fraction of the song), ``rhythm_chords`` (None without a rhythm part),
    ``candidate`` and ``solo`` — exactly one region at most has ``solo: True``.
    """
    lead_name = pick_lead(list(charts))
    if lead_name is None:
        return [], None
    lead = charts[lead_name]
    bars = bars_from_beats(beats if beats else lead.get("beats"))
    if not bars:
        return [], lead_name
    ls = bar_stats(lead, bars)
    regions = _regions([x["soloish"] and x["unique"] for x in ls])

    rhythm_name = next((n for n in charts if str(n).strip().lower() == "rhythm"
                        and n != lead_name), None)
    rs = bar_stats(charts[rhythm_name], bars) if rhythm_name else None
    song_end = bars[-1][1]
    out = []
    for k, e in regions:
        seg = ls[k:e + 1]
        nb = len(seg)
        singles = sum(x["singles"] for x in seg)
        fret = statistics.median(x["fret"] for x in seg)
        nps = statistics.mean(x["nps"] for x in seg)
        pos = seg[0]["a"] / song_end if song_end > 0 else 0
        r_chords = None
        if rs:
            rseg = rs[k:e + 1]
            rn = sum(x["n"] for x in rseg)
            r_chords = sum(x["chords"] for x in rseg) / rn if rn else 0.0
        # A solo, not a lead line: up the neck or very fast, mid/late in the
        # song, a sane length, and the rhythm part (when there is one) not
        # doubling it note for note — unless it is very high up the neck.
        candidate = (nb >= MIN_BARS and singles >= MIN_SINGLES
                     and (fret >= SOLO_FRET or nps >= SOLO_NPS)
                     and POS_MIN <= pos <= POS_MAX and nb <= MAX_BARS
                     and (r_chords is None or r_chords >= RHYTHM_CHORD_FRAC
                          or fret >= SOLO_FRET + 2))
        out.append({
            "start": seg[0]["a"], "end": seg[-1]["b"], "bars": nb,
            "singles": singles, "nps": round(nps, 1), "fret": fret,
            "pos": round(pos, 2),
            "rhythm_chords": None if r_chords is None else round(r_chords, 2),
            "candidate": candidate, "solo": False,
        })
    best = max((r for r in out if r["candidate"]),
               key=lambda r: (r["fret"], r["singles"]), default=None)
    if best:
        best["solo"] = True
    return out, lead_name


def has_solo(sections: list[dict] | None) -> bool:
    """True when any section's name mentions a solo (case-insensitive)."""
    return any(isinstance(s, dict) and _SOLO_RE.search(str(s.get("name", "")))
               for s in sections or [])


def _section_time(s: dict) -> float:
    # `start_time` is the legacy alias the loader also accepts.
    return float(s.get("time", s.get("start_time", 0)))


def insert_solo(sections: list[dict] | None, start: float, end: float) -> tuple[list[dict], int]:
    """Section list with a ``solo`` section from ``start`` to ``end``.

    The section that was running at ``end`` resumes there, so the song's
    structure after the solo is unchanged. Sections that started inside the
    solo are absorbed by it; their count is returned alongside the new list.
    An empty list is treated as one ``default`` section from 0 s.
    Names that repeat are renumbered in time order. The input is not mutated.
    Callers are expected to check :func:`has_solo` first — this never removes
    an existing solo section outside the region, but it does not look for one.
    """
    secs = []
    for s in sections or []:
        if isinstance(s, dict):
            d = dict(s)
            d["time"] = _section_time(d)
            d.pop("start_time", None)
            secs.append(d)
    secs.sort(key=lambda s: s["time"])
    if not secs:
        # Same fallback the Guitar Pro importer emits for a tab without
        # markers, so the song still has a section to resume after the solo.
        secs = [{"name": "default", "number": 1, "time": 0.0}]
    resume = None
    for s in secs:
        if s["time"] <= end:
            resume = s
    inside = [s for s in secs if start <= s["time"] < end]
    keep = [s for s in secs if not (start <= s["time"] < end)]
    keep.append({"name": SOLO_SECTION_NAME, "number": 1, "time": round(start, 3)})
    if resume is not None and not any(abs(s["time"] - end) < _TIME_EPS for s in keep):
        keep.append({"name": resume.get("name", ""), "number": 1, "time": round(end, 3)})
    keep.sort(key=lambda s: s["time"])
    seen: Counter = Counter()
    for s in keep:
        seen[s.get("name", "")] += 1
        s["number"] = seen[s.get("name", "")]
    return keep, len(inside)
