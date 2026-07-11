"""Reading the app's config.json — the one shared, pure helper (R3).

Extracted verbatim from server.py so route modules that need a config value
(reference pitch, server_config, …) can read it without reaching back into the
host file. server.py re-imports it, so its ~11 call sites and any
`server._load_config` test reference keep resolving unchanged.
"""

import json


def _load_config(config_file):
    """Read and parse config.json. Returns the parsed dict, or None if
    the file is missing, unreadable, invalid JSON, or parses to a
    non-dict (e.g. the file contains `[]` or `42`). Callers treat None
    as "fall back to defaults". Shared between GET and POST so both
    handle bad files the same way."""
    if not config_file.exists():
        return None
    try:
        # Explicit UTF-8: save_settings()/import write config.json as
        # UTF-8 bytes, so the read must not depend on the platform's
        # default text encoding (cp1252 on Windows would mojibake or
        # UnicodeDecodeError on a non-ASCII DLC path).
        parsed = json.loads(config_file.read_text(encoding="utf-8"))
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None
