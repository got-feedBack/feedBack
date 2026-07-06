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

test('_classifyTiming: OK band is 40% of the window, sign maps early/late', () => {
    const { _classifyTiming } = load().slopsmithViz_keys_highway_3d.__test;
    const tol = 0.10;                    // keys HIT_TOLERANCE_S
    assert.equal(_classifyTiming(0, tol), 'OK');
    assert.equal(_classifyTiming(tol * 0.4, tol), 'OK');
    assert.equal(_classifyTiming(-tol * 0.4, tol), 'OK');
    // delta = note.t - now: positive → struck before the note → EARLY.
    assert.equal(_classifyTiming(tol * 0.41, tol), 'EARLY');
    assert.equal(_classifyTiming(-tol * 0.41, tol), 'LATE');
    assert.equal(_classifyTiming(NaN, tol), 'OK');
});

test('noteKey prefix round-trips the matched note time (timing-delta source)', () => {
    const { noteKey } = load().slopsmithViz_keys_highway_3d.__test;
    // _checkHit derives the timing delta as parseFloat(judgeHit's key) - t;
    // this pins the serialization that makes that recovery valid.
    assert.equal(parseFloat(noteKey(12.3456, 60)), 12.346);
    assert.equal(parseFloat(noteKey(0, 21)), 0);
});

test('FX defaults: hit-FX + vibrancy controls ship enabled', () => {
    const { FX_DEFAULTS } = load().slopsmithViz_keys_highway_3d.__test;
    assert.equal(FX_DEFAULTS.sparks, true);
    assert.equal(FX_DEFAULTS.timingFx, true);
    assert.equal(FX_DEFAULTS.streakFx, true);
    assert.equal(FX_DEFAULTS.hitFx, 0.7);
    assert.equal(FX_DEFAULTS.vibrancy, 0.85);
});

test('themes: table ids match the guitar highway, default is the stock palette', () => {
    const { BG_THEMES, _bgThemeColors, readThemeSetting } = load().slopsmithViz_keys_highway_3d.__test;
    assert.deepEqual(Object.keys(BG_THEMES), [
        'default', 'midnight', 'charcoal', 'deeppurple', 'forest', 'warmslate',
        'deepfocus', 'deepsea', 'cathode', 'cathodegreen', 'hearth',
    ]);
    // 'default' preserves THIS plugin's original look.
    assert.equal(BG_THEMES.default.clear, 0x1a1a2e);
    assert.equal(BG_THEMES.default.board, 0x141422);
    assert.equal(BG_THEMES.default.laneDim, 0x2a2a3e);
    assert.equal(_bgThemeColors('nonsense'), BG_THEMES.default);
    assert.equal(readThemeSetting(), 'default'); // no localStorage in the vm
    for (const [id, t] of Object.entries(BG_THEMES)) {
        assert.equal(t.clear, t.fog, id + ' clear==fog (horizon dissolve)');
        assert.ok(t.laneDim != null, id + ' rail color');
    }
});

test('FX defaults: theme-PR controls ship enabled at stock-neutral values', () => {
    const { FX_DEFAULTS } = load().slopsmithViz_keys_highway_3d.__test;
    assert.equal(FX_DEFAULTS.cinematic, true);
    assert.equal(FX_DEFAULTS.glow, 0.5);   // 0.5 = 1.0x multiplier (stock)
});


test('bg styles: validated id set, particles default', () => {
    const { BG_STYLE_IDS, readBgStyleSetting } = load().slopsmithViz_keys_highway_3d.__test;
    // Host-realm copy — the vm array's foreign prototype trips deepEqual.
    assert.deepEqual([...BG_STYLE_IDS], ['off', 'particles', 'lights', 'geometric']);
    assert.equal(readBgStyleSetting(), 'particles');
});

test('FX defaults: ambience + score FX ship enabled', () => {
    const { FX_DEFAULTS } = load().slopsmithViz_keys_highway_3d.__test;
    assert.equal(FX_DEFAULTS.scoreFx, true);
    assert.equal(FX_DEFAULTS.bgIntensity, 0.5);
    assert.equal(FX_DEFAULTS.bgReactive, true);
});

/* ── Note-colour palettes (feat/keys3d-note-palettes) ────────────────── */

test('note palettes: 12 entries each, classic IS the stock table', () => {
    const { NOTE_PALETTES, PITCH_CLASS_COLORS } =
        load().slopsmithViz_keys_highway_3d.__test;
    assert.deepEqual(Object.keys(NOTE_PALETTES),
        ['classic', 'emerald', 'vivid', 'pastel', 'ice']);
    for (const [id, colors] of Object.entries(NOTE_PALETTES)) {
        assert.equal(colors.length, 12, id + ' has one colour per pitch class');
        for (const c of colors) {
            assert.ok(Number.isInteger(c) && c >= 0 && c <= 0xffffff,
                id + ' colours are 24-bit ints');
        }
    }
    // 'classic' preserves the shipped look byte-identically — it is the
    // same array, not a copy that could drift.
    assert.equal(NOTE_PALETTES.classic, PITCH_CLASS_COLORS);
    assert.equal(PITCH_CLASS_COLORS[0], 0xff3030); // C stays red in classic
});

test('note palettes: two-tone tables use darker sharps than naturals', () => {
    const { NOTE_PALETTES } = load().slopsmithViz_keys_highway_3d.__test;
    const luma = (c) =>
        0.2126 * ((c >> 16) & 0xff) + 0.7152 * ((c >> 8) & 0xff) + 0.0722 * (c & 0xff);
    for (const id of ['emerald', 'ice']) {
        const p = NOTE_PALETTES[id];
        for (const sharp of [1, 3, 6, 8, 10]) {
            assert.ok(luma(p[sharp]) < luma(p[0]),
                id + ' sharp pc ' + sharp + ' darker than naturals');
        }
    }
});

test('readPaletteSetting: octaves default, validated overrides only', () => {
    // No localStorage in the vm → the plug-and-play default.
    const bare = load().slopsmithViz_keys_highway_3d.__test;
    assert.equal(bare.readPaletteSetting(), 'octaves');
    // An explicit non-default value (classic) overrides.
    const store = { keys3d_bg_palette: 'classic' };
    const win = load({
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = v; },
        },
    });
    const { readPaletteSetting } = win.slopsmithViz_keys_highway_3d.__test;
    assert.equal(readPaletteSetting(), 'classic');
    // Corrupt/foreign value → the default rather than an undefined scheme.
    store.keys3d_bg_palette = 'banana';
    assert.equal(readPaletteSetting(), 'octaves');
});

test('keys3dSetPalette: persists + dispatches valid ids, ignores unknown', () => {
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
    win.keys3dSetPalette('emerald');
    assert.equal(store.keys3d_bg_palette, 'emerald');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'keys3d:settings');
    assert.equal(events[0].detail.palette, 'emerald');
    // Unknown id: no write, no event.
    win.keys3dSetPalette('banana');
    assert.equal(store.keys3d_bg_palette, 'emerald');
    assert.equal(events.length, 1);
    // 'octaves' (procedural, not a 12-array) is a valid selectable id.
    win.keys3dSetPalette('octaves');
    assert.equal(store.keys3d_bg_palette, 'octaves');
    assert.equal(events.length, 2);
});

test('PALETTE_IDS: the array palettes plus the procedural octaves scheme', () => {
    const { PALETTE_IDS, NOTE_PALETTES } = load().slopsmithViz_keys_highway_3d.__test;
    assert.deepEqual([...PALETTE_IDS],
        [...Object.keys(NOTE_PALETTES), 'octaves']);
    assert.ok(PALETTE_IDS.indexOf('octaves') !== -1);
    assert.ok(!('octaves' in NOTE_PALETTES)); // it is NOT a 12-entry table
});

test('octaveNoteColor: hue steps per octave, loops, sharps darker, sub-C1 distinct', () => {
    const { octaveNoteColor, OCTAVE_HUES } = load().slopsmithViz_keys_highway_3d.__test;
    const luma = (c) =>
        0.2126 * ((c >> 16) & 0xff) + 0.7152 * ((c >> 8) & 0xff) + 0.0722 * (c & 0xff);
    // C1 (midi 24) = first hue; C2 (36) = second; C8 (108) = 8th (index 7).
    assert.equal(octaveNoteColor(24), OCTAVE_HUES[0]);   // C1 red
    assert.equal(octaveNoteColor(35), OCTAVE_HUES[0]);   // B1 still octave 1
    assert.equal(octaveNoteColor(36), OCTAVE_HUES[1]);   // C2 orange
    assert.equal(octaveNoteColor(60), OCTAVE_HUES[3]);   // C4 (middle C)
    assert.equal(octaveNoteColor(108), OCTAVE_HUES[7]);  // C8 last hue
    // Naturals across one octave (C1..B1 whites) all share the octave hue.
    for (const nat of [24, 26, 28, 29, 31, 33, 35]) {
        assert.equal(octaveNoteColor(nat), OCTAVE_HUES[0], 'natural ' + nat);
    }
    // Sharps in an octave are a DARKER shade of that same hue.
    for (const sharp of [25, 27, 30, 32, 34]) { // C#1..A#1
        assert.ok(luma(octaveNoteColor(sharp)) < luma(OCTAVE_HUES[0]),
            'sharp ' + sharp + ' darker than the octave natural');
    }
    // The three keys below C1 (A0/A#0/B0) share a distinct sub-C1 colour,
    // different from the red octave-1 start.
    assert.equal(octaveNoteColor(21), octaveNoteColor(23)); // A0 == B0 hue
    assert.notEqual(octaveNoteColor(21), OCTAVE_HUES[0]);
    // Loop: an octave past the table wraps (safety for out-of-88 midi).
    assert.equal(octaveNoteColor(24 + 12 * OCTAVE_HUES.length), OCTAVE_HUES[0]);
});

/* ── Camera presets + fine-tune (feat/keys3d-camera) ─────────────────── */

test('FX defaults: camera height/distance/tilt all neutral (preset carries the tuned aim)', () => {
    const { FX_DEFAULTS, FX_RANGES } = load().slopsmithViz_keys_highway_3d.__test;
    assert.equal(FX_DEFAULTS.camHeight, 1.0);
    assert.equal(FX_DEFAULTS.camDist, 1.0);
    // Tilt ships NEUTRAL (0): the tuned plug-and-play aim now lives in
    // CAM_PRESETS.overhead.lookY, so the fine-tune only nudges from a preset
    // and 'classic' + this default reproduces the exact historical rig.
    assert.equal(FX_DEFAULTS.camTilt, 0.0);
    assert.ok(FX_DEFAULTS.camTilt >= FX_RANGES.camTilt[0] && FX_DEFAULTS.camTilt <= FX_RANGES.camTilt[1]);
    // Height/distance bracket 1 (can go lower AND higher); tilt spans 0.
    assert.ok(FX_RANGES.camHeight[0] < 1 && 1 < FX_RANGES.camHeight[1]);
    assert.ok(FX_RANGES.camDist[0] < 1 && 1 < FX_RANGES.camDist[1]);
    assert.ok(FX_RANGES.camTilt[0] < 0 && 0 < FX_RANGES.camTilt[1]);
});

test('camTilt: negative values survive the clamp (down-tilt must be reachable)', () => {
    const store = {};
    const win = load({
        localStorage: {
            getItem: (k) => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = v; },
        },
        dispatchEvent: () => true,
        CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    });
    const { FX_RANGES } = win.slopsmithViz_keys_highway_3d.__test;
    win.keys3dSetFx('camTilt', -0.5);
    assert.equal(store.keys3d_bg_camTilt, '-0.5');   // NOT crushed to 0 by a 0-1 clamp
    win.keys3dSetFx('camTilt', -99);
    assert.equal(parseFloat(store.keys3d_bg_camTilt), FX_RANGES.camTilt[0]);
});

test('FX ranges: reader + setter clamp to the declared range, not 0-1', () => {
    const store = { keys3d_bg_camHeight: '5', keys3d_bg_camDist: '0.01' };
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
    const { readFxSettings, FX_RANGES } = win.slopsmithViz_keys_highway_3d.__test;
    // Reader: corrupt/out-of-range writes clamp to the declared bounds.
    assert.equal(readFxSettings().camHeight, FX_RANGES.camHeight[1]);
    assert.equal(readFxSettings().camDist, FX_RANGES.camDist[0]);
    // Setter: same clamp on the way in; a value above 1 must survive
    // (the historical 0-1 clamp would have crushed 1.3 to 1).
    win.keys3dSetFx('camHeight', 1.3);
    assert.equal(store.keys3d_bg_camHeight, '1.3');
    win.keys3dSetFx('camDist', 99);
    assert.equal(parseFloat(store.keys3d_bg_camDist), FX_RANGES.camDist[1]);
    // Un-ranged keys keep the historical 0-1 clamp.
    win.keys3dSetFx('vibrancy', 2);
    assert.equal(store.keys3d_bg_vibrancy, '1');
});

test('scrollZ: distance-to-hitline scales linearly with the speed argument', () => {
    const { scrollZ } = load().slopsmithViz_keys_highway_3d.__test;
    const hitZ = 0;
    const d1 = scrollZ(2, 0, hitZ, 130) - hitZ;   // 2s ahead at stock speed
    const d2 = scrollZ(2, 0, hitZ, 260) - hitZ;   // same note at 2x speed
    assert.equal(d2, d1 * 2);
    // At the hit moment the note is at the hit-line regardless of speed.
    assert.equal(scrollZ(5, 5, hitZ, 130), hitZ);
    assert.equal(scrollZ(5, 5, hitZ, 260), hitZ);
});

test('camera presets: classic preserves the stock rig, overhead is the default', () => {
    const { CAM_PRESETS, readCameraSetting } = load().slopsmithViz_keys_highway_3d.__test;
    assert.deepEqual(Object.keys(CAM_PRESETS), ['classic', 'elevated', 'overhead']);
    // 'classic' preserves the historical constants (pre-K units) even though
    // it is no longer the default — anyone who picks it gets the old rig back
    // EXACTLY, because camTilt now defaults to 0 (neutral): effective aim =
    // classic.lookY + 0*CAM_TILT_UNITS = 8, the historical LOOK_Y.
    assert.deepEqual({ ...CAM_PRESETS.classic },
        { fov: 40, y: 46, z: 112, lookY: 8, lookZ: -165 });
    for (const [id, p] of Object.entries(CAM_PRESETS)) {
        for (const f of ['fov', 'y', 'z', 'lookY', 'lookZ']) {
            assert.ok(Number.isFinite(p[f]), id + '.' + f + ' is a number');
        }
        assert.ok(p.y > 0 && p.z > 0, id + ' sits above and behind the keys');
    }
    assert.equal(readCameraSetting(), 'overhead'); // no localStorage in the vm → tuned default
});

test('camera default look is unchanged: overhead bakes the old tuned tilt, camTilt is neutral', () => {
    const { CAM_PRESETS, FX_DEFAULTS } = load().slopsmithViz_keys_highway_3d.__test;
    const CAM_TILT_UNITS = 55; // full-swing of the camTilt offset at ±1 (screen.js)
    // The shipped default look = overhead preset + the default camTilt. Before,
    // that was lookY 0 + (−0.6 × 55) = −33; the tuned aim now lives in the
    // preset (lookY −33) with a neutral camTilt (0), so the effective aim — and
    // thus the out-of-the-box framing — is byte-identical.
    const effOverhead = CAM_PRESETS.overhead.lookY + FX_DEFAULTS.camTilt * CAM_TILT_UNITS;
    assert.equal(effOverhead, -33);
    // 'classic' + the neutral default reproduces the historical LOOK_Y (8) —
    // the "pick Classic for the original look" promise, now actually true.
    const effClassic = CAM_PRESETS.classic.lookY + FX_DEFAULTS.camTilt * CAM_TILT_UNITS;
    assert.equal(effClassic, 8);
});

test('keys3dSetCamera: persists + dispatches valid ids, ignores unknown', () => {
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
    win.keys3dSetCamera('overhead');
    assert.equal(store.keys3d_bg_camera, 'overhead');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'keys3d:settings');
    assert.equal(events[0].detail.camera, 'overhead');
    win.keys3dSetCamera('helicopter');
    assert.equal(store.keys3d_bg_camera, 'overhead');
    assert.equal(events.length, 1);
    const { readCameraSetting } = win.slopsmithViz_keys_highway_3d.__test;
    assert.equal(readCameraSetting(), 'overhead');
    store.keys3d_bg_camera = 'garbage';
    assert.equal(readCameraSetting(), 'overhead');
});

