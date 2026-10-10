"""Synthetic Clone Hero / YARG charts and packages for the drum-chart import tests."""

from __future__ import annotations

import struct
from pathlib import Path

TPQ = 480

# Stand-in OGG bytes: the converters copy single .ogg stems verbatim, so the
# tests never need ffmpeg or real audio.
FAKE_OGG = b"OggS\x00fake-audio"


def write_mid(path: Path, notes, *, tempos=((0, 120.0),), sigs=((0, 4, 4),), texts=(), sections=(),
              tpq: int = TPQ, track_name: str = "PART DRUMS"):
    """notes: (tick, midi_note, velocity, length_ticks); texts: (tick, text) in the drum track;
    sections: (tick, name) -> EVENTS "[section name]"."""
    import mido
    mid = mido.MidiFile(type=1, ticks_per_beat=tpq)

    def track(name, events):
        tr = mido.MidiTrack()
        tr.append(mido.MetaMessage("track_name", name=name, time=0))
        last = 0
        for tick, _order, msg in sorted(events, key=lambda e: (e[0], e[1])):
            msg.time = tick - last
            last = tick
            tr.append(msg)
        tr.append(mido.MetaMessage("end_of_track", time=0))
        mid.tracks.append(tr)

    sync = [(t, 0, mido.MetaMessage("set_tempo", tempo=int(round(60_000_000 / bpm)))) for t, bpm in tempos]
    sync += [(t, 0, mido.MetaMessage("time_signature", numerator=n, denominator=d)) for t, n, d in sigs]
    track("sync", sync)
    track("EVENTS", [(t, 0, mido.MetaMessage("text", text=f"[section {n}]")) for t, n in sections])
    ev = [(t, 0, mido.MetaMessage("text", text=x)) for t, x in texts]
    for tick, note, vel, length in notes:
        ev.append((tick, 2, mido.Message("note_on", note=note, velocity=vel, channel=0)))
        ev.append((tick + max(1, length), 1, mido.Message("note_off", note=note, velocity=0, channel=0)))
    track(track_name, ev)
    mid.save(str(path))
    return path


def write_chart(path: Path, lines, *, resolution=192, tempos=((0, 120.0),), sigs=((0, 4),), offset=None,
                events=(), name="Song", artist="Band"):
    """lines: (tick, 'N'|'S'|'E', a, b) entries for [ExpertDrums]."""
    song = [f'  Name = "{name}"', f'  Artist = "{artist}"', f"  Resolution = {resolution}"]
    if offset is not None:
        song.append(f"  Offset = {offset}")
    sync = [f"  {t} = TS {n}" for t, n in sigs] + [f"  {t} = B {int(round(b * 1000))}" for t, b in tempos]
    sync.sort(key=lambda s: int(s.split("=")[0]))
    ev = [f'  {t} = E "section {n}"' for t, n in events]
    drums = []
    for item in sorted(lines, key=lambda x: (x[0], x[1])):
        t, kind = item[0], item[1]
        if kind in ("N", "S"):
            drums.append(f"  {t} = {kind} {item[2]} {item[3]}")
        else:
            drums.append(f"  {t} = E {item[2]}")
    body = ["[Song]", "{", *song, "}", "[SyncTrack]", "{", *sync, "}", "[Events]", "{", *ev, "}",
            "[ExpertDrums]", "{", *drums, "}"]
    Path(path).write_text("\n".join(body) + "\n", encoding="utf-8")
    return path


def write_ini(path: Path, **kv):
    Path(path).write_text("[song]\n" + "".join(f"{k} = {v}\n" for k, v in kv.items()), encoding="utf-8")
    return path


def drum_pattern(n_measures, tpq=TPQ):
    """A deterministic pro-drums groove: [(tick, MIDI note, velocity, length)]."""
    notes = []
    e = tpq // 2
    for m in range(n_measures):
        for slot in range(8):
            t = (m * 8 + slot) * e
            if slot in (0, 3, 4) or (m % 3 == 1 and slot == 7):
                notes.append((t, 96, 100, 10))                      # kick
            if slot in (2, 6):
                notes.append((t, 97, 100, 10))                      # snare
            if slot not in (0,) or m % 4:
                notes.append((t, 98, 100, 10))                      # hat (cymbal)
            if slot == 0 and m % 4 == 0:
                notes.append((t, 100, 100, 10))                     # crash
            if m % 5 == 2 and slot == 5:
                notes.append((t, 99, 100, 10))
                notes.append((t, 111, 100, 10))                     # blue tom
    return notes


def _mask_bytes(data: bytes, mask: bytes) -> bytes:
    # Independent, byte-by-byte reference of the SngFileFormat mask.
    return bytes(b ^ mask[i % 16] ^ (i & 0xFF) for i, b in enumerate(data))


def write_sng(path, files: dict, meta: dict, mask=bytes(range(7, 23))):
    """Pack {name: bytes} into an .sng (SngFileFormat v1) with the given song.ini metadata."""
    md = b"".join(struct.pack("<i", len(k.encode())) + k.encode() + struct.pack("<i", len(v.encode())) + v.encode()
                  for k, v in meta.items())
    names = list(files)
    idx_len = sum(1 + len(n.encode()) + 16 for n in names)
    head = b"SNGPKG" + struct.pack("<I", 1) + mask + struct.pack("<QQ", len(md) + 8, len(meta)) + md
    head += struct.pack("<QQ", idx_len + 8, len(names))
    data_start = len(head) + idx_len + 8
    off, index, blobs = data_start, b"", []
    for n in names:
        blobs.append(_mask_bytes(files[n], mask))
        index += struct.pack("<B", len(n.encode())) + n.encode() + struct.pack("<QQ", len(files[n]), off)
        off += len(files[n])
    Path(path).write_bytes(head + index + struct.pack("<Q", off - data_start) + b"".join(blobs))
    return path
