"""Integration tests for the generic plugin metadata API
(docs/PLUGIN_METADATA_API.md): the optional `metadata` key on the highway
WebSocket's `song_info` frame, and `GET /api/song/{filename}/metadata`.

Pure-function coverage of the shared `plugin_metadata_for()` assembly
lives in tests/test_plugin_metadata.py — this file covers only the two
delivery surfaces and their wiring (route precedence, WS frame shape,
error responses), mirroring the existing split between
tests/test_highway_ws_authors.py (WS integration) and
tests/test_art_candidates.py (REST integration) this file's fixtures are
adapted from.

Both network seams a real MusicBrainz match would touch
(`enrichment._mb_search_recordings`, `enrichment._caa_*`) are never
exercised here — every enrichment row is seeded directly via
`apply_enrichment_match`, exactly as `test_art_candidates.py` already
does, so nothing in this file opens a socket.
"""

from __future__ import annotations

import importlib
import json
import sys

import pytest
import yaml
from fastapi.testclient import TestClient


# ── REST: GET /api/song/{filename}/metadata ─────────────────────────────────


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
            getattr(sys.modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


def make_sloppak(server, name, title="Song", artist="Artist", album="",
                  year="", genre=""):
    d = server.DLC_DIR / name
    d.mkdir(parents=True)
    (d / "manifest.yaml").write_text(
        f"title: {title}\nartist: {artist}\nduration: 100\n"
        "arrangements: []\nstems: []\n", encoding="utf-8")
    server.meta_db.put(name, 0, 0, {
        "title": title, "artist": artist, "album": album, "year": year,
        "genre": genre, "duration": 100, "arrangements": [],
    })
    return d


def _match_row(server, fn, state="matched", release_id="rel-1",
                recording_id="rec-1", artist_id="art-1", isrc="ISRC0001"):
    song = server.meta_db.enrichment_song_row(fn)
    h = server.meta_db.enrichment_content_hash(
        song["artist"], song["title"], song["album"], song["duration"])
    server.meta_db.apply_enrichment_match(
        fn, h, state, source="text", score=0.95,
        cand={"recording_id": recording_id, "release_id": release_id,
              "artist_id": artist_id, "isrc": isrc,
              "title": song["title"], "artist": song["artist"]})


def test_metadata_route_missing_song_404s(client):
    """Sensible error for a filename that resolves to nothing — same
    error shape as the existing GET /api/song/{filename} sibling route
    (song.py's own {"error": "File not found"}), not a new shape."""
    r = client.get("/api/song/does-not-exist.feedpak/metadata")
    assert r.status_code == 404
    assert r.json() == {"error": "File not found"}


def test_metadata_route_playback_without_enrichment(server, client):
    make_sloppak(server, "a.sloppak", title="Song A", artist="Artist A",
                 album="Album A", year="2004", genre="Rock")
    r = client.get("/api/song/a.sloppak/metadata")
    assert r.status_code == 200
    body = r.json()
    assert body["version"] == 1
    assert body["album"] == "Album A"
    assert body["year"] == 2004
    assert body["genre"] == "Rock"
    assert body["album_artist"] is None
    # No enrichment row yet — optional fields correctly omitted (null),
    # not a missing key and not an error.
    assert body["identifiers"] == {
        "musicbrainz_recording_id": None,
        "musicbrainz_release_id": None,
        "musicbrainz_artist_id": None,
        "isrc": None,
    }
    assert body["enrichment"] == {"available": False}


def test_metadata_route_playback_with_enrichment(server, client):
    make_sloppak(server, "a.sloppak", title="Song A", artist="Artist A",
                 album="Album A", year="2004")
    _match_row(server, "a.sloppak", release_id="rel-42",
               recording_id="rec-42", artist_id="art-42", isrc="ISRC0042")
    r = client.get("/api/song/a.sloppak/metadata")
    assert r.status_code == 200
    body = r.json()
    assert body["identifiers"] == {
        "musicbrainz_recording_id": "rec-42",
        "musicbrainz_release_id": "rel-42",
        "musicbrainz_artist_id": "art-42",
        "isrc": "ISRC0042",
    }
    assert body["enrichment"] == {"available": True}


def test_metadata_route_not_shadowed_by_bare_song_route(server, client):
    """Regression guard for the route-ordering hazard called out in
    routers/song.py's own docstring: /metadata must resolve to the new
    route, not be swallowed by GET /api/song/{filename:path} treating
    "a.sloppak/metadata" as one filename."""
    make_sloppak(server, "a.sloppak", album="Album A")
    r = client.get("/api/song/a.sloppak/metadata")
    assert r.status_code == 200
    body = r.json()
    # The bare route's payload has no "version"/"identifiers" keys at
    # all — if this route were shadowed, either the response would 404
    # (unknown extended filename) or come back shaped like the bare
    # song-info payload instead of the metadata shape.
    assert "version" in body and "identifiers" in body
    assert body["album"] == "Album A"


def test_metadata_route_still_reachable_via_bare_route(server, client):
    """The pre-existing GET /api/song/{filename} route must still work
    unchanged after the reordering above — this is the compatibility
    check for the routing fix itself, not just the new route."""
    make_sloppak(server, "a.sloppak", title="Song A", album="Album A")
    r = client.get("/api/song/a.sloppak")
    assert r.status_code == 200
    body = r.json()
    assert body["title"] == "Song A"
    # The bare route's own payload shape is untouched — it must NOT
    # have picked up the new nested "metadata"/"identifiers" keys; that
    # would be an unrelated, unwanted behavior change to an existing
    # endpoint.
    assert "identifiers" not in body


# ── WebSocket: song_info's optional `metadata` key ──────────────────────────


def _write_sloppak_for_ws(dlc_root, *, title="WS Song", artist="WS Artist",
                           album="", year=0):
    pak = dlc_root / "wstest.sloppak"
    pak.mkdir()
    (pak / "arrangements").mkdir()
    (pak / "arrangements" / "lead.json").write_text(
        json.dumps({
            "notes": [], "chords": [], "anchors": [], "handshapes": [],
            "templates": [],
            "beats": [{"time": 0.0, "measure": 1}],
            "sections": [{"name": "intro", "number": 1, "time": 0.0}],
        })
    )
    manifest = {
        "title": title, "artist": artist, "album": album, "year": year,
        "duration": 10.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": [],
    }
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))
    return pak


@pytest.fixture()
def make_client(tmp_path, monkeypatch):
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


def _song_info(client, path):
    with client.websocket_connect(path) as ws:
        for _ in range(200):
            msg = ws.receive_json()
            if msg.get("error"):
                raise AssertionError(f"WS error frame: {msg}")
            if msg.get("type") == "song_info":
                return msg
            if msg.get("type") == "ready":
                break
    raise AssertionError("no song_info frame received")


def test_song_info_carries_optional_metadata_key(make_client):
    server = make_client()
    _write_sloppak_for_ws(server._get_dlc_dir(), album="WS Album", year=2010)
    with TestClient(server.app) as client:
        info = _song_info(client, "/ws/highway/wstest.sloppak?arrangement=0")
    assert "metadata" in info
    meta = info["metadata"]
    assert meta["version"] == 1
    assert meta["album"] == "WS Album"
    assert meta["year"] == 2010
    # No enrichment row seeded for this play — identifiers correctly null.
    assert meta["identifiers"]["musicbrainz_recording_id"] is None
    assert meta["enrichment"]["available"] is False


def test_song_info_metadata_reflects_enrichment_when_present(make_client):
    server = make_client()
    _write_sloppak_for_ws(server._get_dlc_dir())
    # The scanner hasn't run in this test, so seed the songs cache row
    # under the same DLC-relative key the WS handler resolves to, then
    # seed a matched enrichment row against it — mirrors how a real
    # background scan + enrichment pass would have populated both
    # tables well before playback.
    server.meta_db.put("wstest.sloppak", 0, 0, {
        "title": "WS Song", "artist": "WS Artist", "album": "WS Album",
        "year": "2010", "genre": "", "duration": 10.0, "arrangements": [],
    })
    song = server.meta_db.enrichment_song_row("wstest.sloppak")
    h = server.meta_db.enrichment_content_hash(
        song["artist"], song["title"], song["album"], song["duration"])
    server.meta_db.apply_enrichment_match(
        "wstest.sloppak", h, "matched", source="text", score=0.95,
        cand={"recording_id": "rec-ws", "release_id": "rel-ws",
              "artist_id": "art-ws", "isrc": "ISRCWS01",
              "title": song["title"], "artist": song["artist"]})
    with TestClient(server.app) as client:
        info = _song_info(client, "/ws/highway/wstest.sloppak?arrangement=0")
    meta = info["metadata"]
    assert meta["identifiers"]["musicbrainz_recording_id"] == "rec-ws"
    assert meta["enrichment"]["available"] is True


def test_song_info_existing_fields_unchanged_by_metadata_addition(make_client):
    """Backwards compatibility: every field the WS frame already sent
    before this change must still be present with the same meaning. A
    plugin that never reads "metadata" must see byte-identical values
    for everything else it already relies on."""
    server = make_client()
    _write_sloppak_for_ws(server._get_dlc_dir(), title="Compat Song",
                           artist="Compat Artist")
    with TestClient(server.app) as client:
        info = _song_info(client, "/ws/highway/wstest.sloppak?arrangement=0")
    assert info["title"] == "Compat Song"
    assert info["artist"] == "Compat Artist"
    assert info["type"] == "song_info"
    assert "authors" in info          # pre-existing field, untouched
    assert "arrangement" in info      # pre-existing field, untouched
    # The new key is additive alongside all of the above, not a
    # replacement for any of them.
    assert "metadata" in info
