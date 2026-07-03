"""Tests for one-time builtin starter-content seeding into DLC."""

from __future__ import annotations

import importlib
import sys

import pytest


@pytest.fixture()
def server_mod(tmp_path, monkeypatch, isolate_logging):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    (tmp_path / "config").mkdir()
    monkeypatch.delenv("DLC_DIR", raising=False)
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    yield mod


def _source(server_mod):
    return (
        server_mod._feedBack_server_root()
        / server_mod._BUILTIN_STARTER_SOURCES[0][1]
    )


def _dest(server_mod, dlc):
    return (
        dlc
        / server_mod._BUILTIN_STARTER_SUBDIR
        / server_mod._BUILTIN_STARTER_SOURCES[0][0]
    )


def test_seed_creates_starter_content_and_marker(tmp_path, server_mod):
    """First run copies the bundled feedpak into starter/ and writes the marker."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"starter source not present in checkout: {source}")

    server_mod._seed_builtin_starter_content(dlc)

    dest = _dest(server_mod, dlc)
    assert dest.is_file()
    assert dest.stat().st_size == source.stat().st_size
    assert (server_mod.CONFIG_DIR / server_mod._STARTER_SEED_MARKER).is_file()


def test_seed_preserves_source_mtime(tmp_path, server_mod):
    """The seeded pack keeps the bundle's mtime so the diagnostic refresh check
    (source newer than dest -> update) stays correct across both write paths."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"starter source not present in checkout: {source}")

    server_mod._seed_builtin_starter_content(dlc)

    assert _dest(server_mod, dlc).stat().st_mtime_ns == source.stat().st_mtime_ns


def test_starter_is_not_carved_out_of_the_library():
    """`starter/` must NOT collide with the diagnostics/tutorials carve-out —
    otherwise seeded songs would never appear in the library listing."""
    assert "starter" not in {"diagnostics-builtin", "tutorials-builtin"}


def test_seed_runs_only_once_and_respects_deletion(tmp_path, server_mod):
    """After the first seed, deleting the song does NOT bring it back: the
    marker makes starter seeding a one-time welcome."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"starter source not present in checkout: {source}")

    server_mod._seed_builtin_starter_content(dlc)
    dest = _dest(server_mod, dlc)
    assert dest.is_file()

    # User removes the starter song.
    dest.unlink()

    # A subsequent launch must not re-seed it.
    server_mod._seed_builtin_starter_content(dlc)
    assert not dest.exists()


def test_seed_deferred_until_dlc_configured(tmp_path, server_mod):
    """With no DLC folder, seeding is skipped WITHOUT writing the marker, so it
    retries once a library folder exists."""
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"starter source not present in checkout: {source}")

    # dlc is None and DLC_DIR unset -> _get_dlc_dir() returns None.
    server_mod._seed_builtin_starter_content(None)
    assert not (server_mod.CONFIG_DIR / server_mod._STARTER_SEED_MARKER).exists()

    # Now a DLC is configured: the deferred seed runs.
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    server_mod._seed_builtin_starter_content(dlc)
    assert _dest(server_mod, dlc).is_file()
    assert (server_mod.CONFIG_DIR / server_mod._STARTER_SEED_MARKER).is_file()


def test_seed_refuses_symlinked_seed_directory(tmp_path, server_mod):
    """A symlinked starter/ dir is refused so copies can't escape the DLC tree."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"starter source not present in checkout: {source}")

    outside_dir = tmp_path / "outside"
    outside_dir.mkdir()
    (dlc / server_mod._BUILTIN_STARTER_SUBDIR).symlink_to(outside_dir)

    server_mod._seed_builtin_starter_content(dlc)

    assert list(outside_dir.iterdir()) == []
    # An incomplete seed must NOT write the marker, so a later launch retries.
    assert not (server_mod.CONFIG_DIR / server_mod._STARTER_SEED_MARKER).exists()


def test_seed_never_overwrites_an_existing_user_file(tmp_path, server_mod):
    """One-time starter seeding must never replace a user's own file at the
    destination, even if the bundled pack has a newer mtime."""
    import os as _os

    dlc = tmp_path / "dlc"
    dlc.mkdir()
    dest = _dest(server_mod, dlc)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(b"user's own edited pack")
    _os.utime(dest, (1_000_000, 1_000_000))  # far older than the bundled source

    server_mod._seed_builtin_starter_content(dlc)

    assert dest.read_bytes() == b"user's own edited pack"  # untouched
    # counted as already-present, so the one-time seed considers itself done
    assert (server_mod.CONFIG_DIR / server_mod._STARTER_SEED_MARKER).is_file()


def test_seed_does_not_mark_when_destination_is_a_directory(tmp_path, server_mod):
    """A directory sitting at the destination name is neither clobbered nor
    counted as present, so the marker stays unwritten and seeding retries."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    source = _source(server_mod)
    if not source.is_file():
        pytest.skip(f"starter source not present in checkout: {source}")

    bogus = _dest(server_mod, dlc)
    bogus.parent.mkdir(parents=True, exist_ok=True)
    bogus.mkdir()  # user (or junk) placed a directory where the pack goes

    server_mod._seed_builtin_starter_content(dlc)

    assert bogus.is_dir()  # untouched
    assert not (server_mod.CONFIG_DIR / server_mod._STARTER_SEED_MARKER).exists()


def test_seed_does_not_mark_when_source_missing(tmp_path, server_mod, monkeypatch):
    """If a starter source can't be found, the marker stays unwritten and the
    seed is retried on the next launch (rather than permanently skipped)."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    monkeypatch.setattr(
        server_mod,
        "_BUILTIN_STARTER_SOURCES",
        [("missing.feedpak", "content/starter/does-not-exist.feedpak")],
    )

    server_mod._seed_builtin_starter_content(dlc)

    assert not (dlc / server_mod._BUILTIN_STARTER_SUBDIR / "missing.feedpak").exists()
    assert not (server_mod.CONFIG_DIR / server_mod._STARTER_SEED_MARKER).exists()
