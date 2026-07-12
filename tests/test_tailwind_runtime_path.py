"""The runtime stylesheet must NOT be written over the committed one. (#911)

Two different things used to share `static/tailwind.min.css`:

    the committed file   a BUILD ARTEFACT — image-baked, generated from the in-tree plugins
                         only, and verified by CI's `tailwind-fresh` check.
    the runtime sheet    PER-INSTALL STATE — additionally scans whatever the user installed
                         into FEEDBACK_PLUGINS_DIR, so it differs machine to machine.

Writing the second over the first meant that merely RUNNING THE DEV SERVER from a git checkout
silently modified a tracked file. `git add -A` then swept a 100KB reshuffle of minified CSS
into the commit and `ci/tailwind-fresh` went red with a diff that explained nothing — on a PR
whose real change touched no Tailwind classes at all. It also meant writing app state into the
app directory, which is read-only in some deploys.

These tests pin the separation. The first is the one that matters: it is the exact failure that
shipped.
"""

import importlib
import sys
from pathlib import Path

import pytest


@pytest.fixture()
def tw(monkeypatch, tmp_path):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    sys.modules.pop("tailwind_rebuild", None)
    return importlib.import_module("tailwind_rebuild")


def test_the_runtime_sheet_is_not_the_committed_one(tw, tmp_path):
    """THE REGRESSION. The runtime build must never target the tracked file."""
    runtime = tw.runtime_css_path()
    committed = tw.APP_DIR / "static" / "tailwind.min.css"

    assert runtime != committed, (
        "the runtime stylesheet is being written over the COMMITTED one — running the dev "
        "server in a checkout will silently dirty a tracked file and red-light ci/tailwind-fresh"
    )
    assert committed not in runtime.parents
    assert runtime.parent == tmp_path, "the runtime sheet belongs in CONFIG_DIR"


def test_runtime_path_follows_CONFIG_DIR(monkeypatch, tmp_path):
    """It is per-install state, so it lives wherever this install keeps its state."""
    other = tmp_path / "elsewhere"
    monkeypatch.setenv("CONFIG_DIR", str(other))
    sys.modules.pop("tailwind_rebuild", None)
    tw = importlib.import_module("tailwind_rebuild")
    assert tw.runtime_css_path() == other / "tailwind.min.css"


def test_runtime_path_falls_back_when_CONFIG_DIR_is_unset(monkeypatch):
    monkeypatch.delenv("CONFIG_DIR", raising=False)
    monkeypatch.delenv("SLOPSMITH_CONFIG_DIR", raising=False)
    sys.modules.pop("tailwind_rebuild", None)
    tw = importlib.import_module("tailwind_rebuild")
    p = tw.runtime_css_path()
    assert p.name == "tailwind.min.css"
    assert "static" not in p.parts, "must not fall back into the app's static/ dir"


def test_rebuild_never_touches_the_committed_file(tw, tmp_path, monkeypatch):
    """Belt and braces: drive rebuild() and assert the tracked file is byte-identical.

    This is the assertion that would actually have caught #911 in CI.
    """
    committed = tw.APP_DIR / "static" / "tailwind.min.css"
    before = committed.read_bytes() if committed.is_file() else None

    tw.rebuild("test")   # best-effort; may skip if node/tailwind is absent — that is fine

    after = committed.read_bytes() if committed.is_file() else None
    assert after == before, (
        "rebuild() modified the COMMITTED static/tailwind.min.css — this is #911: it dirties a "
        "tracked file in any git checkout and red-lights ci/tailwind-fresh"
    )


# ── Codex [P2]: a persisted sheet must not outlive its reason ──────────────────
#
# A runtime sheet can survive the thing that justified it and then MASK newer core CSS —
# possibly forever, because startup only rebuilds when user plugins exist and skips entirely
# when the toolchain is absent.

def _server(monkeypatch, tmp_path):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    for m in ("server", "tailwind_rebuild"):
        sys.modules.pop(m, None)
    return importlib.import_module("server")


def test_runtime_sheet_is_ignored_when_the_user_has_no_plugins(monkeypatch, tmp_path):
    """Remove your plugins and the committed sheet is authoritative again — it is complete by
    definition. A leftover runtime sheet would carry classes for plugins that are gone."""
    srv = _server(monkeypatch, tmp_path)
    (tmp_path / "tailwind.min.css").write_text("/* stale runtime sheet */")
    monkeypatch.setattr(srv.tailwind_rebuild, "user_plugin_count", lambda: 0)
    assert srv._runtime_css_if_usable() is None


def _stamp(srv, tmp_path, *, matching: bool):
    """Write the sidecar that records WHICH CORE the runtime sheet was built against."""
    import json
    h = srv.tailwind_rebuild._committed_css_fingerprint() if matching else "0" * 64
    # ask for the real path rather than hardcoding it — with_suffix('.meta.json') on
    # tailwind.min.css yields tailwind.min.meta.json, not tailwind.meta.json
    srv.tailwind_rebuild.runtime_meta_path().write_text(json.dumps({"committed_sha256": h}))


def test_runtime_sheet_is_ignored_when_it_was_built_against_a_DIFFERENT_core(monkeypatch, tmp_path):
    """An upgrade ships new core classes. A runtime sheet built against the OLD core would hide
    them — and with no Tailwind toolchain present, nothing would ever rebuild it.

    Freshness is decided by CONTENT, not mtime. Codex [P2] on the mtime version, and correct:
    archives and container images routinely PRESERVE SOURCE MTIMES, so a just-shipped stylesheet
    can carry an OLDER timestamp than a runtime sheet built days ago — and an mtime check would
    then call the stale one fresh, masking the new CSS forever.
    """
    srv = _server(monkeypatch, tmp_path)
    (tmp_path / "tailwind.min.css").write_text("/* built against the old core */")
    monkeypatch.setattr(srv.tailwind_rebuild, "user_plugin_count", lambda: 1)
    _stamp(srv, tmp_path, matching=False)

    assert srv._runtime_css_if_usable() is None, (
        "a runtime sheet built against a different core must not mask the shipped CSS"
    )


def test_runtime_sheet_is_ignored_when_it_has_no_stamp_at_all(monkeypatch, tmp_path):
    """A sheet from before this mechanism existed. Unknown provenance -> do not trust it."""
    srv = _server(monkeypatch, tmp_path)
    (tmp_path / "tailwind.min.css").write_text("/* no sidecar */")
    monkeypatch.setattr(srv.tailwind_rebuild, "user_plugin_count", lambda: 1)
    assert srv._runtime_css_if_usable() is None


def test_runtime_sheet_IS_used_when_it_matches_this_core_and_plugins_exist(monkeypatch, tmp_path):
    """The case it exists for."""
    srv = _server(monkeypatch, tmp_path)
    runtime = tmp_path / "tailwind.min.css"
    runtime.write_text("/* fresh, with plugin classes */")
    monkeypatch.setattr(srv.tailwind_rebuild, "user_plugin_count", lambda: 2)
    _stamp(srv, tmp_path, matching=True)

    assert srv._runtime_css_if_usable() == runtime
