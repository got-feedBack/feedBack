// _playerButtonKeepsShortcuts (static/js/shortcuts.js): in the player, a focused
// <button> (a speed preset after a click) must not swallow the player's keys.
// Sliced out of source and run on its own; a missing marker fails loudly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'js', 'shortcuts.js'), 'utf8');
const start = SRC.indexOf('export function _playerButtonKeepsShortcuts(');
assert.notEqual(start, -1, '_playerButtonKeepsShortcuts must exist');
const end = SRC.indexOf('\n}\n', start) + 2;
const keeps = new Function(SRC.slice(start + 'export '.length, end) + '\nreturn _playerButtonKeepsShortcuts;')();

const el = (tagName, inModal = false) => ({ tagName, closest: (sel) => (inModal && sel.includes('dialog') ? {} : null) });
const key = (target, extra = {}) => ({ target, defaultPrevented: false, ...extra });
const PLAYER = { isPlayer: true };

test('a focused button in the player keeps the shortcuts', () => {
    assert.equal(keeps(key(el('BUTTON')), PLAYER), true);
});

test('fields, sliders and selects keep their own keys', () => {
    for (const tag of ['INPUT', 'SELECT', 'TEXTAREA', 'DIV']) assert.equal(keeps(key(el(tag)), PLAYER), false, tag);
});

test('not outside the player, not in a modal, not when the button used the key', () => {
    assert.equal(keeps(key(el('BUTTON')), { isPlayer: false }), false);
    assert.equal(keeps(key(el('BUTTON', true)), PLAYER), false);
    assert.equal(keeps(key(el('BUTTON'), { defaultPrevented: true }), PLAYER), false);
    assert.equal(keeps(key(el('BUTTON'), { key: 'Enter' }), PLAYER), false, 'Enter presses the button');
    assert.equal(keeps(key(null), PLAYER), false);
    assert.equal(keeps(null, PLAYER), false);
});
