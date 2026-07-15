// Verify the RENDER clock (_renderClock) is monotone and frame-rate independent.
//
// Regression guard for the highway-jitter bug: getTime()'s interpolator derived
// its rate from a single quantised sample gap — audio.currentTime steps ~23 ms
// while setTime() re-anchors on a 60 Hz poll, so consecutive anchors are 16.7 ms
// or 33.3 ms apart and the estimate alternates between ~1.38x and ~0.69x. It then
// snapped the output onto each stale anchor. Together those drove the chart clock
// BACKWARD on ~10% of frames (measured: -52 ms on a 200 Hz display).
//
// _renderClock() free-runs at a smoothed rate and pulls gently toward the anchored
// estimate instead of snapping, so its output must never go backward during steady
// playback at ANY frame rate.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function highwaySources() {
    const root = path.join(__dirname, '..', '..');
    const jsDir = path.join(root, 'static', 'js');
    const parts = [fs.readFileSync(path.join(root, 'static', 'highway.js'), 'utf8')];
    for (const f of fs.readdirSync(jsDir).sort()) {
        if (f.startsWith('highway-') && f.endsWith('.js')) {
            parts.push(fs.readFileSync(path.join(jsDir, f), 'utf8'));
        }
    }
    return parts.join('\n');
}

// Brace-balanced extraction (same approach as highway_monotonic_clock.test.js) so
// these stay robust to body growth.
function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

// Sandbox holding the real setTime / _anchoredChartTime / _renderClock bodies.
function buildRenderClockSandbox(perfNow) {
    const hwState = {
        chartTime: 0,
        currentTime: 0,
        avOffsetSec: 0,
        songOffset: 0,
        _chartAnchorAudioT: NaN,
        _chartAnchorPerfNow: NaN,
        _chartLastAdvanceAt: 0,
        _chartObservedRate: 1,
        _pllTime: NaN,
        _pllAt: 0,
        _pllRate: 1,
        _pllSeeded: false,
    };
    const sandbox = {
        hwState,
        _CHART_MAX_INTERP_MS: 100,
        _PLL_GAIN: 0.10,
        _PLL_RATE_ALPHA: 0.05,
        _PLL_MAX_ERR_SEC: 0.25,
        _PLL_RESYNC_MS: 120,
        performance: { now: perfNow },
    };
    vm.createContext(sandbox);
    const src = highwaySources();
    const cleanup = (s) => s.replace(/,?\s*$/, '');

    // Resolve THE CLOCK THE RENDERER DRAWS WITH. Prefer _renderClock (the
    // phase-locked loop); fall back to getTime() when it is absent, so these
    // assertions are behavioural — on a tree without the fix they fail because
    // the clock regresses, not merely because a symbol is missing.
    const hasRenderClock = src.includes('function _renderClock(nowP) {');
    const prelude = hasRenderClock
        ? `${extractBlock(src, 'function _anchoredChartTime(nowP) {')}
           ${extractBlock(src, 'function _renderClock(nowP) {')}
           globalThis.renderClock = _renderClock;`
        : `globalThis.getTime = function ${cleanup(extractBlock(src, 'getTime() {'))};
           globalThis.renderClock = () => getTime();`;
    vm.runInContext(`
        globalThis.setTime = function ${cleanup(extractBlock(src, 'setTime(t) {'))};
        ${prelude}
    `, sandbox);
    return sandbox;
}

// Drive a realistic playback timeline: audio.currentTime quantised to ~23 ms,
// setTime() polled at 60 Hz, _renderClock() sampled once per rendered frame.
function simulate(fps, { seconds = 6, quantumMs = 23 } = {}) {
    let now = 0;
    const sb = buildRenderClockSandbox(() => now);
    const frameMs = 1000 / fps;
    const tickMs = 1000 / 60;
    const audioAt = (ms) => Math.floor(ms / quantumMs) * quantumMs / 1000;

    let nextTick = 0;
    let prev = null;
    const deltas = [];
    for (let t = 0; t < seconds * 1000; t += frameMs) {
        now = t;
        if (t >= nextTick) { sb.setTime(audioAt(t)); nextTick = t + tickMs; }
        const c = sb.renderClock(t);
        // Ignore the settling window while the loop seeds and locks.
        if (prev !== null && t > 1000) deltas.push((c - prev) * 1000);
        prev = c;
    }
    const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const sd = Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / deltas.length);
    return {
        deltas,
        mean,
        sd,
        backward: deltas.filter((d) => d < -1e-9).length,
        ideal: frameMs,
    };
}

test('render clock never runs backward during steady playback (60 fps)', () => {
    const r = simulate(60);
    assert.equal(r.backward, 0,
        `render clock went backward on ${r.backward}/${r.deltas.length} frames`);
});

test('render clock never runs backward on a high-refresh display (200 fps)', () => {
    // The reported bug: 42/399 backward frames, min -52.42 ms, on a 200 Hz panel.
    const r = simulate(200);
    assert.equal(r.backward, 0,
        `render clock went backward on ${r.backward}/${r.deltas.length} frames`);
    assert.ok(Math.min(...r.deltas) > 0,
        `no frame may regress; min delta was ${Math.min(...r.deltas).toFixed(2)} ms`);
});

test('render clock is monotone and low-jitter across frame rates', () => {
    for (const fps of [30, 60, 90, 120, 144, 165, 200, 240, 360]) {
        const r = simulate(fps);
        assert.equal(r.backward, 0, `${fps} fps: ${r.backward} backward frames`);
        // Advance the chart at real time on average (1x playback).
        assert.ok(Math.abs(r.mean - r.ideal) < 0.25,
            `${fps} fps: mean advance ${r.mean.toFixed(2)} ms, expected ~${r.ideal.toFixed(2)}`);
        // Residual jitter is frame-rate independent — the loop advances by
        // rate * dt on real elapsed time. Pre-fix this was 4-12 ms.
        assert.ok(r.sd < 2.0,
            `${fps} fps: stddev ${r.sd.toFixed(2)} ms exceeds 2 ms budget`);
    }
});

test('render clock tolerates dropped frames (long dt) without regressing', () => {
    // A GC pause / compositor hiccup produces one long gap. The clock must keep
    // advancing forward across it, not snap back.
    let now = 0;
    const sb = buildRenderClockSandbox(() => now);
    const audioAt = (ms) => Math.floor(ms / 23) * 23 / 1000;
    let prev = null;
    let nextTick = 0;
    const gapAt = 2000;
    for (let t = 0; t < 4000;) {
        now = t;
        if (t >= nextTick) { sb.setTime(audioAt(t)); nextTick = t + 1000 / 60; }
        const c = sb.renderClock(t);
        if (prev !== null && t > 1000) {
            assert.ok(c - prev >= -1e-9,
                `clock regressed by ${((c - prev) * 1000).toFixed(2)} ms at t=${t}`);
        }
        prev = c;
        t += (t >= gapAt && t < gapAt + 5) ? 80 : 5; // one 80 ms stall
    }
});

test('highway declares the phase-locked render-clock state', () => {
    const src = highwaySources();
    assert.match(src, /hwState\._pllTime\s*=\s*NaN/, 'missing _pllTime (NaN sentinel)');
    assert.match(src, /hwState\._pllAt\s*=\s*0/, 'missing _pllAt');
    assert.match(src, /hwState\._pllRate\s*=\s*1/, 'missing _pllRate');
    assert.match(src, /hwState\._pllSeeded\s*=\s*false/, 'missing _pllSeeded');
});

test('draw() drives the render clock rather than reading the raw pushed sample', () => {
    const src = highwaySources();
    const draw = extractBlock(src, 'function draw() {');
    assert.match(draw, /_renderClock\(|_clockNow\(/,
        'draw() must derive its clock per frame (_renderClock / _clockNow), not read '
        + 'the stale value setTime() pushed from app.js\'s 60 Hz setInterval');
});

test('stop() clears the phase-locked clock so re-init starts fresh', () => {
    const src = highwaySources();
    const stopBlock = extractBlock(src, 'stop() {');
    assert.match(stopBlock, /hwState\._pllTime\s*=\s*NaN/, 'stop() must reset _pllTime');
    assert.match(stopBlock, /hwState\._pllSeeded\s*=\s*false/, 'stop() must reset _pllSeeded');
});
