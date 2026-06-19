"""feedpak — open song-package format loader (canonical module name).

The format was renamed `sloppak` → `feedpak`. The implementation currently still
lives in :mod:`sloppak`; this module is the **canonical name going forward** and
re-exports that public API unchanged, so new code can do::

    import feedpak
    loaded = feedpak.load_song(filename, dlc_root, cache_root)

Both `.feedpak` and `.sloppak` packs are accepted everywhere (the legacy
extension and the `sloppak` module name are kept as permanent deprecated
aliases). The authoritative on-disk format spec is published at
https://github.com/got-feedback/feedback-feedpak-spec.

When the internal rename lands, the implementation can move into this module and
`sloppak.py` becomes the thin re-export shim instead — importers of `feedpak`
will not need to change.
"""

from __future__ import annotations

from sloppak import (  # noqa: F401  (re-export)
    PACK_SUFFIXES,
    LoadedFeedpak,
    LoadedSloppak,
    extract_meta,
    get_cached_source_dir,
    is_feedpak,
    is_pack,
    is_sloppak,
    load_manifest,
    load_song,
    read_feedpak_version,
    resolve_source_dir,
)

__all__ = [
    "PACK_SUFFIXES",
    "LoadedFeedpak",
    "LoadedSloppak",
    "extract_meta",
    "get_cached_source_dir",
    "is_feedpak",
    "is_pack",
    "is_sloppak",
    "load_manifest",
    "load_song",
    "read_feedpak_version",
    "resolve_source_dir",
]
