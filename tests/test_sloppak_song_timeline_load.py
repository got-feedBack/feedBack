"""End-to-end tests for the sloppak loader recognising a `song_timeline:` manifest
key and surfacing the parsed payload on the LoadedSloppak."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

import sloppak as sloppak_mod


def _write_dir_sloppak(
    root: Path,
    manifest_extras: dict,
    song_timeline_payload: dict | None,
) -> Path:
    """Build a minimal directory-form sloppak that load_song will accept.

    The lead arrangement intentionally carries beats and sections so that tests
    can verify song_timeline overrides them (or that they survive when
    song_timeline is absent).
    """
    pak = root / f"{root.name}.sloppak"
    pak.mkdir()
    arr_dir = pak / "arrangements"
    arr_dir.mkdir()

    arr = {
        "name": "Lead",
        "tuning": [0, 0, 0, 0, 0, 0],
        "capo": 0,
        "notes": [],
        "chords": [],
        "anchors": [],
        "handshapes": [],
        "templates": [],
        "beats": [{"time": 1.0, "measure": 1}],
        "sections": [{"name": "arr_verse", "number": 1, "time": 1.0}],
    }
    (arr_dir / "lead.json").write_text(json.dumps(arr))

    manifest = {
        "title": "Test",
        "artist": "Tester",
        "album": "",
        "year": 2026,
        "duration": 10.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": [{"id": "full", "file": "stems/full.ogg", "default": True}],
    }
    manifest.update(manifest_extras)
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))

    if song_timeline_payload is not None:
        (pak / "song_timeline.json").write_text(json.dumps(song_timeline_payload))

    return pak


def _load(pak_path: Path, tmp_path: Path):
    dlc_root = pak_path.parent
    cache = tmp_path / "cache"
    cache.mkdir()
    return sloppak_mod.load_song(pak_path.name, dlc_root, cache)


# ── Happy path ───────────────────────────────────────────────────────────────

def test_song_timeline_populates_beats_and_sections(tmp_path: Path):
    payload = {
        "version": 1,
        "beats": [
            {"time": 0.5, "measure": 1},
            {"time": 1.0, "measure": -1},
        ],
        "sections": [
            {"name": "intro", "number": 1, "time": 0.0},
        ],
    }
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "song_timeline.json"}, payload)
    loaded = _load(pak, tmp_path)

    assert loaded.song_timeline is not None
    assert len(loaded.song.beats) == 2
    assert loaded.song.beats[0].time == 0.5
    assert loaded.song.beats[1].measure == -1
    assert len(loaded.song.sections) == 1
    assert loaded.song.sections[0].name == "intro"


def test_song_timeline_absent_falls_through_to_arrangement_beats(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {}, None)
    loaded = _load(pak, tmp_path)

    assert loaded.song_timeline is None
    # Arrangement JSON beat should still be present.
    assert len(loaded.song.beats) == 1
    assert loaded.song.beats[0].time == 1.0


def test_song_timeline_overrides_arrangement_beats(tmp_path: Path):
    payload = {
        "version": 1,
        "beats": [{"time": 0.5, "measure": 1}],
        "sections": [],
    }
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "song_timeline.json"}, payload)
    loaded = _load(pak, tmp_path)

    # song_timeline beat (0.5) must win over arrangement beat (1.0).
    assert loaded.song.beats[0].time == 0.5


# ── Error / security cases ───────────────────────────────────────────────────

def test_song_timeline_absent_when_file_missing(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "nope.json"}, None)
    loaded = _load(pak, tmp_path)
    assert loaded.song_timeline is None


def test_song_timeline_absent_when_invalid_json(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "song_timeline.json"}, None)
    (pak / "song_timeline.json").write_text("not json {{{")
    loaded = _load(pak, tmp_path)
    assert loaded.song_timeline is None


def test_song_timeline_absent_when_beats_not_a_list(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "song_timeline.json"}, None)
    (pak / "song_timeline.json").write_text(json.dumps({"beats": "oops", "sections": []}))
    loaded = _load(pak, tmp_path)
    assert loaded.song_timeline is None


def test_song_timeline_absent_when_sections_not_a_list(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "song_timeline.json"}, None)
    (pak / "song_timeline.json").write_text(json.dumps({"beats": [], "sections": "oops"}))
    loaded = _load(pak, tmp_path)
    assert loaded.song_timeline is None


def test_song_timeline_absent_when_path_escapes_sloppak(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "../outside.json"}, None)
    loaded = _load(pak, tmp_path)
    assert loaded.song_timeline is None


# ── tempos + time_signatures (feedpak 1.2.0) ─────────────────────────────────

def test_song_timeline_tempos_and_time_signatures_loaded(tmp_path: Path):
    payload = {
        "version": 1, "beats": [], "sections": [],
        "tempos": [{"time": 0.0, "bpm": 120}, {"time": 4.0, "bpm": 90}],
        "time_signatures": [{"time": 0.0, "ts": [4, 4]}, {"time": 8.0, "ts": [6, 8]}],
    }
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "song_timeline.json"}, payload)
    loaded = _load(pak, tmp_path)
    assert loaded.tempos == [{"time": 0.0, "bpm": 120.0}, {"time": 4.0, "bpm": 90.0}]
    assert loaded.time_signatures == [{"time": 0.0, "ts": [4, 4]},
                                      {"time": 8.0, "ts": [6, 8]}]


def test_song_timeline_maps_absent_when_not_provided(tmp_path: Path):
    payload = {"version": 1, "beats": [], "sections": []}
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "song_timeline.json"}, payload)
    loaded = _load(pak, tmp_path)
    assert loaded.tempos is None and loaded.time_signatures is None


def test_song_timeline_maps_sanitized(tmp_path: Path):
    payload = {
        "version": 1, "beats": [], "sections": [],
        "tempos": [{"time": 1.0, "bpm": 0}, {"time": 0.0, "bpm": 100}],   # bpm 0 dropped + sorted
        "time_signatures": [{"time": 0.0, "ts": [4, 4, 4]},                # 3-long dropped
                            {"time": 2.0, "ts": [3, 4]}],
    }
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "song_timeline.json"}, payload)
    loaded = _load(pak, tmp_path)
    assert loaded.tempos == [{"time": 0.0, "bpm": 100.0}]
    assert loaded.time_signatures == [{"time": 2.0, "ts": [3, 4]}]


def test_song_timeline_maps_load_even_without_beats_or_sections(tmp_path: Path):
    # tempos/time_signatures are independent of beats/sections — a payload that
    # omits beats (invalid for the override path) must still surface the maps.
    payload = {"version": 1, "tempos": [{"time": 0.0, "bpm": 100}]}
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "song_timeline.json"}, payload)
    loaded = _load(pak, tmp_path)
    assert loaded.tempos == [{"time": 0.0, "bpm": 100.0}]


def test_song_timeline_absent_when_path_is_absolute(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "/etc/passwd"}, None)
    loaded = _load(pak, tmp_path)
    assert loaded.song_timeline is None


def test_song_timeline_skips_non_dict_beat_entries(tmp_path: Path):
    """Non-dict items in the beats list are skipped; valid items are kept."""
    payload = {
        "version": 1,
        "beats": [None, 42, {"time": 0.5, "measure": 1}, "bad"],
        "sections": [],
    }
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "song_timeline.json"}, payload)
    loaded = _load(pak, tmp_path)
    # The timeline was accepted (valid structure overall).
    assert loaded.song_timeline is not None
    # Only the one valid dict entry should appear.
    assert len(loaded.song.beats) == 1
    assert loaded.song.beats[0].time == 0.5


def test_song_timeline_skips_non_dict_section_entries(tmp_path: Path):
    """Non-dict items in the sections list are skipped; valid items are kept."""
    payload = {
        "version": 1,
        "beats": [],
        "sections": [None, {"name": "verse", "number": 1, "time": 1.0}, 99],
    }
    pak = _write_dir_sloppak(tmp_path, {"song_timeline": "song_timeline.json"}, payload)
    loaded = _load(pak, tmp_path)
    assert loaded.song_timeline is not None
    assert len(loaded.song.sections) == 1
    assert loaded.song.sections[0].name == "verse"
