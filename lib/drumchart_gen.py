"""Generated drum gameplay data for charts that lack it.

Rock Band / Clone Hero charts usually carry their own Easy/Medium/Hard parts and
fills; not every source does. `ensure_levels` fills missing lower difficulties by
reducing Expert (feedBack's own rules, `reduce_level`), and `auto_fills` places
star-power activation fills the way YARG does for charts without them. Results are
drumchart.DrumHit lists / (start, end) spans, encoded by `drumchart.drum_tab`.

`auto_fills` is ported from YARG.Core SongChart.AutoGeneration
(ParseForActivationPhrases) — Copyright (c) YARC (YARG) contributors, LGPL-3.0
(https://github.com/YARC-Official/YARG.Core/blob/master/LICENSE) — and is
distributed as part of feedBack under AGPL-3.0, as described in lib/drumchart.py.
"""

from __future__ import annotations

import bisect

from drumchart import LOWER_LEVELS, DrumChart, DrumHit


# ── difficulty reduction (for sources without hand-charted lower levels) ───

# Fitted on 136 hand-authored Rock Band / Clone Hero charts (their Easy/Medium/Hard vs
# their Expert): F1 of matching notes vs the human levels Easy 0.67, Medium 0.78, Hard 0.89,
# note counts 1.12x / 0.98x / 1.05x the human charts. Easy never pairs a kick with hands.
REDUCE = {   # level: (grid in beats, max gems per chord, kick together with hands?)
    "hard": (0.5, 3, True),
    "medium": (1.0, 2, True),
    "easy": (1.0, 2, False),
}
_HAND_PRIORITY = {("red", False): 0, ("yellow", True): 1, ("green", True): 2, ("blue", True): 3,
                  ("yellow", False): 4, ("blue", False): 5, ("green", False): 6}


def _beat_pos(bt, t):
    """Fractional beat index of time t on beat grid bt."""
    if len(bt) < 2:
        return t / 0.5
    i = min(max(bisect.bisect_right(bt, t) - 1, 0), len(bt) - 2)
    return i + (t - bt[i]) / (bt[i + 1] - bt[i])


def reduce_level(hits, beats, level: str) -> list[DrumHit]:
    """feedBack's own reduction of an Expert chart for sources without hand-charted
    levels (not from YARG/Harmonix; rules fitted to authored charts, see REDUCE). Drops
    2x kicks and ghost notes; keeps chords on the level's grid (8ths / quarters) first,
    then off-grid ones that still leave a full grid step to both neighbours; caps gems
    per chord (snare and cymbals before toms; a kick is kept with one hand gem except on
    Easy). ``beats``: [(time, measure)]."""
    grid, max_gems, kick_with_hands = REDUCE[level]
    # strictly increasing grid: a beat map can repeat a time (zero-length beat)
    bt = []
    for t in sorted(t for t, _ in beats or []):
        if not bt or t - bt[-1] > 1e-6:
            bt.append(t)
    chords: dict[float, list] = {}
    for h in hits:
        if h.kick2x or h.dyn == "ghost":
            continue
        chords.setdefault(round(h.time, 3), []).append(h)
    ts = sorted(chords)
    pos = {t: _beat_pos(bt, t) for t in ts}
    on = {t for t in ts if abs(pos[t] / grid - round(pos[t] / grid)) < 0.12}
    kept = sorted(on)
    for t in ts:                       # off-grid chords where they don't crowd the grid
        if t in on:
            continue
        i = bisect.bisect_left(kept, t)
        prev_ok = i == 0 or pos[t] - pos[kept[i - 1]] >= grid - 0.05
        next_ok = i == len(kept) or pos[kept[i]] - pos[t] >= grid - 0.05
        if prev_ok and next_ok:
            kept.insert(i, t)
    out = []
    for t in kept:
        hs = sorted({(h.pad, h.cymbal): h for h in chords[t] if h.pad != "kick"}.values(),
                    key=lambda h: _HAND_PRIORITY.get((h.pad, h.cymbal), 9))
        kick = [h for h in chords[t] if h.pad == "kick"][:1]
        if kick and hs and kick_with_hands:
            out.extend(kick + hs[:max_gems - 1])
        elif hs:
            out.extend(hs[:max_gems])
        else:
            out.extend(kick)
    return out


def ensure_levels(chart: DrumChart, beats=None) -> DrumChart:
    """Fill in every missing lower level by reducing Expert (marked as generated)."""
    if beats is None:
        beats = [(b["time"], b["measure"]) for b in chart.beat_list()] if chart.hits else []
    for lv in LOWER_LEVELS:
        if not chart.levels.get(lv):
            chart.levels[lv] = reduce_level(chart.hits, beats, lv)
            if lv not in chart.levels_generated:
                chart.levels_generated.append(lv)
    return chart


# ── fill (star power activation) generation ────────────────────────────────

def _lower_bound(xs, v) -> int:
    """Index of the last element <= v, -1 if none (YARG ChartEventExtensions.LowerBound)."""
    return bisect.bisect_right(xs, v + 1e-9) - 1


def auto_fills(note_times, beats, star_power, solos=(), sections=()) -> list[tuple[float, float]]:
    """Fill (star power activation) phrases, ported from YARG.Core
    SongChart.AutoGeneration.ParseForActivationPhrases: every 4 measures (2 if that's more
    than 10 s away), snapped to section starts, at least 2 s after the last SP/solo/fill,
    only where 16+ notes follow within 4 measures; the fill spans the measure before the
    activation bar line. (Time-signature snapping is skipped: the beat list carries no
    time signatures.) Returns nothing when there is no star power, like YARG."""
    MIN_SPACING, MAX_SPACING, SP_MIN_NOTES = 2.0, 10.0, 16
    measures = [t for t, m in beats if m != -1]
    sp = sorted(star_power)
    if not sp or len(measures) < 6:
        return []
    solos = sorted(solos)
    sections = sorted(sections)
    sp_starts = [a for a, _ in sp]
    solo_starts = [a for a, _ in solos]
    last_solo = solos[-1][1] if solos else 0.0
    nt = sorted(note_times)
    spacing_ref = sp[0][1]
    cur = max(0, _lower_bound(measures, spacing_ref))
    sec_i = _lower_bound(sections, spacing_ref)
    sp_i, solo_i = 0, _lower_bound(solo_starts, spacing_ref)
    out = []
    total = len(measures)
    while cur < total - 4:
        per = 4
        if measures[cur + per] - spacing_ref > MAX_SPACING:
            per = 2
        cur += per
        mt = measures[cur]
        new_sec = _lower_bound(sections, mt)
        if new_sec > sec_i:
            sec_i = new_sec
            cur = max(0, _lower_bound(measures, sections[sec_i]))
            mt = measures[cur]
        new_sp = _lower_bound(sp_starts, mt)
        if new_sp > sp_i:
            sp_i = new_sp
            spacing_ref = max(sp[sp_i][1], spacing_ref)
        if solos and mt < last_solo:
            new_solo = _lower_bound(solo_starts, mt)
            if new_solo > solo_i:
                solo_i = new_solo
                spacing_ref = max(solos[solo_i][1], spacing_ref)
        if mt - spacing_ref < MIN_SPACING:
            continue
        end = measures[min(cur + 4, total - 1)]
        n = bisect.bisect_right(nt, end + 1e-6) - bisect.bisect_right(nt, mt + 1e-6)
        if n < SP_MIN_NOTES:
            continue
        spacing_ref = mt
        if cur >= 1:
            out.append((round(measures[cur - 1], 4), round(mt, 4)))
    return out
