"""Loader coverage for MULTIPLE drum parts (feedpak 1.17.0 "drums as
arrangements").

A drum part rides the manifest as a `type: drums` arrangement entry carrying
a per-arrangement `drum_tab` file pointer and NO note `file`. The loader:

  - NEVER turns a pointer entry into a fretted Arrangement — that skip is
    the grading invariant (an empty drum chart must not reach the fretted
    pipeline, where note detection would grade it as garbage);
  - resolves the parts into `LoadedSloppak.drum_parts`, primary FIRST: the
    entry aliasing the song-level `drum_tab:` file contributes its id/name
    but is never loaded twice (its payload IS `loaded.drum_tab`);
  - loads each extra part's file with the same permissive posture as the
    song-level tab (a bad part disables that part only, never the load);
  - copes with a pointer-only pack (no song-level key): the first part
    becomes the primary so every legacy consumer keeps working.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

import yaml

import sloppak as sloppak_mod


def _tab(name: str, hits: list[dict] | None = None) -> dict:
    return {
        "version": 1,
        "name": name,
        "kit": [{"id": "kick", "name": "Kick"}],
        "hits": hits if hits is not None else [{"t": 1.0, "p": "kick", "v": 100}],
    }


def _write_pak(root: Path, manifest_extras: dict, files: dict[str, dict | str]) -> Path:
    """A minimal directory-form sloppak with one Lead arrangement plus the
    given extra files ({relpath: json-dict-or-raw-text})."""
    pak = root / f"{root.name}.sloppak"
    pak.mkdir()
    arr_dir = pak / "arrangements"
    arr_dir.mkdir()
    arr = {
        "name": "Lead", "tuning": [0, 0, 0, 0, 0, 0], "capo": 0,
        "notes": [], "chords": [], "anchors": [], "handshapes": [],
        "templates": [], "beats": [], "sections": [],
    }
    (arr_dir / "lead.json").write_text(json.dumps(arr))
    manifest = {
        "title": "Test", "artist": "Tester", "album": "", "year": 2026,
        "duration": 10.0,
        "arrangements": [
            {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
        ],
        "stems": [{"id": "full", "file": "stems/full.ogg", "default": True}],
    }
    manifest.update(manifest_extras)
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    for rel, payload in files.items():
        text = payload if isinstance(payload, str) else json.dumps(payload)
        (pak / rel).write_text(text)
    return pak


def _load(pak_path: Path, tmp_path: Path):
    dlc_root = pak_path.parent
    cache = tmp_path / "cache"
    cache.mkdir()
    return sloppak_mod.load_song(pak_path.name, dlc_root, cache)


def _two_part_manifest() -> dict:
    """The exact shape the editor writes: primary alias entry + one extra."""
    return {
        "drum_tab": "drum_tab.json",
        "arrangements": [
            {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
            {"id": "drums", "name": "Drums", "type": "drums",
             "drum_tab": "drum_tab.json"},
            {"id": "drums-2", "name": "Drums (Live)", "type": "drums",
             "drum_tab": "drum_tab_drums-2.json"},
        ],
    }


# ── The grading invariant ────────────────────────────────────────────────────

def test_pointer_entries_never_become_fretted_arrangements(tmp_path: Path):
    pak = _write_pak(tmp_path, _two_part_manifest(), {
        "drum_tab.json": _tab("Drums"),
        "drum_tab_drums-2.json": _tab("Drums (Live)"),
    })
    loaded = _load(pak, tmp_path)
    # Only the Lead chart is an Arrangement — neither drum part enters the
    # fretted pipeline (song.arrangements is what note detection grades).
    assert [a.name for a in loaded.song.arrangements] == ["Lead"]
    # And the ids list stays parallel to song.arrangements (skipped entries
    # contribute nothing) — a misalignment here would remap every chart edit.
    assert loaded.arrangement_ids == ["lead"]


def test_drums_typed_entry_with_note_file_never_frets(tmp_path: Path):
    # A malformed entry: type:drums but ALSO carrying a note `file`. Keying the
    # skip on file absence would let it through as a fretted, selectable,
    # gradeable Arrangement (spec §5.2/§7.5 MUST-NOT). Routing on `type` first
    # drops it instead — it never reaches song.arrangements.
    bogus = {
        "name": "Bogus", "tuning": [0, 0, 0, 0, 0, 0], "capo": 0,
        "notes": [], "chords": [], "anchors": [], "handshapes": [],
        "templates": [], "beats": [], "sections": [],
    }
    pak = _write_pak(tmp_path, {
        "arrangements": [
            {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
            {"id": "bad", "name": "Bogus", "type": "drums",
             "file": "arrangements/bogus.json"},
        ],
    }, {"arrangements/bogus.json": bogus})
    loaded = _load(pak, tmp_path)
    assert [a.name for a in loaded.song.arrangements] == ["Lead"]
    assert loaded.arrangement_ids == ["lead"]


# ── Parts resolution ─────────────────────────────────────────────────────────

def test_two_parts_resolve_primary_first_with_alias_identity(tmp_path: Path):
    pak = _write_pak(tmp_path, _two_part_manifest(), {
        "drum_tab.json": _tab("Drums"),
        "drum_tab_drums-2.json": _tab("Drums (Live)", [{"t": 2.0, "p": "kick", "v": 90}]),
    })
    loaded = _load(pak, tmp_path)
    assert loaded.drum_parts is not None
    assert [(p["id"], p["name"]) for p in loaded.drum_parts] == [
        ("drums", "Drums"), ("drums-2", "Drums (Live)"),
    ]
    # The primary's payload IS the song-level tab — same object, loaded once.
    assert loaded.drum_parts[0]["drum_tab"] is loaded.drum_tab
    assert loaded.drum_parts[1]["drum_tab"]["hits"][0]["t"] == 2.0


def test_primary_pointer_equivalent_path_is_not_duplicated(tmp_path: Path):
    manifest = {
        "drum_tab": "drum_tab.json",
        "arrangements": [
            {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
            {"id": "kit", "name": "Live Kit", "type": "drums",
             "drum_tab": "./drum_tab.json"},
        ],
    }
    pak = _write_pak(tmp_path, manifest, {"drum_tab.json": _tab("Drums")})
    loaded = _load(pak, tmp_path)
    assert loaded.drum_parts is not None
    assert [(p["id"], p["name"]) for p in loaded.drum_parts] == [
        ("kit", "Live Kit"),
    ]
    assert loaded.drum_parts[0]["drum_tab"] is loaded.drum_tab


def test_legacy_single_drum_pack_gets_a_one_part_list(tmp_path: Path):
    pak = _write_pak(tmp_path, {"drum_tab": "drum_tab.json"}, {
        "drum_tab.json": _tab("Drums"),
    })
    loaded = _load(pak, tmp_path)
    assert loaded.drum_parts is not None and len(loaded.drum_parts) == 1
    assert loaded.drum_parts[0]["id"] == "drums"
    assert loaded.drum_parts[0]["drum_tab"] is loaded.drum_tab


def test_no_drums_means_no_parts(tmp_path: Path):
    pak = _write_pak(tmp_path, {}, {})
    loaded = _load(pak, tmp_path)
    assert loaded.drum_parts is None
    assert loaded.drum_tab is None


def test_pointer_only_pack_promotes_the_first_part_to_primary(tmp_path: Path):
    # A writer that omitted the song-level alias: readers must cope (the
    # spec keeps the alias, but a reader never crashes on its absence).
    pak = _write_pak(tmp_path, {
        "arrangements": [
            {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
            {"id": "kit", "name": "Kit", "type": "drums",
             "drum_tab": "drum_tab_kit.json"},
        ],
    }, {"drum_tab_kit.json": _tab("Kit")})
    loaded = _load(pak, tmp_path)
    assert loaded.drum_parts is not None and len(loaded.drum_parts) == 1
    # The part's tab becomes THE drum tab, so has_drum_tab / the default
    # stream / the drum-only placeholder all keep working.
    assert loaded.drum_tab is loaded.drum_parts[0]["drum_tab"]
    assert loaded.drum_parts[0]["id"] == "kit"


# ── Permissive per-part failure ──────────────────────────────────────────────

def test_a_bad_extra_part_disables_that_part_only(tmp_path: Path):
    manifest = _two_part_manifest()
    manifest["arrangements"].append(
        {"id": "drums-3", "name": "Broken", "type": "drums",
         "drum_tab": "drum_tab_broken.json"})
    pak = _write_pak(tmp_path, manifest, {
        "drum_tab.json": _tab("Drums"),
        "drum_tab_drums-2.json": _tab("Drums (Live)"),
        "drum_tab_broken.json": "not json {{{",
    })
    loaded = _load(pak, tmp_path)
    assert [p["id"] for p in loaded.drum_parts] == ["drums", "drums-2"]


def test_a_traversal_part_path_is_skipped(tmp_path: Path):
    manifest = _two_part_manifest()
    manifest["arrangements"][2]["drum_tab"] = "../outside.json"
    (tmp_path / "outside.json").write_text(json.dumps(_tab("Evil")))
    pak = _write_pak(tmp_path, manifest, {"drum_tab.json": _tab("Drums")})
    loaded = _load(pak, tmp_path)
    assert [p["id"] for p in loaded.drum_parts] == ["drums"]


def test_duplicate_pointer_rels_load_once(tmp_path: Path):
    manifest = _two_part_manifest()
    manifest["arrangements"].append(
        {"id": "drums-dup", "name": "Dup", "type": "drums",
         "drum_tab": "drum_tab_drums-2.json"})
    pak = _write_pak(tmp_path, manifest, {
        "drum_tab.json": _tab("Drums"),
        "drum_tab_drums-2.json": _tab("Drums (Live)"),
    })
    loaded = _load(pak, tmp_path)
    assert [p["id"] for p in loaded.drum_parts] == ["drums", "drums-2"]


def test_duplicate_part_ids_are_made_unique(tmp_path: Path):
    manifest = _two_part_manifest()
    manifest["arrangements"][2]["id"] = "drums"
    manifest["arrangements"].append(
        {"id": "drums-2", "name": "Aux", "type": "drums",
         "drum_tab": "drum_tab_aux.json"})
    pak = _write_pak(tmp_path, manifest, {
        "drum_tab.json": _tab("Drums"),
        "drum_tab_drums-2.json": _tab("Drums (Live)"),
        "drum_tab_aux.json": _tab("Aux"),
    })
    loaded = _load(pak, tmp_path)
    assert [p["id"] for p in loaded.drum_parts] == ["drums", "drums-2", "drums-3"]


def test_drum_pointer_with_wrong_type_logs_warning(tmp_path: Path, caplog):
    pak = _write_pak(tmp_path, {
        "arrangements": [
            {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
            {"id": "typo", "type": "druns", "drum_tab": "drum_tab_typo.json"},
        ],
    }, {"drum_tab_typo.json": _tab("Typo")})
    # feedBack sets propagate=False, so pytest's root capture sees nothing from
    # it — attach caplog's handler to the feedBack logger and pin WARNING
    # regardless of ambient level (a sibling test can leak ERROR onto this tree).
    lg = logging.getLogger("feedBack")
    orig_level = lg.level
    lg.addHandler(caplog.handler)
    lg.setLevel(logging.WARNING)
    try:
        loaded = _load(pak, tmp_path)
    finally:
        lg.removeHandler(caplog.handler)
        lg.setLevel(orig_level)
    assert loaded.drum_parts is None
    assert "has drum_tab" in caplog.text and "type='druns'" in caplog.text


# ── Drum-only pack with parts ────────────────────────────────────────────────

def test_drum_only_pack_with_pointer_entries_still_synthesizes_placeholder(tmp_path: Path):
    # No pitched arrangements at all, drums via pointer entries only: the
    # placeholder "Drums" arrangement must still appear so the highway WS
    # proceeds and the tab reaches the drum highway.
    pak = _write_pak(tmp_path, {
        "arrangements": [
            {"id": "kit", "name": "Kit", "type": "drums",
             "drum_tab": "drum_tab_kit.json"},
        ],
    }, {"drum_tab_kit.json": _tab("Kit", [{"t": 5.0, "p": "kick", "v": 100}])})
    # Remove the Lead arrangement _write_pak added to the manifest.
    manifest_path = pak / "manifest.yaml"
    manifest = yaml.safe_load(manifest_path.read_text())
    manifest["arrangements"] = [e for e in manifest["arrangements"] if e.get("id") != "lead"]
    manifest.pop("duration", None)
    manifest_path.write_text(yaml.safe_dump(manifest, sort_keys=False))
    loaded = _load(pak, tmp_path)
    assert [a.name for a in loaded.song.arrangements] == ["Drums"]
    assert loaded.drum_parts is not None and loaded.drum_parts[0]["id"] == "kit"
    # Song length derived from the last hit (the drum-only path's rule).
    assert loaded.song.song_length > 5.0
