#!/usr/bin/env python3
"""feedpak spec-conformance gate.

feedpak is an open, versioned format with its own normative spec, JSON Schemas,
and reference validator (https://github.com/got-feedback/feedpak-spec). That
makes the spec a contract with everyone outside this repo: third-party packers,
converters, and players build against it. When core reads a manifest key the
spec never defined, the contract quietly breaks — a spec-compliant pack stops
being a fully-working pack, and the format's real definition migrates into our
source tree. See #933 for the instance that motivated this gate.

We cannot mechanically prove core *interprets* a key the way the spec means. We
can prove three surface properties, and those cover the drift that actually
happens:

  1. key-coverage  — every manifest key core reads is declared by the spec.
  2. forward       — core ingests the spec's own example packs.
  3. reverse       — packs committed here satisfy the spec's reference validator.

Dev/CI tooling only: never imported on the serve or Docker path (constitution
Principle I — same category as scripts/build-tailwind.sh). `jsonschema` is
therefore a CI-only dependency, not a runtime requirement.

Usage:
    python tools/check_spec_conformance.py --spec <path-to-feedpak-spec-checkout>

Exit status is 0 only when every layer passes.
"""
from __future__ import annotations

import argparse
import ast
import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Modules that read a feedpak manifest dict. Listed explicitly rather than
# globbed so that adding a new reader is a deliberate act that shows up in
# review — a new reader is exactly when key drift gets introduced. A missing
# file here is a hard error, so a rename cannot silently disable the scan.
READERS = [
    "lib/sloppak.py",
    "lib/enrichment.py",
    "lib/songmeta.py",
]

# Locals that hold a manifest dict. The loaders use a uniform idiom
# (`manifest.get("key")`), so binding by name is sufficient today. See
# "Limitations" in docs/feedpak-spec-gate.md for the hardening path.
MANIFEST_VARS = {"manifest", "mf"}

# Packs committed to this repo, checked against the spec's reference validator.
PACK_GLOBS = ["content/starter/*.feedpak", "docs/**/*.sloppak", "docs/**/*.feedpak"]

EXCEPTIONS_FILE = REPO / "feedpak-spec-exceptions.yml"

# Keys under this prefix are reserved for pre-spec experimentation and are
# always permitted. Anything else undeclared must be listed in the exceptions
# file with a tracking issue, or the build fails.
EXPERIMENTAL_PREFIX = "x-"


def _fail(msg: str) -> None:
    print(f"::error::{msg}")


def _is_manifest_receiver(node: ast.expr) -> bool:
    """True when `node` evaluates to a manifest dict.

    Covers the plain `manifest.get(...)` idiom plus the wrapped form used in
    lib/enrichment.py: `(sloppak_mod.load_manifest(p) or {}).get("key")`.
    """
    if isinstance(node, ast.Name) and node.id in MANIFEST_VARS:
        return True
    try:
        src = ast.unparse(node)
    except Exception:
        return False
    return "load_manifest" in src


def keys_touched(path: Path) -> tuple[set[str], set[str]]:
    """Literal top-level manifest keys `path` reads and writes, separately.

    Writes matter as much as reads: `manifest["k"] = v` means core *emits* `k`
    into a pack it ships, so an undeclared key there puts non-spec surface into
    the wild — the same drift, pointed outward. `manifest["k"]` in a subscript
    is a read only when its context is a Load; an `ast.walk` that ignores `ctx`
    would score `manifest["year"] = ...` (lib/songmeta.py) as a read.
    """
    reads: set[str] = set()
    writes: set[str] = set()
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and _is_manifest_receiver(node.func.value)
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            reads.add(node.args[0].value)
        elif (
            isinstance(node, ast.Subscript)
            and _is_manifest_receiver(node.value)
            and isinstance(node.slice, ast.Constant)
            and isinstance(node.slice.value, str)
        ):
            target = writes if isinstance(node.ctx, ast.Store) else reads
            target.add(node.slice.value)
    return reads, writes


def load_exceptions() -> dict[str, str]:
    """Map of allowlisted key -> tracking issue URL."""
    if not EXCEPTIONS_FILE.exists():
        return {}
    import yaml  # runtime dep (PyYAML is already in requirements.txt)

    data = yaml.safe_load(EXCEPTIONS_FILE.read_text(encoding="utf-8")) or {}
    out: dict[str, str] = {}
    for entry in data.get("exceptions") or []:
        key, issue = entry.get("key"), entry.get("issue")
        if not key or not issue:
            _fail(f"{EXCEPTIONS_FILE.name}: every exception needs both 'key' and 'issue'")
            sys.exit(1)
        out[key] = issue
    return out


def check_key_coverage(spec: Path) -> bool:
    """Layer 1 — core must not read a manifest key the spec does not declare."""
    schema = json.loads((spec / "schemas" / "manifest.schema.json").read_text(encoding="utf-8"))
    declared = set(schema.get("properties") or {})
    if not declared:
        _fail("spec manifest.schema.json declares no properties — wrong path or bad checkout?")
        return False

    reads: set[str] = set()
    writes: set[str] = set()
    for rel in READERS:
        path = REPO / rel
        if not path.exists():
            _fail(f"reader {rel} not found — was it renamed? Update READERS in {Path(__file__).name}.")
            return False
        r, w = keys_touched(path)
        reads |= r
        writes |= w

    exceptions = load_exceptions()
    ok = True

    def _undeclared(keys: set[str]) -> list[str]:
        flagged = {k for k in (keys - declared) if not k.startswith(EXPERIMENTAL_PREFIX)}
        return sorted(flagged - set(exceptions))

    for key in _undeclared(reads):
        _fail(
            f"core reads manifest key '{key}', which the feedpak spec does not define. "
            f"Add it to the spec (github.com/got-feedback/feedpak-spec) before merging, "
            f"rename it to '{EXPERIMENTAL_PREFIX}{key}' if it is deliberately pre-spec, or "
            f"record it in {EXCEPTIONS_FILE.name} with a tracking issue."
        )
        ok = False

    for key in _undeclared(writes):
        _fail(
            f"core writes manifest key '{key}', which the feedpak spec does not define — "
            f"that puts non-spec surface into every pack we emit. Add it to the spec "
            f"(github.com/got-feedback/feedpak-spec) before merging, rename it to "
            f"'{EXPERIMENTAL_PREFIX}{key}' if it is deliberately pre-spec, or record it in "
            f"{EXCEPTIONS_FILE.name} with a tracking issue."
        )
        ok = False

    # A stale exception is its own bug: it means the spec caught up and nobody
    # cleaned up, so the allowlist slowly becomes a place drift hides.
    touched = reads | writes
    for key, issue in exceptions.items():
        if key in declared:
            _fail(
                f"'{key}' is listed in {EXCEPTIONS_FILE.name} but the spec now declares it. "
                f"Remove the exception and close {issue}."
            )
            ok = False
        elif key not in touched:
            _fail(
                f"'{key}' is listed in {EXCEPTIONS_FILE.name} but core no longer reads or writes "
                f"it. Remove the exception."
            )
            ok = False

    print(f"  spec declares {len(declared)} keys; core reads {len(reads)}, writes {len(writes)}")
    if exceptions:
        print(f"  allowlisted (pending spec): {', '.join(sorted(exceptions))}")
    print(f"  key-coverage: {'OK' if ok else 'FAILED'}")
    return ok


def check_forward(spec: Path) -> bool:
    """Layer 2 — core must ingest every example pack the spec ships."""
    examples_dir = spec / "examples"
    if not examples_dir.is_dir():
        _fail(f"{examples_dir} is missing — wrong path or bad checkout?")
        return False
    examples = sorted(
        p for p in examples_dir.iterdir()
        if p.suffix in (".feedpak", ".sloppak")
    )
    if not examples:
        _fail("spec ships no example packs — wrong path or bad checkout?")
        return False

    sys.path.insert(0, str(REPO / "lib"))
    import sloppak  # noqa: E402  (path must be set first — flat imports, no package)

    ok = True
    with tempfile.TemporaryDirectory() as tmp:
        cache = Path(tmp)
        for pack in examples:
            try:
                loaded = sloppak.load_song(pack.name, pack.parent, cache)
            except Exception as e:
                _fail(
                    f"core failed to load the spec's own example pack {pack.name}: "
                    f"{type(e).__name__}: {e}. A spec-valid pack must load."
                )
                ok = False
                continue
            if not loaded.song.arrangements:
                _fail(f"core loaded {pack.name} but found no arrangements")
                ok = False
                continue
            print(f"  loaded {pack.name}: {len(loaded.song.arrangements)} arrangement(s)")
    print(f"  forward: {'OK' if ok else 'FAILED'}")
    return ok


def check_reverse(spec: Path) -> bool:
    """Layer 3 — packs committed here must pass the spec's reference validator."""
    packs = sorted({p for g in PACK_GLOBS for p in REPO.glob(g)})
    if not packs:
        print("  reverse: no committed packs — skipped")
        return True

    proc = subprocess.run(
        [sys.executable, str(spec / "tools" / "validate.py"), *[str(p) for p in packs]],
        capture_output=True,
        text=True,
    )
    sys.stdout.write("".join(f"  {ln}\n" for ln in proc.stdout.splitlines() if ln.strip()))
    if proc.returncode != 0:
        _fail(
            "a pack committed to this repo does not satisfy the feedpak spec "
            "(see the reference validator output above)."
        )
        if proc.stderr.strip():
            sys.stderr.write(proc.stderr)
    print(f"  reverse: {'OK' if proc.returncode == 0 else 'FAILED'}")
    return proc.returncode == 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument(
        "--spec",
        required=True,
        type=Path,
        help="path to a feedpak-spec checkout (CI pins the SHA in .feedpak-spec-ref)",
    )
    args = ap.parse_args()

    spec = args.spec.resolve()
    if not (spec / "schemas" / "manifest.schema.json").exists():
        _fail(f"{spec} does not look like a feedpak-spec checkout")
        return 1

    print("[1/3] key-coverage — core reads only keys the spec declares")
    ok1 = check_key_coverage(spec)
    print("[2/3] forward — core ingests the spec's example packs")
    ok2 = check_forward(spec)
    print("[3/3] reverse — committed packs satisfy the reference validator")
    ok3 = check_reverse(spec)

    if ok1 and ok2 and ok3:
        print("\nfeedpak spec conformance: OK")
        return 0
    print("\nfeedpak spec conformance: FAILED")
    return 1


if __name__ == "__main__":
    sys.exit(main())
