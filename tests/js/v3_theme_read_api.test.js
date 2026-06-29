// Guard for the host theme READ surface added to the cosmetics applier
// (static/v3/theme-core.js): always-present `--fbv-*` defaults on :root (so a
// plugin can read host tokens un-themed), the two keystone roles the palette
// lacked (on-accent / focus-ring), and the window.feedBack.theme read API +
// theme:changed event. Source-level guards on the contract surface; runtime
// behaviour (apply/unequip/defaults-restore/capabilities) is verified
// separately by a headless render. First slice of the host theme contract
// (got-feedback/feedBack#644).

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'static', 'v3', 'theme-core.js'), 'utf8');

test('always-present --fbv-* defaults are injected on :root', () => {
    assert.match(TC, /const DEFAULTS = \{/);
    assert.match(TC, /function _injectDefaults\(\)/);
    assert.match(TC, /id = 'fb-theme-defaults'/);
    assert.match(TC, /':root \{/);
    // injected before the first profile read so var(--fbv-*) resolves immediately
    assert.match(TC, /_injectDefaults\(\);\s*\n\s*refresh\(\);/);
});

test('two keystone roles the palette lacked are added as defaults', () => {
    assert.match(TC, /'on-accent':/);
    assert.match(TC, /'focus-ring':/);
});

test('window.feedBack.theme read API is exposed (get/capabilities/prefersReducedMotion)', () => {
    assert.match(TC, /window\.feedBack = window\.feedBack \|\| \{\};/);
    assert.match(TC, /window\.feedBack\.theme = \{ get, capabilities, prefersReducedMotion \};/);
    assert.match(TC, /function get\(\)/);
    assert.match(TC, /function capabilities\(\)/);
    assert.match(TC, /function prefersReducedMotion\(\)/);
});

test('capabilities reports device affordances and gates motion on reduced-motion', () => {
    assert.match(TC, /glow:/);
    assert.match(TC, /gradients:/);
    assert.match(TC, /motion: allowMotion && !prefersReducedMotion\(\)/);
});

test('apply() tracks theme id + declared capabilities and emits theme:changed', () => {
    assert.match(TC, /function apply\(payload, meta\)/);
    assert.match(TC, /_themeId =/);
    assert.match(TC, /_themeCaps =/);
    assert.match(TC, /_emitThemeChanged\(\)/);
    assert.match(TC, /emit\('theme:changed'/);
});

test('the apply side stays on window.v3Theme (read surface is additive)', () => {
    assert.match(TC, /window\.v3Theme = \{/);
});
