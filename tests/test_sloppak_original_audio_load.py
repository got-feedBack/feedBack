"""End-to-end test for the sloppak loader recognising an `original_audio:`
manifest key (the single full-mix file shipped alongside the separate stems)
and surfacing the manifest-relative path on the LoadedSloppak."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

import sloppak as sloppak_mod


def _write_dir_sloppak(root: Path, manifest_extras: dict, *, write_full_mix: bool) -> Path:
    """Build a minimal directory-form sloppak that load_song will accept.

    Uses the tmp_path leaf name to make the sloppak filename unique per test,
    avoiding the module-level ``resolve_source_dir`` cache being poisoned by a
    previous test that happened to share the same "song.sloppak" filename.
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
        "beats": [],
        "sections": [],
    }
    (arr_dir / "lead.json").write_text(json.dumps(arr))

    manifest = {
        "title": "Test",
        "artist": "Tester",
        "album": "",
        "year": 2026,
        "duration": 10.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": [{"id": "guitar", "file": "stems/guitar.ogg", "default": True}],
    }
    manifest.update(manifest_extras)
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))

    if write_full_mix:
        orig_dir = pak / "original"
        orig_dir.mkdir()
        # The loader only checks presence (is_file); contents are irrelevant.
        (orig_dir / "full.ogg").write_bytes(b"OggS-not-real")

    return pak


def _load(pak_path: Path, tmp_path: Path):
    dlc_root = pak_path.parent
    cache = tmp_path / "cache"
    cache.mkdir()
    return sloppak_mod.load_song(pak_path.name, dlc_root, cache)


# ── Happy path ───────────────────────────────────────────────────────────────

def test_load_song_attaches_original_audio_when_manifest_opts_in(tmp_path: Path):
    pak = _write_dir_sloppak(
        tmp_path, {"original_audio": "original/full.ogg"}, write_full_mix=True
    )
    loaded = _load(pak, tmp_path)
    # Stored as the manifest-relative string so server.py can build the URL the
    # same way it builds stem URLs.
    assert loaded.original_audio == "original/full.ogg"


# ── Absent / degraded branches ───────────────────────────────────────────────

def test_load_song_original_audio_none_when_manifest_silent(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {}, write_full_mix=True)
    loaded = _load(pak, tmp_path)
    assert loaded.original_audio is None


def test_load_song_original_audio_none_when_file_missing(tmp_path: Path):
    # Manifest points at a full mix that isn't on disk — disabled silently.
    pak = _write_dir_sloppak(
        tmp_path, {"original_audio": "original/full.ogg"}, write_full_mix=False
    )
    loaded = _load(pak, tmp_path)
    assert loaded.original_audio is None


def test_load_song_original_audio_none_when_value_blank(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"original_audio": "   "}, write_full_mix=True)
    loaded = _load(pak, tmp_path)
    assert loaded.original_audio is None


# ── Security / path-traversal branches ──────────────────────────────────────

def test_load_song_original_audio_none_when_path_escapes_sloppak(tmp_path: Path):
    pak = _write_dir_sloppak(
        tmp_path, {"original_audio": "../outside.ogg"}, write_full_mix=True
    )
    loaded = _load(pak, tmp_path)
    assert loaded.original_audio is None


def test_load_song_original_audio_none_when_path_is_absolute(tmp_path: Path):
    pak = _write_dir_sloppak(
        tmp_path, {"original_audio": "/etc/passwd"}, write_full_mix=True
    )
    loaded = _load(pak, tmp_path)
    assert loaded.original_audio is None
