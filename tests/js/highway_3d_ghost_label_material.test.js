// Pins the per-mesh material reuse in drawGhostFretLabel()
// (plugins/highway_3d/screen.js).
//
// Bug it guards against: ghost fret labels come from a pool whose meshes are
// handed out in a different order every frame, so a given mesh shows a
// different digit from frame to frame. The old code disposed the mesh's
// instance material and cloned a fresh one whenever the digit (texture)
// changed: a material alloc + dispose per label per frame, and a dispose can
// release the shader program when it was its last user.
//
// Every ghost base material comes from _meshMatForGhostFretDigit with the same
// parameters and only the map differs, so the fix keeps one instance material
// per mesh and swaps its .map. The block is extracted from the source and run
// against fakes, so the test exercises the real code.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');
const src = fs.readFileSync(SCREEN_JS, 'utf8');

function instMatBlock() {
    const fn = src.indexOf('function drawGhostFretLabel(');
    assert.ok(fn > 0, 'drawGhostFretLabel not found');
    const s = src.indexOf('let instMat = lb.userData.h3dGhostFretLblInstMat;', fn);
    const e = src.indexOf('instMat.opacity = alpha;', s);
    assert.ok(s > fn && e > s, 'instance-material block not found');
    return src.slice(s, e) + 'return instMat;';
}

test('the base ghost material is built with the same parameters for every digit', () => {
    // The .map swap is only equivalent while the base materials differ by map alone.
    assert.match(
        src,
        /function _meshMatForGhostFretDigit\(spriteMat\) \{[\s\S]*?new T\.MeshBasicMaterial\(\{\s*map: spriteMat\.map,\s*transparent: true,\s*depthTest: false,\s*depthWrite: false,\s*\}\)/,
    );
});

test('digit changes on a pooled mesh reuse its material instead of re-cloning', () => {
    let clones = 0, disposes = 0;
    const mkBase = (map) => ({
        map,
        clone() { clones++; return { map: this.map, transparent: false, dispose() { disposes++; } }; },
    });
    const bases = [mkBase({ id: 'tex1' }), mkBase({ id: 'tex2' }), mkBase({ id: 'tex3' })];
    const lb = { userData: {} };
    // eslint-disable-next-line no-new-func
    const run = new Function('lb', 'baseGhostMat', instMatBlock());

    const first = run(lb, bases[0]);
    assert.equal(clones, 1);
    assert.equal(first.transparent, true);

    for (let frame = 0; frame < 300; frame++) {
        const base = bases[frame % bases.length];
        const m = run(lb, base);
        assert.equal(m, first, 'same instance material across digit changes');
        assert.equal(m.map, base.map, 'shows the current digit texture');
    }
    assert.equal(clones, 1, 'no clone per digit change');
    assert.equal(disposes, 0, 'no dispose per digit change');
});
