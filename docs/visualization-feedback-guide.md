# Adding hit feedback to a visualization

A practical guide to making your custom visualization light up when notes are hit, dim when they're missed, and stay glowing while sustained notes are held correctly.

**Audience**: you're building a visualization plugin (per [`../CLAUDE.md`](../CLAUDE.md) § "Visualization plugins") and you want it to react to detected hits the same way the built-in 2D and 3D highways do.

**Prerequisites**
- You can already get a `setRenderer`-style plugin loading. (If not, start with [`../CLAUDE.md`](../CLAUDE.md) — that contract is the entry point.)
- You've skimmed [`realtime-scoring-pipeline.md`](realtime-scoring-pipeline.md). You don't need to understand the engine internals, just the shape of `bundle.getNoteState`.
- `note_detect` is enabled in your test setup. Without it, the provider stays unregistered and `bundle.getNoteState` returns `null` for everything — your viz will work but you won't see feedback.

## The whole contract, in 5 lines

```js
draw(bundle) {
    for (const n of bundle.notes) {
        const st = bundle.getNoteState(n, n.t);   // for single notes, pass n.t
        // st is null | { state: 'hit' | 'active' | 'miss', alpha: 0..1, color: string|null }
    }
    for (const ch of bundle.chords) {
        for (const cn of ch.notes) {
            const st = bundle.getNoteState(cn, ch.t);  // for chord constituents, pass CHORD time
            // …
        }
    }
}
```

That's it. The full semantics — when the provider fires, who owns fade timing, what the keys are — are in [`note-state-provider.md`](note-state-provider.md). This doc is about how to use them.

## Minimal 2D Canvas example

A complete `setRenderer`-style plugin that draws each chart note as a circle, lit up when hit, with a green halo for active sustains and a red wash for misses. ~80 lines, no dependencies. Drop it in `plugins/my_viz/screen.js` along with a matching `plugin.json` (`"type": "visualization"`).

```js
(function () {
    'use strict';

    window.slopsmithViz_my_viz = function () {
        let ctx = null;
        let W = 0, H = 0;

        return {
            contextType: '2d',

            init(canvas, bundle) {
                ctx = canvas.getContext('2d');
                W = canvas.width;
                H = canvas.height;
            },

            resize(w, h) {
                W = w; H = h;
            },

            draw(bundle) {
                if (!ctx) return;
                ctx.clearRect(0, 0, W, H);

                const now = bundle.currentTime;
                const stringCount = bundle.stringCount || 6;

                // Project a chart time onto x. Notes ahead of `now` slide
                // in from the right; notes behind `now` slide off left.
                const xFor = (t) => W * 0.5 + (t - now) * 100;
                const yFor = (s) => H * (0.2 + 0.6 * (s / (stringCount - 1)));

                // Single notes.
                for (const n of bundle.notes) {
                    const x = xFor(n.t);
                    if (x < -50 || x > W + 50) continue;   // off-screen cull
                    const y = yFor(n.s);
                    const st = bundle.getNoteState(n, n.t);
                    drawGem(ctx, x, y, n, st);
                }

                // Chord constituents — pass CHORD time, not constituent time.
                for (const ch of bundle.chords) {
                    const x = xFor(ch.t);
                    if (x < -50 || x > W + 50) continue;
                    for (const cn of ch.notes) {
                        const y = yFor(cn.s);
                        const st = bundle.getNoteState(cn, ch.t);
                        drawGem(ctx, x, y, cn, st);
                    }
                }
            },

            destroy() {
                ctx = null;
            },
        };
    };

    function drawGem(ctx, x, y, note, st) {
        const r = 12;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);

        if (!st) {
            // Dim — no judgment yet (or expired).
            ctx.fillStyle = '#445';
            ctx.fill();
            return;
        }

        // Lit. `alpha` is provider-owned fade.
        const a = st.alpha;
        if (st.state === 'hit' || st.state === 'active') {
            ctx.fillStyle = st.color || `rgba(120, 220, 140, ${a})`;
            ctx.fill();
            // Halo grows with brightness — purely cosmetic.
            ctx.beginPath();
            ctx.arc(x, y, r + 6 * a, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(120, 220, 140, ${a * 0.5})`;
            ctx.lineWidth = 2;
            ctx.stroke();
        } else if (st.state === 'miss') {
            ctx.fillStyle = `rgba(220, 90, 90, ${a})`;
            ctx.fill();
        }
    }
})();
```

Things this example deliberately skips:

- **Sustain trails.** Add a `ctx.fillRect` from `xFor(n.t)` to `xFor(n.t + n.sus)` and switch its colour based on the `'active'` state.
- **Inverted / lefty.** Check `bundle.inverted` and `bundle.lefty` and mirror your y-axis / x-axis transforms.
- **Difficulty filter awareness.** `bundle.notes` is already filtered — you get this for free.
- **Capo / tuning offsets.** Not needed for visualization; the gems just show the chart positions.

## Case study — how the 3D highway does it

[`../plugins/highway_3d/screen.js`](../plugins/highway_3d/screen.js) is the canonical custom renderer. It uses the same `bundle.getNoteState(note, chartTime)` call, but applied to Three.js materials.

The cliff notes (search the file for `getNoteState` to find each call site):

- For each visible note, the 3D highway calls `bundle.getNoteState(n, n.t)` (or `ch.t` for chord constituents).
- A non-null return switches the gem's outline mesh from `mStr[s]` (dim, dull string colour) to `mGlow[s]` (bright emissive). The body mesh is swapped the same way.
- Sustain trails use the bright material while `'active'`, the dim one otherwise.
- A separate sparkle layer (`drawNotedetectSizzle()` on the 2D overlay canvas) queues a few crackling arcs and dots projected through the camera, fading with `st.alpha`. The 3D highway runs this on its 2D *overlay* canvas, not in the 3D scene, so the sparkles don't blow out the bloom or get hidden behind world geometry.
- Chord-frame tint: when the chord-level entry (`${chord.t}_chord`) is `hit`, the chord-frame box tints green; on miss, it tints red. Per-constituent verdicts still drive the individual gem visuals so a partial-hit chord shows the frame green with individual constituents lit or dim.

Two implementation details worth copying:

1. The 3D highway caches `bundle.getNoteState` once per frame — `const getNs = bundle.getNoteState;` — and uses the cached ref for the inner loops. The function reference is stable across frames, so this is safe and saves a property read per gem.
2. It null-guards every consumption (`if (st && st.state === 'hit')`) rather than relying on `st.state` to be defined. `null` is the common case — a single visible chord with 30 unstruck notes ahead of the playhead produces 30 null returns and 0 lit returns.

## Troubleshooting

### "I see no lit gems at all"

In order of likelihood:

1. **`note_detect` isn't running.** Open DevTools console and run:
   ```js
   window.highway && window.highway.getNoteStateProvider()
   ```
   If it returns `null`, no scorer is registered. Click the "Detect" button in the player controls (or enable it via your test fixture).
2. **Your renderer isn't calling `bundle.getNoteState`.** Add a `console.log(st)` inside the loop. If you never see anything other than `null`, the provider is registered but you might be on a song with no scoring events yet (try strumming and watch the console).
3. **You're passing the wrong `chartTime`.** Chord constituents need `chord.t`, not `cn.t`. Easy to miss if your inner loop reuses a variable named `t`.
4. **Your renderer's `draw()` isn't firing.** Make sure the highway has had a `ready` message — `bundle.isReady` should be `true`. The factory gates `draw()` calls behind the ready flag.

### "Single notes light up but chord notes don't"

You're almost certainly passing `cn.t` instead of `ch.t` to `getNoteState`. The lookup map is keyed by the chord's time. Most chord constituents have the same `t` as the chord, but the contract still requires the chord time explicitly — and there are chart formats where constituent `t` values drift slightly.

### "Notes light up but never fade — they stay green forever"

The provider — not your renderer — owns fade timing. If you've replaced `note_detect` with your own provider and it returns a truthy state forever, gems stay lit forever. Return `null` when the effect should end. See [`note-state-provider.md`](note-state-provider.md) § "`alpha`" for how to encode a fade.

### "Sustains don't glow while held"

The provider needs to return `'active'` (not `'hit'`) for as long as the held pitch is detected. Check whether the producer in use (`note_detect` on desktop) is tracking sustain state — it does, via `_susActiveUntil`, but only when monophonic pitch detection is enabled and on-pitch within the configured cents tolerance. If your audio is noisy or the cents tolerance is tight, sustains may decay to `null` between frames.

### "My splitscreen panels all light up the same notes at the same time"

Two things might be going on:

1. **Two panels are scoring the same audio input.** Each `note_detect` instance currently shares the engine's single-source detection. See [issue #375](https://github.com/byrongamatos/slopsmith/issues/375) for the RFC on per-source detection. Until that lands, the fact that both panels light identically is expected.
2. **Each panel's highway has its own provider slot.** If you're building a plugin that replaces the provider, register it on each panel's highway instance, not on a global. Splitscreen creates one highway per panel — `setNoteStateProvider` is per-highway.

### "My renderer prints `TypeError: bundle.getNoteState is not a function`"

The bundle field has been part of the contract since slopsmith#254. If `bundle.getNoteState` is missing, the host slopsmith you're running against predates that issue — you're on an old build. Check the version with `cat VERSION` in the slopsmith repo; anything ≥ 0.2 should have it. The field is set to a stable reference, never undefined.

### "I want to draw something on hit that isn't a gem (a particle burst, a sound, anything)"

Two options:

1. **Subscribe to events from inside your renderer.** `window.slopsmith.on('note:hit', judgment => { … })`. The judgment object has the chord/note info, timing/pitch error, etc. Fires once per detection, not per frame. Good for one-shots (sounds, screen shakes, achievement triggers).
2. **Watch for state transitions in your draw loop.** Cache the last-seen state per note key in your renderer; when this frame's state changes from `null` to truthy, you know an event just landed. Good for cumulative effects (particle bursts that need to know their start time).

The provider doesn't itself give you an event stream — it gives you a sample-per-frame view of current state. Pick the right tool for your effect.

## Where to look next

- [`realtime-scoring-pipeline.md`](realtime-scoring-pipeline.md) — full data flow, top to bottom.
- [`note-state-provider.md`](note-state-provider.md) — the producer contract (write your own scorer).
- [`../CLAUDE.md`](../CLAUDE.md) — the canonical `setRenderer` / overlay contract.
- [`../plugins/highway_3d/screen.js`](../plugins/highway_3d/screen.js) — case-study renderer.
- [`note-detect-tuning.md`](note-detect-tuning.md) — what to do when detection itself is flaky (your viz works fine but the underlying hits / misses look wrong).
