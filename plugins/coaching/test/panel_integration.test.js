// Headless integration test for the no-key end-of-song panel. Loads the
// REAL coaching.js browser IIFE in a vm against a minimal DOM/event shim,
// then drives the actual note_detect event sequence and asserts:
//   1. with NO API key, a "Practice spots" panel appears at song end, and
//   2. clicking its "Practice this" button calls window.noteDetect.startDrill
//      with the hotspot's drill range.
// This is what proves the fix without anyone playing a song.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'coaching.js'), 'utf8');

// camelCase a data-* attribute name: loop-a → loopA.
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function makeEl(tag) {
    const el = {
        tagName: tag, id: '', className: '', textContent: '',
        style: {}, dataset: {}, parentNode: null,
        _children: [], _html: '',
        classList: { add() {}, remove() {}, toggle() {} },
        appendChild(c) { this._children.push(c); c.parentNode = this; return c; },
        removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) this._children.splice(i, 1); },
        remove() { if (this.parentNode) this.parentNode.removeChild(this); this.parentNode = null; },
        addEventListener() {},
        set innerHTML(html) { this._html = html; this._children = []; this._parse(html); },
        get innerHTML() { return this._html; },
        _parse(html) {
            // Build a child stub per <button ...> so querySelector(All) can
            // find the close + drill buttons and read their data-attrs.
            const re = /<button\b([^>]*)>/g;
            let m;
            while ((m = re.exec(html))) {
                const attrs = m[1];
                const b = makeEl('button');
                let a;
                const ar = /([a-zA-Z-]+)="([^"]*)"/g;
                while ((a = ar.exec(attrs))) {
                    const name = a[1], val = a[2];
                    if (name === 'id') b.id = val;
                    else if (name === 'class') b.className = val;
                    else if (name.startsWith('data-')) b.dataset[camel(name.slice(5))] = val;
                }
                this._children.push(b);
            }
        },
        _matches(sel) {
            if (sel.startsWith('#')) return this.id === sel.slice(1);
            if (sel.startsWith('.')) return (' ' + this.className + ' ').includes(' ' + sel.slice(1) + ' ');
            return false;
        },
        querySelector(sel) { return this._children.find(c => c._matches(sel)) || null; },
        querySelectorAll(sel) { return this._children.filter(c => c._matches(sel)); },
    };
    return el;
}

function harness() {
    const created = [];
    const host = makeEl('div'); host.id = 'player';
    const body = makeEl('body');
    const document = {
        getElementById(id) {
            if (id === 'player') return host;
            // Return the most-recently created element bearing this id.
            for (let i = created.length - 1; i >= 0; i--) if (created[i].id === id) return created[i];
            return null;
        },
        createElement(tag) { const e = makeEl(tag); created.push(e); return e; },
        querySelector() { return null; },
        body,
        addEventListener() {},
    };
    const winListeners = {};
    const smListeners = {};
    const startDrillCalls = [];
    const sandbox = {
        console, JSON, Math, Date, Array, Map, Set, Object,
        Promise, setTimeout: () => 0, clearTimeout() {},
        CustomEvent: class { constructor(t, init) { this.type = t; Object.assign(this, init); } },
        document,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },  // NO key
        fetch: () => Promise.reject(new Error('no network in test')),
        noteDetect: { startDrill: (a, b, opts) => { startDrillCalls.push({ a, b, opts }); return Promise.resolve(true); } },
        slopsmith: {
            on(t, fn) { (smListeners[t] = smListeners[t] || []).push(fn); },
            off() {},
            emit(t, d) { (smListeners[t] || []).forEach(fn => fn(d)); },
        },
    };
    sandbox.window = sandbox;
    sandbox.window.addEventListener = (t, fn) => { (winListeners[t] = winListeners[t] || []).push(fn); };
    sandbox.window.removeEventListener = () => {};
    const fireWin = (t, detail) => (winListeners[t] || []).forEach(fn => fn({ detail }));
    vm.createContext(sandbox);
    vm.runInContext(SRC, sandbox, { filename: 'coaching.js' });
    return { sandbox, host, fireWin, startDrillCalls };
}

// A PLAYER-fault miss (late) — hotspots cluster player faults, not unheard
// dropouts, so the panel/drill wiring tests exercise a real practice spot.
function missJudgment(t) {
    return { hit: false, noteTime: t, note: { s: 1, f: 5 }, expectedMidi: 33, detectedMidi: 33, timingState: 'LATE', timingError: 130, pitchError: null };
}

test('no-key: judgments fired DURING a drill do not pollute the next play', () => {
    const { sandbox, fireWin } = harness();
    // Simulate a drill loop re-judging the same passage 5× (window===sandbox,
    // so this sets window._ndAnyDrillActive that coaching's _push checks).
    sandbox._ndAnyDrillActive = true;
    for (let i = 0; i < 5; i++) fireWin('notedetect:miss', missJudgment(20 + i * 0.4));
    sandbox._ndAnyDrillActive = false;
    // Then a real full play with 3 of its own misses.
    fireWin('notedetect:miss', missJudgment(50.0));
    fireWin('notedetect:miss', missJudgment(50.4));
    fireWin('notedetect:miss', missJudgment(50.8));
    fireWin('notedetect:session', { song: 'Gasoline', arrangement: 'bass', sections: [] });
    const fb = sandbox.__coachingLastFeedback;
    assert.ok(fb, 'feedback built for the full play');
    assert.equal(fb.mistakes.length, 3, 'only the 3 full-play misses count — the 5 drill reps are skipped');
});

test('no-key: a zero-judgment false-start does NOT clobber a scored play\'s panel', () => {
    const { host, fireWin } = harness();
    // A real scored play → panel with Practice spots.
    fireWin('notedetect:miss', missJudgment(20.0));
    fireWin('notedetect:miss', missJudgment(20.4));
    fireWin('notedetect:miss', missJudgment(20.8));
    fireWin('notedetect:session', { song: 'Gasoline', arrangement: 'bass', sections: [] });
    const panel = host._children.find(c => c.id === 'coaching-summary-panel');
    assert.ok(panel, 'good play rendered a panel');
    assert.match(panel.innerHTML, /Practice spots/, 'good play shows practice spots');
    // A false-start: session fires with ZERO judgments (no hit/miss before it).
    fireWin('notedetect:session', { song: 'Gasoline', arrangement: 'bass', sections: [] });
    assert.match(panel.innerHTML, /Practice spots/, 'false-start did NOT overwrite the scored panel');
    assert.doesNotMatch(panel.innerHTML, /No notes were scored/, 'no "0% / no notes" alarm over a good play');
});

test('no-key: a clustered miss play surfaces a Practice panel at song end', () => {
    const { host, fireWin } = harness();
    // 3 misses within 0.8s → one hotspot (findHotspots default minMisses=2, gap=3s).
    fireWin('notedetect:miss', missJudgment(20.0));
    fireWin('notedetect:miss', missJudgment(20.4));
    fireWin('notedetect:miss', missJudgment(20.8));
    fireWin('notedetect:session', { song: 'Gasoline', arrangement: 'bass', sections: [] });

    const panel = host._children.find(c => c.id === 'coaching-summary-panel');
    assert.ok(panel, 'panel appended to the player host without any API key');
    assert.match(panel.innerHTML, /Practice spots/);
    const btns = panel.querySelectorAll('.coaching-drill-btn');
    assert.equal(btns.length, 1, 'one Practice button for the hotspot');
});

test('no-key: clicking Practice this calls noteDetect.startDrill with the drill range', () => {
    const { host, fireWin, startDrillCalls } = harness();
    fireWin('notedetect:miss', missJudgment(20.0));
    fireWin('notedetect:miss', missJudgment(20.4));
    fireWin('notedetect:miss', missJudgment(20.8));
    fireWin('notedetect:session', { song: 'Gasoline', arrangement: 'bass', sections: [] });

    const panel = host._children.find(c => c.id === 'coaching-summary-panel');
    const btn = panel.querySelectorAll('.coaching-drill-btn')[0];
    assert.ok(btn && typeof btn.onclick === 'function', 'button wired with an onclick');
    btn.onclick();

    assert.equal(startDrillCalls.length, 1, 'startDrill invoked once');
    const call = startDrillCalls[0];
    // drill range = the raw cluster span [20.0, 20.8]; note_detect.startDrill
    // adds its own lead-in/runway (no coaching-side padding, which used to
    // double-stack with it).
    assert.ok(Math.abs(call.a - 20.0) < 1e-9, `start = cluster start 20.0 (${call.a})`);
    assert.ok(Math.abs(call.b - 20.8) < 1e-9, `end = cluster end 20.8 (${call.b})`);
    assert.ok(Array.isArray(call.opts.speedLadder) && call.opts.speedLadder[0] === 0.7, 'slowed ladder from speedMul 0.7');
    assert.ok(call.opts.goal === 0.85 || call.opts.goal === undefined);
});

test('no-key: a single scattered miss still yields a drill target', () => {
    const { host, fireWin } = harness();
    // One miss — too few to cluster into a hotspot — but "drill any spot you
    // missed" means it MUST still surface a drillable Missed-spots target
    // (previously it showed the panel with NO button; ~13% of real takes hit
    // this dead end).
    fireWin('notedetect:miss', missJudgment(20.0));
    fireWin('notedetect:session', { song: 'Sparse', arrangement: 'bass', sections: [] });
    const panel = host._children.find(c => c.id === 'coaching-summary-panel');
    assert.ok(panel, 'panel shown');
    assert.equal(panel.querySelectorAll('.coaching-drill-btn').length, 1, 'the single miss is drillable');
});

test('no-key: a truly clean play shows the panel with no drill button', () => {
    const { host, fireWin } = harness();
    fireWin('notedetect:hit', { hit: true, noteTime: 20, note: { s: 1, f: 5 }, clean: true });
    fireWin('notedetect:session', { song: 'Clean', arrangement: 'bass', sections: [] });
    const panel = host._children.find(c => c.id === 'coaching-summary-panel');
    assert.ok(panel, 'panel still shown on a clean play');
    assert.equal(panel.querySelectorAll('.coaching-drill-btn').length, 0, 'no drill button when nothing was missed');
});
