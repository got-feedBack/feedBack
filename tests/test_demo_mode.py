"""Tests for FEEDBACK_DEMO_MODE middleware.

Covers:
- Demo mode off: write routes pass through (middleware is a no-op).
- Demo mode on: selected entries from _DEMO_BLOCKED return 403 {"error": "demo mode: read-only"}.
- Demo mode on: first GET / sets the feedBack_demo_session cookie.
- Demo mode on: subsequent GET / (cookie already present) does not re-set it.
- Cookie secure flag: set when X-Forwarded-Proto indicates https, including comma-separated values.
- register_demo_janitor_hook: registered hooks are called by the janitor sweep.
- register_demo_janitor_hook: non-callables are rejected with TypeError.
- register_demo_janitor_hook: async (coroutine) functions are rejected with TypeError.
- register_demo_janitor_hook: callables with required arguments are rejected with TypeError.
- register_demo_janitor_hook: present in the plugin context dict passed to load_plugins.
"""

import importlib
import sys
import threading

import demo_mode
import pytest
from fastapi.testclient import TestClient


def _make_client(tmp_path, monkeypatch, *, demo: bool = False):
    """Return a (server_module, TestClient) pair isolated in tmp_path.

    The TestClient is returned open; caller is responsible for closing it.
    raise_server_exceptions defaults to True so unexpected server errors
    surface as test failures rather than silently passing status checks.
    FEEDBACK_SYNC_STARTUP=1 makes the plugin-loader run inline (no background
    thread spawned), consistent with tests/test_startup_status.py.  startup_scan
    and load_plugins are also stubbed to no-ops so background file-scan and
    plugin I/O are suppressed.
    """
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    if demo:
        monkeypatch.setenv("FEEDBACK_DEMO_MODE", "1")
    else:
        monkeypatch.delenv("FEEDBACK_DEMO_MODE", raising=False)
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    # Stub out background threads to keep tests fast and non-flaky.
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    monkeypatch.setattr(server, "load_plugins", lambda app, context, progress_cb=None, route_setup_fn=None: None)
    client = TestClient(server.app, raise_server_exceptions=True)
    return server, client


def _cleanup(server, client):
    client.close()
    # Stop the demo-mode janitor thread (if started) so daemon threads don't
    # accumulate across tests.
    demo_mode._DEMO_JANITOR_STOP.set()
    thread = demo_mode._DEMO_JANITOR_THREAD
    if thread is not None:
        thread.join(timeout=2)
    demo_mode._DEMO_JANITOR_STARTED = False
    demo_mode._DEMO_JANITOR_THREAD = None
    with demo_mode._DEMO_JANITOR_HOOKS_LOCK:
        demo_mode._DEMO_JANITOR_HOOKS.clear()
    conn = getattr(getattr(server, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


# ── Demo mode OFF: write routes are not blocked ───────────────────────────────

def test_demo_off_settings_post_not_blocked(tmp_path, monkeypatch):
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        r = client.post("/api/settings", json={"master_difficulty": 50})
        assert r.status_code == 200
    finally:
        _cleanup(server, client)


# ── Demo mode ON: blocked routes return 403 ───────────────────────────────────

@pytest.mark.parametrize("method,path", [
    ("POST",   "/api/settings"),
    ("POST",   "/api/settings/import"),
    ("POST",   "/api/rescan"),
    ("POST",   "/api/rescan/full"),
    ("POST",   "/api/favorites/toggle"),
    ("POST",   "/api/loops"),
    ("DELETE", "/api/loops/some-id"),
    ("POST",   "/api/audio-effects/mappings"),
    ("DELETE", "/api/audio-effects/mappings/some-id"),
    ("POST",   "/api/audio-effects/mappings/some-id/activate"),
    ("DELETE", "/api/audio-effects/active-mapping"),
    ("GET",    "/api/plugins/updates"),
    ("POST",   "/api/plugins/highway_3d/files"),
    ("DELETE", "/api/plugins/highway_3d/files"),
    # Enrichment (P8): review writes + the MusicBrainz search proxy (the
    # proxy would spend the shared rate limit for anonymous demo visitors).
    ("POST",   "/api/enrichment/review/some-file/accept"),
    ("POST",   "/api/enrichment/review/some-file/reject"),
    ("POST",   "/api/enrichment/review/some-file/pick"),
    ("POST",   "/api/enrichment/kick"),
    ("GET",    "/api/enrichment/search"),
    # Context menus (R2): per-song re-match + the path-exposing Get info.
    ("POST",   "/api/enrichment/refresh/some-file"),
    ("GET",    "/api/chart/some-file/fileinfo"),
    # Art layer (R3): the base64 upload writes files, the server-side URL fetch
    # touches the network, and the override delete removes files — all mutations.
    ("POST",   "/api/song/some-file/art/upload"),
    ("POST",   "/api/song/some-file/art/url"),
    ("DELETE", "/api/art/some-file/override"),
])
def test_demo_on_blocked_routes_return_403(tmp_path, monkeypatch, method, path):
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.request(method, path)
        assert r.status_code == 403
        assert r.json() == {"error": "demo mode: read-only"}
    finally:
        _cleanup(server, client)


def test_demo_on_read_routes_not_blocked(tmp_path, monkeypatch):
    """Safe read routes must still work in demo mode."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.get("/api/settings")
        assert r.status_code == 200
    finally:
        _cleanup(server, client)


# ── Demo cookie: set on first GET /, not on subsequent requests ───────────────

def test_demo_cookie_set_on_first_get_root(tmp_path, monkeypatch):
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.get("/")
        assert "feedBack_demo_session" in r.cookies
    finally:
        _cleanup(server, client)


def test_demo_cookie_not_reset_when_already_present(tmp_path, monkeypatch):
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        # First request sets the cookie.
        r1 = client.get("/")
        session_id = r1.cookies.get("feedBack_demo_session")
        assert session_id is not None

        # Second request (cookie already in jar) must not overwrite it.
        r2 = client.get("/", cookies={"feedBack_demo_session": session_id})
        # The Set-Cookie header for our cookie must be absent.
        set_cookie = r2.headers.get("set-cookie", "")
        assert "feedBack_demo_session" not in set_cookie
    finally:
        _cleanup(server, client)


def test_demo_cookie_not_set_in_non_demo_mode(tmp_path, monkeypatch):
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        r = client.get("/")
        assert "feedBack_demo_session" not in r.cookies
    finally:
        _cleanup(server, client)


# ── Cookie secure flag ────────────────────────────────────────────────────────

def test_demo_cookie_not_secure_over_http(tmp_path, monkeypatch):
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.get("/")
        set_cookie = r.headers.get("set-cookie", "")
        # The cookie must be present but without the Secure attribute.
        assert "feedBack_demo_session" in set_cookie
        assert "secure" not in set_cookie.lower()
    finally:
        _cleanup(server, client)


def test_demo_cookie_secure_over_https_via_forwarded_proto(tmp_path, monkeypatch):
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.get("/", headers={"x-forwarded-proto": "https"})
        set_cookie = r.headers.get("set-cookie", "")
        assert "feedBack_demo_session" in set_cookie
        assert "secure" in set_cookie.lower()
    finally:
        _cleanup(server, client)


def test_demo_cookie_secure_with_comma_separated_forwarded_proto(tmp_path, monkeypatch):
    """Proxies sometimes send 'https,http'; first value must win."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.get("/", headers={"x-forwarded-proto": "https,http"})
        set_cookie = r.headers.get("set-cookie", "")
        assert "feedBack_demo_session" in set_cookie
        assert "secure" in set_cookie.lower()
    finally:
        _cleanup(server, client)


def test_demo_cookie_not_secure_when_forwarded_proto_is_http(tmp_path, monkeypatch):
    """x-forwarded-proto: http must not trigger Secure."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.get("/", headers={"x-forwarded-proto": "http"})
        set_cookie = r.headers.get("set-cookie", "")
        assert "feedBack_demo_session" in set_cookie
        assert "secure" not in set_cookie.lower()
    finally:
        _cleanup(server, client)


# ── register_demo_janitor_hook ────────────────────────────────────────────────

def test_register_demo_janitor_hook_is_callable(tmp_path, monkeypatch):
    """register_demo_janitor_hook must exist and accept a callable."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        called = []
        demo_mode.register_demo_janitor_hook(lambda: called.append(1))
        # Manually invoke the registered hooks (simulating a janitor sweep).
        for hook in list(demo_mode._DEMO_JANITOR_HOOKS):
            hook()
        assert 1 in called
    finally:
        # Clean up our test hook so it doesn't leak into other tests.
        with demo_mode._DEMO_JANITOR_HOOKS_LOCK:
            demo_mode._DEMO_JANITOR_HOOKS.clear()
        _cleanup(server, client)


def test_register_demo_janitor_hook_rejects_non_callable(tmp_path, monkeypatch):
    """Passing a non-callable must raise TypeError immediately at registration."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        with pytest.raises(TypeError):
            demo_mode.register_demo_janitor_hook("not a function")
    finally:
        _cleanup(server, client)


def test_register_demo_janitor_hook_rejects_async_callable(tmp_path, monkeypatch):
    """Async functions must be rejected: the janitor cannot await coroutines."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        async def _async_hook():
            pass

        with pytest.raises(TypeError, match="async"):
            demo_mode.register_demo_janitor_hook(_async_hook)
    finally:
        _cleanup(server, client)


def test_register_demo_janitor_hook_rejects_non_zero_arg_callable(tmp_path, monkeypatch):
    """Callables with required arguments must be rejected at registration time."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        def _needs_arg(x):
            pass

        with pytest.raises(TypeError, match="zero-argument"):
            demo_mode.register_demo_janitor_hook(_needs_arg)
    finally:
        _cleanup(server, client)


def test_register_demo_janitor_hook_accepts_default_arg_callable(tmp_path, monkeypatch):
    """Callables with only default/optional arguments must be accepted."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        def _optional_arg(x=None):
            pass

        demo_mode.register_demo_janitor_hook(_optional_arg)
    finally:
        with demo_mode._DEMO_JANITOR_HOOKS_LOCK:
            demo_mode._DEMO_JANITOR_HOOKS.clear()
        _cleanup(server, client)


def test_register_demo_janitor_hook_in_plugin_context(tmp_path, monkeypatch):
    """register_demo_janitor_hook must be surfaced in the plugin context dict
    passed to load_plugins(), not just on the server module."""
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("FEEDBACK_DEMO_MODE", "1")
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    sys.modules.pop("server", None)
    server = importlib.import_module("server")

    captured: dict = {}

    def _capturing_load_plugins(app, context, **kw):
        captured.update(context)
        # Do NOT call the real loader — we only care that the context dict
        # contains the expected key; running the real loader would trigger pip
        # installs and filesystem scanning, making the test slow/flaky.
        return None

    monkeypatch.setattr(server, "load_plugins", _capturing_load_plugins)
    monkeypatch.setattr(server, "startup_scan", lambda: None)

    with TestClient(server.app):
        assert "register_demo_janitor_hook" in captured, (
            "register_demo_janitor_hook was not passed in the plugin context"
        )
        assert captured["register_demo_janitor_hook"] is demo_mode.register_demo_janitor_hook

    conn = getattr(getattr(server, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(__import__("sys").modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()
    # Clean up janitor state so it doesn't bleed into other tests.
    demo_mode._DEMO_JANITOR_STOP.set()
    thread = demo_mode._DEMO_JANITOR_THREAD
    if thread is not None:
        thread.join(timeout=2)
    demo_mode._DEMO_JANITOR_STARTED = False
    demo_mode._DEMO_JANITOR_THREAD = None
    with demo_mode._DEMO_JANITOR_HOOKS_LOCK:
        demo_mode._DEMO_JANITOR_HOOKS.clear()



@pytest.mark.parametrize("method,path", [
    ("POST", "/api/diagnostics/export"),
    ("GET",  "/api/diagnostics/preview"),
    ("GET",  "/api/diagnostics/hardware"),
])
def test_demo_on_diagnostics_routes_blocked(tmp_path, monkeypatch, method, path):
    """Diagnostics endpoints must return 403 in demo mode."""
    server, client = _make_client(tmp_path, monkeypatch, demo=True)
    try:
        r = client.request(method, path)
        assert r.status_code == 403
        assert r.json() == {"error": "demo mode: read-only"}
    finally:
        _cleanup(server, client)


def test_diag_normalize_include_string_false_treated_as_disabled(tmp_path, monkeypatch):
    """String 'false' must be treated as disabled, not truthy."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        result = server._diag_normalize_include({"logs": "false", "system": "true"})
        assert result["logs"] is False
        assert result["system"] is True
    finally:
        _cleanup(server, client)


def test_diag_normalize_include_string_zero_treated_as_disabled(tmp_path, monkeypatch):
    """String '0' must be treated as disabled."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        result = server._diag_normalize_include({"console": "0", "hardware": "1"})
        assert result["console"] is False
        assert result["hardware"] is True
    finally:
        _cleanup(server, client)


def test_diag_normalize_include_missing_keys_default_true(tmp_path, monkeypatch):
    """Missing keys must default to True so a bare {} request exports everything."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        result = server._diag_normalize_include({})
        for key in ("system", "hardware", "logs", "console", "plugins"):
            assert result[key] is True
    finally:
        _cleanup(server, client)


def test_diag_normalize_include_none_returns_all_true(tmp_path, monkeypatch):
    """None input must default to all-True."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        result = server._diag_normalize_include(None)
        for key in ("system", "hardware", "logs", "console", "plugins"):
            assert result[key] is True
    finally:
        _cleanup(server, client)


def test_diag_coerce_bool_string_false(tmp_path, monkeypatch):
    """_diag_coerce_bool must treat string 'false' as False so the export
    endpoint handles { "redact": "false" } correctly."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        assert server._diag_coerce_bool("false") is False
        assert server._diag_coerce_bool("False") is False
        assert server._diag_coerce_bool("0") is False
        assert server._diag_coerce_bool("no") is False
        assert server._diag_coerce_bool("") is False
    finally:
        _cleanup(server, client)


def test_diag_coerce_bool_truthy_values(tmp_path, monkeypatch):
    """_diag_coerce_bool must treat 'true', '1', True, and arbitrary objects
    as True."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        assert server._diag_coerce_bool(True) is True
        assert server._diag_coerce_bool("true") is True
        assert server._diag_coerce_bool("1") is True
        assert server._diag_coerce_bool("yes") is True
        assert server._diag_coerce_bool(1) is True
    finally:
        _cleanup(server, client)


def test_diag_coerce_bool_none_uses_default(tmp_path, monkeypatch):
    """_diag_coerce_bool(None) must return the supplied default."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        assert server._diag_coerce_bool(None, default=True) is True
        assert server._diag_coerce_bool(None, default=False) is False
    finally:
        _cleanup(server, client)


def test_diag_cap_console_truncates_to_limit(tmp_path, monkeypatch):
    """_diag_cap_console must return a list truncated to _DIAG_MAX_CONSOLE_ENTRIES."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        limit = server._DIAG_MAX_CONSOLE_ENTRIES
        big_list = [{"msg": f"entry {i}"} for i in range(limit + 100)]
        result = server._diag_cap_console(big_list)
        assert isinstance(result, list)
        assert len(result) == limit
        assert result[0] == {"msg": "entry 0"}
    finally:
        _cleanup(server, client)


def test_diag_cap_console_accepts_list_within_limit(tmp_path, monkeypatch):
    """_diag_cap_console must pass through a short list unchanged."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        short = [{"msg": "hi"}] * 5
        assert server._diag_cap_console(short) == short
    finally:
        _cleanup(server, client)


def test_diag_cap_console_rejects_non_list(tmp_path, monkeypatch):
    """_diag_cap_console must return None for non-list inputs."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        assert server._diag_cap_console("not a list") is None
        assert server._diag_cap_console({"a": 1}) is None
        assert server._diag_cap_console(None) is None
    finally:
        _cleanup(server, client)


def test_diag_cap_dict_rejects_oversized_payload(tmp_path, monkeypatch):
    """_diag_cap_dict must return None when the serialised dict exceeds the byte cap."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        limit = server._DIAG_MAX_CLIENT_PAYLOAD_BYTES
        # Build a dict whose JSON representation exceeds the cap.
        big_dict = {"k": "x" * (limit + 1)}
        assert server._diag_cap_dict(big_dict) is None
    finally:
        _cleanup(server, client)


def test_diag_cap_dict_accepts_dict_within_limit(tmp_path, monkeypatch):
    """_diag_cap_dict must pass through a small dict unchanged."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        small = {"renderer": "Intel Iris Xe", "vram_mb": 4096}
        assert server._diag_cap_dict(small) == small
    finally:
        _cleanup(server, client)


def test_diag_cap_dict_rejects_non_dict(tmp_path, monkeypatch):
    """_diag_cap_dict must return None for non-dict inputs."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        assert server._diag_cap_dict([1, 2, 3]) is None
        assert server._diag_cap_dict("string") is None
        assert server._diag_cap_dict(None) is None
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_drops_oversized_plugin(tmp_path, monkeypatch):
    """_diag_cap_contributions must drop only the oversized plugin, not others."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        limit = server._DIAG_MAX_CLIENT_PAYLOAD_BYTES
        big_payload = {"data": "x" * (limit + 1)}
        small_payload = {"active_preset": "rock"}
        result = server._diag_cap_contributions({
            "big_plugin": big_payload,
            "small_plugin": small_payload,
        })
        assert result is not None
        assert "big_plugin" not in result, "Oversized plugin must be dropped"
        assert result["small_plugin"] == small_payload
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_returns_none_for_non_dict(tmp_path, monkeypatch):
    """_diag_cap_contributions must return None for non-dict inputs."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        assert server._diag_cap_contributions(None) is None
        assert server._diag_cap_contributions([{"a": 1}]) is None
        assert server._diag_cap_contributions("string") is None
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_returns_none_when_all_dropped(tmp_path, monkeypatch):
    """_diag_cap_contributions must return None when every plugin is dropped."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        limit = server._DIAG_MAX_CLIENT_PAYLOAD_BYTES
        result = server._diag_cap_contributions({
            "p1": {"data": "x" * (limit + 1)},
            "p2": {"data": "y" * (limit + 1)},
        })
        assert result is None
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_passes_small_plugins_through(tmp_path, monkeypatch):
    """_diag_cap_contributions must pass through all plugins that fit."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        contribs = {"p1": {"x": 1}, "p2": {"y": 2}}
        result = server._diag_cap_contributions(contribs)
        assert result == contribs
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_filters_unknown_plugin_ids(tmp_path, monkeypatch):
    """_diag_cap_contributions must skip plugins not in known_ids before serialising."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        result = server._diag_cap_contributions(
            {"known_plugin": {"data": "ok"}, "unknown_plugin": {"data": "secret"}},
            known_ids={"known_plugin"},
        )
        assert result is not None
        assert "known_plugin" in result
        assert "unknown_plugin" not in result, "Unknown plugin must be dropped before serialisation"
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_known_ids_none_accepts_all(tmp_path, monkeypatch):
    """When known_ids is None, all plugins are accepted (no filter applied)."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        contribs = {"any_plugin": {"x": 1}, "another_plugin": {"y": 2}}
        result = server._diag_cap_contributions(contribs, known_ids=None)
        assert result == contribs
    finally:
        _cleanup(server, client)


def test_diag_cap_contributions_aggregate_cap_enforced(tmp_path, monkeypatch):
    """_diag_cap_contributions must stop accepting plugins once the aggregate byte
    budget is exhausted, rather than accepting all near-limit entries."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        # Each per-plugin payload is just under the per-plugin cap.
        per_limit = server._DIAG_MAX_CLIENT_PAYLOAD_BYTES
        agg_limit = server._DIAG_MAX_CONTRIBUTIONS_BYTES
        # payload that is slightly under per_limit but together fills agg_limit.
        # The contribution {"data": big} serialises to payload_size + 11 bytes
        # (the JSON envelope `{"data":"..."}` adds 11 bytes), so we need
        # payload_size <= per_limit - 11; use -100 for a safe margin.
        payload_size = per_limit - 100
        big = "x" * payload_size
        # How many plugins would exceed the aggregate limit?
        n_plugins = (agg_limit // payload_size) + 5
        contribs = {f"p{i}": {"data": big} for i in range(n_plugins)}
        result = server._diag_cap_contributions(contribs)
        # Result must be non-None (some plugins fit) but fewer than n_plugins.
        assert result is not None
        assert len(result) < n_plugins, (
            "Aggregate cap must prevent all near-limit plugins from being accepted"
        )
    finally:
        _cleanup(server, client)


def test_diag_cap_console_enforces_byte_cap(tmp_path, monkeypatch):
    """_diag_cap_console must stop accumulating entries once the byte budget is
    reached, even when the entry count is still below _DIAG_MAX_CONSOLE_ENTRIES."""
    server, client = _make_client(tmp_path, monkeypatch, demo=False)
    try:
        byte_limit = server._DIAG_MAX_CONSOLE_BYTES
        # Each entry is 1 KB; create enough to exceed the byte cap long before
        # the count cap kicks in.
        entry = {"level": "log", "msg": "x" * 1024}
        n = (byte_limit // 1024) + 100
        result = server._diag_cap_console([entry] * n)
        assert isinstance(result, list)
        assert len(result) < n, "Byte cap must truncate entries before count cap"
    finally:
        _cleanup(server, client)



# ── #902: the janitor re-entry guard ────────────────────────────────────────────
#
# The guard in startup_events() read:
#
#     if getenv_compat("FEEDBACK_DEMO_MODE") or getenv_compat("FEEDBACK_DEMO_MODE") == "1" \
#             and not _DEMO_JANITOR_STARTED:
#
# `and` binds tighter than `or`, so that is `A or (B and C)` — and the
# not-already-started half never runs when the env var is truthy, which is the only case
# that reaches it at all. A second startup started a SECOND janitor thread, overwrote the
# handle, and shutdown then joined only the last one: the first leaked and kept firing
# registered hooks hourly, forever.
#
# The guard now lives INSIDE start_janitor(), not at the call site — a caller cannot get
# operator precedence wrong if there is nothing for it to get wrong.

def _live_janitors():
    return [t for t in threading.enumerate() if t.name == "demo-janitor" and t.is_alive()]


def test_start_janitor_is_idempotent(monkeypatch):
    """Two starts must not produce two threads. This is the #902 regression."""
    monkeypatch.setattr(demo_mode, "_DEMO_JANITOR_STARTED", False)
    monkeypatch.setattr(demo_mode, "_DEMO_JANITOR_THREAD", None)
    before = len(_live_janitors())
    try:
        demo_mode.start_janitor()
        first = demo_mode._DEMO_JANITOR_THREAD
        demo_mode.start_janitor()          # <-- the second startup
        second = demo_mode._DEMO_JANITOR_THREAD

        assert first is second, (
            "a second start_janitor() replaced the thread handle — the first thread is now "
            "unreachable, will never be joined, and keeps running hooks forever (#902)"
        )
        assert len(_live_janitors()) == before + 1, (
            f"expected exactly one janitor thread, found {len(_live_janitors()) - before}"
        )
    finally:
        demo_mode.stop_janitor(timeout=2)


def test_a_second_startup_does_not_leak_a_janitor(monkeypatch):
    """The real shape of the bug: startup runs twice in one process."""
    monkeypatch.setenv("FEEDBACK_DEMO_MODE", "1")
    monkeypatch.setattr(demo_mode, "_DEMO_JANITOR_STARTED", False)
    monkeypatch.setattr(demo_mode, "_DEMO_JANITOR_THREAD", None)
    before = len(_live_janitors())
    try:
        for _ in range(3):
            if demo_mode.demo_mode_enabled():
                demo_mode.start_janitor()
        assert len(_live_janitors()) == before + 1, "a repeated startup leaked janitor threads"
    finally:
        demo_mode.stop_janitor(timeout=2)
        assert len(_live_janitors()) == before, "stop_janitor() did not join the thread"


def test_a_timed_out_stop_does_not_disable_the_janitor_forever(monkeypatch):
    """Codex [P2] on the first cut of the #902 fix.

    stop_janitor() deliberately leaves _DEMO_JANITOR_STARTED True when a hook outruns the
    join timeout, so a later startup can't spawn a second janitor beside a live one. But
    that hook usually finishes a moment later: the thread exits, and the flag stays true.

    A guard keyed on the FLAG would then refuse to start a replacement for the rest of the
    process — demo-mode cleanup silently dead. Guarding on the thread's LIVENESS is what
    makes both the double-start and the never-restart impossible.
    """
    before = len(_live_janitors())

    # Simulate the aftermath of a timed-out stop: flag still set, thread already gone.
    dead = threading.Thread(target=lambda: None, name="demo-janitor")
    dead.start()
    dead.join()
    assert not dead.is_alive()
    monkeypatch.setattr(demo_mode, "_DEMO_JANITOR_STARTED", True)
    monkeypatch.setattr(demo_mode, "_DEMO_JANITOR_THREAD", dead)

    try:
        demo_mode.start_janitor()
        assert len(_live_janitors()) == before + 1, (
            "no replacement janitor was started — a stale STARTED flag from a timed-out "
            "stop disabled demo-mode cleanup for the rest of the process"
        )
        assert demo_mode._DEMO_JANITOR_THREAD is not dead
    finally:
        demo_mode.stop_janitor(timeout=2)


def test_a_replacement_starts_while_a_doomed_janitor_is_still_finishing_a_hook(monkeypatch):
    """Codex [P2], second pass — the sharp window.

    stop_janitor() times out while a hook is still running. The old thread is ALIVE but
    DOOMED: its stop event is set, and it will exit the moment the hook returns. A guard
    that keys on liveness alone treats it as a running janitor, skips the replacement, and
    a second later there is no janitor at all.

    It also pins the reason each janitor owns its OWN stop event: the old code cleared a
    single SHARED Event on start, which would have RESURRECTED the doomed thread — it loops
    back to wait(), sees the flag cleared, and carries on. Two janitors, which is the bug we
    started from.
    """
    before = len(_live_janitors())

    # A janitor mid-hook: alive, and already told to stop.
    release = threading.Event()
    old_stop = threading.Event()

    def _stuck():
        release.wait(timeout=5)          # pretend we're inside a slow hook

    old = threading.Thread(target=_stuck, daemon=True, name="demo-janitor")
    old.start()
    old_stop.set()                       # stop_janitor() timed out and left this set
    monkeypatch.setattr(demo_mode, "_DEMO_JANITOR_STARTED", True)
    monkeypatch.setattr(demo_mode, "_DEMO_JANITOR_THREAD", old)
    monkeypatch.setattr(demo_mode, "_DEMO_JANITOR_STOP", old_stop)

    try:
        demo_mode.start_janitor()

        new = demo_mode._DEMO_JANITOR_THREAD
        assert new is not old, (
            "no replacement was started for a doomed janitor — once its hook returns the "
            "process is left with no janitor at all"
        )
        assert new.is_alive()

        # the old thread's own stop event must STILL be set: starting a replacement must not
        # resurrect it
        assert old_stop.is_set(), (
            "the doomed janitor's stop event was cleared — it would loop back around and "
            "keep running alongside the replacement. Two janitors."
        )
        assert demo_mode._DEMO_JANITOR_STOP is not old_stop, "the new janitor must own a fresh event"
    finally:
        release.set()
        old.join(timeout=5)
        demo_mode.stop_janitor(timeout=2)
        assert len(_live_janitors()) == before
