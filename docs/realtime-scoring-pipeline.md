# Real-time scoring pipeline

This doc traces how a single audio sample becomes a lit-up gem on the highway. It exists because the path crosses five layers — native engine, IPC bridge, `note_detect` plugin, highway core, renderer — and the contract between them is currently spread across `slopsmith/CLAUDE.md`, `slopsmith-desktop/`, and four different plugin source files.

**Audience**: plugin authors building a visualization that wants to react to detected hits, and maintainers debugging why a gem isn't lighting up.

**Companion docs**
- [`note-state-provider.md`](note-state-provider.md) — the `setNoteStateProvider` / `bundle.getNoteState` API contract, in isolation.
- [`visualization-feedback-guide.md`](visualization-feedback-guide.md) — a practical "how do I add hit feedback to my custom viz" walkthrough.
- `slopsmith-desktop/docs/audio-engine-architecture.md` (companion repo) — internals of the JUCE engine + ML detector that produce the verdicts this pipeline consumes.

## Pipeline at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│  slopsmith-desktop (native, JUCE + ONNX + Basic Pitch)               │
│                                                                      │
│  audio device → ring buffer → ┌─ PitchDetector (YIN)                 │
│                               ├─ MlNoteDetector (Basic Pitch / ONNX) │
│                               ├─ ChordScorer  (FFT + harmonic comb)  │
│                               └─ NoteVerifier (background thread)    │
│                                       │                              │
└───────────────────────────────────────┼──────────────────────────────┘
                                        │ IPC (Electron preload)
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  note_detect plugin  (slopsmith/plugins/note_detect/screen.js)       │
│                                                                      │
│   drain audio:getNoteVerdicts(songTime, playing)                     │
│   (or fall back to browser matchNotes + audio:scoreChord)            │
│        │                                                             │
│        ▼                                                             │
│   noteResults Map keyed by `${time}_${string}_${fret}`               │
│        │                                                             │
│        ├─► window.slopsmith.emit('note:hit' | 'note:miss', judgment) │
│        │                                                             │
│        └─► highway.setNoteStateProvider(noteStateFor)                │
└───────────────────────────────────────┬──────────────────────────────┘
                                        │
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  highway core  (slopsmith/static/highway.js)                         │
│                                                                      │
│   bundle.getNoteState(note, chartTime) → null                        │
│                                       │ 'hit'  | 'active' | 'miss'   │
│                                       │ { state, alpha, color }      │
└───────────────────────────────────────┬──────────────────────────────┘
                                        │ per visible note, per frame
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Renderer (built-in 2D, bundled 3D, or your custom viz)              │
│                                                                      │
│   draw(bundle) {                                                     │
│       for (const n of bundle.notes) {                                │
│           const st = bundle.getNoteState(n, n.t);                    │
│           // light gem, sustain, sparkle …                           │
│       }                                                              │
│   }                                                                  │
└──────────────────────────────────────────────────────────────────────┘
```

Two facts shape every other detail:

1. **Verdicts are produced once and consumed many times.** A renderer must not call `audio:scoreChord` itself. Scoring runs once in the engine (or in `note_detect`'s browser fallback) and the resulting per-note state is published through a single, idempotent provider. Renderers read the provider in their `draw()` loop and that's it.
2. **The chord-time semantic is load-bearing.** Chord constituents are keyed in `noteResults` as `${chordTime}_${string}_${fret}`. A renderer that passes a per-constituent timestamp instead of the chord's `t` will look up nothing and silently render dim gems. See [`note-state-provider.md`](note-state-provider.md) for the rule.

## Layer 1 — Native engine

In normal desktop sessions, scoring runs in C++ on a JUCE audio thread + a background verifier thread, not in JavaScript. The architecture doc in the companion repo covers internals; the surface area visible to JS is:

| IPC method | Purpose | Cadence on the JS side |
|---|---|---|
| `audio:setChart(chart)` | Push the active arrangement once per song / arrangement switch. | Once per `playSong()`. |
| `audio:getNoteVerdicts(songTime, playing)` | Drain finalized per-note verdicts AND push the renderer's playhead. | ~20 Hz (the `detectInterval` tick). |
| `audio:getPitchDetection()` | Monophonic dominant pitch (YIN or ML, whichever is ready). | ~20 Hz. |
| `audio:scoreChord(ctx)` | One-shot polyphonic score against the engine's input ring. | Per chord event during matching (fallback path). |
| `audio:detectNotes()` | Full ML active-pitch set: `{notes: [{midi, confidence, onsetMs, onsetSeq}], sampleRate}`. | Optional; only the diagnostic / ML-aware code paths use it. |
| `audio:isMlNoteDetection()` | `true` when Basic Pitch is loaded and ready. | Once at startup. |

All of these are feature-detected (`typeof audio.getNoteVerdicts === 'function'`) so the renderer keeps working against a downlevel addon.

Handlers live in [`audio-bridge.ts`](../../slopsmith-desktop/src/main/audio-bridge.ts) (in the `slopsmith-desktop` repo). Look for the `ipcMain.handle('audio:setChart', ...)`, `'audio:getNoteVerdicts'`, etc. blocks around lines 500–560.

## Layer 2 — `note_detect` plugin

`note_detect` is the only consumer of those IPC methods today. Everything downstream consumes `note_detect`'s output, not the engine's output directly. There are **two paths** through this layer; the engine path is preferred on desktop, the browser path is the fallback.

### Engine-verifier path (modern, desktop only)

On `playSong()`, `note_detect` calls `audio:setChart(arrangementChart)` and then polls `audio:getNoteVerdicts(songTime, playing)` on the detect tick. The verifier in C++ has already scored each chart note against the audio ring (using harmonic-comb + onset detection); each call returns the verdicts that have finalized since the last drain.

Each verdict has the shape:

```js
{
    id: string,                // chart-note id assigned at setChart time
    detected: boolean,         // hit or miss
    detectedSongTime: number,  // when the engine saw the onset
    centsError: number,        // cents off the expected pitch
    snr: number                // confidence-ish signal:noise ratio
}
```

`note_detect` translates each verdict into its internal `judgment` shape and writes it into `noteResults`, keyed `${chartNote.t}_${chartNote.s}_${chartNote.f}` for single notes, and `${chord.t}_${cn.s}_${cn.f}` for each chord constituent. Chord-level verdicts also write a chord-time-only entry `${chord.t}_chord` used for chord-frame tint.

### Browser fallback path (legacy / non-desktop)

If the desktop bridge isn't available (web build, downlevel addon, audio engine stopped), the same plugin runs the entire pipeline in the browser:

1. `getUserMedia` → `AudioContext` → `ChannelSplitterNode` → `ScriptProcessor` (per-channel mono).
2. Per-frame YIN pitch detect + onset gate.
3. `matchNotes()` — windowed match between detected events and chart notes (timing tolerance + pitch tolerance from settings).
4. For chord events: `_ndScoreChord()` runs a renderer-side FFT + band-energy scorer on the accumulated buffer.

Either way, the result lands in `noteResults` with the same keys, and the downstream consumers don't care which path produced it.

### Publishing

Two channels:

```js
// 1. Global event (for stats panels, journaling plugins, etc.)
window.slopsmith.emit(judgment.hit ? 'note:hit' : 'note:miss', judgment);

// 2. Per-note state provider (for the highway + renderers)
highway.setNoteStateProvider(noteStateFor);
```

The provider function `noteStateFor(note, chartTime)` reads `noteResults` and returns one of:

| Return | Meaning |
|---|---|
| `null` (or anything falsy) | No state — renderer draws this note normally. |
| `'hit'` | Note was struck cleanly. Fade owned by the provider. |
| `'active'` | Sustained note currently still being held on-pitch. |
| `'miss'` | Note expired without a clean detection. |
| `{ state, alpha, color }` | Object form — same `state` field, plus explicit `alpha` (0..1) and optional `color` override. |

The full contract — including the keying rules and sustain semantics — is in [`note-state-provider.md`](note-state-provider.md).

## Layer 3 — Highway core

The highway exposes the provider to renderers via the per-frame `bundle` passed to `draw(bundle)`. The relevant lines in [`static/highway.js`](../static/highway.js):

- The provider slot itself: `let _noteStateProvider = null;` at line 153.
- The normalizer that the bundle exposes: `function _noteState(note, chartTime) { … }` at line 290. This catches exceptions thrown by the provider, validates the `state` is one of `'hit'/'active'/'miss'`, clamps `alpha` to `[0, 1]`, drops zero-alpha returns, and returns `null` otherwise.
- The bundle field: `getNoteState: _noteState` (line 514) — a **stable reference**, no per-frame allocation. Custom renderers can safely cache it.
- The API method: `setNoteStateProvider(fn)` on the highway's exported object (line 2974). Last writer wins; passing `null` clears the provider.

The built-in 2D renderer consumes the provider in three places — `drawNote` (line 1445), `drawSustains` (line 1364), and the chord-frame path (line 1655) — so the default visuals work as soon as `note_detect` is enabled, without any per-plugin wiring.

## Layer 4 — Renderer

In your renderer's `draw(bundle)`, the typical pattern is:

```js
draw(bundle) {
    for (const n of bundle.notes) {
        const state = bundle.getNoteState(n, n.t);  // n.t for single notes
        if (state) {
            // state.state is 'hit' | 'active' | 'miss'
            // state.alpha is 0..1 (provider-owned decay)
            // state.color is optional string override
            drawLitGem(n, state);
        } else {
            drawDimGem(n);
        }
    }
    for (const ch of bundle.chords) {
        for (const cn of ch.notes) {
            const state = bundle.getNoteState(cn, ch.t);  // ch.t, NOT cn.t
            // …
        }
    }
}
```

Two patterns the bundled renderers use that you can copy:

- **2D highway** ([`static/highway.js`](../static/highway.js) `drawNote` at line 1445): `'hit'`/`'active'` → bright string color + additive halo + sparkle. `'miss'` → faint red wash. Sustain trail brightens with `'active'`.
- **3D highway** ([`plugins/highway_3d/screen.js`](../plugins/highway_3d/screen.js) — search for `getNoteState`): outline mesh + body switch from dim material (`mStr[s]`) to bright (`mGlow[s]`); sustained notes keep the glow while `'active'`; a contained sparkle is queued on the 2D overlay layer.

For a from-scratch viz, [`visualization-feedback-guide.md`](visualization-feedback-guide.md) has a minimal Canvas2D example.

## Concrete trace: strumming a C major at chart time 12.34 s

Chart event: a `chord` at `t = 12.34` with three constituents — strings 1 (B), 2 (G), 3 (D) at frets `(1, 0, 2)`.

1. **t ≈ 12.30 s**: the player strums. The audio thread captures samples into `inputFrameRing`. The Basic Pitch ML detector publishes `B3`, `G3`, `D3` as active pitches; the `NoteVerifier` thread, which has had the chart since `playSong()`, opens scoring windows around `t = 12.34` for each chord-note (`12.34 ± timingTolerance`).
2. **t ≈ 12.34 s**: Each open-window note's harmonic comb confirms the expected pitch present. The verifier closes the windows shortly after `12.34 + timingTolerance` and pushes three verdicts onto the drain queue: `{detected: true, detectedSongTime: 12.31, centsError: +4, snr: 5.3}` for each.
3. **t ≈ 12.39 s**: `note_detect`'s detect tick calls `audio:getNoteVerdicts(12.39, true)`. It receives the three verdicts, builds three `judgment` objects, writes:
   - `noteResults["12.34_1_1"] = { hit: true, … }`
   - `noteResults["12.34_2_0"] = { hit: true, … }`
   - `noteResults["12.34_3_2"] = { hit: true, … }`
   - `noteResults["12.34_chord"] = { hit: true, hitStrings: 3, totalStrings: 3, … }`
   - Emits `window.slopsmith.emit('note:hit', judgment)` for the chord.
4. **Next rAF**: the renderer's `draw(bundle)` iterates `bundle.chords`. For the chord at `t = 12.34` it calls `bundle.getNoteState(cn, 12.34)` for each constituent. Each call resolves `noteStateFor(cn, 12.34)`, which looks up `noteResults["12.34_${cn.s}_${cn.f}"]`, finds a recent `hit`, returns `{ state: 'hit', alpha: ~1, color: null }`.
5. **2D renderer**: each gem in the chord renders with bright string color + halo + sparkle. The chord-frame tint goes green.
6. **3D renderer (if active)**: outline + body swap to `mGlow[s]`; a sparkle entry is queued for each gem on the 2D overlay layer; the chord frame box tints green.
7. **Over the next ~300 ms**: `noteStateFor` returns a decaying `alpha` (provider-owned fade). When `alpha` drops below the floor, it returns `null` and the gems revert to dim.

If any string had been missed (say string 3 silent because of an over-aggressive mute), step 2 would have closed that window with `detected: false`. `noteResults["12.34_3_2"]` would be a `miss`, the chord-frame verdict would still be `hit` (any-constituent-hit rule per [PR #316](https://github.com/byrongamatos/slopsmith/pull/316)), and the renderer would paint string 3 with the miss wash while the others lit up.

## Where to look next

If you want to…

- **Build a custom viz that reacts to hits** → [`visualization-feedback-guide.md`](visualization-feedback-guide.md).
- **Understand the provider contract in full** (semantics of `alpha`, key formats, sustain rules) → [`note-state-provider.md`](note-state-provider.md).
- **Dig into the engine internals** (NoteVerifier thread, ML detector loading, ring buffer) → `slopsmith-desktop/docs/audio-engine-architecture.md` in the companion repo.
- **Tune detection quality** (false misses, latency, A/V offset) → [`note-detect-tuning.md`](note-detect-tuning.md).
- **Read the canonical setRenderer contract** → [`../CLAUDE.md`](../CLAUDE.md) § "Visualization plugins".

## Key files

| File | Role |
|---|---|
| `slopsmith-desktop/src/audio/AudioEngine.cpp:1447` | Audio device callback — entry point for every input sample. |
| `slopsmith-desktop/src/audio/AudioEngine.h:196` | `inputFrameRing` declaration (lock-free SPSC, 8192 samples). |
| `slopsmith-desktop/src/audio/NoteVerifier.cpp:152` | Background verifier thread loop. |
| `slopsmith-desktop/src/audio/NoteVerifier.cpp:52` | `setChart()` — push the active arrangement. |
| `slopsmith-desktop/src/main/audio-bridge.ts` | IPC handlers (look for `audio:setChart`, `audio:getNoteVerdicts`, `audio:scoreChord`). |
| `slopsmith/plugins/note_detect/screen.js` | `noteResults` map, `noteStateFor`, `setNoteStateProvider` registration, verdict drain loop. |
| `slopsmith/static/highway.js:153` | `_noteStateProvider` slot. |
| `slopsmith/static/highway.js:290` | `_noteState()` normalizer (catches exceptions, clamps alpha, validates state). |
| `slopsmith/static/highway.js:514` | `getNoteState: _noteState` bundle field. |
| `slopsmith/static/highway.js:2974` | `setNoteStateProvider` on the public highway API. |
