"""Tests for scripts/solo_sections.py — the feedpak I/O around lib/solo_sections.

Builds directory- and zip-form packs from the synthetic charts in
test_solo_sections.py and checks dry-run, where the section lands (song
timeline vs arrangement JSON), the never-overwrite rule, and that a zip keeps
every other member byte-for-byte.
"""

from __future__ import annotations

import json
import shutil
import zipfile
from pathlib import Path

import yaml

from scripts.solo_sections import analyse, main
from tests.test_solo_sections import _beats, _chart, _rhythm

import sloppak


def _write_pack(root: Path, name: str = "song.feedpak", *, timeline: bool = False,
                lead: dict | None = None, extra_arrs: bool = True) -> Path:
    pak = root / name
    (pak / "arrangements").mkdir(parents=True)
    lead = lead if lead is not None else _chart()
    rhythm = _rhythm()
    arrs = [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"},
            {"id": "rhythm", "name": "Rhythm", "file": "arrangements/rhythm.json"}]
    if extra_arrs:
        arrs.append({"id": "bass", "name": "Bass", "type": "bass", "file": "arrangements/bass.json"})
        (pak / "arrangements" / "bass.json").write_text(
            json.dumps({"notes": [], "chords": []}), encoding="utf-8")
    manifest = {"title": "T", "artist": "A", "duration": 80.0, "arrangements": arrs,
                "stems": [{"id": "full", "file": "stems/full.ogg"}]}
    if timeline:
        manifest["song_timeline"] = "song_timeline.json"
        (pak / "song_timeline.json").write_text(json.dumps(
            {"version": 1, "beats": lead.pop("beats"), "sections": lead.pop("sections")}),
            encoding="utf-8")
    (pak / "arrangements" / "lead.json").write_text(json.dumps(lead), encoding="utf-8")
    (pak / "arrangements" / "rhythm.json").write_text(json.dumps(rhythm), encoding="utf-8")
    (pak / "stems").mkdir()
    (pak / "stems" / "full.ogg").write_bytes(b"OggS-not-really-audio")
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8")
    return pak


def _zip_pack(pak: Path) -> Path:
    z = pak.with_name(pak.name + ".zip-tmp")
    with zipfile.ZipFile(z, "w") as zf:
        for f in sorted(pak.rglob("*")):
            if f.is_file():
                zf.write(f, f.relative_to(pak).as_posix(),
                         compress_type=zipfile.ZIP_STORED if f.suffix == ".ogg" else zipfile.ZIP_DEFLATED)
    shutil.rmtree(pak)
    z.rename(pak)
    return pak


def _loaded_sections(pak: Path, tmp_path: Path) -> list[str]:
    """Section names as the real loader sees them."""
    loaded = sloppak.load_song(pak.name, pak.parent, tmp_path / "cache")
    return [s.name for s in loaded.song.sections]


def _sections(pak: Path, rel: str) -> list[dict]:
    return json.loads(sloppak.read_member_bytes(pak, rel))["sections"]


def test_dry_run_changes_nothing(tmp_path):
    pak = _write_pack(tmp_path)
    before = {f: f.read_bytes() for f in pak.rglob("*") if f.is_file()}
    assert main([str(tmp_path)]) == 0
    assert {f: f.read_bytes() for f in pak.rglob("*") if f.is_file()} == before


def test_write_into_arrangement_json_when_no_timeline(tmp_path):
    pak = _write_pack(tmp_path)
    plan = analyse(pak)
    # Only the lead JSON carries sections, so only it is a target; bass is not
    # a guitar part and rhythm has no sections.
    assert sorted(plan["targets"]) == ["arrangements/lead.json"]
    assert main([str(pak), "--write"]) == 0
    names = [(s["name"], s["time"]) for s in _sections(pak, "arrangements/lead.json")]
    assert ("solo", 40.0) in names and ("chorus", 56.0) in names
    # Rest of the chart untouched.
    lead = json.loads((pak / "arrangements" / "lead.json").read_text(encoding="utf-8"))
    assert lead["notes"] == _chart()["notes"]
    assert "sections" not in json.loads((pak / "arrangements" / "rhythm.json").read_text())


def test_write_updates_every_arrangement_carrying_sections(tmp_path):
    pak = _write_pack(tmp_path)
    rhythm = _rhythm()
    rhythm["sections"] = _chart()["sections"]
    (pak / "arrangements" / "rhythm.json").write_text(json.dumps(rhythm), encoding="utf-8")
    main([str(pak), "--write"])
    assert _sections(pak, "arrangements/lead.json") == _sections(pak, "arrangements/rhythm.json")
    assert _loaded_sections(pak, tmp_path)[2] == "solo"


def test_write_into_song_timeline_when_present(tmp_path):
    pak = _write_pack(tmp_path, timeline=True)
    lead_before = (pak / "arrangements" / "lead.json").read_bytes()
    main([str(pak), "--write"])
    assert (pak / "arrangements" / "lead.json").read_bytes() == lead_before
    tl = json.loads((pak / "song_timeline.json").read_text(encoding="utf-8"))
    assert tl["version"] == 1 and tl["beats"] == _beats()
    assert [s["name"] for s in tl["sections"]] == ["verse", "chorus", "solo", "chorus", "verse"]
    # The loader sees it (song_timeline wins over arrangement JSON).
    assert _loaded_sections(pak, tmp_path) == ["verse", "chorus", "solo", "chorus", "verse"]


def test_never_overwrites_an_existing_solo(tmp_path):
    lead = _chart()
    lead["sections"].append({"name": "Guitar Solo", "number": 1, "time": 70.0})
    pak = _write_pack(tmp_path, lead=lead)
    before = (pak / "arrangements" / "lead.json").read_bytes()
    plan = analyse(pak)
    assert plan["marked"] and plan["targets"] == {}
    main([str(pak), "--write"])
    assert (pak / "arrangements" / "lead.json").read_bytes() == before


def test_rerun_is_idempotent(tmp_path):
    pak = _write_pack(tmp_path)
    main([str(pak), "--write"])
    once = (pak / "arrangements" / "lead.json").read_bytes()
    main([str(pak), "--write"])
    assert (pak / "arrangements" / "lead.json").read_bytes() == once


def test_zip_form_rewrite_keeps_other_members(tmp_path):
    pak = _zip_pack(_write_pack(tmp_path))
    with zipfile.ZipFile(pak) as zf:
        before = {i.filename: (zf.read(i), i.compress_type) for i in zf.infolist()}
    main([str(tmp_path), "--write"])
    with zipfile.ZipFile(pak) as zf:
        after = {i.filename: (zf.read(i), i.compress_type) for i in zf.infolist()}
    assert set(after) == set(before)
    for name in before:
        if name == "arrangements/lead.json":
            assert after[name] != before[name]
        else:
            assert after[name] == before[name]
    assert any(s["name"] == "solo" for s in _sections(pak, "arrangements/lead.json"))
    assert not list(tmp_path.glob("*.solo-tmp"))


def test_jsonc_target_is_not_rewritten(tmp_path):
    pak = _write_pack(tmp_path, timeline=True)
    (pak / "song_timeline.json").rename(pak / "song_timeline.jsonc")
    m = yaml.safe_load((pak / "manifest.yaml").read_text(encoding="utf-8"))
    m["song_timeline"] = "song_timeline.jsonc"
    (pak / "manifest.yaml").write_text(yaml.safe_dump(m, sort_keys=False), encoding="utf-8")
    before = (pak / "song_timeline.jsonc").read_bytes()
    assert analyse(pak)["targets"] == {}
    main([str(pak), "--write"])
    assert (pak / "song_timeline.jsonc").read_bytes() == before


def test_match_filter_and_json_report(tmp_path, capsys):
    _write_pack(tmp_path, "keep_me.feedpak")
    _write_pack(tmp_path, "other.sloppak")
    main([str(tmp_path), "--match", "KEEP", "--json"])
    report = json.loads(capsys.readouterr().out)
    assert [Path(r["file"]).name for r in report] == ["keep_me.feedpak"]
    assert report[0]["status"] == "FOUND"
    assert report[0]["targets"] == ["arrangements/lead.json"]
