# Coaching plugin

Turns each play into **actionable feedback**. It consumes note_detect's per-note
judgments, builds one structured `coaching.play_feedback.v1` object per play, and
(optionally) sends that to an LLM — using *your own* Anthropic API key, from the
browser — to produce a prioritized, encouraging practice plan.

The plugin never forks note_detect: it listens for the `notedetect:hit` /
`notedetect:miss` / `notedetect:session` window events and emits its own events
on the slopsmith bus. It also never sends your API key to the slopsmith server.

## Pipeline

```
notedetect:hit/miss  ──┐
                       ├─▶ buildPlayFeedback() ──▶ coaching:feedback  (+ window.__coachingLastFeedback)
notedetect:session  ──┘            │
                                   └─▶ requestCoaching()  (if a key is set)
                                          │
                                          ├─▶ session.summary  (the practice plan)
                                          └─▶ coaching:summary  (+ end-of-song panel, window.__coachingLastSummary)
```

## The contract: `coaching.play_feedback.v1`

Three levels — per-mistake atoms, hotspots that group them by reference, and a
session wrapper. The two load-bearing fields:

- **`mistake.faultVerdict`** (`player_error` | `detector_suspect` |
  `confirmed_detector_bug`) — routes a miss to *drill it* vs *feed it to the
  harness*. A detection that fired but was off → `player_error`. `no_detection`
  → `detector_suspect`, **unless** the miss carries a note-present signal
  (note_detect heard the pitch yet still scored a miss) → `confirmed_detector_bug`,
  set in-app; an external harness replay also sets it.
- **`hotspot.signal.kind`** (`systematic` | `random`) — a consistent skew
  (median clears a floor *and* dominates the spread) is a tool/calibration
  problem (e.g. an A/V offset), not a skill gap. Keeps the drill loop from
  training the player on the detector's blind spots.

See the schema + builder in [`coaching.js`](coaching.js); it's covered by
[`test/feedback-schema.test.js`](test/feedback-schema.test.js).

## The LLM coach (task #14)

`session.summary` is filled by a **client-side** Anthropic Messages API call:

- **Model** `claude-haiku-4-5` (cheapest tier while the flow is proven out —
  bumps to `claude-opus-4-8` once coaching quality is validated), a frozen +
  prompt-cached system prompt, and
  `output_config.format` (json_schema) so the reply parses deterministically.
- The request **distills** the feedback to the session block + hotspots +
  failure/fault tallies — raw mistake atoms are not sent.
- The system prompt teaches the model the two load-bearing fields above, so it
  routes systematic skews / `detector_suspect` misses into *tooling notes*
  instead of scolding the player.
- The key is read from `localStorage` and sent straight to Anthropic with the
  `anthropic-dangerous-direct-browser-access` header. **It never touches the
  slopsmith server.**

Pure pieces (`summarizeForCoach`, `buildCoachRequest`, `parseCoachSummary`,
`renderSummaryHtml`, `makeSettings`) and the fetch seam (`requestCoaching`, with
an injectable `fetchImpl`) are covered by [`test/coach.test.js`](test/coach.test.js).

### Summary shape

```jsonc
{
  "headline": "one-line encouraging takeaway",
  "priorities": [
    { "focus": "...", "why": "the evidence", "drill": "a concrete action", "hotspotKey": "song|arr|secRange" }
  ],
  "toolNotes": "systematic-skew / detector_suspect routing",
  "encouragement": "closing motivation",
  "_model": "claude-opus-4-8"
}
```

## Setup

Settings → **Coaching**: enable the coach and paste your Anthropic API key
(stored only in this browser). Or from the console:

```js
coaching.setApiKey('sk-ant-...');   // stored in localStorage, browser-only
coaching.setModel('claude-opus-4-8'); // optional; default is opus-4-8
coaching.setEnabled(true);
coaching.coachLast();               // re-run the coach on the last play
```

`localStorage` keys: `coaching.anthropicApiKey`, `coaching.model`,
`coaching.llmEnabled`.

## Events

| Event | Payload | When |
|---|---|---|
| `coaching:feedback` | `PlayFeedback` | every play (after `notedetect:session`) |
| `coaching:summary` | `{ feedback, summary }` | when the LLM plan lands (also renders the panel) |
| `coaching:summary-error` | `{ feedback, error }` | the LLM call failed (missing/invalid key, network, etc.) |

A failed LLM call is warn-only — it never breaks the play; `coaching:feedback`
still fires with `session.summary` left null.

## Tests

```bash
cd plugins/coaching && node --test
```

## End-of-song panel (no API key required)

Every play with Detect on shows a free **"Practice spots"** panel built straight
from `play_feedback.v1` (`renderFeedbackHtml`): this play's clean-%, each hotspot
(time range, note count, miss rate, a `systematic → may be calibration` flag), and
a **▶ Practice this** button per hotspot. **No API key needed** — the panel and the
drill loop do not depend on the LLM coach. If a key is set, the LLM-written plan
(`renderSummaryHtml`) upgrades the same panel in place when it lands. Pop the last
play's panel from the console with `coaching.showLast()`.

## Drill loop

The **▶ Practice this** button hands the hotspot's `{loopA, loopB, speedMul, goal}`
to note_detect's drill conductor (`window.noteDetect.startDrill`, note_detect ≥
1.16.0), which runs the slow → goal-gate → graduate practice loop. Coaching supplies
only the *where/how-slow* (`speedMul` → speed ladder via `drillLadderFromSpeedMul`);
the conductor owns the A-B loop, speed ramp, and HUD. The button degrades to an
inline hint if note_detect is missing or too old. note_detect also has its own
multi-play **finder** banner (≥1.17.0) that auto-picks a recurring hotspot across
plays — a second entry point into the same conductor.

## Next

- Persist the plan to the Practice Journal plugin.
- Musical bar/section bounds for hotspots.

(LLM auth uses an Anthropic API key — `coaching.setApiKey('sk-ant-…')` or Settings →
Coaching. A Claude Max/Pro subscription does **not** grant Messages-API access, so it
can't drive the coach; the drill loop itself needs no key.)
