// The Section Practice UI is refreshed from the 60 Hz time tick in static/app.js
// (_updateSectionPracticeHighlight -> _syncSectionPracticePieceUi) and from the
// highway draw hook (_placeSectionPracticeControlForChrome ->
// _syncSectionPracticePillV3Chrome). Those used to rewrite label.textContent,
// prev/next .disabled, the pill's title/aria-label and re-query + re-toggle every
// chip on every call, even when nothing changed. Each write invalidates
// style/layout on the main thread the highway renders on.
//
// These tests drive the real function bodies against stub elements that count
// writes, and assert that a second call with unchanged state writes nothing.
//
// Same extraction approach as count_in_beats.test.js: pull the function source
// out of the module and evaluate it in a vm sandbox.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'static', 'js', 'section-practice.js'), 'utf8');

function extractFunction(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`extractFunction: '${signature}' not found`);
    const openBrace = src.indexOf('{', src.indexOf(')', start));
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    }
    return src.slice(start, i).replace(/^export\s+/, '');
}

const FNS = [
    'function _setAttrIfChanged(',
    'function _syncSectionPracticePillV3Chrome(',
    'function _syncSectionPracticePieceUi(',
    'function _sectionPracticeChipRefs(',
    'export function _updateSectionPracticeHighlight(',
].map((sig) => extractFunction(SRC, sig)).join('\n');


// Minimal element stub. Every DOM write bumps `writes` (shared counter).
function makeEl(counter, { id = '', classes = [], dataset = {} } = {}) {
    const cls = new Set(classes);
    const attrs = new Map();
    let text = '';
    let checked = false;
    let disabled = false;
    const el = {
        id,
        dataset,
        isConnected: true,
        children: [],
        get textContent() { return text; },
        set textContent(v) { counter.writes++; text = String(v); },
        get checked() { return checked; },
        set checked(v) { counter.writes++; checked = !!v; },
        get disabled() { return disabled; },
        set disabled(v) { counter.writes++; disabled = !!v; },
        getAttribute(n) { return attrs.has(n) ? attrs.get(n) : null; },
        setAttribute(n, v) { counter.writes++; attrs.set(n, String(v)); },
        classList: {
            contains: (c) => cls.has(c),
            // DOMTokenList.toggle(token, force) only mutates when state changes.
            toggle(c, force) {
                const want = force === undefined ? !cls.has(c) : !!force;
                if (want !== cls.has(c)) { counter.writes++; if (want) cls.add(c); else cls.delete(c); }
                return want;
            },
            add(c) { if (!cls.has(c)) { counter.writes++; cls.add(c); } },
            remove(c) { if (cls.has(c)) { counter.writes++; cls.delete(c); } },
        },
        contains(other) { return el.children.includes(other); },
        querySelector() { return null; },
        querySelectorAll() { counter.queries++; return el.children.slice(); },
        insertBefore() { counter.writes++; },
    };
    return el;
}

function load({ chipCount = 4 } = {}) {
    const counter = { writes: 0, queries: 0 };
    const els = {
        'section-practice-piece-label': makeEl(counter),
        'section-practice-piece-prev': makeEl(counter),
        'section-practice-piece-next': makeEl(counter),
        'section-practice-whole': makeEl(counter),
        'section-practice-pill': makeEl(counter),
        'section-practice-scroll': makeEl(counter),
    };
    const scroll = els['section-practice-scroll'];
    for (let i = 0; i < chipCount; i++) {
        scroll.children.push(makeEl(counter, { classes: ['section-practice-chip'], dataset: { parentIdx: String(i) } }));
    }
    const sandbox = {
        document: { getElementById: (id) => els[id] || null },
        Array,
        Number,
        state: {
            mode: false,
            active: 1,
            ranges: [{ start: 0 }, { start: 5 }, { start: 10 }],
            selected: 1,
            whole: false,
            follow: -1,
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(`
        let _sectionPracticeRanges = state.ranges;
        let _sectionPracticeActiveParent = state.active;
        let _sectionPracticeSelected = state.selected;
        let _sectionPracticeWholeSection = state.whole;
        let _sectionPracticeMode = state.mode;
        let _sectionPracticeFollowParent = state.follow;
        let _sectionPracticeChipScroll = null;
        let _sectionPracticeChips = [];
        let _sectionPracticeHighlightKey = '';
        function _sectionPracticeCurrentPartIndex() { return _sectionPracticeSelected; }
        function _sectionPracticeBarIsReady() { return true; }
        function _sectionPracticeParentIndexAtTime(t) { return Math.min(3, Math.floor(t / 10)); }
        function _scrollSectionPracticeChipIntoView() {}
        ${FNS}
        globalThis.api = {
            highlight: _updateSectionPracticeHighlight,
            pieceUi: _syncSectionPracticePieceUi,
            pill: _syncSectionPracticePillV3Chrome,
            setSelected(v) { _sectionPracticeSelected = v; },
        };
    `, sandbox);
    return { api: sandbox.api, counter, els };
}

test('piece UI: a repeat sync with unchanged state performs no DOM writes', () => {
    const { api, counter, els } = load();
    api.pieceUi();
    assert.ok(counter.writes > 0, 'first sync should populate the controls');
    assert.equal(els['section-practice-piece-label'].textContent, 'Part 2 of 3');
    counter.writes = 0;
    api.pieceUi();
    api.pieceUi();
    assert.equal(counter.writes, 0, 'unchanged state must not rewrite label/checkbox/buttons');
});

test('piece UI: a real state change is still written', () => {
    const { api, counter, els } = load();
    api.pieceUi();
    api.setSelected(2);
    counter.writes = 0;
    api.pieceUi();
    assert.equal(els['section-practice-piece-label'].textContent, 'Part 3 of 3');
    assert.equal(els['section-practice-piece-next'].disabled, true);
    assert.equal(els['section-practice-piece-prev'].disabled, false);
    assert.ok(counter.writes > 0);
});

test('chip highlight: steady playback inside one section writes nothing and does not re-query chips', () => {
    const { api, counter, els } = load();
    api.highlight(12); // follow parent 1, active parent 1
    const chips = els['section-practice-scroll'].children;
    assert.equal(chips[1].classList.contains('is-playing'), true);
    assert.equal(chips[1].classList.contains('is-selected'), true);
    counter.writes = 0;
    counter.queries = 0;
    for (let t = 12; t < 19; t += 1 / 60) api.highlight(t);
    assert.equal(counter.writes, 0, 'no DOM writes while the playing section is unchanged');
    assert.equal(counter.queries, 0, 'chip NodeList must be cached, not re-queried per tick');
});

test('chip highlight: crossing into the next section moves is-playing', () => {
    const { api, els } = load();
    api.highlight(12);
    api.highlight(21);
    const chips = els['section-practice-scroll'].children;
    assert.equal(chips[1].classList.contains('is-playing'), false);
    assert.equal(chips[2].classList.contains('is-playing'), true);
});

test('chip highlight: re-rendered chips (old ones detached) are re-resolved', () => {
    const { api, counter, els } = load();
    api.highlight(12);
    const scroll = els['section-practice-scroll'];
    scroll.children.forEach((c) => { c.isConnected = false; });
    scroll.children = [0, 1, 2].map((i) => makeEl(counter, { classes: ['section-practice-chip'], dataset: { parentIdx: String(i) } }));
    api.highlight(12);
    assert.equal(scroll.children[1].classList.contains('is-playing'), true,
        'fresh chips must get the highlight even though the state key is unchanged');
});

test('v3 pill chrome: a repeat sync performs no attribute writes', () => {
    const { api, counter, els } = load();
    api.pill(false);
    assert.equal(els['section-practice-pill'].getAttribute('title'), 'Section practice');
    counter.writes = 0;
    api.pill(false);
    api.pill(false);
    assert.equal(counter.writes, 0, 'title/aria-label must not be re-set every frame');
});
