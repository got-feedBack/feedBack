// Behavioural tests for the 3D highway's per-frame clock (smoothNow +
// slewClock in plugins/highway_3d/screen.js).
//
// smoothNow used to return the raw bundle.currentTime on every new audio
// sample. Between samples it extrapolated forward, so by the time the next
// (coarse, ~20 ms) sample arrived the clock was usually already past it and
// snapped back: a backwards step on most audio updates (sawtooth judder).
// These tests run the real function bodies in a vm sandbox against a
// simulated host: an audio clock quantized to ~21 ms, sampled by core's
// free-running 60 Hz setTime tick, read by an unrelated-phase rAF loop.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');
const src = fs.readFileSync(SCREEN_JS, 'utf8');

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

function buildSmoothNow() {
    let now = 0;
    const sandbox = { performance: { now: () => now } };
    vm.createContext(sandbox);
    vm.runInContext(`
        let _clkAudioT = NaN, _clkPerf = NaN, _frameNow = 0;
        const _clkOut = { t: 0, at: NaN, rate: 1 };
        ${extractBlock('function slewClock(')}
        ${extractBlock('function smoothNow(bundle)')}
        globalThis.smoothNow = smoothNow;
    `, sandbox);
    return { smoothNow: sandbox.smoothNow, setNow: (t) => { now = t; } };
}

// host: 'raw' = current core (bundle.currentTime = last 60 Hz setTime value),
// 'perFrame' = core that already interpolates per frame (bundle time smooth),
// 'downlevel' = like 'raw' but without bundle.isPlaying.
function simulate({ rate = 1, quantum = 0.02133, secs = 10, host = 'raw', events = {} } = {}) {
    const clock = buildSmoothNow();
    let origin = 0;
    let paused = false;
    let pausedAt = 0;
    const audioTime = (w) => (paused ? pausedAt : origin + (rate * w) / 1000);
    let chartTime = 0;
    let lastAdvance = -1e9;
    let nextTick = 3.1;
    let nextFrame = 11.7;
    let tickIdx = 0;
    let stallUntil = -1;
    let stallIdx = 0;
    const frames = [];
    for (let w = 0; w < secs * 1000; w += 0.1) {
        // Main-thread stall: neither core's setTime tick nor rAF runs.
        if (events.stallEveryMs && w % events.stallEveryMs < 0.1) {
            stallUntil = w + (events.stallMs || 4 + ((stallIdx++ * 37) % 25));
        }
        if (w < stallUntil) continue;
        if (events.seekAtMs && Math.abs(w - events.seekAtMs) < 0.05) origin -= 5;
        if (events.pauseAtMs && !paused && w >= events.pauseAtMs) { pausedAt = audioTime(w); paused = true; }
        if (w >= nextTick) {
            const t = Math.floor(audioTime(w) / quantum) * quantum;
            if (t !== chartTime) lastAdvance = w;
            chartTime = t;
            // ±2 ms deterministic jitter. Like Chrome's setInterval, the
            // schedule doesn't drift: a late tick is followed by an early one.
            nextTick += 16.67 + ((tickIdx++ * 7919) % 41 - 20) / 10;
            while (nextTick < w) nextTick += 16.67;
        }
        if (w >= nextFrame) {
            clock.setNow(w);
            const isPlaying = w - lastAdvance <= 100;
            const bundle = { currentTime: host === 'perFrame' && isPlaying ? audioTime(w) : chartTime };
            if (host !== 'downlevel') bundle.isPlaying = isPlaying;
            const t = clock.smoothNow(bundle);
            frames.push({ w, raw: bundle.currentTime, t, playing: isPlaying, truth: audioTime(w) });
            nextFrame = Math.max(nextFrame + 16.67, w + 4);
        }
    }
    return frames;
}

function smoothness(frames, key, rate) {
    const ratios = [];
    let back = 0;
    for (let i = 1; i < frames.length; i++) {
        const a = frames[i - 1];
        const b = frames[i];
        if (!a.playing || !b.playing || b.w < 500) continue;
        const d = b[key] - a[key];
        if (d < 0) back++;
        ratios.push(d / ((b.w - a.w) / 1000) / rate);
    }
    const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
    const sd = Math.sqrt(ratios.reduce((s, x) => s + (x - mean) ** 2, 0) / ratios.length);
    return { sd, back, mean };
}

test('baseline: the simulated bundle clock is coarse (guards against a vacuous pass)', () => {
    const raw = smoothness(simulate(), 'raw', 1);
    assert.ok(raw.sd > 0.3, `raw sd=${raw.sd}`);
});

for (const host of ['raw', 'downlevel', 'perFrame']) {
    for (const rate of [1, 0.5]) {
        test(`smoothNow never steps backwards and runs at ~constant rate (${host} host, ${rate}x)`, () => {
            const f = simulate({ host, rate });
            const s = smoothness(f, 't', rate);
            assert.equal(s.back, 0, 'no backward steps during playback');
            assert.ok(s.sd < 0.15, `delta/wall sd=${s.sd.toFixed(3)}`);
            assert.ok(Math.abs(s.mean - 1) < 0.02, `mean rate=${s.mean.toFixed(3)}`);
            const tail = f.filter((x) => x.w > 2000);
            const maxErr = Math.max(...tail.map((x) => Math.abs(x.truth - x.t)));
            assert.ok(maxErr < 0.03, `max |truth - smoothNow| = ${(maxErr * 1000).toFixed(1)} ms`);
        });
    }
}

test('smoothNow stays monotonic through main-thread stalls (bunched samples)', () => {
    // Short hitches (4-28 ms) delay one tick and pull the next one early, so
    // a full audio step lands in a few-ms segment; a per-sample-pair rate
    // estimate then reads several x and overshoots. Plus long (90 ms) stalls.
    for (const events of [{ stallEveryMs: 211 }, { stallEveryMs: 307, stallMs: 90 }]) {
        const s = smoothness(simulate({ secs: 20, events }), 't', 1);
        assert.equal(s.back, 0, `no backward steps (${JSON.stringify(events)})`);
        assert.ok(s.sd < 0.15, `delta/wall sd=${s.sd.toFixed(3)} (${JSON.stringify(events)})`);
    }
});

test('smoothNow snaps after a frame gap longer than 250 ms', () => {
    const f = simulate({ secs: 3, events: { stallEveryMs: 1009, stallMs: 300 } });
    const gaps = f.map((x, n) => n).filter((n) => n > 0 && f[n].playing && f[n].w - f[n - 1].w > 250);
    assert.ok(gaps.length > 0, 'simulation must create a frame gap above 250 ms');
    for (const i of gaps) {
        assert.equal(f[i].t, f[i].raw, 'the first frame after a long gap snaps to the current sample');
        assert.ok(Math.abs(f[i].truth - f[i].t) < 0.03, `|truth - smoothNow| = ${((f[i].truth - f[i].t) * 1000).toFixed(1)} ms`);
    }
});

test('smoothNow follows an already-smooth bundle clock closely (core interpolates per frame)', () => {
    const f = simulate({ host: 'perFrame' }).filter((x) => x.w > 1000 && x.playing);
    const maxDiff = Math.max(...f.map((x) => Math.abs(x.t - x.raw)));
    assert.ok(maxDiff < 0.002, `max |smoothNow - bundle.currentTime| = ${(maxDiff * 1000).toFixed(2)} ms`);
});

test('smoothNow snaps on a seek instead of slewing', () => {
    const f = simulate({ events: { seekAtMs: 5000 } });
    const after = f.find((x) => x.w > 5050);
    assert.ok(Math.abs(after.t - after.truth) < 0.04, `smoothNow=${after.t} truth=${after.truth}`);
});

for (const host of ['raw', 'downlevel']) {
    test(`smoothNow returns raw once paused (${host} host)`, () => {
        const f = simulate({ host, events: { pauseAtMs: 5000 } });
        // isPlaying flips after 100 ms; the downlevel staleness cap is also 100 ms.
        const settled = f.filter((x) => x.w > 5250);
        assert.ok(settled.length > 10);
        for (const x of settled) assert.equal(x.t, x.raw);
    });
}
