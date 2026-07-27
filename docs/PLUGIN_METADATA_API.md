# Plugin Metadata API

Generic, optional song metadata for plugins: album/year/genre plus
MusicBrainz identifiers, when known. Exposes information the server
already computes (via its MusicBrainz/AcoustID enrichment worker) but
that previously never reached a plugin.

Underlying data investigation: `docs/MUSICBRAINZ_METADATA_AUDIT.md` (in
the `song-background-manager` repository).

## Compatibility guarantee

This is a **purely additive** change:

- No existing field on the highway WebSocket's `song_info` frame, or on
  any existing REST route, has been removed, renamed, or given a
  different meaning.
- The only new surface is one new optional key (`metadata`) on
  `song_info`, and one new route (`GET /api/song/{filename}/metadata`).
- A plugin that reads `song:loaded` today and destructures only the
  fields it already knows about continues to work completely unchanged.
- Every field inside `metadata` is either a value or `null` — never a
  missing key — so a consumer can use plain optional-chaining
  (`song.metadata?.album`) without a `hasOwnProperty`/`in` check.

## The `metadata` object

Carried as an optional key on the highway WebSocket's `song_info` frame,
and as the entire body of `GET /api/song/{filename}/metadata`.

```json
{
  "version": 1,
  "album": "Back In Black",
  "album_artist": null,
  "year": 1980,
  "genre": "Rock",
  "identifiers": {
    "musicbrainz_recording_id": "f3f39d1f-...-0001",
    "musicbrainz_release_id": "f3f39d1f-...-0002",
    "musicbrainz_artist_id": "f3f39d1f-...-0003",
    "isrc": "AUAP08000001"
  },
  "enrichment": {
    "available": true
  }
}
```

A song with no MusicBrainz match yet (or one that hasn't been enrichment-
scanned at all) returns the same shape with the enrichment-derived
fields null — never a missing key, never an error:

```json
{
  "version": 1,
  "album": "",
  "album_artist": null,
  "year": null,
  "genre": "",
  "identifiers": {
    "musicbrainz_recording_id": null,
    "musicbrainz_release_id": null,
    "musicbrainz_artist_id": null,
    "isrc": null
  },
  "enrichment": {
    "available": false
  }
}
```

### Field reference

| Field | Type | Meaning |
|---|---|---|
| `version` | integer | `1` today. Bumped only if this object's *shape* changes in a way a consumer must detect — see Versioning below. |
| `album` | string | From the sloppak's own manifest when the caller already has it loaded (the highway WebSocket, mid-playback), otherwise from the local library cache (populated at scan time from the same manifest). `""` when unknown, never omitted. |
| `album_artist` | `null` (always, today) | fee[dB]back has no album-artist concept anywhere in its current data model — not in the chart format, not in the library cache, not in the enrichment cache. Present in the shape (rather than omitted) so a future version that *does* populate it is purely additive, not a new key a consumer has to start checking for. Never silently filled in from the track `artist`, which is a different, specific piece of data a consumer could reasonably rely on being accurate. |
| `year` | integer or `null` | Same source as `album` — the just-loaded manifest when available, else the local library cache. `null` when unknown or unparseable — never `0`, which would misleadingly imply a real year. |
| `genre` | string | From the local library cache (the pack's own declared genre, not a MusicBrainz-derived one) — genre isn't part of the in-memory `Song` object, so this one always comes from the cache regardless of caller. `""` when unknown. |
| `identifiers.musicbrainz_recording_id` | string or `null` | MusicBrainz recording MBID. Only populated once the song's enrichment match is `matched` or `manual` (see Confidence below). |
| `identifiers.musicbrainz_release_id` | string or `null` | MusicBrainz release MBID — usable directly against the Cover Art Archive (`coverartarchive.org/release/{id}/...`). |
| `identifiers.musicbrainz_artist_id` | string or `null` | MusicBrainz artist MBID. |
| `identifiers.isrc` | string or `null` | International Standard Recording Code, when MusicBrainz has one for the matched recording. |
| `enrichment.available` | boolean | `true` only when the identifiers above are populated (i.e. the match is confirmed, not merely proposed). Check this instead of null-checking every identifier individually. |

### Confidence: why `enrichment.available` can be `false` even for an
### enriched song

fee[dB]back's background matcher classifies every match attempt into a
tier: `matched` (automatic, high confidence), `manual` (a user's
explicit pin — always trusted), `review` (medium confidence, sitting in
the Match-Review queue for a human decision), or `failed`/`unscanned`.
Only `matched` and `manual` rows have their MusicBrainz identifiers
surfaced here. A `review` row's candidate list is a set of *proposals*,
not a confirmed identity — surfacing one of them as if it were settled
would be actively misleading to a plugin (and to whatever the plugin
shows the user). This mirrors the same gate the existing cover-art
candidate API (`GET /api/song/{filename}/art/candidates`) already
applies before trusting a stored `mb_release_id`.

## REST endpoint

```
GET /api/song/{filename}/metadata
```

Returns the `metadata` object described above directly as the response
body (200). Use this for a song that isn't currently playing — a
library-browsing plugin hovering over a song card, for example — since
the WebSocket only carries this data for whichever song is actually
loaded in the highway right now.

Errors mirror the existing sibling route `GET /api/song/{filename}`:

| Status | Body | When |
|---|---|---|
| `404` | `{"error": "DLC folder not configured"}` | No DLC directory is configured on this server at all. |
| `403` | `{"error": "forbidden"}` | The resolved path escapes the configured DLC directory (traversal attempt). |
| `404` | `{"error": "File not found"}` | The filename doesn't resolve to an existing song. |

No network access is ever made by this route — every field comes from
already-populated local cache tables, or is `null`.

## WebSocket

The highway WebSocket's existing `song_info` frame (sent once per song
load over `/ws/highway/{filename}`) now carries one additional optional
key, `metadata`, holding the same object described above. Every other
key on this frame is unchanged.

```json
{
  "type": "song_info",
  "title": "Back In Black",
  "artist": "AC/DC",
  "duration": 269.504,
  "arrangement": "Lead",
  "...": "... every existing field, unchanged ...",
  "metadata": {
    "version": 1,
    "album": "Back In Black",
    "album_artist": null,
    "year": 1980,
    "genre": "Rock",
    "identifiers": {
      "musicbrainz_recording_id": null,
      "musicbrainz_release_id": null,
      "musicbrainz_artist_id": null,
      "isrc": null
    },
    "enrichment": { "available": false }
  }
}
```

Client-side, `window.feedBack.currentSong.metadata` (populated from this
same key by `static/highway.js`) carries the same object to any plugin
listening for `song:loaded`:

```js
window.feedBack.on('song:loaded', (e) => {
  const song = e.detail;
  console.log(song.title, song.artist);          // unchanged, as before
  console.log(song.metadata?.album);              // new, optional
  const mbid = song.metadata?.identifiers?.musicbrainz_release_id;
  if (mbid) {
    // safe to use directly against the Cover Art Archive, etc.
  }
});
```

An older server (or this server before this feature shipped) may omit
the raw `metadata` field from the `song_info` message entirely — but
`static/highway.js` always assigns `metadata: msg.metadata ?? null`
when building `currentSong`, so `song.metadata` normalizes to `null`
in that case, not `undefined`.

- Field access can always use optional chaining, regardless of server
  version: `song.metadata?.album` evaluates safely to `undefined` when
  `song.metadata` is `null` (optional chaining short-circuits the same
  way on `null` as on `undefined`).
- A plugin that specifically needs to know whether metadata is
  available at all — rather than just reading a field and tolerating
  `undefined` — can check `song.metadata !== null`.
- When `song.metadata` isn't `null`, it always has the full key shape
  documented above (`version`, `album`, `album_artist`, `year`,
  `genre`, `identifiers`, `enrichment`) — a plugin never needs to
  check for the existence of an individual field once it has confirmed
  the object itself isn't `null`.

No feature-detection dance is required for this specific kind of
purely-additive change.

## Choosing WebSocket vs. REST

- **Use the WebSocket's `metadata` key** when you already handle
  `song:loaded` and want this data the instant a song loads, with zero
  extra round trips.
- **Use the REST endpoint** when you need metadata for a song that isn't
  currently playing, or when you specifically want to avoid growing your
  `song:loaded` handler's dependency surface.

Both call the exact same underlying function
(`lib/plugin_metadata.py::plugin_metadata_for`) and return the exact
same response shape, and the enrichment/identifier rules (Confidence,
above) are identical on both — a song's MusicBrainz identifiers are
never available on one surface and hidden on the other.

`album`/`year` can, however, briefly differ between the two for a song
that hasn't been through a library scan yet: the WebSocket handler
already has the sloppak's manifest loaded for playback and passes it
through as `base_metadata`, so it can report the real `album`/`year`
immediately, while the REST route has no loaded manifest to draw on and
is cache-only, so it reports `""`/`null` until the next library scan
populates the `songs` cache. This is a temporary staleness window, not
a permanent split — once the scanner has run, both surfaces read the
same cache row and agree again. Don't rely on the two surfaces
returning byte-for-byte identical metadata at the same instant for a
song that was just added and hasn't been scanned yet.

## Versioning

`metadata.version` starts at `1`. It will only be incremented for a
change that removes, renames, or retypes an existing field — something a
consumer genuinely needs to detect and branch on. Adding a new field
(like a future `release_group_id` or `work_id`, should the enrichment
cache ever store one) is **not** such a change and will not bump the
version; existing consumers are already required to tolerate unknown
keys under the compatibility guarantee above.

## Performance notes

- One additional indexed, single-row SQLite read per song load
  (`song_enrichment` keyed by filename), offloaded off the WebSocket's
  event loop the same way the rest of that handler already offloads
  heavier work.
- The `album`/`year`/`genre` fields cost a second, equally cheap indexed
  read against the `songs` cache table — the same table
  `GET /api/song/{filename}` already reads on every call.
- No network access, ever, from either delivery path.
- The REST endpoint adds no cost at all to the playback path — it's only
  as expensive as any other on-demand per-song lookup already in this
  codebase.
