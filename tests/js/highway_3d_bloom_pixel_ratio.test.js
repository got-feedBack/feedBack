// Pins the bloom-composer sizing in plugins/highway_3d/screen.js.
//
// Bug it guards against: bloom is on by default, and the EffectComposer is
// built once in _bloomEnsure(). EffectComposer snapshots
// renderer.getPixelRatio() in its constructor, and applySize() only ever
// updated the renderer's pixel ratio. When the adaptive render scale (#654)
// lowered _renderScale, the composer's render targets (and the bloom mip
// chain) stayed at the original resolution, so the downscale saved no GPU
// work and the adapt loop kept stepping down on every cooldown. The bloom
// branch also called canvasSize() (getBoundingClientRect, a forced layout)
// every frame, bypassing the 1-in-10 box-check throttle above it.
//
// The block is extracted from the source and run against fakes, so the test
// exercises the real code rather than just its shape.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');
const src = fs.readFileSync(SCREEN_JS, 'utf8');

function bloomBranch() {
    const start = src.indexOf('const comp = (_bloom && !_ssActive()) ? _bloomEnsure() : null;');
    assert.ok(start > 0, 'bloom render branch not found');
    const end = src.indexOf('comp.render()', start);
    assert.ok(end > start, 'comp.render() not found after the bloom branch');
    return src.slice(start, end);
}

// The sizing statements between `if (comp) {` and the tone-mapping line.
function sizingBlock() {
    const b = bloomBranch();
    const s = b.indexOf('if (comp) {') + 'if (comp) {'.length;
    const e = b.indexOf('if (ren.toneMapping');
    assert.ok(s > 0 && e > s, 'sizing block not found');
    return b.slice(s, e);
}

test('bloom branch does not force a layout read every frame', () => {
    assert.doesNotMatch(bloomBranch(), /canvasSize\(|getBoundingClientRect\(/);
});

test('composer pixel ratio is seeded from the renderer at construction', () => {
    assert.match(src, /_bloomPR\s*=\s*ren\.getPixelRatio\(\)\s*;\s*_composer\s*=\s*comp\s*;/);
});

test('render-scale drop reaches the composer, steady frames do no work', () => {
    const calls = [];
    const comp = {
        setPixelRatio(pr) { calls.push(['pr', pr]); },
        setSize(w, h) { calls.push(['size', w, h]); },
    };
    const state = { pr: 1, _bloomPR: 1, _bloomW: 1280, _bloomH: 720, _appliedW: 1280, _appliedH: 720 };
    const ren = { getPixelRatio: () => state.pr };
    // eslint-disable-next-line no-new-func
    const frame = new Function('comp', 'ren', 's',
        'let {_bloomPR, _bloomW, _bloomH, _appliedW, _appliedH} = s;' +
        sizingBlock() +
        'Object.assign(s, {_bloomPR, _bloomW, _bloomH});');

    frame(comp, ren, state);
    assert.deepEqual(calls, [], 'no resize when nothing changed');

    state.pr = 0.85;                 // adaptive scale stepped down
    frame(comp, ren, state);
    frame(comp, ren, state);
    assert.deepEqual(calls, [['pr', 0.85]], 'pixel ratio pushed exactly once');

    calls.length = 0;
    state._appliedW = 1000.5; state._appliedH = 600.4;   // fractional CSS box
    frame(comp, ren, state);
    frame(comp, ren, state);
    // Same CSS size the renderer got, unrounded, so the composer's targets
    // truncate after the pixel-ratio multiply exactly like the drawing buffer.
    assert.deepEqual(calls, [['size', 1000.5, 600.4]], 'fractional sizes resize once, not every frame');
});
