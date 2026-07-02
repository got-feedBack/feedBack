"""Tests for the Albums-view follow-up (#689's client half): the feedpak
`track`/`disc` fields flowing scanner → songs columns → the `track` sort the
album track list orders by."""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def server(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    monkeypatch.setenv("DLC_DIR", str(dlc))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    srv = importlib.import_module("server")
    try:
        yield srv
    finally:
        conn = getattr(getattr(srv, "meta_db", None), "conn", None)
        if conn is not None:
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


def _put(server, fn, title, track=None, disc=None, album="The Album", artist="Artist"):
    server.meta_db.put(fn, 0, 0, {
        "title": title, "artist": artist, "album": album, "year": "1990",
        "duration": 100, "arrangements": [{"name": "Lead", "index": 0}],
        "track_number": track, "disc": disc,
    })


def test_sloppak_extract_meta_reads_track_and_disc(server):
    d = server.DLC_DIR / "a.sloppak"
    d.mkdir(parents=True)
    (d / "manifest.yaml").write_text(
        "title: Song\nartist: Artist\nduration: 100\n"
        "arrangements: []\nstems: []\ntrack: 7\ndisc: 2\n", encoding="utf-8")
    import sloppak
    meta = sloppak.extract_meta(d)
    assert meta["track_number"] == 7
    assert meta["disc"] == 2
    # Unauthored → None (the album view falls back to title order).
    (d / "manifest.yaml").write_text(
        "title: Song\nartist: Artist\nduration: 100\n"
        "arrangements: []\nstems: []\n", encoding="utf-8")
    meta = sloppak.extract_meta(d)
    assert meta["track_number"] is None
    assert meta["disc"] is None


def test_track_sort_orders_by_disc_then_track_nulls_last(server, client):
    _put(server, "d2t1.sloppak", "Zeta", track=1, disc=2)
    _put(server, "d1t2.sloppak", "Yankee", track=2, disc=1)
    _put(server, "d1t1.sloppak", "Xray", track=1, disc=1)
    _put(server, "nonum-b.sloppak", "Bravo")            # unauthored → bottom,
    _put(server, "nonum-a.sloppak", "Alpha")            # ordered by title
    body = client.get("/api/library", params={
        "artist": "Artist", "album": "The Album", "sort": "track", "size": 50}).json()
    assert [s["filename"] for s in body["songs"]] == [
        "d1t1.sloppak", "d1t2.sloppak", "d2t1.sloppak",
        "nonum-a.sloppak", "nonum-b.sloppak"]


def test_track_and_disc_survive_put_roundtrip(server):
    _put(server, "a.sloppak", "Song", track=3, disc=1)
    row = server.meta_db.conn.execute(
        "SELECT track_number, disc FROM songs WHERE filename = 'a.sloppak'").fetchone()
    assert row == (3, 1)
