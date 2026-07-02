// Pins the auto-reframe-on-layout-settle behaviour in
// plugins/highway_3d/screen.js.
//
// Bug it guards against: when a song opens, the player screen may not have
// its final dimensions yet (controls / sections bar still laying out). The
// highway canvas is `#highway { flex: 1; min-height: 0 }`, so its real
// rendered box (canvasSize() via getBoundingClientRect) is temporarily too
// tall — applySize() then frames cam.aspect for the wrong height and the
// camera crops the near strings / fret-number row. Once the layout settles
// the flex box shrinks to the correct size, but the backing store
// (canvas.width/height) does NOT change, so the splitscreen-oriented
// `_lastHwW/_lastHwH` check never fires and the framing stays wrong until the
// user un/re-maximizes the window (which fires a real `resize`).
//
// The fix makes draw() additionally compare the live canvas box against the
// last logical size handed to applySize() (_appliedW/_appliedH) and re-apply
// on >1px drift even when the backing store is unchanged. A refactor that
// drops the CSS-box comparison, stops recording _appliedW/_appliedH, or
// reverts to backing-store-only detection would silently bring the bug back.
//
// Source-level only — same strategy as the other tests/js/ files.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');
const src = fs.readFileSync(SCREEN_JS, 'utf8');

// ── Applied-size tracking ───────────────────────────────────────────────────

test('the last applied logical size is tracked as instance state', () => {
    assert.match(
        src,
        /let\s+_appliedW\s*=\s*0\s*,\s*_appliedH\s*=\s*0\s*;/,
        '_appliedW / _appliedH must be declared as per-instance state',
    );
});

test('applySize records the logical w/h it applied', () => {
    // Recorded right after the aspect/aspectScale update so the draw() drift
    // check can compare against the size actually framed for.
    assert.match(
        src,
        /aspectScale\s*=\s*Math\.max\(1,[\s\S]*?_appliedW\s*=\s*w\s*;\s*_appliedH\s*=\s*h\s*;/,
        'applySize must set _appliedW = w; _appliedH = h after computing aspectScale',
    );
});

// ── draw() re-frames on CSS-box drift ───────────────────────────────────────

test('draw() reads the live canvas box once per frame', () => {
    assert.match(
        src,
        /const\s+box\s*=\s*canvasSize\(\s*highwayCanvas\s*\)\s*;/,
        'draw() must sample canvasSize(highwayCanvas) for the live box',
    );
});

test('backing-store drift branch is preserved (splitscreen path)', () => {
    // The original check that catches the splitscreen hw.resize override
    // resizing the element without calling renderer.resize() must remain.
    // The comparison is hoisted into _bsChanged (checked with cheap property
    // reads every frame, and it forces the throttled box read to run on the
    // same frame); the branch body is unchanged.
    assert.match(
        src,
        /const\s+_bsChanged\s*=\s*highwayCanvas\.width\s*!==\s*_lastHwW\s*\|\|\s*highwayCanvas\.height\s*!==\s*_lastHwH\s*;/,
        'the backing-store (canvas.width/height) comparison must run every frame',
    );
    assert.match(
        src,
        /if\s*\(\s*_bsChanged\s*\)\s*\{\s*_lastHwW\s*=\s*highwayCanvas\.width\s*;\s*_lastHwH\s*=\s*highwayCanvas\.height\s*;\s*if\s*\(\s*box\.w\s*>\s*0\s*&&\s*box\.h\s*>\s*0\s*\)\s*applySize\(\s*box\.w\s*,\s*box\.h\s*\)\s*;/,
        'the backing-store drift branch must still re-apply',
    );
    // The throttle must never delay the backing-store path: _bsChanged is
    // part of the gate that forces the box read on the same frame.
    assert.match(
        src,
        /if\s*\(\s*_bsChanged\s*\|\|\s*!_wrapPinned\s*\|\|\s*_boxCheckCountdown\s*===\s*0\s*\)/,
        'the box-read gate must include _bsChanged so backing-store changes re-apply immediately',
    );
});

test('draw() re-applies on CSS-box drift even without a backing-store change', () => {
    // The else-if branch: backing store unchanged, but the flex box drifted
    // from the last applied logical size by more than 1px → re-frame. This is
    // the branch that fixes the open-song crop without a manual window resize.
    assert.match(
        src,
        /else if\s*\(\s*box\.w\s*>\s*0\s*&&\s*box\.h\s*>\s*0\s*&&\s*\(\s*Math\.abs\(\s*box\.w\s*-\s*_appliedW\s*\)\s*>\s*1\s*\|\|\s*Math\.abs\(\s*box\.h\s*-\s*_appliedH\s*\)\s*>\s*1\s*\)\s*\)\s*\{\s*applySize\(\s*box\.w\s*,\s*box\.h\s*\)\s*;/,
        'draw() must re-apply when the live box drifts >1px from _appliedW/_appliedH',
    );
});

// ── Lifecycle reset ─────────────────────────────────────────────────────────

test('destroy() resets the applied-size tracking', () => {
    // Instances are reused across songs (destroy() → init()); stale applied
    // dims would suppress the first reframe of the next song.
    assert.match(
        src,
        /_appliedW\s*=\s*0\s*;\s*_appliedH\s*=\s*0\s*;/,
        'destroy() must reset _appliedW / _appliedH to 0',
    );
});
