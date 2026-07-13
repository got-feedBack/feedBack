"""The sloppak loader's handling of a pack's complete mixdown (#933).

The mixdown is a stem: feedpak spec §5.3 RESERVES the id `full` for it. It is a
mixdown, not a layer — it already contains every instrument, so a reader that
sums `stems` must never include it in that sum, and `load_song()` therefore
lifts it OUT of `LoadedSloppak.stems` and onto `LoadedSloppak.full_mix`.

Also covers the DEPRECATED `original_audio:` manifest key — a key this repo
invented (#583) before the spec reserved `full`, which every pack in the wild
still carries. We read it as a fallback so those packs keep their full mix; we
never write it. Those tests are the deprecation contract: they go when the key
does (#945).
"""

from __future__ import annotations

import json
from pathlib import Path

import yaml

import sloppak as sloppak_mod


def _write_dir_sloppak(
    root: Path,
    manifest_extras: dict,
    *,
    write_legacy_full_mix: bool = False,
    stems: list[dict] | None = None,
) -> Path:
    """Build a minimal directory-form sloppak that load_song will accept.

    Uses the tmp_path leaf name to make the sloppak filename unique per test,
    avoiding the module-level ``resolve_source_dir`` cache being poisoned by a
    previous test that happened to share the same "song.sloppak" filename.
    """
    pak = root / f"{root.name}.sloppak"
    pak.mkdir()
    arr_dir = pak / "arrangements"
    arr_dir.mkdir()

    arr = {
        "name": "Lead",
        "tuning": [0, 0, 0, 0, 0, 0],
        "capo": 0,
        "notes": [],
        "chords": [],
        "anchors": [],
        "handshapes": [],
        "templates": [],
        "beats": [],
        "sections": [],
    }
    (arr_dir / "lead.json").write_text(json.dumps(arr))

    manifest = {
        "title": "Test",
        "artist": "Tester",
        "album": "",
        "year": 2026,
        "duration": 10.0,
        "arrangements": [{"id": "lead", "name": "Lead", "file": "arrangements/lead.json"}],
        "stems": (
            stems
            if stems is not None
            else [{"id": "guitar", "file": "stems/guitar.ogg", "default": True}]
        ),
    }
    manifest.update(manifest_extras)
    (pak / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False))

    if write_legacy_full_mix:
        orig_dir = pak / "original"
        orig_dir.mkdir()
        # The loader only checks presence (is_file); contents are irrelevant.
        (orig_dir / "full.ogg").write_bytes(b"OggS-not-real")

    return pak


def _load(pak_path: Path, tmp_path: Path):
    dlc_root = pak_path.parent
    cache = tmp_path / "cache"
    cache.mkdir()
    return sloppak_mod.load_song(pak_path.name, dlc_root, cache)


def _separated(**extra) -> list[dict]:
    """A separated pack that RETAINS its mixdown, as spec §5.3 asks writers to."""
    return [
        {"id": "full", "file": "stems/full.ogg", "default": False, **extra},
        {"id": "guitar", "file": "stems/guitar.ogg", "default": True},
        {"id": "drums", "file": "stems/drums.ogg", "default": True},
    ]


# ── The `full` stem is the mixdown (spec §5.3) ───────────────────────────────

def test_full_stem_is_surfaced_as_the_mixdown(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {}, stems=_separated())
    loaded = _load(pak, tmp_path)
    # Manifest-relative, so the WS builds its URL exactly as it builds a stem's.
    assert loaded.full_mix == "stems/full.ogg"


def test_full_stem_is_removed_from_the_stem_list(tmp_path: Path):
    """The regression this whole change exists to prevent.

    Every consumer sums `stems` into one mix and renders one fader per entry. The
    mixdown already contains every instrument, so leaving it in the list doubles
    the entire song — and muting `guitar` would still leave guitar audible inside
    it. That exact trap is why the packer invented `original_audio` rather than
    putting the mixdown where the format says it goes.
    """
    pak = _write_dir_sloppak(tmp_path, {}, stems=_separated())
    loaded = _load(pak, tmp_path)
    assert [s["id"] for s in loaded.stems] == ["guitar", "drums"]


def test_single_mix_pack_keeps_full_as_its_only_stem(tmp_path: Path):
    """A pack whose ONLY stem is `full` is a single-mix pack, not a separated one.

    There are no instruments to be pristine against, so the mixdown stays the sole
    playable stem and nothing is surfaced separately. Anything else would strip the
    stem list of the most common pack shape in the library and leave it silent.
    """
    pak = _write_dir_sloppak(
        tmp_path, {}, stems=[{"id": "full", "file": "stems/full.ogg", "default": True}]
    )
    loaded = _load(pak, tmp_path)
    assert loaded.full_mix is None
    assert [s["id"] for s in loaded.stems] == ["full"]


def test_every_full_entry_is_removed_not_just_the_first(tmp_path: Path):
    """A malformed pack listing `full` twice must not leave one behind.

    Removing the mixdown by object identity would drop only the entry we surface
    and leave its duplicate in the stem list — a whole copy of the song, summed
    with the instruments. That is the exact bug this partition prevents, so a
    duplicate must not smuggle it back in.
    """
    pak = _write_dir_sloppak(
        tmp_path,
        {},
        stems=[
            {"id": "full", "file": "stems/full.ogg", "default": False},
            {"id": "guitar", "file": "stems/guitar.ogg", "default": True},
            {"id": "full", "file": "original/full.ogg", "default": True},
        ],
    )
    loaded = _load(pak, tmp_path)
    assert loaded.full_mix == "stems/full.ogg"
    assert [s["id"] for s in loaded.stems] == ["guitar"]


def test_separated_pack_without_a_full_stem_has_no_mixdown(tmp_path: Path):
    """Stems only, mixdown discarded — the pre-1.15.0 shape. Nothing to surface."""
    pak = _write_dir_sloppak(
        tmp_path,
        {},
        stems=[
            {"id": "guitar", "file": "stems/guitar.ogg", "default": True},
            {"id": "drums", "file": "stems/drums.ogg", "default": True},
        ],
    )
    loaded = _load(pak, tmp_path)
    assert loaded.full_mix is None
    assert [s["id"] for s in loaded.stems] == ["guitar", "drums"]


def test_single_mix_pack_ignores_a_lingering_deprecated_key(tmp_path: Path):
    """`full` is the pack's only stem AND the old key is still there.

    The stem wins, and it stays the sole playable stem — falling back to the key
    would surface the mixdown twice: once as the stem the player is already
    playing, and once as a "pristine" track for it to cross over to.
    """
    pak = _write_dir_sloppak(
        tmp_path,
        {"original_audio": "original/full.ogg"},
        stems=[{"id": "full", "file": "stems/full.ogg", "default": True}],
        write_legacy_full_mix=True,
    )
    loaded = _load(pak, tmp_path)
    assert loaded.full_mix is None
    assert [s["id"] for s in loaded.stems] == ["full"]


def test_full_stem_wins_over_the_deprecated_key(tmp_path: Path):
    """A migrated pack that still carries the old key must use the stem."""
    pak = _write_dir_sloppak(
        tmp_path,
        {"original_audio": "original/full.ogg"},
        stems=_separated(),
        write_legacy_full_mix=True,
    )
    loaded = _load(pak, tmp_path)
    assert loaded.full_mix == "stems/full.ogg"


# ── The library index must not advertise the mixdown as an instrument ────────

def test_extract_meta_excludes_the_mixdown_from_stem_ids(tmp_path: Path):
    """The library's stem chips / stem_count come from here, and must agree with
    load_song() — otherwise the filter offers a "full" chip beside guitar+drums
    and counts a third stem that no mixer will ever show."""
    pak = _write_dir_sloppak(tmp_path, {}, stems=_separated())
    meta = sloppak_mod.extract_meta(pak)
    assert meta["stem_ids"] == ["guitar", "drums"]
    assert meta["stem_count"] == 2


def test_extract_meta_keeps_full_for_a_single_mix_pack(tmp_path: Path):
    pak = _write_dir_sloppak(
        tmp_path, {}, stems=[{"id": "full", "file": "stems/full.ogg", "default": True}]
    )
    meta = sloppak_mod.extract_meta(pak)
    assert meta["stem_ids"] == ["full"]
    assert meta["stem_count"] == 1


# ── DEPRECATED `original_audio:` fallback — delete with the key (#945) ───────

def test_legacy_key_still_provides_the_full_mix(tmp_path: Path):
    """Every pack written before the spec reserved `full` looks like this. Dropping
    the read would silently take the pristine mix away from all of them."""
    pak = _write_dir_sloppak(
        tmp_path, {"original_audio": "original/full.ogg"}, write_legacy_full_mix=True
    )
    loaded = _load(pak, tmp_path)
    assert loaded.full_mix == "original/full.ogg"
    # The legacy mixdown lives OUTSIDE `stems`, so the stem list is untouched.
    assert [s["id"] for s in loaded.stems] == ["guitar"]


def test_legacy_key_absent_means_no_full_mix(tmp_path: Path):
    pak = _write_dir_sloppak(tmp_path, {}, write_legacy_full_mix=True)
    loaded = _load(pak, tmp_path)
    assert loaded.full_mix is None


def test_legacy_key_none_when_file_missing(tmp_path: Path):
    # Manifest points at a full mix that isn't on disk — disabled silently.
    pak = _write_dir_sloppak(
        tmp_path, {"original_audio": "original/full.ogg"}, write_legacy_full_mix=False
    )
    loaded = _load(pak, tmp_path)
    assert loaded.full_mix is None


def test_legacy_key_none_when_value_blank(tmp_path: Path):
    pak = _write_dir_sloppak(
        tmp_path, {"original_audio": "   "}, write_legacy_full_mix=True
    )
    loaded = _load(pak, tmp_path)
    assert loaded.full_mix is None


# ── Security / path-traversal branches (legacy key only — a stem `file` is
#    resolved through the same /api/sloppak/.../file/ guard as every other stem)

def test_legacy_key_none_when_path_escapes_sloppak(tmp_path: Path):
    pak = _write_dir_sloppak(
        tmp_path, {"original_audio": "../outside.ogg"}, write_legacy_full_mix=True
    )
    loaded = _load(pak, tmp_path)
    assert loaded.full_mix is None


def test_legacy_key_none_when_path_is_absolute(tmp_path: Path):
    pak = _write_dir_sloppak(
        tmp_path, {"original_audio": "/etc/passwd"}, write_legacy_full_mix=True
    )
    loaded = _load(pak, tmp_path)
    assert loaded.full_mix is None
