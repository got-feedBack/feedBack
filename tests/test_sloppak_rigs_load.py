"""End-to-end test for the sloppak loader recognising a `rigs:` manifest key
(rigs.json — the pack-level library of engine-agnostic rigs, spec §7.9) and
surfacing the payload on the LoadedSloppak.

The governing posture: rig objects pass through VERBATIM. This loader does not
select realizations or apply the `intent.gm` floor — it only makes the library
addressable by `id`, which is what `tones.base_rig` / `tones.changes[].rig`
reference."""

from __future__ import annotations

import json
from pathlib import Path

import yaml

import sloppak as sloppak_mod


def _write_dir_sloppak(root: Path, manifest_extras: dict, rigs_payload) -> Path:
    """Minimal directory-form sloppak; writes rigs.json when a payload is given.

    Unique filename per test (tmp_path leaf) so the module-level
    resolve_source_dir cache isn't poisoned across tests."""
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
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": [{"id": "full", "file": "stems/full.ogg", "default": True}],
    }
    manifest.update(manifest_extras)
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))

    if rigs_payload is not None:
        (pak / "rigs.json").write_text(json.dumps(rigs_payload))
    return pak


def _load(pak_path: Path, tmp_path: Path):
    dlc_root = pak_path.parent
    cache = tmp_path / "cache"
    cache.mkdir()
    return sloppak_mod.load_song(pak_path.name, dlc_root, cache)


# ── Happy path ───────────────────────────────────────────────────────────────

def test_load_song_attaches_rigs_when_manifest_opts_in(tmp_path: Path):
    """A source rig (spec §7.9 1.18.0) survives the load intact — including the
    `soundfont` realization and the `intent.gm` floor a consumer needs to voice
    the part."""
    payload = {
        "version": 1,
        "rigs": [
            {
                "id": "grand-piano",
                "name": "Grand Piano",
                "instrument": "keys",
                "blocks": [
                    {
                        "role": "source",
                        "name": "Concert Grand",
                        "intent": {"kind": "instrument", "gm": {"program": 0}},
                        "realizations": [
                            {"engine": "soundfont", "format": "sf2",
                             "ref": "sounds/grand.sf2", "bank": 0, "program": 0},
                        ],
                    },
                ],
            },
        ],
    }
    pak = _write_dir_sloppak(tmp_path, {"rigs": "rigs.json"}, payload)
    loaded = _load(pak, tmp_path)
    assert loaded.rigs is not None
    assert loaded.rigs["version"] == 1
    assert loaded.rigs["rigs"] == payload["rigs"]


def test_load_song_rigs_absent_without_manifest_key(tmp_path: Path):
    """The file alone must not opt a pack in — the manifest is the opt-in
    (spec §9.1, "manifest opt-in, file off to the side")."""
    pak = _write_dir_sloppak(tmp_path, {}, {"version": 1, "rigs": []})
    assert _load(pak, tmp_path).rigs is None


# ── Verbatim passthrough ─────────────────────────────────────────────────────

def test_load_song_preserves_unknown_rig_content(tmp_path: Path):
    """Unknown `role` / `engine` / `kind` values and `ext` namespaces MUST
    survive (spec §7.9) — core does not interpret rigs, so it must not prune
    what a newer writer or a plugin put there."""
    payload = {
        "version": 2,
        "rigs": [
            {
                "id": "future-rig",
                "blocks": [
                    {"role": "quantum-flux", "intent": {"kind": "not-yet-invented"},
                     "realizations": [{"engine": "some-future-engine", "ref": "x.bin"}],
                     "ext": {"vendor.custom": {"anything": [1, 2, 3]}}},
                ],
                "graph": {"nodes": ["input", "output"], "edges": [["input", "output"]]},
                "ext": {"vendor.rig": "kept"},
            },
        ],
    }
    pak = _write_dir_sloppak(tmp_path, {"rigs": "rigs.json"}, payload)
    loaded = _load(pak, tmp_path)
    assert loaded.rigs["version"] == 2
    assert loaded.rigs["rigs"] == payload["rigs"]


# ── Addressability ───────────────────────────────────────────────────────────

def test_load_song_drops_unaddressable_rigs_and_normalizes_ids(tmp_path: Path):
    """A rig is reachable only by `id`, so entries without a usable one are
    unreferenceable by construction. Ids are stripped to match the reference
    side, which lib/tones.py strips before it reaches the wire."""
    payload = {
        "rigs": [
            "not-a-dict",
            {"name": "no id at all"},
            {"id": "", "name": "blank id"},
            {"id": "   ", "name": "whitespace id"},
            {"id": 7, "name": "non-string id"},
            {"id": "  padded-rig  ", "name": "Padded"},
            {"id": "plain-rig", "name": "Plain"},
        ],
    }
    pak = _write_dir_sloppak(tmp_path, {"rigs": "rigs.json"}, payload)
    loaded = _load(pak, tmp_path)
    assert [r["id"] for r in loaded.rigs["rigs"]] == ["padded-rig", "plain-rig"]
    # Everything except the normalized id is untouched.
    assert loaded.rigs["rigs"][0]["name"] == "Padded"
    # `version` defaults when the file omits it.
    assert loaded.rigs["version"] == 1


def test_load_song_first_rig_wins_on_duplicate_id(tmp_path: Path):
    """A duplicate id makes `tones.base_rig` ambiguous, which would surface as
    the wrong sound rather than an error."""
    payload = {
        "rigs": [
            {"id": "dupe", "name": "First"},
            {"id": "dupe", "name": "Second"},
            {"id": " dupe ", "name": "Third, padded into a collision"},
        ],
    }
    pak = _write_dir_sloppak(tmp_path, {"rigs": "rigs.json"}, payload)
    loaded = _load(pak, tmp_path)
    assert len(loaded.rigs["rigs"]) == 1
    assert loaded.rigs["rigs"][0]["name"] == "First"


# ── Permissive posture (spec §7.9: never fail the pack) ──────────────────────

def test_load_song_survives_malformed_rigs(tmp_path: Path):
    """Malformed / missing / traversing rig libraries disable rigs, never the
    pack — the song itself must still load."""
    cases = [
        {"version": 1, "rigs": "not-a-list"},   # wrong `rigs` type
        ["top-level-not-a-dict"],               # wrong document type
        {"version": 1},                         # no `rigs` key at all
    ]
    for i, payload in enumerate(cases):
        sub = tmp_path / f"case{i}"
        sub.mkdir()
        pak = _write_dir_sloppak(sub, {"rigs": "rigs.json"}, payload)
        loaded = _load(pak, sub)
        assert loaded.rigs is None, f"case {i} should disable rigs"
        assert loaded.song is not None, f"case {i} must not fail the pack"


def test_load_song_survives_unparseable_rigs(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"rigs": "rigs.json"}, None)
    (pak / "rigs.json").write_text("{ not json at all ")
    loaded = _load(pak, tmp_path)
    assert loaded.rigs is None
    assert loaded.song is not None


def test_load_song_survives_missing_rigs_file(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {"rigs": "rigs.json"}, None)
    loaded = _load(pak, tmp_path)
    assert loaded.rigs is None
    assert loaded.song is not None


def test_load_song_rejects_traversing_rigs_path(tmp_path: Path):
    """A crafted manifest must not read outside the pack."""
    (tmp_path / "outside.json").write_text(json.dumps({"rigs": [{"id": "leaked"}]}))
    pak = _write_dir_sloppak(tmp_path, {"rigs": "../outside.json"}, None)
    loaded = _load(pak, tmp_path)
    assert loaded.rigs is None
    assert loaded.song is not None
