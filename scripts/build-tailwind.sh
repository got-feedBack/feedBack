#!/usr/bin/env bash
# Regenerate static/tailwind.min.css from the project's content globs.
# This is a maintainer task — the generated CSS is committed, so end
# users / Docker / desktop builds never run this. Required when adding
# new Tailwind utility classes that aren't yet present in committed
# source.
#
# Pin to Tailwind 3.x so the input/config syntax matches what was
# already shipped via the Play CDN (Tailwind 4 has breaking changes).
#
# Run this from a checkout with NO untracked plugin directories present (a
# `git worktree add --detach` of this branch is the safest way). The content
# glob (tailwind.config.js) scans `./plugins/**` on disk regardless of
# .gitignore — a dev machine with private/out-of-tree plugins checked out
# locally (e.g. audio_engine, plugin_manager) will silently bake their classes
# into the committed CSS, which CI's clean checkout can never reproduce and
# will permanently fail the tailwind-fresh gate.
set -euo pipefail
cd "$(dirname "$0")/.."
# Byte-stable rebuilds require the exact same resolved dependency tree, not
# just the same top-level tailwindcss version: `npx -y tailwindcss@x.y.z`
# installs into a scratch npx cache and lets npm re-resolve transitive deps
# (postcss, cssnano, autoprefixer) to whatever's current on the registry at
# invocation time — those drift independently of the pinned version and
# silently produced non-reproducible output between two machines. tailwindcss
# is now a pinned devDependency (package.json/package-lock.json); `npm ci`
# before this script (both here and in CI) is what actually makes the output
# reproducible.
exec npx tailwindcss \
    -c tailwind.config.js \
    -i static/_tailwind.src.css \
    -o static/tailwind.min.css \
    --minify
