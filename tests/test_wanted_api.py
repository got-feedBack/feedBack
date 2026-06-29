"""Tests for the wishlist / "wanted" list (got-feedback/feedBack#636 item 4).

A wishlist entry is a song the user does NOT own yet (the *arr Wanted/Monitored
analogue), so it lives in its own `wanted` table keyed by descriptive identity
rather than a local filename. Producers (the find_more ownership-diff, or a
manual add) POST entries; the API is idempotent on identity so a re-run of an
ownership-diff can't duplicate.
"""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def server_mod(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        conn.close()


@pytest.fixture()
def client(server_mod):
    c = TestClient(server_mod.app)
    try:
        yield c
    finally:
        c.close()


def test_add_list_remove_round_trip(client):
    assert client.get("/api/wanted").json() == {"wanted": []}

    r = client.post("/api/wanted", json={"artist": "Tool", "title": "Lateralus",
                                         "source": "find_more", "source_ref": "cf:123"})
    assert r.status_code == 200
    row = r.json()["wanted"]
    assert (row["artist"], row["title"], row["source"]) == ("Tool", "Lateralus", "find_more")
    wid = row["id"]

    listed = client.get("/api/wanted").json()["wanted"]
    assert [w["title"] for w in listed] == ["Lateralus"]

    assert client.request("DELETE", f"/api/wanted/{wid}").json() == {"ok": True}
    assert client.get("/api/wanted").json() == {"wanted": []}
    # Deleting an already-gone id is a no-op, not an error.
    assert client.request("DELETE", f"/api/wanted/{wid}").json() == {"ok": False}


def test_add_is_idempotent_on_identity(client, server_mod):
    payload = {"artist": "Rush", "title": "YYZ", "source": "find_more", "source_ref": "x1"}
    first = client.post("/api/wanted", json=payload).json()["wanted"]
    # Same identity (case-insensitive on artist/title) → no duplicate, same row.
    again = client.post("/api/wanted", json={**payload, "artist": "rush", "title": "yyz"}).json()["wanted"]
    assert first["id"] == again["id"]
    assert server_mod.meta_db.count_wanted() == 1

    # A different source_ref is a distinct entry.
    client.post("/api/wanted", json={**payload, "source_ref": "x2"})
    assert server_mod.meta_db.count_wanted() == 2


def test_newest_first_ordering(client, server_mod):
    for t in ("First", "Second", "Third"):
        server_mod.meta_db.add_wanted(artist="A", title=t, source="manual")
    titles = [w["title"] for w in client.get("/api/wanted").json()["wanted"]]
    assert titles == ["Third", "Second", "First"]


def test_add_requires_artist_or_title(client):
    r = client.post("/api/wanted", json={"source": "manual"})
    assert r.status_code == 400
    r2 = client.post("/api/wanted", json={"artist": "", "title": "   "})
    assert r2.status_code == 400


def test_add_defaults_source_to_manual(client):
    row = client.post("/api/wanted", json={"title": "Untitled"}).json()["wanted"]
    assert row["source"] == "manual"
    assert row["artist"] == ""


def test_non_dict_body_rejected(client):
    # FastAPI's `data: dict` validation rejects a JSON array (422) before the
    # handler's own defensive isinstance guard; either way it's not a 2xx.
    assert client.post("/api/wanted", json=[]).status_code in (400, 422)


def test_table_creation_is_idempotent(server_mod):
    # Re-running the CREATE TABLE / CREATE INDEX must not error or wipe rows —
    # pin the additive + idempotent migration guarantee (constitution IV).
    server_mod.meta_db.add_wanted(artist="Keep", title="Me")
    server_mod.meta_db.conn.execute("""
        CREATE TABLE IF NOT EXISTS wanted (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            artist TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '',
            source TEXT NOT NULL DEFAULT '', source_ref TEXT NOT NULL DEFAULT '',
            note TEXT NOT NULL DEFAULT '', created_at TEXT
        )
    """)
    server_mod.meta_db.conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_wanted_identity "
        "ON wanted(artist COLLATE NOCASE, title COLLATE NOCASE, source, source_ref)"
    )
    assert server_mod.meta_db.count_wanted() == 1
