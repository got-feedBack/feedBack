"""Drum gameplay metadata (feedpak 1.20.0) on the highway WebSocket.

A drums pack's `drum_tab.json` may carry accents (`a`), double kicks (`x2`),
star power / fill / solo ranges and easier `levels`. This drives the real
FastAPI app over a temp DLC dir and asserts the wire contract:

- `drum_hits` carry `a` and `x2`,
- the `drum_tab` frame carries the sanitised range lists and a `levels` index,
- each level's hits follow as `drum_level_hits` chunks (no `x2` there),
- a tab without the 1.20.0 keys streams exactly the pre-1.20.0 frames.
"""

from __future__ import annotations

import importlib
import json
import sys

import pytest
import yaml
from fastapi.testclient import TestClient


FULL_TAB = {
    "version": 1,
    "name": "Drums",
    "kit": [{"id": "kick", "name": "Kick"}, {"id": "snare", "name": "Snare"}, {"id": "crash_l", "name": "Crash"}],
    "hits": [
        {"t": 0.5, "p": "kick"},
        {"t": 0.5, "p": "crash_l", "a": True},
        {"t": 0.625, "p": "kick", "x2": True},
        {"t": 0.75, "p": "snare", "g": True},
    ],
    "star_power": [{"start_time": 0.5, "end_time": 2.5}],
    "fills": [{"start_time": 6.0, "end_time": 8.0}, {"start_time": 9.0, "end_time": 1.0}],
    "solos": [{"start_time": 32.0, "end_time": 48.0}],
    "levels": {
        "hard": {"hits": [{"t": 0.5, "p": "kick", "x2": True}, {"t": 0.5, "p": "crash_l", "a": True}]},
        "easy": {"hits": [{"t": 0.5, "p": "crash_l"}], "generated": True},
    },
}

PLAIN_TAB = {"version": 1, "name": "Drums", "hits": [{"t": 0.5, "p": "kick"}, {"t": 0.75, "p": "snare"}]}


def _write_pack(dlc_root, tab, name="drumtest"):
    pak = dlc_root / f"{name}.sloppak"
    pak.mkdir()
    (pak / "drum_tab.json").write_text(json.dumps(tab))
    manifest = {
        "title": "Drum WS Test",
        "artist": "Tester",
        "album": "",
        "year": 2026,
        "duration": 60.0,
        "arrangements": [{"id": "drums", "name": "Drums", "type": "drums", "drum_tab": "drum_tab.json"}],
        "drum_tab": "drum_tab.json",
        "stems": [],
    }
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
        getattr(server, "_join_background_db_threads", lambda: None)()
        conn.close()


def _frames(client, path, limit=400):
    """All typed frames (keepalive `loading` skipped) through `ready`."""
    out = []
    with client.websocket_connect(path) as ws:
        for _ in range(limit):
            msg = ws.receive_json()
            if msg.get("error"):
                raise AssertionError(f"WS error frame: {msg}")
            if msg.get("type") == "loading":
                continue
            out.append(msg)
            if msg.get("type") == "ready":
                break
    assert out and out[-1]["type"] == "ready", [f.get("type") for f in out]
    return out


def test_drum_metadata_streams_with_the_tab(make_client):
    server = make_client()
    _write_pack(server._get_dlc_dir(), FULL_TAB)
    with TestClient(server.app) as client:
        frames = _frames(client, "/ws/highway/drumtest.sloppak?arrangement=0")
    types = [f["type"] for f in frames]

    tab = frames[types.index("drum_tab")]
    assert tab["star_power"] == [{"start_time": 0.5, "end_time": 2.5}]
    # the malformed fill (ends before it starts) is dropped, the good one kept
    assert tab["fills"] == [{"start_time": 6.0, "end_time": 8.0}]
    assert tab["solos"] == [{"start_time": 32.0, "end_time": 48.0}]
    assert tab["levels"] == {
        "easy": {"total": 1, "generated": True},
        "hard": {"total": 2, "generated": False},
    }

    hits = [h for f in frames if f["type"] == "drum_hits" for h in f["data"]]
    assert {"t": 0.5, "p": "crash_l", "a": True} in hits
    assert {"t": 0.625, "p": "kick", "x2": True} in hits
    assert {"t": 0.75, "p": "snare", "g": True} in hits

    # level hits follow the top-level hits, chunked per level, never with x2
    i_last_hits = max(i for i, t in enumerate(types) if t == "drum_hits")
    lv_frames = [(i, f) for i, f in enumerate(frames) if f["type"] == "drum_level_hits"]
    assert lv_frames and all(i > i_last_hits for i, _ in lv_frames)
    by_level: dict[str, list] = {}
    for _, f in lv_frames:
        by_level.setdefault(f["level"], []).extend(f["data"])
        assert f["total"] == tab["levels"][f["level"]]["total"]
    assert by_level["easy"] == [{"t": 0.5, "p": "crash_l"}]
    assert by_level["hard"] == [{"t": 0.5, "p": "kick"}, {"t": 0.5, "p": "crash_l", "a": True}]


def test_tab_without_metadata_keeps_the_old_frames(make_client):
    server = make_client()
    _write_pack(server._get_dlc_dir(), PLAIN_TAB, name="plain")
    with TestClient(server.app) as client:
        frames = _frames(client, "/ws/highway/plain.sloppak?arrangement=0")
    tab = next(f for f in frames if f["type"] == "drum_tab")
    assert set(tab) == {"type", "version", "name", "kit", "total"}
    assert not any(f["type"] == "drum_level_hits" for f in frames)


def test_level_hits_are_chunked(make_client):
    server = make_client()
    big = dict(PLAIN_TAB)
    big["levels"] = {"medium": {"hits": [{"t": i * 0.01, "p": "snare"} for i in range(1203)]}}
    _write_pack(server._get_dlc_dir(), big, name="big")
    with TestClient(server.app) as client:
        frames = _frames(client, "/ws/highway/big.sloppak?arrangement=0", limit=600)
    chunks = [f for f in frames if f["type"] == "drum_level_hits"]
    assert [len(c["data"]) for c in chunks] == [500, 500, 203]
    assert all(c["level"] == "medium" and c["total"] == 1203 for c in chunks)
