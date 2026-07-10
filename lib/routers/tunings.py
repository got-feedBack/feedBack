"""The merged tuning catalog (/api/tunings).

Extracted verbatim from server.py (R3) except @app->@router, CONFIG_DIR->
appstate.config_dir, _load_config imported from lib/appconfig, and the tuning
registry read through the appstate seam (appstate.tuning_providers — the same
instance plugins register into via the plugin_context in server.py).
"""

from fastapi import APIRouter

import appstate
from appconfig import _load_config
from tunings import DEFAULT_REFERENCE_PITCH, TUNING_PRESET_MIDIS, freqs_to_midis

router = APIRouter()


@router.get("/api/tunings")
def get_tunings():
    cfg = _load_config(appstate.config_dir / "config.json") or {}
    ref = cfg.get("reference_pitch", DEFAULT_REFERENCE_PITCH)
    try:
        ref = float(ref)
        if not (430.0 <= ref <= 450.0):
            ref = DEFAULT_REFERENCE_PITCH
    except (TypeError, ValueError):
        ref = DEFAULT_REFERENCE_PITCH
    merged = appstate.tuning_providers.get_merged(ref)
    # tuningMidis: the same catalog as exact integer MIDI notes (low → high).
    # Built-ins come straight from TUNING_PRESET_MIDIS (no float round-trip);
    # provider-contributed entries are recovered from their frequencies at the
    # served reference pitch. Every consumer today (the v3 badges, plugins)
    # reconstructs midis client-side via log2 — a rounding footgun at non-440
    # references — so serve the integers once, host-side. Additive: the
    # existing referencePitch/tunings shape is unchanged.
    tuning_midis: dict[str, dict[str, list[int]]] = {}
    for key, names in merged.items():
        builtin = TUNING_PRESET_MIDIS.get(key, {})
        resolved: dict[str, list[int]] = {}
        for name, freqs in names.items():
            midis = builtin.get(name) or freqs_to_midis(freqs, ref)
            if midis:
                resolved[name] = list(midis)
        if resolved:
            tuning_midis[key] = resolved
    return {"referencePitch": ref, "tunings": merged, "tuningMidis": tuning_midis}
