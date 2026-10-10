"""Rock Band / Clone Hero / YARG drum charts → feedpak `drum_tab.json`.

Reads the drums part of a ``notes.mid`` (PART DRUMS) or ``notes.chart``
([ExpertDrums] and the easier difficulties) plus ``song.ini``, and turns it
into 4-lane pro-drums hits with absolute (audio) times, a tempo map, beats,
sections, star-power phrases, fills and solos. `drum_tab()` encodes the result
as a feedpak `drum_tab.json` payload — piece-ids through `lib/drums.py`, the
gameplay keys per feedpak 1.20.0 §7.5 "Drum gameplay metadata" — and
`song_timeline()` as a `song_timeline.json` payload. Generated levels and
fills for charts that lack them live in lib/drumchart_gen.py.

The chart-parsing rules are ported from YARG.Core (MoonscraperChartParser:
MidReader / MidReader.ProcessLists / MidIOHelper / ChartReader /
ChartReader.ProcessLists / ChartIOHelper; Chart/Loaders/MoonSong/
MoonSongLoader.Drums.cs; Parsing/TextEvents.cs):

    Copyright (c) 2016-2020 Alexander Ong (Moonscraper)
    Copyright (c) YARC (YARG) contributors
    Licensed under the GNU Lesser General Public License v3.0
    (https://github.com/YARC-Official/YARG.Core/blob/master/LICENSE).

Ported to Python and modified (drums rules only, no Elite Drums). Distributed
here as part of feedBack under AGPL-3.0, which LGPL-3.0 permits: LGPL-3.0 is
GPL-3.0 plus additional permissions, and GPL-3.0 section 13 allows combining
with AGPL-3.0 code.

Rules implemented (YARG behaviour in brackets):
- MIDI pads 96..101 (Expert; 84/72/60 for Hard/Medium/Easy) = kick, red,
  yellow, blue, orange (4-lane green), green (5-lane); 95 = 2x kick
  [InstrumentPlus]. Yellow/blue/orange default to cymbals; tom markers
  110/111/112 XOR the cymbal flag for that pad over [start, end-1] ticks.
- MIDI dynamics only when the track has the ``[ENABLE_CHART_DYNAMICS]`` text
  event: velocity 127 = accent, 1 = ghost, never on kicks.
- .chart ``N 0..5`` = kick..green, ``N 32`` = 2x kick, ``N 66/67/68`` = cymbal
  markers for yellow/blue/orange (pads default to toms), ``N 34..38`` accents
  and ``N 40..44`` ghosts for red..green. ``S 2`` star power, ``S 64`` fill.
- 5-lane charts (any 5-lane green note, or ``five_lane_drums`` in song.ini) are
  converted to 4-lane pro with YARG's table (yellow->Y cym, blue->B tom,
  orange->G cym, green->G tom, orange+green chord -> B cym + G tom).
- Disco flip (``[mix <d> drums<n>d]``) swaps red <-> yellow cymbal until the
  next mix event.
- Star power = MIDI 116 / .chart S 2; fills (activation) = MIDI 120..124 /
  S 64; solos = MIDI 103; sections = ``[section x]`` / ``[prc_x]`` text events.
- ``song.ini`` ``delay`` (ms; .chart ``Offset`` seconds as fallback): chart
  time = audio time - delay [SongRunner.AudioTime], so audio time = chart
  time + delay.
"""

from __future__ import annotations

import bisect
import configparser
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

import drums as drums_mod

log = logging.getLogger("feedBack.lib.drumchart")

PADS = ("kick", "red", "yellow", "blue", "green")

# 4-lane pro pad (+cymbal) -> General MIDI drum note. `drums.midi_to_piece`
# turns these into drum_tab piece-ids (hh_closed, tom_hi, ride, tom_mid,
# crash_l, tom_floor, ...), so the piece vocabulary stays owned by lib/drums.py.
GM_KICK, GM_KICK2X, GM_SNARE = 36, 35, 38
PAD_TO_GM = {
    ("kick", False): GM_KICK,
    ("red", False): GM_SNARE,
    ("yellow", True): 42,    # closed hi-hat
    ("yellow", False): 48,   # hi tom
    ("blue", True): 51,      # ride
    ("blue", False): 45,     # mid tom
    ("green", True): 49,     # crash
    ("green", False): 41,    # floor tom
}

# drum_tab piece-id -> 4-lane pro pad (+cymbal), for writing a chart back out
# (scripts/sloppak_to_ch.py). Covers the whole closed vocabulary in lib/drums.py.
PIECE_TO_PAD = {
    "kick": ("kick", False),
    "snare": ("red", False), "snare_xstick": ("red", False),
    "hh_closed": ("yellow", True), "hh_open": ("yellow", True), "hh_pedal": ("yellow", True),
    "tom_hi": ("yellow", False),
    "tom_mid": ("blue", False),
    "tom_low": ("green", False), "tom_floor": ("green", False),
    "ride": ("blue", True), "ride_bell": ("blue", True),
    "crash_l": ("green", True), "crash_r": ("green", True), "splash": ("green", True),
    "china": ("green", True), "stack": ("green", True), "bell": ("green", True),
}

# MIDI (RB / PS / CH) constants - MidIOHelper.cs
DRUM_TRACK_NAMES = ("PART DRUMS", "PART DRUM", "PART REAL_DRUMS_PS")
DIFF_START = {"easy": 60, "medium": 72, "hard": 84, "expert": 96}
MIDI_STARPOWER, MIDI_SOLO = 116, 103
MIDI_FILLS = (120, 121, 122, 123, 124)
MIDI_TOM_MARKERS = {110: 2, 111: 3, 112: 4}      # -> raw pad index (yellow, blue, orange)
VELOCITY_ACCENT, VELOCITY_GHOST = 127, 1
CHART_DYNAMICS_TEXT = "ENABLE_CHART_DYNAMICS"

# Raw (Moonscraper) pad indices
RAW_KICK, RAW_RED, RAW_YELLOW, RAW_BLUE, RAW_ORANGE, RAW_GREEN = range(6)

# Easier difficulties, easiest first — the feedpak 1.20.0 `levels` ids.
LOWER_LEVELS = ("easy", "medium", "hard")


@dataclass
class DrumHit:
    time: float          # seconds, audio time (song.ini delay applied)
    pad: str             # kick/red/yellow/blue/green (4-lane pro)
    cymbal: bool = False
    kick2x: bool = False
    dyn: str | None = None   # "accent" | "ghost" | None
    tick: int = 0

    @property
    def gm(self) -> int:
        if self.pad == "kick":
            return GM_KICK2X if self.kick2x else GM_KICK
        return PAD_TO_GM[(self.pad, self.cymbal if self.pad != "red" else False)]


@dataclass
class TempoMap:
    resolution: int
    tempos: list = field(default_factory=lambda: [(0, 120.0)])     # (tick, bpm)
    time_sigs: list = field(default_factory=lambda: [(0, 4, 4)])   # (tick, numerator, denominator)

    def __post_init__(self):
        self.tempos = sorted(self.tempos) or [(0, 120.0)]
        if self.tempos[0][0] != 0:
            self.tempos.insert(0, (0, 120.0))
        self.time_sigs = sorted(self.time_sigs) or [(0, 4, 4)]
        if self.time_sigs[0][0] != 0:
            self.time_sigs.insert(0, (0, 4, 4))
        # cumulative seconds at each tempo change
        self._starts = [0.0]
        for (t0, bpm), (t1, _) in zip(self.tempos, self.tempos[1:]):
            self._starts.append(self._starts[-1] + (t1 - t0) / self.resolution * 60.0 / bpm)

    def tick_to_time(self, tick: float) -> float:
        i = max(bisect.bisect_right([t for t, _ in self.tempos], tick) - 1, 0)
        t0, bpm = self.tempos[i]
        return self._starts[i] + (tick - t0) / self.resolution * 60.0 / bpm

    def time_to_tick(self, time: float) -> float:
        i = max(bisect.bisect_right(self._starts, time) - 1, 0) if time > 0 else 0
        t0, bpm = self.tempos[i]
        return t0 + (time - self._starts[i]) * bpm / 60.0 * self.resolution

    def beats(self, end_tick: float) -> list[tuple[int, int]]:
        """[(tick, measure number or -1)] for every beat up to end_tick (inclusive of the
        measure containing it). Beat unit = 1/denominator note."""
        out = []
        measure = 0
        sigs = self.time_sigs + [(float("inf"), 4, 4)]
        for (t0, num, den), (t1, _, _) in zip(sigs, sigs[1:]):
            num = max(1, num)
            step = self.resolution * 4 / max(1, den)
            tick = t0
            while tick < t1:
                if tick > end_tick:
                    return out
                measure += 1
                for b in range(num):
                    bt = tick + b * step
                    if bt >= t1:
                        break
                    out.append((int(round(bt)), measure if b == 0 else -1))
                tick += num * step
        return out


@dataclass
class DrumChart:
    hits: list[DrumHit]
    tempo: TempoMap
    offset: float = 0.0                    # seconds added to chart time (song.ini delay)
    sections: list = field(default_factory=list)      # (time, name)
    star_power: list = field(default_factory=list)    # (start, end) seconds
    fills: list = field(default_factory=list)         # (start, end)
    solos: list = field(default_factory=list)         # (start, end)
    source_format: str = ""
    five_lane: bool = False
    dynamics: bool = False
    levels: dict = field(default_factory=dict)          # "easy"/"medium"/"hard" -> [DrumHit]
    levels_generated: list = field(default_factory=list)  # which of those were reduced by software

    def beat_list(self) -> list[dict]:
        end = max((h.tick for h in self.hits), default=0)
        return [{"time": round(self.tempo.tick_to_time(t) + self.offset, 3), "measure": m}
                for t, m in self.tempo.beats(end)]


# ── song.ini ────────────────────────────────────────────────────────────────

def load_song_ini(path: Path) -> dict:
    """[song]/[Song] section of a song.ini as a lowercase-key dict ({} if missing)."""
    path = Path(path)
    if not path.exists():
        return {}
    cp = configparser.ConfigParser(interpolation=None, strict=False, comment_prefixes=(";", "#", "//"))
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    try:
        cp.read_string(text)
    except configparser.MissingSectionHeaderError:
        cp.read_string("[song]\n" + text)
    for sec in cp.sections():
        if sec.strip().lower() == "song":
            return {k.strip().lower(): v.strip() for k, v in cp.items(sec)}
    return {}


def ini_bool(v) -> bool:
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def ini_delay_seconds(ini: dict, chart_offset: float = 0.0) -> float:
    """song.ini ``delay`` (ms) wins; ``delay_seconds`` / .chart Offset are fallbacks."""
    try:
        d = int(float(ini.get("delay", 0) or 0))
    except ValueError:
        d = 0
    if d:
        return d / 1000.0
    try:
        if ini.get("delay_seconds"):
            return float(ini["delay_seconds"])
    except ValueError:
        pass
    return float(chart_offset or 0.0)


# ── shared post-processing (MoonSongLoader.Drums) ───────────────────────────

@dataclass
class _RawNote:
    tick: int
    pad: int                 # raw pad 0..5
    cymbal: bool = False
    plus: bool = False       # 2x kick
    dyn: str | None = None


def _normalize_text(text: str) -> str:
    m = re.search(r"\[(.*?)\]", text)
    return (m.group(1) if m else text).strip()


def _section_name(text: str) -> str | None:
    t = _normalize_text(text)
    for p in ("section", "prc"):
        if t.startswith(p):
            name = t[len(p):].lstrip("_").strip()
            return name.replace("_", " ") or None
    return None


def _mix_event(text: str):
    """(difficulty, setting) for [mix <d> drums<c><setting>], else None (TextEvents)."""
    m = re.match(r"mix[ _]*([0-3])[ _]*drums[ _]*([0-5])(.*)$", _normalize_text(text))
    if not m:
        return None
    diff = ("easy", "medium", "hard", "expert")[int(m.group(1))]
    s = m.group(3).strip()
    setting = {"d": "disco", "dnoflip": "disco_noflip", "easy": "easy", "easynokick": "easynokick"}.get(s, "none")
    return diff, setting


def _to_four_lane(raw: list[_RawNote], five_lane: bool, mix: list[tuple[int, str]]) -> list[tuple]:
    """Raw notes -> [(tick, pad, cymbal, plus, dyn)] 4-lane pro (GetFourLaneDrumPad)."""
    by_tick: dict[int, list[_RawNote]] = {}
    for n in raw:
        by_tick.setdefault(n.tick, []).append(n)
    mix = sorted(mix)
    out = []
    for n in raw:
        if five_lane:
            pad, cym = {RAW_KICK: ("kick", False), RAW_RED: ("red", False), RAW_YELLOW: ("yellow", True),
                        RAW_BLUE: ("blue", False), RAW_ORANGE: ("green", True),
                        RAW_GREEN: ("green", False)}[n.pad]
            if n.pad == RAW_ORANGE and any(o.pad == RAW_GREEN for o in by_tick[n.tick] if o is not n):
                pad, cym = "blue", True
        else:
            pad = {RAW_KICK: "kick", RAW_RED: "red", RAW_YELLOW: "yellow", RAW_BLUE: "blue",
                   RAW_ORANGE: "green", RAW_GREEN: "green"}[n.pad]
            cym = n.cymbal and pad in ("yellow", "blue", "green")
            setting = "none"
            for t, s in mix:
                if t <= n.tick:
                    setting = s
            if setting == "disco":
                if pad == "red":
                    pad, cym = "yellow", True
                elif pad == "yellow":
                    pad, cym = "red", False
        out.append((n.tick, pad, cym, n.plus and pad == "kick", n.dyn))
    # one gem per (tick, pad, cymbal, 2x)
    seen, uniq = set(), []
    for t in sorted(out, key=lambda x: (x[0], PADS.index(x[1]), x[2])):
        k = t[:4]
        if k not in seen:
            seen.add(k)
            uniq.append(t)
    return uniq


def _finish(raw, five_lane, mix, tempo: TempoMap, offset, sections, sp, fills, solos, fmt, dynamics):
    hits = [DrumHit(time=round(tempo.tick_to_time(t) + offset, 4), pad=p, cymbal=c, kick2x=k, dyn=d, tick=t)
            for t, p, c, k, d in _to_four_lane(raw, five_lane, mix)]

    def span(rng):
        return sorted({(round(tempo.tick_to_time(a) + offset, 4), round(tempo.tick_to_time(b) + offset, 4))
                       for a, b in rng})
    return DrumChart(hits=hits, tempo=tempo, offset=offset,
                     sections=[(round(tempo.tick_to_time(t) + offset, 4), n) for t, n in sorted(sections)],
                     star_power=span(sp), fills=span(fills), solos=span(solos),
                     source_format=fmt, five_lane=five_lane, dynamics=dynamics)


# ── notes.mid ───────────────────────────────────────────────────────────────

def parse_mid(path: Path, ini: dict | None = None, difficulty: str = "expert") -> DrumChart:
    import mido
    ini = ini or {}
    mid = mido.MidiFile(str(path), clip=True)   # Phase Shift sysex carries bytes > 127
    if mid.ticks_per_beat <= 0:
        raise ValueError("SMPTE-timed MIDI files are not supported")
    tempos, sigs, sections = [], [], []
    drum_track = None
    for tr in mid.tracks:
        name = next((m.name for m in tr if m.type == "track_name"), "").strip()
        tick = 0
        for m in tr:
            tick += m.time
            if m.type == "set_tempo":
                tempos.append((tick, 60_000_000 / m.tempo))
            elif m.type == "time_signature":
                sigs.append((tick, m.numerator, m.denominator))
        up = name.upper()
        if up == "EVENTS":
            tick = 0
            for m in tr:
                tick += m.time
                if m.type in ("text", "marker", "lyrics"):
                    s = _section_name(m.text)
                    if s:
                        sections.append((tick, s))
        if up in DRUM_TRACK_NAMES:
            # PART DRUMS overrides; the alternates only fill in when it's missing (TrackOverrides)
            if drum_track is None or up == "PART DRUMS":
                drum_track = tr
    if drum_track is None:
        raise ValueError(f"{Path(path).name}: no PART DRUMS track")
    # tempo changes at the same tick: last one wins
    tempo = TempoMap(mid.ticks_per_beat, list({t: b for t, b in sorted(tempos)}.items()),
                     list({t: (t, n, d) for t, n, d in sorted(sigs)}.values()))

    base = DIFF_START[difficulty]
    texts, events = [], []     # (tick, text); (start, end, note, velocity)
    open_notes: dict[tuple, list] = {}
    tick = 0
    for m in drum_track:
        tick += m.time
        if m.type in ("text", "marker", "lyrics"):
            texts.append((tick, m.text))
        elif m.type == "note_on" and m.velocity > 0:
            open_notes.setdefault((m.note, m.channel), []).append((tick, m.velocity))
        elif m.type == "note_off" or (m.type == "note_on" and m.velocity == 0):
            q = open_notes.get((m.note, m.channel))
            if q:
                st, vel = q.pop(0)
                events.append((st, tick, m.note, vel))
    for (note, _), q in open_notes.items():   # unterminated: zero length
        events += [(st, st, note, vel) for st, vel in q]
    events.sort()

    dynamics = any(_normalize_text(t) == CHART_DYNAMICS_TEXT for _, t in texts)
    raw, sp, fills, solos, markers = [], [], [], [], []
    for st, en, note, vel in events:
        off = note - base
        if 0 <= off <= 5:
            dyn = None
            if dynamics and off != RAW_KICK:
                dyn = "accent" if vel == VELOCITY_ACCENT else "ghost" if vel == VELOCITY_GHOST else None
            raw.append(_RawNote(st, off, cymbal=off in (RAW_YELLOW, RAW_BLUE, RAW_ORANGE), dyn=dyn))
        elif note == base - 1 and difficulty == "expert":
            raw.append(_RawNote(st, RAW_KICK, plus=True))
        elif note == MIDI_STARPOWER:
            sp.append((st, en))
        elif note in MIDI_FILLS:
            fills.append((st, en))
        elif note == MIDI_SOLO:
            solos.append((st, en))
        elif note in MIDI_TOM_MARKERS:
            markers.append((st, en, MIDI_TOM_MARKERS[note]))
    raw.sort(key=lambda n: (n.tick, n.pad))
    # tom markers toggle the cymbal flag of that pad's notes in [start, end-1]
    for st, en, pad in markers:
        last = en - 1 if en > st else en
        for n in raw:
            if n.pad == pad and st <= n.tick <= last:
                n.cymbal = not n.cymbal
    five = ini_bool(ini.get("five_lane_drums", "")) or any(n.pad == RAW_GREEN for n in raw)
    mix = [(t, ev[1]) for t, txt in texts if (ev := _mix_event(txt)) and ev[0] == difficulty]
    return _finish(raw, five, mix, tempo, ini_delay_seconds(ini), sections, sp, fills, solos,
                   "mid", dynamics)


# ── notes.chart ─────────────────────────────────────────────────────────────

_CHART_SECTION = re.compile(r"^\s*\[([^\]]+)\]\s*$")


def _chart_sections(text: str) -> dict[str, list[str]]:
    out, cur, body = {}, None, None
    for line in text.splitlines():
        m = _CHART_SECTION.match(line)
        if m and body is None:
            cur = m.group(1).strip()
            continue
        s = line.strip()
        if s == "{":
            body = []
        elif s == "}":
            if cur is not None and body is not None:
                out[cur] = body
            cur, body = None, None
        elif body is not None and s:
            body.append(s)
    return out


def _chart_song_section(secs: dict) -> dict:
    song = {}
    for line in secs.get("Song", []):
        k, _, v = line.partition("=")
        song[k.strip()] = v.strip().strip('"')
    return song


def parse_chart(path: Path, ini: dict | None = None, difficulty: str = "expert") -> DrumChart:
    ini = ini or {}
    secs = _chart_sections(Path(path).read_text(encoding="utf-8-sig", errors="replace"))
    song = _chart_song_section(secs)
    res = int(float(song.get("Resolution", 192)))
    tempos, sigs = [], []
    for line in secs.get("SyncTrack", []):
        k, _, v = line.partition("=")
        parts = v.split()
        if not parts:
            continue
        t = int(k.strip())
        if parts[0] == "B":
            tempos.append((t, int(parts[1]) / 1000.0))
        elif parts[0] == "TS":
            den = 2 ** int(parts[2]) if len(parts) > 2 else 4
            sigs.append((t, int(parts[1]), den))
    tempo = TempoMap(res, tempos, sigs)
    sections = []
    for line in secs.get("Events", []):
        k, _, v = line.partition("=")
        parts = v.strip().split(None, 1)
        if len(parts) == 2 and parts[0] == "E":
            s = _section_name(parts[1].strip().strip('"'))
            if s:
                sections.append((int(k.strip()), s))
    name = difficulty.capitalize() + "Drums"
    track = secs.get(name)
    if track is None:
        raise ValueError(f"{Path(path).name}: no [{name}] section")
    raw, flags, sp, fills, texts = [], [], [], [], []
    for line in track:
        k, _, v = line.partition("=")
        parts = v.split()
        if len(parts) < 2:
            continue
        t = int(k.strip())
        if parts[0] == "N":
            n = int(parts[1])
            if 0 <= n <= 5:
                raw.append(_RawNote(t, n))
            elif n == 32:
                raw.append(_RawNote(t, RAW_KICK, plus=True))
            elif n in (66, 67, 68):
                flags.append((t, n - 64, "cymbal"))
            elif 34 <= n <= 38:
                flags.append((t, n - 33, "accent"))
            elif 40 <= n <= 44:
                flags.append((t, n - 39, "ghost"))
        elif parts[0] == "S":
            p, length = int(parts[1]), int(parts[2]) if len(parts) > 2 else 0
            if p == 2:
                sp.append((t, t + length))
            elif p == 64:
                fills.append((t, t + length))
        elif parts[0] == "E":
            texts.append((t, " ".join(parts[1:]).strip('"')))
    for t, pad, kind in flags:
        for n in raw:
            if n.tick == t and n.pad == pad and not n.plus:
                if kind == "cymbal":
                    n.cymbal = True
                elif n.dyn is None:   # NoteFlagPriority: accent and ghost block each other
                    n.dyn = kind
    raw.sort(key=lambda n: (n.tick, n.pad))
    five = ini_bool(ini.get("five_lane_drums", "")) or any(n.pad == RAW_GREEN for n in raw)
    mix = [(t, ev[1]) for t, txt in texts if (ev := _mix_event(txt)) and ev[0] == difficulty]
    try:
        chart_off = float(song.get("Offset", 0) or 0)
    except ValueError:
        chart_off = 0.0
    return _finish(raw, five, mix, tempo, ini_delay_seconds(ini, chart_off), sections, sp, fills, [],
                   "chart", bool(flags))


# ── song folders ────────────────────────────────────────────────────────────

AUDIO_EXTS = (".ogg", ".opus", ".mp3", ".wav", ".flac", ".m4a")


def find_chart_file(folder: Path) -> Path | None:
    folder = Path(folder)
    for name in ("notes.mid", "notes.midi", "notes.chart"):
        p = folder / name
        if p.exists():
            return p
    hits = sorted(list(folder.glob("*.mid")) + list(folder.glob("*.chart")))
    return hits[0] if hits else None


def load_song_folder(folder: Path, difficulty: str = "expert", levels: bool = True) -> tuple[DrumChart, dict]:
    """Parse a CH/YARG song folder. With ``levels`` (Expert only), the chart's own
    Easy/Medium/Hard parts are read into ``chart.levels`` where they have notes."""
    folder = Path(folder)
    ini = load_song_ini(folder / "song.ini")
    chart_path = find_chart_file(folder)
    if chart_path is None:
        raise FileNotFoundError(f"{folder.name}: no notes.mid or notes.chart")
    is_chart = chart_path.suffix.lower() == ".chart"
    parse = parse_chart if is_chart else parse_mid
    chart = parse(chart_path, ini, difficulty)
    if is_chart and (not ini.get("name") or not ini.get("artist")):
        song = _chart_song_section(_chart_sections(chart_path.read_text(encoding="utf-8-sig", errors="replace")))
        for key, ini_key in (("Name", "name"), ("Artist", "artist"), ("Album", "album")):
            if song.get(key):
                ini.setdefault(ini_key, song[key])
        if song.get("Year"):
            ini.setdefault("year", song["Year"].strip(", "))
    if levels and difficulty == "expert":
        for lv in LOWER_LEVELS:
            try:
                c = parse(chart_path, ini, lv)
            except ValueError:      # no [EasyDrums] section etc.
                continue
            if c.hits:
                chart.levels[lv] = c.hits
    return chart, ini


def song_audio_files(folder: Path) -> dict[str, list[Path]]:
    """CH/YARG audio files grouped by role: song, guitar, rhythm, bass, drums, vocals, keys, crowd."""
    out: dict[str, list[Path]] = {}
    for p in sorted(Path(folder).iterdir()):
        if p.suffix.lower() not in AUDIO_EXTS or p.name.lower().startswith("preview"):
            continue
        m = re.match(r"^(song|guitar|rhythm|bass|drums|vocals|keys|crowd)(?:_\d+)?$", p.stem.lower())
        if m:
            out.setdefault(m.group(1), []).append(p)
    return out


# ── feedpak encoding (drum_tab.json / song_timeline.json) ───────────────────

def hit_to_tab(h: DrumHit, *, top: bool = True) -> dict:
    """One hit in drum_tab `hits[]` form. ``x2`` only on the top-level chart (spec §7.5)."""
    out: dict = {"t": round(h.time, 3), "p": drums_mod.midi_to_piece(h.gm)}
    if h.dyn == "accent":
        out["a"] = True
    elif h.dyn == "ghost":
        out["g"] = True
    if top and h.kick2x:
        out["x2"] = True
    return out


def _tab_hits(hits, *, top: bool = True) -> list[dict]:
    return sorted((hit_to_tab(h, top=top) for h in hits), key=lambda d: (d["t"], d["p"]))


def _ranges(spans) -> list[dict]:
    return [{"start_time": a, "end_time": b} for a, b in spans]


def drum_tab(chart: DrumChart, name: str = "Drums") -> dict:
    """The chart as a feedpak `drum_tab.json` payload: ``hits[]`` is Expert including
    the 2x kicks (flagged ``x2``), plus the 1.20.0 gameplay keys that are non-empty."""
    hits = _tab_hits(chart.hits)
    kit = [{"id": p, "name": p.replace("_", " ").title()}
           for p in dict.fromkeys(h["p"] for h in hits)]
    tab: dict = {"version": drums_mod.SCHEMA_VERSION, "name": name, "kit": kit, "hits": hits}
    for key, spans in (("star_power", chart.star_power), ("fills", chart.fills), ("solos", chart.solos)):
        if spans:
            tab[key] = _ranges(spans)
    levels = {}
    for lv in LOWER_LEVELS:
        if chart.levels.get(lv):
            levels[lv] = {"hits": _tab_hits(chart.levels[lv], top=False)}
            if lv in chart.levels_generated:
                levels[lv]["generated"] = True
    if levels:
        tab["levels"] = levels
    return tab


def tab_to_hits(hits: list) -> list[DrumHit]:
    """drum_tab ``hits[]`` -> 4-lane pro hits. Pieces outside the 4-lane map
    (unknown ids) are dropped; ``x2`` only counts on kicks."""
    out = []
    for h in hits or []:
        if not isinstance(h, dict):
            continue
        pc = PIECE_TO_PAD.get(h.get("p"))
        try:
            t = float(h.get("t"))
        except (TypeError, ValueError):
            continue
        if pc is None:
            continue
        dyn = "accent" if h.get("a") else "ghost" if h.get("g") else None
        out.append(DrumHit(t, pc[0], pc[1], kick2x=bool(h.get("x2")) and pc[0] == "kick", dyn=dyn))
    out.sort(key=lambda d: (d.time, PADS.index(d.pad)))
    return out


def tab_spans(tab: dict, key: str) -> list[tuple[float, float]]:
    """A drum_tab range list (``star_power`` / ``fills`` / ``solos``) as (start, end) pairs."""
    out = []
    for r in (tab or {}).get(key) or []:
        try:
            out.append((float(r["start_time"]), float(r["end_time"])))
        except (TypeError, ValueError, KeyError):
            continue
    return out


def song_timeline(chart: DrumChart) -> dict:
    """The chart's tempo map, beats and sections as a `song_timeline.json` payload."""
    tm, off = chart.tempo, chart.offset
    return {
        "version": 1,
        "tempos": [{"time": round(tm.tick_to_time(t) + off, 4), "bpm": round(bpm, 4)} for t, bpm in tm.tempos],
        "time_signatures": [{"time": round(tm.tick_to_time(t) + off, 4), "ts": [int(n), int(d)]}
                            for t, n, d in tm.time_sigs],
        "beats": chart.beat_list(),
        "sections": [{"name": n, "number": i + 1, "time": t} for i, (t, n) in enumerate(chart.sections)],
    }
