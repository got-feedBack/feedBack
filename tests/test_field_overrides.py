"""Tests for the per-field metadata override + lock store (Fix-metadata popup).

A reversible DISPLAY overlay, never written to the pack: filename-keyed, so it
survives a rescan (never purged by delete_missing) and is dropped only with the
song (delete_song). Locks pin a field against a later auto-match.
"""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def server(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SKIP_STARTUP_TASKS", "1")
    sys.modules.pop("server", None)
    srv = importlib.import_module("server")
    try:
        yield srv
    finally:
        conn = getattr(getattr(srv, "meta_db", None), "conn", None)
        if conn is not None:
            getattr(sys.modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


def _put(server, fn, **meta):
    base = {"title": "Song", "artist": "Artist", "album": "", "duration": 100,
            "arrangements": [{"name": "Lead", "index": 0}]}
    base.update(meta)
    server.meta_db.put(fn, 0, 0, base)


# ── store semantics ───────────────────────────────────────────────────────────

def test_set_get_and_partial_upsert(server):
    db = server.meta_db
    assert db.get_song_overrides("a.archive") == {}
    db.set_song_override("a.archive", "artist", value="AC/DC")
    assert db.get_song_overrides("a.archive") == {"artist": {"value": "AC/DC", "locked": False}}
    # partial: lock without touching the value
    db.set_song_override("a.archive", "artist", locked=True)
    assert db.get_song_overrides("a.archive")["artist"] == {"value": "AC/DC", "locked": True}
    # partial: change the value, keep the lock
    db.set_song_override("a.archive", "artist", value="AC/DC (fixed)")
    assert db.get_song_overrides("a.archive")["artist"] == {"value": "AC/DC (fixed)", "locked": True}


def test_lock_only_row_persists_without_a_value(server):
    db = server.meta_db
    db.set_song_override("a.archive", "year", locked=True)
    # a pure lock (no override value) is a valid, kept row
    assert db.get_song_overrides("a.archive") == {"year": {"value": None, "locked": True}}


def test_empty_and_unlocked_drops_the_row(server):
    db = server.meta_db
    db.set_song_override("a.archive", "album", value="X", locked=True)
    db.set_song_override("a.archive", "album", value="", locked=False)
    assert db.get_song_overrides("a.archive") == {}          # no empty shell


def test_clear_one_field_leaves_others(server):
    db = server.meta_db
    db.set_song_override("a.archive", "title", value="T")
    db.set_song_override("a.archive", "artist", value="A")
    db.clear_song_override("a.archive", "title")
    assert set(db.get_song_overrides("a.archive")) == {"artist"}


# ── lifecycle: rescan survival vs explicit delete ─────────────────────────────

def test_rescan_never_purges_overrides_delete_does(server):
    _put(server, "a.archive")
    server.meta_db.set_song_override("a.archive", "artist", value="AC/DC", locked=True)
    server.meta_db.delete_missing(set())                     # file vanished from a scan
    assert server.meta_db.get_song_overrides("a.archive")["artist"]["value"] == "AC/DC"
    server.meta_db.purge_song_user_data("a.archive")         # the delete_song purge
    assert server.meta_db.get_song_overrides("a.archive") == {}


def test_overrides_map_batches(server):
    db = server.meta_db
    db.set_song_override("a.archive", "artist", value="A")
    db.set_song_override("b.archive", "title", value="B", locked=True)
    m = db.overrides_map(["a.archive", "b.archive", "missing.archive"])
    assert m["a.archive"]["artist"]["value"] == "A"
    assert m["b.archive"]["title"] == {"value": "B", "locked": True}
    assert "missing.archive" not in m
    assert db.overrides_map([]) == {}


# ── API ───────────────────────────────────────────────────────────────────────

def test_api_put_get_and_clear(client, server):
    _put(server, "a.archive")
    r = client.put("/api/song/a.archive/overrides",
                   json={"overrides": {"artist": {"value": "AC/DC", "locked": True},
                                       "year": {"value": "1979"}}})
    assert r.status_code == 200
    ov = r.json()["overrides"]
    assert ov["artist"] == {"value": "AC/DC", "locked": True}
    assert ov["year"] == {"value": "1979", "locked": False}
    assert client.get("/api/song/a.archive/overrides").json()["overrides"]["artist"]["value"] == "AC/DC"
    # clear via PUT (value null + unlocked) — DELETE is shadowed by /api/song/{path}
    client.put("/api/song/a.archive/overrides",
               json={"overrides": {"artist": {"value": None, "locked": False}}})
    assert "artist" not in client.get("/api/song/a.archive/overrides").json()["overrides"]


def test_api_rejects_unknown_field(client, server):
    _put(server, "a.archive")
    r = client.put("/api/song/a.archive/overrides",
                   json={"overrides": {"tuning": {"value": "Drop D"}}})
    assert r.status_code == 400
    assert "unknown field" in r.json()["error"]


# ── lock enforcement (slice 2) ────────────────────────────────────────────────

def test_locked_fields_reader(server):
    db = server.meta_db
    db.set_song_override("a.archive", "artist", value="X", locked=True)
    db.set_song_override("a.archive", "title", value="Y")            # override, not locked
    db.set_song_override("a.archive", "year", locked=True)           # lock only
    assert db.locked_fields("a.archive") == {"artist", "year"}


def test_compose_lock_filter_strips_locked_cand_keys(server):
    f = server._compose_lock_filter(None, {"artist", "year"})
    cand = {"recording_id": "r", "artist": "X", "artist_sort": "X", "title": "T",
            "year": "1990", "album": "A", "genres": ["rock"]}
    out = f(cand)
    # locked display keys stripped (artist maps to artist + artist_sort)…
    assert not ({"artist", "artist_sort", "year"} & set(out))
    # …identity + unlocked display fields survive
    assert out["recording_id"] == "r" and out["title"] == "T" and out["album"] == "A"
    # no locks → base filter returned unchanged (zero-copy common path)
    assert server._compose_lock_filter(None, set()) is None
