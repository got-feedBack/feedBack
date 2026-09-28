"""Baseline security headers on every response (security audit, issue #47).

No prior test exercised response headers at all — server.py had zero
defense-in-depth headers (X-Content-Type-Options, X-Frame-Options, CSP,
...) before this fix. Fixture mirrors test_version_endpoint.py's pattern
(fresh server import per test, background I/O suppressed).
"""

import importlib
import sys

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    with TestClient(server.app) as tc:
        try:
            yield tc
        finally:
            conn = getattr(getattr(server, "meta_db", None), "conn", None)
            if conn is not None:
                getattr(sys.modules.get("server"), "_join_background_db_threads", lambda: None)()
                conn.close()


def test_response_carries_baseline_security_headers(client):
    r = client.get("/api/version")
    assert r.status_code == 200
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
    assert "Content-Security-Policy" in r.headers


def test_csp_restricts_default_and_object_src(client):
    r = client.get("/api/version")
    csp = r.headers["Content-Security-Policy"]
    assert "default-src 'self'" in csp
    assert "object-src 'none'" in csp
    assert "frame-ancestors 'none'" in csp


def test_csp_blocks_non_https_script_origins_but_allows_self_and_https(client):
    r = client.get("/api/version")
    csp = r.headers["Content-Security-Policy"]
    script_src = next(part for part in csp.split(";") if part.strip().startswith("script-src"))
    assert "'self'" in script_src
    assert "https:" in script_src
    # No bare http:, data:, or wildcard scheme — those are common XSS/CSP-
    # bypass payload vectors this header exists to close off.
    assert "http:" not in script_src
    assert "data:" not in script_src
    assert "*" not in script_src


def test_csp_allows_self_and_blob_workers(client):
    # alphaTab (tabview/staffview) spawns its rendering worker from a blob:
    # URL. Without an explicit worker-src, CSP falls back to script-src,
    # which allows 'self'/https: but not blob: -- silently blocking the
    # worker and rendering a blank canvas (issue: worker-src missing after
    # the #44/#47 baseline-CSP addition).
    r = client.get("/api/version")
    csp = r.headers["Content-Security-Policy"]
    worker_src = next(part for part in csp.split(";") if part.strip().startswith("worker-src"))
    assert "'self'" in worker_src
    assert "blob:" in worker_src
    assert "http:" not in worker_src
    assert "data:" not in worker_src


def test_security_headers_present_on_error_responses_too(client):
    # A 404 (unknown route) must still carry the headers — they're set via
    # middleware wrapping the whole call_next chain, not per-route.
    r = client.get("/api/this-route-does-not-exist")
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert r.headers.get("X-Frame-Options") == "DENY"
    assert "Content-Security-Policy" in r.headers
