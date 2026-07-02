"""Tests for the metadata-enrichment plumbing (P7): the song_enrichment cache
table + identity hashing + the queue/lifecycle around the (for now) no-op
matcher. The text matcher itself is the next slice; these tests pin the
contracts it will inherit: rename-survivable idempotent hashing, manual rows
never auto-reset, never purged on rescan, purged on explicit delete."""

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


def _put(server, fn, title="Song", artist="Artist", album="", duration=100):
    server.meta_db.put(fn, 0, 0, {
        "title": title, "artist": artist, "album": album, "duration": duration,
        "arrangements": [{"name": "Lead", "index": 0}],
    })


# ── identity hash ─────────────────────────────────────────────────────────────

def test_hash_is_rename_survivable_and_normalized(server):
    h = server.meta_db.enrichment_content_hash
    # keyed on metadata, not the filename → a renamed pack keeps its hash
    assert h("Artist", "Song", "Album", 100) == h("Artist", "Song", "Album", 100)
    # case + whitespace folded; duration rounded to whole seconds
    assert h(" artist ", "SONG", "album", 100.4) == h("Artist", "Song", "Album", 100)
    # a real identity change means a different hash
    assert h("Artist", "Song", "Album", 100) != h("Artist", "Other", "Album", 100)
    assert h("Artist", "Song", "Album", None) == h("Artist", "Song", "Album", 0)


# ── queue selection ───────────────────────────────────────────────────────────

def test_pending_covers_new_unscanned_and_changed(server):
    _put(server, "a.archive")
    assert [r["filename"] for r in server.meta_db.enrichment_pending()] == ["a.archive"]
    # stubbed → still unscanned → still pending (the matcher hasn't run)
    server._background_enrich()
    assert [r["filename"] for r in server.meta_db.enrichment_pending()] == ["a.archive"]
    # a matched row with the CURRENT hash is settled…
    h = server.meta_db.enrichment_content_hash("Artist", "Song", "", 100)
    with server.meta_db._lock:
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET match_state = 'matched', content_hash = ? "
            "WHERE filename = 'a.archive'", (h,))
        server.meta_db.conn.commit()
    assert server.meta_db.enrichment_pending() == []
    # …until the song's identity changes, which re-queues it
    _put(server, "a.archive", title="Song (Remastered)")
    assert [r["filename"] for r in server.meta_db.enrichment_pending()] == ["a.archive"]


def test_hash_change_resets_matched_but_never_manual(server):
    _put(server, "a.archive")
    _put(server, "b.archive", title="Other")
    server._background_enrich()
    with server.meta_db._lock:
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET match_state = 'matched' WHERE filename = 'a.archive'")
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET match_state = 'manual' WHERE filename = 'b.archive'")
        server.meta_db.conn.commit()
    # identity edits…
    _put(server, "a.archive", title="Song v2")
    _put(server, "b.archive", title="Other v2")
    server._background_enrich()
    a = server.meta_db.get_enrichment("a.archive")
    b = server.meta_db.get_enrichment("b.archive")
    # …drop a stale MATCH back to unscanned with the fresh hash
    assert a["match_state"] == "unscanned"
    assert a["content_hash"] == server.meta_db.enrichment_content_hash("Artist", "Song v2", "", 100)
    # …but a MANUAL pin survives untouched (state AND hash)
    assert b["match_state"] == "manual"
    assert b["content_hash"] == server.meta_db.enrichment_content_hash("Artist", "Other", "", 100)


def test_failed_rows_not_requeued_by_pending(server):
    _put(server, "a.archive")
    server._background_enrich()
    with server.meta_db._lock:
        server.meta_db.conn.execute(
            "UPDATE song_enrichment SET match_state = 'failed' WHERE filename = 'a.archive'")
        server.meta_db.conn.commit()
    # backoff/retry policy belongs to the matcher slice, not the queue walk
    assert server.meta_db.enrichment_pending() == []


# ── worker pass ───────────────────────────────────────────────────────────────

def test_enrich_pass_stamps_every_song(server):
    for i in range(5):
        _put(server, f"s{i}.archive", title=f"Song {i}")
    server._background_enrich()
    for i in range(5):
        row = server.meta_db.get_enrichment(f"s{i}.archive")
        assert row is not None
        assert row["match_state"] == "unscanned"
        assert row["content_hash"] == server.meta_db.enrichment_content_hash(
            "Artist", f"Song {i}", "", 100)


# ── lifecycle: rescan survival vs explicit delete ─────────────────────────────

def test_rescan_never_purges_enrichment(server):
    _put(server, "a.archive")
    server._background_enrich()
    server.meta_db.delete_missing(set())          # file vanished from a scan snapshot
    assert server.meta_db.get_enrichment("a.archive") is not None   # row survives
    # …and is invisible in the read-time-filtered counts
    assert server.meta_db.enrichment_state_counts() == {}
    _put(server, "a.archive")                     # the file comes back
    assert server.meta_db.enrichment_state_counts() == {"unscanned": 1}


def test_status_endpoint_counts(client, server):
    _put(server, "a.archive")
    _put(server, "b.archive", title="Other")
    server._background_enrich()
    body = client.get("/api/enrichment/status").json()
    assert body["states"] == {"unscanned": 2}
    assert body["total_songs"] == 2
    assert body["running"] is False
    assert body["processed"] == 2


def test_art_cache_dir_created(server):
    d = server._enrichment_art_dir()
    assert d.is_dir()
    assert d.name == "art_cache"
