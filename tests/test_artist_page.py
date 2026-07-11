"""Server tests for the artist-pages layer (PR-B, artist-pages launch charrette).

Two halves, mirroring the design's split:

* GET /api/artist/{name}/page — the all-LOCAL payload. Covers the counts /
  albums / alias variants, the DENOMINATOR LAW (mastered counts songs YOU OWN,
  never anything external — locked position 2), similar-in-library genre
  co-occurrence (in-library artists only, self excluded, empty → empty), and
  mb_artist_id resolution from matched/manual rows only.

* GET /api/artist/{name}/links + POST .../links/refresh — the lazy, cached,
  opt-in external-links layer. The HTTP transport is a fake over
  `enrichment._mb_http_get` (the ONE network seam — same pattern as
  tests/test_mb_enrichment.py), so nothing here opens a socket. Covers the
  url-rel whitelist mapping, the http(s) scheme gate (a hostile javascript:
  resource never reaches a link slot), cache-hit second calls making no
  network call, the offline guard, the default-OFF setting gate, and the
  demo-mode blocks.
"""

import importlib
import enrichment
import json
import sys
from urllib.parse import quote

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
            getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()
        sys.modules.pop("server", None)


@pytest.fixture()
def client(server):
    return TestClient(server.app)


MBID = "66c662b6-6e2f-4930-8610-912e24c63ed1"


def _put(server, fn, title=None, artist="AC/DC", album="", year="",
         genre="", duration=200):
    server.meta_db.put(fn, 0, 0, {
        "title": title or fn.split(".")[0], "artist": artist, "album": album,
        "year": year, "genre": genre, "duration": duration,
        "arrangements": [{"name": "Lead", "index": 0}],
    })


def _pin_match(server, fn, artist_id=MBID):
    """Give a song a user-pinned (manual) match carrying an artist MBID."""
    assert server.meta_db.set_enrichment_manual(fn, {
        "recording_id": "rec-1", "title": "T", "artist": "AC/DC",
        "artist_id": artist_id,
    })


def _page(client, name="AC/DC"):
    r = client.get("/api/artist/" + quote(name, safe="") + "/page")
    assert r.status_code == 200
    return r.json()


class FakeMBArtist:
    """Canned MusicBrainz artist lookup over the _mb_http_get seam."""

    def __init__(self, srv):
        self._srv = srv
        self.calls = []
        self.doc = artist_doc()
        self.raise_transport = False

    def __call__(self, path, params):
        if self.raise_transport:
            raise enrichment.EnrichTransportError("fake network down")
        self.calls.append((path, dict(params)))
        if path == f"artist/{MBID}":
            return self.doc
        raise AssertionError(f"unexpected MB path {path!r}")


@pytest.fixture()
def mb_artist(server, monkeypatch):
    """Install the fake transport AND enable the network flag (the test env
    disables it by default — see test_links_offline_returns_empty)."""
    fake = FakeMBArtist(server)
    monkeypatch.setattr(enrichment, "_mb_http_get", fake)
    monkeypatch.setattr(enrichment, "_enrich_network_enabled", lambda: True)
    return fake


def artist_doc():
    """An MB artist doc exercising the whole whitelist: a hostile javascript:
    URL and an ftp:// URL (both must be scheme-gated out), non-whitelisted rel
    types (must be dropped), one of each slot, and both wiki rels (wikipedia
    must win over wikidata)."""
    rel = lambda rtype, url: {"type": rtype, "url": {"resource": url}}
    return {
        "id": MBID,
        "name": "AC/DC",
        "relations": [
            rel("official homepage", "javascript:alert(1)"),        # scheme-gated
            rel("official homepage", "https://www.acdc.com"),       # first valid wins
            rel("official homepage", "https://second.example"),
            rel("setlistfm", "https://www.setlist.fm/setlists/acdc"),
            rel("youtube", "https://www.youtube.com/acdc"),
            rel("social network", "https://www.instagram.com/acdc"),
            rel("bandcamp", "ftp://bad.example/acdc"),               # scheme-gated
            rel("soundcloud", "https://soundcloud.com/acdc"),
            rel("wikidata", "https://www.wikidata.org/wiki/Q27593"),
            rel("wikipedia", "https://en.wikipedia.org/wiki/AC/DC"),
            rel("streaming", "https://stream.example/acdc"),         # not whitelisted
            rel("purchase for download", "https://store.example"),   # not whitelisted
        ],
        "genres": [{"name": "hard rock", "count": 10}, {"name": "rock", "count": 5}],
    }


def _enable_links(client):
    r = client.post("/api/settings", json={"artist_external_links": True})
    assert r.status_code == 200 and "error" not in r.json()


# ── /page: counts, albums, variants ──────────────────────────────────────────

def test_page_counts_albums_and_files(client, server):
    _put(server, "a.sloppak", album="The Razors Edge", year="1990")
    _put(server, "b.sloppak", album="The Razors Edge", year="1990")
    _put(server, "c.sloppak", album="Back in Black", year="1980")
    _put(server, "d.sloppak", album="")                      # loose, no album
    _put(server, "x.sloppak", artist="Other Band", album="Elsewhere")
    page = _page(client)
    assert page["artist"] == "AC/DC"
    assert page["song_count"] == 4                            # never the other artist
    assert page["album_count"] == 2                           # empty album ≠ an album
    albums = {a["name"]: a for a in page["albums"]}
    assert albums["The Razors Edge"]["count"] == 2
    assert albums["The Razors Edge"]["year"] == "1990"
    assert albums["Back in Black"]["count"] == 1
    assert set(page["files"]) == {"a.sloppak", "b.sloppak", "c.sloppak", "d.sloppak"}
    # Mosaic art comes from the artist's own songs.
    assert page["art_urls"] and all("/art" in u for u in page["art_urls"])


def test_page_unknown_artist_is_zero_count_not_error(client, server):
    page = _page(client, "Nobody Here")
    assert page["artist"] == "Nobody Here"
    assert page["song_count"] == 0
    assert page["albums"] == [] and page["similar"] == []
    assert page["mb_artist_id"] is None


def test_page_canonicalizes_aliases_and_lists_variants(client, server):
    _put(server, "a.sloppak", artist="ACDC", album="Alb")
    _put(server, "b.sloppak", artist="AC/DC", album="Alb")
    r = client.post("/api/artist-aliases",
                    json={"raw_name": "ACDC", "canonical_name": "AC/DC"})
    assert r.status_code == 200
    # Asking by the RAW name lands on the same canonical page.
    for name in ("AC/DC", "ACDC"):
        page = _page(client, name)
        assert page["artist"] == "AC/DC"
        assert page["song_count"] == 2                        # both variants counted
        assert page["variants"] == [{"name": "ACDC", "count": 1}]


# ── /page: the denominator law ────────────────────────────────────────────────

def test_mastered_counts_only_owned_songs(client, server):
    """Locked position 2: 'N mastered' is over songs in YOUR library — a
    song_stats row whose file left the library can never inflate it."""
    _put(server, "a.sloppak")
    _put(server, "b.sloppak")
    _put(server, "c.sloppak")
    server.meta_db.record_session("a.sloppak", 0, score=100, accuracy=0.95)   # mastered
    server.meta_db.record_session("b.sloppak", 0, score=50, accuracy=0.5)     # in progress
    # A mastered score for a song NOT in the library (deleted / renamed) —
    # must not count: the denominator is ownership.
    server.meta_db.record_session("gone.sloppak", 0, score=100, accuracy=0.99)
    page = _page(client)
    assert page["song_count"] == 3
    assert page["mastered_count"] == 1
    assert page["has_stats"] is True


def test_mastered_uses_best_accuracy_across_arrangements(client, server):
    _put(server, "a.sloppak")
    server.meta_db.record_session("a.sloppak", 0, score=10, accuracy=0.4)
    server.meta_db.record_session("a.sloppak", 1, score=90, accuracy=0.93)
    assert _page(client)["mastered_count"] == 1


def test_no_practice_data_reports_zero_and_flag(client, server):
    """The frontend omits the mastered segment when it is 0 (invitational —
    never '0 mastered'); the payload carries the honest numbers + flag."""
    _put(server, "a.sloppak")
    page = _page(client)
    assert page["mastered_count"] == 0
    assert page["has_stats"] is False


# ── /page: similar-in-library ─────────────────────────────────────────────────

def test_similar_ranks_genre_overlap_in_library_only(client, server):
    _put(server, "a1.sloppak", artist="AC/DC", genre="Rock")
    _put(server, "a2.sloppak", artist="AC/DC", genre="Blues")
    _put(server, "b1.sloppak", artist="Band B", genre="rock")     # case folds
    _put(server, "b2.sloppak", artist="Band B", genre="Blues")    # 2 shared genres
    _put(server, "c1.sloppak", artist="Band C", genre="Rock")     # 1 shared genre
    _put(server, "d1.sloppak", artist="Band D", genre="Jazz")     # no overlap
    similar = _page(client)["similar"]
    names = [s["artist"] for s in similar]
    assert names[0] == "Band B"                                   # most shared genres
    assert "Band C" in names
    assert "Band D" not in names                                  # never non-overlapping
    assert "AC/DC" not in names                                   # never self


def test_similar_empty_without_genre_data(client, server):
    _put(server, "a.sloppak", genre="")
    _put(server, "b.sloppak", artist="Band B", genre="Rock")
    assert _page(client)["similar"] == []


def test_similar_folds_alias_variants(client, server):
    _put(server, "a.sloppak", artist="AC/DC", genre="Rock")
    _put(server, "b.sloppak", artist="Band B", genre="Rock")
    _put(server, "b2.sloppak", artist="band b", genre="Rock")
    client.post("/api/artist-aliases",
                json={"raw_name": "band b", "canonical_name": "Band B"})
    similar = _page(client)["similar"]
    assert [s["artist"] for s in similar] == ["Band B"]           # one entry, folded
    assert similar[0]["count"] == 2


# ── /page: mb_artist_id resolution ────────────────────────────────────────────

def test_page_mb_artist_id_from_matched_rows(client, server):
    _put(server, "a.sloppak")
    _pin_match(server, "a.sloppak")
    assert _page(client)["mb_artist_id"] == MBID


def test_page_ignores_unmatched_rows_artist_id(client, server):
    """Only matched/manual rows are identity authority — a failed row's
    leftover artist_id must not resurface."""
    _put(server, "a.sloppak")
    server.meta_db.conn.execute(
        "INSERT INTO song_enrichment (filename, match_state, mb_artist_id) "
        "VALUES ('a.sloppak', 'failed', ?)", (MBID,))
    server.meta_db.conn.commit()
    assert _page(client)["mb_artist_id"] is None


# ── /links: setting gate, whitelist, scheme gate ─────────────────────────────

def test_links_disabled_by_default_no_network(client, server, mb_artist):
    _put(server, "a.sloppak")
    _pin_match(server, "a.sloppak")
    r = client.get("/api/artist/AC%2FDC/links")
    assert r.status_code == 200
    body = r.json()
    assert body["links"] == {} and body.get("disabled") is True
    assert mb_artist.calls == []                        # opt-in means opt-in


def test_links_whitelist_mapping_and_scheme_gate(client, server, mb_artist):
    _put(server, "a.sloppak")
    _pin_match(server, "a.sloppak")
    _enable_links(client)
    r = client.get("/api/artist/AC%2FDC/links")
    assert r.status_code == 200
    body = r.json()
    assert body["matched"] is True and body["cached"] is False
    links = body["links"]
    # The javascript: homepage is scheme-gated out; the first VALID one wins.
    assert links["official"] == "https://www.acdc.com"
    assert links["tour"] == "https://www.setlist.fm/setlists/acdc"
    assert links["video"] == "https://www.youtube.com/acdc"
    # Social collects; the ftp:// bandcamp is scheme-gated out.
    assert links["social"] == ["https://www.instagram.com/acdc",
                               "https://soundcloud.com/acdc"]
    # Wikipedia preferred over wikidata when both exist.
    assert links["wikipedia"] == "https://en.wikipedia.org/wiki/AC/DC"
    # Nothing hostile or non-whitelisted anywhere in the payload.
    dumped = json.dumps(body)
    for bad in ("javascript:", "ftp://", "stream.example", "store.example"):
        assert bad not in dumped
    # One throttled lookup, with the url-rels include.
    assert len(mb_artist.calls) == 1
    path, params = mb_artist.calls[0]
    assert path == f"artist/{MBID}"
    assert "url-rels" in params.get("inc", "")


def test_links_wikidata_fallback_when_no_wikipedia(client, server, mb_artist):
    _put(server, "a.sloppak")
    _pin_match(server, "a.sloppak")
    _enable_links(client)
    mb_artist.doc = {"id": MBID, "relations": [
        {"type": "wikidata", "url": {"resource": "https://www.wikidata.org/wiki/Q27593"}},
    ], "genres": []}
    links = client.get("/api/artist/AC%2FDC/links").json()["links"]
    assert links["wikipedia"] == "https://www.wikidata.org/wiki/Q27593"


def test_links_cached_second_call_makes_no_network_call(client, server, mb_artist):
    _put(server, "a.sloppak")
    _pin_match(server, "a.sloppak")
    _enable_links(client)
    first = client.get("/api/artist/AC%2FDC/links").json()
    assert first["cached"] is False and len(mb_artist.calls) == 1
    second = client.get("/api/artist/AC%2FDC/links").json()
    assert second["cached"] is True
    assert second["links"] == first["links"]
    assert len(mb_artist.calls) == 1                    # cache hit — no re-fetch


def test_links_refresh_refetches_and_updates_cache(client, server, mb_artist):
    _put(server, "a.sloppak")
    _pin_match(server, "a.sloppak")
    _enable_links(client)
    client.get("/api/artist/AC%2FDC/links")
    mb_artist.doc = {"id": MBID, "relations": [
        {"type": "official homepage", "url": {"resource": "https://new.example"}},
    ], "genres": []}
    r = client.post("/api/artist/AC%2FDC/links/refresh")
    assert r.status_code == 200
    assert r.json()["links"]["official"] == "https://new.example"
    assert len(mb_artist.calls) == 2
    # And the refreshed value is what the next GET serves from cache.
    again = client.get("/api/artist/AC%2FDC/links").json()
    assert again["cached"] is True
    assert again["links"]["official"] == "https://new.example"


# ── /links: offline / unmatched / hostile-id guards ──────────────────────────

def test_links_offline_returns_empty(client, server):
    """The test env's offline default (FEEDBACK_SKIP_STARTUP_TASKS) doubles as
    the kill-switch test: matched artist + links on, but no network → empty
    links, no error, nothing cached."""
    _put(server, "a.sloppak")
    _pin_match(server, "a.sloppak")
    _enable_links(client)
    body = client.get("/api/artist/AC%2FDC/links").json()
    assert body["links"] == {} and body.get("offline") is True
    assert server.meta_db.get_artist_enrichment(MBID) is None


def test_links_unmatched_artist_reports_matched_false(client, server, mb_artist):
    _put(server, "a.sloppak")                            # no enrichment match
    _enable_links(client)
    body = client.get("/api/artist/AC%2FDC/links").json()
    assert body == {"links": {}, "matched": False}
    assert mb_artist.calls == []


def test_links_rejects_malformed_stored_mbid(client, server, mb_artist):
    """A hand-rolled /pick body can stuff junk into mb_artist_id — the strict
    MBID shape gate must keep it off the MB request line."""
    _put(server, "a.sloppak")
    _pin_match(server, "a.sloppak", artist_id="evil/../../path")
    _enable_links(client)
    body = client.get("/api/artist/AC%2FDC/links").json()
    assert body == {"links": {}, "matched": False}
    assert mb_artist.calls == []


# ── demo mode ─────────────────────────────────────────────────────────────────

def test_links_routes_demo_blocked_page_stays_open(client, server, monkeypatch):
    _put(server, "a.sloppak")
    _pin_match(server, "a.sloppak")
    monkeypatch.setenv("FEEDBACK_DEMO_MODE", "1")
    assert client.get("/api/artist/AC%2FDC/links").status_code == 403
    assert client.post("/api/artist/AC%2FDC/links/refresh").status_code == 403
    # The all-local page read stays available to demo visitors.
    assert client.get("/api/artist/AC%2FDC/page").status_code == 200


# ── settings keys ─────────────────────────────────────────────────────────────

def test_artist_page_settings_defaults_and_validation(client, server):
    cfg = client.get("/api/settings").json()
    assert cfg["artist_pages_enabled"] is True           # page is local-only → ON
    assert cfg["artist_external_links"] is False         # links are opt-in → OFF
    # Bool pattern: non-bool shapes return a structured error, not a 500.
    for key in ("artist_pages_enabled", "artist_external_links"):
        assert "error" in client.post("/api/settings", json={key: "yes"}).json()
        assert "error" not in client.post("/api/settings", json={key: True}).json()
        assert client.get("/api/settings").json()[key] is True
