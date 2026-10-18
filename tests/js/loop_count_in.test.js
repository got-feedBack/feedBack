// The per-loop count-in preference.
//
// A-B loops wrap with a one-bar click count-in (static/js/count-in.js). This
// feature adds a Gameplay setting to switch that off so a loop restarts
// straight on the first note. The two behaviours under test:
//
//   1. `_loopCountInEnabled()` reads the mirrored localStorage pref, default ON
//      (absence of the key keeps the historical count-in).
//   2. `startCountIn({ silent: true })` performs a "silent wrap": seek straight
//      back to A and keep playing — no pause, no clicks, no overlay — while
//      still emitting `loop:restart` exactly once so plugins (note_detect's
//      drill sync) stay in step.
//
// Same vm-sandbox extraction idiom as loop_restart.test.js: pull the function
// source out of the module and run it against stubs, rather than importing the
// DOM-coupled ESM module.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const COUNT_IN_JS = path.join(__dirname, '..', '..', 'static', 'js', 'count-in.js');
const CONTROLS_JS = path.join(__dirname, '..', '..', 'static', 'js', 'player-controls.js');
const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');

// Brace-match a function declaration out of the source. Brittle by design:
// a rename fails loudly here rather than silently skipping coverage.
function extractFunction(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`extractFunction: '${signature}' not found`);
    let scan = start + signature.length;
    if (src[scan] === '(') {
        let parenDepth = 1;
        scan++;
        while (scan < src.length && parenDepth > 0) {
            const ch = src[scan];
            if (ch === '(') parenDepth++;
            else if (ch === ')') parenDepth--;
            scan++;
        }
    }
    const openBrace = src.indexOf('{', scan);
    if (openBrace === -1) throw new Error(`extractFunction: no body after '${signature}'`);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    if (depth !== 0) throw new Error(`extractFunction: unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

const countInSrc = fs.readFileSync(COUNT_IN_JS, 'utf8').replace(/^export /gm, '');

function buildSandbox() {
    const emitCalls = [];
    const counters = { pause: 0, click: 0, overlay: 0 };
    const seekCalls = [];
    const sandbox = {
        performance: { now: () => Date.now() },
        requestAnimationFrame(fn) { queueMicrotask(() => fn(Date.now() + 10_000)); },
        setTimeout: () => 0,
        audio: { pause() { counters.pause++; } },
        jucePlayer: { pause: () => Promise.resolve(), play: () => Promise.resolve(true) },
        highway: { setTime() {}, getBPM: () => 120 },
        _audioSeek: (s, reason) => {
            seekCalls.push({ s, reason });
            return Promise.resolve({ completed: true, from: 20, to: s });
        },
        playClick: () => { counters.click++; },
        showCountOverlay: () => { counters.overlay++; },
        hideCountOverlay: () => {},
        countInBeats: () => 4,
        document: {
            getElementById: () => ({
                textContent: '', className: '',
                classList: { add() {}, remove() {}, toggle() {} },
            }),
        },
        window: {
            feedBack: { emit(event, detail) { emitCalls.push({ event, detail }); }, isPlaying: false },
            _juceMode: false,
        },
        queueMicrotask,
        __emitCalls: emitCalls,
        __counters: counters,
        __seekCalls: seekCalls,
    };
    sandbox.host = {
        _audioSeek: (...a) => sandbox._audioSeek(...a),
        setPlayButtonState: () => {},
        _songEventPayload: () => ({}),
        togglePlay: () => {},
        jucePlayer: () => sandbox.jucePlayer,
    };
    vm.createContext(sandbox);
    if (sandbox.window && sandbox.highway) sandbox.window.highway = sandbox.highway;
    return sandbox;
}

function loadCountIn(sandbox) {
    const startSrc = extractFunction(countInSrc, 'async function startCountIn');
    const silentSrc = extractFunction(countInSrc, 'async function wrapLoopSilently');
    const prelude = `
        var loopA = 10;
        var loopB = 20;
        var _countingIn = false;
        var _countInGen = 0;
        var _countInTimer = null;
        var _countInRaf = 0;
        var S = { isPlaying: true, lastAudioTime: 0 };
        ${silentSrc}
        ${startSrc}
        globalThis.__startCountIn = startCountIn;
        globalThis.__getCountingIn = () => _countingIn;
    `;
    vm.runInContext(prelude, sandbox);
}

async function settle() {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
}

test('the silent wrap seeks straight to A without pausing or clicking', async () => {
    const sandbox = buildSandbox();
    loadCountIn(sandbox);

    await sandbox.__startCountIn({ silent: true });
    await settle();

    assert.equal(sandbox.__counters.pause, 0, 'silent wrap must not pause playback');
    assert.equal(sandbox.__counters.click, 0, 'silent wrap must not play count-in clicks');
    assert.equal(sandbox.__counters.overlay, 0, 'silent wrap must not show the count overlay');
    assert.deepEqual(sandbox.__seekCalls.map((c) => c.s), [10], 'must seek back to loopA');
    const restarts = sandbox.__emitCalls.filter((c) => c.event === 'loop:restart');
    assert.equal(restarts.length, 1, `expected one loop:restart, got ${restarts.length}`);
    assert.equal(restarts[0].detail.loopA, 10);
    assert.equal(restarts[0].detail.loopB, 20);
    assert.equal(restarts[0].detail.time, 10);
    assert.equal(sandbox.__getCountingIn(), false, 'guard must clear after the seek lands');
});

test('the default wrap still runs the count-in (pause + clicks)', async () => {
    const sandbox = buildSandbox();
    loadCountIn(sandbox);

    await sandbox.__startCountIn();
    await settle();

    assert.equal(sandbox.__counters.pause, 1, 'default wrap must still pause for the count-in');
    assert.equal(sandbox.__counters.click, 0, 'clicks fire from the 500ms timer, not synchronously');
});

test('a silent wrap aborts without emitting when the seek lands off-target', async () => {
    const sandbox = buildSandbox();
    loadCountIn(sandbox);
    sandbox._audioSeek = () => Promise.resolve({ completed: true, from: 20, to: 20 });

    await sandbox.__startCountIn({ silent: true });
    await settle();

    const restarts = sandbox.__emitCalls.filter((c) => c.event === 'loop:restart');
    assert.equal(restarts.length, 0, 'off-target seek must not emit loop:restart');
    assert.equal(sandbox.__getCountingIn(), false, 'guard must clear on abort');
});

test('_loopCountInEnabled defaults on and reads the mirrored pref', () => {
    const pcSrc = fs.readFileSync(CONTROLS_JS, 'utf8').replace(/^export /gm, '');
    const fnSrc = extractFunction(pcSrc, 'function _loopCountInEnabled');
    const sandbox = {
        localStorage: {
            _d: {},
            getItem(k) { return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null; },
            setItem(k, v) { this._d[k] = String(v); },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(`${fnSrc}; globalThis.__fn = _loopCountInEnabled;`, sandbox);

    assert.equal(sandbox.__fn(), true, 'absent key means ON (historical behaviour)');
    sandbox.localStorage.setItem('loopCountIn', '1');
    assert.equal(sandbox.__fn(), true);
    sandbox.localStorage.setItem('loopCountIn', '0');
    assert.equal(sandbox.__fn(), false);
});

test('the wrap tick passes the pref through as the silent flag', () => {
    // Source-level lock: app.js must gate the wrap count-in on the preference.
    // Without this, the setting would persist but never take effect.
    const appSrc = fs.readFileSync(APP_JS, 'utf8');
    assert.match(
        appSrc,
        /startCountIn\(\{\s*silent:\s*!_loopCountInEnabled\(\)\s*\}\)/,
        'app.js wrap tick must call startCountIn({ silent: !_loopCountInEnabled() })',
    );
});
