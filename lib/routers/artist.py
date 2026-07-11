"""Artist routes: the artist page + external-links payload
(/api/artist/{name}/page, /links, /links/refresh).

Extracted verbatim from server.py (R3) except @app->@router and the seam reads
(meta_db->appstate.meta_db, CONFIG_DIR->appstate.config_dir, _default_settings->
appstate.default_settings). MusicBrainz link enrichment is reached as
enrichment.X; the shared URL-safety validator lives in lib/library_registry.py.
"""

from fastapi import APIRouter

import appstate
import enrichment
from appconfig import _load_config
from library_registry import _safe_art_redirect_url

import logging
log = logging.getLogger("feedBack.server")
router = APIRouter()

# MB artist url-relation types → the page's link slots (locked position 4:
# whitelist only, links-only forever). Everything not listed is dropped.
_ARTIST_URL_REL_SLOTS = {
    "official homepage": "official",
    "setlistfm": "tour",
    "concerts": "tour",
    "youtube": "video",
    "video channel": "video",
    "social network": "social",
    "bandcamp": "social",
    "soundcloud": "social",
    "wikipedia": "wikipedia",
    "wikidata": "wikipedia",
}


def _artist_links_from_mb(body: dict) -> tuple[dict, list]:
    """Whitelist an MB artist doc's url-relations into the page's link slots:
    {official, tour, video, social: [...], wikipedia}. Every URL passes the
    same http(s)-scheme gate as art redirects (_safe_art_redirect_url) so a
    hostile javascript:/data:/file: resource can never reach an href. First
    URL wins per single slot; social collects up to 5; wikipedia is preferred
    over wikidata when both exist. Also returns MB's genre names (capped)."""
    links: dict = {}
    social: list = []
    wikidata_url = None
    for rel in (body or {}).get("relations") or []:
        if not isinstance(rel, dict):
            continue
        rtype = str(rel.get("type") or "").strip().lower()
        slot = _ARTIST_URL_REL_SLOTS.get(rtype)
        if not slot:
            continue
        url = rel.get("url")
        url = url.get("resource") if isinstance(url, dict) else url
        if _safe_art_redirect_url(url) is None:
            continue
        if slot == "social":
            if url not in social and len(social) < 5:
                social.append(url)
        elif rtype == "wikidata":
            wikidata_url = wikidata_url or url
        elif slot not in links:
            links[slot] = url
    if social:
        links["social"] = social
    if "wikipedia" not in links and wikidata_url:
        links["wikipedia"] = wikidata_url
    genres = [str(g.get("name")) for g in (body or {}).get("genres") or []
              if isinstance(g, dict) and g.get("name")]
    return links, genres[:8]


def _artist_links_payload(name: str, force: bool = False) -> dict:
    """Shared by GET links + POST refresh. Order of gates: the user's opt-in
    setting (external links are OFF by default — the dev-chat thread's call),
    then a known mb_artist_id (no id → nothing to look up), then the cache
    (unless force), then the offline guard, then ONE throttled fetch."""
    cfg = _load_config(appstate.config_dir / "config.json") or appstate.default_settings()
    if cfg.get("artist_external_links") is not True:
        return {"links": {}, "matched": False, "disabled": True}
    canonical = appstate.meta_db._terminal_canonical((name or "").strip())
    mbid = appstate.meta_db.artist_known_mb_id(appstate.meta_db._raw_variants_for(canonical))
    mbid = (mbid or "").strip().lower()
    # The id is interpolated into the MB request path — same strict-shape rule
    # as the manifest identity keys (_MBID_RE), so a junk/hostile value stored
    # via a hand-rolled /pick body can never reach the request line.
    if not mbid or not enrichment._MBID_RE.match(mbid):
        return {"links": {}, "matched": False}
    if not force:
        cached = appstate.meta_db.get_artist_enrichment(mbid)
        if cached:
            return {"links": cached["url_rels"], "genres": cached["genres"],
                    "matched": True, "cached": True, "mb_artist_id": mbid}
    if not enrichment._enrich_network_enabled():
        return {"links": {}, "matched": True, "offline": True, "mb_artist_id": mbid}
    try:
        body = enrichment._mb_http_get(f"artist/{mbid}", {"inc": "url-rels+genres+tags"})
    except enrichment.EnrichTransportError:
        return {"links": {}, "matched": True, "offline": True, "mb_artist_id": mbid}
    links, genres = _artist_links_from_mb(body or {})
    appstate.meta_db.put_artist_enrichment(mbid, links, genres)
    return {"links": links, "genres": genres, "matched": True, "cached": False,
            "mb_artist_id": mbid}


@router.get("/api/artist/{name:path}/page")
def api_artist_page(name: str):
    """The artist page's all-LOCAL payload — counts, albums, aliases, similar-
    in-library, mosaic art, play-all seed. Never touches the network; an
    unmatched or even unknown artist still returns a functional page."""
    return appstate.meta_db.artist_page(name)


@router.get("/api/artist/{name:path}/links")
def api_artist_links(name: str):
    """External links for a matched artist — cached after the first call.
    Sync route on purpose (like /api/enrichment/search): FastAPI runs it in
    the threadpool so the MB throttle's sleep never blocks the event loop."""
    return _artist_links_payload(name)


@router.post("/api/artist/{name:path}/links/refresh")
def api_artist_links_refresh(name: str):
    """Explicit re-fetch of the cached links (the page's manual Refresh)."""
    return _artist_links_payload(name, force=True)
