"""Tests for .jsonc support in the sloppak/feedpak loaders (feedpak-spec §8).

When a manifest pointer resolves to a ``.jsonc`` file, the reader MUST strip
C-style comments (``//`` line and ``/* */`` block) before parsing. These tests
exercise every side-file reader in ``lib/sloppak.py`` (arrangement, notation,
drum_tab, song_timeline, lyrics, keys) plus the arrangement/song_timeline
reads in ``scripts/lift_keys_notation.py`` against ``.jsonc`` inputs, and pin
the string-boundary rule (comment-like text inside a JSON string survives).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

import sloppak as sloppak_mod
from jsonc import parse_jsonc
from scripts.lift_keys_notation import _load_song_beats


# ── jsonc.parse_jsonc unit tests ─────────────────────────────────────────────

def test_parse_jsonc_strips_line_comment():
    assert parse_jsonc('{"a": 1 // c\n}') == {"a": 1}


def test_parse_jsonc_strips_block_comment():
    assert parse_jsonc('{"a": /* x */ 2}') == {"a": 2}


def test_parse_jsonc_strips_multiline_block_comment():
    text = '{\n  /* multi\n     line */\n  "a": 1\n}'
    assert parse_jsonc(text) == {"a": 1}


def test_parse_jsonc_preserves_comment_like_text_in_strings():
    # ``//`` and ``/*`` inside a JSON string literal must NOT be treated as
    # comments — the string-aware regex keeps them verbatim.
    text = '{"url": "https://x/y", "note": "// not a comment /* still not */"}'
    out = parse_jsonc(text)
    assert out["url"] == "https://x/y"
    assert out["note"] == "// not a comment /* still not */"


def test_parse_jsonc_rejects_malformed():
    with pytest.raises(json.JSONDecodeError):
        parse_jsonc('{"a": // comment breaks value\n}')


def test_parse_jsonc_plain_json_passes_through():
    assert parse_jsonc('{"a": 1}') == {"a": 1}


# ── Fixture builder ──────────────────────────────────────────────────────────

def _base_arrangement(*, beats=None) -> dict:
    return {
        "name": "Lead", "tuning": [0, 0, 0, 0, 0, 0], "capo": 0,
        "notes": [], "chords": [], "anchors": [], "handshapes": [],
        "templates": [], "beats": beats or [], "sections": [],
    }


def _write_sloppak(root: Path, *, manifest_extras: dict, side_files: dict) -> Path:
    """Build a minimal directory-form sloppak.

    ``side_files`` maps a pak-relative filename (e.g. ``"arrangements/lead.jsonc"``)
    to the exact text to write — so the caller controls comments / extensions.
    """
    pak = root / f"{root.name}.sloppak"
    pak.mkdir()
    (pak / "arrangements").mkdir()
    # A default lead arrangement file the manifest references; can be overridden
    # via side_files if the caller wants a .jsonc arrangement.
    if "arrangements/lead.json" not in side_files and "arrangements/lead.jsonc" not in side_files:
        (pak / "arrangements" / "lead.json").write_text(
            json.dumps(_base_arrangement())
        )
    for rel, text in side_files.items():
        target = pak / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
    manifest = {
        "title": "Test", "artist": "Tester", "album": "", "year": 2026,
        "duration": 10.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": [{"id": "full", "file": "stems/full.ogg", "default": True}],
    }
    manifest.update(manifest_extras)
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    return pak


def _load(pak_path: Path, tmp_path: Path):
    dlc_root = pak_path.parent
    cache = tmp_path / "cache"
    cache.mkdir()
    return sloppak_mod.load_song(pak_path.name, dlc_root, cache)


# ── Arrangement .jsonc ───────────────────────────────────────────────────────

def test_load_arrangement_jsonc_with_comments(tmp_path: Path):
    arr_text = (
        '// lead chart\n'
        '{\n'
        '  "name": "Lead",\n'
        '  "tuning": [0, 0, 0, 0, 0, 0],\n'
        '  "capo": 0,\n'
        '  /* no notes yet */\n'
        '  "notes": [{"t": 0.5, "s": 0, "f": 5, "sus": 0}],\n'
        '  "chords": [], "anchors": [], "handshapes": [], "templates": [],\n'
        '  "beats": [], "sections": []\n'
        '}'
    )
    pak = _write_sloppak(
        tmp_path,
        manifest_extras={
            "arrangements": [{"id": "lead", "name": "Lead",
                              "file": "arrangements/lead.jsonc"}]
        },
        side_files={"arrangements/lead.jsonc": arr_text},
    )
    loaded = _load(pak, tmp_path)
    assert len(loaded.song.arrangements) == 1
    arr = loaded.song.arrangements[0]
    assert arr.name == "Lead"
    assert len(arr.notes) == 1
    assert arr.notes[0].fret == 5


def test_load_arrangement_jsonc_malformed_is_skipped(tmp_path: Path):
    # A .jsonc file that is still invalid after stripping comments must be
    # skipped gracefully (the loader's existing permissive path), not crash.
    pak = _write_sloppak(
        tmp_path,
        manifest_extras={
            "arrangements": [{"id": "lead", "name": "Lead",
                              "file": "arrangements/lead.jsonc"}]
        },
        side_files={"arrangements/lead.jsonc": '{"notes": // broken\n}'},
    )
    loaded = _load(pak, tmp_path)
    # The malformed arrangement is skipped; load still returns a song shell.
    assert len(loaded.song.arrangements) == 0


# ── Notation .jsonc ──────────────────────────────────────────────────────────

def test_load_notation_jsonc_with_comments(tmp_path: Path):
    from tests.test_sloppak_notation_load import VALID_NOTATION
    payload = VALID_NOTATION
    text = (
        '/* notation for keys */\n'
        + json.dumps(payload)
    )
    pak = _write_sloppak(
        tmp_path,
        manifest_extras={
            "arrangements": [{"id": "lead", "name": "Lead",
                              "file": "arrangements/lead.json",
                              "notation": "notation_lead.jsonc"}]
        },
        side_files={"notation_lead.jsonc": text},
    )
    loaded = _load(pak, tmp_path)
    assert loaded.notation_by_id is not None
    assert "lead" in loaded.notation_by_id


# ── drum_tab .jsonc ──────────────────────────────────────────────────────────

def test_load_drum_tab_jsonc_with_comments(tmp_path: Path):
    payload = {
        "version": 1, "name": "Drums",
        "kit": [{"id": "kick", "name": "Kick"}],
        "hits": [{"t": 0.5, "p": "kick", "v": 110}],
    }
    text = '// drum tab\n' + json.dumps(payload)
    pak = _write_sloppak(
        tmp_path,
        manifest_extras={"drum_tab": "drum_tab.jsonc"},
        side_files={"drum_tab.jsonc": text},
    )
    loaded = _load(pak, tmp_path)
    assert loaded.drum_tab is not None
    assert loaded.drum_tab["hits"][0]["p"] == "kick"


# ── song_timeline .jsonc ─────────────────────────────────────────────────────

def test_load_song_timeline_jsonc_with_comments(tmp_path: Path):
    payload = {
        "beats": [{"time": 0.0, "measure": 0}, {"time": 0.5, "measure": 0}],
        "sections": [{"name": "intro", "number": 0, "time": 0.0}],
    }
    text = '/* timeline */\n' + json.dumps(payload)
    pak = _write_sloppak(
        tmp_path,
        manifest_extras={"song_timeline": "song_timeline.jsonc"},
        side_files={"song_timeline.jsonc": text},
    )
    loaded = _load(pak, tmp_path)
    assert loaded.song_timeline is not None
    assert len(loaded.song.beats) == 2
    assert loaded.song.sections[0].name == "intro"


# ── lyrics .jsonc ────────────────────────────────────────────────────────────

def test_load_lyrics_jsonc_with_comments(tmp_path: Path):
    payload = [
        {"w": "Hel", "t": 0.0, "d": 0.2},
        {"w": "lo", "t": 0.2, "d": 0.3},
    ]
    text = '// syllable lyrics\n' + json.dumps(payload)
    pak = _write_sloppak(
        tmp_path,
        manifest_extras={"lyrics": "lyrics.jsonc"},
        side_files={"lyrics.jsonc": text},
    )
    loaded = _load(pak, tmp_path)
    assert len(loaded.song.lyrics) == 2
    assert loaded.song.lyrics[0]["w"] == "Hel"


# ── keys .jsonc ──────────────────────────────────────────────────────────────

def test_load_keys_jsonc_with_comments(tmp_path: Path):
    payload = {
        "version": 1,
        "events": [{"t": 0.0, "key": "Em", "scale": "natural_minor"}],
    }
    text = '/* key/scale track */\n' + json.dumps(payload)
    pak = _write_sloppak(
        tmp_path,
        manifest_extras={"keys": "keys.jsonc"},
        side_files={"keys.jsonc": text},
    )
    loaded = _load(pak, tmp_path)
    assert loaded.keys is not None
    assert loaded.keys["events"][0]["key"] == "Em"


# ── Comment-like text inside strings is preserved end-to-end ─────────────────

def test_load_arrangement_jsonc_preserves_comment_like_string_values(tmp_path: Path):
    # A note whose fret label (if it had one) or a string field contains ``//``
    # must survive the strip. We put a ``//`` inside the arrangement name and a
    # ``/* */`` inside a beat section name to exercise both comment shapes.
    arr_text = (
        '{\n'
        '  "name": "Lead // solo",\n'
        '  "tuning": [0, 0, 0, 0, 0, 0], "capo": 0,\n'
        '  "notes": [], "chords": [], "anchors": [], "handshapes": [], "templates": [],\n'
        '  "beats": [],\n'
        '  "sections": [{"name": "verse /* important */", "number": 0, "time": 0.0}]\n'
        '}'
    )
    pak = _write_sloppak(
        tmp_path,
        manifest_extras={
            "arrangements": [{"id": "lead", "name": "Lead",
                              "file": "arrangements/lead.jsonc"}]
        },
        side_files={"arrangements/lead.jsonc": arr_text},
    )
    loaded = _load(pak, tmp_path)
    arr = loaded.song.arrangements[0]
    # The manifest's ``name: Lead`` overrides the arrangement JSON's name, so
    # assert on the section name instead — it flows straight from the parsed
    # .jsonc with no manifest override, proving the comment-like text inside
    # the string survived the strip.
    assert arr.name == "Lead"
    assert loaded.song.sections[0].name == "verse /* important */"


# ── lift_keys_notation reads .jsonc arrangements / song_timeline ─────────────

def test_lift_keys_notation_loads_song_beats_from_jsonc_timeline(tmp_path: Path):
    """``_load_song_beats`` (the helper the lifter uses to find downbeats) must
    read a ``.jsonc`` song_timeline when the manifest points at one."""
    timeline_text = (
        '// timeline\n'
        + json.dumps({
            "beats": [{"time": 0.0, "measure": 0}, {"time": 0.5, "measure": 0},
                      {"time": 1.0, "measure": 1}],
            "sections": [],
        })
    )
    pak = tmp_path / "song.sloppak"
    pak.mkdir()
    (pak / "arrangements").mkdir()
    (pak / "arrangements" / "keys.json").write_text(json.dumps(_base_arrangement()))
    (pak / "song_timeline.jsonc").write_text(timeline_text, encoding="utf-8")
    manifest = {
        "title": "T", "artist": "A", "duration": 4.0,
        "arrangements": [{"id": "keys", "name": "Keys",
                          "file": "arrangements/keys.json"}],
        "song_timeline": "song_timeline.jsonc",
        "stems": [{"id": "full", "file": "stems/full.ogg"}],
    }
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    beats = _load_song_beats(pak, manifest)
    assert len(beats) == 3
    assert beats[2]["measure"] == 1


def test_lift_keys_notation_falls_back_to_jsonc_arrangement_beats(tmp_path: Path):
    """When no song_timeline is present, ``_load_song_beats`` falls back to the
    first arrangement JSON carrying beats — and that arrangement may be ``.jsonc``."""
    arr_text = (
        '/* keys */\n'
        + json.dumps({
            **_base_arrangement(),
            "beats": [{"time": 0.0, "measure": 0}, {"time": 1.0, "measure": 1}],
        })
    )
    pak = tmp_path / "song.sloppak"
    pak.mkdir()
    (pak / "arrangements").mkdir()
    (pak / "arrangements" / "keys.jsonc").write_text(arr_text, encoding="utf-8")
    manifest = {
        "title": "T", "artist": "A", "duration": 4.0,
        "arrangements": [{"id": "keys", "name": "Keys",
                          "file": "arrangements/keys.jsonc"}],
        "stems": [{"id": "full", "file": "stems/full.ogg"}],
    }
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    beats = _load_song_beats(pak, manifest)
    assert len(beats) == 2
    assert beats[1]["measure"] == 1
