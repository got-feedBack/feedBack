#!/usr/bin/env python3
"""Find the guitar solo in feedpaks and mark it as a ``solo`` section.

Usage:
    python scripts/solo_sections.py PATH [PATH ...] [--match TEXT] [--write] [--json]

Each PATH is a feedpak (``.feedpak`` / legacy ``.sloppak``, zip or directory
form) or a folder that is searched recursively for them. Detection lives in
``lib/solo_sections.py``; this is the I/O glue around it.

**Dry run by default** — it reports what it found and what it would write.
``--write`` modifies the packs.

Where the section is written follows feedpak-spec §6.1/§7.4: sections are
song-level data, so

- when the manifest names a ``song_timeline`` file, its ``sections`` array is
  updated (it takes priority over anything embedded in arrangement JSON);
- otherwise every arrangement JSON that carries a non-empty ``sections`` array
  is updated, so whichever one a Reader hoists agrees; if none carries any,
  the first arrangement JSON gets the list (the one a Reader hoists from).

No manifest key is added or changed. Songs whose sections already name a solo
are left alone — an existing solo section is never overwritten. ``.jsonc``
targets are skipped rather than rewritten, because rewriting would drop their
comments. Zip-form packs are rebuilt member by member (each entry's original
compression is kept) into a temp file that atomically replaces the original.
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import zipfile
from pathlib import Path

# Make `lib/` importable regardless of CWD.
_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
sys.path.insert(0, str(_ROOT / "lib"))

import sloppak as sloppak_mod  # noqa: E402
import solo_sections as solo  # noqa: E402
from jsonc import parse_jsonc  # noqa: E402

log = logging.getLogger("feedBack.scripts.solo_sections")

# Arrangement entries without a `type` hint are judged by name.
_NON_GUITAR_NAME_RE = re.compile(r"bass|drum|keys|piano|synth|vocal", re.I)


def _is_guitar_entry(entry: dict) -> bool:
    if not isinstance(entry.get("file"), str) or not entry["file"]:
        return False
    if entry.get("drum_tab"):
        return False
    kind = str(entry.get("type") or "").strip().lower()
    if kind:
        return kind == "guitar"
    return not _NON_GUITAR_NAME_RE.search(str(entry.get("name") or entry.get("id") or ""))


def _read_json_member(pak: Path, rel: str) -> object | None:
    raw = sloppak_mod.read_member_bytes(pak, rel)
    if raw is None:
        return None
    text = raw.decode("utf-8")
    return parse_jsonc(text) if rel.lower().endswith(".jsonc") else json.loads(text)


def _find_packs(paths: list[Path]) -> list[Path]:
    packs: list[Path] = []
    for p in paths:
        if sloppak_mod.is_sloppak(p) and p.exists():
            packs.append(p)
        elif p.is_dir():
            packs.extend(sorted(c for c in p.rglob("*")
                                if sloppak_mod.is_sloppak(c)
                                # skip anything nested inside a directory-form pack
                                and not any(sloppak_mod.is_sloppak(a) for a in c.relative_to(p).parents
                                            if a != Path("."))))
        else:
            log.warning("%s: not a feedpak or folder — skipped", p)
    return packs


def analyse(pak: Path) -> dict | None:
    """Detect the solo in one pack and plan the writes. None when unreadable.

    The plan is ``{"lead", "regions", "marked", "sections", "targets"}`` where
    ``targets`` maps pack-relative file → parsed JSON *after* the change (empty
    when there is nothing to write).
    """
    try:
        manifest = sloppak_mod.load_manifest(pak)
    except (OSError, ValueError, zipfile.BadZipFile) as e:
        log.warning("%s: unreadable manifest (%s) — skipped", pak.name, e)
        return None

    entries = [e for e in manifest.get("arrangements") or [] if isinstance(e, dict)]
    arr_data: dict[str, dict] = {}   # rel path → parsed JSON, in manifest order
    charts: dict[str, dict] = {}     # name → parsed JSON, guitar parts only
    for entry in entries:
        rel = entry.get("file")
        if not isinstance(rel, str) or not rel:
            continue
        try:
            data = _read_json_member(pak, rel)
        except (UnicodeDecodeError, ValueError) as e:
            log.warning("%s: unreadable arrangement %r (%s) — skipped", pak.name, rel, e)
            continue
        if not isinstance(data, dict):
            continue
        arr_data[rel] = data
        if _is_guitar_entry(entry):
            charts[str(entry.get("name") or entry.get("id") or rel)] = data

    timeline_rel, timeline = None, None
    st_rel = manifest.get("song_timeline")
    if isinstance(st_rel, str) and st_rel:
        try:
            raw = _read_json_member(pak, st_rel)
        except (UnicodeDecodeError, ValueError) as e:
            log.warning("%s: unreadable song_timeline (%s)", pak.name, e)
            raw = None
        # Same validity test the loader applies before letting it take priority.
        if isinstance(raw, dict) and isinstance(raw.get("beats"), list) \
                and isinstance(raw.get("sections"), list):
            timeline_rel, timeline = st_rel, raw

    # The song-level sections and beats a Reader would see.
    if timeline is not None:
        sections, beats = timeline["sections"], timeline["beats"]
    else:
        sections = next((d["sections"] for d in arr_data.values()
                         if isinstance(d.get("sections"), list) and d["sections"]), [])
        beats = next((d["beats"] for d in arr_data.values()
                      if isinstance(d.get("beats"), list) and d["beats"]), [])

    regions, lead = solo.find_solos(charts, beats) if charts else ([], None)
    marked = solo.has_solo(sections)
    plan = {"lead": lead, "regions": regions, "marked": marked,
            "sections": sections, "targets": {}, "absorbed": 0}
    found = next((r for r in regions if r["solo"]), None)
    if marked or found is None:
        return plan

    new_sections, plan["absorbed"] = solo.insert_solo(sections, found["start"], found["end"])
    if timeline is not None:
        target_rels = [timeline_rel]
    else:
        target_rels = [rel for rel, d in arr_data.items()
                       if isinstance(d.get("sections"), list) and d["sections"]]
        if not target_rels and arr_data:
            target_rels = [next(iter(arr_data))]
    for rel in target_rels:
        if rel.lower().endswith(".jsonc"):
            log.warning("%s: %s is JSONC — not rewritten (comments would be lost)",
                        pak.name, rel)
            continue
        src = timeline if rel == timeline_rel else arr_data[rel]
        plan["targets"][rel] = dict(src, sections=new_sections)
    plan["sections"] = new_sections
    return plan


def write_pack(pak: Path, targets: dict[str, dict]) -> None:
    """Replace the ``targets`` JSON files inside a pack (dir or zip form)."""
    payloads = {rel: json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
                for rel, data in targets.items()}
    if pak.is_dir():
        for rel, payload in payloads.items():
            dest = pak / rel
            tmp = dest.with_name(dest.name + ".solo-tmp")
            try:
                tmp.write_bytes(payload)
                tmp.replace(dest)
            except OSError:
                tmp.unlink(missing_ok=True)
                raise
        return

    by_key = {sloppak_mod._zip_member_key(rel): payload for rel, payload in payloads.items()}
    tmp = pak.with_name(pak.name + ".solo-tmp")
    try:
        with zipfile.ZipFile(pak) as zin, \
                zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                key = sloppak_mod._zip_member_key(item.filename)
                # Passing the original ZipInfo keeps each entry's compression —
                # stems are already-compressed audio.
                zout.writestr(item, by_key[key] if key in by_key else zin.read(item))
        tmp.replace(pak)
    except (OSError, zipfile.BadZipFile):
        tmp.unlink(missing_ok=True)
        raise


def _fmt(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:05.2f}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="+", type=Path,
                        help="feedpaks, or folders to search for them")
    parser.add_argument("--match", default="",
                        help="only packs whose file name contains this (case-insensitive)")
    parser.add_argument("--write", action="store_true",
                        help="write the solo section (default: dry run)")
    parser.add_argument("--json", action="store_true",
                        help="print the detection report as JSON on stdout")
    args = parser.parse_args(argv)

    report = []
    written = 0
    for pak in _find_packs(args.paths):
        if args.match and args.match.lower() not in pak.name.lower():
            continue
        plan = analyse(pak)
        if plan is None or plan["lead"] is None:
            continue
        found = next((r for r in plan["regions"] if r["solo"]), None)
        tag = "MARKED" if plan["marked"] else ("FOUND" if found else "-")
        report.append({"file": str(pak), "lead": plan["lead"], "status": tag,
                       "regions": plan["regions"], "targets": sorted(plan["targets"])})
        log.info("%-6s %s  (part: %s)", tag, pak.name, plan["lead"])
        for r in plan["regions"]:
            log.info("   %s %s-%s %2d bars %s n/s %d notes fret %s at %d%% rhythm-chords %s%s",
                     "SOLO" if r["solo"] else "    ", _fmt(r["start"]), _fmt(r["end"]),
                     r["bars"], r["nps"], r["singles"], r["fret"], int(r["pos"] * 100),
                     r["rhythm_chords"],
                     "  (candidate)" if r["candidate"] and not r["solo"] else "")
        if plan["marked"]:
            log.info("   already marked: %s", [
                (s.get("name"), _fmt(float(s.get("time", 0)))) for s in plan["sections"]
                if isinstance(s, dict) and re.search("solo", str(s.get("name", "")), re.I)])
        if not plan["targets"]:
            continue
        verb = "wrote" if args.write else "DRY-RUN would write"
        log.info("   %s solo section to %s%s", verb, ", ".join(sorted(plan["targets"])),
                 f" (absorbing {plan['absorbed']} section(s) inside it)" if plan["absorbed"] else "")
        if args.write:
            write_pack(pak, plan["targets"])
            written += 1

    if args.json:
        sys.stdout.write(json.dumps(report, indent=1) + "\n")
    log.info("done: %d pack(s) %s", written if args.write else
             sum(1 for r in report if r["targets"]),
             "written" if args.write else "would be written (dry run; pass --write)")
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(main())
