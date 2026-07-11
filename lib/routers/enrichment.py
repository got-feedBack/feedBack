"""Metadata-enrichment route handlers (/api/enrichment/*): status, kick/cancel,
per-song state, the Match-Review queue (accept/reject/pick/search), and AcoustID
fingerprint identify.

Extracted verbatim from server.py (R3) except @app->@router and the seam reads
(meta_db->appstate.meta_db, CONFIG_DIR->appstate.config_dir). The enrichment
engine itself — transport, matcher, the background worker, and the upload caps —
lives in lib/enrichment.py and is reached here as enrichment.X.
"""

import asyncio
import os
import shutil
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

import appstate
import enrichment
import mb_match
from appconfig import _load_config

import logging
log = logging.getLogger("feedBack.server")
router = APIRouter()

@router.get("/api/enrichment/status")
def enrichment_status():
    """Enrichment pipeline state: worker flags + row counts by match_state.
    Ambient tool-state for the match-review UI (never a home-screen score —
    design §11); also what tests poke."""
    return {
        "running": enrichment._enrich_status["running"],
        "processed": enrichment._enrich_status["processed"],
        "last_pass_at": enrichment._enrich_status["last_pass_at"],
        "states": appstate.meta_db.enrichment_state_counts(),
        "total_songs": appstate.meta_db.count(),
        # Per-pass matching progress for the "Refresh Metadata" batch bar +
        # per-tile badges (total = songs queued to match this pass, matched =
        # done so far, current = the one being matched now).
        "total": enrichment._enrich_status.get("total", 0),
        "matched": enrichment._enrich_status.get("matched", 0),
        "current": enrichment._enrich_status.get("current"),
        "cancelling": enrichment._enrich_cancel.is_set(),
    }


@router.get("/api/enrichment/song/{filename:path}")
def api_enrichment_song(filename: str):
    """Read-only per-song match provenance for the Details drawer (launch
    polish): which canonical identity this chart matched and how. A tiny
    projection of the cache row — no candidates, no cache paths."""
    row = appstate.meta_db.get_enrichment(filename)
    if not row:
        raise HTTPException(status_code=404, detail="no enrichment row")
    return {k: row.get(k) for k in
            ("match_state", "canon_artist", "canon_title",
             "match_source", "match_score")}


@router.post("/api/enrichment/kick")
def api_enrichment_kick():
    """The Settings "Match now" button AND the library's "Refresh Metadata"
    button: request an enrichment pass without waiting for a scan to complete.
    Processes the songs that still need it (unscanned/changed + retriable
    failures) — already-matched songs are left alone, so on a fully-matched
    library this is a fast no-op. Single-flight + coalescing like every other
    kick — spamming it queues at most one follow-up pass."""
    return {"started": enrichment._kick_enrich()}


@router.post("/api/enrichment/cancel")
def api_enrichment_cancel():
    """Stop button on the "Refresh Metadata" batch: signal the running pass to
    halt after the current song (an in-flight ≤1/s lookup can't be interrupted,
    but no new one is started) and drop any coalesced follow-up. A no-op when
    nothing is running."""
    was_running = enrichment._enrich_status["running"]
    if was_running:
        enrichment._enrich_cancel.set()
    return {"ok": True, "was_running": was_running}


@router.post("/api/enrichment/rematch")
def api_enrichment_rematch(data: dict = Body(...)):
    """The library "Refresh Metadata" button: force a fresh re-match of the
    songs the grid is SHOWING (its visible/filtered window). Resets each to
    `unscanned` so the next pass re-fetches it from scratch — EXCEPT user-pinned
    `manual` rows, which are never auto-overwritten (apply_enrichment_match
    guards that) — then kicks one pass. Scoped to the visible set on purpose:
    fast (dozens of songs), visible (tiles animate), and it can't blow the whole
    ≤1/s rate budget on a 1000-song library the way a full re-sweep would.
    Returns the filenames actually queued so the UI badges exactly those."""
    raw = (data or {}).get("filenames") or []
    fns = [str(f) for f in raw if isinstance(f, str)][:500]
    queued: list[str] = []
    for fn in fns:
        song = appstate.meta_db.enrichment_song_row(fn)
        if not song:
            continue
        h = appstate.meta_db.enrichment_content_hash(
            song["artist"], song["title"], song["album"], song["duration"])
        # allow_manual_overwrite=False → a manual pin is left as-is (returns
        # False), everything else resets to unscanned (returns True).
        if appstate.meta_db.apply_enrichment_match(fn, h, "unscanned",
                                          allow_manual_overwrite=False):
            queued.append(fn)
    started = enrichment._kick_enrich() if queued else False
    return {"queued": queued, "count": len(queued), "started": started}


@router.post("/api/enrichment/states")
def api_enrichment_states(data: dict = Body(...)):
    """Per-tile match states for the grid's VISIBLE window during a metadata
    refresh: the client posts the filenames it is showing and gets back each
    one's match_state (+ the song being matched right now, + whether a pass is
    running), so a card can animate queued→working→result without a per-song
    round-trip. Read-only — safe for demo visitors (no network, no mutation)."""
    raw = (data or {}).get("filenames") or []
    # Bound the batch: a visible grid window is dozens of cards; cap defensively.
    fns = [str(f) for f in raw if isinstance(f, str)][:500]
    return {
        "states": appstate.meta_db.enrichment_states_for(fns),
        "current": enrichment._enrich_status.get("current"),
        "running": enrichment._enrich_status["running"],
    }


@router.post("/api/enrichment/refresh/{filename:path}")
def api_enrichment_refresh(filename: str):
    """The context menu's "Refresh metadata": reset THIS song's match to
    unscanned (canonical values + candidates cleared, backoff zeroed) and
    kick a pass so it re-matches immediately. An EXPLICIT user action, so it
    may discard a manual pin — the automation never does, but the user
    asking for a re-match is the one party who owns that pin."""
    song = appstate.meta_db.enrichment_song_row(filename)
    if not song:
        raise HTTPException(status_code=404, detail="unknown song")
    h = appstate.meta_db.enrichment_content_hash(
        song["artist"], song["title"], song["album"], song["duration"])
    appstate.meta_db.apply_enrichment_match(filename, h, "unscanned",
                                   allow_manual_overwrite=True)
    return {"ok": True, "started": enrichment._kick_enrich()}


@router.get("/api/enrichment/review")
def api_enrichment_review(limit: int = 200):
    """The Match-Review queue: songs whose text match landed in the medium-
    confidence review tier, each with its stored candidate list — the drawer
    renders straight from this, no MusicBrainz round-trip. Ordered by the
    user's enrich_review_order setting."""
    limit = max(1, min(int(limit), 500))
    cfg = _load_config(appstate.config_dir / "config.json") or {}
    order = cfg.get("enrich_review_order", "missing_first")
    return {
        "songs": appstate.meta_db.enrichment_review_queue(limit=limit, order=order),
        "total_review": appstate.meta_db.enrichment_state_counts().get("review", 0),
    }


@router.post("/api/enrichment/review/{filename:path}/accept")
def api_enrichment_accept(filename: str, data: dict = Body(...)):
    """Accept one of the stored review candidates: the row becomes a
    user-pinned `manual` match (never auto-reset). Display-only, like every
    enrichment write — nothing touches the pack file."""
    recording_id = str((data or {}).get("recording_id") or "")
    row = appstate.meta_db.get_enrichment(filename)
    if not row or row["match_state"] != "review":
        raise HTTPException(status_code=404, detail="no review row for this song")
    cand = next((c for c in (row.get("candidates") or [])
                 if c.get("recording_id") == recording_id), None)
    if not cand:
        raise HTTPException(status_code=404, detail="candidate not in the stored list")
    if not appstate.meta_db.set_enrichment_manual(filename, cand, source="review"):
        raise HTTPException(status_code=404, detail="unknown song")
    return {"ok": True, "enrichment": appstate.meta_db.get_enrichment(filename)}


@router.post("/api/enrichment/review/{filename:path}/reject")
def api_enrichment_reject(filename: str):
    """"None of these" — clears any canonical values and parks the row as
    failed/rejected (never auto-retried; editing the song's metadata
    re-queues it). Valid from `review` or `matched`, never from `manual`."""
    if not appstate.meta_db.set_enrichment_rejected(filename):
        raise HTTPException(status_code=404, detail="no rejectable match for this song")
    return {"ok": True, "enrichment": appstate.meta_db.get_enrichment(filename)}


# The candidate fields a manual pick is allowed to carry — the payload comes
# from our own /api/enrichment/search proxy, but the route re-sanitizes so a
# hand-rolled client can't stuff arbitrary keys/types into the cache row.
_CAND_STR_FIELDS = ("recording_id", "title", "artist", "artist_id",
                    "artist_sort", "release_id", "album", "year", "isrc")


def _sanitize_candidate(raw: dict) -> dict | None:
    if not isinstance(raw, dict):
        return None
    out = {k: str(raw.get(k) or "") for k in _CAND_STR_FIELDS}
    if not out["recording_id"] or not out["title"]:
        return None
    genres = raw.get("genres") or []
    out["genres"] = [str(g) for g in genres if isinstance(g, str)][:5] \
        if isinstance(genres, list) else []
    return out


@router.post("/api/enrichment/review/{filename:path}/pick")
def api_enrichment_pick(filename: str, data: dict = Body(...)):
    """Fix-match / manual search-and-pick: pin a candidate the user found via
    /api/enrichment/search (not limited to the stored review list — this is
    the escape hatch for a wrong auto-match too). Sets `manual`, the
    highest-authority state."""
    cand = _sanitize_candidate((data or {}).get("candidate"))
    if not cand:
        raise HTTPException(status_code=400, detail="candidate needs recording_id + title")
    if not appstate.meta_db.set_enrichment_manual(filename, cand, source="search"):
        raise HTTPException(status_code=404, detail="unknown song")
    return {"ok": True, "enrichment": appstate.meta_db.get_enrichment(filename)}


@router.get("/api/enrichment/search")
def api_enrichment_search(artist: str = "", title: str = "", limit: int = 8,
                          filename: str = "", duration: float = 0.0):
    """Manual-search proxy to MusicBrainz (throttled + identified like the
    background matcher — a user typing in the drawer must not sidestep the
    rate limit). `filename` optionally scores results against that song's
    stored identity (year/duration corroboration) instead of just the typed
    text. `duration` (seconds) lets a caller that HAS the audio but no library
    row — e.g. the editor's create modal, which holds the master track — pass
    its length so the studio take ranks above live/extended cuts. Sync route on
    purpose: FastAPI runs it in the threadpool, so the throttle's sleep never
    blocks the event loop."""
    if not (artist.strip() or title.strip()):
        raise HTTPException(status_code=400, detail="artist or title required")
    limit = max(1, min(int(limit), 25))
    try:
        cands = enrichment._mb_search_recordings(artist, title, limit=limit)
    except enrichment.EnrichTransportError as e:
        return JSONResponse({"error": "musicbrainz unavailable", "detail": str(e)},
                            status_code=503)
    ref = None
    if filename:
        ref = appstate.meta_db.enrichment_song_row(filename)
    if ref is None:
        ref = {"artist": artist, "title": title}
    # A caller-supplied duration corroborates the take even without a library row.
    if duration and duration > 0 and not ref.get("duration"):
        ref = dict(ref)
        ref["duration"] = duration
    # Alias-enrich so a non-Latin-primary artist (大橋純子) ranks by its
    # romanized alias against the typed query ("Junko Ohashi") instead of
    # sinking to the bottom with a 0 artist score.
    try:
        enrichment._alias_enrich(ref, cands)
    except enrichment.EnrichTransportError:
        pass   # aliases are a ranking nicety here; fall back to primary-name scoring
    return {"candidates": mb_match.rank_candidates(ref, cands)}


@router.post("/api/enrichment/identify")
async def api_enrichment_identify(request: Request):
    """Identify a song by AUDIO FINGERPRINT (AcoustID) rather than text — the
    reliable way to get the EXACT recording/version (the studio take, not a live
    bootleg or an extended cut). Upload the master audio; returns candidates in
    the same shape as /search, so the review UI and the editor's Match popup can
    render fingerprint hits identically. 412 `needs_setup` when the user hasn't
    opted in / has no key (the UI nudges them to Settings); 503 when it's set up
    but the fpcalc Chromaprint binary is missing or the network is off. Async so
    the multipart is size-capped BEFORE spooling; the blocking fpcalc subprocess
    + AcoustID HTTP run in the threadpool via run_in_executor."""
    gate = enrichment._acoustid_gate()
    if gate is not None:
        return gate
    # Pre-parse Content-Length guard — reject an oversized body before Starlette
    # spools the multipart to temp disk (mirrors the song-upload endpoint). The
    # per-part cap below is the authoritative limit; this is the fast up-front no.
    cl = request.headers.get("content-length")
    if cl is not None:
        try:
            cl_int = int(cl)
        except ValueError:
            return JSONResponse({"error": "Invalid Content-Length header"}, status_code=400)
        if cl_int > enrichment._ACOUSTID_MAX_UPLOAD_BYTES + enrichment._MULTIPART_OVERHEAD_SLACK:
            return JSONResponse({"error": "audio upload too large (256 MB max)"}, status_code=413)
    try:
        form = await request.form(max_part_size=enrichment._ACOUSTID_MAX_UPLOAD_BYTES)
    except Exception:
        return JSONResponse({"error": "audio upload too large (256 MB max)"}, status_code=413)
    file = form.get("file")
    if not isinstance(file, UploadFile):
        raise HTTPException(status_code=400, detail="missing file upload")
    import tempfile
    ext = (Path(file.filename or "").suffix or ".bin").lower()
    tmpdir = tempfile.mkdtemp(prefix="feedback_acoustid_")
    tmp = os.path.join(tmpdir, "audio" + ext)
    try:
        total = 0
        with open(tmp, "wb") as fh:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > enrichment._ACOUSTID_MAX_UPLOAD_BYTES:
                    return JSONResponse(
                        {"error": "audio upload too large (256 MB max)"}, status_code=413)
                fh.write(chunk)
        if total == 0:
            raise HTTPException(status_code=400, detail="empty upload")
        # fpcalc subprocess + AcoustID HTTP are blocking — off the event loop.
        cands = await asyncio.get_event_loop().run_in_executor(
            None, enrichment._identify_by_fingerprint, tmp)
    except enrichment.EnrichTransportError as e:
        return JSONResponse({"error": "acoustid unavailable", "detail": str(e)},
                            status_code=503)
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    return {"candidates": cands}


@router.post("/api/enrichment/identify/{filename:path}")
def api_enrichment_identify_song(filename: str):
    """Identify an EXISTING library song by AUDIO FINGERPRINT — the library-side
    counterpart to /api/enrichment/identify (which takes an upload). Fingerprints
    the song's own master audio on disk (the manual "Identify by audio" action in
    the Fix-metadata / match-review flow). Same candidate shape as /search, so the
    review UI renders fingerprint hits like text hits. Same 412/503 gating; 404
    when the song has no full-mix audio to fingerprint."""
    gate = enrichment._acoustid_gate()
    if gate is not None:
        return gate
    audio = enrichment._song_audio_file(filename)
    if not audio:
        return JSONResponse(
            {"error": "no audio",
             "detail": "couldn't find this song's master audio to fingerprint "
                       "(a stems-only pack has no full mix to identify)."},
            status_code=404)
    try:
        cands = enrichment._identify_by_fingerprint(audio)
    except enrichment.EnrichTransportError as e:
        return JSONResponse({"error": "acoustid unavailable", "detail": str(e)},
                            status_code=503)
    return {"candidates": cands}
