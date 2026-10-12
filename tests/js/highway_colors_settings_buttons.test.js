// Highway String Colors settings buttons (Reset to defaults, Save as…, Delete,
// Copy share code, Import, saved-theme dropdown).
//
// The R3a carve-out (#883) moved the handlers into static/js/highway-colors.js
// as private module functions, but the markup in plugins/highway_3d/settings.html
// still called them via inline onclick="window.hwcReset?.()", which resolved to
// undefined, so every button silently did nothing. The buttons now carry
// data-hwc-action and core handles them with one delegated listener.
//
// Layer 1 pins the markup ↔ action-table contract at source level; layer 2
// runs the real delegation code against a fake document.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const colorsJs = fs.readFileSync(path.join(ROOT, 'static', 'js', 'highway-colors.js'), 'utf8');
const settingsHtml = fs.readFileSync(path.join(ROOT, 'plugins', 'highway_3d', 'settings.html'), 'utf8');

// Brace-balanced extraction (same helper shape as highway_string_colors.test.js).
function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    let depth = 1;
    let i = src.indexOf('{', start) + 1;
    while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    }
    assert.equal(depth, 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

const markupActions = [...settingsHtml.matchAll(/data-hwc-action="([a-z]+)"/g)].map((m) => m[1]).sort();

test('settings markup no longer calls handlers on window (they are module-private)', () => {
    assert.doesNotMatch(settingsHtml, /window\.hwc[A-Za-z]+/);
    assert.doesNotMatch(settingsHtml, /on(click|change)="[^"]*hwc/);
});

test('every settings button has an action core handles, and vice versa', () => {
    assert.deepEqual(markupActions, ['copy', 'delete', 'import', 'reset', 'save']);
    const table = extractBlock(colorsJs, 'const _HWC_CLICK_ACTIONS = ');
    const tableKeys = [...table.matchAll(/^\s+([a-z]+): \(\) => (hwc[A-Za-z]+)\(\),$/gm)];
    assert.deepEqual(tableKeys.map((m) => m[1]).sort(), markupActions);
    for (const [, , fn] of tableKeys) {
        assert.match(colorsJs, new RegExp(`(?:async )?function ${fn}\\(`), `${fn} is defined in the module`);
    }
    assert.match(settingsHtml, /<select id="hwc-theme-select"/);
});

test('initHighwayColors installs the delegated listener', () => {
    assert.match(extractBlock(colorsJs, 'export function initHighwayColors()'), /_hwcInstallSettingsDelegation\(\);/);
});

// ── Layer 2: run the real delegation against a fake document ─────────────

function loadDelegation() {
    const code = extractBlock(colorsJs, 'const _HWC_CLICK_ACTIONS = ') + ';\n'
        + 'let _hwcDelegated = false;\n'
        + extractBlock(colorsJs, 'function _hwcInstallSettingsDelegation()')
        + '\nreturn _hwcInstallSettingsDelegation;';
    const calls = [];
    const listeners = {};
    const document = {
        addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    };
    const stub = (name) => (...args) => calls.push([name, ...args]);
    const install = new Function(
        'document', 'console',
        'hwcSaveTheme', 'hwcDeleteTheme', 'hwcReset', 'hwcCopyShare', 'hwcImport', 'hwcOnSelectTheme',
        code,
    )(document, console,
        stub('hwcSaveTheme'), stub('hwcDeleteTheme'), stub('hwcReset'),
        stub('hwcCopyShare'), stub('hwcImport'), stub('hwcOnSelectTheme'));
    return { install, calls, listeners };
}

// A clicked element inside a button with the given data-hwc-action (or none).
function clickOn(action) {
    const btn = action == null ? null : { dataset: { hwcAction: action } };
    return { target: { closest: (sel) => (sel === '[data-hwc-action]' ? btn : null) } };
}

test('each button reaches its handler, including clicks on the label inside it', () => {
    const { install, calls, listeners } = loadDelegation();
    install();
    const expected = { save: 'hwcSaveTheme', delete: 'hwcDeleteTheme', reset: 'hwcReset', copy: 'hwcCopyShare', import: 'hwcImport' };
    for (const [action, fn] of Object.entries(expected)) {
        calls.length = 0;
        for (const l of listeners.click) l(clickOn(action));
        assert.deepEqual(calls, [[fn]], action);
    }
});

test('unrelated clicks and prototype keys do nothing', () => {
    const { install, calls, listeners } = loadDelegation();
    install();
    for (const action of [null, 'bogus', 'constructor', '__proto__', 'toString']) {
        for (const l of listeners.click) l(clickOn(action));
    }
    for (const l of listeners.click) l({ target: {} });   // no closest() (e.g. text node)
    assert.deepEqual(calls, []);
});

test('the saved-theme dropdown selects the chosen theme', () => {
    const { install, calls, listeners } = loadDelegation();
    install();
    for (const l of listeners.change) l({ target: { id: 'hwc-theme-select', value: 'My Bass' } });
    for (const l of listeners.change) l({ target: { id: 'something-else', value: 'x' } });
    assert.deepEqual(calls, [['hwcOnSelectTheme', 'My Bass']]);
});

test('installing twice does not double-fire', () => {
    const { install, calls, listeners } = loadDelegation();
    install();
    install();
    assert.equal(listeners.click.length, 1);
    assert.equal(listeners.change.length, 1);
    for (const l of listeners.click) l(clickOn('reset'));
    assert.deepEqual(calls, [['hwcReset']]);
});
