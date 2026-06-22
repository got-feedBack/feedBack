// Source-level guard for the 3D Highway overlay fully covering #highway.
//
// The `.h3d-wrap` overlay is anchored to top:0/left:0/right:0 of its offset
// parent, which only lines up with #highway when the canvas sits at the
// parent's origin. The v3 player can place chrome above the canvas, shifting
// the wrap up so its lower edge falls short of #highway and exposes a strip
// of the canvas (the reported gap). applySize() must pin the wrap to the
// canvas's actual offset box so it stays flush. createHighway's WebGL
// lifecycle is too heavy for a vm sandbox, so this locks in the wiring.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const screenJs = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');

function extractBlock(src, signature) {
    const start = src.indexOf(signature);
    assert.ok(start !== -1, `signature '${signature}' not found`);
    const openBrace = src.indexOf('{', start);
    let depth = 1;
    let i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    assert.ok(depth === 0, `unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

test('applySize pins the .h3d-wrap overlay to the highway canvas offset box', () => {
    const src = fs.readFileSync(screenJs, 'utf8');
    const fn = extractBlock(src, 'function applySize(w, h)');
    // Guarded on a laid-out canvas so we never pin to a zero box.
    assert.match(
        fn,
        /highwayCanvas\s*&&\s*highwayCanvas\.offsetWidth\s*>\s*0\s*&&\s*highwayCanvas\.offsetHeight\s*>\s*0/,
        'must guard the pin on a laid-out canvas (offsetWidth/Height > 0)',
    );
    // Track top/left and size to the canvas's own offset box.
    assert.match(fn, /wrap\.style\.top\s*=\s*highwayCanvas\.offsetTop/, 'must track canvas offsetTop');
    assert.match(fn, /wrap\.style\.left\s*=\s*highwayCanvas\.offsetLeft/, 'must track canvas offsetLeft');
    assert.match(fn, /wrap\.style\.width\s*=\s*highwayCanvas\.offsetWidth/, 'must size to canvas offsetWidth');
    assert.match(fn, /wrap\.style\.height\s*=\s*highwayCanvas\.offsetHeight/, 'must size to canvas offsetHeight');
    // right:0 must be released so the explicit width takes effect.
    assert.match(fn, /wrap\.style\.right\s*=\s*['"]auto['"]/, "must release right:0 (set 'auto') when pinning width");
});

test('applySize falls back to the computed height when the canvas is not laid out', () => {
    const src = fs.readFileSync(screenJs, 'utf8');
    const fn = extractBlock(src, 'function applySize(w, h)');
    assert.match(fn, /else\s*\{\s*wrap\.style\.height\s*=\s*h\s*\+\s*['"]px['"]/, 'must keep the computed-height fallback');
});
