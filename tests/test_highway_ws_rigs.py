"""Integration test for the rig library on the highway WebSocket.

The `tone_changes` frame carries rig *references* (`base_rig`, per-change
`rig`) and each drum part carries its `tones` binding — all of them ids that
mean nothing without the library they point into. This asserts the library
actually reaches the client, verbatim, and that packs binding no rig send the
payload they always did.

Core does not resolve any of it: selecting a realization and applying the
`intent.gm` floor belong to whatever voices the part, so the whole block ships
untouched (spec §7.9).
"""

from __future__ import annotations

import importlib
import json
import sys

import pytest
import yaml
from fastapi.testclient import TestClient


RIGS = {
    "version": 2,
    "rigs": [
        {
            "id": "grand-piano",
            "name": "Grand Piano",
            "instrument": "keys",
            "blocks": [
                {
                    "role": "source",
                    "intent": {"kind": "instrument", "gm": {"program": 0}},
                    "realizations": [
                        {"engine": "soundfont", "format": "sf2",
                         "ref": "sounds/grand.sf2", "bank": 0, "program": 0},
                    ],
                    # Unknown namespace — §7.9 says a Reader MUST preserve it.
                    "ext": {"vendor.custom": {"anything": [1, 2, 3]}},
                },
            ],
        },
        {"id": "std-kit", "name": "Standard Kit", "instrument": "drums",
         "blocks": [{"role": "source",
                     "intent": {"kind": "instrument",
                                "gm": {"percussion": True, "kit": 0}}}]},
    ],
}

TONES = {
    "base": "Grand",
    "base_rig": "grand-piano",
    "changes": [{"t": 12.5, "name": "Rhodes", "rig": "grand-piano"}],
}

DRUM_TAB = {
    "version": 1,
    "name": "Drums",
    "kit": [{"id": "kick", "name": "Kick"}],
    "hits": [{"t": 1.0, "p": "kick", "v": 100}],
}


def _write_sloppak(dlc_dir, *, rigs=None, tones=None, drum_tones=None):
    pak = dlc_dir / "rigtest.sloppak"
    pak.mkdir(parents=True)
    arr_dir = pak / "arrangements"
    arr_dir.mkdir()
    arr = {
        "name": "Lead", "tuning": [0, 0, 0, 0, 0, 0], "capo": 0,
        "notes": [{"t": 1.0, "s": 0, "f": 3, "sus": 0}],
        "chords": [], "anchors": [], "handshapes": [], "templates": [],
        "beats": [{"time": 0.0, "measure": 1}], "sections": [],
    }
    if tones is not None:
        arr["tones"] = tones
    (arr_dir / "lead.json").write_text(json.dumps(arr))

    manifest = {
        "title": "Rig Test", "artist": "Tester", "album": "", "year": 2026,
        "duration": 30.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": [{"id": "full", "file": "stems/full.ogg", "default": True}],
        "drum_tab": "drum_tab.json",
    }
    if rigs is not None:
        manifest["rigs"] = "rigs.json"
        (pak / "rigs.json").write_text(json.dumps(rigs))
    if drum_tones is not None:
        manifest["drum_tones"] = drum_tones
    (pak / "drum_tab.json").write_text(json.dumps(DRUM_TAB))
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    return pak


@pytest.fixture()
def make_client(tmp_path, monkeypatch):
    """Factory: build the DLC dir first, then import a fresh server bound to it."""

    def _make():
        monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
        monkeypatch.setenv("DLC_DIR", str(tmp_path / "dlc"))
        monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
        sys.modules.pop("server", None)
        server = importlib.import_module("server")
        monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
        monkeypatch.setattr(server, "startup_scan", lambda: None)
        monkeypatch.setattr(server, "SLOPPAK_CACHE_DIR", tmp_path / "cache")
        import appstate as _appstate
        monkeypatch.setattr(_appstate, "sloppak_cache_dir", tmp_path / "cache")
        return server

    (tmp_path / "dlc").mkdir()
    yield _make
    server = sys.modules.get("server")
    conn = getattr(getattr(server, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(sys.modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


def _frames(client, limit=300):
    """Every typed frame through `ready` (drains fully so teardown is clean)."""
    out = []
    with client.websocket_connect("/ws/highway/rigtest.sloppak?arrangement=0") as ws:
        for _ in range(limit):
            msg = ws.receive_json()
            if msg.get("error"):
                raise AssertionError(f"WS error frame: {msg}")
            if msg.get("type") == "loading":
                continue
            out.append(msg)
            if msg.get("type") == "ready":
                break
    return out


def _one(frames, kind):
    hits = [f for f in frames if f.get("type") == kind]
    return hits[0] if hits else None


# ── The library reaches the client ───────────────────────────────────────────

def test_rigs_library_streams_verbatim(make_client):
    server = make_client()
    _write_sloppak(server._get_dlc_dir(), rigs=RIGS, tones=TONES)
    with TestClient(server.app) as client:
        frames = _frames(client)

    rigs = _one(frames, "rigs")
    assert rigs is not None, [f["type"] for f in frames]
    assert rigs["version"] == 2
    # Verbatim — including the `ext` namespace and the soundfont realization a
    # Reader that can't render it must still preserve.
    assert rigs["data"] == RIGS["rigs"]


def test_tone_changes_reference_the_library(make_client):
    """The bindings and the library they point into both arrive, and the ids
    line up — that pairing is the whole point of the reader."""
    server = make_client()
    _write_sloppak(server._get_dlc_dir(), rigs=RIGS, tones=TONES)
    with TestClient(server.app) as client:
        frames = _frames(client)

    tc = _one(frames, "tone_changes")
    assert tc["base_rig"] == "grand-piano"
    assert tc["data"] == [{"t": 12.5, "name": "Rhodes", "rig": "grand-piano"}]

    known = {r["id"] for r in _one(frames, "rigs")["data"]}
    assert tc["base_rig"] in known
    assert all(c["rig"] in known for c in tc["data"])


def test_rigs_stream_even_without_arrangement_tones(make_client):
    """A pack can bind sound to its drums alone, so the library must NOT be
    gated on this arrangement having tone changes."""
    server = make_client()
    _write_sloppak(server._get_dlc_dir(), rigs=RIGS, tones=None,
                   drum_tones={"base": "Kit", "base_rig": "std-kit"})
    with TestClient(server.app) as client:
        frames = _frames(client)

    assert _one(frames, "tone_changes") is None      # no arrangement tones
    assert _one(frames, "rigs") is not None          # library still sent


def test_drum_part_carries_its_tones_binding(make_client):
    server = make_client()
    _write_sloppak(server._get_dlc_dir(), rigs=RIGS,
                   drum_tones={"base": "Kit", "base_rig": "std-kit"})
    with TestClient(server.app) as client:
        frames = _frames(client)

    parts = _one(frames, "song_info")["drum_parts"]
    assert len(parts) == 1
    assert parts[0]["tones"] == {"base": "Kit", "base_rig": "std-kit"}
    assert parts[0]["tones"]["base_rig"] in {r["id"] for r in _one(frames, "rigs")["data"]}


# ── Packs that bind nothing are unchanged ────────────────────────────────────

def test_no_rigs_message_when_pack_ships_no_library(make_client):
    server = make_client()
    _write_sloppak(server._get_dlc_dir(), rigs=None, tones=None)
    with TestClient(server.app) as client:
        frames = _frames(client)

    assert _one(frames, "rigs") is None


def test_unbound_pack_keeps_the_legacy_payload_shape(make_client):
    """A chart with tones but no rig bindings must send the exact frame it did
    before the rig model existed — no `base_rig`, no `rig`, no `tones` on the
    drum part."""
    server = make_client()
    _write_sloppak(server._get_dlc_dir(), rigs=None,
                   tones={"base": "Clean", "changes": [{"t": 5.0, "name": "Lead"}]})
    with TestClient(server.app) as client:
        frames = _frames(client)

    tc = _one(frames, "tone_changes")
    assert "base_rig" not in tc
    assert tc["data"] == [{"t": 5.0, "name": "Lead"}]
    assert all("rig" not in c for c in tc["data"])
    assert all("tones" not in p for p in _one(frames, "song_info")["drum_parts"])
