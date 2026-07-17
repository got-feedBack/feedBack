"""Registered instrument definitions (GET /api/instruments).

Reads from the appstate.instrument_registry seam — the same instance
populated by the plugin loader when it discovers type:instrument plugins.
"""

from fastapi import APIRouter
import appstate

router = APIRouter()


@router.get("/api/instruments")
def get_instruments():
    """Return all instrument definitions registered via instrument plugins."""
    reg = getattr(appstate, "instrument_registry", None)
    return reg.get_all() if reg else []
