// highway.js's immutable constants: geometry, colour tables, timing budgets, and the
// load-adaptive render-scale thresholds.
//
// WHY THESE — AND ONLY THESE — MAY LIVE AT MODULE SCOPE
//
// createHighway() is a FACTORY, not a singleton. The constitution publishes
// window.createHighway precisely so a plugin can build a SECOND highway for its own panel,
// and highway.js says so at the top of the closure:
//
//     // R3c: per-instance mutable state in one object, so extracted renderer/ws
//     // modules can close over it as a factory arg without cross-panel sharing.
//
// So MUTABLE state (hwState) must never become a module-level singleton — two highways would
// silently share it. That is the opposite of the app.js carve, where a single state container
// was right because there is exactly one app.
//
// These 29 are pure literals: frozen numbers, strings and colour tables, never reassigned and
// never mutated. Sharing them across instances is not just safe, it is what you want — one
// copy of the shimmer LUT bounds and the string palettes rather than one per panel.
//
// Anything with a runtime dependency (document, window, performance, localStorage) stays in
// the factory. Checked: none of these has one.

// Cap the interpolation so a stalled main thread (long task, GC,
// dropped tick) can't make getTime drift far past reality. Also the
// threshold for "audio looks paused" — if setTime hasn't advanced t
// in this long, treat as paused.
export const _CHART_MAX_INTERP_MS = 100;

// Throttled DOM visibility sampling. Reading canvas.offsetParent
// every rAF frame forces a style/layout recalc — profiled at ~0.5 s
// main-thread self-time over a 63 s session. The displayed state
// changes rarely (navigate / splitscreen panel toggle), so the DOM
// is only re-sampled every _DOM_VIS_CHECK_FRAMES frames; the cached
// value serves the frames in between (worst-case transition latency
// ~10 frames ≈ 166 ms at 60 Hz — fine for a hide/show pause signal).
// Set _domVisSampledFrame to NaN to force a fresh sample on the next
// check (done on init, canvas replace, resize, and override-clear so
// deliberate transitions don't wait out the throttle window).
// NOTE those manual resets are LATENCY optimizations, not correctness
// requirements: the periodic re-sample runs every _DOM_VIS_CHECK_FRAMES
// frames regardless, so a visibility-affecting path that forgets to
// reset self-heals within ~10 frames — stale visibility can never be
// served indefinitely.
export const _DOM_VIS_CHECK_FRAMES = 10;

// Paused-render throttle (feedBack#654). The rAF loop runs
// unconditionally and only gates on visibility + ready, never on
// playback — so an expensive renderer (3D Highway's Three.js WebGL
// scene) does a full render every frame even while paused. That is
// pure waste, and the dominant cost on high-refresh / ANGLE setups
// (Chromium on Windows paces rAF to the fastest attached monitor,
// so the loop can run at 144 Hz even on a 60 Hz panel). While the
// audio clock is stalled, cap draws to one per
// _PAUSED_FRAME_INTERVAL_MS. Note position is clock-derived
// (n.t - currentTime), so this changes smoothness only — never
// audio/visual sync. A low non-zero rate (not a hard skip) keeps
// resize / seek-scrub / renderer-swap repaints correct without
// having to hook each of those paths.
export const _PAUSED_FRAME_INTERVAL_MS = 100;

export const _DRAW_BUDGET_HI_MS = 12;

export const _DRAW_BUDGET_LO_MS = 7;

export const _AUTO_SCALE_MIN = 0.25;

export const _AUTO_ADJUST_COOLDOWN_MS = 600;

// Upscaling is deliberately LAZY (longer cooldown than the downscale path) so
// the resolution doesn't visibly hunt up/down on passages that hover near the
// budget — testers saw "quality going up and down" as parts got busier (#618
// charrette). Downscale stays prompt to protect the frame rate.
export const _AUTO_UPSCALE_COOLDOWN_MS = 2500;

// 64-entry precomputed jitter LUT replacing Math.random() in the
// lit-sustain shimmer hot path (drawSustains). Visually
// indistinguishable from per-frame Math.random at rAF cadence,
// allocation-free, and removes 4 RNG calls per visible lit sustain
// per frame on dense charts. Seeded deterministically (xorshift32)
// so the LUT itself is identical across `createHighway()` instances
// — shimmer is therefore reload-stable and test-reproducible PER
// instance for a given (frameIdx, n.s, n.t) seed. The seed includes
// closure-scope `_frameIdx` which is per-instance, so two
// splitscreen highways with different rAF cadence will shimmer
// differently at any given wall-clock moment; what's stable is the
// LUT contents.
//
// _SHIMMER_LUT_SIZE MUST stay a power of two — `_shimmerNoise`
// indexes with `& (_SHIMMER_LUT_SIZE - 1)` for the cheap modulo.
export const _SHIMMER_LUT_SIZE = 64;

// Memoize ctx.measureText() for the lyric overlay. Per-syllable
// measurement was the dominant cost in dense karaoke charts; text
// and fontSize are the only inputs (font face string is constant
// `bold ${fontSize}px sans-serif`). Two-level Map (outer: fontSize,
// inner: text) so a cache hit avoids the `fontSize + '|' + text`
// concat that previously allocated on every lookup.
//
// Bounded on BOTH levels: window resizes change `fontSize`, so each
// resize creates a fresh inner Map; without an outer cap, the cache
// would retain every fontSize ever rendered for the page lifetime.
// Cap outer at 16 distinct fontSize buckets (more than enough — a
// session typically sees one or two), inner at 4096 entries per
// bucket. Clear-on-overflow on both — a karaoke cold start re-warms
// in one frame.
export const _LYRIC_MEASURE_OUTER_MAX = 16;

export const _LYRIC_MEASURE_INNER_MAX = 4096;

// Rendering config
export const VISIBLE_SECONDS = 3.0;

export const Z_CAM = 2.2;

export const Z_MAX = 10.0;

export const BG = '#080810';

// String color palettes. Indices 0–5 cover guitar / bass; 6–7
// are added for extended-range GP imports (7-string, 8-string).
// Lookups still use `|| '#888'` as a safety fallback for any
// out-of-range index.
//
// These are `let`, not `const`: setStringColors() (used by the core
// "Highway String Colors" theming UI) overrides per-index entries at
// runtime, deriving the dim/bright variants from the chosen base color.
// DEFAULT_* keep the originals so a reset restores them byte-for-byte.
export const DEFAULT_STRING_COLORS = [
    '#cc0000', '#cca800', '#0066cc',
    '#cc6600', '#00cc66', '#9900cc',
    '#cc00aa', '#00cccc',  // 7th = magenta, 8th = teal
];

export const DEFAULT_STRING_DIM = [
    '#520000', '#524200', '#002952',
    '#522900', '#005229', '#3d0052',
    '#520042', '#005252',
];

export const DEFAULT_STRING_BRIGHT = [
    '#ff3c3c', '#ffe040', '#3c9cff',
    '#ff9c3c', '#3cff9c', '#cc3cff',
    '#ff3ce0', '#3ce0e0',
];

export const MAX_RENDERER_DRAW_FAILURES = 3;

// ── Chord rendering — chains, frames, fretline preview (feedBack#88) ──
//
// Charts often repeat the same chord shape several times in a
// row (e.g. a G strummed 4 times). We call a contiguous run of same-id
// chords with gaps < CHAIN_GAP_THRESHOLD a "chain". Chains drive two
// visual choices:
//   • The first chord in a chain renders in full; subsequent chords in
//     a chain of CHAIN_RENDER_FULL_MAX or longer render as a "repeat
//     box" — a translucent boxed frame so the eye can see the rhythm
//     pattern without re-scanning identical fret numbers.
//   • Each chord anchors a CHORD_FRAME_FRETS-wide frame; muted and
//     open-only chords inherit the frame from their predecessor so
//     they don't snap to fret 0.
//
// We compute chain stats and frame anchors once per `src` array via
// _ensureChordRenderCache (lazy, invalidates when the array reference
// changes — which happens on chord ingest, mastery rebuild, or song
// reset). The render path is then pure read.
export const CHAIN_GAP_THRESHOLD = 0.5;

export const CHAIN_RENDER_FULL_MAX = 4;

export const CHORD_FRAME_FRETS = 4;

// Fretline preview: the static fret line at the bottom shows the chord
// closest to the strum line (currentTime + FRETLINE_TARGET_OFFSET) within
// the [target - FRETLINE_WINDOW_BEFORE, target + FRETLINE_WINDOW_AFTER]
// window, as a teaching aid.
export const FRETLINE_TARGET_OFFSET = -0.25;

export const FRETLINE_WINDOW_BEFORE = 0.1;

export const FRETLINE_WINDOW_AFTER = 0.3;

// Repeat / mute box colors.
export const REPEAT_BOX_FILL = 'rgba(48, 80, 128, 0.06)';

export const REPEAT_BOX_BAR = '#50a0dc';

export const MUTE_BOX_STROKE = '#6060809b';

export const MUTE_BOX_BAR = '#606080d1';
