# The feedpak spec-conformance gate

`tools/check_spec_conformance.py`, run in CI as the `feedpak-spec` job.

## Why

feedpak is published as an **open format**: its own repo
([got-feedback/feedpak-spec](https://github.com/got-feedback/feedpak-spec)), a normative spec, JSON
Schemas, and a reference validator. That is a promise to everyone outside this codebase — third-party
packers, converters, and players build against the spec, and the spec is meant to be the complete and
authoritative description of a pack.

The moment core reads a manifest key the spec doesn't define, that promise breaks silently:

- A spec-compliant pack is no longer guaranteed to be a fully-working pack.
- The reference validator can't warn authors about a key it has never heard of — it will happily green-light
  the key, and every misspelling of it.
- The format's real definition drifts into our source tree. In the case that motivated this gate
  ([#933](https://github.com/got-feedback/feedback/issues/933)), third-party tooling started emitting an
  `original/` directory that no code anywhere requires — the convention was reverse-engineered from an
  example in a *code comment*.

The rule this gate enforces: **any manifest key core reads must be in the spec before core ships code that
depends on it.** Spec first, implementation second.

Note that "get it into the spec" is not automatically the right fix for an existing violation — for
`original_audio` it isn't. The spec already carries the pre-separation mixdown as a stem
(`{id: full, file: stems/full.ogg}`), so that key added a *second, redundant* location for audio to a format
that already had one, and the resolution is to remove it rather than bless it. The gate takes no position on
which way a violation resolves; it only insists that one of the two happens deliberately, in the open,
before the code merges.

## What it checks

We can't mechanically prove core *interprets* a key the way the spec means. We can prove three surface
properties, and they cover the drift that actually occurs.

| Layer | Check | Catches |
|---|---|---|
| 1. key-coverage | Every manifest key core reads **or writes** is declared in the spec's `manifest.schema.json`. | Core growing a key the spec never defined — the #933 class. |
| 2. forward | Core's `load_song()` ingests every example pack the spec ships. | The spec adding or tightening something core ignores or breaks on. |
| 3. reverse | Every pack committed to this repo passes the spec's `tools/validate.py`. | Core (or a contributor) committing a pack the spec would reject. |

Layer 1 works by walking the AST of the modules listed in `READERS` and collecting every literal key touched
on a manifest dict (`manifest.get("x")`, `manifest["x"]`, and the wrapped
`(load_manifest(p) or {}).get("x")` form used in `lib/enrichment.py`).

**Reads and writes are both checked, and reported differently.** A key core *writes*
(`manifest["x"] = v`, as `lib/songmeta.py` does) is spec surface pointed outward: it puts a key into every
pack we emit, so an undeclared one seeds the ecosystem with non-spec data. Subscripts are classified by AST
context — `Store` is a write, `Load` is a read — so `manifest["year"] = ...` is not miscounted as a read.

## When it fails

You added a manifest key. Three ways forward, in order of preference:

1. **Land it in the spec first.** Open a PR against `feedpak-spec` adding the key to
   `schemas/manifest.schema.json` and `spec/feedpak-v1.md`, bump `.feedpak-spec-ref` here to the merged
   SHA, and your key passes. This is the intended path.
2. **Mark it experimental.** Prefix the key `x-` (e.g. `x-my_new_key`). The gate permits `x-`-prefixed keys
   unconditionally, and the prefix signals to every third-party packer that the key is not stable surface.
3. **Record an exception.** Add it to `feedpak-spec-exceptions.yml` with a tracking issue. This is debt, and
   the gate treats it as such: an exception goes stale (and fails the build) the moment the spec catches up
   or core stops reading the key, so the allowlist can't become somewhere drift quietly accumulates.

## Pinning

`.feedpak-spec-ref` holds the SHA of the `feedpak-spec` commit this repo is verified against. Pinned rather
than tracking the spec's default branch on purpose — a change over there must never turn CI red on an
unrelated PR here.

When the spec moves, bump the SHA in its own PR. If that PR is red, the spec changed in a way core doesn't
satisfy — exactly the signal we want, delivered as a reviewable PR rather than a surprise on someone else's
branch.

## Limitations

Known, and worth fixing in follow-ups rather than blocking on:

- **Layer 1 is name-heuristic.** It recognises manifest dicts bound to locals named in `MANIFEST_VARS`
  (`manifest`, `mf`) plus the `load_manifest(...)` call form. This works because the loaders use a uniform
  idiom, but it is fragile against a refactor that renames the local. The hardening step is to route all
  manifest access through a single declared `KNOWN_MANIFEST_KEYS` registry in `lib/sloppak.py`; the gate
  then compares registry against schema exactly instead of inferring.
- **Layer 1 covers top-level keys only.** Nested structure (`arrangements[].file`, `.id`, `.notation`) isn't
  checked. Extending to it means walking the schema's `$ref` subschemas.
- **Layer 3 can't catch unknown keys**, because `manifest.schema.json` sets `additionalProperties: true` and
  the reference validator deliberately "treats unknown keys/files as forward-compatible". Fixing this
  properly belongs in the spec (tighten the schema, or give the validator a `--strict` mode). Until then,
  layer 1 is the only thing standing between us and the next `original_audio`.
