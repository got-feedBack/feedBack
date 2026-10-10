"""Drum kit vocabulary, presets, and drum_tab.json helpers.

The canonical drum payload in a sloppak is a top-level `drum_tab.json` file
referenced from `manifest.yaml` via the `drum_tab:` key (see
`docs/sloppak-spec.md` §5.3). This module is the source of truth for:

- the closed list of drum piece-ids that a `drum_tab.json` may reference,
- their default GM percussion MIDI notes and visual category,
- preset lane configurations for the drums plugin,
- a permissive validator + short-key wire helper used by both the writer
  side (importers) and the reader side (sloppak loader + highway WS).

The schema is intentionally extensible: unknown piece-ids round-trip through
the loader so a newer sloppak can still play on an older client that just
doesn't have visuals for the new piece. Validation is strict only on the
top-level shape (`version`, `kit`, `hits` types).
"""

from __future__ import annotations

import logging
import math

log = logging.getLogger("feedBack.lib.drums")


# ── Piece vocabulary ──────────────────────────────────────────────────────────
#
# Each entry pins a closed piece-id to its default General MIDI percussion
# note(s), a category (kick/drum/cymbal — drives default shape rendering), and
# a default colour. The drums plugin reads this map on startup and uses the
# defaults to seed the user's lane configuration; users can override colours
# and shapes per lane in localStorage.

PIECES: dict[str, dict] = {
    # Kick — full-width bar across all non-kick lanes.
    "kick":          {"midi": [35, 36],        "category": "kick",   "shape": "bar",            "color": "#f59e0b"},

    # Drums proper — rectangles. Toms ordered hi→floor.
    "snare":         {"midi": [38, 40],        "category": "drum",   "shape": "rect",           "color": "#ef4444"},
    "snare_xstick":  {"midi": [37],            "category": "drum",   "shape": "rect_hatched",   "color": "#dc2626"},
    "tom_hi":        {"midi": [50, 48],        "category": "drum",   "shape": "rect",           "color": "#eab308"},
    "tom_mid":       {"midi": [47, 45],        "category": "drum",   "shape": "rect",           "color": "#ca8a04"},
    "tom_low":       {"midi": [43],             "category": "drum",   "shape": "rect",           "color": "#a16207"},
    "tom_floor":     {"midi": [41],            "category": "drum",   "shape": "rect",           "color": "#854d0e"},

    # Cymbals — circles. Open/closed hi-hat are distinct piece-ids, not a
    # per-hit articulation flag, because hit detection must reject a
    # closed-hat strike on an open-hat note (and vice versa).
    "hh_closed":     {"midi": [42],            "category": "cymbal", "shape": "circle_filled",  "color": "#22d3ee"},
    "hh_open":       {"midi": [46],            "category": "cymbal", "shape": "circle_ring",    "color": "#06b6d4"},
    "hh_pedal":      {"midi": [44],            "category": "cymbal", "shape": "circle_small_x", "color": "#0891b2"},
    # Stack — two cymbals stacked for a trashy/choked effect. GM has no
    # standard for it; we reuse 30 (in GM's extended-percussion range,
    # unused by real drum-kit MIDIs).
    "stack":         {"midi": [30],            "category": "cymbal", "shape": "circle_jagged",  "color": "#94a3b8"},
    "crash_l":       {"midi": [49],            "category": "cymbal", "shape": "circle",         "color": "#84cc16"},
    "crash_r":       {"midi": [57],            "category": "cymbal", "shape": "circle",         "color": "#65a30d"},
    "splash":        {"midi": [55],            "category": "cymbal", "shape": "circle_small",   "color": "#a3e635"},
    "china":         {"midi": [52],            "category": "cymbal", "shape": "circle_jagged",  "color": "#4d7c0f"},
    "ride":          {"midi": [51, 59],        "category": "cymbal", "shape": "circle",         "color": "#3b82f6"},
    "ride_bell":     {"midi": [53],            "category": "cymbal", "shape": "circle_dot",     "color": "#1d4ed8"},
    # Bell cymbal — a small mounted bell, distinct from the ride's bell.
    # No GM standard; we reuse 80 ("Mute Triangle"), unused in real
    # drum-kit MIDIs.
    "bell":          {"midi": [80],            "category": "cymbal", "shape": "circle_dot",     "color": "#fde047"},
}


# Reverse map MIDI note → piece-id. First piece-id whose `midi` list contains
# the note wins (PIECES is iteration-ordered so the "preferred" piece-id for a
# shared MIDI is the one declared earlier). Built once at import time.
_MIDI_TO_PIECE: dict[int, str] = {}
for _pid, _meta in PIECES.items():
    for _m in _meta["midi"]:
        _MIDI_TO_PIECE.setdefault(_m, _pid)


def midi_to_piece(midi: int) -> str | None:
    """Return the canonical piece-id for a GM percussion MIDI note, or None
    if the note isn't mapped (e.g. cowbell, tambourine — extensible later)."""
    return _MIDI_TO_PIECE.get(int(midi))


def piece_to_default_midi(piece: str) -> list[int]:
    """Return the GM MIDI notes that map to `piece` by default. Empty list for
    unknown piece-ids — callers should treat that as "unmapped" rather than
    crashing, so a newer sloppak's unknown piece round-trips silently."""
    entry = PIECES.get(piece)
    return list(entry["midi"]) if entry else []


def piece_default_shape(piece: str) -> str:
    """Default rendering shape for a piece-id. `"rect"` fallback so an
    unknown piece still draws something the user can see."""
    entry = PIECES.get(piece)
    return entry["shape"] if entry else "rect"


def piece_default_color(piece: str) -> str:
    """Default colour for a piece-id. Neutral grey fallback for unknown."""
    entry = PIECES.get(piece)
    return entry["color"] if entry else "#9ca3af"


def piece_category(piece: str) -> str:
    """Category (`kick`/`drum`/`cymbal`) — `"drum"` fallback for unknown."""
    entry = PIECES.get(piece)
    return entry["category"] if entry else "drum"


# ── Preset lane configurations ────────────────────────────────────────────────
#
# Each preset is a list of `lane` dicts. A lane carries:
#   - `pieces`: list of piece-ids that route to this lane (multiple → shared)
#   - `label`:  short header text
# Visual fields (color, shape, weight) are optional; the renderer falls back
# to the per-piece defaults above. The drums plugin layers user customisation
# on top of these.

PRESET_RB4 = [
    {"pieces": ["kick"],                                        "label": "Ki"},
    {"pieces": ["snare", "snare_xstick"],                       "label": "Sn"},
    {"pieces": ["hh_closed", "hh_open", "hh_pedal"],            "label": "HH"},
    {"pieces": ["tom_hi", "tom_mid"],                           "label": "T"},
    {"pieces": ["tom_low", "tom_floor"],                        "label": "FT"},
    {"pieces": ["crash_l", "crash_r", "splash", "china", "stack"], "label": "Cr"},
    {"pieces": ["ride", "ride_bell", "bell"],                   "label": "Ri"},
]

# 8-lane layout matching the legacy drums plugin v3 (HH / Sn / T1 / T2 / T3 /
# Cr / Ri / Ki) so existing sloppaks keep their familiar lane order when the
# rewrite ships.
PRESET_PHASESHIFT8 = [
    {"pieces": ["hh_closed", "hh_open", "hh_pedal"],            "label": "HH"},
    {"pieces": ["snare", "snare_xstick"],                       "label": "Sn"},
    {"pieces": ["tom_hi"],                                      "label": "T1"},
    {"pieces": ["tom_mid"],                                     "label": "T2"},
    {"pieces": ["tom_low", "tom_floor"],                        "label": "T3"},
    {"pieces": ["crash_l", "crash_r", "splash", "china", "stack"], "label": "Cr"},
    {"pieces": ["ride", "ride_bell", "bell"],                   "label": "Ri"},
    {"pieces": ["kick"],                                        "label": "Ki"},
]

# One lane per piece-id — for users with a full e-kit who want every piece on
# its own column. Order roughly mirrors a physical kit left→right.
PRESET_EKIT_FULL = [
    {"pieces": ["hh_pedal"],     "label": "HH-p"},
    {"pieces": ["hh_closed"],    "label": "HH-c"},
    {"pieces": ["hh_open"],      "label": "HH-o"},
    {"pieces": ["snare_xstick"], "label": "Sn-x"},
    {"pieces": ["snare"],        "label": "Sn"},
    {"pieces": ["tom_hi"],       "label": "T1"},
    {"pieces": ["tom_mid"],      "label": "T2"},
    {"pieces": ["tom_low"],      "label": "T3"},
    {"pieces": ["tom_floor"],    "label": "FT"},
    {"pieces": ["stack"],        "label": "Stk"},
    {"pieces": ["crash_l"],      "label": "Cr-L"},
    {"pieces": ["splash"],       "label": "Sp"},
    {"pieces": ["china"],        "label": "Ch"},
    {"pieces": ["ride"],         "label": "Ri"},
    {"pieces": ["ride_bell"],    "label": "Ri-B"},
    {"pieces": ["bell"],         "label": "Bl"},
    {"pieces": ["crash_r"],      "label": "Cr-R"},
    {"pieces": ["kick"],         "label": "Ki"},
]

PRESETS: dict[str, list[dict]] = {
    "rb4":            PRESET_RB4,
    "phase_shift_8":  PRESET_PHASESHIFT8,
    "ekit_full":      PRESET_EKIT_FULL,
}


# ── drum_tab.json schema helpers ──────────────────────────────────────────────

# Default velocity when a hit omits `v`. Matches spec §5.3 ("v is optional,
# defaults to 100 — keeps simple charts terse").
DEFAULT_VELOCITY = 100

# Current `version` written by importers. Readers MUST accept any version they
# recognise; an unknown version is logged at DEBUG level on every call to
# validate_drum_tab() and the payload is still passed
# through (per Principle IV, additive evolution).
SCHEMA_VERSION = 1


def validate_drum_tab(data: object) -> tuple[bool, str]:
    """Light schema check for a parsed `drum_tab.json` payload.

    Returns `(ok, reason)`. Accepts both `version: 1` (current) and absent
    `version` (treat as 1) for forward-compat with hand-edited tabs.
    `hits[]` is required and must be a list; individual hits are NOT
    validated here — per-hit filtering happens in `hit_to_wire()` /
    `hits_to_wire()` at WS-stream time, so a single malformed hit cannot
    disqualify the whole tab.
    """
    if not isinstance(data, dict):
        return False, "drum_tab payload must be a JSON object"
    hits = data.get("hits")
    if not isinstance(hits, list):
        return False, "drum_tab.hits must be a list"
    kit = data.get("kit", [])
    if kit is not None and not isinstance(kit, list):
        return False, "drum_tab.kit must be a list (or omitted)"
    ver = data.get("version", SCHEMA_VERSION)
    if isinstance(ver, bool) or not isinstance(ver, int):
        return False, "drum_tab.version must be an integer"
    if ver != SCHEMA_VERSION:
        log.debug("drum_tab: unknown schema version %r — passing through", ver)
    return True, ""


def hit_to_wire(hit: dict, *, top: bool = True) -> dict | None:
    """Normalise one hit dict into the short-key wire form streamed by
    `/ws/highway/{filename}`. Returns None on a malformed hit (missing `t`
    or `p`) so the loader can drop just that entry without aborting the
    whole tab.

    Wire keys (all optional except `t`, `p`):
        t  float seconds      required, monotonic
        p  string piece-id    required, free-form (validated against PIECES
                              by the client; unknown ids render as `"rect"`)
        v  int 1-127          velocity (omitted when absent; client defaults
                              to DEFAULT_VELOCITY)
        g  bool               ghost note
        f  bool               flam
        k  float seconds      cymbal-choke tail duration
        a  bool               accent (feedpak 1.20.0). Never sent together
                              with `g` — the spec forbids the pair, so a hit
                              that sets both keeps the ghost and loses the
                              accent rather than handing the client an
                              impossible dynamic.
        x2 bool               double-kick ("Expert+") note (1.20.0). Only on
                              a `kick` hit and only when ``top`` is true: the
                              spec makes `x2` meaningful in the top-level
                              `hits[]` alone, so a `levels` entry never
                              carries it on the wire.
    """
    if not isinstance(hit, dict):
        return None
    t_raw = hit.get("t")
    if isinstance(t_raw, bool):
        return None
    try:
        t = float(t_raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if not math.isfinite(t):
        return None
    p = hit.get("p")
    if not isinstance(p, str) or not p:
        return None
    out: dict = {"t": round(t, 3), "p": p}
    v = hit.get("v")
    if not isinstance(v, bool) and isinstance(v, (int, float)) and math.isfinite(v) and 1 <= int(v) <= 127:
        out["v"] = int(v)
    if bool(hit.get("g")):
        out["g"] = True
    if bool(hit.get("f")):
        out["f"] = True
    k = hit.get("k")
    if not isinstance(k, bool) and isinstance(k, (int, float)) and math.isfinite(k) and k > 0:
        out["k"] = round(float(k), 3)
    if bool(hit.get("a")) and "g" not in out:
        out["a"] = True
    if top and p == "kick" and bool(hit.get("x2")):
        out["x2"] = True
    return out


def hits_to_wire(hits: list[dict], *, top: bool = True) -> list[dict]:
    """Vectorised `hit_to_wire` — drops malformed entries, sorts by time.

    ``top=False`` encodes a `levels` entry's hits (no `x2`, see `hit_to_wire`).
    """
    out: list[dict] = []
    if not isinstance(hits, list):
        return out
    for h in hits:
        w = hit_to_wire(h, top=top)
        if w is not None:
            out.append(w)
    out.sort(key=lambda h: h["t"])
    return out


# ── Drum gameplay metadata (feedpak 1.20.0) ───────────────────────────────────
#
# Optional top-level drum_tab keys describing the chart beyond its hits:
# `star_power` / `fills` / `solos` range lists and the easier `levels`. Like
# the hits they are sanitised here, at WS-stream time, so one malformed entry
# drops alone instead of disqualifying the tab.

RANGE_KEYS = ("star_power", "fills", "solos")
LEVEL_IDS = ("easy", "medium", "hard")


def _finite(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def ranges_to_wire(ranges: object) -> list[dict]:
    """Normalise a drum_tab range list (`star_power` / `fills` / `solos`).

    Each entry becomes `{"start_time", "end_time"}` rounded to the hit
    precision; entries that aren't objects, lack a finite pair, or end before
    they start are dropped. Sorted by `start_time` (the spec asks Writers to
    sort, Readers shouldn't depend on it). Returns [] for a missing/odd value.
    """
    out: list[dict] = []
    if not isinstance(ranges, list):
        return out
    for r in ranges:
        if not isinstance(r, dict):
            continue
        a = _finite(r.get("start_time"))
        b = _finite(r.get("end_time"))
        if a is None or b is None or b < a:
            continue
        out.append({"start_time": round(a, 3), "end_time": round(b, 3)})
    out.sort(key=lambda r: (r["start_time"], r["end_time"]))
    return out


def levels_to_wire(levels: object) -> dict[str, dict]:
    """Normalise a drum_tab `levels` object to `{id: {"hits", "generated"}}`.

    Only the spec's closed ids (`easy`, `medium`, `hard`) survive — a Reader
    MUST ignore any other id. A level whose `hits` isn't a list, or whose hits
    are all malformed, is dropped: an empty level would offer the player a
    difficulty with nothing to play. Hits go through `hits_to_wire(top=False)`.
    """
    out: dict[str, dict] = {}
    if not isinstance(levels, dict):
        return out
    for lid in LEVEL_IDS:
        lv = levels.get(lid)
        if not isinstance(lv, dict) or not isinstance(lv.get("hits"), list):
            continue
        hits = hits_to_wire(lv["hits"], top=False)
        if not hits:
            continue
        out[lid] = {"hits": hits, "generated": lv.get("generated") is True}
    return out


def normalise_kit(kit: list | None) -> list[dict]:
    """Normalise the `kit[]` legend: each entry becomes `{"id": str, "name":
    str}`. Unknown piece-ids are kept (forward-compat) with a title-cased
    fallback name. Returns an empty list for missing/empty kit (the client
    will derive the kit from the union of `hits[].p` in that case)."""
    if not isinstance(kit, list):
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for entry in kit:
        if not isinstance(entry, dict):
            continue
        pid = entry.get("id")
        if not isinstance(pid, str) or not pid or pid in seen:
            continue
        seen.add(pid)
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            name = pid.replace("_", " ").title()
        out.append({"id": pid, "name": name})
    return out
