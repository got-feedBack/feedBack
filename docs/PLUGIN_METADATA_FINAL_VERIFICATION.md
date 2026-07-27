# Plugin Metadata API — Verification Record

Verification record for the generic plugin metadata feature (`lib/plugin_metadata.py`, the `song_info` WebSocket extension, `GET /api/song/{filename}/metadata`), covering pull request [#1045](https://github.com/got-feedBack/feedBack/pull/1045) (`got-feedBack/feedBack:main` ← `JMcG1:feature/plugin-metadata-api`).

## Scope

The PR changes nine files relative to `upstream/main`, confirmed via `git diff --stat upstream/main...HEAD`:

```text
CHANGELOG.md
docs/PLUGIN_METADATA_API.md
docs/PLUGIN_METADATA_FINAL_VERIFICATION.md
lib/plugin_metadata.py
lib/routers/song.py
lib/routers/ws_highway.py
static/highway.js
tests/test_plugin_metadata.py
tests/test_plugin_metadata_api.py
```

Unrelated working-tree content — the pre-existing repo-wide CRLF/LF line-ending mismatch (~430 files, unstaged), and the untracked `Backups/`, `PR_DESCRIPTION.md`, `docs/PLUGIN_METADATA_API_PROPOSAL.md`, `docs/TEMPORARY_BACKGROUND_API.md`, and `plugins/song-background-manager/` — is confirmed excluded from this diff and from every commit on this branch.

## Architecture

- Both the REST route (`GET /api/song/{filename}/metadata`) and the highway WebSocket's `song_info.metadata` key are assembled by the same shared resolver, `plugin_metadata_for()` in `lib/plugin_metadata.py` — there is no separate REST or WS implementation.
- Both surfaces return the same response shape and apply the same enrichment-gating rule.
- The WebSocket handler may pass an already-loaded `base_metadata` (the sloppak manifest's `album`/`year`, already read for playback) so it can report current values without waiting for a library scan; the REST route has no loaded manifest and remains cache-only (`songs` table, populated at scan time).
- `identifiers.*` (MusicBrainz recording/release/artist ID, ISRC) are populated only when the song's enrichment match state is `matched` or `manual` — a `review`/`failed`/`unscanned` row's candidate data is never surfaced as if confirmed.
- The metadata delivery path makes no network request; fields are resolved
  from already-loaded sloppak manifest data where available, existing local
  SQLite metadata and enrichment tables, or documented safe defaults
  (`""`/`null`).

## Compatibility

- Purely additive: `GET /api/song/{filename}/metadata` is a new route, and `song_info.metadata` is a new, optional key.
- No existing `song_info` field, and no existing REST route, was removed, renamed, or given a different meaning.
- `static/highway.js` assigns `metadata: msg.metadata ?? null` — an older server that omits the raw `metadata` field normalizes to `currentSong.metadata === null` client-side, never `undefined` at the property level.
- Feedpak read/write format is unchanged — this feature only reads already-populated manifest/cache data, it does not touch pack files, manifest keys, or folder layout.

## Tests

Commands run this session, from `core-development` on the current branch:

```console
git diff --check upstream/main...HEAD
```
→ clean, no output.

```console
git diff --stat upstream/main...HEAD
```
→ 9 files changed, 1179 insertions(+), 0 deletions(-) (matches the Scope section above).

All three pytest commands below were run this session on the contributor's own machine (Windows, Python 3.14.6, pytest 9.1.1, `rootdir: core-development`):

```console
python -m pytest tests/test_plugin_metadata.py --collect-only -q
```
→ **23 items collected** in `test_plugin_metadata.py`: shape/version (2), playback metadata with no enrichment (1), year coercion (6 parametrized cases), album_artist always null (1), enrichment gating for `matched`/`manual`/`review`/`failed`/`unscanned` (5, including 3 parametrized), `base_metadata` resolution (7: per-field override of a populated cache, blank/zero values falling through to cache rather than clobbering it, partial `base_metadata` still pulling `genre` from cache, confirmed-enrichment unaffected by `base_metadata`, and unconfirmed-enrichment still hidden with `base_metadata`, 3 parametrized cases), and JSON round-trip (1).

```console
python -m pytest tests/test_plugin_metadata.py tests/test_plugin_metadata_api.py -q
```
→ **31 passed**, 0 failed (23 + 8), 6.12s. 33 warnings, all pre-existing and unrelated to this feature (`StarletteDeprecationWarning` on `httpx`/`testclient`, and `on_event` lifespan deprecation warnings from `server.py`'s existing startup/shutdown handlers).

```console
python -m pytest tests/test_highway_ws_authors.py tests/test_highway_ws_instrument_routing.py tests/test_highway_ws_notation.py tests/test_ws_highway_disconnect.py -q
```
→ **21 passed**, 0 failed (9 + 7 + 4 + 1), 3.37s — the existing highway WebSocket regression suite, unaffected by the new `song_info.metadata` key.

```console
git diff --check upstream/main...HEAD
```
→ clean, no output.
