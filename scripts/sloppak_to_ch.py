#!/usr/bin/env python3
"""Drums feedpak -> Clone Hero / YARG song folder (notes.mid + song.ini + OGG stems).

Usage:
    python scripts/sloppak_to_ch.py SONG.sloppak OUT_DIR [--part ID] [-v]

The inverse of scripts/ch_to_sloppak.py, for the pack's drums. notes.mid gets:

- a tempo map + time signatures rebuilt from the pack's beat grid (480 ticks per
  beat; a pickup before the first beat), and EVENTS sections;
- PART DRUMS from the drum part's ``drum_tab`` (the primary part, or ``--part``):
  pieces fold onto 4-lane pro pads (lib/drumchart.py PIECE_TO_PAD); cymbals are
  the MIDI default and toms get tom markers (110/111/112); ``x2`` kicks go on note
  95; ``a`` / ``g`` become velocity 127 / 1 under [ENABLE_CHART_DYNAMICS]; the
  tab's ``levels`` become the Easy/Medium/Hard parts; ``star_power`` (116),
  ``fills`` (120-124) and ``solos`` (103) become their phrase notes.

The MIDI layout follows YARG.Core's MidIOHelper / MidReader (LGPL-3.0, see
lib/drumchart.py). Stems: drums/bass/guitar/vocals/piano(keys)/other(song) are
copied as OGG; the ``full`` mix becomes song.ogg when there are no other stems.
Cover -> album.<ext>.
"""

from __future__ import annotations

import argparse
import bisect
import logging
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "lib"))

import audio  # noqa: E402
import drumchart  # noqa: E402
import sloppak  # noqa: E402

log = logging.getLogger("feedBack.scripts.sloppak_to_ch")

TPQ = 480
STEM_TO_CH = {"drums": "drums", "bass": "bass", "guitar": "guitar", "vocals": "vocals", "piano": "keys",
              "other": "song", "full": "song"}
TOM_MARKER = {"yellow": 110, "blue": 111, "green": 112}
PAD_INDEX = {p: i for i, p in enumerate(drumchart.PADS)}


# ── tempo map from beats ────────────────────────────────────────────────────

class BeatClock:
    """Seconds <-> ticks from a beat grid. Beat k sits at tick (pickup + k) * TPQ; when the
    first beat isn't at 0 s, a pickup measure of ``pickup`` beats fills the gap."""

    def __init__(self, beats: list[dict], first_event: float | None = None):
        if len(beats) < 2:          # no grid: 120 BPM from 0
            beats = [{"time": 0.5 * i, "measure": i // 4 + 1 if i % 4 == 0 else -1} for i in range(2)]
        bt = [float(b["time"]) for b in beats]
        flags = [b.get("measure", -1) not in (-1, None) for b in beats]
        self.delay = 0.0
        if 0.02 < bt[0] < 0.5 * (bt[1] - bt[0]) and (first_event is None or first_event >= bt[0] - 1e-6):
            # less than half a beat before the grid and nothing in it: song.ini delay, not a pickup
            self.delay = bt[0]
            bt = [t - self.delay for t in bt]
        if bt[0] > 0.02:
            self.pickup = max(1, int(round(bt[0] / (bt[1] - bt[0]))))
            self.times = [0.0] + bt
            self.ticks = [0] + [(self.pickup + k) * TPQ for k in range(len(bt))]
            self.measure_flags = [True] + [False] * (self.pickup - 1) + flags
        else:
            self.pickup = 0
            self.times = [0.0] + bt[1:]
            self.ticks = [k * TPQ for k in range(len(bt))]
            self.measure_flags = flags

    def tick(self, t: float) -> int:
        t = float(t) - self.delay
        if t >= self.times[-1]:
            per = self.times[-1] - self.times[-2]
            return int(round(self.ticks[-1] + (t - self.times[-1]) / per * TPQ))
        if t <= self.times[0]:
            return self.ticks[0]
        i = bisect.bisect_right(self.times, t) - 1
        t0, t1 = self.times[i], self.times[i + 1]
        frac = (t - t0) / (t1 - t0) if t1 > t0 else 0.0
        return int(round(self.ticks[i] + frac * (self.ticks[i + 1] - self.ticks[i])))

    def tempo_events(self) -> list[tuple[int, int]]:
        """[(tick, microseconds per quarter)] - one per beat, deduplicated."""
        out, last = [], None
        for i in range(len(self.times) - 1):
            beats = (self.ticks[i + 1] - self.ticks[i]) / TPQ
            us = int(round((self.times[i + 1] - self.times[i]) / beats * 1_000_000))
            if us <= 0:
                continue
            if us != last:
                out.append((int(self.ticks[i]), us))
                last = us
        return out

    def time_sigs(self) -> list[tuple[int, int]]:
        """[(tick, numerator)] from measure starts (x/4)."""
        starts = [i for i, f in enumerate(self.measure_flags) if f] or [0]
        if starts[0] != 0:
            starts = [0] + starts
        out, last = [], None
        for a, b in zip(starts, starts[1:] + [len(self.measure_flags)]):
            num = max(1, min(b - a, 16))
            if num != last:
                out.append((a * TPQ, num))
                last = num
        return out


# ── tracks ──────────────────────────────────────────────────────────────────

def _msgs_track(name, events):
    """events: (tick, order, mido message) -> MidiTrack with delta times."""
    import mido
    tr = mido.MidiTrack()
    tr.append(mido.MetaMessage("track_name", name=name, time=0))
    last = 0
    for tick, _, msg in sorted(events, key=lambda e: (e[0], e[1])):
        msg.time = max(0, tick - last)
        last = max(last, tick)
        tr.append(msg)
    tr.append(mido.MetaMessage("end_of_track", time=0))
    return tr


def _note(events, tick, note, vel=100, length=TPQ // 8):
    import mido
    events.append((tick, 2, mido.Message("note_on", note=note, velocity=vel)))
    events.append((tick + max(1, length), 1, mido.Message("note_off", note=note, velocity=0)))


def _phrase(events, clock, spans, notes):
    for a, b in spans:
        ta, tb = clock.tick(a), clock.tick(b)
        for n in notes:
            _note(events, ta, n, 100, length=max(1, tb - ta))


def drums_track(tab: dict, clock: BeatClock):
    """PART DRUMS for a drum_tab payload -> (track, Expert note count)."""
    import mido
    hits = drumchart.tab_to_hits(tab.get("hits"))
    levels = [("expert", hits)]
    for lv in drumchart.LOWER_LEVELS:
        entry = (tab.get("levels") or {}).get(lv)
        if isinstance(entry, dict):
            levels.append((lv, drumchart.tab_to_hits(entry.get("hits"))))
    ev = []
    if any(h.dyn for _, lv_hits in levels for h in lv_hits):
        ev.append((0, 0, mido.MetaMessage("text", text="[ENABLE_CHART_DYNAMICS]")))
    toms = set()
    for lv, lv_hits in levels:
        base = drumchart.DIFF_START[lv]
        seen = set()
        for h in lv_hits:
            tk = clock.tick(h.time)
            if h.pad == "kick":
                if h.kick2x and lv != "expert":
                    continue
                note, vel = (base - 1 if h.kick2x else base), 100
            else:
                note = base + PAD_INDEX[h.pad]
                vel = 127 if h.dyn == "accent" else 1 if h.dyn == "ghost" else 100
            if (tk, note) in seen:
                continue
            seen.add((tk, note))
            _note(ev, tk, note, vel)
            if h.pad in TOM_MARKER and not h.cymbal and (tk, h.pad) not in toms:
                toms.add((tk, h.pad))
                _note(ev, tk, TOM_MARKER[h.pad], 100, length=2)      # covers [tk, tk+1], every level
    _phrase(ev, clock, drumchart.tab_spans(tab, "star_power"), [drumchart.MIDI_STARPOWER])
    _phrase(ev, clock, drumchart.tab_spans(tab, "fills"), drumchart.MIDI_FILLS)
    _phrase(ev, clock, drumchart.tab_spans(tab, "solos"), [drumchart.MIDI_SOLO])
    return _msgs_track("PART DRUMS", ev), len(hits)


# ── driver ──────────────────────────────────────────────────────────────────

def _pick_tab(loaded, part: str | None) -> dict | None:
    if part and loaded.drum_parts:
        for p in loaded.drum_parts:
            if p["id"] == part:
                return p["drum_tab"]
        raise ValueError(f"no drum part {part!r} (have: {', '.join(p['id'] for p in loaded.drum_parts)})")
    return loaded.drum_tab


def _copy_audio(files: list[Path], dst: Path) -> None:
    if len(files) == 1 and files[0].suffix.lower() == ".ogg":
        shutil.copyfile(files[0], dst)
        return
    ff = audio._ffmpeg_cmd()
    if not ff:
        raise RuntimeError("ffmpeg is required to mix or transcode these stems")
    cmd = [ff, "-v", "error", "-y"]
    for f in files:
        cmd += ["-i", str(f)]
    if len(files) > 1:
        cmd += ["-filter_complex", f"amix=inputs={len(files)}:duration=longest:normalize=0"]
    subprocess.run(cmd + ["-c:a", "libvorbis", "-q:a", "6", str(dst)], check=True)


def export(pack: Path, out_dir: Path, part: str | None = None) -> dict:
    """Write a CH/YARG song folder for a pack's drum part. Returns a summary dict."""
    import mido
    pack = Path(pack)
    cache = Path(tempfile.mkdtemp(prefix="pak2ch_"))
    try:
        loaded = sloppak.load_song(pack.name, pack.parent, cache)
        tab = _pick_tab(loaded, part)
        if tab is None:
            raise ValueError(f"{pack.name}: no drum_tab to export")
        song, man = loaded.song, loaded.manifest
        beats = [{"time": b.time, "measure": b.measure} for b in song.beats]
        first = min((float(h["t"]) for h in tab.get("hits") or [] if isinstance(h, dict) and "t" in h),
                    default=None)
        clock = BeatClock(beats, first)
        mid = mido.MidiFile(type=1, ticks_per_beat=TPQ)
        sync = [(t, 0, mido.MetaMessage("set_tempo", tempo=us)) for t, us in clock.tempo_events()]
        sync += [(t, 0, mido.MetaMessage("time_signature", numerator=n, denominator=4))
                 for t, n in clock.time_sigs()]
        mid.tracks.append(_msgs_track(str(man.get("title") or "song"), sync))
        mid.tracks.append(_msgs_track("EVENTS", [
            (clock.tick(s.start_time), 0, mido.MetaMessage("text", text=f"[section {s.name}]"))
            for s in song.sections]))
        tr, n = drums_track(tab, clock)
        mid.tracks.append(tr)
        out_dir = Path(out_dir)
        out_dir.mkdir(parents=True, exist_ok=True)
        mid.save(str(out_dir / "notes.mid"))

        src = loaded.source_dir
        groups: dict[str, list[Path]] = {}
        stems = list(loaded.stems)
        if loaded.full_mix and not stems:
            stems = [{"id": "full", "file": loaded.full_mix}]
        for s in stems:
            ch = STEM_TO_CH.get(s.get("id"))
            f = src / str(s.get("file", ""))
            if ch and f.is_file():
                groups.setdefault(ch, []).append(f)
        for ch, files in groups.items():
            _copy_audio(files, out_dir / f"{ch}.ogg")
        cover = man.get("cover")
        if isinstance(cover, str) and cover and (src / cover).is_file():
            shutil.copyfile(src / cover, out_dir / ("album" + Path(cover).suffix.lower()))
        ini = {"name": man.get("title", ""), "artist": man.get("artist", ""), "album": man.get("album", ""),
               "year": man.get("year", "") or "", "charter": "feedBack export",
               "delay": int(round(clock.delay * 1000)),
               "song_length": int(round(float(man.get("duration", 0) or 0) * 1000)),
               "pro_drums": "True", "five_lane_drums": "False", "diff_drums": -1}
        (out_dir / "song.ini").write_text(
            "[song]\n" + "".join(f"{k} = {v}\n" for k, v in ini.items() if v != ""), encoding="utf-8")
        return {"out": str(out_dir), "parts": {"PART DRUMS": n}, "stems": sorted(groups),
                "tempo_events": len(clock.tempo_events())}
    finally:
        shutil.rmtree(cache, ignore_errors=True)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pack", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--part", help="drum part (type: drums arrangement id); default: the primary part")
    ap.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(levelname)s %(message)s")
    try:
        s = export(a.pack, a.out_dir, a.part)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as e:
        log.error("%s", e)
        return 1
    log.info("wrote %s: PART DRUMS %d notes; stems %s", s["out"], s["parts"]["PART DRUMS"],
             ", ".join(s["stems"]) or "none")
    return 0


if __name__ == "__main__":
    sys.exit(main())
