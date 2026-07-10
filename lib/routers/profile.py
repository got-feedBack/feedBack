"""Player profile — identity, avatars (bundled + custom uploads), and progress.

Extracted verbatim from ``server.py`` (R3); edits: ``@app`` -> ``@router``,
``meta_db`` -> ``appstate.meta_db``, ``CONFIG_DIR``/``STATIC_DIR`` ->
``appstate.config_dir``/``appstate.static_dir`` (seam), ``_clean_str`` from
``reqfields``, ``_get_progression_content()`` ->
``appstate.get_progression_content()``. The bundled-avatar lister moves with it.
"""

import logging
import secrets

from fastapi import APIRouter
from fastapi.responses import FileResponse, JSONResponse

import appstate
from reqfields import _clean_str

log = logging.getLogger("feedBack.server")

router = APIRouter()


def _list_bundled_avatars() -> list[str]:
    """Bundled default avatar filenames under static/v3/avatars/."""
    d = appstate.static_dir / "v3" / "avatars"
    if not d.is_dir():
        return []
    exts = {".svg", ".png", ".webp"}
    return sorted(
        p.name for p in d.iterdir()
        if p.is_file() and p.suffix.lower() in exts and not p.name.startswith(".")
    )


@router.get("/api/profile")
def api_get_profile():
    profile = appstate.meta_db.get_profile()
    # Equipped cosmetics ride along (resolved to their payloads) so the theme
    # and avatar frame apply at boot without an extra request. Never let a
    # cosmetics/content problem break the profile read.
    cosmetics = {}
    try:
        shop = appstate.get_progression_content()["shop"]
        for slot, item_id in appstate.meta_db.get_equipped().items():
            item = shop.get(item_id)
            if item:
                cosmetics[slot] = {"item_id": item_id, "payload": item["payload"]}
    except Exception:
        log.warning("profile cosmetics enrich failed", exc_info=True)
    profile["cosmetics"] = cosmetics
    return profile



@router.post("/api/profile")
def api_set_profile(data: dict):
    """Set/update the player profile. Body: {display_name, avatar:{type,value}}.
    avatar.type is 'default' (value = bundled filename) or 'upload' (value =
    the /api/profile/avatar/<name> URL returned by the upload endpoint); omit
    avatar to keep the existing one (name-only edit)."""
    name = _clean_str(data.get("display_name"))
    if not (1 <= len(name) <= 32):
        return JSONResponse({"error": "Display name must be 1–32 characters."}, status_code=400)
    avatar = data.get("avatar")
    if avatar is None:
        avatar = {}            # omitted → keep the current avatar (name-only edit)
    elif not isinstance(avatar, dict):
        return JSONResponse({"error": "avatar must be an object."}, status_code=400)
    atype = avatar.get("type")
    aval = _clean_str(avatar.get("value"))
    avatar_url = None
    if atype == "default":
        if aval not in _list_bundled_avatars():
            return JSONResponse({"error": "Unknown default avatar."}, status_code=400)
        avatar_url = f"/static/v3/avatars/{aval}"
    elif atype == "upload":
        from safepath import safe_join
        fname = aval.rsplit("/", 1)[-1] if aval.startswith("/api/profile/avatar/") else ""
        target = safe_join(appstate.config_dir / "avatars", fname) if fname else None
        if target is None or not target.is_file():
            return JSONResponse({"error": "Uploaded avatar not found."}, status_code=400)
        avatar_url = f"/api/profile/avatar/{fname}"
    elif atype:
        return JSONResponse({"error": "Unknown avatar type."}, status_code=400)
    # atype None/missing → keep the current avatar (name-only edit).
    return appstate.meta_db.set_profile(name, avatar_url)


@router.get("/api/profile/avatars")
def api_list_avatars():
    return [{"name": n, "url": f"/static/v3/avatars/{n}"} for n in _list_bundled_avatars()]


@router.post("/api/profile/avatar")
def api_upload_avatar(data: dict):
    """Upload a custom avatar as base64 (mirrors the album-art upload pattern).
    Re-encodes to a ≤512px PNG under appstate.config_dir/avatars/."""
    import base64
    import io
    b64 = data.get("image", "")
    if not isinstance(b64, str) or not b64:
        return JSONResponse({"error": "No image data"}, status_code=400)
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    try:
        raw = base64.b64decode(b64)
    except Exception:
        return JSONResponse({"error": "Invalid base64"}, status_code=400)
    if len(raw) > 6 * 1024 * 1024:
        return JSONResponse({"error": "Image too large (max 6 MB)."}, status_code=400)
    avatars_dir = appstate.config_dir / "avatars"
    avatars_dir.mkdir(parents=True, exist_ok=True)
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        img.thumbnail((512, 512))
        fname = f"upload-{secrets.token_hex(4)}.png"  # token busts caches on change
        img.save(str(avatars_dir / fname), "PNG")
    except Exception as e:
        return JSONResponse({"error": f"Invalid image: {e}"}, status_code=400)
    return {"url": f"/api/profile/avatar/{fname}"}


@router.get("/api/profile/avatar/{name}")
def api_get_avatar(name: str):
    from safepath import safe_join
    target = safe_join(appstate.config_dir / "avatars", name)
    if target is None or not target.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    return FileResponse(str(target), media_type="image/png")


@router.get("/api/profile/progress")
def api_profile_progress():
    """One call for the whole profile badge: {level, xp, xp_in_level,
    xp_to_next, current_streak, best_streak, last_active_date}."""
    return appstate.meta_db.get_progress()
