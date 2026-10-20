// Keyboard speed shortcuts: `,` / `.` step 10 % (Shift 20 %), `0` = 100 %.
// The step math is _nudgedSpeedPercent in static/js/player-controls.js; the
// bindings are registerShortcut calls in static/app.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CONTROLS_JS = path.join(__dirname, '..', '..', 'static', 'js', 'player-controls.js');
const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');

function loadNudge() {
    const src = fs.readFileSync(CONTROLS_JS, 'utf8');
    const start = src.indexOf('export function _nudgedSpeedPercent');
    assert.ok(start >= 0, '_nudgedSpeedPercent present');
    const end = src.indexOf('\n}\n', start) + 3;
    const ctx = {};
    vm.runInNewContext(src.slice(start, end).replace('export function', 'function')
        + '\nthis.f = _nudgedSpeedPercent;', ctx);
    return ctx.f;
}

const nudge = loadNudge();

test('steps of 10 and 20 from the current speed', () => {
    assert.equal(nudge(100, -10), 90);
    assert.equal(nudge(100, -20), 80);
    assert.equal(nudge(90, 10), 100);
    assert.equal(nudge(75, -10), 65, 'from a preset off the 10 grid');
    assert.equal(nudge(99.6, -10), 90, 'a rate like 0.996 rounds first');
});

test('clamped to the slider range', () => {
    assert.equal(nudge(20, -10), 15);
    assert.equal(nudge(15, -20), 15);
    assert.equal(nudge(145, 10), 150);
    assert.equal(nudge(150, 20), 150);
    assert.equal(nudge(50, -20, 40, 120), 40, 'custom min');
    assert.equal(nudge(110, 20, 40, 120), 120, 'custom max');
});

test('garbage reads as 100 % / no step', () => {
    assert.equal(nudge(NaN, -10), 90);
    assert.equal(nudge(undefined, 10), 110);
    assert.equal(nudge(100, NaN), 100);
});

test('app.js binds , . 0 (plus physical-key aliases) in the player only', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    for (const key of [',', 'Comma', '.', 'Period', '0']) {
        const re = new RegExp(`registerShortcut\\(\\{\\s*key: '${key.replace('.', '\\.')}',[\\s\\S]*?scope: 'player',\\s*modifiers: _SPEED_MODS`);
        assert.match(src, re, `shortcut for ${key}`);
    }
    assert.match(src, /const _SPEED_MODS = \{ ctrl: false, alt: false, meta: false \};/);
    assert.match(src, /nudgeSpeed\(dir \* \(e\.shiftKey \? 20 : 10\)\)/);
});
