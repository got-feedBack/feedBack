// _playerButtonKeepsShortcuts (static/js/shortcuts.js): in the player, a focused
// <button> (a speed preset after a click) must not swallow the player's keys.
// Sliced out of source and run on its own; a missing marker fails loudly. The
// dispatcher itself (_shortcutDispatchBlocked) is sliced too, with the real
// helpers it calls and stubs only for the page-bound ones, so removing the
// dispatcher's call to the helper fails these tests.

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


// ── Through the dispatcher ─────────────────────────────────────────────────
function slice(name) {
    const at = SRC.indexOf(`export function ${name}(`);
    assert.notEqual(at, -1, `${name} must exist`);
    const open = SRC.indexOf('{', SRC.indexOf(')', at));
    let depth = 0;
    for (let j = open; j < SRC.length; j++) {
        if (SRC[j] === '{') depth++;
        else if (SRC[j] === '}' && --depth === 0) return SRC.slice(at + 'export '.length, j + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
}

const CTX = { isPlayer: true, isSettings: false };
const blocked = new Function('ctxRef', [
    'const _sectionPracticeBarContains = () => false;',
    'const _sectionPracticePopoverOpen = () => false;',
    'const _getCurrentContext = () => ctxRef;',
    ...['_isTextInput', '_isInsideInteractiveControl', '_isSpaceKey', '_playerButtonKeepsShortcuts',
        '_shortcutDispatchBlocked'].map(slice),
    'return _shortcutDispatchBlocked;',
].join('\n'))(CTX);

const node = (tagName, { type, inModal = false } = {}) => ({
    tagName, type, isContentEditable: false,
    closest: (sel) => (inModal && sel.includes('dialog') ? {} : null),
});
const press = (target, k, extra = {}) => ({ key: k, target, defaultPrevented: false, ...extra });

test('dispatcher: ArrowRight on a focused player button reaches the shortcuts', () => {
    CTX.isPlayer = true;
    assert.equal(blocked(press(node('BUTTON'), 'ArrowRight')), false);
    assert.equal(blocked(press(node('BUTTON'), ',')), false);
});

test('dispatcher: the exceptions still block', () => {
    CTX.isPlayer = true;
    assert.equal(blocked(press(node('BUTTON'), 'ArrowRight', { defaultPrevented: true })), true, 'button used the key');
    assert.equal(blocked(press(node('BUTTON'), 'Enter')), true, 'Enter presses the button');
    assert.equal(blocked(press(node('BUTTON', { inModal: true }), 'ArrowRight')), true, 'modal');
    assert.equal(blocked(press(node('INPUT', { type: 'range' }), 'ArrowRight')), true, 'slider keeps arrows');
    assert.equal(blocked(press(node('INPUT', { type: 'text' }), 'ArrowRight')), true, 'text field');
    assert.equal(blocked(press(node('SELECT'), 'ArrowDown')), true, 'select');
    CTX.isPlayer = false;
    assert.equal(blocked(press(node('BUTTON'), 'ArrowRight')), true, 'not in the player');
    CTX.isPlayer = true;
});
