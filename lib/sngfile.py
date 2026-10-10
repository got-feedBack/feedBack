"""Read Clone Hero / YARG ``.sng`` packages (a song folder in one masked file).

Layout (SngFileFormat, github.com/mdsitton/SngFileFormat, version 1, little endian):
  "SNGPKG" | uint32 version | 16-byte xor mask
  uint64 metadata_len | uint64 count | count x (int32 klen, key, int32 vlen, value)   - song.ini pairs
  uint64 filemeta_len | uint64 count | count x (uint8 nlen, name, uint64 size, uint64 offset)
  uint64 data_len | file data, each byte masked: b ^ mask[i % 16] ^ (i & 0xFF), i = index in its file
"""

from __future__ import annotations

import struct
from pathlib import Path

# Never unpack these: CH/YARG background videos are large and nothing here plays them.
_VIDEO_EXTS = (".mp4", ".webm", ".avi", ".mkv", ".vp8")


class SngError(ValueError):
    pass


class NeedMore(SngError):
    """The buffer ends inside the header; fetch at least ``need`` bytes."""

    def __init__(self, need):
        super().__init__(f"need {need} bytes")
        self.need = need


def parse_header(buf: bytes) -> tuple[dict, dict, int]:
    """(metadata incl. "mask", {filename: (offset, size)}, header_end) from the start of an .sng."""
    pos = 0

    def take(n):
        nonlocal pos
        if pos + n > len(buf):
            raise NeedMore(max(pos + n, 2 * len(buf)))
        b = buf[pos:pos + n]
        pos += n
        return b

    if take(6) != b"SNGPKG":
        raise SngError("not an SNG package")
    (version,) = struct.unpack("<I", take(4))
    if version != 1:
        raise SngError(f"unsupported SNG version {version}")
    mask = take(16)
    _, n = struct.unpack("<QQ", take(16))
    meta = {"mask": mask}
    for _ in range(n):
        (kl,) = struct.unpack("<i", take(4))
        k = take(kl).decode("utf-8", "replace")
        (vl,) = struct.unpack("<i", take(4))
        meta[k] = take(vl).decode("utf-8", "replace")
    _, n = struct.unpack("<QQ", take(16))
    files = {}
    for _ in range(n):
        (nl,) = struct.unpack("<B", take(1))
        name = take(nl).decode("utf-8", "replace")
        size, off = struct.unpack("<QQ", take(16))
        files[name] = (off, size)
    take(8)          # data length
    return meta, files, pos


def read_sng(path) -> tuple[dict, dict]:
    """(metadata incl. "mask", {filename: (offset, size)}) without reading file contents."""
    with open(path, "rb") as f:
        buf = f.read(65536)
        while True:
            try:
                meta, files, _ = parse_header(buf)
                return meta, files
            except NeedMore as e:
                f.seek(0)
                more = f.read(e.need)
                if len(more) <= len(buf):
                    raise SngError(f"{Path(path).name}: truncated header") from None
                buf = more


def unmask(data: bytes, mask: bytes) -> bytes:
    """Undo the per-file xor mask. The key stream repeats every 256 bytes
    (lcm of the 16-byte mask and the ``i & 0xFF`` counter), so xor the whole
    buffer against that period as one big integer instead of byte by byte."""
    if not data:
        return b""
    period = bytes(mask[i % 16] ^ i for i in range(256))
    key = (period * (len(data) // 256 + 1))[:len(data)]
    n = int.from_bytes(data, "little") ^ int.from_bytes(key, "little")
    return n.to_bytes(len(data), "little")


def extract_sng(path, out_dir, names=None) -> Path:
    """Unpack an .sng into a normal song folder (song.ini written from its metadata).
    ``names``: only these files; default everything but video."""
    meta, files = read_sng(path)
    mask = meta.pop("mask")
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    with open(path, "rb") as f:
        for name, (off, size) in files.items():
            if names is not None and name not in names:
                continue
            if names is None and Path(name).suffix.lower() in _VIDEO_EXTS:
                continue
            safe = Path(name.replace("\\", "/")).name      # no directories from the package
            if not safe or safe in (".", ".."):
                continue
            f.seek(off)
            (out / safe).write_bytes(unmask(f.read(size), mask))
    ini = "".join(f"{k} = {v}\n" for k, v in meta.items() if "\n" not in k + v)
    (out / "song.ini").write_text("[song]\n" + ini, encoding="utf-8")
    return out
