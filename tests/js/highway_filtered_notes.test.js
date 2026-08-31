// Focused coverage for highway difficulty filtering. The createHighway closure
// is too large for the Node harness, so wiring stays source-checked while the
// extracted filter and bundle helpers are exercised with real chart state.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const highwayJs = path.join(__dirname, '..', '..', 'static', 'highway.js');

function extractBlock(src, marker) {
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `${marker} present`);
    const open = src.indexOf('{', start);
    assert.ok(open >= 0, `${marker} has a body`);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') {
            depth -= 1;
            if (depth === 0) return src.slice(start, i + 1);
        }
    }
    assert.fail(`${marker} body is balanced`);
}

function createMasteryHarness() {
    const src = fs.readFileSync(highwayJs, 'utf8');
    const snippets = [
        extractBlock(src, 'function _hasAuthoredPhraseLevels(phrases = hwState._phrases)'),
        extractBlock(src, 'function _rebuildMasteryFilter()'),
        extractBlock(src, 'function _makeBundle()'),
    ].join('\n');
    const hwState = {
        currentTime: 0,
        songInfo: { tuning: [0, 0, 0, 0, 0, 0], capo: 0, centOffset: 0 },
        ready: false,
        _chartAnchorPerfNow: NaN,
        _chartLastAdvanceAt: 0,
        notes: [{ t: 1, s: 0, f: 3 }],
        chords: [{ t: 2, notes: [{ s: 1, f: 5 }] }],
        anchors: [{ time: 0, fret: 1, width: 4 }],
        handShapes: [{ start_time: 0, end_time: 3 }],
        beats: [], sections: [], chordTemplates: [], stringCount: 6,
        lyrics: [], lyricsSource: null, toneChanges: [], toneBase: null, drumTab: null,
        _mastery: 1,
        _phrases: null,
        _filteredNotes: [{ sentinel: 'note' }],
        _filteredChords: [{ sentinel: 'chord' }],
        _filteredAnchors: [{ sentinel: 'anchor' }],
        _filteredHandShapes: [{ sentinel: 'handshape' }],
        _phrasesHaveHandShapes: true,
        _xfNotes: null, _xfChords: null, _xfAnchors: null,
        _xfNotesAll: null, _xfChordsAll: null, _xfChordTemplates: null,
        _xfStringCount: null, _xfTuning: null, _xfCapo: null,
        _xfHandShapes: null, _xfCentOffset: null,
        _inverted: false, _lefty: false, showLyrics: true,
        _showTeachingMarks: true, _showFingerHints: true,
    };
    let restages = 0;
    const runtime = new Function('hwState', 'onRestage', `
        const _bundleReused = {};
        const _CHART_MAX_INTERP_MS = 250;
        const performance = { now: () => 0 };
        const _effectiveRenderScale = () => 1;
        const project = () => {};
        const boundFretX = () => {};
        const bsearch = () => 0;
        const bsearchTime = () => 0;
        const boundNoteState = () => null;
        const _getNoteStateProvider = () => null;
        const _restageChartTransform = onRestage;
        ${snippets}
        return {
            phrases(data) {
                if (hwState._phrases === null) hwState._phrases = [];
                for (const phrase of data) hwState._phrases.push(phrase);
            },
            ready() {
                hwState.ready = true;
                _rebuildMasteryFilter();
                return _makeBundle();
            },
            hasPhraseData: _hasAuthoredPhraseLevels,
        };
    `)(hwState, () => { restages += 1; });
    return { hwState, runtime, restages: () => restages };
}

test('highway public API exposes getFilteredNotes', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /getFilteredNotes\s*\(\s*\)\s*\{[^}]*_filteredNotes\s*!==\s*null/,
        'getFilteredNotes must check _filteredNotes !== null',
    );
});

test('getFilteredNotes falls through to notes when _filteredNotes is null', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /getFilteredNotes\s*\(\s*\)\s*\{[^}]*_filteredNotes[^}]*:\s*hwState\.notes/,
        'getFilteredNotes must return notes as fallback',
    );
});

test('highway public API exposes getFilteredChords', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /getFilteredChords\s*\(\s*\)\s*\{[^}]*_filteredChords\s*!==\s*null/,
        'getFilteredChords must check _filteredChords !== null',
    );
});

test('getFilteredChords falls through to chords when _filteredChords is null', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /getFilteredChords\s*\(\s*\)\s*\{[^}]*_filteredChords[^}]*:\s*hwState\.chords/,
        'getFilteredChords must return chords as fallback',
    );
});

test('highway public API exposes hasPhraseData', () => {
    const src = fs.readFileSync(highwayJs, 'utf8');
    assert.match(
        src,
        /hasPhraseData\s*\(\s*\)\s*\{[^}]*_hasAuthoredPhraseLevels\(\)/,
        'hasPhraseData must use the authored-level predicate',
    );
});

test('metadata-only phrases preserve flat chart views through ready', () => {
    const { hwState, runtime, restages } = createMasteryHarness();
    runtime.phrases([
        { start_time: 0, end_time: 1, levels: [] },
        { start_time: 1, end_time: 2 },
        { start_time: 2, end_time: 3, levels: null },
    ]);

    const bundle = runtime.ready();

    assert.strictEqual(bundle.notes, hwState.notes);
    assert.strictEqual(bundle.chords, hwState.chords);
    assert.strictEqual(bundle.anchors, hwState.anchors);
    assert.strictEqual(bundle.handShapes, hwState.handShapes);
    assert.equal(bundle.hasPhraseData, false, 'mastery slider stays disabled');
    assert.equal(runtime.hasPhraseData(), false);
    assert.equal(restages(), 1, 'ready refreshes the chart transform stage');
});

test('mixed phrase payload safely skips missing levels and filters authored levels', () => {
    const { runtime } = createMasteryHarness();
    const filteredNote = { t: 4, s: 2, f: 7 };
    const filteredChord = { t: 5, notes: [{ s: 0, f: 2 }] };
    const filteredAnchor = { time: 4, fret: 5, width: 4 };
    const filteredHandShape = { start_time: 4, end_time: 6 };
    runtime.phrases([
        { start_time: 0, end_time: 3 },
        { start_time: 3, end_time: 4, levels: null },
        { start_time: 4, end_time: 6, levels: [{
            notes: [filteredNote],
            chords: [filteredChord],
            anchors: [filteredAnchor],
            handshapes: [filteredHandShape],
        }] },
    ]);

    const bundle = runtime.ready();

    assert.deepEqual(bundle.notes, [filteredNote]);
    assert.deepEqual(bundle.chords, [filteredChord]);
    assert.deepEqual(bundle.anchors, [filteredAnchor]);
    assert.deepEqual(bundle.handShapes, [filteredHandShape]);
    assert.equal(bundle.hasPhraseData, true);
});
