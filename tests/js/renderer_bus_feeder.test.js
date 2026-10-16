// Behavioral tests for the renderer-audio bus feeder in static/js/juce-audio.js.
//
// The feeder (an IIFE, `_installRendererBusFeeder`) captures renderer-side
// song audio (stems-plugin WebAudio master, or the core <audio> element) and
// pushes it into the desktop engine's renderer bus while the output device is
// exclusive-style — the Phase 2 path for audio the native backing transport
// cannot carry. These tests extract that IIFE from source and exercise
// `window._reevaluateRendererBus` against fakes, covering: stems engagement
// under exclusive output, disengagement on return to shared mode, inertness
// in shared mode / while the native transport owns the song, and the
// element-capture fallback.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The JUCE audio shims were carved out of app.js into their own module (R3a).
const APP_JS = path.join(__dirname, '..', '..', 'static', 'js', 'juce-audio.js');

function extractFeederIIFE(src) {
    const marker = '(function _installRendererBusFeeder() {';
    const start = src.indexOf(marker);
    assert.ok(start !== -1, 'feeder IIFE not found in static/js/juce-audio.js');
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, 'unbalanced braces in feeder IIFE');
    const tail = src.slice(i, i + 5);
    assert.match(tail, /^\)\(\)/, 'feeder IIFE not immediately invoked');
    return src.slice(start, i) + ')();';
}

function makeFakeContext(sampleRate = 48000) {
    const ctx = {
        sampleRate,
        state: 'running',
        sinkIdCalls: [],
        destination: { isDestination: true },
        setSinkId(v) { this.sinkIdCalls.push(v); return Promise.resolve(); },
        resume() { this.state = 'running'; return Promise.resolve(); },
        audioWorklet: { addModule: () => Promise.resolve() },
        createMediaElementSource(el) {
            this.mediaSourceEl = el;
            return { connect() {}, disconnect() {} };
        },
        createMediaStreamSource(stream) {
            this.mediaStreamSource = stream;
            return { connect() {}, disconnect() {} };
        },
        close() { this.closed = true; return Promise.resolve(); },
    };
    return ctx;
}

// Fake getDisplayMedia stream for the loopback-capture path.
function makeLoopbackStream({ suppressed = true } = {}) {
    const stopped = [];
    const audioTrack = {
        kind: 'audio',
        stop() { stopped.push('audio'); },
        getSettings: () => (suppressed ? { suppressLocalAudioPlayback: true } : {}),
    };
    const videoTrack = { kind: 'video', stop() { stopped.push('video'); } };
    return {
        __stopped: stopped,
        getAudioTracks: () => [audioTrack],
        getVideoTracks: () => [videoTrack],
        getTracks: () => [videoTrack, audioTrack],
    };
}

// `displayMedia`: undefined → loopback capture unavailable (Docker sphere /
// old desktop main); a function → used as navigator.mediaDevices.getDisplayMedia.
function makeSandbox({ isAudioRunning = () => true, exclusive = () => true, displayMedia, portMessage } = {}) {
    const calls = { setRendererBus: [], pushRendererAudio: [], setPageMuted: [] };

    const api = {
        isAudioRunning: () => Promise.resolve(isAudioRunning()),
        setRendererBus: (en, g) => { calls.setRendererBus.push([en, g]); return Promise.resolve(); },
        pushRendererAudio: (buf, rate) => { calls.pushRendererAudio.push([buf.length, rate]); },
        setPageMuted: (m) => { calls.setPageMuted.push(m); return Promise.resolve(m); },
    };
    if (portMessage) api.rendererBusPortMessage = portMessage;
    const windowPosts = [];

    const workletNodes = [];
    class FakeWorkletNode {
        constructor(ctx, name, options) {
            this.options = options;
            this.posted = [];
            this.port = {
                onmessage: null,
                postMessage: (msg, transfer) => { this.posted.push({ msg, transfer }); },
            };
            workletNodes.push(this);
        }
        connect() {}
        disconnect() {}
    }

    const sandbox = {
        console: { log() {}, warn() {}, error() {} },
        URL: { createObjectURL: () => 'blob:tap', revokeObjectURL() {} },
        Blob: class { constructor() {} },
        AudioWorkletNode: FakeWorkletNode,
        AudioContext: function () { const c = makeFakeContext(); sandbox.__createdContexts.push(c); return c; },
        WeakSet, WeakMap, Promise, Float32Array, Math, MessageChannel,
        __workletNodes: workletNodes,
        __windowPosts: windowPosts,
        setInterval: () => 0,
        document: {
            hidden: false,
            addEventListener() {},
            getElementById: () => sandbox.__audioEl,
        },
        __createdContexts: [],
        __audioEl: { id: 'audio' },
        __calls: calls,
        navigator: { mediaDevices: displayMedia ? { getDisplayMedia: displayMedia } : {} },
        window: null,
    };
    sandbox.window = {
        feedBackDesktop: { audio: api },
        _juceOutputIsExclusive: () => Promise.resolve(exclusive()),
        _juceMode: false,
        _currentSongAudio: null,
        feedBack: { stems: {} },
        postMessage: (msg, origin, transfer) => { windowPosts.push({ msg, origin, transfer }); },
    };
    sandbox.globalThis = sandbox;

    const src = fs.readFileSync(APP_JS, 'utf8');
    // The shims reach back into app.js through the host seam (static/js/host.js).
    // Route it at the SAME stubs this sandbox already had — a fresh `() => {}` would
    // swallow the calls and the assertions below would pass vacuously.
    sandbox.host = {
        jucePlayer: () => sandbox.jucePlayer,
        playSong: (...a) => (sandbox.playSong ? sandbox.playSong(...a) : undefined),
        _audioSeek: (...a) => (sandbox._audioSeek ? sandbox._audioSeek(...a) : Promise.resolve({ completed: true })),
        setPlayButtonState: (...a) => (sandbox.setPlayButtonState ? sandbox.setPlayButtonState(...a) : undefined),
        _songEventPayload: (...a) => (sandbox._songEventPayload ? sandbox._songEventPayload(...a) : ({})),
        showScreen: (...a) => (sandbox.showScreen ? sandbox.showScreen(...a) : undefined),
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFeederIIFE(src), sandbox);
    assert.equal(typeof sandbox.window._reevaluateRendererBus, 'function',
        'feeder must expose window._reevaluateRendererBus');
    return sandbox;
}

function makeStemsGraph() {
    return {
        context: makeFakeContext(),
        masterNode: { connect() {}, disconnect() {} },
    };
}

// Surface-mode (stems/element) tests run WITHOUT getDisplayMedia: the first
// tick probes loopback, fails, and latches _loopbackUnavailable; the second
// tick exercises the fallback surface mode. This mirrors an old desktop main
// without the display-media handler.
async function reevaluateWithFallback(sb) {
    await sb.window._reevaluateRendererBus();   // loopback probe → unavailable
    await sb.window._reevaluateRendererBus();   // surface fallback
}

test('stems graph + exclusive output → bus enabled, stems ctx null-sinked (loopback unavailable)', async () => {
    const sb = makeSandbox({ exclusive: () => true });
    const graph = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = graph;

    await reevaluateWithFallback(sb);

    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 'bus enabled');
    assert.equal(graph.context.sinkIdCalls.at(-1)?.type, 'none', 'stems ctx re-pointed at null sink');
});

test('output returns to shared → bus disabled, sink restored', async () => {
    let excl = true;
    const sb = makeSandbox({ exclusive: () => excl });
    const graph = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = graph;

    await reevaluateWithFallback(sb);
    excl = false;
    await sb.window._reevaluateRendererBus();

    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [false, 0], 'bus disabled');
    assert.equal(graph.context.sinkIdCalls.at(-1), '', 'default sink restored');
});

test('stems graph + shared output → feeder stays off (no double audio)', async () => {
    const sb = makeSandbox({ exclusive: () => false });
    sb.window.feedBack.stems.audioGraph = makeStemsGraph();

    await sb.window._reevaluateRendererBus();

    assert.equal(sb.__calls.setRendererBus.length, 0, 'bus never touched in shared mode');
});

test('element song + exclusive → element captured into bus (loopback unavailable)', async () => {
    const sb = makeSandbox({ exclusive: () => true });
    sb.window._currentSongAudio = { url: '/api/sloppak/x.sloppak/file/stems/full.ogg' };
    sb.window._juceMode = false;

    await reevaluateWithFallback(sb);

    assert.equal(sb.__createdContexts.length, 1, 'capture context created');
    assert.equal(sb.__createdContexts[0].mediaSourceEl, sb.__audioEl, 'element source captured');
    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 'bus enabled');
});

test('native-transport song, loopback unavailable → surface modes stay off', async () => {
    const sb = makeSandbox({ exclusive: () => true });
    sb.window._currentSongAudio = { url: '/audio/song.ogg' };
    sb.window._juceMode = true;

    await reevaluateWithFallback(sb);

    assert.ok(!sb.__calls.setRendererBus.some(([en]) => en === true),
        'bus never ENABLED (failed-probe cleanup may disable it)');
    assert.equal(sb.__createdContexts.length, 0, 'no capture context created');
});

test('stems graph replaced mid-engagement → re-engages on the new graph', async () => {
    const sb = makeSandbox({ exclusive: () => true });
    const g1 = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = g1;
    await reevaluateWithFallback(sb);

    const g2 = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = g2;
    await sb.window._reevaluateRendererBus();

    assert.equal(g2.context.sinkIdCalls.at(-1)?.type, 'none', 'new graph null-sinked');
    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 're-enabled for new graph');
});

// ── Loopback mode (whole-app capture) ────────────────────────────────────────

test('exclusive output + loopback available → engages without any song loaded', async () => {
    const stream = makeLoopbackStream();
    const sb = makeSandbox({ exclusive: () => true, displayMedia: () => Promise.resolve(stream) });

    await sb.window._reevaluateRendererBus();

    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 'bus enabled for whole session');
    assert.ok(stream.__stopped.includes('video'), 'unused video track stopped');
    assert.equal(sb.__createdContexts.at(-1)?.mediaStreamSource, stream, 'loopback stream captured');
    assert.equal(sb.__calls.setPageMuted.length, 0, 'suppress constraint honoured — no page mute');
});

test('loopback context is closed on disengage (no orphaned tap worklet)', async () => {
    let excl = true;
    const stream = makeLoopbackStream();
    const sb = makeSandbox({ exclusive: () => excl, displayMedia: () => Promise.resolve(stream) });

    await sb.window._reevaluateRendererBus();          // engage loopback
    const lbCtx = sb.__createdContexts.at(-1);
    assert.equal(lbCtx?.mediaStreamSource, stream, 'loopback engaged');
    assert.notEqual(lbCtx.closed, true, 'context live while engaged');

    excl = false;
    await sb.window._reevaluateRendererBus();          // disengage
    assert.equal(lbCtx.closed, true, 'loopback context closed on disengage');
    assert.ok(stream.__stopped.includes('audio'), 'capture stream stopped');
});

test('loopback preferred over stems when both available', async () => {
    const stream = makeLoopbackStream();
    const sb = makeSandbox({ exclusive: () => true, displayMedia: () => Promise.resolve(stream) });
    const graph = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = graph;

    await sb.window._reevaluateRendererBus();

    assert.equal(graph.context.sinkIdCalls.length, 0, 'stems ctx untouched — loopback owns capture');
    assert.equal(sb.__createdContexts.at(-1)?.mediaStreamSource, stream, 'loopback engaged');
});

test('suppressLocalAudioPlayback unsupported → page-mute fallback, unmuted on disengage', async () => {
    let excl = true;
    const stream = makeLoopbackStream({ suppressed: false });
    const sb = makeSandbox({ exclusive: () => excl, displayMedia: () => Promise.resolve(stream) });

    await sb.window._reevaluateRendererBus();
    assert.deepEqual(sb.__calls.setPageMuted, [true], 'page muted as fallback');

    excl = false;
    await sb.window._reevaluateRendererBus();
    assert.deepEqual(sb.__calls.setPageMuted, [true, false], 'page unmuted on disengage');
    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [false, 0], 'bus disabled');
});

test('getDisplayMedia rejected → sticky fallback to surface modes', async () => {
    const sb = makeSandbox({
        exclusive: () => true,
        displayMedia: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    });
    const graph = makeStemsGraph();
    sb.window.feedBack.stems.audioGraph = graph;

    await sb.window._reevaluateRendererBus();   // probe fails, latches unavailable
    await sb.window._reevaluateRendererBus();   // falls back to stems

    assert.equal(graph.context.sinkIdCalls.at(-1)?.type, 'none', 'stems fallback engaged');
    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 'bus enabled via fallback');
});

test('element capture collision (createMediaElementSource throws) → no poisoned state, clean retry', async () => {
    const sb = makeSandbox({ exclusive: () => true });   // loopback unavailable
    sb.window._currentSongAudio = { url: '/api/sloppak/x.sloppak/file/stems/full.ogg' };
    // First capture attempt collides (highway analyser owns the element).
    let collide = true;
    const origFactory = sb.AudioContext;
    sb.__createdContexts.length = 0;
    // Patch contexts so createMediaElementSource throws while colliding.
    sb.AudioContext = function () {
        const c = origFactory();
        const orig = c.createMediaElementSource.bind(c);
        c.createMediaElementSource = (el) => {
            if (collide) throw new DOMException('already connected', 'InvalidStateError');
            return orig(el);
        };
        c.close = () => Promise.resolve();
        return c;
    };

    await reevaluateWithFallback(sb);            // element engage fails (collision)
    assert.ok(!sb.__calls.setRendererBus.some(([en]) => en === true), 'bus never left enabled');

    collide = false;
    await sb.window._reevaluateRendererBus();    // retry succeeds — no TypeError, fresh ctx

    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [true, 1.0], 'element engaged after collision cleared');
});

test('engine stops → bus disabled', async () => {
    let running = true;
    const sb = makeSandbox({ isAudioRunning: () => running, exclusive: () => true });
    sb.window.feedBack.stems.audioGraph = makeStemsGraph();
    await sb.window._reevaluateRendererBus();

    running = false;
    await sb.window._reevaluateRendererBus();

    assert.deepEqual(sb.__calls.setRendererBus.at(-1), [false, 0], 'bus disabled after engine stop');
});

// ── Tap worklet: in-worklet batching + direct MessagePort sink ───────────────

function loadTapProcessor() {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const m = src.match(/const TAP_WORKLET = `([\s\S]*?)`;/);
    assert.ok(m, 'TAP_WORKLET source not found');
    let Proc = null;
    const sb = {
        AudioWorkletProcessor: class { constructor() { this.port = { onmessage: null, posted: [], postMessage(d) { this.posted.push(d); } }; } },
        registerProcessor: (name, cls) => { assert.equal(name, 'feedback-bus-tap'); Proc = cls; },
        Float32Array,
    };
    vm.createContext(sb);
    vm.runInContext(m[1], sb);
    return Proc;
}

function quantum(start) {
    const L = new Float32Array(128), R = new Float32Array(128);
    for (let i = 0; i < 128; i++) { L[i] = start + i; R[i] = -(start + i); }
    return [[L, R]];
}

function makeSinkPort() {
    return { onmessage: null, posted: [], postMessage(d) { this.posted.push(Float32Array.from(d)); } };
}

test('tap worklet batches 128-frame quanta into one post per batch, interleaved', () => {
    const Proc = loadTapProcessor();
    const p = new Proc({ processorOptions: { batchFrames: 512 } });
    for (let q = 0; q < 8; q++) p.process(quantum(q * 128));
    assert.equal(p.port.posted.length, 0, 'inactive tap posts nothing');

    p.port.onmessage({ data: { active: true } });
    const posts = [];
    p.port.postMessage = (d) => posts.push(Float32Array.from(d));
    for (let q = 0; q < 12; q++) p.process(quantum(q * 128));
    assert.equal(posts.length, 3, '12 quanta / 4 per batch = 3 posts (was 12 before batching)');
    assert.equal(posts[0].length, 1024, '512 stereo frames per post');
    assert.deepEqual([...posts[1].subarray(0, 4)], [512, -512, 513, -513], 'continuous interleaved L/R');
});

test('tap worklet routes batches to the direct sink only after the main process acks it', () => {
    const Proc = loadTapProcessor();
    const p = new Proc({ processorOptions: { batchFrames: 256 } });
    const sink = makeSinkPort();
    const viaMain = [];
    p.port.postMessage = (d) => viaMain.push(d);
    p.port.onmessage({ data: { sink } });
    p.port.onmessage({ data: { active: true } });

    for (let q = 0; q < 2; q++) p.process(quantum(q * 128));
    assert.equal(viaMain.length, 1, 'before the ack, batches use the main-thread fallback');
    assert.equal(sink.posted.length, 0);

    sink.onmessage({ data: { ready: true } });
    for (let q = 0; q < 4; q++) p.process(quantum(q * 128));
    assert.equal(sink.posted.length, 2, 'after the ack, batches go straight to the main process');
    assert.equal(viaMain.length, 1, 'renderer main thread no longer on the audio path');

    sink.onmessage({ data: { ready: false } });
    for (let q = 0; q < 2; q++) p.process(quantum(q * 128));
    assert.equal(viaMain.length, 2, 'a refused port falls back to the main-thread path');
});

test('desktop preload with rendererBusPortMessage → tap hands a MessagePort to worklet and preload', async () => {
    const stream = makeLoopbackStream();
    const sb = makeSandbox({
        exclusive: () => true,
        displayMedia: () => Promise.resolve(stream),
        portMessage: 'feedback-desktop:renderer-bus-port',
    });

    await sb.window._reevaluateRendererBus();

    const node = sb.__workletNodes.at(-1);
    assert.equal(node.options.processorOptions.batchFrames, 512, '~10 ms batch at 48 kHz');
    const sinkMsg = node.posted.find((p) => p.msg && p.msg.sink);
    assert.ok(sinkMsg, 'worklet received its sink port');
    assert.equal(sinkMsg.transfer.length, 1);
    assert.equal(sinkMsg.transfer[0], sinkMsg.msg.sink, 'sink port transferred, not cloned');
    assert.equal(sb.__windowPosts.length, 1, 'other end posted to the preload');
    const wp = sb.__windowPosts[0];
    assert.equal(wp.msg.type, 'feedback-desktop:renderer-bus-port');
    assert.equal(wp.msg.sourceRate, 48000);
    assert.equal(wp.transfer.length, 1);
    assert.ok(node.posted.some((p) => p.msg && p.msg.active === true), 'worklet activated');
    for (const p of [sinkMsg.msg.sink, wp.transfer[0]]) p.close();
});

test('old desktop preload (no port API) → batched fallback via pushRendererAudio', async () => {
    const stream = makeLoopbackStream();
    const sb = makeSandbox({ exclusive: () => true, displayMedia: () => Promise.resolve(stream) });

    await sb.window._reevaluateRendererBus();

    const node = sb.__workletNodes.at(-1);
    assert.equal(sb.__windowPosts.length, 0, 'no port handed out without the preload API');
    node.port.onmessage({ data: new Float32Array(1024) });
    assert.equal(sb.__calls.pushRendererAudio.length, 1);
    assert.deepEqual([...sb.__calls.pushRendererAudio[0]], [1024, 48000], 'worklet batch pushed as-is');
});
