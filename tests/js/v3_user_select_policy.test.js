// Guards the v3 text-selection policy (static/v3/v3.css + static/v3/index.html):
// the UI defaults to non-selectable so accidental chrome selection can't look
// broken, while form fields, plugin screens, and core content opt back in. A
// future global reset clobbering the rule — or the content containers losing
// their .fb-selectable opt-in — should fail here.
//
// Source-level only — same strategy as the other tests/js/ files.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
// Strip block comments so the policy's own explanatory prose (which quotes the
// `* { user-select:none }` anti-pattern as a warning) can't trip the assertions.
const css = fs.readFileSync(path.join(root, 'static', 'v3', 'v3.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
const html = fs.readFileSync(path.join(root, 'static', 'v3', 'index.html'), 'utf8');

test('v3 defaults to non-selectable on html (not a universal `*` rule)', () => {
    assert.match(css, /html\s*\{[^}]*user-select:\s*none/,
        'html must default user-select: none');
    // The `* { user-select: none }` anti-pattern breaks input carets / IME — must not exist.
    assert.doesNotMatch(css, /\*\s*\{[^}]*user-select:\s*none/,
        'must NOT use a universal `*` user-select:none rule');
});

test('form fields are always re-enabled (caret / IME safe)', () => {
    assert.match(
        css,
        /input,\s*textarea,\s*select[\s\S]*?contenteditable[\s\S]*?user-select:\s*text/,
        'input/textarea/select/[contenteditable] must be re-enabled to user-select: text',
    );
});

test('plugin screen subtree stays selectable by inheritance (no `*`, respects plugin opt-outs)', () => {
    assert.match(
        css,
        /\.screen\[id\^="plugin-"\]\s*\{[^}]*user-select:\s*text/,
        'plugin screens must be re-enabled so plugin content is not silently un-copyable',
    );
    assert.doesNotMatch(
        css,
        /\.screen\[id\^="plugin-"\]\s*\*/,
        'the plugin carve must NOT use `*` (would override a plugin\'s own non-select chrome)',
    );
});

test('core content opts back in via .fb-selectable (element + descendants)', () => {
    assert.match(
        css,
        /\.fb-selectable,\s*\.fb-selectable\s*\*\s*\{[^}]*user-select:\s*text/,
        '.fb-selectable (and descendants) must set user-select: text',
    );
});

test('the Settings panel and now-playing metadata carry .fb-selectable', () => {
    assert.match(html, /class="fb-settings fb-selectable"/,
        'the Settings panel must opt back in (paths / version / diagnostics / About)');
    assert.match(html, /class="text-sm leading-tight fb-selectable"/,
        'the now-playing song metadata block must opt back in');
});
