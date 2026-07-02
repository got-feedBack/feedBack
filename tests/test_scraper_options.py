"""Tests for the R1 scraper options: per-source toggles (MusicBrainz /
Cover Art Archive), per-field auto-apply toggles (names / year / genres /
cover art), and the review-queue order preference.

Same no-network contract as the P8/R3 suites: both transports are faked
over their single seams (`_mb_http_get`, `_caa_http_get`) and the network
flag is only force-enabled where a test needs the pipeline to run.
"""

import importlib
import io as _io
import sys

import pytest
from fastapi.testclient import TestClient
from PIL import Image


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


class FakeMB:
    """Canned MusicBrainz over the `_mb_http_get` seam (the P8 fixture)."""

    def __init__(self):
        self.calls = []
        self.search_response = {"recordings": []}

    def __call__(self, path, params):
        self.calls.append((path, dict(params)))
        if path == "recording":
            return self.search_response
        raise AssertionError(f"unexpected MB path {path!r}")


@pytest.fixture()
def mb(server, monkeypatch):
    fake = FakeMB()
    monkeypatch.setattr(server, "_mb_http_get", fake)
    monkeypatch.setattr(server, "_enrich_network_enabled", lambda: True)
    return fake


def _put(server, fn, title="Thunderstruck (v2)", artist="ACDC", album="",
         duration=292, year="1990", mtime=0):
    server.meta_db.put(fn, mtime, 0, {
        "title": title, "artist": artist, "album": album, "year": year,
        "duration": duration, "arrangements": [{"name": "Lead", "index": 0}],
    })


def mb_doc(rid="rec-1", title="Thunderstruck", artist="AC/DC", artist_id="art-1",
           album="The Razors Edge", date="1990-09-24", length_ms=292000, score=100):
    return {
        "id": rid, "score": score, "title": title, "length": length_ms,
        "isrcs": ["AUAP09000045"],
        "artist-credit": [{"name": artist, "artist": {
            "id": artist_id, "name": artist, "sort-name": artist}}],
        "releases": [{"id": "rel-1", "title": album, "status": "Official",
                      "date": date, "release-group": {"primary-type": "Album"}}],
        "tags": [{"name": "hard rock", "count": 7}],
    }


# ── settings keys ─────────────────────────────────────────────────────────────

BOOL_KEYS = ("enrich_src_musicbrainz", "enrich_src_caa", "enrich_apply_names",
             "enrich_apply_year", "enrich_apply_genres", "enrich_apply_art")


def test_scraper_option_keys_validate_and_persist(client):
    for key in BOOL_KEYS:
        bad = client.post("/api/settings", json={key: "yes"}).json()
        assert "error" in bad
        client.post("/api/settings", json={key: False})
        assert client.get("/api/settings").json()[key] is False
    assert "error" in client.post(
        "/api/settings", json={"enrich_review_order": "random"}).json()
    assert "error" in client.post(
        "/api/settings", json={"enrich_review_order": 42}).json()
    client.post("/api/settings", json={"enrich_review_order": "artist"})
    assert client.get("/api/settings").json()["enrich_review_order"] == "artist"


def test_defaults_present(server):
    d = server._default_settings()
    for key in BOOL_KEYS:
        assert d[key] is True
    assert d["enrich_review_order"] == "missing_first"


# ── per-source: MusicBrainz ───────────────────────────────────────────────────

def test_musicbrainz_source_off_stamps_without_matching(server, mb, client):
    client.post("/api/settings", json={"enrich_src_musicbrainz": False})
    _put(server, "a.sloppak")
    mb.search_response = {"recordings": [mb_doc()]}
    server._background_enrich()
    assert mb.calls == []
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "unscanned"       # hash stamped, no match
    # Re-enabling picks the same row up on the next pass.
    client.post("/api/settings", json={"enrich_src_musicbrainz": True})
    server._background_enrich()
    assert server.meta_db.get_enrichment("a.sloppak")["match_state"] == "matched"


# ── per-field auto-apply ──────────────────────────────────────────────────────

def test_field_toggles_strip_auto_applied_fields(server, mb, client):
    client.post("/api/settings", json={"enrich_apply_year": False,
                                       "enrich_apply_genres": False})
    _put(server, "a.sloppak")
    mb.search_response = {"recordings": [mb_doc()]}
    server._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "matched"
    assert row["canon_artist"] == "AC/DC"
    assert row["canon_title"] == "Thunderstruck"
    assert row["canon_album"] == "The Razors Edge"
    assert row["canon_year"] is None               # toggled off
    assert row["genres"] == []                     # toggled off
    # Identity ids always stamp — the art fetch and re-matching need them.
    assert row["mb_recording_id"] == "rec-1"
    assert row["mb_release_id"] == "rel-1"


def test_names_toggle_keeps_ids_and_other_fields(server, mb, client):
    client.post("/api/settings", json={"enrich_apply_names": False})
    _put(server, "a.sloppak")
    mb.search_response = {"recordings": [mb_doc()]}
    server._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "matched"
    assert row["canon_artist"] is None
    assert row["canon_title"] is None
    assert row["canon_album"] is None
    assert row["canon_year"] == "1990"
    assert row["genres"] == ["hard rock"]
    assert row["mb_recording_id"] == "rec-1"


def test_review_accept_applies_all_fields_despite_toggles(server, mb, client):
    """A match the USER confirms is their intent — the auto-apply toggles
    gate only what happens without them."""
    client.post("/api/settings", json={"enrich_apply_names": False,
                                       "enrich_apply_year": False,
                                       "enrich_apply_genres": False})
    # Partial artist agreement → review tier (candidates stored unfiltered).
    _put(server, "a.sloppak", artist="AC/DC ft Nobody")
    mb.search_response = {"recordings": [mb_doc()]}
    server._background_enrich()
    assert server.meta_db.get_enrichment("a.sloppak")["match_state"] == "review"
    r = client.post("/api/enrichment/review/a.sloppak/accept",
                    json={"recording_id": "rec-1"})
    assert r.status_code == 200
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "manual"
    assert row["canon_artist"] == "AC/DC"
    assert row["canon_year"] == "1990"
    assert row["genres"] == ["hard rock"]


# ── per-field: nothing-forfeited (re-enable backfills, no partial seeding) ─────

def test_reenabling_field_backfills_matched_row(server, mb, client):
    """A field toggled OFF strips the value AND records it in apply_mask, so
    turning the field back on re-queues the (unchanged-hash) matched row and
    backfills — the same "nothing forfeited" contract the source/art toggles
    keep."""
    client.post("/api/settings", json={"enrich_apply_year": False})
    _put(server, "a.sloppak")
    mb.search_response = {"recordings": [mb_doc()]}
    server._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "matched"
    assert row["canon_year"] is None                    # suppressed
    assert row["apply_mask"] == "enrich_apply_year"     # …and remembered
    # Re-enable → next pass re-queues and backfills the year (hash unchanged).
    client.post("/api/settings", json={"enrich_apply_year": True})
    server._background_enrich()
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["match_state"] == "matched"
    assert row["canon_year"] == "1990"                  # backfilled
    assert row["apply_mask"] in (None, "")              # fully applied now
    # Converged: a fully-applied row is not re-queued again.
    assert server.meta_db.enrichment_pending(
        allowed_keys=frozenset(server._ENRICH_APPLY_FIELDS)) == []


def test_partial_match_is_not_a_cache_donor(server):
    """A row that suppressed a display field must not seed a sibling chart of
    the same recording with its blank — enrichment_cache_lookup skips it, so
    the sibling falls through to its own (correctly-filtered) match. A fully-
    applied row IS a donor."""
    h = server.meta_db.enrichment_content_hash("ACDC", "Thunderstruck (v2)", "", 292)
    # Partial donor: matched with the year suppressed (apply_mask set).
    server.meta_db.apply_enrichment_match(
        "a.sloppak", h, "matched", source="text", score=1.0,
        cand={"recording_id": "rec-1", "artist": "AC/DC", "title": "Thunderstruck"},
        apply_mask="enrich_apply_year")
    assert server.meta_db.enrichment_cache_lookup(
        h, exclude_filename="b.sloppak") is None
    # Fully-applied donor (no apply_mask): offered, with its year intact.
    server.meta_db.apply_enrichment_match(
        "c.sloppak", h, "matched", source="text", score=1.0,
        cand={"recording_id": "rec-1", "artist": "AC/DC",
              "title": "Thunderstruck", "year": "1990"})
    donor = server.meta_db.enrichment_cache_lookup(h, exclude_filename="b.sloppak")
    assert donor is not None and donor["year"] == "1990"


# ── per-source / per-field: cover art ─────────────────────────────────────────

def png_bytes(color=(200, 30, 30)):
    buf = _io.BytesIO()
    Image.new("RGB", (4, 4), color).save(buf, "PNG")
    return buf.getvalue()


def make_sloppak(server, name, title="Song", artist="Artist"):
    d = server.DLC_DIR / name
    d.mkdir(parents=True)
    (d / "manifest.yaml").write_text(
        f"title: {title}\nartist: {artist}\nduration: 100\n"
        "arrangements: []\nstems: []\n", encoding="utf-8")
    server.meta_db.put(name, 0, 0, {
        "title": title, "artist": artist, "album": "", "year": "",
        "duration": 100, "arrangements": [{"name": "Lead", "index": 0}],
    })
    return d


def _match_row(server, fn, release_id="rel-1"):
    song = server.meta_db.enrichment_song_row(fn)
    h = server.meta_db.enrichment_content_hash(
        song["artist"], song["title"], song["album"], song["duration"])
    server.meta_db.apply_enrichment_match(
        fn, h, "matched", source="text", score=1.0,
        cand={"recording_id": "rec-1", "release_id": release_id,
              "title": song["title"], "artist": song["artist"]})


@pytest.fixture()
def caa(server, monkeypatch):
    calls = []
    art = {"rel-1": png_bytes((60, 60, 200))}

    def fake(release_id):
        calls.append(release_id)
        return art.get(release_id)
    fake.calls = calls
    monkeypatch.setattr(server, "_caa_http_get", fake)
    monkeypatch.setattr(server, "_enrich_network_enabled", lambda: True)
    return fake


def test_caa_source_toggle_gates_art_fetch(server, client, caa):
    make_sloppak(server, "a.sloppak")
    _match_row(server, "a.sloppak")
    client.post("/api/settings", json={"enrich_src_caa": False})
    server._background_enrich()
    assert caa.calls == []
    row = server.meta_db.get_enrichment("a.sloppak")
    assert row["art_state"] is None                # not forfeited, just skipped
    # Re-enable → the same row is picked up.
    client.post("/api/settings", json={"enrich_src_caa": True})
    server._background_enrich()
    assert server.meta_db.get_enrichment("a.sloppak")["art_state"] == "caa"


def test_apply_art_toggle_gates_art_fetch(server, client, caa):
    make_sloppak(server, "a.sloppak")
    _match_row(server, "a.sloppak")
    client.post("/api/settings", json={"enrich_apply_art": False})
    server._background_enrich()
    assert caa.calls == []
    assert server.meta_db.get_enrichment("a.sloppak")["art_state"] is None


# ── review-queue order ────────────────────────────────────────────────────────

def _review_row(server, fn):
    server.meta_db.apply_enrichment_match(
        fn, "h", "review", source="text", score=0.7,
        candidates=[{"recording_id": "rec-1", "title": "T", "artist": "A"}])


def _review_filenames(client):
    return [s["filename"] for s in
            client.get("/api/enrichment/review").json()["songs"]]


def test_review_queue_order_setting(server, client):
    # a: complete, artist Alpha, oldest; b: missing album+year, artist Zeta,
    # middle; c: missing year, artist Mid, newest — the three orders differ.
    _put(server, "a.sloppak", title="Song A", artist="Alpha",
         album="Full", year="1990", mtime=100)
    _put(server, "b.sloppak", title="Song B", artist="Zeta",
         album="", year="", mtime=200)
    _put(server, "c.sloppak", title="Song C", artist="Mid",
         album="Full", year="", mtime=300)
    for fn in ("a.sloppak", "b.sloppak", "c.sloppak"):
        _review_row(server, fn)

    # Default: missing-data-first.
    assert _review_filenames(client) == ["b.sloppak", "c.sloppak", "a.sloppak"]
    client.post("/api/settings", json={"enrich_review_order": "artist"})
    assert _review_filenames(client) == ["a.sloppak", "c.sloppak", "b.sloppak"]
    client.post("/api/settings", json={"enrich_review_order": "recent"})
    assert _review_filenames(client) == ["c.sloppak", "b.sloppak", "a.sloppak"]
    # An unknown stored value degrades to the default order, never an error.
    assert server.meta_db.enrichment_review_queue(order="bogus")[0]["filename"] == "b.sloppak"
