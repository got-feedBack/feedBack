"""Loader coverage for the manifest-vs-in-JSON `tones` precedence cascade
(feedpak 1.18.0, spec §5.1 / §5.2).

Two rules, both about *which* sound binding wins, neither about interpreting it:

  - A manifest arrangement entry's `tones` replaces the arrangement JSON's
    `tones` **WHOLESALE** — no field-level merge. A half-merged block (this
    source's `base` with that source's `changes`) would be a sound nobody
    authored, so the two never blend.
  - Top-level `drum_tones` binds the song-level (primary) drum part and is the
    fallback; a `type: drums` entry's own `tones` takes precedence, and a
    Reader MUST NOT apply both to the same part.
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

import sloppak as sloppak_mod


IN_JSON_TONES = {
    "base": "In-JSON Clean",
    "base_rig": "injson-clean",
    "changes": [{"t": 5.0, "name": "In-JSON Lead", "rig": "injson-lead"}],
}
ENTRY_TONES = {
    "base": "Entry Grand",
    "base_rig": "entry-grand",
    "changes": [{"t": 9.0, "name": "Entry Rhodes", "rig": "entry-rhodes"}],
}


def _tab(name: str) -> dict:
    return {
        "version": 1,
        "name": name,
        "kit": [{"id": "kick", "name": "Kick"}],
        "hits": [{"t": 1.0, "p": "kick", "v": 100}],
    }


def _write_pak(root: Path, manifest_extras: dict, arr_tones: dict | None = None,
               files: dict[str, dict] | None = None) -> Path:
    """Directory-form sloppak with one Lead arrangement, optionally carrying an
    in-JSON `tones` block, plus any extra files."""
    pak = root / f"{root.name}.sloppak"
    pak.mkdir()
    arr_dir = pak / "arrangements"
    arr_dir.mkdir()
    arr = {
        "name": "Lead", "tuning": [0, 0, 0, 0, 0, 0], "capo": 0,
        "notes": [], "chords": [], "anchors": [], "handshapes": [],
        "templates": [], "beats": [], "sections": [],
    }
    if arr_tones is not None:
        arr["tones"] = arr_tones
    (arr_dir / "lead.json").write_text(json.dumps(arr))

    manifest = {
        "title": "Test", "artist": "Tester", "album": "", "year": 2026,
        "duration": 10.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": [{"id": "full", "file": "stems/full.ogg", "default": True}],
    }
    manifest.update(manifest_extras)
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    for rel, payload in (files or {}).items():
        (pak / rel).write_text(json.dumps(payload))
    return pak


def _load(pak_path: Path, tmp_path: Path):
    cache = tmp_path / "cache"
    cache.mkdir()
    return sloppak_mod.load_song(pak_path.name, pak_path.parent, cache)


# ── Arrangement entry vs in-JSON (§5.2) ──────────────────────────────────────

def test_entry_tones_replaces_in_json_wholesale(tmp_path: Path):
    """The entry object replaces the in-JSON one entirely — no key survives
    from the loser, not even ones the winner doesn't define."""
    entry_tones = {"base": "Entry Only"}          # no base_rig, no changes
    pak = _write_pak(
        tmp_path,
        {"arrangements": [{"id": "lead", "name": "Lead",
                           "file": "arrangements/lead.json",
                           "tones": entry_tones}]},
        arr_tones=IN_JSON_TONES,
    )
    arr = _load(pak, tmp_path).song.arrangements[0]
    assert arr.tones == entry_tones
    # The in-JSON `base_rig` and `changes` must NOT have been merged in.
    assert "base_rig" not in arr.tones
    assert "changes" not in arr.tones


def test_in_json_tones_survive_when_entry_has_none(tmp_path: Path):
    pak = _write_pak(tmp_path, {}, arr_tones=IN_JSON_TONES)
    assert _load(pak, tmp_path).song.arrangements[0].tones == IN_JSON_TONES


def test_empty_entry_tones_is_absent_not_an_override(tmp_path: Path):
    """`{}` reads as "didn't specify", not "override to silence" — otherwise a
    stray empty object silently unbinds the part's sound."""
    pak = _write_pak(
        tmp_path,
        {"arrangements": [{"id": "lead", "name": "Lead",
                           "file": "arrangements/lead.json", "tones": {}}]},
        arr_tones=IN_JSON_TONES,
    )
    assert _load(pak, tmp_path).song.arrangements[0].tones == IN_JSON_TONES


def test_malformed_entry_tones_is_ignored(tmp_path: Path):
    """A non-dict `tones` must not override, and must not crash the load."""
    pak = _write_pak(
        tmp_path,
        {"arrangements": [{"id": "lead", "name": "Lead",
                           "file": "arrangements/lead.json",
                           "tones": ["not", "a", "dict"]}]},
        arr_tones=IN_JSON_TONES,
    )
    assert _load(pak, tmp_path).song.arrangements[0].tones == IN_JSON_TONES


def test_entry_tones_binds_a_notation_only_arrangement(tmp_path: Path):
    """§5.2: entry `tones` is available whether or not the arrangement has a
    `file` — a keys part is a notation-only entry, and binding its sound is the
    whole point of the 1.18.0 work."""
    notation = {"version": 1, "measures": []}
    pak = _write_pak(
        tmp_path,
        {"arrangements": [{"id": "keys", "name": "Keys",
                           "notation": "notation_keys.json",
                           "tones": ENTRY_TONES}]},
        files={"notation_keys.json": notation},
    )
    arr = _load(pak, tmp_path).song.arrangements[0]
    assert arr.name == "Keys"
    assert arr.tones == ENTRY_TONES


# ── drum_tones vs entry tones (§5.1) ─────────────────────────────────────────

def test_drum_tones_binds_the_primary_part(tmp_path: Path):
    pak = _write_pak(
        tmp_path,
        {"drum_tab": "drum_tab.json", "drum_tones": ENTRY_TONES},
        files={"drum_tab.json": _tab("Drums")},
    )
    parts = _load(pak, tmp_path).drum_parts
    assert len(parts) == 1
    assert parts[0]["tones"] == ENTRY_TONES


def test_entry_tones_outrank_drum_tones_on_the_primary(tmp_path: Path):
    """An alias pointer entry naming the same file IS the primary, so its own
    binding wins — and `drum_tones` must not also be applied."""
    alias_tones = {"base": "Alias Kit", "base_rig": "alias-kit"}
    pak = _write_pak(
        tmp_path,
        {
            "drum_tab": "drum_tab.json",
            "drum_tones": ENTRY_TONES,
            "arrangements": [
                {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
                {"id": "drums", "name": "Drums", "type": "drums",
                 "drum_tab": "drum_tab.json", "tones": alias_tones},
            ],
        },
        files={"drum_tab.json": _tab("Drums")},
    )
    parts = _load(pak, tmp_path).drum_parts
    assert len(parts) == 1
    assert parts[0]["tones"] == alias_tones


def test_drum_tones_does_not_leak_to_secondary_parts(tmp_path: Path):
    """`drum_tones` is the PRIMARY's fallback only. A second drummer with no
    binding of its own gets None — not the primary's kit."""
    live_tones = {"base": "Live Kit", "base_rig": "live-kit"}
    pak = _write_pak(
        tmp_path,
        {
            "drum_tab": "drum_tab.json",
            "drum_tones": ENTRY_TONES,
            "arrangements": [
                {"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
                {"id": "drums-live", "name": "Drums (Live)", "type": "drums",
                 "drum_tab": "drum_tab_live.json", "tones": live_tones},
                {"id": "drums-prog", "name": "Drums (Prog)", "type": "drums",
                 "drum_tab": "drum_tab_prog.json"},
            ],
        },
        files={
            "drum_tab.json": _tab("Drums"),
            "drum_tab_live.json": _tab("Drums Live"),
            "drum_tab_prog.json": _tab("Drums Prog"),
        },
    )
    parts = {p["id"]: p for p in _load(pak, tmp_path).drum_parts}
    assert parts["drums"]["tones"] == ENTRY_TONES        # primary, from drum_tones
    assert parts["drums-live"]["tones"] == live_tones    # own entry
    assert parts["drums-prog"]["tones"] is None          # no binding, no leak


def test_drum_parts_carry_none_when_pack_binds_nothing(tmp_path: Path):
    """A pack with drums and no sound binding at all still loads, with the key
    present and None — consumers can read `part["tones"]` unconditionally."""
    pak = _write_pak(
        tmp_path,
        {"drum_tab": "drum_tab.json"},
        files={"drum_tab.json": _tab("Drums")},
    )
    parts = _load(pak, tmp_path).drum_parts
    assert parts[0]["tones"] is None


def test_malformed_drum_tones_is_ignored(tmp_path: Path):
    pak = _write_pak(
        tmp_path,
        {"drum_tab": "drum_tab.json", "drum_tones": "not-a-dict"},
        files={"drum_tab.json": _tab("Drums")},
    )
    assert _load(pak, tmp_path).drum_parts[0]["tones"] is None
