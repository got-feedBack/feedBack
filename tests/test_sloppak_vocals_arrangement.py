"""Vocals-arrangement projection: a sloppak carrying a sung-melody sidecar
(`vocal_pitch`, feedpak-spec §7.2) projects a synthetic chartless "Vocals"
arrangement in BOTH `load_song()` (player selectability, visualizer
auto-match) and `extract_meta()` (library index + the `song_stats`
arrangement-count validation), so sung runs get their own honest stats
bucket instead of being posted against a fretted arrangement."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

import sloppak as sloppak_mod


def _write_dir_sloppak(
    root: Path,
    manifest_extras: dict,
    vocal_pitch_payload: dict | None = None,
    include_lead: bool = True,
) -> Path:
    """Minimal directory-form sloppak; unique name per test (cache safety)."""
    pak = root / f"{root.name}.sloppak"
    pak.mkdir()
    arr_dir = pak / "arrangements"
    arr_dir.mkdir()

    arrangements = []
    if include_lead:
        arr = {
            "name": "Lead",
            "tuning": [0, 0, 0, 0, 0, 0],
            "capo": 0,
            "notes": [],
            "chords": [],
            "anchors": [],
            "handshapes": [],
            "templates": [],
            "beats": [],
            "sections": [],
        }
        (arr_dir / "lead.json").write_text(json.dumps(arr))
        arrangements.append(
            {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}
        )

    manifest = {
        "title": "Test",
        "artist": "Tester",
        "album": "",
        "year": 2026,
        "duration": 10.0,
        "arrangements": arrangements,
        "stems": [{"id": "full", "file": "stems/full.ogg", "default": True}],
    }
    manifest.update(manifest_extras)
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))

    if vocal_pitch_payload is not None:
        (pak / "vocal_pitch.json").write_text(json.dumps(vocal_pitch_payload))

    return pak


def _load(pak_path: Path, tmp_path: Path):
    dlc_root = pak_path.parent
    cache = tmp_path / "cache"
    cache.mkdir()
    return sloppak_mod.load_song(pak_path.name, dlc_root, cache)


_PITCH = {"version": 1, "notes": [{"t": 1.0, "d": 0.5, "midi": 62},
                                  {"t": 8.0, "d": 2.0, "midi": 69}]}


# ── load_song projection ─────────────────────────────────────────────────────

def test_vocal_pitch_projects_synthetic_vocals_arrangement(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"vocal_pitch": "vocal_pitch.json"}, _PITCH)
    loaded = _load(pak, tmp_path)
    names = [a.name for a in loaded.song.arrangements]
    assert names == ["Lead", "Vocals"]
    vox = loaded.song.arrangements[-1]
    assert vox.type == "vocals"
    assert vox.notes == []  # chartless — the melody stays in the sidecar


def test_no_projection_without_vocal_pitch_key(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {}, None)
    loaded = _load(pak, tmp_path)
    assert [a.name for a in loaded.song.arrangements] == ["Lead"]


def test_no_projection_when_sidecar_missing_is_still_projected(tmp_path: Path):
    # The manifest key is the contract (matching every sidecar consumer): a
    # declared-but-absent file still projects, and the visualizer's own
    # status endpoint reports the chart missing. The load must not crash.
    pak = _write_dir_sloppak(tmp_path, {"vocal_pitch": "vocal_pitch.json"}, None)
    loaded = _load(pak, tmp_path)
    assert [a.name for a in loaded.song.arrangements] == ["Lead", "Vocals"]


def test_no_duplicate_when_explicit_vocal_arrangement_loaded(tmp_path: Path):
    # An author-shipped vocal arrangement WITH a chart file suppresses the
    # projection (both by type and by name).
    pak = _write_dir_sloppak(tmp_path, {"vocal_pitch": "vocal_pitch.json"}, _PITCH)
    arr = {
        "name": "Lead Vocals",
        "tuning": [0, 0, 0, 0, 0, 0],
        "capo": 0,
        "notes": [], "chords": [], "anchors": [],
        "handshapes": [], "templates": [], "beats": [], "sections": [],
    }
    (pak / "arrangements" / "vox.json").write_text(json.dumps(arr))
    manifest = yaml.safe_load((pak / "manifest.yaml").read_text())
    manifest["arrangements"].append(
        {"id": "vox", "name": "Lead Vocals", "file": "arrangements/vox.json"}
    )
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    loaded = _load(pak, tmp_path)
    names = [a.name for a in loaded.song.arrangements]
    assert names == ["Lead", "Lead Vocals"]  # no synthetic duplicate


def test_melody_only_pak_loads_with_duration_fallback(tmp_path: Path):
    # A pak with ONLY a vocal_pitch sidecar (no fretted arrangements) must
    # still load — and derive its length from the last sung note, mirroring
    # the drum-only placeholder contract.
    pak = _write_dir_sloppak(
        tmp_path,
        {"vocal_pitch": "vocal_pitch.json", "duration": 0},
        _PITCH,
        include_lead=False,
    )
    loaded = _load(pak, tmp_path)
    assert [a.name for a in loaded.song.arrangements] == ["Vocals"]
    assert loaded.song.song_length == 12.0  # 8.0 + 2.0 sustain + 2.0 tail


def test_melody_only_pak_with_malformed_sidecar_still_loads(tmp_path: Path):
    pak = _write_dir_sloppak(
        tmp_path,
        {"vocal_pitch": "vocal_pitch.json", "duration": 0},
        None,
        include_lead=False,
    )
    (pak / "vocal_pitch.json").write_text("not json {{{")
    loaded = _load(pak, tmp_path)
    # Projection still happens; only the duration fallback is lost.
    assert [a.name for a in loaded.song.arrangements] == ["Vocals"]
    assert loaded.song.song_length == 0.0


def test_sidecar_path_escape_only_costs_the_duration_fallback(tmp_path: Path):
    pak = _write_dir_sloppak(
        tmp_path,
        {"vocal_pitch": "../outside.json", "duration": 0},
        None,
        include_lead=False,
    )
    (tmp_path / "outside.json").write_text(json.dumps(_PITCH))
    loaded = _load(pak, tmp_path)
    assert [a.name for a in loaded.song.arrangements] == ["Vocals"]
    assert loaded.song.song_length == 0.0  # confined read refused the escape


# ── extract_meta projection (the stats-bucket mirror) ────────────────────────

def test_extract_meta_projects_vocals_entry(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"vocal_pitch": "vocal_pitch.json"}, _PITCH)
    meta = sloppak_mod.extract_meta(pak)
    names = [a["name"] for a in meta["arrangements"]]
    assert names == ["Lead", "Vocals"]
    # indexes must be contiguous after the priority re-sort
    assert [a["index"] for a in meta["arrangements"]] == [0, 1]


def test_extract_meta_count_matches_load_song(tmp_path: Path):
    # The whole point: `song_stats` validates the posted arrangement index
    # against extract_meta's count — it must agree with the player's list.
    pak = _write_dir_sloppak(tmp_path, {"vocal_pitch": "vocal_pitch.json"}, _PITCH)
    meta = sloppak_mod.extract_meta(pak)
    loaded = _load(pak, tmp_path)
    assert len(meta["arrangements"]) == len(loaded.song.arrangements)


def test_extract_meta_suppressed_by_declared_vocalish_entry(tmp_path: Path):
    # A manifest-declared vocal-ish entry (even chartless) is already counted
    # by extract_meta's loop; the projection must not double it. load_song
    # drops the chartless entry and projects — so the counts stay in step.
    pak = _write_dir_sloppak(tmp_path, {"vocal_pitch": "vocal_pitch.json"}, _PITCH)
    manifest = yaml.safe_load((pak / "manifest.yaml").read_text())
    manifest["arrangements"].append({"id": "vox", "name": "Vocal Melody"})
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    meta = sloppak_mod.extract_meta(pak)
    names = [a["name"] for a in meta["arrangements"]]
    assert names.count("Vocals") == 0          # no synthetic duplicate
    assert "Vocal Melody" in names
    loaded = _load(pak, tmp_path)
    assert len(meta["arrangements"]) == len(loaded.song.arrangements)


def test_extract_meta_no_projection_without_key(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {}, None)
    meta = sloppak_mod.extract_meta(pak)
    assert [a["name"] for a in meta["arrangements"]] == ["Lead"]


# ── downstream instrument attribution ────────────────────────────────────────

def test_projected_entry_maps_to_vocals_instrument(tmp_path: Path):
    from progression import instrument_for_arrangement

    pak = _write_dir_sloppak(tmp_path, {"vocal_pitch": "vocal_pitch.json"}, _PITCH)
    meta = sloppak_mod.extract_meta(pak)
    vox_entry = next(a for a in meta["arrangements"] if a["name"] == "Vocals")
    assert instrument_for_arrangement(vox_entry) == "vocals"
