"""sloppak.load_song() must order arrangements exactly like extract_meta().

The library index (extract_meta) is what the v3 library's arrangement chips —
and playlists' pinned arrangements — pass to playSong(filename, index), which
becomes the highway WebSocket's `?arrangement=N`, which indexes
`load_song(...).song.arrangements`. If the two orders diverge, clicking the
"Lead" chip on a pack whose manifest lists Rhythm first opens Rhythm.
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

import sloppak as sloppak_mod


def _write_pack(root: Path, entries: list[dict]) -> Path:
    """Directory-form sloppak with one empty arrangement JSON per fretted entry.

    Unique filename per test (tmp_path leaf) so the module-level
    resolve_source_dir cache isn't poisoned across tests."""
    pak = root / f"{root.name}.sloppak"
    (pak / "arrangements").mkdir(parents=True)
    manifest_entries = []
    for e in entries:
        entry = dict(e)
        if entry.get("type") not in ("drums", "drum"):
            rel = f"arrangements/{entry['id']}.json"
            (pak / rel).write_text(json.dumps({
                "name": entry["name"], "notes": [], "chords": [], "anchors": [],
                "handshapes": [], "templates": [],
            }))
            entry["file"] = rel
        manifest_entries.append(entry)
    (pak / "manifest.yaml").write_text(yaml.safe_dump({
        "title": "T", "artist": "A", "duration": 1.0,
        "arrangements": manifest_entries,
    }, sort_keys=False))
    return pak


def _load(pak: Path, tmp_path: Path):
    return sloppak_mod.load_song(pak.name, pak.parent, tmp_path / "cache")


def _assert_indices_agree(pak: Path, loaded) -> None:
    meta = sloppak_mod.extract_meta(pak)["arrangements"]
    for a in meta:
        if a["index"] < len(loaded.song.arrangements):
            assert loaded.song.arrangements[a["index"]].name == a["name"], (
                f"library index {a['index']} is {a['name']!r} but the highway "
                f"would load {loaded.song.arrangements[a['index']].name!r}"
            )


def test_load_song_order_matches_extract_meta(tmp_path):
    pak = _write_pack(tmp_path, [
        {"id": "keys", "name": "Keys"},
        {"id": "rhythm", "name": "Rhythm"},
        {"id": "bass", "name": "Bass"},
        {"id": "lead", "name": "Lead"},
    ])
    loaded = _load(pak, tmp_path)

    meta_names = [a["name"] for a in sloppak_mod.extract_meta(pak)["arrangements"]]
    assert meta_names == ["Lead", "Rhythm", "Bass", "Keys"]
    assert [a.name for a in loaded.song.arrangements] == meta_names
    _assert_indices_agree(pak, loaded)


def test_arrangement_ids_stay_parallel_after_sorting(tmp_path):
    # arrangement_ids is indexed by song.arrangements position (notation lookup
    # in ws_highway) — it must be reordered together with the arrangements.
    pak = _write_pack(tmp_path, [
        {"id": "r1", "name": "Rhythm"},
        {"id": "b1", "name": "Bass"},
        {"id": "l1", "name": "Lead"},
    ])
    loaded = _load(pak, tmp_path)
    assert [a.name for a in loaded.song.arrangements] == ["Lead", "Rhythm", "Bass"]
    assert loaded.arrangement_ids == ["l1", "r1", "b1"]


def test_drum_entries_do_not_shift_fretted_indices(tmp_path):
    # `type: drums` entries are listed by extract_meta (the library shows the
    # part) but never become a fretted Arrangement in load_song. They must sort
    # AFTER every fretted part, or a later "other" part (Keys) is off by one.
    pak = _write_pack(tmp_path, [
        {"id": "drums", "name": "Drums", "type": "drums"},
        {"id": "keys", "name": "Keys"},
        {"id": "lead", "name": "Lead"},
    ])
    loaded = _load(pak, tmp_path)

    meta_names = [a["name"] for a in sloppak_mod.extract_meta(pak)["arrangements"]]
    assert meta_names == ["Lead", "Keys", "Drums"]
    assert [a.name for a in loaded.song.arrangements] == ["Lead", "Keys"]
    _assert_indices_agree(pak, loaded)


def test_manifest_already_in_priority_order_is_unchanged(tmp_path):
    pak = _write_pack(tmp_path, [
        {"id": "lead", "name": "Lead"},
        {"id": "combo", "name": "Combo"},
        {"id": "rhythm", "name": "Rhythm"},
        {"id": "bass", "name": "Bass"},
        {"id": "alt", "name": "Lead 2"},
    ])
    loaded = _load(pak, tmp_path)
    assert [a.name for a in loaded.song.arrangements] == [
        "Lead", "Combo", "Rhythm", "Bass", "Lead 2"]
    assert loaded.arrangement_ids == ["lead", "combo", "rhythm", "bass", "alt"]
    _assert_indices_agree(pak, loaded)
