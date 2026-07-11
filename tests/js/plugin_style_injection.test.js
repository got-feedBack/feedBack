// Verify the plugin `styles` capability in static/js/plugin-loader.js: _injectPluginStyles
// adds exactly one versioned <link rel="stylesheet"> per plugin, swaps it on a
// version upgrade (no duplicates, no stale tags), injects nothing for a plugin
// without `styles`, and routes the URL through the sandboxed asset endpoint.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLUGIN_LOADER_JS = path.join(__dirname, '..', '..', 'static', 'js', 'plugin-loader.js');

// Brace-balanced extraction of a `const NAME = (...) => { ... }` arrow, so a
// nested object/template literal can't make a naive regex stop early.
function extractConstArrow(src, name) {
    const sig = `const ${name} = `;
    const start = src.indexOf(sig);
    assert.ok(start !== -1, `const arrow '${name}' not found`);
    const openBrace = src.indexOf('{', src.indexOf('=>', start));
    assert.ok(openBrace !== -1, `arrow body for '${name}' not found`);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces in '${name}'`);
    // include the trailing `;`
    return src.slice(start, src.indexOf(';', i) + 1);
}

// Fresh sandbox per test so head state and the loadedStyles Map can't leak
// across cases. Returns the hoisted _injectPluginStyles plus the head array.
function setupSandbox() {
    const headLinks = [];
    const makeLink = () => ({
        dataset: {},
        rel: '',
        href: '',
        remove() {
            const idx = headLinks.indexOf(this);
            if (idx >= 0) headLinks.splice(idx, 1);
        },
    });
    // Seed a stand-in for core's prebuilt <link href="/static/tailwind.min.css">
    // so the ordering test can assert plugin sheets are inserted before it.
    const seedCore = () => {
        const core = makeLink();
        core.rel = 'stylesheet';
        core.href = '/static/tailwind.min.css';
        headLinks.push(core);
        return core;
    };
    // Minimal but faithful <head>: appendChild pushes to the end, insertBefore
    // splices before the reference node, and querySelector resolves the two
    // anchor selectors _injectPluginStyles uses to find core's stylesheet
    // (the tailwind-specific one, then any stylesheet as a fallback).
    const head = {
        appendChild: (node) => { headLinks.push(node); },
        insertBefore: (node, ref) => {
            const i = ref ? headLinks.indexOf(ref) : -1;
            if (i >= 0) headLinks.splice(i, 0, node);
            else headLinks.push(node);
        },
        querySelector: (sel) => {
            if (sel.includes('tailwind.min.css')) {
                return headLinks.find((l) => (l.href || '').includes('tailwind.min.css')) || null;
            }
            return headLinks.find((l) => l.rel === 'stylesheet') || null;
        },
    };
    const sandbox = {
        console: { warn() {} },
        encodeURIComponent,
        document: {
            head,
            createElement: () => makeLink(),
            // Production only ever queries 'link[data-plugin-id]'; return a
            // copy so a remove() splice during forEach is safe.
            querySelectorAll: () => headLinks.slice(),
        },
    };
    vm.createContext(sandbox);
    const src = fs.readFileSync(PLUGIN_LOADER_JS, 'utf8');
    const removeSrc = extractConstArrow(src, '_removePluginStyleTags');
    const injectSrc = extractConstArrow(src, '_injectPluginStyles');
    const reconcileSrc = extractConstArrow(src, '_reconcilePluginStyles');
    // One script so all share a lexical scope (the arrows close over
    // loadedStyles + _removePluginStyleTags), then hoist for the test to call.
    vm.runInContext(
        `const loadedStyles = new Map();\n${removeSrc}\n${injectSrc}\n${reconcileSrc}\n` +
        `globalThis.__inject = _injectPluginStyles;\n` +
        `globalThis.__reconcile = _reconcilePluginStyles;\n` +
        `globalThis.__head = () => null;`,
        sandbox,
    );
    return { inject: sandbox.__inject, reconcile: sandbox.__reconcile, headLinks, seedCore };
}

const plug = (over = {}) => ({
    id: 'demo', version: '1', has_styles: true, styles: 'assets/plugin.css', ...over,
});

test('injects exactly one <link> for a plugin with styles', () => {
    const { inject, headLinks } = setupSandbox();
    inject(plug());
    assert.equal(headLinks.length, 1);
    const link = headLinks[0];
    assert.equal(link.rel, 'stylesheet');
    assert.equal(link.dataset.pluginId, 'demo');
    assert.equal(link.dataset.pluginVersion, '1');
    // Root-relative styles → routes through /api/plugins/{id}/assets/... (no
    // doubled "assets/"), with the version as a cache-busting query.
    assert.equal(link.href, '/api/plugins/demo/assets/plugin.css?v=1');
});

test('inserts the plugin <link> before core tailwind.min.css so core wins equal-specificity collisions', () => {
    const { inject, headLinks, seedCore } = setupSandbox();
    const core = seedCore();
    inject(plug());
    assert.equal(headLinks.length, 2, 'core link plus the plugin link');
    const pluginIdx = headLinks.findIndex((l) => l.dataset.pluginId === 'demo');
    const coreIdx = headLinks.indexOf(core);
    assert.ok(pluginIdx >= 0, 'plugin <link> was injected');
    assert.ok(pluginIdx < coreIdx, 'plugin <link> must precede core tailwind.min.css');
});

test('falls back to appendChild when no stylesheet <link> anchor exists in <head>', () => {
    // With an empty <head>, both anchor queries (tailwind-specific, then any
    // stylesheet) miss, so coreSheet is null and the link is appended.
    const { inject, headLinks } = setupSandbox();
    inject(plug());
    assert.equal(headLinks.length, 1, 'still injects when there is no anchor to insert before');
    assert.equal(headLinks[0].dataset.pluginId, 'demo');
});

test('is idempotent — re-activation does not duplicate the tag', () => {
    const { inject, headLinks } = setupSandbox();
    inject(plug());
    inject(plug());
    inject(plug());
    assert.equal(headLinks.length, 1);
});

test('swaps the <link> on a version upgrade (no stale duplicates)', () => {
    const { inject, headLinks } = setupSandbox();
    inject(plug({ version: '1' }));
    inject(plug({ version: '2' }));
    assert.equal(headLinks.length, 1, 'old version <link> must be removed');
    assert.equal(headLinks[0].dataset.pluginVersion, '2');
    assert.equal(headLinks[0].href, '/api/plugins/demo/assets/plugin.css?v=2');
});

test('injects nothing for a plugin without styles (regression)', () => {
    const { inject, headLinks } = setupSandbox();
    inject({ id: 'plain', version: '1', has_styles: false });
    inject({ id: 'plain2', version: '1' }); // has_styles undefined
    assert.equal(headLinks.length, 0);
});

test('skips an unsafe styles path (not under assets/, traversal, backslash, query/fragment)', () => {
    const { inject, headLinks } = setupSandbox();
    const bad = [
        'plugin.css',            // not under assets/
        '../routes.py',          // not under assets/, traversal
        'assets/../routes.py',   // starts with assets/ but escapes via ..
        'assets/..',             // trailing traversal
        'assets\\plugin.css',    // backslash
        'assets/plugin.css?x=1', // query char would collide with our ?v=
        'assets/plugin.css#frag',// fragment
    ];
    bad.forEach((styles, i) => inject(plug({ id: `bad${i}`, styles })));
    assert.equal(headLinks.length, 0, 'no unsafe path should inject a <link>');
});

test('removes the stale <link> when a plugin upgrade drops styles', () => {
    const { inject, headLinks } = setupSandbox();
    inject(plug({ version: '1' }));
    assert.equal(headLinks.length, 1);
    // Same plugin re-processed after an in-session upgrade that no longer
    // declares styles — the old stylesheet must be torn down, not left active.
    inject({ id: 'demo', version: '2', has_styles: false });
    assert.equal(headLinks.length, 0, 'stale stylesheet must be removed when styles disappear');
});

test('removes the stale <link> when a plugin upgrade points styles outside assets/', () => {
    const { inject, headLinks } = setupSandbox();
    inject(plug({ version: '1' }));
    assert.equal(headLinks.length, 1);
    // Upgrade to an unusable path → the prior valid <link> is torn down rather
    // than left applying stale CSS.
    inject(plug({ version: '2', styles: '../routes.py' }));
    assert.equal(headLinks.length, 0);
});

test('does not collide tags across two different plugins', () => {
    const { inject, headLinks } = setupSandbox();
    inject(plug({ id: 'a' }));
    inject(plug({ id: 'b' }));
    assert.equal(headLinks.length, 2);
    assert.deepEqual(headLinks.map((l) => l.dataset.pluginId).sort(), ['a', 'b']);
});

test('reconcile keeps the <link> of a plugin absent from a partial response', () => {
    const { inject, reconcile, headLinks } = setupSandbox();
    inject(plug({ id: 'a' }));
    inject(plug({ id: 'b' }));
    assert.equal(headLinks.length, 2);
    // `a` is missing from this response. That happens transiently during a
    // backend restart (the plugin registry repopulates while HTTP stays up),
    // so absence is NOT an uninstall signal — the still-loaded plugin must
    // keep its stylesheet or it renders visible-but-unstyled until it
    // reappears. Explicit removal still happens via the not-ready/unstyled
    // paths (tests below).
    reconcile([plug({ id: 'b' })]);
    assert.equal(headLinks.length, 2);
    assert.deepEqual(headLinks.map((l) => l.dataset.pluginId).sort(), ['a', 'b']);
});

test('reconcile removes the <link> of a plugin that is no longer ready', () => {
    const { inject, reconcile, headLinks } = setupSandbox();
    inject(plug({ id: 'a' }));
    reconcile([plug({ id: 'a', status: 'installing' })]);
    assert.equal(headLinks.length, 0);
});

test('reconcile keeps a still-ready, still-styled plugin', () => {
    const { inject, reconcile, headLinks } = setupSandbox();
    inject(plug({ id: 'a' }));
    reconcile([plug({ id: 'a' })]);
    assert.equal(headLinks.length, 1);
});
