"""_unpack_zip() bounds a single sloppak's total DECOMPRESSED size during
extraction (security audit, issue #46) — independent of the unpack-cache
LRU eviction in test_sloppak_unpack_cache.py, which only bounds the
aggregate cache *after* an extraction finishes, not a single highly
compressed/corrupt archive currently being extracted.

The cap is checked against each zip member's *declared* size
(``ZipInfo.file_size``, read from the central directory) before any bytes
are decompressed, so a highly-compressed member with a huge declared size
is rejected immediately rather than after writing megabytes/gigabytes to
disk. Test members use real all-zero payloads (compress ~1000:1 with
zlib) rather than forged ZipInfo metadata, matching the actual shape of a
real zip bomb and keeping the test fast without needing to fake bytes on
disk.
"""

import zipfile

import pytest

import sloppak as sloppak_mod


def test_unpack_zip_rejects_when_declared_size_exceeds_cap(tmp_path, monkeypatch):
    monkeypatch.setenv("FEEDBACK_SLOPPAK_MAX_UNPACK_MB", "1")  # 1 MB cap
    zip_path = tmp_path / "bomb.sloppak"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # 2 MB of zeros compresses to a few KB — declared (uncompressed)
        # size honestly exceeds the 1 MB cap without a slow/large write.
        zf.writestr("stems/audio.ogg", b"\x00" * (2 * 1024 * 1024))

    dest = tmp_path / "unpacked"
    with pytest.raises(ValueError, match="decompressed-size"):
        sloppak_mod._unpack_zip(zip_path, dest)

    assert not dest.exists(), "a rejected extraction must not leave a partial directory behind"


def test_unpack_zip_allows_pack_under_the_cap(tmp_path, monkeypatch):
    monkeypatch.setenv("FEEDBACK_SLOPPAK_MAX_UNPACK_MB", "1")  # 1 MB cap
    zip_path = tmp_path / "small.sloppak"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("manifest.yaml", "title: small\n")
        zf.writestr("stems/audio.ogg", b"\x00" * 1024)  # 1 KB, well under the cap

    dest = tmp_path / "unpacked"
    sloppak_mod._unpack_zip(zip_path, dest)

    assert (dest / "manifest.yaml").exists()
    assert (dest / "stems" / "audio.ogg").read_bytes() == b"\x00" * 1024


def test_unpack_zip_cap_disabled_via_zero(tmp_path, monkeypatch):
    monkeypatch.setenv("FEEDBACK_SLOPPAK_MAX_UNPACK_MB", "0")
    zip_path = tmp_path / "huge_declared.sloppak"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        # Declared size far above the (now-disabled) 1 MB cap must not raise.
        zf.writestr("stems/audio.ogg", b"\x00" * (2 * 1024 * 1024))

    dest = tmp_path / "unpacked"
    sloppak_mod._unpack_zip(zip_path, dest)  # must not raise

    assert dest.exists()


def test_unpack_zip_default_cap_is_generous_for_a_real_pack(tmp_path, monkeypatch):
    """No env var set — the built-in default (8 GB) must not reject an
    ordinary small pack."""
    monkeypatch.delenv("FEEDBACK_SLOPPAK_MAX_UNPACK_MB", raising=False)
    zip_path = tmp_path / "normal.sloppak"
    with zipfile.ZipFile(zip_path, "w") as zf:
        zf.writestr("manifest.yaml", "title: normal\n")
        zf.writestr("stems/audio.ogg", b"\x00" * 4096)

    dest = tmp_path / "unpacked"
    sloppak_mod._unpack_zip(zip_path, dest)  # must not raise

    assert (dest / "manifest.yaml").exists()


def test_unpack_zip_cap_sums_across_multiple_members(tmp_path, monkeypatch):
    """Several members individually under the cap, but over it combined,
    must still be rejected — the check is a running total, not per-file."""
    monkeypatch.setenv("FEEDBACK_SLOPPAK_MAX_UNPACK_MB", "1")  # 1 MB cap
    zip_path = tmp_path / "many_members.sloppak"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for i in range(3):
            # ~683 KB each declared, x3 ≈ 2 MB > 1 MB cap, each individually under it.
            zf.writestr(f"stems/part{i}.ogg", b"\x00" * (700 * 1024))

    dest = tmp_path / "unpacked"
    with pytest.raises(ValueError, match="decompressed-size"):
        sloppak_mod._unpack_zip(zip_path, dest)

    assert not dest.exists()
