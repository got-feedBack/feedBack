"""Media/file-serving routes: song audio (/audio/{f}), the local-audio-path
resolver (/api/audio-local-path), and raw sloppak member serving
(/api/sloppak/{f}/file/{rel}).

Extracted verbatim from server.py (R3) except @app->@router and the cache/static
path seams (AUDIO_CACHE_DIR->appstate.audio_cache_dir, STATIC_DIR->
appstate.static_dir, SLOPPAK_CACHE_DIR->appstate.sloppak_cache_dir).
"""

import ipaddress
import re

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse

import appstate
import sloppak as sloppak_mod
from dlc_paths import _get_dlc_dir, _resolve_dlc_path

import logging
log = logging.getLogger("feedBack.server")
router = APIRouter()

def _resolve_sloppak_local_file(filename: str, rel_path: str):
    """Resolve a file inside a sloppak to its on-disk path.

    Applies the same containment guards as ``serve_sloppak_file``. Returns the
    resolved ``Path`` on success, or an ``(error, status)`` tuple on failure so
    callers can produce their endpoint-appropriate response.
    """
    dlc = _get_dlc_dir()
    if not dlc:
        return ("not configured", 404)
    # `filename` is caller-controlled. Contain it under DLC_DIR before it
    # reaches the resolver (see serve_sloppak_file for the traversal rationale).
    resolved = _resolve_dlc_path(dlc, filename)
    if resolved is None:
        return ("forbidden", 403)
    # Confine to actual sloppak bundles — otherwise any plain subdirectory
    # would become a read-any-file-under-DLC_DIR source.
    if not sloppak_mod.is_sloppak(resolved):
        return ("not found", 404)
    # Canonicalise the cache key against the resolved path so equivalent URL
    # forms of the same sloppak converge on one _source_cache entry.
    try:
        filename = resolved.relative_to(dlc.resolve()).as_posix()
    except ValueError:
        # safe_join already proved containment; fail closed regardless.
        return ("forbidden", 403)
    src = sloppak_mod.get_cached_source_dir(filename)
    if src is None:
        try:
            src = sloppak_mod.resolve_source_dir(filename, dlc, appstate.sloppak_cache_dir)
        except Exception:
            return ("not found", 404)
    # Prevent path traversal within the sloppak.
    target = (src / rel_path).resolve()
    try:
        target.relative_to(src.resolve())
    except ValueError:
        return ("forbidden", 403)
    if not target.exists() or not target.is_file():
        return ("not found", 404)
    return target


@router.get("/api/sloppak/{filename:path}/file/{rel_path:path}")
def serve_sloppak_file(filename: str, rel_path: str):
    """Serve a file from inside a sloppak (stems, cover, etc.)."""
    result = _resolve_sloppak_local_file(filename, rel_path)
    if isinstance(result, tuple):
        error, status = result
        return JSONResponse({"error": error}, status)
    target = result
    ext = target.suffix.lower()
    mt = {
        ".ogg": "audio/ogg", ".opus": "audio/ogg", ".oga": "audio/ogg",
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac",
        ".m4a": "audio/mp4",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".webp": "image/webp",
        ".json": "application/json",
    }.get(ext)
    return FileResponse(str(target), media_type=mt) if mt else FileResponse(str(target))


@router.get("/api/audio-local-path")
def audio_local_path(url: str, request: Request):
    """Return absolute local filesystem path for a song URL (Electron desktop only).

    Accepts ``/audio/<path>`` where ``<path>`` may include subdirectory segments —
    no scheme, no host, no query string, no fragment.  The resolved path must stay
    inside appstate.audio_cache_dir or appstate.static_dir; ``..`` traversal, backslashes, and
    absolute ``filename`` values are rejected.

    Also accepts ``/api/sloppak/<filename>/file/<rel>`` (percent-encoded, as
    emitted by the highway song payload) and resolves it to the unpacked
    sloppak cache file via the same containment guards as
    ``serve_sloppak_file`` — this lets the desktop engine play a feedpak
    full-mix natively under WASAPI-exclusive output.

    This endpoint returns a raw filesystem path and is intended exclusively for
    the Electron desktop process (which runs on loopback). Requests from non-
    loopback clients are rejected with 403.
    """
    # Loopback-only — only the local Electron process should call this
    client_host = request.client.host if request.client else None
    try:
        is_loopback = bool(client_host and ipaddress.ip_address(client_host).is_loopback)
    except ValueError:
        is_loopback = client_host == "localhost"
    if not is_loopback:
        return JSONResponse({"error": "forbidden"}, status_code=403)
    # Sloppak in-pack file (feedpak full-mix): /api/sloppak/<fn>/file/<rel>.
    # Both segments arrive percent-encoded (built with urllib quote() in the
    # highway payload); decode before handing to the shared resolver, which
    # re-applies all containment guards on the decoded values.
    slop_match = re.fullmatch(r"/api/sloppak/([^?#]+)/file/([^?#]+)", url)
    if slop_match:
        from urllib.parse import unquote

        result = _resolve_sloppak_local_file(
            unquote(slop_match.group(1)), unquote(slop_match.group(2))
        )
        if isinstance(result, tuple):
            error, status = result
            return JSONResponse({"error": error}, status_code=status)
        return JSONResponse({"path": str(result)})
    # Accept only simple /audio/<filename> — no scheme, no host, no query/fragment
    if not re.fullmatch(r"/audio/[^?#]+", url):
        return JSONResponse({"error": "invalid url"}, status_code=400)
    filename = url[len("/audio/"):]
    # Reject traversal, absolute paths, and backslash separators
    if ".." in filename.split("/") or filename.startswith("/") or "\\" in filename:
        return JSONResponse({"error": "invalid url"}, status_code=400)
    for d in [appstate.audio_cache_dir, appstate.static_dir]:
        candidate = (d / filename).resolve()
        # Ensure resolved path is inside the allowed directory
        try:
            candidate.relative_to(d.resolve())
        except ValueError:
            continue
        if candidate.is_file():
            return JSONResponse({"path": str(candidate)})
    return JSONResponse({"error": "not found"}, status_code=404)


@router.get("/audio/{filename:path}")
def serve_audio(filename: str):
    """Serve audio files from the writable audio cache directory."""
    # Reject traversal attempts and absolute-path components
    if ".." in filename.split("/") or filename.startswith("/") or "\\" in filename:
        return JSONResponse({"error": "not found"}, status_code=404)
    for d in [appstate.audio_cache_dir, appstate.static_dir]:
        candidate = (d / filename).resolve()
        try:
            candidate.relative_to(d.resolve())
        except ValueError:
            continue
        if candidate.is_file():
            return FileResponse(str(candidate))
    return JSONResponse({"error": "not found"}, status_code=404)
