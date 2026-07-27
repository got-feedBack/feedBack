"""Generic plugin metadata assembly (see docs/PLUGIN_METADATA_API.md).

`plugin_metadata_for(filename, *, base_metadata=None)` is the single
source of truth for the optional `metadata` object carried on the
highway WebSocket's `song_info` frame (`routers/ws_highway.py`) and
served directly by `GET /api/song/{filename}/metadata`
(`routers/song.py`). Both call sites call this one function so they can
never drift out of sync with each other — see
PLUGIN_METADATA_API_PROPOSAL.md's "two-file drift" risk note for why
that matters here specifically.

Design contract (do not weaken without updating both call sites and
docs/PLUGIN_METADATA_API.md):

* Pure with respect to the caller — takes a filename and an optional
  already-known metadata dict, returns a plain dict. No FastAPI/
  WebSocket/Request objects, so it is trivially unit testable and safe
  to call from either the WS handler or a REST route.
* `base_metadata` lets a caller that has *already* loaded a song (the
  WebSocket handler parses the sloppak/manifest before this is ever
  called) hand over what it already knows — album/year/genre — instead
  of forcing a second, possibly-stale lookup against the `songs` cache
  table, which is only populated once the library scanner has run and
  can lag behind what's actually in the file the caller just opened.
  Per field, the resolution order is: `base_metadata` → the `songs`
  cache (`MetadataDB.pack_fields`) → a safe default (`""`/`None`). A
  caller with nothing already loaded (e.g. the REST route, which never
  reads the sloppak) simply omits `base_metadata` and the function
  behaves exactly as it did before this parameter existed.
* At most two SQLite reads — both already-existing, already-indexed,
  single-row primary-key lookups (`MetadataDB.pack_fields`,
  `MetadataDB.get_enrichment`) — no new tables, no new query shapes, no
  N+1 risk from repeated calls. `pack_fields` is still always called
  (its `title`/`artist` romaji handling and its role as the fallback
  for any field `base_metadata` doesn't supply mean it can't be
  skipped just because a caller passed partial base metadata), so this
  remains at most two reads regardless of what `base_metadata` contains.
* Zero network access, ever. Every field either comes from the caller's
  `base_metadata`, the local `songs`/`song_enrichment` cache tables, or
  is `None`.
* Never raises for an unknown/unscanned filename — every field degrades
  to `None` (or `""`/`0`-equivalent defaults) rather than raising, so a
  caller never needs a try/except around this call.
* Enrichment (MusicBrainz identifiers, ISRC) always comes exclusively
  from `appstate.meta_db.get_enrichment(filename)` — `base_metadata`
  can never influence or bypass this. Populated ONLY when the song's
  enrichment row is `matched` or `manual` — a `review`/`failed`/
  `unscanned` row's stored candidate data is a proposal, not a
  confirmed identity, and must never be surfaced as if it were one
  (mirrors the same gate `routers/art.py`'s candidate assembly already
  applies before trusting `mb_release_id`).
"""

from __future__ import annotations

import appstate

# Bump this when the shape of the returned dict changes in a way a
# consumer might need to detect (a field is added is NOT such a change —
# see docs/PLUGIN_METADATA_API.md's compatibility guarantees; only a
# removed/renamed/retyped field would be, and this module promises never
# to do that silently).
PLUGIN_METADATA_VERSION = 1

# Enrichment states whose stored MusicBrainz fields represent a confirmed
# identity rather than an in-progress or rejected proposal.
_CONFIRMED_MATCH_STATES = ("matched", "manual")


def _year_or_none(raw) -> int | None:
    """Coerce the `songs.year` cache column (stored as TEXT, sometimes
    blank, sometimes a full date string from a loosely-authored pack) to
    a clean int, or None when it isn't one. Never raises."""
    if raw in (None, ""):
        return None
    try:
        year = int(str(raw)[:4])
    except (TypeError, ValueError):
        return None
    return year if year > 0 else None


def _text_or_empty(*candidates) -> str:
    """First truthy (non-None, non-blank) candidate, else `""`. Used for
    the string fields, where `base_metadata` is preferred over the
    `songs` cache but neither should ever surface `None` for these."""
    for value in candidates:
        if value:
            return value
    return ""


def plugin_metadata_for(filename: str, *, base_metadata: dict | None = None) -> dict:
    """Assemble the generic plugin metadata object for one song.

    `filename` is the same DLC-relative key every other per-song cache
    lookup in this codebase uses (the `songs`/`song_enrichment` tables'
    primary key) — callers are responsible for resolving/canonicalizing
    a request path to that form first, exactly as `routers/song.py`'s
    `get_song_info` already does via `song_path.relative_to(dlc.resolve())
    .as_posix()` before touching the cache.

    `base_metadata`, when given, is an already-known subset of this
    song's metadata (currently `album`/`year`/`genre` are recognized;
    unrecognized keys are ignored) that the caller obtained some other
    way — the WebSocket handler passes the `album`/`year` it just parsed
    off the sloppak's own manifest, since that's more current than
    whatever the last library scan cached and avoids reading the
    sloppak a second time. Any field `base_metadata` doesn't supply (or
    supplies as blank/zero/unknown) falls back to the `songs` cache
    exactly as before. This parameter never affects enrichment, which is
    always read fresh from `song_enrichment` regardless.

    Always returns a fully-shaped dict; every field that can't be
    determined is `None` rather than an exception or a missing key, so a
    caller can serialize the result directly with no None-checking of
    its own beyond what it wants to do with the values.
    """
    pack = appstate.meta_db.pack_fields(filename)
    enrichment = appstate.meta_db.get_enrichment(filename)
    base = base_metadata or {}

    confirmed = bool(
        enrichment and enrichment.get("match_state") in _CONFIRMED_MATCH_STATES
    )

    year = _year_or_none(base.get("year"))
    if year is None:
        year = _year_or_none(pack.get("year"))

    return {
        "version": PLUGIN_METADATA_VERSION,
        "album": _text_or_empty(base.get("album"), pack.get("album")),
        # fee[dB]back has no album-artist concept anywhere in its data
        # model today — not in the Song dataclass, not in the `songs`
        # cache, not in `song_enrichment`, not in the feedpak manifest
        # schema (confirmed against 1,539 real sample packs during the
        # investigation behind this module). Always None rather than
        # silently substituting the track artist, which is a different,
        # specific piece of data a consumer could reasonably rely on
        # being accurate.
        "album_artist": None,
        "year": year,
        "genre": _text_or_empty(base.get("genre"), pack.get("genre")),
        "identifiers": {
            "musicbrainz_recording_id": (
                enrichment.get("mb_recording_id") if confirmed else None
            ),
            "musicbrainz_release_id": (
                enrichment.get("mb_release_id") if confirmed else None
            ),
            "musicbrainz_artist_id": (
                enrichment.get("mb_artist_id") if confirmed else None
            ),
            "isrc": enrichment.get("isrc") if confirmed else None,
        },
        "enrichment": {
            "available": confirmed,
        },
    }
