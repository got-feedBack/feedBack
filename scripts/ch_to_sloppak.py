#!/usr/bin/env python3
"""Clone Hero / YARG / Rock Band song folder (or .sng) -> a drums feedpak.

Usage:
    python scripts/ch_to_sloppak.py SONG_FOLDER_OR_SNG OUT.sloppak
           [--title T --artist A --album X --year N] [--dir] [-v]

SONG_FOLDER holds ``notes.mid`` (PART DRUMS) or ``notes.chart`` ([ExpertDrums]),
``song.ini`` and the audio (``song.ogg`` and/or ``guitar``/``rhythm``/``bass``/
``drums[_1-4]``/``vocals``/``keys`` stems). An ``.sng`` package is unpacked first.

The pack it writes (feedpak 1.20.0):

- ``drum_tab.json`` — the Expert drums part as 4-lane pro piece hits (2x kicks
  flagged ``x2``), plus the chart's star power, fills and solos, and its
  Easy/Medium/Hard parts as ``levels`` (any missing level is reduced from Expert
  and marked ``generated``). A chart with star power but no fills gets YARG's
  generated activation fills. Spec §7.5 "Drum gameplay metadata".
- ``song_timeline.json`` — tempo map, time signatures, beats and sections.
- ``manifest.yaml`` — one ``type: drums`` arrangement pointing at the tab, with the
  song-level ``drum_tab`` key as its primary-part alias (spec §7.5 "Multiple drum
  parts"; the pack has no pitched arrangement, and ``arrangements`` may not be empty).

song.ini ``delay`` is applied, so chart times line up with the audio as YARG plays
it. Audio: a lone ``song.ogg`` becomes the ``full`` stem; separate CH stems become
pack stems (guitar+rhythm -> guitar, keys -> piano, song -> other, drums_1..4 mixed
into drums; crowd is dropped). A single ``.ogg`` per stem is copied as-is; anything
else is mixed / transcoded with ffmpeg. Parsing rules: lib/drumchart.py.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "lib"))

import yaml  # noqa: E402

import audio  # noqa: E402
import drumchart  # noqa: E402
import drumchart_gen  # noqa: E402
import sngfile  # noqa: E402

log = logging.getLogger("feedBack.scripts.ch_to_sloppak")

# The format version this converter writes: drum gameplay metadata (1.20.0).
FEEDPAK_VERSION = "1.20.0"

STEM_ORDER = ["full", "guitar", "bass", "drums", "vocals", "piano", "other"]
ROLE_TO_STEM = {"guitar": "guitar", "rhythm": "guitar", "bass": "bass", "drums": "drums",
                "vocals": "vocals", "keys": "piano", "song": "other"}


def _ffmpeg() -> str:
    ff = audio._ffmpeg_cmd()
    if not ff:
        raise RuntimeError("ffmpeg is required to mix or transcode these stems")
    return ff


def audio_seconds(path: Path) -> float:
    """Duration via ffprobe next to ffmpeg; 0.0 when unavailable."""
    probe = audio._bundled_or_path("ffprobe")
    if not probe:
        return 0.0
    try:
        r = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                            str(path)], capture_output=True, text=True, timeout=60)
        return float(r.stdout.strip())
    except (OSError, ValueError, subprocess.SubprocessError):
        return 0.0


def encode_stem(inputs: list[Path], out: Path) -> None:
    """One or more audio files -> one OGG (summed, not normalised, like the CH mixer)."""
    if len(inputs) == 1 and inputs[0].suffix.lower() == ".ogg":
        shutil.copyfile(inputs[0], out)
        return
    cmd = [_ffmpeg(), "-v", "error", "-y"]
    for p in inputs:
        cmd += ["-i", str(p)]
    if len(inputs) > 1:
        cmd += ["-filter_complex", f"amix=inputs={len(inputs)}:duration=longest:normalize=0"]
    cmd += ["-vn", "-c:a", "libvorbis", "-q:a", "6", str(out)]
    subprocess.run(cmd, check=True)


def build_stems(folder: Path, stems_dir: Path) -> list[dict]:
    files = drumchart.song_audio_files(folder)
    files.pop("crowd", None)
    if not files:
        raise ValueError(f"{folder.name}: no audio (song.ogg / stems) found")
    stems_dir.mkdir(parents=True, exist_ok=True)
    if set(files) == {"song"}:
        encode_stem(files["song"], stems_dir / "full.ogg")
        return [{"id": "full", "file": "stems/full.ogg", "default": True}]
    groups: dict[str, list[Path]] = {}
    for role, paths in files.items():
        groups.setdefault(ROLE_TO_STEM[role], []).extend(paths)
    out = []
    for sid in sorted(groups, key=STEM_ORDER.index):
        encode_stem(groups[sid], stems_dir / f"{sid}.ogg")
        out.append({"id": sid, "file": f"stems/{sid}.ogg", "default": True})
    return out


def parse_year(v) -> int:
    m = re.search(r"\d{4}", str(v or ""))
    return int(m.group(0)) if m else 0


def find_cover(folder: Path) -> Path | None:
    for name in ("album.jpg", "album.png", "album.jpeg", "cover.jpg", "cover.png"):
        p = folder / name
        if p.exists():
            return p
    return None


def zip_dir(work: Path, out: Path) -> None:
    tmp = out.with_name(out.name + ".tmp")
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as z:
        for f in sorted(work.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(work).as_posix())
    if out.exists():
        out.unlink() if out.is_file() else shutil.rmtree(out)
    tmp.rename(out)


def prepare_chart(folder: Path) -> tuple[drumchart.DrumChart, dict]:
    """Parse the folder's drums and fill in what YARG/feedBack generate for charts
    without it: activation fills (when there is star power) and lower levels."""
    chart, ini = drumchart.load_song_folder(folder)
    if not chart.hits:
        raise ValueError(f"{folder.name}: the expert drums part has no notes")
    if chart.star_power and not chart.fills:
        beats = [(b["time"], b["measure"]) for b in chart.beat_list()]
        chart.fills = drumchart_gen.auto_fills([h.time for h in chart.hits], beats, chart.star_power,
                                               chart.solos, [t for t, _ in chart.sections])
    drumchart_gen.ensure_levels(chart)
    return chart, ini


def convert(src: Path, out: Path, title=None, artist=None, album=None, year=None, as_dir=False) -> dict:
    """Write a drums pack for a CH/YARG song folder or .sng. Returns a summary dict."""
    src = Path(src)
    unpacked = None
    work = Path(tempfile.mkdtemp(prefix="ch2pak_"))
    try:
        if src.is_file() and src.suffix.lower() == ".sng":
            unpacked = Path(tempfile.mkdtemp(prefix="sng_"))
            folder = sngfile.extract_sng(src, unpacked)
        else:
            folder = src
        chart, ini = prepare_chart(folder)
        stems = build_stems(folder, work / "stems")
        dur = max([audio_seconds(work / s["file"]) for s in stems] + [chart.hits[-1].time + 1.0])
        (work / "drum_tab.json").write_text(json.dumps(drumchart.drum_tab(chart), separators=(",", ":")),
                                            encoding="utf-8")
        (work / "song_timeline.json").write_text(json.dumps(drumchart.song_timeline(chart),
                                                            separators=(",", ":")), encoding="utf-8")
        manifest = {
            "feedpak_version": FEEDPAK_VERSION,
            "title": title or ini.get("name") or folder.name,
            "artist": artist or ini.get("artist") or "Unknown",
            "album": album if album is not None else ini.get("album", ""),
            "year": year if year is not None else parse_year(ini.get("year")),
            "duration": round(dur, 3),
        }
        cover = find_cover(folder)
        if cover:
            name = "cover" + cover.suffix.lower().replace(".jpeg", ".jpg")
            shutil.copyfile(cover, work / name)
            manifest["cover"] = name
        manifest["stems"] = stems
        manifest["arrangements"] = [{"id": "drums", "name": "Drums", "type": "drums",
                                     "drum_tab": "drum_tab.json"}]
        manifest["drum_tab"] = "drum_tab.json"
        manifest["song_timeline"] = "song_timeline.json"
        (work / "manifest.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True),
                                            encoding="utf-8")
        out = Path(out)
        if as_dir:
            if out.exists():
                shutil.rmtree(out) if out.is_dir() else out.unlink()
            shutil.copytree(work, out)
        else:
            zip_dir(work, out)
    finally:
        shutil.rmtree(work, ignore_errors=True)
        if unpacked:
            shutil.rmtree(unpacked, ignore_errors=True)
    return {"out": str(out), "notes": len(chart.hits), "format": chart.source_format,
            "star_power": len(chart.star_power), "fills": len(chart.fills), "solos": len(chart.solos),
            "sections": len(chart.sections), "delay": chart.offset, "five_lane": chart.five_lane,
            "levels_generated": sorted(chart.levels_generated),
            "stems": [s["id"] for s in stems], "duration": manifest["duration"]}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", type=Path, help="CH/YARG song folder or .sng package")
    ap.add_argument("out", type=Path)
    ap.add_argument("--title")
    ap.add_argument("--artist")
    ap.add_argument("--album")
    ap.add_argument("--year", type=int)
    ap.add_argument("--dir", action="store_true", help="write the directory form instead of a zip")
    ap.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, format="%(levelname)s %(message)s")
    try:
        s = convert(a.src, a.out, a.title, a.artist, a.album, a.year, a.dir)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as e:
        log.error("%s", e)
        return 1
    log.info("wrote %s: %d drum notes (%s), %d star power, %d fills, %d solos, %d sections, "
             "delay %+.3fs, generated levels %s, stems %s", s["out"], s["notes"], s["format"],
             s["star_power"], s["fills"], s["solos"], s["sections"], s["delay"],
             ", ".join(s["levels_generated"]) or "none", ", ".join(s["stems"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
