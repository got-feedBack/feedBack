// The core highway samples its render clock once per rAF frame through
// stepRenderClock() instead of drawing the raw value the 60 Hz setInterval
// last pushed through setTime(). These tests run the real
// setTime / getTime / stepRenderClock bodies (extracted from highway.js)
// against a simulated pipeline: an audio clock that only moves in ~21 ms
// steps, a free-running 60 Hz setTime tick, and a rAF loop with a different
// phase. They pin the property that matters on screen: chart time advances
// by ~one frame's worth every frame, never backwards.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HIGHWAY_JS = path.join(__dirname, '..', '..', 'static', 'highway.js');
const src = fs.readFileSync(HIGHWAY_JS, 'utf8');

function extractBlock(signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const open = src.indexOf('{', start);
    let depth = 1;
    let i = open + 1;
    while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    }
    assert.equal(depth, 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

function buildSandbox() {
    let now = 0;
    const sandbox = {
        hwState: {
            chartTime: 0, currentTime: 0, avOffsetSec: 0, songOffset: 0,
            _chartAnchorAudioT: NaN, _chartAnchorPerfNow: NaN,
            _chartLastAdvanceAt: 0, _chartObservedRate: 1,
        },
        _CHART_MAX_INTERP_MS: 100,
        performance: { now: () => now },
    };
    vm.createContext(sandbox);
    vm.runInContext(`
        ${extractBlock('function stepRenderClock(')}
        globalThis.stepRenderClock = stepRenderClock;
        globalThis.setTime = function ${extractBlock('setTime(t) {')};
        globalThis.getTime = function ${extractBlock('getTime() {')};
    `, sandbox);
    sandbox.setNow = (t) => { now = t; };
    return sandbox;
}

// Simulate `secs` of playback at `rate`. Returns per-frame [wallMs, rawSetTimeValue,
// getTimeValue, renderClockValue] while the clock reads as playing.
function simulate({ rate = 1, quantum = 0.02133, secs = 10, events = {} } = {}) {
    const sb = buildSandbox();
    const clk = { t: 0, at: NaN, rate: 1 };
    let audioOrigin = 0;
    let paused = false;
    let pausedAt = 0;
    const audioTime = (w) => (paused ? pausedAt : audioOrigin + (rate * w) / 1000);
    let nextTick = 3.1;    // setInterval phase
    let nextFrame = 11.7;  // rAF phase (unrelated)
    let tickIdx = 0;
    const frames = [];
    let stallUntil = -1;
    let stallIdx = 0;
    for (let w = 0; w < secs * 1000; w += 0.1) {
        // Main-thread stall: neither the setTime tick nor rAF runs; afterwards
        // both fire as soon as possible (setInterval does not catch up).
        if (events.stallEveryMs && w % events.stallEveryMs < 0.1) {
            stallUntil = w + (events.stallMs || 4 + ((stallIdx++ * 37) % 25));
        }
        if (w < stallUntil) continue;
        if (events.seekAtMs && Math.abs(w - events.seekAtMs) < 0.05) audioOrigin -= 5;
        if (events.pauseAtMs && !paused && w >= events.pauseAtMs) { pausedAt = audioTime(w); paused = true; }
        sb.setNow(w);
        if (w >= nextTick) {
            sb.setTime(Math.floor(audioTime(w) / quantum) * quantum);
            // setInterval jitter: ±2 ms, deterministic
            // ±2 ms deterministic jitter. Like Chrome's setInterval, the
            // schedule doesn't drift: a late tick is followed by an early one.
            nextTick += 16.67 + ((tickIdx++ * 7919) % 41 - 20) / 10;
            while (nextTick < w) nextTick += 16.67;
        }
        if (w >= nextFrame) {
            const playing = w - sb.hwState._chartLastAdvanceAt <= 100;
            const gt = sb.getTime();
            const t = sb.stepRenderClock(clk, sb.hwState.chartTime, sb.hwState._chartAnchorPerfNow, w, playing);
            frames.push({ w, raw: sb.hwState.chartTime, gt, t, playing, truth: audioTime(w) });
            nextFrame = Math.max(nextFrame + 16.67, w + 4);
        }
    }
    return frames;
}

function smoothness(frames, key, rate) {
    const ratios = [];
    let back = 0;
    let zero = 0;
    for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1];
        const b = frames[i];
        if (!a.playing || !b.playing || b.w < 500) continue; // skip lock-in
        const d = b[key] - a[key];
        if (d < 0) back++;
        else if (d === 0) zero++;
        ratios.push(d / ((b.w - a.w) / 1000) / rate);
    }
    const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
    const sd = Math.sqrt(ratios.reduce((s, x) => s + (x - mean) ** 2, 0) / ratios.length);
    return { sd, back, zero, mean };
}

test('baseline: raw setTime value and bare getTime() both judder on a quantized audio clock', () => {
    // Guards the test itself: if the simulated input were already smooth,
    // the stepRenderClock assertions below would pass vacuously.
    const f = simulate();
    const raw = smoothness(f, 'raw', 1);
    const gt = smoothness(f, 'gt', 1);
    assert.ok(raw.zero > 50, `raw should repeat values (zero=${raw.zero})`);
    assert.ok(raw.sd > 0.3, `raw sd=${raw.sd}`);
    assert.ok(gt.back > 20, `getTime should step backwards on re-anchor (back=${gt.back})`);
});

for (const rate of [1, 0.5, 0.75]) {
    test(`stepRenderClock is monotonic and ~constant-rate at ${rate}x`, () => {
        const f = simulate({ rate });
        const s = smoothness(f, 't', rate);
        assert.equal(s.back, 0, 'never steps backwards during playback');
        assert.equal(s.zero, 0, 'never repeats a frame while playing');
        assert.ok(s.sd < 0.15, `delta/wall sd=${s.sd.toFixed(3)} (raw is > 0.3)`);
        assert.ok(Math.abs(s.mean - 1) < 0.02, `mean rate=${s.mean.toFixed(3)}`);
        // Tracks the audio clock: stays within a few ms of the truth.
        const tail = f.filter((x) => x.w > 2000);
        const maxLag = Math.max(...tail.map((x) => Math.abs(x.truth - x.t)));
        assert.ok(maxLag < 0.03, `max |truth - render| = ${(maxLag * 1000).toFixed(1)} ms`);
    });
}

test('stepRenderClock stays monotonic through main-thread stalls (bunched setTime ticks)', () => {
    // Short hitches (4-28 ms) delay one tick and pull the next one early, so
    // a full audio step lands in a few-ms segment and getTime()'s per-segment
    // rate reads several x. A filter that chased getTime() would overshoot and
    // snap back; one long stall (90 ms) is in the mix too.
    const f = simulate({ secs: 20, events: { stallEveryMs: 211 } });
    const g = simulate({ secs: 20, events: { stallEveryMs: 307, stallMs: 90 } });
    const sg = smoothness(g, 't', 1);
    assert.equal(sg.back, 0, 'no backward steps after long stalls');
    const s = smoothness(f, 't', 1);
    assert.equal(s.back, 0, 'no backward steps');
    assert.ok(s.sd < 0.15, `delta/wall sd=${s.sd.toFixed(3)}`);
});

test('stepRenderClock snaps on a seek instead of slewing', () => {
    const f = simulate({ events: { seekAtMs: 5000 } });
    // Within ~two setTime ticks + a frame of the seek, the render clock is on the new position.
    const after = f.find((x) => x.w > 5050);
    assert.ok(Math.abs(after.t - after.truth) < 0.04, `render=${after.t} truth=${after.truth}`);
});

test('stepRenderClock returns raw chartTime exactly once the clock reads as paused', () => {
    const f = simulate({ events: { pauseAtMs: 5000 } });
    const paused = f.filter((x) => !x.playing && x.w > 5000);
    assert.ok(paused.length > 10);
    for (const x of paused) assert.equal(x.t, x.raw);
});

test('stepRenderClock: first frame and paused frames pass the target straight through', () => {
    const sb = buildSandbox();
    const clk = { t: 0, at: NaN, rate: 1 };
    assert.equal(sb.stepRenderClock(clk, 12.5, 990, 1000, true), 12.5);
    assert.equal(sb.stepRenderClock(clk, 3.25, 990, 1016, false), 3.25);
    // Large error while playing (> 50 ms) snaps to the extrapolated sample.
    assert.equal(sb.stepRenderClock(clk, 9, 1033, 1033, true), 9);
});

test('draw() feeds the renderers stepRenderClock() + avOffset, before renderer.draw', () => {
    const draw = extractBlock('function draw() {');
    const sampleIdx = draw.search(/hwState\.currentTime\s*=\s*stepRenderClock\(\s*hwState\._renderClock,\s*hwState\.chartTime,\s*hwState\._chartAnchorPerfNow/);
    assert.ok(sampleIdx !== -1, 'draw() must sample the render clock from the chart anchor');
    assert.match(draw.slice(sampleIdx), /\+\s*hwState\.avOffsetSec/, 'AV offset still applied');
    const drawIdx = draw.indexOf('hwState._renderer.draw(bundle)');
    assert.ok(sampleIdx < drawIdx, 'sample before the renderer draws');
    // No-anchor boot state keeps setTime()'s value.
    assert.match(draw, /if\s*\(\s*!Number\.isNaN\(hwState\._chartAnchorPerfNow\)\s*\)\s*\{\s*const _clockPlaying/);
});

test('default renderer scales anchor smoothing by the real frame dt', () => {
    assert.match(src, /updateSmoothAnchor\(anchor,\s*hwState\._frameDt\)/);
    assert.doesNotMatch(src, /updateSmoothAnchor\(anchor,\s*1\s*\/\s*60\)/);
});
