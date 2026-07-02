"""JSONC support — JSON with C-style comments.

Per feedpak-spec §8: when a manifest pointer resolves to a ``.jsonc`` file, a
Reader MUST strip ``//`` line comments and ``/* */`` block comments before
parsing the JSON content. This module implements that stripping in a single
shared place so every sloppak/feedpak reader in this repo parses ``.jsonc``
the same way (string-aware so comment-like text inside JSON strings survives).

The regex mirrors the reference implementation in ``feedpak-spec/tools/validate.py``.
``load_json(path)`` auto-detects ``.jsonc`` by suffix; plain ``.json`` (and any
other extension) goes straight through ``json.loads``. Use it as a drop-in
replacement for ``json.loads(path.read_text(encoding="utf-8"))``.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

# Match JSON string literals (preserved), // line comments, and /* block */
# comments. A single combined alternation processed by `sub` with a callback
# that keeps strings and replaces comments with the empty string — so
# comment-like text inside a string literal is never stripped.
_JSONC_STRIP_RE = re.compile(
    r'"(?:[^"\\]|\\.)*"|'   # string literal — keep as-is
    r'//.*|'                 # // line comment — strip
    r'/\*[\s\S]*?\*/',       # /* block comment */ — strip
)


def parse_jsonc(text: str) -> object:
    """Parse a JSONC string, stripping C-style comments before JSON parsing.

    Handles ``//`` line comments and ``/* */`` block comments, respecting
    string boundaries so that comment-like text inside strings is preserved.
    Raises ``json.JSONDecodeError`` on malformed JSON (after stripping).
    """
    stripped = _JSONC_STRIP_RE.sub(
        lambda m: m.group(0) if m.group(0).startswith('"') else '',
        text,
    )
    return json.loads(stripped)


def load_json(path: Path) -> object:
    """Read and parse a JSON/JSONC file by path.

    Files ending in ``.jsonc`` are stripped of comments via :func:`parse_jsonc`;
    all other files are parsed as plain JSON. UTF-8 encoded, matching every
    other reader in this repo.
    """
    raw = path.read_text(encoding="utf-8")
    if path.name.lower().endswith(".jsonc"):
        return parse_jsonc(raw)
    return json.loads(raw)
