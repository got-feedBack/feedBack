"""Tests for artist-name canonicalization (P4): the artist_alias override that
merges messy artist tags ("ACDC" → "AC/DC") AT DISPLAY — the deduped dropdown/
tree (query_artists), the artist filter (canonical matches all raw variants),
and the grid card label — without rewriting songs.artist or the feedpak files.
Sort/A–Z stay on the raw artist (keyset-safe); that reindex is deferred to P5a."""

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


def _seed(server, fn, artist, album="Alb"):
    server.meta_db.put(fn, 0, 0, {"title": fn.split(".")[0], "artist": artist, "album": album})


def _artist_names(client):
    data = client.get("/api/library/artists?size=100").json()
    return [a["name"] for a in data["artists"]]


def _grid_artist(client, fn):
    row = next(s for s in client.get("/api/library").json()["songs"] if s["filename"] == fn)
    return row["artist"]


def _alias(client, raw, canonical):
    return client.post("/api/artist-aliases", json={"raw_name": raw, "canonical_name": canonical})


# ── No aliases: raw names, unchanged behaviour ───────────────────────────────

def test_no_aliases_lists_raw_distinct(client, server):
    _seed(server, "a.archive", "ACDC")
    _seed(server, "b.archive", "AC/DC")
    assert set(_artist_names(client)) == {"ACDC", "AC/DC"}


# ── Dropdown/tree dedupe on the canonical name ───────────────────────────────

def test_alias_dedupes_artist_list(client, server):
    _seed(server, "a.archive", "ACDC")
    _seed(server, "b.archive", "AC/DC")
    _alias(client, "ACDC", "AC/DC")
    data = client.get("/api/library/artists?size=100").json()
    assert [a["name"] for a in data["artists"]] == ["AC/DC"]
    assert data["total_artists"] == 1


# ── Grid card shows the canonical label ──────────────────────────────────────

def test_grid_shows_canonical_artist(client, server):
    _seed(server, "a.archive", "ACDC")
    _alias(client, "ACDC", "AC/DC")
    assert _grid_artist(client, "a.archive") == "AC/DC"


# ── Filtering by the canonical matches every raw variant ─────────────────────

def test_filter_by_canonical_matches_all_variants(client, server):
    _seed(server, "a.archive", "ACDC")
    _seed(server, "b.archive", "AC/DC")
    _seed(server, "c.archive", "Other")
    _alias(client, "ACDC", "AC/DC")
    got = {s["filename"] for s in
           client.get("/api/library", params={"artist": "AC/DC"}).json()["songs"]}
    assert got == {"a.archive", "b.archive"}


# ── Merge endpoint ───────────────────────────────────────────────────────────

def test_merge_endpoint(client, server):
    _seed(server, "a.archive", "Beatles")
    _seed(server, "b.archive", "The Beatles")
    r = client.post("/api/artist-aliases/merge",
                    json={"raw_names": ["Beatles", "The Beatles"], "canonical_name": "The Beatles"})
    assert r.json()["merged"] == 1   # "The Beatles" self-skip
    assert _artist_names(client) == ["The Beatles"]


def test_merge_requires_canonical_and_list(client, server):
    assert client.post("/api/artist-aliases/merge", json={"raw_names": ["x"]}).status_code == 400
    assert client.post("/api/artist-aliases/merge", json={"canonical_name": "y"}).status_code == 400


# ── Un-merge: self-alias clears + DELETE ─────────────────────────────────────

def test_self_alias_clears(client, server):
    _seed(server, "a.archive", "ACDC")
    _alias(client, "ACDC", "AC/DC")
    _alias(client, "ACDC", "ACDC")   # self → un-merge
    assert client.get("/api/artist-aliases").json()["aliases"] == []
    assert _grid_artist(client, "a.archive") == "ACDC"


def test_delete_alias_unmerges(client, server):
    _seed(server, "a.archive", "ACDC")
    _alias(client, "ACDC", "AC/DC")
    assert client.delete("/api/artist-aliases/ACDC").json()["ok"] is True
    assert _grid_artist(client, "a.archive") == "ACDC"


# ── Never purged when songs churn (separate, non-filename-keyed table) ────────

def test_alias_survives_song_reindex(client, server):
    _seed(server, "a.archive", "ACDC")
    _alias(client, "ACDC", "AC/DC")
    # A rescan re-indexes the song (INSERT OR REPLACE INTO songs).
    server.meta_db.put("a.archive", 1, 1, {"title": "a", "artist": "ACDC", "album": "Alb"})
    assert _grid_artist(client, "a.archive") == "AC/DC"
    assert len(client.get("/api/artist-aliases").json()["aliases"]) == 1


# ── Raw-artist picker (Tidy-up source) ───────────────────────────────────────

def test_raw_artists_lists_counts_and_canonical(client, server):
    _seed(server, "a.archive", "ACDC")
    _seed(server, "b.archive", "ACDC")
    _seed(server, "c.archive", "AC/DC")
    _alias(client, "ACDC", "AC/DC")
    by_name = {a["name"]: a for a in client.get("/api/artists/raw").json()["artists"]}
    assert by_name["ACDC"]["count"] == 2
    assert by_name["ACDC"]["canonical"] == "AC/DC"     # shows where it maps
    assert by_name["AC/DC"]["count"] == 1


# ── Transitive chains flatten so sequential merges unify (PR #705 P2) ─────────

def test_sequential_merge_flattens_transitive_chain(client, server):
    """merge ACDC→AC/DC then AC/DC→AC-DC must unify ALL variants onto the terminal
    canonical ("AC-DC") — not leave a two-hop chain that grouping/filtering split."""
    _seed(server, "a.archive", "ACDC")
    _seed(server, "b.archive", "AC/DC")
    _seed(server, "c.archive", "AC-DC")
    client.post("/api/artist-aliases/merge",
                json={"raw_names": ["ACDC"], "canonical_name": "AC/DC"})
    client.post("/api/artist-aliases/merge",
                json={"raw_names": ["AC/DC"], "canonical_name": "AC-DC"})
    # Both original variants resolve (single hop) to the terminal canonical.
    assert server.meta_db.effective_artist("ACDC") == "AC-DC"
    assert server.meta_db.effective_artist("AC/DC") == "AC-DC"
    # The song tagged "ACDC" displays the terminal, not the intermediate.
    assert _grid_artist(client, "a.archive") == "AC-DC"
    # Grouping shows ONE canonical, not two split groups.
    assert _artist_names(client) == ["AC-DC"]
    # Stored rows are already terminal (forward-flattened), never AC/DC.
    canon = {a["canonical_name"] for a in client.get("/api/artist-aliases").json()["aliases"]}
    assert canon == {"AC-DC"}
    # Filtering by the terminal matches every original variant.
    got = {s["filename"] for s in
           client.get("/api/library", params={"artist": "AC-DC"}).json()["songs"]}
    assert got == {"a.archive", "b.archive", "c.archive"}


def test_cycle_is_refused_and_state_intact(client, server):
    """A→B then B→A would close a cycle: the second set is refused (409) and the
    existing A→B mapping is left intact — no loop, no corruption."""
    _seed(server, "a.archive", "A")
    _seed(server, "b.archive", "B")
    client.post("/api/artist-aliases/merge", json={"raw_names": ["A"], "canonical_name": "B"})
    r = _alias(client, "B", "A")           # B → A closes the cycle
    assert r.status_code == 409
    # State unchanged: exactly one alias row, A → B.
    assert client.get("/api/artist-aliases").json()["aliases"] == [
        {"raw_name": "A", "canonical_name": "B", "mb_artist_id": None}]
    assert server.meta_db.effective_artist("A") == "B"
    assert server.meta_db.effective_artist("B") == "B"


def test_terminal_resolution_survives_a_stored_cycle(server):
    """Even if the table somehow holds a direct cycle (P↔Q), the visited-set makes
    _terminal_canonical terminate instead of looping forever."""
    db = server.meta_db
    with db._lock:
        db.conn.execute("INSERT INTO artist_alias (raw_name, canonical_name, updated_at) "
                        "VALUES ('P', 'Q', datetime('now'))")
        db.conn.execute("INSERT INTO artist_alias (raw_name, canonical_name, updated_at) "
                        "VALUES ('Q', 'P', datetime('now'))")
        db.conn.commit()
    assert db._terminal_canonical("P") in ("P", "Q")
    assert db._terminal_canonical("Q") in ("P", "Q")


def test_list_aliases_sorted(client, server):
    _seed(server, "a.archive", "ACDC")
    _seed(server, "b.archive", "guns n roses")
    _alias(client, "ACDC", "AC/DC")
    _alias(client, "guns n roses", "Guns N' Roses")
    aliases = client.get("/api/artist-aliases").json()["aliases"]
    assert {a["raw_name"] for a in aliases} == {"ACDC", "guns n roses"}
