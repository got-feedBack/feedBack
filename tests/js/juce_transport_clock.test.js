// jucePlayer (static/js/transport.js) interpolates the JUCE backing position
// between 100 ms getBackingPosition() IPC polls. These tests run the real
// jucePlayer against a simulated engine + IPC with latency and jitter, a 60 Hz
// rAF sampler, and virtual time, and pin what the highway sees: the clock
// never steps backwards outside a seek, stays close to the engine position,
// and advances at a steady rate frame to frame.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TRANSPORT_JS = path.join(__dirname, '..', '..', 'static', 'js', 'transport.js');

function extractJucePlayer(src) {
    const start = src.indexOf('// JUCE-mode clock tuning');
    const end = src.indexOf('export function _audioTime()');
    assert.ok(start !== -1 && end > start, 'jucePlayer block not found in transport.js');
    return src.slice(start, end).replace('export const jucePlayer', 'const jucePlayer')
        + '\nglobalThis.jucePlayer = jucePlayer;';
}

// Deterministic PRNG so jitter is reproducible.
function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// Virtual-time harness. `ipc()` returns { readMs, replyMs }: how long after
// the call the engine samples its position, and how long after that the
// renderer's await resumes.
async function simulate({ secs = 20, ipc, blockMs = 512 / 48, events = {} }) {
    let now = 0;
    const timers = [];
    let seq = 0;
    const schedule = (at, fn) => { timers.push({ at, fn, id: ++seq }); return seq; };
    let playOrigin = 0;
    const enginePos = (w) => Math.floor((w - playOrigin) / blockMs) * blockMs / 1000;
    const sandbox = {
        performance: { now: () => now },
        setTimeout: (fn, ms) => schedule(now + ms, fn),
        clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
        console: { warn() {}, log() {} },
        _emitSongPositionChanged() {},
        window: {
            feedBackDesktop: {
                audio: {
                    startBacking: () => Promise.resolve(),
                    stopBacking: () => Promise.resolve(),
                    seekBacking: () => Promise.resolve(),
                    getBackingPosition: () => new Promise((resolve) => {
                        const { readMs, replyMs } = ipc();
                        schedule(now + readMs, () => {
                            const p = enginePos(now);
                            schedule(now + replyMs, () => resolve(p));
                        });
                    }),
                },
            },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractJucePlayer(fs.readFileSync(TRANSPORT_JS, 'utf8')), sandbox);
    const jp = sandbox.jucePlayer;
    jp._dur = 600;
    await jp.play();

    const frames = [];
    const frameMs = 1000 / 60;
    for (let f = frameMs; f < secs * 1000; f += frameMs) {
        schedule(f, () => frames.push({ w: now, t: jp.currentTime, truth: enginePos(now) }));
    }
    if (events.seekAtMs) {
        schedule(events.seekAtMs, () => {
            playOrigin = now - 2000;     // engine now at 2.0 s
            void jp.seek(2);
            frames.push({ seek: true });
        });
    }
    if (events.engineJumpAtMs) {
        // Engine-side discontinuity the renderer didn't ask for (native loop).
        schedule(events.engineJumpAtMs, () => { playOrigin += 5000; frames.push({ seek: true }); });
    }
    const endMs = secs * 1000;
    while (timers.length) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const t = timers.shift();
        if (t.at > endMs) break;
        now = t.at;
        t.fn();
        await new Promise((r) => setImmediate(r));
    }
    jp._stopPolling();
    return frames;
}

function stats(frames) {
    let backward = 0, maxErr = 0;
    const ratios = [];
    let prev = null;
    for (const fr of frames) {
        if (fr.seek) { prev = null; continue; }
        if (prev) {
            const dt = fr.t - prev.t;
            if (dt < -1e-9) backward++;
            ratios.push(dt / ((fr.w - prev.w) / 1000));
            if (fr.w > 1000) maxErr = Math.max(maxErr, Math.abs(fr.t - fr.truth));
        }
        prev = fr;
    }
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const sd = Math.sqrt(ratios.reduce((a, b) => a + (b - mean) ** 2, 0) / ratios.length);
    return { backward, sd, maxErr };
}

// Typical desktop: 1-6 ms round trip, engine reads anywhere inside it.
const jitteryIpc = (seed) => {
    const r = rng(seed);
    return () => {
        const total = 1 + r() * 5 + (r() < 0.1 ? 15 + r() * 25 : 0);  // 10% slow replies
        const read = r() * total;
        return { readMs: read, replyMs: total - read };
    };
};

test('JUCE clock never steps backwards under IPC latency + jitter', async () => {
    const s = stats(await simulate({ ipc: jitteryIpc(1) }));
    assert.equal(s.backward, 0, `backward steps: ${s.backward}`);
    assert.ok(s.sd < 0.08, `Δchart/Δwall stddev ${s.sd.toFixed(3)} should stay near 1.0 ± 0.08`);
    assert.ok(s.maxErr < 0.03, `max |clock - engine| ${(s.maxErr * 1000).toFixed(1)} ms`);
});

test('a constant IPC delay does not bias the clock behind the engine', async () => {
    const frames = await simulate({ ipc: () => ({ readMs: 15, replyMs: 15 }), blockMs: 0.001 });
    const late = frames.filter((f) => !f.seek && f.w > 2000);
    const meanErr = late.reduce((a, f) => a + (f.t - f.truth), 0) / late.length;
    assert.ok(Math.abs(meanErr) < 0.002, `mean error ${(meanErr * 1000).toFixed(2)} ms`);
});

test('seek repositions immediately and an in-flight poll from before it is ignored', async () => {
    // Slow replies so a poll is in flight when the seek lands.
    const frames = await simulate({ secs: 8, ipc: () => ({ readMs: 1, replyMs: 30 }), events: { seekAtMs: 4005 } });
    const i = frames.findIndex((f) => f.seek);
    const after = frames.slice(i + 1, i + 15);
    for (const f of after) assert.ok(Math.abs(f.t - f.truth) < 0.03, `post-seek frame ${f.t} vs ${f.truth}`);
    assert.equal(stats(frames).backward, 0);
});

test('an engine-side jump (not requested) snaps the clock to the engine', async () => {
    const frames = await simulate({ secs: 8, ipc: jitteryIpc(7), events: { engineJumpAtMs: 4000 } });
    const tail = frames.filter((f) => !f.seek && f.w > 4500);
    for (const f of tail) assert.ok(Math.abs(f.t - f.truth) < 0.03, `${f.t} vs ${f.truth}`);
});

module.exports = { simulate, stats, jitteryIpc };
