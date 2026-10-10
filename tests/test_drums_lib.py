"""Unit tests for lib/drums.py — piece vocabulary, presets, and wire helpers."""

from __future__ import annotations

import drums


# ── Piece vocabulary ──────────────────────────────────────────────────────────

def test_pieces_have_required_fields():
    """Every piece entry must have midi (list), category, shape, color."""
    required = {"midi", "category", "shape", "color"}
    for pid, meta in drums.PIECES.items():
        assert required <= set(meta.keys()), f"{pid} missing fields"
        assert isinstance(meta["midi"], list) and meta["midi"], f"{pid} midi must be non-empty list"
        assert meta["category"] in {"kick", "drum", "cymbal"}, f"{pid} bad category"
        assert isinstance(meta["color"], str) and meta["color"].startswith("#")


def test_midi_to_piece_round_trip_for_gm_drums():
    """Every MIDI note listed in PIECES round-trips through midi_to_piece."""
    for pid, meta in drums.PIECES.items():
        for m in meta["midi"]:
            resolved = drums.midi_to_piece(m)
            # The reverse map prefers the earliest piece-id for a shared MIDI.
            # The resolved id must still map back to a piece whose midi list
            # contains m, even if it isn't `pid` (e.g. some toms share notes).
            assert resolved is not None, f"MIDI {m} (from {pid}) not in reverse map"
            assert m in drums.PIECES[resolved]["midi"]


def test_midi_to_piece_unknown_returns_none():
    """MIDI notes outside the GM percussion range we map return None."""
    # 60 is middle C — not a drum note.
    assert drums.midi_to_piece(60) is None
    # 200 is out of MIDI range.
    assert drums.midi_to_piece(200) is None


def test_open_and_closed_hihat_are_distinct():
    """hh_open and hh_closed must NOT share MIDI notes — the highway relies on
    this to reject a closed-hat strike on an open-hat note."""
    closed = set(drums.PIECES["hh_closed"]["midi"])
    opened = set(drums.PIECES["hh_open"]["midi"])
    assert closed & opened == set(), "hh_closed and hh_open MUST NOT share MIDI"


def test_piece_to_default_midi_returns_list_copy():
    """piece_to_default_midi must return a fresh list (callers may mutate)."""
    mids = drums.piece_to_default_midi("kick")
    assert mids == [35, 36]
    mids.append(99)
    assert drums.piece_to_default_midi("kick") == [35, 36], "must return a copy"


def test_piece_helpers_have_fallbacks_for_unknown_ids():
    """Unknown piece-ids must round-trip with safe defaults — a newer sloppak's
    unknown piece should still render rather than crash."""
    assert drums.piece_to_default_midi("future_piece") == []
    assert drums.piece_default_shape("future_piece") == "rect"
    assert drums.piece_default_color("future_piece").startswith("#")
    assert drums.piece_category("future_piece") == "drum"


# ── Presets ──────────────────────────────────────────────────────────────────

def test_presets_are_well_formed():
    """Each preset must be a list of lanes with non-empty `pieces` and a label."""
    for name, preset in drums.PRESETS.items():
        assert isinstance(preset, list) and preset, f"preset {name} empty"
        for lane in preset:
            assert isinstance(lane, dict)
            assert "pieces" in lane and lane["pieces"], f"preset {name}: lane missing pieces"
            assert "label" in lane and lane["label"], f"preset {name}: lane missing label"
            # Every piece-id referenced must exist in PIECES — presets aren't
            # the place to invent new piece-ids.
            for pid in lane["pieces"]:
                assert pid in drums.PIECES, f"preset {name}: unknown piece-id {pid}"


def test_phaseshift8_preserves_legacy_lane_order():
    """The phase_shift_8 preset must match the v3 drums plugin's HH/Sn/T1/T2/
    T3/Cr/Ri/Ki order so existing sloppaks keep their familiar layout."""
    labels = [lane["label"] for lane in drums.PRESET_PHASESHIFT8]
    assert labels == ["HH", "Sn", "T1", "T2", "T3", "Cr", "Ri", "Ki"]


def test_every_piece_is_routed_by_every_preset():
    """Adding a new piece-id to PIECES without routing it in every preset
    would let hits for that piece vanish from the highway under that
    preset. This guards against that class of regression."""
    all_pieces = set(drums.PIECES.keys())
    for name, preset in drums.PRESETS.items():
        routed = {pid for lane in preset for pid in lane["pieces"]}
        missing = all_pieces - routed
        assert not missing, (
            f"preset {name!r} doesn't route: {sorted(missing)}. "
            f"Add them to an existing lane (grouped presets) or to their "
            f"own lane (e-kit presets).")


# ── Wire helpers ─────────────────────────────────────────────────────────────

def test_validate_drum_tab_accepts_minimal_payload():
    ok, reason = drums.validate_drum_tab({"hits": []})
    assert ok, reason


def test_validate_drum_tab_rejects_non_object():
    ok, _ = drums.validate_drum_tab([])
    assert not ok
    ok, _ = drums.validate_drum_tab(None)
    assert not ok


def test_validate_drum_tab_rejects_missing_hits():
    ok, reason = drums.validate_drum_tab({"version": 1})
    assert not ok
    assert "hits" in reason


def test_validate_drum_tab_rejects_non_int_version():
    ok, _ = drums.validate_drum_tab({"version": "1", "hits": []})
    assert not ok


def test_validate_drum_tab_accepts_unknown_version():
    """An unknown schema version is logged but the payload is still accepted —
    forward-compat per Principle IV (backwards-compatible custom song library)."""
    ok, _ = drums.validate_drum_tab({"version": 99, "hits": []})
    assert ok


def test_hit_to_wire_canonicalises_known_fields():
    out = drums.hit_to_wire({"t": 0.5001, "p": "kick", "v": 110, "g": True, "f": False, "k": 0.08})
    assert out == {"t": 0.5, "p": "kick", "v": 110, "g": True, "k": 0.08}


def test_hit_to_wire_drops_malformed():
    assert drums.hit_to_wire({"t": 0.5}) is None         # no piece
    assert drums.hit_to_wire({"p": "kick"}) is None       # no time
    assert drums.hit_to_wire({"t": "x", "p": "kick"}) is None
    assert drums.hit_to_wire({"t": 0.5, "p": ""}) is None
    assert drums.hit_to_wire("not a dict") is None


def test_hit_to_wire_drops_out_of_range_velocity():
    """Velocity must be 1-127. 0 / 200 / negative get silently dropped."""
    out = drums.hit_to_wire({"t": 0.5, "p": "kick", "v": 0})
    assert "v" not in out
    out = drums.hit_to_wire({"t": 0.5, "p": "kick", "v": 200})
    assert "v" not in out
    out = drums.hit_to_wire({"t": 0.5, "p": "kick", "v": -1})
    assert "v" not in out


def test_hits_to_wire_drops_bad_and_sorts():
    hits = [
        {"t": 2.0, "p": "snare"},
        {"t": 1.0, "p": "kick"},
        {"t": "bad", "p": "kick"},   # dropped
        {"t": 0.5, "p": "ride", "v": 90},
    ]
    out = drums.hits_to_wire(hits)
    assert [h["t"] for h in out] == [0.5, 1.0, 2.0]
    assert [h["p"] for h in out] == ["ride", "kick", "snare"]


def test_normalise_kit_dedupes_and_fills_names():
    kit = [
        {"id": "kick", "name": "Kick"},
        {"id": "snare"},                          # name derived from id
        {"id": "kick", "name": "duplicate"},      # dedupe wins by first occurrence
        {"id": "", "name": "empty id"},           # dropped
        "not a dict",                              # dropped
    ]
    out = drums.normalise_kit(kit)
    assert out == [{"id": "kick", "name": "Kick"}, {"id": "snare", "name": "Snare"}]


def test_normalise_kit_handles_none():
    assert drums.normalise_kit(None) == []
    assert drums.normalise_kit("not a list") == []


# ── Drum gameplay metadata (feedpak 1.20.0) ───────────────────────────────────


def test_hit_to_wire_carries_accent_and_double_kick():
    assert drums.hit_to_wire({"t": 1.0, "p": "crash_l", "a": True}) == {"t": 1.0, "p": "crash_l", "a": True}
    assert drums.hit_to_wire({"t": 1.0, "p": "kick", "x2": True}) == {"t": 1.0, "p": "kick", "x2": True}
    # absent / false flags stay off the wire (pre-1.20.0 frames unchanged)
    assert drums.hit_to_wire({"t": 1.0, "p": "kick", "a": False, "x2": False}) == {"t": 1.0, "p": "kick"}


def test_hit_to_wire_never_sends_accent_with_ghost():
    # The spec forbids a hit that is both; the ghost wins, the accent drops.
    assert drums.hit_to_wire({"t": 1.0, "p": "snare", "a": True, "g": True}) == {"t": 1.0, "p": "snare", "g": True}


def test_hit_to_wire_x2_only_on_top_level_kicks():
    assert "x2" not in drums.hit_to_wire({"t": 1.0, "p": "snare", "x2": True})
    assert "x2" not in drums.hit_to_wire({"t": 1.0, "p": "kick", "x2": True}, top=False)


def test_ranges_to_wire_sanitises_and_sorts():
    out = drums.ranges_to_wire([
        {"start_time": 8.0, "end_time": 9.5},
        {"start_time": 1.00049, "end_time": 2.0},
        {"start_time": 3.0, "end_time": 2.0},          # ends before it starts
        {"start_time": "x", "end_time": 2.0},
        {"start_time": True, "end_time": 2.0},          # bool is not a number
        {"start_time": float("nan"), "end_time": 2.0},
        {"end_time": 2.0},
        "not a dict",
        {"start_time": 4.0, "end_time": 4.0, "extra": 1},  # zero length is fine
    ])
    assert out == [
        {"start_time": 1.0, "end_time": 2.0},
        {"start_time": 4.0, "end_time": 4.0},
        {"start_time": 8.0, "end_time": 9.5},
    ]
    assert drums.ranges_to_wire(None) == []
    assert drums.ranges_to_wire({"start_time": 1, "end_time": 2}) == []


def test_levels_to_wire_keeps_known_ids_and_drops_empty_levels():
    out = drums.levels_to_wire({
        "hard": {"hits": [{"t": 1.0, "p": "kick", "x2": True}, {"t": 0.5, "p": "snare", "a": True}]},
        "easy": {"hits": [{"t": 0.5, "p": "crash_l"}], "generated": True},
        "medium": {"hits": [{"t": 0.5}]},                 # every hit malformed -> no level
        "expert": {"hits": [{"t": 0.5, "p": "kick"}]},    # not a v1 level id
        "extreme": "nope",
    })
    assert out == {
        "easy": {"hits": [{"t": 0.5, "p": "crash_l"}], "generated": True},
        "hard": {"hits": [{"t": 0.5, "p": "snare", "a": True}, {"t": 1.0, "p": "kick"}], "generated": False},
    }
    assert drums.levels_to_wire(None) == {}
    assert drums.levels_to_wire({"easy": {"hits": "x"}}) == {}
