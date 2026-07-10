"""Diagnostic bundle export + hardware probe (/api/diagnostics/*).

One-click "Export Diagnostics" in Settings produces a redacted zip combining
server logs, system info, hardware (CPU/GPU/RAM), plugin inventory, and the
browser-side console transcript + hardware probe. Bundle format is specified in
docs/diagnostics-bundle-spec.md.

Extracted verbatim from server.py (R3) except:
  - the decorators (@app -> @router),
  - CONFIG_DIR -> appstate.config_dir and _running_version() ->
    appstate.running_version() (both read through the appstate seam),
  - the builtin-plugins lookup in _diag_plugins_roots: Path(__file__).parent
    (the app root when this lived at the top level) ->
    Path(__file__).resolve().parents[2] (routers -> lib -> app root). The
    plugins/ dir ships at the app root in every packaging path.

The pure helpers + caps here are re-exported from server.py so the existing
`server._diag_*` / `server._DIAG_*` tests keep resolving (none monkeypatch them).
"""

import json
import logging
import os
from pathlib import Path

from fastapi import APIRouter, Body, Response

import appstate
from dlc_paths import _get_dlc_dir
from diagnostics_bundle import build_bundle as _diag_build, preview_bundle as _diag_preview
from diagnostics_hardware import collect as _diag_hardware
from env_compat import getenv_compat

log = logging.getLogger("feedBack.server")
router = APIRouter()


def _diag_log_file() -> Path | None:
    raw = os.environ.get("LOG_FILE", "").strip()
    if not raw:
        return None
    return Path(raw)


def _diag_plugins_roots() -> list[Path]:
    """Return all plugin root directories for orphan scanning.

    Includes both the built-in ``plugins/`` directory and
    ``FEEDBACK_PLUGINS_DIR`` when set, so user-installed plugins and
    orphans in the external dir are reflected in the bundle.
    """
    roots: list[Path] = []
    user_dir = getenv_compat("FEEDBACK_PLUGINS_DIR", "").strip()
    if user_dir:
        p = Path(user_dir)
        if p.is_dir():
            roots.append(p)
    builtin = Path(__file__).resolve().parents[2] / "plugins"  # R3: app root from lib/routers/
    if builtin not in roots:
        roots.append(builtin)
    return roots


def _diag_coerce_bool(v, *, default: bool = True) -> bool:
    """Coerce a request-side value to bool, accepting both JSON booleans and
    string representations.

    - Falsy strings: ``"false"``, ``"0"``, ``"no"``, ``""`` → ``False``
    - ``None`` → *default*
    - Everything else (including ``"true"``, ``"1"``) → ``True``
    """
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() not in ("false", "0", "no", "")
    return bool(v)


def _diag_normalize_include(include: dict | None) -> dict:
    """Coerce request-side flags to the booleans build_bundle expects.
    Missing keys default to True so a bare {} request still produces
    the full bundle.

    Accepts both JSON booleans (``true``/``false``) and string
    representations so callers that serialize flags as strings behave
    consistently with the preview endpoint:
    - Falsy strings: ``"false"``, ``"0"``, ``"no"``, ``""`` → ``False``
    - Everything else (including ``"true"``, ``"1"``, ``"yes"``) → ``True``
    """
    keys = ("system", "hardware", "logs", "console", "plugins")
    if not isinstance(include, dict):
        return {k: True for k in keys}

    return {k: _diag_coerce_bool(include.get(k), default=True) for k in keys}


# Server-side caps on client-supplied payload sections.  diagnostics.js
# enforces a 500-entry / ~250 KB ring buffer on the browser side; these
# bounds give generous headroom while still preventing a crafted POST from
# forcing the server to allocate arbitrarily large in-memory bundles.
_DIAG_MAX_CONSOLE_ENTRIES = 1000          # hard cap: truncate silently
_DIAG_MAX_CONSOLE_BYTES = 2 * 1024 * 1024  # 2 MB hard cap on total console list
_DIAG_MAX_CLIENT_PAYLOAD_BYTES = 2 * 1024 * 1024   # 2 MB per dict section
_DIAG_MAX_CONTRIBUTIONS_BYTES = 4 * 1024 * 1024    # 4 MB aggregate cap for contributions


def _diag_cap_console(v) -> list | None:
    """Return *v* if it is a list, truncated to _DIAG_MAX_CONSOLE_ENTRIES entries
    and _DIAG_MAX_CONSOLE_BYTES total.  Entries are accumulated until either cap
    is reached; no partial-entry splitting occurs."""
    if not isinstance(v, list):
        return None
    result = v[:_DIAG_MAX_CONSOLE_ENTRIES]
    # Also enforce a byte cap — the count cap alone does not bound memory when
    # entries contain arbitrarily large strings.
    try:
        out = []
        total = 0
        for entry in result:
            encoded = json.dumps(entry, separators=(",", ":")).encode("utf-8", errors="replace")
            if total + len(encoded) > _DIAG_MAX_CONSOLE_BYTES:
                break
            out.append(entry)
            total += len(encoded)
        return out
    except (TypeError, ValueError):
        return None


def _diag_cap_dict(v) -> dict | None:
    """Return *v* if it is a dict whose JSON serialisation fits within
    _DIAG_MAX_CLIENT_PAYLOAD_BYTES, otherwise return None."""
    if not isinstance(v, dict):
        return None
    try:
        encoded = json.dumps(v, separators=(",", ":")).encode("utf-8", errors="replace")
    except (TypeError, ValueError) as e:
        log.warning("diagnostics client payload is not JSON-serialisable, dropping: %s", e)
        return None
    if len(encoded) > _DIAG_MAX_CLIENT_PAYLOAD_BYTES:
        return None
    return v


def _diag_cap_contributions(v, known_ids=None) -> dict | None:
    """Apply per-plugin and aggregate size caps on client_contributions.

    Unlike _diag_cap_dict(), which drops the whole dict when any plugin
    exceeds the limit, this function caps each plugin independently so
    one noisy plugin does not silence every other plugin's contribution.

    Parameters
    ----------
    v:
        The raw contributions dict from the POST payload.
    known_ids:
        When provided, contributions from plugins not in this set are
        skipped *before* serialisation, preventing a malicious caller
        from forcing the server to JSON-encode hundreds of near-limit
        payloads that ``build_bundle()`` would later discard anyway.
        ``None`` means "accept all plugin ids" (used in tests / preview).
    """
    if not isinstance(v, dict):
        return None
    result = {}
    total_bytes = 0
    for pid, contribution in v.items():
        if not isinstance(pid, str):
            continue
        # Filter unknown plugin ids early — before serialising — so a
        # crafted request cannot force large allocations for plugins that
        # build_bundle() would drop.
        if known_ids is not None and pid not in known_ids:
            continue
        try:
            encoded = json.dumps(contribution, separators=(",", ":")).encode("utf-8", errors="replace")
        except (TypeError, ValueError) as e:
            log.warning(
                "client_contributions[%r] is not JSON-serialisable, dropping: %s", pid, e
            )
            continue
        if len(encoded) > _DIAG_MAX_CLIENT_PAYLOAD_BYTES:
            log.warning(
                "client_contributions[%r] exceeds %d bytes, dropping",
                pid, _DIAG_MAX_CLIENT_PAYLOAD_BYTES,
            )
            continue
        if total_bytes + len(encoded) > _DIAG_MAX_CONTRIBUTIONS_BYTES:
            log.warning(
                "client_contributions aggregate size limit (%d bytes) reached, "
                "dropping remaining entries",
                _DIAG_MAX_CONTRIBUTIONS_BYTES,
            )
            break
        result[pid] = contribution
        total_bytes += len(encoded)
    return result or None


@router.post("/api/diagnostics/export")
def export_diagnostics(payload: dict = Body(default_factory=dict)):
    """Build a diagnostic bundle and stream it back as a zip download.

    The browser layers in `client_console`, `client_hardware`,
    `client_ua`, and `local_storage` before posting; the server adds
    server logs, hardware, plugin inventory, and packages everything
    into a single zip.

    Errors during plugin diagnostics callables are caught and logged
    to the bundle's manifest `notes` rather than failing the export.
    """
    from plugins import LOADED_PLUGINS, PLUGINS_LOCK

    redact = _diag_coerce_bool(payload.get("redact", True), default=True)
    include = _diag_normalize_include(payload.get("include"))
    client_console = _diag_cap_console(payload.get("client_console"))
    client_hardware = _diag_cap_dict(payload.get("client_hardware"))
    client_ua = _diag_cap_dict(payload.get("client_ua"))
    local_storage = _diag_cap_dict(payload.get("local_storage"))
    # Fetch the plugin list first so we can filter contributions to known
    # plugin ids before serialising — prevents a crafted request from
    # forcing large allocations for plugins build_bundle() would drop.
    with PLUGINS_LOCK:
        plugins_snapshot = list(LOADED_PLUGINS)
    known_ids = {p.get("id") for p in plugins_snapshot if isinstance(p.get("id"), str)}
    client_contributions = _diag_cap_contributions(
        payload.get("client_contributions"), known_ids=known_ids
    )

    zip_bytes, filename, _manifest = _diag_build(
        feedBack_version=appstate.running_version(),
        config_dir=appstate.config_dir,
        dlc_dir=_get_dlc_dir(),
        log_file=_diag_log_file(),
        loaded_plugins=plugins_snapshot,
        include=include,
        redact=redact,
        client_console=client_console,
        client_hardware=client_hardware,
        client_ua=client_ua,
        local_storage=local_storage,
        client_contributions=client_contributions,
        log=log,
        plugins_root=_diag_plugins_roots(),
    )
    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/api/diagnostics/preview")
def preview_diagnostics(
    redact: bool = True,
    system: bool = True,
    hardware: bool = True,
    logs: bool = True,
    console: bool = True,
    plugins: bool = True,
):
    """Return what `/api/diagnostics/export` would produce, minus the
    actual file contents — file tree, sizes, schemas, redaction counts.
    Lets the Settings UI show the user what's about to be sent."""
    from plugins import LOADED_PLUGINS, PLUGINS_LOCK

    include = {
        "system": system,
        "hardware": hardware,
        "logs": logs,
        "console": console,
        "plugins": plugins,
    }
    with PLUGINS_LOCK:
        plugins_snapshot = list(LOADED_PLUGINS)
    return _diag_preview(
        feedBack_version=appstate.running_version(),
        config_dir=appstate.config_dir,
        dlc_dir=_get_dlc_dir(),
        log_file=_diag_log_file(),
        loaded_plugins=plugins_snapshot,
        include=include,
        redact=redact,
        log=log,
        plugins_root=_diag_plugins_roots(),
    )


@router.get("/api/diagnostics/hardware")
def diagnostics_hardware():
    """Backend hardware probe (cross-platform). Reusable independently
    of the bundle export — handy for "what's my GPU" plugin queries."""
    return _diag_hardware()
