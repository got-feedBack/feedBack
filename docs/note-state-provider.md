# Note-state provider API

The contract that lets a scorer (today: `note_detect`) tell every renderer (today: built-in 2D, bundled 3D, anything you build) when a chart note has been **hit / actively held / missed**.

Introduced in [slopsmith#254](https://github.com/byrongamatos/slopsmith/issues/254). See [`realtime-scoring-pipeline.md`](realtime-scoring-pipeline.md) for how data flows into the provider; this doc focuses on the API itself.

**Audience**: plugin authors who want to either (a) **register** as the scorer (replacing `note_detect`), or (b) **read** per-note state from a custom visualization.

## The API in one minute

Two endpoints on the `highway` object, one bundle field exposed to renderers:

```js
// Producer side (a scorer plugin)
highway.setNoteStateProvider((note, chartTime) => {
    // return null / 'hit' / 'active' / 'miss' / { state, alpha, color }
});
highway.getNoteStateProvider();        // current provider, or null
highway.setNoteStateProvider(null);    // clear

// Consumer side (inside your renderer's draw)
const st = bundle.getNoteState(note, chartTime);   // same return shape
```

**One provider at a time** — last writer wins. There's no event-emitter / multi-subscriber pattern; the contract is deliberately singular so the renderer's per-frame call is allocation-free and unambiguous. If two scorer plugins coexist, the second one's `setNoteStateProvider` call replaces the first.

The provider is called **per visible note, per frame, from the renderer's `draw()` loop**. Keep it cheap — a typical highway can have 30+ visible gems per frame across 60 fps. The bundled `note_detect` provider does one Map lookup + a few arithmetic operations.

## Return values

| Return | Meaning | When to use |
|---|---|---|
| `null` / `undefined` / `false` / `0` / `""` | No state for this note this frame. Renderer draws it normally. | The vast majority of returns. Default for unstruck notes, expired effects, notes the scorer doesn't know about. |
| `'hit'` | Note was struck cleanly. | Right after a successful detection, while the brief post-strike glow is visible. |
| `'active'` | A sustained note is *currently being held on-pitch*. | While a sustain trail should glow. Re-emit every frame the hold is still valid; stop returning state when the sustain ends. |
| `'miss'` | Note expired without a clean detection. | After the scoring window closed and no hit was registered. |
| `{ state, alpha, color }` | Full object form. Same `state`. Adds `alpha` (0..1 brightness multiplier) and optional `color` override. | Whenever you want a custom fade or to tint with something other than the renderer's default string colour. |

### `alpha`

A brightness multiplier in `[0, 1]`. **The provider owns the fade.** The renderer doesn't track timestamps or decay; it just renders whatever brightness you return.

- Returning a bare string (`'hit'`) is equivalent to `{ state: 'hit', alpha: 1, color: null }`.
- Returning `{ state: 'hit', alpha: 0 }` is the same as returning `null` — the highway clamps it and drops the result before the renderer sees it. Use this as a clean way to signal "stop rendering" without changing your control flow.
- Out-of-range numbers are clamped to `[0, 1]`. Non-finite (`NaN`, `Infinity`) falls back to `1`.

### `color`

Optional CSS-style colour string (e.g., `'#7ef'`, `'rgb(255, 90, 90)'`). When present, the renderer uses it instead of the default string colour for the lit gem / sustain trail. When absent or non-string, the renderer keeps its default palette.

## What the highway does to your return value

[`static/highway.js`](../static/highway.js) line 290:

```js
function _noteState(note, chartTime) {
    if (!_noteStateProvider) return null;
    let raw;
    try { raw = _noteStateProvider(note, chartTime); } catch (e) { return null; }
    if (!raw) return null;
    const state = typeof raw === 'string' ? raw : raw.state;
    if (state !== 'hit' && state !== 'active' && state !== 'miss') return null;
    const alpha = (raw && typeof raw === 'object' && Number.isFinite(raw.alpha))
        ? Math.max(0, Math.min(1, raw.alpha))
        : 1;
    if (alpha <= 0) return null;
    const color = (raw && typeof raw === 'object' && typeof raw.color === 'string') ? raw.color : null;
    return { state, alpha, color };
}
```

Practical implications:

- **Provider exceptions are swallowed.** If your provider throws, the renderer sees `null` for that note this frame. The next frame's call is independent. Cleanest for the renderer (no draw stall), trickiest for the provider author (no console signal that something's wrong). Log inside your provider if you need to diagnose.
- **Invalid `state` strings return `null`.** Typos like `'Hit'` or `'hits'` are silently rejected. The renderer keeps drawing the note dim.
- **`alpha === 0` returns `null`.** The dim-render path is what you want here anyway; this is the cleanest exit.
- **Renderers receive the normalized object** (`{ state, alpha, color }`) or `null`. They never see your raw return value, so feel free to return shorthands.

## How to call `bundle.getNoteState` from a renderer

The bundle passed to `draw(bundle)` carries a stable reference (`getNoteState: _noteState` — same function every frame, never reallocated). You can cache it on the renderer instance:

```js
init(canvas, bundle) {
    this.ctx = canvas.getContext('2d');
    this.getNoteState = bundle.getNoteState;   // safe to cache the function ref
},
draw(bundle) {
    for (const n of bundle.notes) {
        const st = this.getNoteState(n, n.t);
        if (st && st.state === 'hit') /* paint bright */;
    }
}
```

### Two pitfalls when calling it

1. **Pass `chord.t`, not `cn.t`, for chord constituents.** Chord constituents are keyed in the producer by the chord's time, not the constituent's. (Most chart formats give the constituent the same `t` as the chord anyway, but the contract is explicit and you should follow it.)
   ```js
   for (const ch of bundle.chords) {
       for (const cn of ch.notes) {
           const st = bundle.getNoteState(cn, ch.t);  // ← ch.t
       }
   }
   ```
2. **Don't cache the return value across frames.** It encodes a fade. Re-call every frame.

## How to register as a provider

```js
function myNoteStateFor(note, chartTime) {
    // note: { t, s, f, sus, … }  — chart note object (or a chord constituent)
    // chartTime: number — `t` for single notes, the chord's `t` for chord constituents
    const verdict = myStore.lookup(`${chartTime}_${note.s}_${note.f}`);
    if (!verdict) return null;
    const age = performance.now() - verdict.timestamp;
    if (age > 800) return null;            // owned fade — drop after 800 ms
    return {
        state: verdict.hit ? 'hit' : 'miss',
        alpha: Math.max(0, 1 - age / 800),  // linear fade
    };
}

// Mount on every highway in the session. In a typical plugin:
//   - call once on `song:ready`, after `createHighway()` has wired the panel
//   - call again whenever a new panel mounts (splitscreen)
highway.setNoteStateProvider(myNoteStateFor);
```

To play nicely with other plugins (or with `note_detect`'s default registration), check what's already there:

```js
const existing = highway.getNoteStateProvider();
if (existing == null) {
    highway.setNoteStateProvider(myNoteStateFor);
} else {
    // Decide: chain (fallback to existing if you return null),
    // replace (existing.foo behaviour is lost), or abort.
}
```

## Keying conventions used by `note_detect`

If your provider is replacing or extending `note_detect`'s, match its key format:

| Note shape | Key in `noteResults` |
|---|---|
| Single note at `t = 12.34`, string `s`, fret `f` | `"12.34_{s}_{f}"` |
| Chord constituent (chord at `t = 12.34`, constituent string `s`, fret `f`) | `"12.34_{s}_{f}"` — keyed by **chord time**, not constituent time |
| Chord-frame verdict for that chord | `"12.34_chord"` |

The string interpolation uses the chart's `t` directly (no rounding, no string coercion beyond `${}`). Don't `.toFixed(2)` it — small floating-point drift between chord and constituent `t` values would create a key mismatch.

## Sustain state — `'hit'` vs `'active'`

Both are "lit" states; the difference is *who owns the fade*:

- `'hit'`: the gem was struck cleanly. The provider returns this once per frame, decaying `alpha` over a few hundred ms, then returns `null` when the glow should end.
- `'active'`: a sustained note (one with `sus > 0`) is currently being held on-pitch. The provider keeps returning `{ state: 'active', alpha: 1 }` every frame as long as the hold is valid. When the hold ends (pitch slipped, sustain expired, song paused), the provider stops returning state.

A renderer typically treats both the same way visually — bright gem, bright sustain trail — but `'active'` differs in *duration*: it stays for as long as the hold lasts (potentially seconds), while `'hit'` is a short post-strike glow.

`note_detect` tracks the on-pitch state of held sustains in a `_susActiveUntil` Map (key → `performance.now()` when the grace window ends). A typical grace window is 30 ms (one or two pitch frames), so a brief audio gap during a sustained note doesn't kill the glow.

## Common pitfalls

1. **Provider returns truthy forever → gem stays lit forever.** Always return `null` when the effect should end. The renderer has no other way to know.
2. **Provider tracks fade in renderer state instead.** Don't. The provider is consulted by *every* renderer and you'd end up with mismatched fades on each. Owns-its-own-decay is the design.
3. **Renderer passes a per-constituent `t` instead of the chord's.** Silent failure — the lookup misses, all chord gems render dim. See the second pitfall above.
4. **Calling `setNoteStateProvider` once at module load.** The highway might not exist yet, or a later splitscreen panel might create another highway. Re-register on every `song:ready` and every new panel mount.
5. **Renderer caches the bundle.** Bundle arrays are live references but the object itself is constructed per frame for some fields. Don't hold `let myBundle = bundle` across frames. Caching the function ref `bundle.getNoteState` is fine — it's stable.
6. **Provider does heavy work per call.** It runs O(visible notes × FPS) — typically 1000+ calls/sec during dense passages. A Map lookup is fine; a regex / JSON parse / sort is not.

## Where to look next

- [`realtime-scoring-pipeline.md`](realtime-scoring-pipeline.md) — full data flow from audio → verdict → provider.
- [`visualization-feedback-guide.md`](visualization-feedback-guide.md) — practical "how do I add this to my viz" walkthrough with a minimal 2D Canvas example.
- [`../plugins/note_detect/`](../plugins/note_detect/) — the canonical producer. Search `screen.js` for `setNoteStateProvider` and `noteStateFor`.
- [`../plugins/highway_3d/screen.js`](../plugins/highway_3d/screen.js) — canonical custom-renderer consumer. Search for `getNoteState`.
- [`../CLAUDE.md`](../CLAUDE.md) § "Note-state provider" — the short version of this doc embedded in the plugin-system overview.
