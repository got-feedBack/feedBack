"""Shared pytest fixtures for the feedBack test suite."""

import logging

import pytest
import structlog


_LOGGING_NAMES = ("feedBack", "uvicorn", "uvicorn.error", "uvicorn.access")


@pytest.fixture(autouse=True)
def _reset_enrichment_state():
    """Reset the enrichment worker's process-global state between tests.

    The `server` fixtures pop-and-reimport `server`, but `lib/enrichment.py`
    (which now owns the worker) stays imported for the whole session, so its
    module globals — the cancel Event, the status dict, the caches — would
    otherwise leak across tests. A test that set `_enrich_cancel` (or a stale
    `running` status) could silently short-circuit a later direct
    `_background_enrich()` call. Clear it up front so each test starts clean.
    """
    try:
        import enrichment
    except ImportError:
        yield
        return
    enrichment._enrich_cancel.clear()
    enrichment._enrich_pending_pass = False
    enrichment._enrich_status.update(
        {"running": False, "processed": 0, "last_pass_at": None,
         "total": 0, "matched": 0, "current": None})
    enrichment._enrich_last_fetch = 0.0
    enrichment._artist_alias_cache.clear()
    # _caa_index_locks is deliberately left alone: it's guarded by
    # _caa_index_locks_guard, so clearing it here (unlocked) would race a
    # still-alive worker thread, and its entries are stateless per-release
    # mutexes that don't leak test state anyway.
    yield


@pytest.fixture()
def isolate_logging():
    """Restore feedBack / uvicorn logger state after each test.

    Saves handlers, level, and propagate flag before the test runs and
    restores all three on teardown.  Import into any test module that calls
    configure_logging() so mutations don't bleed across tests.
    """
    saved = {}
    for name in _LOGGING_NAMES:
        lg = logging.getLogger(name)
        saved[name] = (
            list(lg.handlers),  # snapshot the handler list
            lg.level,
            lg.propagate,
        )
    yield
    for name in _LOGGING_NAMES:
        lg = logging.getLogger(name)
        original_handlers, original_level, original_propagate = saved[name]

        # Close and remove any handlers that were added during the test.
        for h in list(lg.handlers):
            if h not in original_handlers:
                lg.removeHandler(h)
                h.close()
        # Remove any original handlers that may have been removed during the test
        # so we can add them back cleanly.
        for h in list(lg.handlers):
            lg.removeHandler(h)
        # Reattach the original handlers.
        for h in original_handlers:
            lg.addHandler(h)

        lg.setLevel(original_level)
        lg.propagate = original_propagate
    structlog.reset_defaults()
