// Verify static/highway.js keeps the drum gameplay metadata (feedpak 1.20.0)
// the server streams with a drum tab: `star_power` / `fills` / `solos` on
// the `drum_tab` frame, and each level's hits from `drum_level_hits` chunks,
// so a drums renderer reads them from `bundle.drumTab`.
//
// Same isolation strategy as beats_loaded.test.js — extract the relevant
// switch-case blocks by string matching and run them in a vm sandbox with a
// stub hwState.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HIGHWAY_JS = path.join(__dirname, '..', '..', 'static', 'highway.js');

function getCaseBlock(src, label) {
    const start = src.indexOf(`case '${label}'`);
    assert.ok(start !== -1, `case '${label}' not found in highway.js`);
    const tail = src.slice(start);
    const nextCase = tail.slice(1).search(/\n\s*case\s+['"]/);
    const nextDefault = tail.search(/\n\s*default\s*:/);
    let end = tail.length;
    if (nextCase > 0) end = Math.min(end, nextCase + 1);
    if (nextDefault > 0) end = Math.min(end, nextDefault);
    return tail.slice(0, end);
}

// A dispatcher holding just the drum cases: feed(msg) runs one WS frame.
function makeDispatcher() {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const body = ['drum_tab', 'drum_hits', 'drum_level_hits'].map(l => getCaseBlock(src, l)).join('\n');
    const ctx = {
        hwState: { drumTab: null },
        document: { getElementById: () => null },
    };
    vm.createContext(ctx);
    vm.runInContext(`function feed(msg) { switch (msg.type) {\n${body}\n} }`, ctx);
    return ctx;
}

test('drum_tab keeps star power / fills / solos and indexes the levels', () => {
    const ctx = makeDispatcher();
    ctx.feed({
        type: 'drum_tab', version: 1, name: 'Drums', kit: [], total: 2,
        star_power: [{ start_time: 0.5, end_time: 2.5 }],
        fills: [{ start_time: 6, end_time: 8 }],
        solos: [{ start_time: 32, end_time: 48 }],
        levels: { easy: { total: 1, generated: true }, hard: { total: 2, generated: false }, bogus: { total: 1 } },
    });
    const dt = ctx.hwState.drumTab;
    assert.deepEqual(JSON.parse(JSON.stringify(dt.star_power)), [{ start_time: 0.5, end_time: 2.5 }]);
    assert.deepEqual(JSON.parse(JSON.stringify(dt.fills)), [{ start_time: 6, end_time: 8 }]);
    assert.deepEqual(JSON.parse(JSON.stringify(dt.solos)), [{ start_time: 32, end_time: 48 }]);
    // unknown level ids are ignored (the spec's closed list)
    assert.deepEqual(Object.keys(dt.levels).sort(), ['easy', 'hard']);
    assert.equal(dt.levels.easy.generated, true);
    assert.equal(dt.levels.hard.generated, false);

    ctx.feed({ type: 'drum_hits', data: [{ t: 0.5, p: 'kick', x2: true }, { t: 0.5, p: 'crash_l', a: true }], total: 2 });
    ctx.feed({ type: 'drum_level_hits', level: 'hard', data: [{ t: 0.5, p: 'kick' }], total: 2 });
    ctx.feed({ type: 'drum_level_hits', level: 'hard', data: [{ t: 0.5, p: 'crash_l', a: true }], total: 2 });
    ctx.feed({ type: 'drum_level_hits', level: 'easy', data: [{ t: 0.5, p: 'crash_l' }], total: 1 });
    // chunks for a level the drum_tab frame didn't announce are dropped
    ctx.feed({ type: 'drum_level_hits', level: 'medium', data: [{ t: 1, p: 'snare' }], total: 1 });
    ctx.feed({ type: 'drum_level_hits', level: '__proto__', data: [{ t: 1, p: 'snare' }], total: 1 });

    assert.equal(dt.hits.length, 2);
    assert.equal(dt.hits[0].x2, true);
    assert.equal(dt.hits[1].a, true);
    assert.equal(dt.levels.hard.hits.length, 2);
    assert.equal(dt.levels.easy.hits.length, 1);
    assert.equal(dt.levels.medium, undefined);
});

test('a drum_tab frame without metadata leaves the old shape untouched', () => {
    const ctx = makeDispatcher();
    ctx.feed({ type: 'drum_tab', version: 1, name: 'Drums', kit: [], total: 0 });
    const dt = ctx.hwState.drumTab;
    assert.deepEqual(Object.keys(dt).sort(), ['hits', 'kit', 'name', 'part_id', 'version']);
    // stray level chunks with no announced levels are ignored, not thrown on
    ctx.feed({ type: 'drum_level_hits', level: 'easy', data: [{ t: 1, p: 'snare' }], total: 1 });
    assert.equal(dt.levels, undefined);
});

test('a new drum_tab frame resets the previous song\'s metadata', () => {
    const ctx = makeDispatcher();
    ctx.feed({ type: 'drum_tab', version: 1, name: 'A', kit: [], total: 0, star_power: [{ start_time: 1, end_time: 2 }],
        levels: { easy: { total: 1, generated: false } } });
    ctx.feed({ type: 'drum_level_hits', level: 'easy', data: [{ t: 1, p: 'snare' }], total: 1 });
    ctx.feed({ type: 'drum_tab', version: 1, name: 'B', kit: [], total: 0 });
    const dt = ctx.hwState.drumTab;
    assert.equal(dt.name, 'B');
    assert.equal(dt.star_power, undefined);
    assert.equal(dt.levels, undefined);
});
