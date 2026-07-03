"""Tests for the bulk personal-meta endpoint (P2):
POST /api/songs/user-meta/batch — the apply-to-all behind the Songs batch bar.
DB-only, never touches files. Additive by design: bulk tag edits ADD/REMOVE
(never full-replace) and an omitted `set_difficulty` leaves each song's own
value alone (mixed-state "leave unchanged")."""

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
            getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


def _seed(server, *filenames):
    for fn in filenames:
        server.meta_db.put(fn, 0, 0, {"title": fn.split(".")[0], "artist": "A"})


def _um(client, fn):
    return client.get(f"/api/song/{fn}/user-meta").json()


BATCH = "/api/songs/user-meta/batch"


# ── Difficulty across a selection ────────────────────────────────────────────

def test_batch_set_difficulty_on_all(client, server):
    _seed(server, "a.archive", "b.archive", "c.archive")
    r = client.post(BATCH, json={"filenames": ["a.archive", "b.archive"],
                                 "set_difficulty": 4})
    assert r.status_code == 200
    assert r.json()["updated"] == 2
    assert _um(client, "a.archive")["user_difficulty"] == 4
    assert _um(client, "b.archive")["user_difficulty"] == 4
    # untouched song stays unset
    assert _um(client, "c.archive")["user_difficulty"] is None


def test_batch_clear_difficulty_preserves_notes(client, server):
    _seed(server, "a.archive", "b.archive")
    client.put("/api/song/a.archive/user-meta", json={"user_difficulty": 3, "notes": "keep me"})
    client.put("/api/song/b.archive/user-meta", json={"user_difficulty": 2})
    r = client.post(BATCH, json={"filenames": ["a.archive", "b.archive"],
                                 "set_difficulty": None})
    assert r.status_code == 200
    # a still has its notes; b (no notes) is fully cleared
    a = _um(client, "a.archive")
    assert a["user_difficulty"] is None and a["notes"] == "keep me"
    assert _um(client, "b.archive") == {"user_difficulty": None, "notes": "", "tags": []}


def test_omitting_set_difficulty_leaves_each_value(client, server):
    """Mixed-state: no set_difficulty key → every song keeps its own difficulty
    while tags still apply."""
    _seed(server, "a.archive", "b.archive")
    client.put("/api/song/a.archive/user-meta", json={"user_difficulty": 1})
    client.put("/api/song/b.archive/user-meta", json={"user_difficulty": 5})
    client.post(BATCH, json={"filenames": ["a.archive", "b.archive"],
                             "add_tags": ["gig"]})
    assert _um(client, "a.archive")["user_difficulty"] == 1
    assert _um(client, "b.archive")["user_difficulty"] == 5
    assert _um(client, "a.archive")["tags"] == ["gig"]


# ── Tags: additive, never full-replace ───────────────────────────────────────

def test_batch_add_tags_does_not_clobber_existing(client, server):
    _seed(server, "a.archive", "b.archive")
    client.put("/api/song/a.archive/user-meta", json={"tags": ["existing"]})
    client.post(BATCH, json={"filenames": ["a.archive", "b.archive"],
                             "add_tags": ["Warm-ups", "warm-ups"]})  # dupe-folds
    assert _um(client, "a.archive")["tags"] == ["existing", "warm-ups"]
    assert _um(client, "b.archive")["tags"] == ["warm-ups"]


def test_batch_remove_tags(client, server):
    _seed(server, "a.archive", "b.archive")
    client.put("/api/song/a.archive/user-meta", json={"tags": ["gig", "riffs"]})
    client.put("/api/song/b.archive/user-meta", json={"tags": ["gig"]})
    client.post(BATCH, json={"filenames": ["a.archive", "b.archive"],
                             "remove_tags": ["gig"]})
    assert _um(client, "a.archive")["tags"] == ["riffs"]
    assert _um(client, "b.archive")["tags"] == []


def test_add_wins_over_remove_conflict(client, server):
    _seed(server, "a.archive")
    client.post(BATCH, json={"filenames": ["a.archive"],
                             "add_tags": ["keep"], "remove_tags": ["keep"]})
    assert _um(client, "a.archive")["tags"] == ["keep"]


def test_returned_tag_vocabulary_refreshes(client, server):
    _seed(server, "a.archive", "b.archive")
    body = client.post(BATCH, json={"filenames": ["a.archive", "b.archive"],
                                    "add_tags": ["warmups"]}).json()
    assert {"tag": "warmups", "count": 2} in body["tags"]


# ── Validation ───────────────────────────────────────────────────────────────

def test_empty_filenames_is_400(client, server):
    assert client.post(BATCH, json={"filenames": [], "set_difficulty": 3}).status_code == 400
    assert client.post(BATCH, json={"set_difficulty": 3}).status_code == 400


def test_nothing_to_apply_is_400(client, server):
    _seed(server, "a.archive")
    assert client.post(BATCH, json={"filenames": ["a.archive"]}).status_code == 400


@pytest.mark.parametrize("bad", [0, 6, 2.5, "x", True])
def test_bad_set_difficulty_is_400(client, server, bad):
    _seed(server, "a.archive")
    assert client.post(BATCH, json={"filenames": ["a.archive"],
                                    "set_difficulty": bad}).status_code == 400


def test_tags_must_be_arrays(client, server):
    _seed(server, "a.archive")
    assert client.post(BATCH, json={"filenames": ["a.archive"],
                                    "add_tags": "gig"}).status_code == 400


def test_batch_survives_rescan(client, server):
    _seed(server, "a.archive")
    client.post(BATCH, json={"filenames": ["a.archive"],
                             "set_difficulty": 3, "add_tags": ["t"]})
    server.meta_db.put("a.archive", 1, 1, {"title": "a", "artist": "A"})
    m = _um(client, "a.archive")
    assert m["user_difficulty"] == 3 and m["tags"] == ["t"]
