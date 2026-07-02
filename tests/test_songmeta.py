"""Unit tests for lib/songmeta.py — metadata file-persistence helpers."""
from __future__ import annotations

import zipfile

import yaml

# songmeta lives in lib/ which is on PYTHONPATH via conftest / pyproject
from songmeta import (
    _apply_to_sloppak_manifest,
    _coerce_year,
    write_song_metadata,
)


def _make_zip_pak(path, manifest: dict) -> None:
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.yaml", yaml.safe_dump(manifest))
        z.writestr("arrangements/lead.json", "{}")


def _read_zip_manifest(path) -> dict:
    with zipfile.ZipFile(path) as z:
        return yaml.safe_load(z.read("manifest.yaml"))


class TestCoerceYear:
    def test_int_passthrough(self):
        assert _coerce_year(2024) == 2024

    def test_string_digit(self):
        assert _coerce_year("2024") == 2024

    def test_empty_string_clears(self):
        # A user clearing the year field sends "" — must map to 0 so the
        # scanner reads it back as "" (str(0 or "") == "").
        assert _coerce_year("") == 0

    def test_none_clears(self):
        assert _coerce_year(None) == 0

    def test_non_numeric_string_clears(self):
        assert _coerce_year("unknown") == 0

    def test_zero_passthrough(self):
        assert _coerce_year(0) == 0


class TestApplyToSloppakManifest:
    def test_set_title(self):
        manifest = {"title": "Old Title", "artist": "A"}
        dirty = _apply_to_sloppak_manifest(manifest, {"title": "New Title"})
        assert dirty
        assert manifest["title"] == "New Title"
        assert manifest["artist"] == "A"  # untouched

    def test_set_year(self):
        manifest = {"year": 2000}
        dirty = _apply_to_sloppak_manifest(manifest, {"year": "2024"})
        assert dirty
        assert manifest["year"] == 2024

    def test_clear_year(self):
        """Clearing year (empty string) must write 0, not be silently skipped."""
        manifest = {"year": 2020}
        dirty = _apply_to_sloppak_manifest(manifest, {"year": ""})
        assert dirty, "clearing year should mark manifest dirty"
        assert manifest["year"] == 0

    def test_no_year_key_leaves_existing(self):
        """If 'year' is not in fields at all, the existing value is preserved."""
        manifest = {"year": 2020}
        dirty = _apply_to_sloppak_manifest(manifest, {"title": "T"})
        assert dirty
        assert manifest["year"] == 2020  # untouched

    def test_empty_fields(self):
        manifest = {"title": "T"}
        dirty = _apply_to_sloppak_manifest(manifest, {})
        assert not dirty


class TestWriteSongMetadata:
    """Suffix dispatch — zip-form packages are writable under BOTH the current
    ``.feedpak`` suffix and the legacy ``.sloppak`` one. The ``.feedpak`` gate
    was missed when the format was renamed, silently downgrading Edit Metadata
    to a DB-only update that a full rescan reverts."""

    def test_zip_feedpak_persists(self, tmp_path):
        pak = tmp_path / "song.feedpak"
        _make_zip_pak(pak, {"title": "Old", "artist": "A"})
        assert write_song_metadata(pak, {"title": "New"})
        assert _read_zip_manifest(pak)["title"] == "New"

    def test_zip_sloppak_persists(self, tmp_path):
        pak = tmp_path / "song.sloppak"
        _make_zip_pak(pak, {"title": "Old", "artist": "A"})
        assert write_song_metadata(pak, {"title": "New"})
        assert _read_zip_manifest(pak)["title"] == "New"

    def test_zip_suffix_case_insensitive(self, tmp_path):
        pak = tmp_path / "song.FeedPak"
        _make_zip_pak(pak, {"title": "Old"})
        assert write_song_metadata(pak, {"title": "New"})
        assert _read_zip_manifest(pak)["title"] == "New"

    def test_directory_form_persists(self, tmp_path):
        pak = tmp_path / "song.feedpak"
        pak.mkdir()
        (pak / "manifest.yaml").write_text(
            yaml.safe_dump({"title": "Old"}), encoding="utf-8"
        )
        assert write_song_metadata(pak, {"title": "New"})
        got = yaml.safe_load((pak / "manifest.yaml").read_text(encoding="utf-8"))
        assert got["title"] == "New"

    def test_unknown_suffix_returns_false(self, tmp_path):
        f = tmp_path / "song.txt"
        f.write_text("not a package")
        assert not write_song_metadata(f, {"title": "New"})
