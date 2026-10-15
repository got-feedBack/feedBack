// Verify the v3 Pedalboard Plugins page (static/v3/plugins-page.js) pure
// helpers: category resolution (manifest override > curated > derive > other),
// thumbnail URL building, click-target selection (settings vs screen vs none),
// drag clamping, default-flow slots, and the localStorage layout round-trip.
//
// The page exposes these helpers on window.v3PluginsPage._test, so we load the
// IIFE in a vm sandbox with a minimal window/document and read them back —
// no brace-extraction needed.

const { test } = require('node:test');
// Non-strict assert on purpose: helpers return objects created inside the vm
// realm, whose Object.prototype differs from this realm's — strict deepEqual
// would fail the prototype check even when the structure matches.
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', '..', 'static', 'v3', 'plugins-page.js');

function loadPage(opts) {
    opts = opts || {};
    const store = opts.store || {};
    const win = { feedBack: null };
    win.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { if (opts.throwOnSet) throw new Error('quota'); store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
    };
    win.addEventListener = () => {};
    win.matchMedia = () => ({ matches: false });
    const doc = Object.assign({
        readyState: 'complete',
        getElementById: () => null,          // render() bails: no #v3-plugins
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
    }, opts.doc || {});
    const ctx = {
        window: win, document: doc, console,
        fetch: () => Promise.reject(new Error('no fetch in test')),
        requestAnimationFrame: () => 0,
        setTimeout: () => 0, clearTimeout: () => {},
    };
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(SRC, 'utf8'), ctx, { filename: 'plugins-page.js' });
    return { api: win.v3PluginsPage, t: win.v3PluginsPage._test, store, win };
}

test('categoryOf: manifest category is authoritative (lowercased)', () => {
    const { t } = loadPage();
    assert.equal(t.categoryOf({ id: 'whatever', category: 'Audio' }), 'audio');
    // Even an unknown manifest category wins over the curated map.
    assert.equal(t.categoryOf({ id: 'nam_tone', category: 'Custom' }), 'custom');
});

test('categoryOf: curated map, then type-derive, then other', () => {
    const { t } = loadPage();
    assert.equal(t.categoryOf({ id: 'nam_tone' }), 'audio');
    assert.equal(t.categoryOf({ id: 'flappy_bend' }), 'game');
    assert.equal(t.categoryOf({ id: 'editor' }), 'tools');
    assert.equal(t.categoryOf({ id: 'unknown_x', type: 'visualization' }), 'creation');
    assert.equal(t.categoryOf({ id: 'unknown_x' }), 'other');
    assert.equal(t.categoryOf(null), 'other');
});

test('thumbUrl: manifest icon routes through the asset endpoint; else default', () => {
    const { t } = loadPage();
    assert.equal(t.thumbUrl({ id: 'flappy_bend', icon: 'assets/thumb.png' }),
        '/api/plugins/flappy_bend/assets/thumb.png');
    // Leading assets/ is stripped (route path is relative to assets/).
    assert.equal(t.thumbUrl({ id: 'x', icon: 'assets/img/p.svg' }), '/api/plugins/x/assets/img/p.svg');
    assert.equal(t.thumbUrl({ id: 'x' }), '/static/v3/pedal-default.svg');
    assert.equal(t.thumbUrl({ id: 'x', icon: '' }), '/static/v3/pedal-default.svg');
});

test('settingsTarget: screen > settings > none', () => {
    const { t } = loadPage();
    // A screen wins even when the plugin also has settings (e.g. audio_engine):
    // the pedal opens the plugin's page, not its settings panel.
    assert.deepEqual(t.settingsTarget({ id: 'a', has_settings: true, nav: true }), { kind: 'screen', id: 'a' });
    assert.deepEqual(t.settingsTarget({ id: 'b', has_settings: false, nav: true }), { kind: 'screen', id: 'b' });
    assert.deepEqual(t.settingsTarget({ id: 'c', has_settings: false, has_screen: true }), { kind: 'screen', id: 'c' });
    // Settings-only plugin (no screen) falls back to its settings panel.
    assert.deepEqual(t.settingsTarget({ id: 'e', has_settings: true }), { kind: 'settings', id: 'e' });
    assert.deepEqual(t.settingsTarget({ id: 'd' }), { kind: 'none', id: 'd' });
});

test('clampToBoard: x clamped to [0, boardW-pedalW]; y floored at 0', () => {
    const { t } = loadPage();
    assert.deepEqual(t.clampToBoard({ x: 999, y: 50 }, 800, 150), { x: 650, y: 50 });
    assert.deepEqual(t.clampToBoard({ x: -40, y: -10 }, 800, 150), { x: 0, y: 0 });
    // Board narrower than a pedal → maxX floors at 0.
    assert.deepEqual(t.clampToBoard({ x: 30, y: 5 }, 100, 150), { x: 0, y: 5 });
});

test('defaultSlot: padding origin; column count adapts to board width', () => {
    const { t } = loadPage();
    const s0 = t.defaultSlot(0, 1200);
    assert.equal(s0.x, 24);
    assert.equal(s0.y, 24);
    // 2nd pedal is to the right on the same row (≥2 columns at this width).
    const s1 = t.defaultSlot(1, 1200);
    assert.ok(s1.x > s0.x);
    assert.equal(s1.y, s0.y);
    // Number of columns = index where the row first wraps. Wider board → more.
    const cols = (bw) => { const y0 = t.defaultSlot(0, bw).y; let i = 1; while (i < 50 && t.defaultSlot(i, bw).y === y0) i++; return i; };
    assert.ok(cols(2200) > cols(700), 'more columns on a wider board');
    assert.ok(cols(700) >= 1);
});

test('loadLayout/saveLayout: round-trip + corruption tolerance', () => {
    const { t, store } = loadPage();
    assert.deepEqual(t.loadLayout(), {});
    t.saveLayout({ audio: { nam_tone: { x: 10, y: 20 } } });
    assert.deepEqual(t.loadLayout(), { audio: { nam_tone: { x: 10, y: 20 } } });
    assert.ok(store[t.LS_KEY]);
    // Corrupt JSON → empty object, no throw.
    store[t.LS_KEY] = '{not json';
    assert.deepEqual(t.loadLayout(), {});
});

test('saveLayout: swallows storage exceptions (quota / private mode)', () => {
    const { t } = loadPage({ throwOnSet: true });
    assert.doesNotThrow(() => t.saveLayout({ a: 1 }));
});

test('frameFor: assigns a pool skin, persists it, and sticks across calls', () => {
    const { t } = loadPage();
    const frames = {};
    const f1 = t.frameFor('alpha', frames);
    assert.ok(t.PEDAL_FRAMES.includes(f1), 'assigned skin is from the pool');
    assert.equal(frames.alpha, f1, 'assignment recorded for persistence');
    assert.equal(t.frameFor('alpha', frames), f1, 'same plugin keeps the same skin');
    // A stale/invalid saved skin (e.g. removed from the pool) is re-picked.
    frames.beta = 'gone.png';
    const f3 = t.frameFor('beta', frames);
    assert.ok(t.PEDAL_FRAMES.includes(f3), 're-picked a valid skin');
    assert.ok(t.frameUrl('pedal-002.png').startsWith('/static/v3/pedals/pedal-002.png'));
});

test('loadCollapsed/saveCollapsed: round-trip + corruption tolerance', () => {
    const { t, store } = loadPage();
    assert.deepEqual(t.loadCollapsed(), {});
    t.saveCollapsed({ audio: true });
    assert.deepEqual(t.loadCollapsed(), { audio: true });
    store[t.COLLAPSE_KEY] = '{bad';
    assert.deepEqual(t.loadCollapsed(), {});
});

test('DRAG_THRESHOLD is a small positive pixel budget', () => {
    const { t } = loadPage();
    assert.equal(typeof t.DRAG_THRESHOLD, 'number');
    assert.ok(t.DRAG_THRESHOLD > 0 && t.DRAG_THRESHOLD < 20);
});

// ── Settings panel lookup across tabs (#746) ────────────────────────────────
// A plugin with settings.category (e.g. the 3D highways → "graphics") mounts
// its <details> in #plugin-settings-graphics, not #plugin-settings. The pedal
// must find it there and bring its tab to the front.

function fakeSettingsDom() {
    const clicks = [];
    const panel = (tab) => ({ dataset: { tab } });
    const details = (id, tab) => ({
        getAttribute: (k) => (k === 'data-plugin-id' ? id : null),
        closest: (sel) => (sel === '.fb-tabpanel' ? panel(tab) : null),
    });
    const all = [details('tuner', 'plugins'), details('highway_3d', 'graphics')];
    const tabs = ['gameplay', 'graphics', 'plugins'].map((tab) => ({
        dataset: { tab }, click: () => clicks.push(tab),
    }));
    const queries = [];
    const doc = {
        querySelectorAll: (sel) => {
            queries.push(sel);
            if (sel.indexOf('details[data-plugin-id]') !== -1) return all;
            if (sel === '#settings-tabbar .fb-tab') return tabs;
            return [];
        },
    };
    return { doc, clicks, queries };
}

test('findSettingsPanel: finds a panel mounted in a per-tab container', () => {
    const dom = fakeSettingsDom();
    const { t } = loadPage({ doc: dom.doc });
    const d = t.findSettingsPanel('highway_3d');
    assert.ok(d, 'graphics-tab panel not found');
    assert.equal(d.getAttribute('data-plugin-id'), 'highway_3d');
    // The lookup must not be limited to #plugin-settings.
    assert.ok(dom.queries.some((q) => q.indexOf('#settings details[data-plugin-id]') !== -1));
    assert.equal(t.findSettingsPanel('missing'), null);
});

test('showSettingsTabFor: clicks the tab that holds the panel', () => {
    const dom = fakeSettingsDom();
    const { t } = loadPage({ doc: dom.doc });
    t.showSettingsTabFor(t.findSettingsPanel('highway_3d'));
    assert.deepEqual(dom.clicks, ['graphics']);
    t.showSettingsTabFor(t.findSettingsPanel('tuner'));
    assert.deepEqual(dom.clicks, ['graphics', 'plugins']);
});

test('showSettingsTabFor: no-op outside a tab panel (classic settings page)', () => {
    const dom = fakeSettingsDom();
    const { t } = loadPage({ doc: dom.doc });
    t.showSettingsTabFor({ closest: () => null });
    t.showSettingsTabFor(null);
    assert.deepEqual(dom.clicks, []);
});

// Drive the handler the pedal's click/keydown calls, so the test fails if
// openSettingsPanel ever stops bringing the panel's tab to the front.
function fakePedalDom() {
    const events = [];
    const details = (id, tab) => {
        const d = {
            getAttribute: (k) => (k === 'data-plugin-id' ? id : null),
            closest: (sel) => (sel === '.fb-tabpanel' ? { dataset: { tab } } : null),
            scrollIntoView: () => events.push('scroll:' + id),
        };
        Object.defineProperty(d, 'open', { set: (v) => events.push('open:' + id + '=' + v) });
        return d;
    };
    const all = [details('tuner', 'plugins'), details('highway_3d', 'graphics')];
    const tabs = ['gameplay', 'graphics', 'plugins'].map((tab) => ({
        dataset: { tab }, click: () => events.push('tab:' + tab),
    }));
    const doc = {
        getElementById: () => null,
        querySelectorAll: (sel) => {
            if (sel.indexOf('details[data-plugin-id]') !== -1) return all;
            if (sel === '#settings-tabbar .fb-tab') return tabs;
            return [];
        },
    };
    return { doc, events };
}

test('pedal activation: settings-only plugin selects its inactive tab before opening', () => {
    const dom = fakePedalDom();
    const { t, win } = loadPage({ doc: dom.doc });
    win.showScreen = (id) => dom.events.push('screen:' + id);
    t.openPluginSettings({ id: 'highway_3d', has_settings: true });
    assert.deepEqual(dom.events, [
        'screen:settings', 'tab:graphics', 'open:highway_3d=true', 'scroll:highway_3d',
    ]);
});

test('pedal activation: unmounted screen falls back to the settings panel in its tab', () => {
    const dom = fakePedalDom();
    const { t, win } = loadPage({ doc: dom.doc });
    win.showScreen = (id) => dom.events.push('screen:' + id);
    t.openPluginSettings({ id: 'highway_3d', has_screen: true, has_settings: true });
    assert.deepEqual(dom.events, [
        'screen:settings', 'tab:graphics', 'open:highway_3d=true', 'scroll:highway_3d',
    ]);
});
