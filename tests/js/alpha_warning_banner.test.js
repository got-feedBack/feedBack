// Verify the alpha-build heads-up banner: markup is present in
// static/v3/index.html and `_updateAlphaWarningBanner(version)` in
// static/app.js toggles its visibility correctly per the version string.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX_HTML = path.join(__dirname, '..', '..', 'static', 'v3', 'index.html');
const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');

test('index.html ships the alpha-warning banner inside the library section', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');

    // Locate the library section so we can prove the banner lives there
    // and not stuck somewhere it would render off-screen.
    const libStart = html.indexOf('id="library-section"');
    assert.ok(libStart !== -1, 'library-section anchor not found in index.html');
    const libEnd = html.indexOf('</section>', libStart);
    assert.ok(libEnd !== -1, 'library-section closing tag not found');
    const librarySection = html.slice(libStart, libEnd);

    assert.match(
        librarySection,
        /id="alpha-warning-banner"/,
        'alpha-warning-banner must live inside library-section',
    );
    // `hidden` Tailwind class must be present so the banner stays invisible
    // until JS opts it in via classList.toggle('hidden', false).
    assert.match(
        librarySection,
        /id="alpha-warning-banner"[^>]*\bhidden\b/,
        'alpha-warning-banner must start with the `hidden` class',
    );
    // role="status" gives screen readers a non-interrupting announcement
    // rather than treating it as decorative.
    assert.match(
        librarySection,
        /id="alpha-warning-banner"[^>]*role="status"/,
        'alpha-warning-banner must declare role="status"',
    );
});

// Brace-balanced extraction so the function body — including nested
// object literals, template strings, or future guards — survives a
// naive regex stopping at the first `}`.
function extractFunctionSource(src, name) {
    const sig = `function ${name}`;
    const start = src.indexOf(sig);
    assert.ok(start !== -1, `function declaration '${name}' not found`);
    const openBrace = src.indexOf('{', start);
    assert.ok(openBrace !== -1, `opening brace after '${name}' not found`);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces in function '${name}'`);
    return src.slice(start, i);
}

// Build a fresh sandbox per test so cross-case state can't leak —
// classList.toggle mutations on one fake banner can't bias the next case.
function setupSandbox({ bannerExists = true } = {}) {
    const classes = new Set(['hidden']);
    const banner = bannerExists ? {
        classList: {
            // Mirror DOMTokenList.toggle: when `force` is provided, it
            // sets/removes deterministically; the production code relies
            // on that signature, so test it the same way.
            toggle: (cls, force) => {
                if (force === true) classes.add(cls);
                else if (force === false) classes.delete(cls);
                else if (classes.has(cls)) classes.delete(cls);
                else classes.add(cls);
            },
        },
    } : null;
    const sandbox = {
        document: {
            getElementById: (id) => (id === 'alpha-warning-banner' ? banner : null),
        },
    };
    vm.createContext(sandbox);
    const src = fs.readFileSync(APP_JS, 'utf8');
    const fnSrc = extractFunctionSource(src, '_updateAlphaWarningBanner');
    // Hoist into the sandbox global so the test can call it like a
    // regular function. The production declaration is inside an IIFE,
    // but the function body itself is independent of that closure.
    vm.runInContext(`${fnSrc}\nglobalThis.__update = _updateAlphaWarningBanner;`, sandbox);
    return { update: sandbox.__update, classes };
}

test('unhides the banner on an alpha version string', () => {
    const { update, classes } = setupSandbox();
    update('0.2.9-alpha.5');
    assert.equal(classes.has('hidden'), false, 'banner should be visible on alpha versions');
});

test('keeps the banner hidden on a stable version string', () => {
    const { update, classes } = setupSandbox();
    update('0.2.9');
    assert.equal(classes.has('hidden'), true, 'banner must stay hidden on stable versions');
});

test('alpha detection is case-insensitive', () => {
    const { update, classes } = setupSandbox();
    update('0.2.9-ALPHA.5');
    assert.equal(classes.has('hidden'), false, 'uppercase ALPHA should also trigger the banner');
});

test('does not confuse beta or rc with alpha', () => {
    for (const v of ['0.2.9-beta.1', '0.2.9-rc.2', '1.0.0']) {
        const { update, classes } = setupSandbox();
        update(v);
        assert.equal(
            classes.has('hidden'),
            true,
            `banner must remain hidden on non-alpha version '${v}'`,
        );
    }
});

test('handles non-string or missing version input gracefully', () => {
    for (const v of [null, undefined, 42, {}, '']) {
        const { update, classes } = setupSandbox();
        update(v);
        assert.equal(
            classes.has('hidden'),
            true,
            `banner must stay hidden when version is ${JSON.stringify(v)}`,
        );
    }
});

test('no-ops without throwing when the banner element is absent', () => {
    const { update } = setupSandbox({ bannerExists: false });
    assert.doesNotThrow(() => update('0.2.9-alpha.5'));
});
