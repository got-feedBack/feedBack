// Guards app.js's `window` contract ahead of the R3a ES-module flip.
//
// app.js is a classic script, so every top-level `function foo()` is implicitly
// a property of `window`. As an ES module it will not be — module scope is not
// global scope. Any name reached from OUTSIDE app.js must therefore be an
// explicit `window.foo = …` before the flip, or it vanishes silently.
//
// "Silently" is the whole problem. A missing inline handler is a ReferenceError
// only when someone clicks the button; a `typeof window.setViz !== 'function'`
// guard (capabilities/visualization.js) just degrades and says nothing. Neither
// shows up in a test run, so this file is the thing standing between a dropped
// name and a dead button in production.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const APP_JS = fs.readFileSync(path.join(ROOT, 'static', 'app.js'), 'utf8');
const V3_HTML = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'index.html'), 'utf8');

// Every name app.js publishes: the scattered `window.foo = …` assignments plus
// the consolidated `Object.assign(window, { … })` contract block at the bottom.
function exposedNames() {
    const names = new Set(
        [...APP_JS.matchAll(/^window\.([A-Za-z_$][\w$]*)\s*=/gm)].map((m) => m[1]),
    );
    const block = APP_JS.match(/Object\.assign\(window, \{([\s\S]*?)\n\}\);/);
    assert.ok(block, 'the Object.assign(window, …) contract block is missing from app.js');
    // Strip the comments first — the prose inside them is full of words that
    // would otherwise scrape as identifiers.
    const body = block[1].replace(/\/\/[^\n]*/g, '');
    for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\s*(?=,|$)/gm)) names.add(m[1]);
    return names;
}

// app.js's own top-level `function foo()` declarations — the names that stop
// being global under `type="module"`.
function topLevelFunctions() {
    return new Set(
        [...APP_JS.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]),
    );
}

const HANDLER = /on(?:click|change|input|submit|keyup|keydown|mousedown|error|focus|blur)\s*=\s*"([A-Za-z_$][\w$]*)/g;

test('every inline on*= handler in the v3 shell is on window', () => {
    const exposed = exposedNames();
    const owned = topLevelFunctions();
    const missing = [...V3_HTML.matchAll(HANDLER)]
        .map((m) => m[1])
        .filter((n) => owned.has(n) && !exposed.has(n));
    assert.deepEqual([...new Set(missing)], [], 'inline handlers that would break under type="module"');
});

test('every on*= handler app.js builds in a template literal is on window', () => {
    // e.g. `<button onclick="goFavPage(${p})">` — these resolve against window at
    // CLICK time, exactly like the ones written into the HTML, but they live in a
    // JS string so scanning index.html alone never finds them.
    const exposed = exposedNames();
    const owned = topLevelFunctions();
    const missing = [...APP_JS.matchAll(HANDLER)]
        .map((m) => m[1])
        .filter((n) => owned.has(n) && !exposed.has(n));
    assert.deepEqual([...new Set(missing)], [], 'generated handlers that would break under type="module"');
});

test('the runtime-composed handler names are on window', () => {
    // app.js:2156-2157 chooses the handler NAME at runtime:
    //     const letterFn = favoritesOnly ? 'filterFavTreeLetter' : 'filterTreeLetter';
    //     const pageFn   = favoritesOnly ? 'goFavTreePage'       : 'goTreePage';
    // then interpolates it: `onclick="${letterFn}('A')"`.
    //
    // ponytail: hardcoded on purpose. These names exist only inside string
    // literals, so the two scans above cannot see them, and neither can ESLint,
    // no-undef, or a grep for `onclick="fn`. They are the library A–Z rail and
    // its pagination — drop one and those buttons throw on click and nowhere
    // else. If that ternary ever gains a branch, add the new name here too.
    const exposed = exposedNames();
    for (const name of ['filterTreeLetter', 'filterFavTreeLetter', 'goTreePage', 'goFavTreePage']) {
        assert.ok(exposed.has(name), `window.${name} is required by the runtime-composed A–Z rail / pagination handlers`);
    }
});

test('cross-file window.* readers still resolve', () => {
    // Names other core scripts read off window. capabilities/visualization.js is
    // the cautionary one: it reads window.setViz behind a `typeof` guard, so
    // losing it degrades the visualization capability in SILENCE rather than
    // throwing.
    const exposed = exposedNames();
    for (const name of ['setViz', 'showScreen', 'playSong', 'uiPrompt', '_confirmDialog', 'loadPlugins']) {
        assert.ok(exposed.has(name), `window.${name} is read by another file`);
    }
});
