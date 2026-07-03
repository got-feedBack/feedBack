"""Tests for the 'Start here' starter shelf (launch polish) —
GET /api/library/practice-suggestions when NO practice attempts exist.

growth_edge_suggestions returns starter picks (sensible-length songs,
shortest first, flagged starter:true) only on a never-practiced library;
the moment any scored attempt exists the normal growth-edge behaviour is
unchanged — including the honest empty shelf when everything attempted is
mastered. Read-only, like the recommender it falls back from."""

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


def _seed(server, fn, duration, title=None):
    server.meta_db.put(fn, 0, 0, {
        "title": title or fn.split(".")[0], "artist": "A", "duration": duration})


def _play(server, fn, acc, arr=0):
    """Record a scored attempt so the song has a best_accuracy."""
    server.meta_db.record_session(fn, arr, score=int(acc * 1000), accuracy=acc)


def _suggest(client, limit=8):
    return client.get(f"/api/library/practice-suggestions?limit={limit}").json()


# ── No attempts → starter picks, shortest sensible first ─────────────────────

def test_no_attempts_returns_starter_rows(client, server):
    _seed(server, "long.archive", 600)      # > 480s → not a starter
    _seed(server, "jingle.archive", 30)     # < 90s → not a starter
    _seed(server, "mid.archive", 200)
    _seed(server, "short.archive", 120)
    rows = _suggest(client)
    assert [r["filename"] for r in rows] == ["short.archive", "mid.archive"]
    assert all(r["starter"] is True for r in rows)


def test_starter_duration_bounds_inclusive(client, server):
    _seed(server, "at90.archive", 90)
    _seed(server, "at480.archive", 480)
    _seed(server, "under.archive", 89)
    _seed(server, "over.archive", 481)
    _seed(server, "nodur.archive", 0)       # unknown length → never a starter
    got = {r["filename"] for r in _suggest(client)}
    assert got == {"at90.archive", "at480.archive"}


def test_starter_caps_at_eight(client, server):
    for i in range(10):
        _seed(server, f"s{i:02d}.archive", 100 + i)
    assert len(_suggest(client)) == 8
    # Even an explicit larger limit never exceeds the starter cap of 8.
    assert len(_suggest(client, limit=20)) == 8


def test_starter_rows_are_enriched_and_growth_shaped(client, server):
    """Same row shape as the growth-edge rows (the client reuses the card
    markup verbatim) plus the starter marker; enriched by the route."""
    _seed(server, "song.archive", 150, title="My Song")
    r = _suggest(client)[0]
    assert r["starter"] is True
    assert r["title"] == "My Song" and r["artist"] == "A"
    assert r["art_url"].endswith("/art")
    for key in ("filename", "best_accuracy", "arrangement", "last_played_at",
                "user_difficulty", "growth_score"):
        assert key in r
    # No attempt yet → no accuracy/arrangement; the client passes an
    # undefined arrangement so playSong picks the default.
    assert r["best_accuracy"] is None
    assert r["arrangement"] is None


# ── Attempts exist → normal growth-edge behaviour, unchanged ─────────────────

def test_attempts_exist_normal_behaviour_unchanged(client, server):
    _seed(server, "inprog.archive", 150)
    _seed(server, "fresh.archive", 150)
    _play(server, "inprog.archive", 0.6)
    rows = _suggest(client)
    assert [r["filename"] for r in rows] == ["inprog.archive"]
    assert not any(r.get("starter") for r in rows)


def test_all_mastered_returns_empty_not_starter(client, server):
    """Attempts exist and everything attempted is mastered → the shelf is
    honestly empty; the starter fallback must NOT kick in."""
    _seed(server, "done.archive", 150)
    _seed(server, "fresh.archive", 150)
    _play(server, "done.archive", 0.95)
    assert _suggest(client) == []


def test_empty_library_returns_empty(client, server):
    assert _suggest(client) == []
