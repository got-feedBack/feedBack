"""A raising tuning provider must not take down get_merged() for everyone. (#899)

`TuningProviderRegistry.get_merged()` wraps each provider in a try/except precisely so one
misbehaving plugin cannot break tunings for the rest. The handler called `logger.exception`
— and there is no `logger` in server.py; the module logger is `log`. So the handler MEANT
to swallow-and-report instead raised NameError, which propagated out of get_merged().

The net effect was the exact opposite of the handler's purpose: one bad provider took the
whole merged-tunings call down, and the traceback named the wrong problem.

Nothing exercised the failure path, which is why it survived. This is that path.
"""

import importlib
import logging
import sys

import pytest


@pytest.fixture()
def registry(monkeypatch, tmp_path):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod.TuningProviderRegistry()


def test_a_raising_provider_does_not_break_the_others(registry, caplog):
    """The whole point of the try/except. Before the fix this raised NameError."""
    def boom():
        raise RuntimeError("provider exploded")

    def good():
        return {"guitar": {"My Tuning": [82.41, 110.0, 146.83, 196.0, 246.94, 329.63]}}

    registry.register("bad-plugin", boom)
    registry.register("good-plugin", good)

    merged = registry.get_merged()          # must NOT raise

    assert "My Tuning" in merged["guitar"], (
        "the healthy provider's tuning is missing — one raising provider took down the "
        "merged result for everyone"
    )
    # and the default tunings survive
    assert merged["guitar"], "default tunings were lost"


def test_the_failure_is_actually_logged(registry, caplog):
    """Swallowing is only acceptable if it is reported. A NameError in the handler meant
    nothing was ever logged — the failure was both fatal AND silent about its real cause."""
    def boom():
        raise RuntimeError("provider exploded")

    registry.register("bad-plugin", boom)

    # The feedBack logger sets propagate=False, so pytest's root-logger capture sees
    # NOTHING from it. Attach caplog's handler directly. (test_plugins.py has a
    # capture_logger() context manager for this, but it is not importable from here:
    # pyproject pins pythonpath to [".", "lib"], so `tests` is not a package.)
    lg = logging.getLogger("feedBack")
    orig_level = lg.level
    lg.addHandler(caplog.handler)
    lg.setLevel(logging.ERROR)
    try:
        registry.get_merged()
    finally:
        lg.removeHandler(caplog.handler)
        lg.setLevel(orig_level)  # restore, or ERROR leaks onto the feedBack tree

    assert any("bad-plugin" in r.getMessage() for r in caplog.records), (
        "the raising provider was never named in the logs"
    )
