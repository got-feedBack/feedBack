// Nobody may monkey-patch window.showScreen. (#924)
//
// It used to be wrapped by THREE independent parties, each capturing whatever happened to be
// there at the time:
//
//     app.js publishes the raw function
//       -> static/v3/shell.js wrapped it (to call syncActive, and to map home -> v3-songs)
//       -> the stems plugin wrapped it AGAIN (to tear down on leaving the player)
//
// Plugins load ASYNCHRONOUSLY, so the chain linked up in whatever order the race settled. A
// capture taken before shell.js installed silently dropped the mapping it carried — and the
// library opened on the dead legacy #home screen. Testers saw that as "randomly, the library
// shows the old interface" (#923).
//
// Neither wrapper ever needed to be one. showScreen already EMITS screen:changed, and that is
// already how app.js, audio-mixer.js and tour-engine.js do it. Both are listeners now, and
// window.showScreen is a plain function again — so the ordering hazard is structurally
// impossible rather than merely avoided.
//
// This test is the thing that keeps it that way. A wrapper reintroduced anywhere in static/
// fails CI.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function jsFiles(dir) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...jsFiles(p));
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

// strip comments so the prose above (and in shell.js) isn't read as an assignment
const scrub = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/[^\n]*$/gm, '');

test('nothing in static/ assigns window.showScreen', () => {
    const offenders = [];
    for (const f of jsFiles(path.join(ROOT, 'static'))) {
        const src = scrub(fs.readFileSync(f, 'utf8'));
        // `window.showScreen = ...` — an assignment, not a call or a typeof guard
        if (/window\.showScreen\s*=(?!=)/.test(src)) offenders.push(path.relative(ROOT, f));
    }
    assert.deepEqual(
        offenders, [],
        'these files monkey-patch window.showScreen. Do not: three wrappers racing over one '
        + 'global is what made the library open on the legacy screen (#923). Listen to '
        + 'screen:changed instead — showScreen already emits it, with { id, from }.',
    );
});

test('showScreen emits screen:changed with the screen it LEFT', () => {
    const src = fs.readFileSync(path.join(ROOT, 'static', 'js', 'session.js'), 'utf8');
    assert.match(
        src,
        /emit\('screen:changed',\s*\{\s*id,\s*from:/,
        "screen:changed must carry `from` — without it, \"I am leaving the player\" is not "
        + 'expressible from an event, and the only way to say it is to wrap showScreen, which is '
        + 'the bug this exists to prevent',
    );
});

test('screen:changing fires BEFORE the navigation work, screen:changed after', () => {
    // The distinction is the whole point, and Codex caught me collapsing it.
    //
    // The stems plugin's wrapper tore down its audio graph BEFORE showScreen did anything.
    // screen:changed fires at the very END — after core awaits library and provider loads — so
    // moving the plugin onto it would delay teardown behind a slow fetch, or skip it if that
    // fetch threw, and stems would keep playing on a non-player screen.
    //
    //     screen:changing  before anything happens. "I am leaving `from`." Cancel/teardown here.
    //     screen:changed   after the DOM and data settle. "I am on `id`."
    const src = fs.readFileSync(path.join(ROOT, 'static', 'js', 'session.js'), 'utf8');
    const changing = src.indexOf("emit('screen:changing'");
    const changed = src.indexOf("emit('screen:changed'");
    assert.ok(changing !== -1, 'screen:changing must be emitted');
    assert.ok(changed !== -1, 'screen:changed must be emitted');
    assert.ok(changing < changed, 'screen:changing must come first');

    // and `changing` must precede the first await, or it is no earlier than `changed` in practice
    const firstAwait = src.indexOf('await ', changing);
    assert.ok(firstAwait === -1 || changing < firstAwait,
        'screen:changing must fire before showScreen awaits anything — that is its entire purpose');
});

test('the v3 shell reacts to screen:changed rather than wrapping showScreen', () => {
    const src = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'shell.js'), 'utf8');
    assert.match(scrub(src), /on\('screen:changed'/, 'shell.js must listen, not patch');
});
