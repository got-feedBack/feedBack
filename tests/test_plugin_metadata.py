"""Unit tests for lib/plugin_metadata.py — the shared assembly function
behind the highway WebSocket's optional `metadata` key and
`GET /api/song/{filename}/metadata` (see docs/PLUGIN_METADATA_API.md).

Pure `MetadataDB` + `plugin_metadata_for()` tests — no FastAPI, no
WebSocket, no network. The WS/REST integration surface is covered
separately in tests/test_plugin_metadata_api.py, mirroring the existing
split between tests/test_song.py (pure) and the router-level test files.
"""

from __future__ import annotations

import sys

import pytest

import appstate
from metadata_db import MetadataDB
from plugin_metadata import PLUGIN_METADATA_VERSION, plugin_metadata_for


@pytest.fixture()
def db(tmp_path, monkeypatch):
    """A real, isolated MetadataDB wired into appstate.meta_db the same
    way server.py wires the real one at startup — plugin_metadata_for()
    reads appstate.meta_db at call time (never a frozen `from` import),
    so this is a faithful substitute, not a mock."""
    instance = MetadataDB(tmp_path)
    monkeypatch.setattr(appstate, "meta_db", instance)
    yield instance
    instance.conn.close()


def _seed_pack(db, filename, **fields):
    """Seed a `songs` cache row the way a real scan would populate it."""
    base = {
        "title": "Song", "artist": "Artist", "album": "", "year": "",
        "genre": "", "duration": 100.0, "arrangements": [],
    }
    base.update(fields)
    db.put(filename, 0, 0, base)


def _seed_match(db, filename, *, state="matched", recording_id="rec-1",
                 release_id="rel-1", artist_id="art-1", isrc="ISRC0001"):
    """Seed a song_enrichment row the way the P8 matcher would write one."""
    song = db.enrichment_song_row(filename)
    h = db.enrichment_content_hash(
        song["artist"], song["title"], song["album"], song["duration"])
    db.apply_enrichment_match(
        filename, h, state, source="text", score=0.95,
        cand={
            "recording_id": recording_id, "release_id": release_id,
            "artist_id": artist_id, "isrc": isrc,
            "title": song["title"], "artist": song["artist"],
        },
    )


# ── Shape and version ───────────────────────────────────────────────────────

def test_returns_versioned_shape_for_unknown_song(db):
    """A filename with no songs row and no enrichment row must not raise,
    and every field must degrade to a safe default rather than being
    absent — see the module's own documented null contract."""
    out = plugin_metadata_for("never-seen.feedpak")
    assert out == {
        "version": PLUGIN_METADATA_VERSION,
        "album": "",
        "album_artist": None,
        "year": None,
        "genre": "",
        "identifiers": {
            "musicbrainz_recording_id": None,
            "musicbrainz_release_id": None,
            "musicbrainz_artist_id": None,
            "isrc": None,
        },
        "enrichment": {"available": False},
    }


def test_metadata_version_is_present_and_stable(db):
    out = plugin_metadata_for("anything.feedpak")
    assert out["version"] == 1


# ── Playback metadata (album/year/genre) ────────────────────────────────────

def test_playback_metadata_with_no_enrichment(db):
    _seed_pack(db, "AC-DC/Back In Black.feedpak",
               title="Back In Black", artist="AC/DC",
               album="Back In Black", year="1980", genre="Rock")
    out = plugin_metadata_for("AC-DC/Back In Black.feedpak")
    assert out["album"] == "Back In Black"
    assert out["year"] == 1980
    assert out["genre"] == "Rock"
    # No enrichment row at all yet — identifiers stay null, not an error.
    assert out["identifiers"]["musicbrainz_recording_id"] is None
    assert out["enrichment"]["available"] is False


@pytest.mark.parametrize("raw_year,expected", [
    ("", None),
    (None, None),
    ("1980", 1980),
    ("1980-01-01", 1980),   # a loosely-authored full-date value
    ("not-a-year", None),   # malformed — never raises, never guesses
    ("0", None),            # year zero is not a real value
])
def test_year_coercion_never_raises(db, raw_year, expected):
    _seed_pack(db, "song.feedpak", year=raw_year)
    out = plugin_metadata_for("song.feedpak")
    assert out["year"] == expected


def test_album_artist_is_always_none(db):
    """fee[dB]back has no album-artist concept anywhere in its data model
    (confirmed against the Song dataclass, the songs cache schema, the
    song_enrichment schema, and 1,539 real feedpak manifests during the
    investigation behind this module) — this field must never be
    silently filled in from `artist` or anything else."""
    _seed_pack(db, "song.feedpak", artist="Someone")
    out = plugin_metadata_for("song.feedpak")
    assert out["album_artist"] is None


# ── Enrichment gating ────────────────────────────────────────────────────────

def test_matched_enrichment_populates_identifiers(db):
    _seed_pack(db, "song.feedpak")
    _seed_match(db, "song.feedpak", state="matched")
    out = plugin_metadata_for("song.feedpak")
    assert out["identifiers"] == {
        "musicbrainz_recording_id": "rec-1",
        "musicbrainz_release_id": "rel-1",
        "musicbrainz_artist_id": "art-1",
        "isrc": "ISRC0001",
    }
    assert out["enrichment"]["available"] is True


def test_manual_pin_is_treated_as_confirmed(db):
    """A user's manual pick (match_state='manual') is just as authoritative
    as an automatic match for this purpose — the distinction only matters
    to the enrichment review UI, never to a metadata consumer."""
    _seed_pack(db, "song.feedpak")
    _seed_match(db, "song.feedpak", state="manual")
    out = plugin_metadata_for("song.feedpak")
    assert out["enrichment"]["available"] is True
    assert out["identifiers"]["musicbrainz_recording_id"] == "rec-1"


@pytest.mark.parametrize("state", ["review", "failed", "unscanned"])
def test_unconfirmed_states_never_leak_identifiers(db, state):
    """A review/failed/unscanned row's stored candidate data is a
    proposal, not a confirmed identity — must never be surfaced as if it
    were one, mirroring the same gate routers/art.py's candidate assembly
    already applies before trusting mb_release_id."""
    _seed_pack(db, "song.feedpak")
    _seed_match(db, "song.feedpak", state=state)
    out = plugin_metadata_for("song.feedpak")
    assert out["identifiers"] == {
        "musicbrainz_recording_id": None,
        "musicbrainz_release_id": None,
        "musicbrainz_artist_id": None,
        "isrc": None,
    }
    assert out["enrichment"]["available"] is False


# ── base_metadata resolution (WebSocket's already-loaded manifest data) ─────
#
# The WebSocket handler passes the sloppak manifest's album/year through as
# base_metadata instead of relying solely on the songs cache, since the cache
# is only populated once the library scanner has run and can lag behind what
# the handler just loaded (docs/PLUGIN_METADATA_API.md's "Choosing WebSocket
# vs. REST" section). These tests cover that resolution logic directly and
# in isolation — the WS integration test in test_plugin_metadata_api.py only
# exercises the single case of an entirely empty cache.

def test_base_metadata_overrides_populated_cache_per_field(db):
    """base_metadata isn't just a fallback for a missing cache row — it
    takes priority over a cache row that already has its own (older)
    values, field by field, since it reflects what's actually in the
    file the caller just opened."""
    _seed_pack(db, "song.feedpak", album="Cache Album", year="1999", genre="Cache Genre")
    out = plugin_metadata_for(
        "song.feedpak", base_metadata={"album": "Fresh Album", "year": 2020})
    assert out["album"] == "Fresh Album"
    assert out["year"] == 2020


def test_blank_and_zero_base_metadata_falls_through_to_cache(db):
    """A caller that has a Song object but nothing useful in it yet (the
    Song dataclass defaults album to "" and year to 0) must not clobber
    a cache row that already has real values — blank/zero in
    base_metadata means "I don't know," not "this song has no album.\""""
    _seed_pack(db, "song.feedpak", album="Cache Album", year="1999")
    out = plugin_metadata_for(
        "song.feedpak", base_metadata={"album": "", "year": 0})
    assert out["album"] == "Cache Album"
    assert out["year"] == 1999


def test_partial_base_metadata_still_pulls_missing_fields_from_cache(db):
    """base_metadata never carries genre (it isn't part of the Song
    dataclass — see lib/plugin_metadata.py's module docstring), so a
    caller supplying only album/year must still get genre from the
    cache rather than losing it."""
    _seed_pack(db, "song.feedpak", album="Cache Album", year="1999", genre="Cache Genre")
    out = plugin_metadata_for(
        "song.feedpak", base_metadata={"album": "Fresh Album", "year": 2020})
    assert out["genre"] == "Cache Genre"


def test_confirmed_enrichment_still_available_with_base_metadata(db):
    """base_metadata must never gate or suppress enrichment — a matched
    song's MusicBrainz identifiers are exactly as available whether the
    caller passes base_metadata or not."""
    _seed_pack(db, "song.feedpak")
    _seed_match(db, "song.feedpak", state="matched")
    out = plugin_metadata_for(
        "song.feedpak", base_metadata={"album": "Fresh Album", "year": 2020})
    assert out["identifiers"] == {
        "musicbrainz_recording_id": "rec-1",
        "musicbrainz_release_id": "rel-1",
        "musicbrainz_artist_id": "art-1",
        "isrc": "ISRC0001",
    }
    assert out["enrichment"]["available"] is True
    # And the playback fields still resolve independently of enrichment.
    assert out["album"] == "Fresh Album"
    assert out["year"] == 2020


@pytest.mark.parametrize("state", ["review", "failed", "unscanned"])
def test_unconfirmed_enrichment_still_hidden_with_base_metadata(db, state):
    """base_metadata must never bypass the confirmed-match gate either —
    a review/failed/unscanned row's identifiers stay null even when the
    caller also supplies base_metadata."""
    _seed_pack(db, "song.feedpak")
    _seed_match(db, "song.feedpak", state=state)
    out = plugin_metadata_for(
        "song.feedpak", base_metadata={"album": "Fresh Album", "year": 2020})
    assert out["identifiers"] == {
        "musicbrainz_recording_id": None,
        "musicbrainz_release_id": None,
        "musicbrainz_artist_id": None,
        "isrc": None,
    }
    assert out["enrichment"]["available"] is False
    assert out["album"] == "Fresh Album"


# ── Backwards/forwards compatibility of the shape itself ────────────────────

def test_output_is_a_plain_json_serializable_dict(db):
    """Every value must survive a plain json.dumps round trip untouched —
    the WS handler sends this dict straight through websocket.send_json,
    and the REST route returns it straight through FastAPI's default
    JSON response, neither of which does any extra serialization work."""
    import json
    _seed_pack(db, "song.feedpak", album="A", year="1999", genre="G")
    _seed_match(db, "song.feedpak")
    out = plugin_metadata_for("song.feedpak")
    round_tripped = json.loads(json.dumps(out))
    assert round_tripped == out
