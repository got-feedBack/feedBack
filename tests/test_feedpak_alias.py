"""Coverage for the additive sloppak → feedpak rename (back-compat foundation).

The format was renamed `sloppak` → `feedpak`. This phase is purely additive: both
the `.feedpak` and legacy `.sloppak` extensions must load, the new `feedpak`
module must re-export the loader, the `feedpak_version` manifest key must be read,
and every legacy `sloppak`-named symbol must keep working. Nothing sloppak breaks.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

import sloppak as sloppak_mod
import feedpak as feedpak_mod


def _build(root: Path, suffix: str, manifest_extras: dict | None = None) -> Path:
    """Build a minimal directory-form pack with the given extension."""
    pak = root / f"{root.name}{suffix}"
    pak.mkdir()
    arr_dir = pak / "arrangements"
    arr_dir.mkdir()
    (arr_dir / "lead.json").write_text(json.dumps({
        "name": "Lead", "tuning": [0, 0, 0, 0, 0, 0], "capo": 0,
        "notes": [], "chords": [], "anchors": [], "handshapes": [], "templates": [],
    }))
    manifest = {
        "title": "Test", "artist": "Tester", "album": "", "year": 2026,
        "duration": 10.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": [{"id": "full", "file": "stems/full.ogg", "default": True}],
    }
    manifest.update(manifest_extras or {})
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    return pak


def _load(mod, pak: Path, tmp_path: Path):
    cache = tmp_path / "cache"
    cache.mkdir()
    return mod.load_song(pak.name, pak.parent, cache)


# ── Both extensions are detected ──────────────────────────────────────────────

@pytest.mark.parametrize("suffix", [".feedpak", ".sloppak"])
def test_detection_accepts_both_extensions(tmp_path: Path, suffix: str):
    pak = tmp_path / f"song{suffix}"
    assert sloppak_mod.is_pack(pak)
    assert sloppak_mod.is_feedpak(pak)
    assert sloppak_mod.is_sloppak(pak)  # deprecated alias still accepts .feedpak


def test_detection_rejects_other_extensions(tmp_path: Path):
    assert not sloppak_mod.is_pack(tmp_path / "song.zip")
    assert not sloppak_mod.is_pack(tmp_path / "song.mp3")


# ── Both extensions load, via both module names ───────────────────────────────

@pytest.mark.parametrize("suffix", [".feedpak", ".sloppak"])
def test_load_via_sloppak_module(tmp_path: Path, suffix: str):
    pak = _build(tmp_path, suffix)
    loaded = _load(sloppak_mod, pak, tmp_path)
    assert loaded.song.title == "Test"
    assert loaded.stems[0]["id"] == "full"


@pytest.mark.parametrize("suffix", [".feedpak", ".sloppak"])
def test_load_via_feedpak_module(tmp_path: Path, suffix: str):
    """The canonical `feedpak` module re-exports the loader and loads both forms."""
    pak = _build(tmp_path, suffix)
    loaded = _load(feedpak_mod, pak, tmp_path)
    assert loaded.song.title == "Test"


def test_feedpak_module_reexports_match_sloppak():
    for name in ("load_song", "load_manifest", "extract_meta", "resolve_source_dir",
                 "is_pack", "is_feedpak", "is_sloppak", "read_feedpak_version"):
        assert getattr(feedpak_mod, name) is getattr(sloppak_mod, name)
    assert feedpak_mod.LoadedFeedpak is sloppak_mod.LoadedSloppak


# ── feedpak_version is read ───────────────────────────────────────────────────

def test_feedpak_version_read_when_present(tmp_path: Path):
    pak = _build(tmp_path, ".feedpak", {"feedpak_version": "1.0.0"})
    loaded = _load(feedpak_mod, pak, tmp_path)
    assert loaded.feedpak_version == "1.0.0"
    assert feedpak_mod.extract_meta(pak)["feedpak_version"] == "1.0.0"


def test_feedpak_version_none_when_absent(tmp_path: Path):
    pak = _build(tmp_path, ".feedpak")
    loaded = _load(feedpak_mod, pak, tmp_path)
    assert loaded.feedpak_version is None
    assert feedpak_mod.extract_meta(pak)["feedpak_version"] is None


def test_feedpak_version_ignores_non_string(tmp_path: Path):
    pak = _build(tmp_path, ".feedpak", {"feedpak_version": 1})
    loaded = _load(feedpak_mod, pak, tmp_path)
    assert loaded.feedpak_version is None
