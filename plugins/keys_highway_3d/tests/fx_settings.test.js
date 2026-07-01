// FX-settings scaffold tests (guitar-highway parity controls). Same bare-vm
// harness as data_layer.test.js — no DOM, no localStorage — which doubles as
// a lint that the new module-scope FX code stays side-effect safe.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(extraWindow) {
    const window = {
        console,
        location: { protocol: 'http:', host: 'localhost' },
        slopsmith: {},
        ...extraWindow,
    };
    window.window = window;
    window.globalThis = window;
    const context = vm.createContext(window);
    const src = fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8');
    vm.runInContext(src, context, { filename: 'screen.js' });
    return window;
}

test('readFxSettings: defaults survive a localStorage-less environment', () => {
    const { readFxSettings, FX_DEFAULTS } = load().slopsmithViz_keys_highway_3d.__test;
    assert.deepEqual(readFxSettings(), FX_DEFAULTS);
    assert.equal(FX_DEFAULTS.bloom, true); // effects on by default
});

test('readFxSettings: reads keys3d_bg_* overrides and coerces types', () => {
    const store = { keys3d_bg_bloom: '0' };
    const win = load({
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = v; },
        },
    });
    const { readFxSettings } = win.slopsmithViz_keys_highway_3d.__test;
    assert.equal(readFxSettings().bloom, false);
    store.keys3d_bg_bloom = 'true';
    assert.equal(readFxSettings().bloom, true);
    store.keys3d_bg_bloom = 'false';
    assert.equal(readFxSettings().bloom, false);
    // Corrupt/foreign value → keep the default rather than silently
    // disabling the effect.
    store.keys3d_bg_bloom = 'banana';
    assert.equal(readFxSettings().bloom, true);
});

test('keys3dSetFx: persists, coerces, and ignores unknown keys', () => {
    const store = {};
    const events = [];
    const win = load({
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = v; },
        },
        dispatchEvent: (ev) => { events.push(ev); return true; },
        CustomEvent: class CustomEvent {
            constructor(type, opts) { this.type = type; this.detail = opts && opts.detail; }
        },
    });
    win.keys3dSetFx('bloom', false);
    assert.equal(store.keys3d_bg_bloom, '0');
    // String forms round-trip like the reader's accepted representations.
    win.keys3dSetFx('bloom', 'false');
    assert.equal(store.keys3d_bg_bloom, '0');
    win.keys3dSetFx('bloom', 'true');
    assert.equal(store.keys3d_bg_bloom, '1');
    win.keys3dSetFx('bloom', false);
    assert.equal(events.length, 4);
    assert.equal(events[0].type, 'keys3d:settings');
    // Field-wise (the detail object was built inside the vm realm, so a
    // deep-strict compare would trip on its foreign Object.prototype).
    assert.equal(events[0].detail.fx.bloom, false);
    assert.deepEqual(Object.keys(events[0].detail.fx), ['bloom']);
    // Unknown key: no write, no event.
    win.keys3dSetFx('nonsense', 1);
    assert.equal(events.length, 4);
    assert.ok(!('keys3d_bg_nonsense' in store));
});
