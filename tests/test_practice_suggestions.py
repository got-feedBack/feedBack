"""Tests for the P3 growth-edge 'practice next' recommender —
GET /api/library/practice-suggestions + meta_db.growth_edge_suggestions().

The score is difficulty-appropriateness (mid band wins) × mastery-proximity
(closer to 0.9, not yet there). Read-only: it must never write difficulty.
Personal difficulty is per-filename (P1); authored/derived seeding + true
per-arrangement difficulty are deferred pending the feedpak difficulty spec."""

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
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


def _seed(server, fn, title=None):
    server.meta_db.put(fn, 0, 0, {"title": title or fn.split(".")[0], "artist": "A"})


def _play(server, fn, acc, arr=0):
    """Record a scored attempt so the song has a best_accuracy."""
    server.meta_db.record_session(fn, arr, score=int(acc * 1000), accuracy=acc)


def _diff(client, fn, d):
    client.put(f"/api/song/{fn}/user-meta", json={"user_difficulty": d})


def _suggest(client, limit=8):
    return client.get(f"/api/library/practice-suggestions?limit={limit}").json()


SUG = "/api/library/practice-suggestions"


# ── Gating: only attempted & not-yet-mastered ────────────────────────────────

def test_excludes_mastered_and_unattempted(client, server):
    _seed(server, "mastered.archive"); _play(server, "mastered.archive", 0.95)
    _seed(server, "inprog.archive");   _play(server, "inprog.archive", 0.6)
    _seed(server, "fresh.archive")     # never played
    got = {r["filename"] for r in _suggest(client)}
    assert got == {"inprog.archive"}


def test_empty_when_nothing_attempted(client, server):
    _seed(server, "a.archive")
    assert _suggest(client) == []


# ── Ordering: mid-difficulty preferred at equal accuracy ──────────────────────

def test_mid_difficulty_ranks_above_extremes(client, server):
    for fn in ("mid.archive", "easy.archive", "hard.archive"):
        _seed(server, fn); _play(server, fn, 0.6)
    _diff(client, "mid.archive", 3)
    _diff(client, "easy.archive", 1)
    _diff(client, "hard.archive", 5)
    order = [r["filename"] for r in _suggest(client)]
    assert order[0] == "mid.archive"
    # 1 and 5 share the same weight, so both trail mid
    assert set(order[1:]) == {"easy.archive", "hard.archive"}


# ── Ordering: closer-to-mastery preferred at equal difficulty ─────────────────

def test_closer_to_mastery_ranks_higher(client, server):
    _seed(server, "almost.archive"); _play(server, "almost.archive", 0.85)
    _seed(server, "early.archive");  _play(server, "early.archive", 0.4)
    # both unrated (→ treated as mid), so accuracy proximity decides
    order = [r["filename"] for r in _suggest(client)]
    assert order == ["almost.archive", "early.archive"]


def test_unrated_still_surfaces_as_mid(client, server):
    """Before anything is rated the shelf must still work (degrades to
    closest-to-mastery). An unrated song outranks a very-easy rated one at
    similar accuracy."""
    _seed(server, "unrated.archive"); _play(server, "unrated.archive", 0.7)
    _seed(server, "veryeasy.archive"); _play(server, "veryeasy.archive", 0.72)
    _diff(client, "veryeasy.archive", 1)
    order = [r["filename"] for r in _suggest(client)]
    # unrated (weight 1.0 × 0.70 = 0.70) beats very-easy (0.6 × 0.72 = 0.432)
    assert order[0] == "unrated.archive"


# ── Best arrangement = the one closest to mastery ────────────────────────────

def test_suggested_arrangement_is_best(client, server):
    _seed(server, "multi.archive")
    _play(server, "multi.archive", 0.5, arr=0)
    _play(server, "multi.archive", 0.8, arr=1)   # closer to mastery
    r = _suggest(client)[0]
    assert r["filename"] == "multi.archive"
    assert r["arrangement"] == 1
    assert r["best_accuracy"] == 0.8


# ── Enrichment + limit ───────────────────────────────────────────────────────

def test_rows_are_enriched(client, server):
    _seed(server, "song.archive", title="My Song"); _play(server, "song.archive", 0.6)
    r = _suggest(client)[0]
    assert r["title"] == "My Song" and r["artist"] == "A"
    assert r["art_url"].endswith("/art")
    assert "growth_score" in r


def test_limit_is_respected(client, server):
    for i in range(5):
        fn = f"s{i}.archive"; _seed(server, fn); _play(server, fn, 0.5 + i * 0.05)
    assert len(_suggest(client, limit=3)) == 3


# ── Read-only: never writes difficulty ───────────────────────────────────────

def test_recommender_never_writes_difficulty(client, server):
    _seed(server, "a.archive"); _play(server, "a.archive", 0.6)
    _suggest(client)
    assert client.get("/api/song/a.archive/user-meta").json()["user_difficulty"] is None
