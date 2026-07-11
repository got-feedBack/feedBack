"""App version + source/license URLs (/api/version).

Extracted verbatim from ``server.py`` (R3) except the decorator (``@app`` ->
``@router``) and the VERSION-file lookup: ``Path(__file__).parent`` (app root
when this lived at the top level) -> ``Path(__file__).resolve().parents[2]``
(routers -> lib -> app root). VERSION ships at the app root in every packaging
path (Dockerfile COPY, desktop bundle).
"""

import os
from pathlib import Path

from fastapi import APIRouter

router = APIRouter()


def _safe_http_url(raw):
    """Return `raw` stripped + trailing-slash-stripped if it parses as an
    http(s) URL with a non-empty host; else None.

    Used to validate operator-supplied `APP_SOURCE_URL` / `APP_LICENSE_URL`
    env vars before they reach `<a href>` in the UI. A bare prefix check
    like `startswith(("http://","https://"))` accepts malformed inputs
    such as `"https://"` (no host) or `"https:///foo"` (empty host) that
    still produce broken hrefs — and, when used as a base for the default
    `license_url`, garbage like `"https:///blob/main/LICENSE"`.
    """
    from urllib.parse import urlsplit
    if not raw:
        return None
    s = raw.strip().rstrip("/")
    if not s:
        return None
    try:
        parsed = urlsplit(s)
    except ValueError:
        return None
    if parsed.scheme.lower() not in ("http", "https"):
        return None
    # `netloc` includes any `user:pass@` and `:port` — strings like
    # "http://:80/path" have non-empty netloc (":80") but no real
    # hostname. Validate `hostname` so only URLs with an actual host
    # are accepted.
    if not parsed.hostname:
        return None
    return s


@router.get("/api/version")
def get_version():
    env_version = os.environ.get("APP_VERSION", "").strip()
    if env_version:
        version = env_version
    else:
        version_file = Path(__file__).resolve().parents[2] / "VERSION"  # R3: app root from lib/routers/
        version = "unknown"
        if version_file.exists():
            try:
                version = version_file.read_text().strip()
            except (OSError, UnicodeDecodeError):
                pass
    default_source_url = "https://github.com/got-feedback/feedBack"
    # APP_SOURCE_URL / APP_LICENSE_URL flow straight into <a href> in the UI,
    # so validate with urllib.parse rather than a bare prefix check — a prefix
    # check accepts malformed values like "https://" (no host) which produce
    # broken hrefs (and a constructed license_url like "https:///blob/main/LICENSE").
    # _safe_http_url requires scheme in {http,https} AND a non-empty hostname
    # (not just netloc — that would still accept port-only authorities like
    # "http://:80/path"); fall back to the safe default otherwise.
    source_url = _safe_http_url(os.environ.get("APP_SOURCE_URL")) or default_source_url
    # APP_LICENSE_URL: explicit override for the LICENSE link. The default
    # constructed value (source_url + "/blob/main/LICENSE") is GitHub-
    # specific and assumes the repo's default branch is `main`; non-GitHub
    # hosts (GitLab, Gitea, self-hosted) need an explicit value.
    license_url = _safe_http_url(os.environ.get("APP_LICENSE_URL")) or (source_url + "/blob/main/LICENSE")
    return {
        "version": version,
        "source_url": source_url,
        "license_url": license_url,
    }
