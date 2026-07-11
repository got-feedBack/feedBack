"""Tests for GET /api/audio-local-path — URL validation and path traversal safety."""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client_and_server(tmp_path, monkeypatch):
    """Loopback TestClient — simulates the Electron desktop calling from 127.0.0.1.

    FEEDBACK_SYNC_STARTUP=1 prevents background scan/plugin threads from
    spawning and leaking into other tests.  load_plugins and startup_scan are
    stubbed to no-ops so startup completes instantly.
    """
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    # Redirect STATIC_DIR to a temp directory so no real checkout files are touched
    static_tmp = tmp_path / "static"
    static_tmp.mkdir()
    monkeypatch.setattr(server, "STATIC_DIR", static_tmp)
    monkeypatch.setattr(server.appstate, "static_dir", static_tmp)
    # Pass client=("127.0.0.1", 50000) so request.client.host is a loopback address
    test_client = TestClient(server.app, client=("127.0.0.1", 50000))
    try:
        yield test_client, server
    finally:
        test_client.close()
        meta_db = getattr(server, "meta_db", None)
        conn = getattr(meta_db, "conn", None)
        if conn is not None:
            getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()


@pytest.fixture()
def non_loopback_client(tmp_path, monkeypatch):
    """Non-loopback TestClient — default 'testclient' host simulates an external caller.

    FEEDBACK_SYNC_STARTUP=1 prevents background scan/plugin threads from
    spawning and leaking into other tests.  load_plugins and startup_scan are
    stubbed to no-ops so startup completes instantly.
    """
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    # Default client=("testclient", 50000) is not a loopback address
    test_client = TestClient(server.app)
    try:
        yield test_client
    finally:
        test_client.close()
        meta_db = getattr(server, "meta_db", None)
        conn = getattr(meta_db, "conn", None)
        if conn is not None:
            getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()


# ── happy path ────────────────────────────────────────────────────────────────

def test_resolves_file_in_audio_cache(client_and_server, tmp_path):
    client, server = client_and_server
    audio_file = server.AUDIO_CACHE_DIR / "audio_abc123.ogg"
    audio_file.parent.mkdir(parents=True, exist_ok=True)
    audio_file.touch()
    r = client.get("/api/audio-local-path", params={"url": "/audio/audio_abc123.ogg"})
    assert r.status_code == 200
    assert r.json()["path"] == str(audio_file.resolve())


def test_resolves_file_in_static_dir(client_and_server, tmp_path):
    client, server = client_and_server
    # STATIC_DIR is monkeypatched to tmp_path/static — write there, not the checkout
    audio_file = server.STATIC_DIR / "audio_static_test.ogg"
    audio_file.touch()
    r = client.get("/api/audio-local-path", params={"url": "/audio/audio_static_test.ogg"})
    assert r.status_code == 200
    assert r.json()["path"] == str(audio_file.resolve())


def test_returns_directory_as_404(client_and_server, tmp_path):
    """Directories must not be returned even if they exist inside the base dir."""
    client, server = client_and_server
    subdir = server.AUDIO_CACHE_DIR / "not_a_file"
    subdir.mkdir(parents=True, exist_ok=True)
    r = client.get("/api/audio-local-path", params={"url": "/audio/not_a_file"})
    assert r.status_code == 404


def test_returns_404_for_nonexistent_file(client_and_server):
    client, _ = client_and_server
    r = client.get("/api/audio-local-path", params={"url": "/audio/does_not_exist.ogg"})
    assert r.status_code == 404
    assert "error" in r.json()


# ── sloppak URLs (feedpak full-mix, desktop exclusive-mode routing) ──────────

@pytest.fixture()
def dlc_client(tmp_path, monkeypatch):
    """Loopback TestClient with a temp DLC_DIR for sloppak resolution."""
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    monkeypatch.setenv("DLC_DIR", str(dlc))
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "cfg"))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    # Module-level sloppak source-dir cache survives re-import; clear it so a
    # prior test's filename key can't shadow this test's temp DLC_DIR.
    server.sloppak_mod._source_cache.clear()
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    static_tmp = tmp_path / "static"
    static_tmp.mkdir()
    monkeypatch.setattr(server, "STATIC_DIR", static_tmp)
    monkeypatch.setattr(server.appstate, "static_dir", static_tmp)
    tc = TestClient(server.app, client=("127.0.0.1", 50000))
    try:
        yield tc, server, dlc
    finally:
        tc.close()
        meta_db = getattr(server, "meta_db", None)
        conn = getattr(meta_db, "conn", None)
        if conn is not None:
            getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
            conn.close()


def _make_sloppak(dlc, name="song.sloppak"):
    """Create a minimal directory-form sloppak with a full-mix file."""
    pak = dlc / name
    (pak / "stems").mkdir(parents=True)
    (pak / "stems" / "full.ogg").write_bytes(b"OggS-fake")
    return pak


def test_sloppak_url_resolves_to_local_path(dlc_client):
    tc, _server, dlc = dlc_client
    pak = _make_sloppak(dlc)
    r = tc.get(
        "/api/audio-local-path",
        params={"url": "/api/sloppak/song.sloppak/file/stems/full.ogg"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["path"] == str((pak / "stems" / "full.ogg").resolve())


def test_sloppak_url_percent_encoded_segments_decode(dlc_client):
    tc, _server, dlc = dlc_client
    _make_sloppak(dlc, name="My Song.sloppak")
    r = tc.get(
        "/api/audio-local-path",
        params={"url": "/api/sloppak/My%20Song.sloppak/file/stems/full.ogg"},
    )
    assert r.status_code == 200, r.text


def test_sloppak_url_rel_traversal_is_403(dlc_client):
    tc, _server, dlc = dlc_client
    _make_sloppak(dlc)
    (dlc / "secret.txt").write_text("top secret")
    r = tc.get(
        "/api/audio-local-path",
        params={"url": "/api/sloppak/song.sloppak/file/..%2Fsecret.txt"},
    )
    assert r.status_code == 403, r.text


def test_sloppak_url_filename_traversal_is_403(dlc_client):
    tc, _server, _dlc = dlc_client
    r = tc.get(
        "/api/audio-local-path",
        params={"url": "/api/sloppak/..%2F..%2F..%2Fetc/file/passwd"},
    )
    assert r.status_code == 403, r.text


def test_sloppak_url_without_dlc_configured_is_404(client_and_server):
    """No DLC_DIR in the base fixture — resolver reports 'not configured'."""
    client, _ = client_and_server
    r = client.get(
        "/api/audio-local-path",
        params={"url": "/api/sloppak/mysong/file/stems/full.ogg"},
    )
    assert r.status_code == 404


# ── rejected non-/audio/ inputs ───────────────────────────────────────────────


def test_rejects_empty_url(client_and_server):
    client, _ = client_and_server
    r = client.get("/api/audio-local-path", params={"url": ""})
    assert r.status_code == 400


def test_rejects_url_with_scheme(client_and_server):
    client, _ = client_and_server
    r = client.get("/api/audio-local-path", params={"url": "http://evil.example.com/audio/x.ogg"})
    assert r.status_code == 400


# ── traversal / escape attempts ───────────────────────────────────────────────

def test_rejects_dotdot_traversal(client_and_server):
    client, _ = client_and_server
    r = client.get("/api/audio-local-path", params={"url": "/audio/../etc/passwd"})
    assert r.status_code == 400


def test_rejects_double_slash_absolute_component(client_and_server):
    client, _ = client_and_server
    # /audio//etc/passwd — the empty component after /audio/ becomes an absolute path join
    r = client.get("/api/audio-local-path", params={"url": "/audio//etc/passwd"})
    assert r.status_code == 400


def test_rejects_backslash_in_filename(client_and_server):
    client, _ = client_and_server
    r = client.get("/api/audio-local-path", params={"url": "/audio/foo\\bar.ogg"})
    assert r.status_code == 400


def test_rejects_url_with_query(client_and_server):
    client, _ = client_and_server
    r = client.get("/api/audio-local-path", params={"url": "/audio/x.ogg?foo=bar"})
    assert r.status_code == 400


def test_rejects_url_with_fragment(client_and_server):
    client, _ = client_and_server
    r = client.get("/api/audio-local-path", params={"url": "/audio/x.ogg#foo"})
    assert r.status_code == 400


# ── loopback restriction ──────────────────────────────────────────────────────

def test_rejects_non_loopback_client(non_loopback_client):
    """Non-loopback clients must receive 403."""
    r = non_loopback_client.get("/api/audio-local-path", params={"url": "/audio/x.ogg"})
    assert r.status_code == 403


# ── serve_audio traversal protection ─────────────────────────────────────────

def test_serve_audio_dotdot_traversal_is_rejected(client_and_server):
    """GET /audio/../<path> must not escape the base directories."""
    client, _ = client_and_server
    r = client.get("/audio/../etc/passwd")
    assert r.status_code == 404


def test_serve_audio_valid_file_is_served(client_and_server, tmp_path):
    """GET /audio/<file> serves a file that exists in AUDIO_CACHE_DIR."""
    client, server = client_and_server
    audio_file = server.AUDIO_CACHE_DIR / "audio_serve_test.ogg"
    audio_file.parent.mkdir(parents=True, exist_ok=True)
    audio_file.touch()
    r = client.get("/audio/audio_serve_test.ogg")
    assert r.status_code == 200
