// Verify the feedpak credits overlay helpers in app.js:
//   - _creditLineLabel()       role → friendly "<verb> by" label
//   - showSongCreditsOverlay() builds an XSS-safe card; no-op on empty list
//   - hideSongCreditsOverlay() removes the overlay element
//
// Same isolation strategy as autoplay_exit.test.js — extract the functions
// from app.js by brace-matching and run them in a vm sandbox with a fake DOM.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { extractFunction } = require('./test_utils');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');
const SRC = fs.readFileSync(APP_JS, 'utf8');

// Minimal fake DOM element: records className, children, and textContent.
// Setting textContent clears children (matching real DOM) so we can assert
// names were set via textContent (not innerHTML) — the XSS-safety contract.
function makeEl() {
    return {
        className: '',
        children: [],
        _text: '',
        set textContent(v) { this._text = String(v); this.children = []; },
        get textContent() { return this._text; },
        appendChild(c) { this.children.push(c); return c; },
        replaceChildren() { this.children = []; },
        remove() { this.removed = true; },
    };
}

function allText(node) {
    let s = node._text || '';
    for (const c of node.children) s += allText(c);
    return s;
}

function buildSandbox(currentSong) {
    const body = makeEl();
    const sandbox = {
        document: { body, createElement: () => makeEl() },
        window: { feedBack: { currentSong, off() {} } },
        setTimeout: () => 1,
        clearTimeout: () => {},
    };
    vm.createContext(sandbox);
    const preamble = `
        let _creditsOverlay = null;
        let _creditsTimer = null;
        let _creditsHideOnPlay = null;
        let _creditsMaxTimer = null;
        const _CREDITS_MAX_MS = 12000;
        const _CREDIT_ROLE_VERBS = ${JSON.stringify({
            charter: 'Charted by', transcriber: 'Transcribed by',
            arranger: 'Arranged by', editor: 'Edited by', mixer: 'Mixed by',
            engineer: 'Engineered by', proofreader: 'Proofread by',
        })};
    `;
    vm.runInContext(
        preamble
        + extractFunction(SRC, 'function _creditLineLabel(') + '\n'
        + extractFunction(SRC, 'function showSongCreditsOverlay(') + '\n'
        + extractFunction(SRC, 'function hideSongCreditsOverlay(') + '\n'
        + 'globalThis._creditLineLabel = _creditLineLabel;'
        + 'globalThis.showSongCreditsOverlay = showSongCreditsOverlay;'
        + 'globalThis.hideSongCreditsOverlay = hideSongCreditsOverlay;'
        + 'globalThis._getOverlay = () => _creditsOverlay;',
        sandbox,
    );
    return sandbox;
}

test('_creditLineLabel maps known roles, title-cases unknown, blanks empty', () => {
    const s = buildSandbox({});
    assert.equal(s._creditLineLabel('charter'), 'Charted by');
    assert.equal(s._creditLineLabel('Editor'), 'Edited by');     // case-insensitive
    assert.equal(s._creditLineLabel('mixer'), 'Mixed by');
    assert.equal(s._creditLineLabel('luthier'), 'Luthier by');   // unknown → title-cased
    assert.equal(s._creditLineLabel(null), '');                  // no role → bare name
    assert.equal(s._creditLineLabel(''), '');
});

test('showSongCreditsOverlay builds a card with heading + credit lines', () => {
    const s = buildSandbox({ title: 'My Song' });
    s.showSongCreditsOverlay([
        { name: 'Azure', role: 'charter' },
        { name: 'Bob Lee', role: 'editor' },
        { name: 'Solo', role: null },
    ]);
    const overlay = s._getOverlay();
    assert.ok(overlay, 'overlay created');
    assert.equal(overlay.className, 'song-credits-overlay');
    assert.equal(s.document.body.children.length, 1);
    const text = allText(overlay);
    assert.match(text, /My Song/);          // heading is the song title
    assert.match(text, /Charted by/);
    assert.match(text, /Azure/);
    assert.match(text, /Edited by/);
    assert.match(text, /Bob Lee/);
    assert.match(text, /Solo/);             // role-less entry still shows the name
});

test('showSongCreditsOverlay sets names via textContent (XSS-safe)', () => {
    const s = buildSandbox({ title: 'T' });
    s.showSongCreditsOverlay([{ name: '<img src=x onerror=alert(1)>', role: 'charter' }]);
    const overlay = s._getOverlay();
    // The raw string survives verbatim as text — proving it was never parsed
    // as HTML (no innerHTML interpolation anywhere on the path).
    assert.match(allText(overlay), /<img src=x onerror=alert\(1\)>/);
});

test('showSongCreditsOverlay is a no-op for empty / non-array input', () => {
    const s = buildSandbox({ title: 'T' });
    s.showSongCreditsOverlay([]);
    assert.equal(s._getOverlay(), null);
    s.showSongCreditsOverlay(undefined);
    assert.equal(s._getOverlay(), null);
    assert.equal(s.document.body.children.length, 0);
});

test('hideSongCreditsOverlay removes the overlay', () => {
    const s = buildSandbox({ title: 'T' });
    s.showSongCreditsOverlay([{ name: 'Azure', role: 'charter' }]);
    const overlay = s._getOverlay();
    assert.ok(overlay);
    s.hideSongCreditsOverlay();
    assert.equal(overlay.removed, true);
    assert.equal(s._getOverlay(), null);
});
