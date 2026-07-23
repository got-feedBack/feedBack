// Pins the wide-pane horizontal-FOV-hold ("Hor+") framing in
// plugins/highway_3d/screen.js.
//
// What it guards: ultra-wide panes (top/bottom 2-player split → full-width /
// half-height → ~32:9) used to render the neck as a thin central sliver because
// THREE's PerspectiveCamera fov is VERTICAL and was locked at 70°, ballooning
// the horizontal cone past 130°. The fix lets camUpdate lower the effective
// vertical fov as the pane widens (holding the horizontal cone ~constant) so the
// neck fills the pane. It is gated behind window.__h3dAspectTune (default off →
// byte-for-byte the prior behaviour) for live A/B comparison.
//
// A refactor that re-hardcodes the camera fov, drops the change-guarded cam.fov
// write, stops caching the pane aspect, or removes the no-op-at-startAspect
// guarantee would silently regress the feature (or worse, change normal-pane
// framing). These are source-level pins — same strategy as the other
// tests/js/ files (no DOM / WebGL in CI).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');
const src = fs.readFileSync(SCREEN_JS, 'utf8');

function sourceBetween(startText, endText) {
    const start = src.indexOf(startText);
    const end = src.indexOf(endText, start);
    assert.ok(start >= 0 && end > start, 'missing source range');
    return src.slice(start, end);
}

function standaloneFunction(startText, endText) {
    return Function('return (' + sourceBetween(startText, endText).trim() + ')')();
}

// ── Constants ────────────────────────────────────────────────────────────────

test('BASE_VFOV is a named constant (not a literal in the camera ctor)', () => {
    assert.match(
        src,
        /const\s+BASE_VFOV\s*=\s*70\s*;/,
        'BASE_VFOV must be declared as a constant',
    );
});

test('the camera is constructed with BASE_VFOV, not a bare 70', () => {
    assert.match(
        src,
        /new\s+T\.PerspectiveCamera\(\s*BASE_VFOV\s*,/,
        'PerspectiveCamera must take BASE_VFOV as its vertical fov',
    );
});

test('the Hor+ start-aspect and min-vfov defaults exist', () => {
    assert.match(src, /const\s+HORPLUS_START_ASPECT\s*=\s*16\s*\/\s*9\s*;/,
        'HORPLUS_START_ASPECT must default to 16/9 (no-op at/under the reference aspect)');
    assert.match(src, /const\s+HORPLUS_MIN_VFOV\s*=\s*\d+\s*;/,
        'HORPLUS_MIN_VFOV floor must be declared');
});

// ── effectiveVfov: no-op guarantees ──────────────────────────────────────────

test('effectiveVfov returns the base fov when the bridge is off/absent', () => {
    // The disabled / malformed-input guard returns `base` before any Hor+ math,
    // so normal panes are unaffected when __h3dAspectTune is missing or off.
    assert.match(
        src,
        /function\s+effectiveVfov\s*\(\s*aspect\s*,\s*tune\s*\)\s*\{[\s\S]*?if\s*\(\s*!tune\s*\|\|\s*!tune\.enabled[\s\S]*?return\s+base\s*;/,
        'effectiveVfov must short-circuit to the base fov when disabled',
    );
});

test('effectiveVfov is a no-op at/under the start aspect', () => {
    assert.match(
        src,
        /if\s*\(\s*aspect\s*<=\s*start\s*\)\s*return\s+base\s*;/,
        'effectiveVfov must return base when aspect <= start (no-op for normal/2x2 panes)',
    );
});

// ── shipped defaults: off + coherent ─────────────────────────────────────────
// The "default off → byte-for-byte prior behaviour" contract only holds if the
// shipped _ASPECT_DEFAULTS actually ship disabled with a base that matches the
// camera's constructed fov. A previous revision shipped enabled:true with
// baseVfov:30 (and blend:0), which forced every pane's fov to 30/36 and
// silently re-framed normal single-player panes. These pin against that.

test('_ASPECT_DEFAULTS ships disabled (no-op out of the box)', () => {
    assert.match(
        src,
        /const\s+_ASPECT_DEFAULTS\s*=\s*\{[\s\S]*?\benabled\s*:\s*false\b/,
        '_ASPECT_DEFAULTS.enabled must default to false so the feature is opt-in',
    );
});

test('the default base fov matches BASE_VFOV (enabling is still a no-op on normal panes)', () => {
    // baseVfov === BASE_VFOV means even with the feature ON, a <=startAspect pane
    // returns the unchanged 70° — the effect is confined to genuinely wide panes.
    assert.match(
        src,
        /const\s+_ASPECT_DEFAULTS\s*=\s*\{[\s\S]*?\bbaseVfov\s*:\s*BASE_VFOV\b/,
        '_ASPECT_DEFAULTS.baseVfov must default to BASE_VFOV, not a divergent literal',
    );
});

test('the default blend engages the hold and the floor sits below the base', () => {
    // blend:1 means turning the feature on actually holds the horizontal cone
    // (blend:0 would collapse effectiveVfov back to base = feature inert), and
    // minVfovDeg:HORPLUS_MIN_VFOV keeps the floor below baseVfov (a real floor,
    // not one that clamps the base upward).
    assert.match(
        src,
        /const\s+_ASPECT_DEFAULTS\s*=\s*\{[\s\S]*?\bblend\s*:\s*1\b/,
        '_ASPECT_DEFAULTS.blend must default to 1 so the Hor+ hold actually applies when enabled',
    );
    assert.match(
        src,
        /const\s+_ASPECT_DEFAULTS\s*=\s*\{[\s\S]*?\bminVfovDeg\s*:\s*HORPLUS_MIN_VFOV\b/,
        '_ASPECT_DEFAULTS.minVfovDeg must default to HORPLUS_MIN_VFOV (a floor below baseVfov)',
    );
});

// ── camUpdate: change-guarded fov write + cached aspect ───────────────────────

test('applySize caches the pane aspect for camUpdate', () => {
    assert.match(
        src,
        /_paneAspect\s*=\s*cam\.aspect\s*;/,
        'applySize must cache cam.aspect into _paneAspect',
    );
});

test('camUpdate resolves a per-pane tune and respects splitOnly', () => {
    assert.match(
        src,
        /const\s+_aspTune\s*=\s*_resolveTuneFor\(\s*_paneKey\s*\)\s*;[\s\S]*?_aspTune\.splitOnly\s*&&\s*!_ssActive\(\)/,
        'camUpdate must resolve the tune per pane via _resolveTuneFor(_paneKey) and gate splitOnly',
    );
});

test('the tune bridge seeds from localStorage (persisted sessions apply on load)', () => {
    assert.match(
        src,
        /function\s+_aspectTune\s*\(\)[\s\S]*?localStorage\.getItem\(\s*_ASPECT_LS\s*\)/,
        '_aspectTune() must seed the bridge from localStorage',
    );
});

test('a floating tuner panel is built and can be shown/hidden', () => {
    assert.match(src, /function\s+_ensureAspectPanel\s*\(\)/,
        '_ensureAspectPanel() must exist to build the live panel');
    assert.match(src, /function\s+_setAspectPanelVisible\s*\(/,
        '_setAspectPanelVisible() must show/hide the panel');
});

// ── Per-pane targeting ────────────────────────────────────────────────────────

test('the tune resolves per pane with a sparse override map', () => {
    // _resolveTuneFor overlays a pane's __panels[key] overrides onto the base so
    // one split pane can be framed independently of the others.
    assert.match(
        src,
        /function\s+_resolveTuneFor\s*\(\s*paneKey\s*\)[\s\S]*?base\.__panels\s*&&\s*base\.__panels\[\s*paneKey\s*\]/,
        '_resolveTuneFor must overlay per-pane overrides from base.__panels',
    );
});

test('panel writes route to the selected target (base or a pane override)', () => {
    // _aspectWriteVal writes to the base when target is empty, else into the
    // pane override sub-object; camUpdate consumes it via _resolveTuneFor.
    assert.match(
        src,
        /function\s+_aspectWriteVal\s*\([\s\S]*?if\s*\(\s*!_aspectEditTarget\s*\)[\s\S]*?base\.__panels\b[\s\S]*?\[\s*_aspectEditTarget\s*\]/,
        '_aspectWriteVal must target base for "all" and __panels[target] for a pane',
    );
});

test('a Target select and pane registry drive the per-pane picker', () => {
    assert.match(src, /_aspectTargetSel\s*=\s*document\.createElement\(\s*'select'\s*\)/,
        'the panel must build a Target <select>');
    assert.match(src, /function\s+_aspectRegisterPane\s*\(/,
        '_aspectRegisterPane must record live panes for the picker');
    assert.match(src, /if\s*\(\s*window\.__h3dAspectPanelOpen\s*\)\s*_aspectRegisterPane\(\s*_paneKey\s*\)/,
        'camUpdate must register its pane only while the tuner panel is open');
});

test('panes are keyed by arrangement (stable across songs, no split-API dep)', () => {
    // 'arr:<name>' keys are distinct between split panes AND stable across
    // songs, without depending on the external splitscreen panel index (which
    // isn't always available). A per-instance id is the no-arrangement fallback.
    assert.match(
        src,
        /function\s+_aspectPaneKey\s*\(\s*arrangement\s*,\s*uid\s*\)[\s\S]*?'arr:'\s*\+\s*a[\s\S]*?'pane:'\s*\+\s*uid/,
        '_aspectPaneKey must prefer arr:<name> and fall back to pane:<uid>',
    );
    assert.match(
        src,
        /const\s+_paneKey\s*=\s*_aspectPaneKey\(\s*[\s\S]*?songInfo[\s\S]*?arrangement\s*,\s*_paneUid\s*\)\s*;/,
        'camUpdate must key the pane by arrangement (with the uid fallback)',
    );
});

test('arrangement-keyed overrides persist; instance-id keys stay session-only', () => {
    assert.match(
        src,
        /function\s+_aspectPersist\s*\(\)[\s\S]*?k\.slice\(0,\s*4\)\s*===\s*'arr:'[\s\S]*?out\.__panels\s*=\s*p/,
        '_aspectPersist must persist only arr:* overrides so they carry across songs',
    );
});

test('the target dropdown prunes dead panes and does not rebuild while focused', () => {
    assert.match(src, /function\s+_aspectPrunePanes\s*\(\)[\s\S]*?delete\s+reg\[k\]/,
        '_aspectPrunePanes must drop panes not seen recently');
    assert.match(src, /_aspectPrunePanes\(\)\s*;[\s\S]*?if\s*\(\s*_aspectPanesDirty\s*\)\s*_aspectBuildTargets\(\)/,
        'the readout tick must prune then rebuild only when dirty');
    assert.match(src, /function\s+_aspectBuildTargets\s*\(\)[\s\S]*?document\.activeElement\s*===\s*_aspectTargetSel[\s\S]*?return/,
        '_aspectBuildTargets must skip rebuilding while the select is focused');
});

test('programmatic sync does not write back into the tune', () => {
    // _syncAspectPanel dispatches synthetic input events to refresh labels; the
    // slider handler must skip the write while syncing, else opening/switching a
    // target would populate a full override for every field.
    assert.match(src, /_aspectSyncing\s*=\s*true[\s\S]*?finally[\s\S]*?_aspectSyncing\s*=\s*false/,
        '_syncAspectPanel must set/reset the _aspectSyncing guard');
    assert.match(src, /if\s*\(\s*!_aspectSyncing\s*\)\s*_aspectWriteVal\(\s*f\.k\s*,/,
        'the slider input handler must skip the write while syncing');
});

test('unchecking hfov override clears a pane override key (re-inherits base)', () => {
    assert.match(
        src,
        /function\s+_aspectClearVal\s*\(\s*k\s*\)[\s\S]*?delete\s+ov\[k\][\s\S]*?delete\s+m\[\s*_aspectEditTarget\s*\]/,
        '_aspectClearVal must delete the pane override key (and empty object)',
    );
    assert.match(src, /else\s+_aspectClearVal\(\s*'hfovDeg'\s*\)/,
        'unchecking the hfov override must call _aspectClearVal');
});

test('pruning drops the matching readout slot and a dangling __last', () => {
    assert.match(
        src,
        /delete\s+reg\[k\]\s*;[\s\S]*?delete\s+ro\[k\]\s*;\s*if\s*\(\s*ro\.__last\s*===\s*k\s*\)\s*delete\s+ro\.__last/,
        '_aspectPrunePanes must prune the readout cache alongside the registry',
    );
});

test('single-pane forces the edit target back to All (no hidden pane edits)', () => {
    assert.match(
        src,
        /if\s*\(\s*keys\.length\s*<=\s*1\s*\|\|\s*\(\s*_aspectEditTarget\s*&&\s*!reg\[_aspectEditTarget\]\s*\)\s*\)\s*\{\s*_aspectEditTarget\s*=\s*''/,
        '_aspectBuildTargets must reset the edit target to "" when the Target row is hidden',
    );
});

test('resolved per-pane tune is memoized and invalidated by a revision', () => {
    assert.match(src, /_aspectRev\s*\+\+/, 'a mutation revision must be bumped on persist');
    assert.match(
        src,
        /_aspectResolveCache\.get\(\s*paneKey\s*\)[\s\S]*?c\.rev\s*===\s*_aspectRev[\s\S]*?return\s+c\.obj/,
        '_resolveTuneFor must return a cached object when the revision is unchanged',
    );
});

test('the pane clock falls back to Date.now so pruning keeps working', () => {
    assert.match(
        src,
        /function\s+_aspectNowMs\s*\(\)[\s\S]*?performance\.now\(\)[\s\S]*?return\s+Date\.now\(\)/,
        '_aspectNowMs must fall back to Date.now() when the Performance API is absent',
    );
});

test('opening the panel prunes before the first dropdown build', () => {
    assert.match(
        src,
        /if\s*\(\s*on\s*\)\s*\{\s*_aspectPrunePanes\(\)\s*;\s*_aspectBuildTargets\(\)/,
        '_setAspectPanelVisible must prune stale panes before building the dropdown',
    );
});

test('Reset on All restores defaults exactly (no forced enabled)', () => {
    // Panel visibility is independent of the enabled flag now, so Reset must not
    // force enabled true — it should restore _ASPECT_DEFAULTS verbatim.
    assert.doesNotMatch(src, /Object\.keys\(_ASPECT_DEFAULTS\)[\s\S]*?base\.enabled\s*=\s*true/,
        'Reset must not override the default enabled state');
});

test('the panel has a dismiss (close) control', () => {
    assert.match(
        src,
        /close\.textContent\s*=\s*'×'[\s\S]*?_setAspectPanelVisible\(\s*false\s*\)/,
        'the panel header must have a × button that hides the panel',
    );
});

test('camUpdate only writes cam.fov when it actually changes', () => {
    const camUpdate = sourceBetween('function camUpdate(bundle)',
        '        function _freeCamProjectionZoom');
    assert.equal((camUpdate.match(/const\s+_freeCam\s*=\s*_freeCamFor\(highwayCanvas\)/g) || []).length, 1,
        'camUpdate must resolve the bridge once');
    assert.match(camUpdate, /_applyFreeCamProjection\(_vfov,\s*_projectionZoom\)/);

    const projection = sourceBetween('function _freeCamProjectionZoom',
        '        function _clearFreeCamViewOffset');
    assert.match(projection,
        /if\s*\(\s*!freeCam\s*\|\|\s*!freeCam\.enabled\s*\)\s*return\s+1/,
        'a disabled bridge must keep zoom neutral');
    const coerceZoom = standaloneFunction('function _coerceFreeCamProjectionZoom',
        '        function _freeCamNeutralProjectionNdcY');
    assert.deepEqual(
        [coerceZoom(2), coerceZoom('2'), coerceZoom(Symbol('bad'))],
        [2, 1, 1],
        'projection zoom accepts only finite numeric values without coercion');
    assert.match(projection,
        /Number\.isFinite\(vfov\)\s*&&\s*Math\.abs\(vfov\s*-\s*cam\.fov\)\s*>\s*1e-4[\s\S]*?cam\.fov\s*=\s*vfov/,
        'the original finite and changed fov guards must remain');
    assert.match(projection,
        /Math\.abs\(desiredZoom[\s\S]*?1e-4[\s\S]*?cam\.zoom\s*=\s*desiredZoom/,
        'the zoom write must be guarded');
    assert.match(projection, /if\s*\(\s*changed\s*\)\s*cam\.updateProjectionMatrix\(\)/,
        'fov and zoom must share one projection update');
});

// ── Shortcut (open/close) + lifecycle reset ───────────────────────────────────

test('the shortcut opens/closes the tuner panel', () => {
    assert.match(
        src,
        /registerShortcut\(\{[\s\S]*?_toggleAspectPanel\(\)/,
        'a registerShortcut handler must toggle the tuner panel',
    );
    assert.match(src, /function\s+_toggleAspectPanel\s*\(\)/,
        '_toggleAspectPanel() must exist to reveal/dismiss the panel');
});

test('destroy() resets the pane aspect and restores the base fov', () => {
    assert.match(src, /_paneAspect\s*=\s*0\s*;/,
        'destroy() must reset _paneAspect to 0');
    assert.match(src,
        /destroy\(\)\s*\{[\s\S]*?_unsubscribeFocus\(\);\s*teardown\(\);[\s\S]*?highwayCanvas\s*=\s*null/,
        'destroy() must delegate cleanup through teardown');

    const teardown = sourceBetween('function teardown()', '        function canvasSize(canvas)');
    assert.match(teardown,
        /_resetFreeCamViewOffsetState\(true\)[\s\S]*?_resetFreeCamProjectionState\(\)/);
    const reset = sourceBetween('function _resetFreeCamProjectionState',
        '        function _freeCamShouldApplyViewOffset');
    assert.match(reset,
        /cam\.fov\s*!==\s*BASE_VFOV[\s\S]*?cam\.fov\s*=\s*BASE_VFOV/,
        'destroy() cleanup must strictly restore the base fov');
    assert.match(reset,
        /cam\.zoom\s*!==\s*1[\s\S]*?cam\.zoom\s*=\s*1/,
        'destroy() cleanup must strictly restore neutral zoom');
    assert.match(reset, /if\s*\(\s*changed\s*\)\s*cam\.updateProjectionMatrix\(\)/,
        'fov and zoom cleanup must share one projection update');
});

test('free-camera view offsets are normalized and cached', () => {
    const toPixels = standaloneFunction('function _freeCamViewOffsetToPixels',
        '        function _freeCamPixelsToViewOffset');
    const toOffset = standaloneFunction('function _freeCamPixelsToViewOffset',
        '        function _setFreeCamViewOffsetPixels');
    assert.deepEqual(
        [toPixels(0.25, 800), toPixels(-0.1, 600), toOffset(200, 800), toOffset(-60, 600)],
        [200, -60, 0.25, -0.1],
    );
    const view = sourceBetween('function _setFreeCamViewOffsetPixels',
        '        function _getFreeCamBoardAnchorOffset');
    assert.match(view,
        /const\s+view\s*=\s*cam\.view[\s\S]*?view\.offsetX[\s\S]*?view\.offsetY[\s\S]*?return\s+true[\s\S]*?cam\.setViewOffset\(/,
        'steady offsets must skip setViewOffset');
});

test('free-camera projection controls do not feed adaptive tilt', () => {
    const update = sourceBetween('function camUpdate(bundle)',
        '        function _freeCamProjectionZoom');
    assert.match(update,
        /_probe\.project\(cam\)[\s\S]*?_freeCamNeutralProjectionNdcY\(_probe\.y,\s*_projectionZoom\)[\s\S]*?if\s*\(\s*_tiltProbeY\s*<\s*DESIRED_NDC_Y/);
    const neutral = sourceBetween('function _freeCamNeutralProjectionNdcY',
        '        function _applyFreeCamProjection');
    assert.match(neutral, /return\s+\(ndcY\s*-\s*viewOffsetY\)\s*\/\s*zoom/,
        'tilt must remove projection zoom and vertical view offset');
});

test('board anchor validates requests and captures safely', () => {
    const request = sourceBetween('function _getFreeCamBoardAnchorRequest',
        '        function _captureFreeCamBoardAnchorWorldPoint');
    assert.match(request, /const\s+capture\s*=\s*anchor\s*&&\s*anchor\.capture[\s\S]*?capture\.clientX[\s\S]*?capture\.clientY/);
    assert.match(request,
        /!Number\.isFinite\(anchor\.requestId\)[\s\S]*?_clearFreeCamBoardAnchorState\(\)[\s\S]*?return\s+null/,
        'malformed requests must fail safely');

    let clearCount = 0;
    const getRequest = Function('_clearFreeCamBoardAnchorState',
        'return (' + request.trim() + ')')(() => { clearCount += 1; });
    const validAnchor = {
        enabled: true,
        requestId: 7,
        clientX: 80,
        clientY: 60,
        capture: { clientX: 40, clientY: 30 },
    };
    assert.equal(getRequest({ enabled: 1, boardAnchor: validAnchor }), validAnchor,
        'truthy bridge enablement must accept a valid numeric request');
    assert.equal(getRequest({ enabled: false, boardAnchor: validAnchor }), null);
    assert.equal(getRequest({ enabled: true, boardAnchor: {
        ...validAnchor,
        clientX: '80',
    } }), null, 'numeric strings must not be coerced');
    assert.doesNotThrow(() => getRequest({ enabled: true, boardAnchor: {
        ...validAnchor,
        requestId: Symbol('request'),
    } }));
    assert.equal(clearCount, 3, 'disabled and malformed requests must clear state');

    const offset = sourceBetween('function _getFreeCamBoardAnchorOffset',
        '        function _getFreeCamBoardAnchorRequest');
    assert.match(offset,
        /canvas\.getBoundingClientRect\(\)[\s\S]*?_captureFreeCamBoardAnchorWorldPoint\(capture,\s*rect\)/);
    assert.match(offset,
        /unavailable:\s*true[\s\S]*?finally\s*\{[\s\S]*?cam\.zoom\s*=\s*savedZoom[\s\S]*?_setFreeCamViewOffsetPixels\(viewW,\s*viewH,\s*baseX,\s*baseY\)/,
        'unavailable captures must stay safe and projection state must be restored');
});

test('board anchor publishes the public correction contract', () => {
    const publish = sourceBetween('function _publishFreeCamBoardAnchorReadout',
        '        function _writeFreeCamBoardAnchorReadout');
    assert.match(publish,
        /freeCam\.boardAnchorReadout[\s\S]*?_freeCamPixelsToViewOffset\(offset\.x,\s*viewW\)[\s\S]*?_freeCamPixelsToViewOffset\(offset\.y,\s*viewH\)/,
        'readout corrections must use caller-owned normalized offsets');

    const toOffset = standaloneFunction('function _freeCamPixelsToViewOffset',
        '        function _setFreeCamViewOffsetPixels');
    const write = standaloneFunction('function _writeFreeCamBoardAnchorReadout',
        '        /* ── Resize helper');
    const publishReadout = Function('_freeCamPixelsToViewOffset',
        '_writeFreeCamBoardAnchorReadout',
        'return (' + publish.trim() + ')')(toOffset, write);
    const readout = {};
    publishReadout({ boardAnchorReadout: readout }, {
        active: true,
        requestId: 7,
        x: 80,
        y: -60,
    }, 800, 600);
    assert.deepEqual(readout, {
        active: true,
        requestId: 7,
        viewOffsetDeltaX: 0.1,
        viewOffsetDeltaY: -0.1,
    });
    publishReadout({ boardAnchorReadout: readout }, null, 800, 600);
    assert.deepEqual(readout, {
        active: false,
        requestId: 0,
        viewOffsetDeltaX: 0,
        viewOffsetDeltaY: 0,
    });
    assert.doesNotThrow(() => publishReadout({
        boardAnchorReadout: Object.freeze({}),
    }, { active: true, requestId: 8, x: 1, y: 1 }, 1, 1));
});

test('board anchor recaptures for owner request or canvas changes', () => {
    const ownership = sourceBetween('function _getFreeCamBoardAnchorOffset',
        '        function _getFreeCamBoardAnchorRequest');
    assert.match(ownership,
        /retained\.bridge\s*!==\s*freeCam[\s\S]*?_clearFreeCamBoardAnchorState\(\)[\s\S]*?retained\s*=\s*null/,
        'switching bridge objects must clear the previous owner');
    assert.match(ownership,
        /!retained\s*\|\|\s*retained\.requestId\s*!==\s*requestId[\s\S]*?retained\.viewW\s*!==\s*viewW[\s\S]*?retained\.viewH\s*!==\s*viewH/);
});

test('board anchor steady work reuses scratch state and retained ownership', () => {
    const offset = sourceBetween('function _getFreeCamBoardAnchorOffset',
        '        function _getFreeCamBoardAnchorRequest');
    assert.match(offset,
        /_freeCamBoardAnchorOffset\.active\s*=\s*true[\s\S]*?return\s+_freeCamBoardAnchorOffset/);
    assert.doesNotMatch(offset, /return\s*\{\s*active:\s*true/);
    assert.match(offset,
        /_freeCamBoardAnchorProject[\s\S]*?point\.project\(cam\)/,
        'projection must reuse the renderer-owned vector');

    const readout = sourceBetween('function _writeFreeCamBoardAnchorReadout',
        '        /* ── Resize helper');
    assert.match(readout,
        /if\s*\(\s*!Object\.is\(readout\[key\],\s*value\)\s*\)\s*readout\[key\]\s*=\s*value/);
    const cleanup = sourceBetween('function _clearFreeCamBoardAnchorState',
        '        function _resetFreeCamProjectionState');
    assert.match(cleanup,
        /_publishFreeCamBoardAnchorReadout\(retainedBridge,\s*null,\s*1,\s*1\)/);
    assert.doesNotMatch(cleanup, /window\.__h3dCamCtl|__h3dCamCtlPanels|_freeCamFor|document/,
        'cleanup must stay scoped to the retained owner');
});
