'use strict';

// State-machine smoke tests for the host working-tuning capability
// (static/capabilities/working-tuning.js). Runs the real module in a vm sandbox
// with stubbed window.feedBack (emit/on + capabilities), localStorage and fetch.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'static', 'capabilities', 'working-tuning.js'), 'utf8');

function makeSandbox(opts) {
    opts = opts || {};
    const listeners = {};
    const store = opts.localStorage || {};
    const settings = opts.settings || { instrument: 'guitar', string_count: 6, tuning: 'Standard', reference_pitch: 440 };
    const localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
    };
    const sandbox = {
        window: {
            feedBack: {
                capabilities: { version: 1, registerOwner() {}, registerParticipant() {} },
                emit(ev, detail) { (listeners[ev] || []).slice().forEach((fn) => fn(detail)); },
                on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
            },
            localStorage,
        },
        localStorage,
        fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(settings) }),
        console, Promise, Date, Array, Object, JSON, Number, isFinite, setTimeout,
    };
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox);
    return {
        wt: () => sandbox.window.feedBack.workingTuning,
        emit: (ev, d) => sandbox.window.feedBack.emit(ev, d),
        on: (ev, fn) => sandbox.window.feedBack.on(ev, fn),
        reinject: () => vm.runInContext(SRC, sandbox),
        store,
    };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

test('defaults: an unset instrument is assumed with null offsets', () => {
    const d = makeSandbox().wt().get('guitar-6');
    assert.equal(d.offsets, null);
    assert.equal(d.provenance, 'assumed');
});

test('set + get round-trips, per-instrument isolation (guitar vs bass)', () => {
    const s = makeSandbox();
    s.wt().set({ offsets: [-2, 0, 0, 0, 0, 0], stringCount: 6 }, { instrument: 'guitar-6' });
    assert.deepEqual(s.wt().get('guitar-6').offsets, [-2, 0, 0, 0, 0, 0]);
    assert.equal(s.wt().get('bass-4').offsets, null);
});

test('both directions: E → Drop D → back to E via set()', () => {
    const s = makeSandbox();
    s.wt().set({ offsets: [-2, 0, 0, 0, 0, 0] }, { instrument: 'guitar-6' });
    assert.deepEqual(s.wt().get('guitar-6').offsets, [-2, 0, 0, 0, 0, 0]);
    s.wt().set({ offsets: [0, 0, 0, 0, 0, 0] }, { instrument: 'guitar-6' });
    assert.deepEqual(s.wt().get('guitar-6').offsets, [0, 0, 0, 0, 0, 0]);   // came back
});

test('changing the tuning invalidates a prior verification', () => {
    const s = makeSandbox();
    s.wt().set({ offsets: [0, 0, 0, 0, 0, 0], verifiedStrings: [1, 1, 1, 1, 1, 1] }, { instrument: 'guitar-6', provenance: 'verified' });
    assert.equal(s.wt().get('guitar-6').provenance, 'verified');
    s.wt().set({ offsets: [-2, 0, 0, 0, 0, 0] }, { instrument: 'guitar-6' });
    assert.equal(s.wt().get('guitar-6').provenance, 'assumed');
});

test('verified decays to assumed on song:loading (offsets kept)', () => {
    const s = makeSandbox();
    s.wt().set({ offsets: [0, 0, 0, 0, 0, 0], verifiedStrings: [1, 1, 1, 1, 1, 1] }, { instrument: 'guitar-6', provenance: 'verified' });
    assert.equal(s.wt().get('guitar-6').provenance, 'verified');
    s.emit('song:loading', { filename: 'x' });
    assert.equal(s.wt().get('guitar-6').provenance, 'assumed');
    assert.deepEqual(s.wt().get('guitar-6').offsets, [0, 0, 0, 0, 0, 0]);
});

test('resetToDefault clears back to defaults', () => {
    const s = makeSandbox();
    s.wt().set({ offsets: [-2, 0, 0, 0, 0, 0] }, { instrument: 'guitar-6' });
    s.wt().resetToDefault('guitar-6');
    assert.equal(s.wt().get('guitar-6').offsets, null);
});

test('launch default: setLaunchDefault persists + getLaunchDefault returns it', () => {
    const s = makeSandbox();
    s.wt().set({ offsets: [-2, 0, 0, 0, 0, 0], stringCount: 6 }, { instrument: 'guitar-6' });
    s.wt().setLaunchDefault('guitar-6');
    assert.deepEqual(s.wt().getLaunchDefault('guitar-6').offsets, [-2, 0, 0, 0, 0, 0]);
    assert.ok('v3-working-tuning-launch-default' in s.store);
});

test('launch default is opt-in: none set → getLaunchDefault is null', () => {
    assert.equal(makeSandbox().wt().getLaunchDefault('guitar-6'), null);
});

test('launch default seeds a fresh boot and wins over the raw profile', async () => {
    const store = {};
    const s1 = makeSandbox({ localStorage: store });
    s1.wt().set({ offsets: [-2, 0, 0, 0, 0, 0], stringCount: 6 }, { instrument: 'guitar-6' });
    s1.wt().setLaunchDefault('guitar-6');
    // Fresh boot with the SAME localStorage; settings say Standard → launch default wins.
    const s2 = makeSandbox({ localStorage: store, settings: { instrument: 'guitar', string_count: 6, tuning: 'Standard', reference_pitch: 440 } });
    await tick();
    assert.deepEqual(s2.wt().get('guitar-6').offsets, [-2, 0, 0, 0, 0, 0]);
    assert.equal(s2.wt().get('guitar-6').source, 'launch-default');
});

test('clearLaunchDefault removes it', () => {
    const s = makeSandbox();
    s.wt().set({ offsets: [-2, 0, 0, 0, 0, 0], stringCount: 6 }, { instrument: 'guitar-6' });
    s.wt().setLaunchDefault('guitar-6');
    s.wt().clearLaunchDefault('guitar-6');
    assert.equal(s.wt().getLaunchDefault('guitar-6'), null);
});

test('idempotent re-injection: a second load does NOT clobber live state', () => {
    const s = makeSandbox();
    s.wt().set({ offsets: [-2, 0, 0, 0, 0, 0], stringCount: 6 }, { instrument: 'guitar-6' });
    s.reinject();   // run the module source again in the same context
    assert.deepEqual(s.wt().get('guitar-6').offsets, [-2, 0, 0, 0, 0, 0]);   // preserved
});

test('working-tuning-changed fires on set with the changed instrument', () => {
    const s = makeSandbox();
    const seen = [];
    s.on('working-tuning-changed', (e) => seen.push(e));
    s.wt().set({ offsets: [-2, 0, 0, 0, 0, 0], stringCount: 6 }, { instrument: 'guitar-6' });
    assert.ok(seen.length >= 1);
    const last = seen[seen.length - 1];
    assert.equal(last.instrument, 'guitar');
    assert.deepEqual(last.tuning.offsets, [-2, 0, 0, 0, 0, 0]);
});
