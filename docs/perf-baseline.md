# Perf baseline — module-migration refactor

The refactor promises "measured runtime wins, no hand-waved perf claims" and
"screen-entry and frame-time no worse." This is the baseline to hold it to.
Rerun the harness after every phase (R0 → R3c) and compare.

## Running it

```
# 1. start core against a library with real charts (see caveat below)
CONFIG_DIR=… DLC_DIR=/path/to/songs PYTHONPATH=lib \
  python3 -m uvicorn server:app --host 127.0.0.1 --port 8000

# 2. capture (maintainer/CI-only; uses the committed Playwright chromium)
node scripts/perf-baseline.mjs --base http://127.0.0.1:8000 --n 60 --soak 30
```

The script prints a markdown block; paste it under "Results" below with the date
and the commit it was taken at.

## What it measures

- **Server latency** — p50/p95/p99 over N requests for `/api/version`,
  `/api/plugins`, `/api/library`, `/api/library/artists`.
- **Cold boot → interactive** — full page load to `networkidle`.
- **JS heap** — `performance.memory.usedJSHeapSize` after load and after an idle
  soak (a leak signal across a session).
- **Plugin-script shape** — how many plugin `<script>`s the loader injected (a
  "the app booted with its plugins" sanity signal).

**Not yet captured — needs a seeded library with charts** (fill in when run
against a real environment): playback **frame-time p95** on the 2D and 3D
highway, and **screen-entry** (plugin inject → interactive) for
editor / notedetect / highway_3d with a chart loaded. These are the
perf-sensitive numbers that gate the `highway.js` split (R3c); the harness has
the hooks, they just need real songs in `DLC_DIR`.

## Results

### R0 baseline — 2026-07-08 (branch `feat/r0-plugin-module-rails`)

> ⚠️ A quick capture (`--n 50 --soak 8`) against an **empty** library (no charts
> in `DLC_DIR`), so the `/api/library*` and boot numbers are floor values —
> re-take on a seeded environment with the recommended `--n 60 --soak 30` for the
> real R0 baseline before comparing R1+ against it. Recorded here to prove the
> harness and lock the methodology.

Server latency (ms), n=50:

| Endpoint | status | p50 | p95 | p99 |
|---|---|---|---|---|
| `/api/version` | 200 | 0.9 | 1.8 | 22.3 |
| `/api/plugins` | 200 | 1.6 | 2.1 | 3.4 |
| `/api/library?limit=60` | 200 | 1.4 | 1.7 | 2.9 |
| `/api/library/artists` | 200 | 1.3 | 1.8 | 2.7 |

Client:

| Metric | Value |
|---|---|
| Cold boot → networkidle | 1268 ms |
| JS heap after load | 10.1 MB |
| JS heap after idle soak | 10.1 MB (no idle growth) |
| Plugin scripts injected | 12 |

No plugin has migrated yet, so all 12 are classic. When the R1 pilot (stems)
lands, cold-boot / heap should not regress.
