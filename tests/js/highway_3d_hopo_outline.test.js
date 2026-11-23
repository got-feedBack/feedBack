// _triOutline (plugins/highway_3d/screen.js): the hammer-on / pull-off triangle's
// outline is the string colour, darkened on light colours so the white triangle
// stays visible on a yellow (or white) gem. Sliced out of source; a missing marker
// fails loudly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js'), 'utf8');
const start = SRC.indexOf('function _triOutline(');
assert.notEqual(start, -1, '_triOutline must exist');
const end = SRC.indexOf('\n        }', start) + '\n        }'.length;
const triOutline = new Function(SRC.slice(start, end) + '\nreturn _triOutline;')();

const lum = (hex) => {
    const v = parseInt(hex.slice(1), 16);
    return (0.2126 * ((v >> 16) & 255) + 0.7152 * ((v >> 8) & 255) + 0.0722 * (v & 255)) / 255;
};

test('dark and saturated string colours keep their own outline', () => {
    assert.equal(triOutline(0xff0000), '#ff0000');   // red
    assert.equal(triOutline(0x2060ff), '#2060ff');   // blue
});

test('light string colours get a darkened outline', () => {
    for (const c of [0xffd700, 0xffff00, 0xffffff, 0x80ff80]) {
        const out = triOutline(c);
        assert.notEqual(out, '#' + c.toString(16).padStart(6, '0'));
        assert.ok(lum(out) < 0.4, `${out} should be dark enough on a white triangle`);
    }
});
