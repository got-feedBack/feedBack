// Pins the v3 "Save as collection" wiring in static/v3/songs.js (#636 item 2).
// A smart collection is a saved live library filter, surfaced as a source in
// the provider picker; the drawer can save the current filter set as one.
// Source-level only — same strategy as tests/js/v3_az_rail.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SONGS_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'songs.js');
const src = fs.readFileSync(SONGS_JS, 'utf8');

test('currentFilterRules builds the raw query-param rule object', () => {
    assert.match(src, /function\s+currentFilterRules/);
    // Multi-value filters are CSV strings (what the backend stores / re-parses).
    assert.match(src, /r\.tunings\s*=\s*f\.tunings\.join\(','\)/);
    assert.match(src, /r\.arrangements_has\s*=\s*f\.arr_has\.join\(','\)/);
});

test('saving POSTs to /api/collections with name + rules', () => {
    assert.match(
        src,
        /fetch\('\/api\/collections',[\s\S]*?JSON\.stringify\(\{\s*name,\s*rules\s*\}\)/,
        'saveCurrentAsCollection must POST {name, rules} to /api/collections',
    );
    // After save, switch the source to the new collection and rebuild the UI.
    assert.match(src, /state\.provider\s*=\s*'collection:'\s*\+\s*col\.id/);
});

test('the drawer shows a Save-as-collection action only when filters are set', () => {
    assert.match(src, /Object\.keys\(currentFilterRules\(\)\)\.length[\s\S]*?data-drawer-save/);
    assert.match(src, /data-drawer-save[\s\S]*?saveCurrentAsCollection/);
});
