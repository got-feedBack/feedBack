// Pins the optional note-name labels in plugins/highway_3d/screen.js
// (noteNamesVisible): a note name (C, C#, D, Eb, E, F, F#, G, Ab, A, Bb, B)
// above single-note gems, following tuning and capo.
//
// The pitch helpers are pure top-level functions, so they are sliced out of
// the source and executed; the setting wiring is checked at source level like
// the other tests/js/ files.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCREEN_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');
const SETTINGS_HTML = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'settings.html');
// screen.js is checked in with CRLF; normalise so the slicing below is EOL-agnostic.
const src = fs.readFileSync(SCREEN_JS, 'utf8').replace(/\r\n/g, '\n');

function slice(startRe, endMarker) {
    const start = src.search(startRe);
    assert.ok(start >= 0, `missing ${startRe}`);
    const end = src.indexOf(endMarker, start);
    assert.ok(end > start, `missing end of ${startRe}`);
    return src.slice(start, end + endMarker.length);
}

// _BASE_OPEN_MIDI_* constants + _baseOpenStringMidis + the note-name helper.
const helpers = new Function(
    slice(/const _BASE_OPEN_MIDI_BASS4 = /, '\n    }\n') // through _baseOpenStringMidis
    + '\n' + slice(/const _NOTE_NAMES_COMMON = /, ';\n')
    + '\n' + slice(/function _noteNameForFret\(/, '\n    }\n')
    + '\nreturn { _baseOpenStringMidis, _noteNameForFret, _NOTE_NAMES_COMMON };',
)();
const { _baseOpenStringMidis, _noteNameForFret, _NOTE_NAMES_COMMON } = helpers;

const guitar = _baseOpenStringMidis(6, 'Lead');   // E A D G B E
const bass = _baseOpenStringMidis(4, 'Bass');     // E A D G

test('uses the common spelling for each pitch class', () => {
    assert.deepEqual(_NOTE_NAMES_COMMON,
        ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']);
});

test('3rd fret on the low E is G (guitar and bass)', () => {
    assert.equal(_noteNameForFret(guitar[0], 3, 0), 'G');
    assert.equal(_noteNameForFret(bass[0], 3, 0), 'G');
});

test('sharps and flats come out as F#, Bb, C#, Eb, Ab', () => {
    assert.equal(_noteNameForFret(guitar[0], 2, 0), 'F#'); // E string fret 2
    assert.equal(_noteNameForFret(guitar[1], 1, 0), 'Bb'); // A string fret 1
    assert.equal(_noteNameForFret(guitar[1], 4, 0), 'C#'); // A string fret 4
    assert.equal(_noteNameForFret(guitar[2], 1, 0), 'Eb'); // D string fret 1
    assert.equal(_noteNameForFret(guitar[3], 1, 0), 'Ab'); // G string fret 1
});

test('open strings name the string; octaves are not shown', () => {
    assert.deepEqual(guitar.map((m) => _noteNameForFret(m, 0, 0)), ['E', 'A', 'D', 'G', 'B', 'E']);
    assert.equal(_noteNameForFret(guitar[0], 12, 0), 'E');
});

test('6-string bass uses B E A D G C, the standard the GP importer offsets against', () => {
    const bass6 = _baseOpenStringMidis(6, 'Bass');
    assert.deepEqual(bass6.map((m) => _noteNameForFret(m, 0, 0)), ['B', 'E', 'A', 'D', 'G', 'C']);
    assert.equal(_noteNameForFret(bass6[0], 3, 0), 'D');   // low B, fret 3
    // Same pitches as core's importer (high→low there) and tuner profile.
    const gp = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'gp2rs.py'), 'utf8');
    const gpBass = gp.match(/STANDARD_TUNING_BASS = \[([\d, ]+)\]/);
    assert.ok(gpBass, 'STANDARD_TUNING_BASS present in lib/gp2rs.py');
    assert.deepEqual(bass6, gpBass[1].split(',').map(Number).reverse());
    // A 6-string guitar is unchanged.
    assert.deepEqual(_baseOpenStringMidis(6, 'Lead'), [40, 45, 50, 55, 59, 64]);
});

test('tuning offsets shift the name (Eb standard, drop D)', () => {
    assert.equal(_noteNameForFret(guitar[0] - 1, 0, 0), 'Eb');
    assert.equal(_noteNameForFret(guitar[0] - 2, 0, 0), 'D');
    assert.equal(_noteNameForFret(guitar[0] - 2, 5, 0), 'G');
});

test('capo raises open strings only; chart frets already count from the nut', () => {
    assert.equal(_noteNameForFret(guitar[0], 0, 2), 'F#'); // open = capo 2
    assert.equal(_noteNameForFret(guitar[0], 3, 2), 'G');  // fret 3 is still G
});

// Slide helpers: the label names the fret the gliding gem is over.
const slide = new Function(
    slice(/function slideTrailEnd\(/, '\n    }\n')
    + '\n' + slice(/function slideEaseW\(/, '\n    }\n')
    + '\n' + slice(/function slideFretNow\(/, '\n    }\n')
    + '\nreturn { slideFretNow };',
)();

test('during a slide the name follows the gem to the new fret', () => {
    const n = { t: 10, f: 3, sus: 1, sl: 5 };                 // low E, 3 → 5 (G → A)
    assert.equal(slide.slideFretNow(n, 9.5), 3);              // not yet played
    assert.equal(slide.slideFretNow(n, 10), 3);               // onset
    assert.equal(slide.slideFretNow(n, 11), 5);               // slide finished
    assert.equal(slide.slideFretNow(n, 12), 5);               // lingering after it
    assert.equal(_noteNameForFret(guitar[0], slide.slideFretNow(n, 11), 0), 'A');
    const mid = slide.slideFretNow(n, 10.6);
    assert.ok(mid >= 3 && mid <= 5, `mid-slide fret ${mid} stays between start and end`);
});

test('notes without a slide keep their own fret', () => {
    assert.equal(slide.slideFretNow({ t: 0, f: 7, sus: 2 }, 1), 7);
    assert.equal(slide.slideFretNow({ t: 0, f: 0, sus: 2, sl: 2 }, 1), 0); // open: no glide
});

test('the label uses the sliding fret only while the gem is gliding', () => {
    assert.match(src, /const nameFret = slideXNow !== 0 \? slideFretNow\(n, now, slideSt\) : n\.f;/);
});

// String filter: the slot mapping comes from core's highway colors API only.
const slots = new Function('window',
    slice(/const NOTE_NAME_SLOT_KEYS = /, ';\n')
    + '\n' + slice(/function _noteNameSlotKeysForChart\(/, '\n    }\n')
    + '\nreturn { NOTE_NAME_SLOT_KEYS, _noteNameSlotKeysForChart };');

test('string slots come straight from core\'s keysForChart', () => {
    const seen = [];
    const api = { keysForChart(sc, isBass) { seen.push([sc, isBass]); return ['low7', 'lowE', 'A', 'D', 'G']; } };
    const { _noteNameSlotKeysForChart } = slots({ feedBack: { highwayColors: api } });
    assert.deepEqual(_noteNameSlotKeysForChart(5, true), ['low7', 'lowE', 'A', 'D', 'G']);
    assert.deepEqual(seen, [[5, true]]);
});

test('without core\'s colors API the filter names every string', () => {
    assert.equal(slots({ feedBack: {} })._noteNameSlotKeysForChart(4, true), null);
    assert.equal(slots(undefined)._noteNameSlotKeysForChart(6, false), null);
    const throwing = { feedBack: { highwayColors: { keysForChart() { throw new Error('x'); } } } };
    assert.equal(slots(throwing)._noteNameSlotKeysForChart(6, false), null);
    // null slots → every string on, unless the selection is empty (then none).
    assert.match(src, /new Set\(String\(noteNamesStrings \|\| ''\)\.split\(','\)\.filter\(Boolean\)\)/);
    assert.match(src, /_noteNameStringOn\.push\(slots \? enabled\.has\(slots\[i\]\) : enabled\.size > 0\);/);
});

test('the setting uses exactly core\'s named string slots', () => {
    const core = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'js', 'highway-colors.js'), 'utf8');
    const coreKeys = [...core.matchAll(/\{ key: '([A-Za-z0-9]+)', label:/g)].map((m) => m[1]);
    const { NOTE_NAME_SLOT_KEYS } = slots({});
    assert.deepEqual([...NOTE_NAME_SLOT_KEYS].sort(), [...coreKeys].sort());
});

test('long-notes-only and string filters gate the label', () => {
    assert.match(src, /&& _noteNameStringOn\[s\]\n\s*&& \(!noteNamesLongOnly \|\| \(n\.sus \|\| 0\) >= noteNamesMinSustain \|\| _noteNameRuns\.has\(n\)\)\) \{/);
    assert.match(src, /noteNamesLongOnly: false, noteNamesMinSustain: 0\.2, noteNamesStrings: NOTE_NAME_SLOT_KEYS\.join\(','\)/);
    assert.match(src, /'noteNamesVisible', 'noteNamesLongOnly',/);
    // Minimum length is clamped to 0.05..2 s; unknown string keys are dropped.
    assert.match(src, /key === 'noteNamesMinSustain'[\s\S]{0,200}Math\.max\(0\.05, Math\.min\(2, n\)\)/);
    assert.match(src, /key === 'noteNamesStrings'[\s\S]{0,400}NOTE_NAME_SLOT_KEYS\.filter\(\(k\) => want\.has\(k\)\)/);
    for (const k of ['noteNamesLongOnly', 'noteNamesMinSustain', 'noteNamesStrings']) {
        assert.match(src, new RegExp(`changedKey === '${k}'`));
        assert.match(src, new RegExp(`${k} = _bgReadSetting\\(panelKey, '${k}'\\)`));
    }
    assert.match(src, /window\.h3dBgSetNoteNamesStrings = /);
    // The per-string flags are recomputed when the string selection changes.
    assert.match(src, /\+ '\|' \+ noteNamesStrings;/);
});

test('note names stay below the bloom threshold so they render crisp, not hazy', () => {
    // Text textures are raw (NoColorSpace) canvas colours, so the bloom high-pass
    // sees the label colour directly. White (1.0) bloomed; keep it under the threshold.
    const hex = src.match(/const NOTE_NAME_HEX = '#([0-9a-fA-F]{6})'/);
    const bloom = src.match(/new UB\.UnrealBloomPass\(new T\.Vector2\([^)]*\), [\d.]+, [\d.]+, ([\d.]+)\)/);
    assert.ok(hex && bloom, 'NOTE_NAME_HEX and the bloom threshold are present');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    assert.ok(lum < Number(bloom[1]) - 0.02, `label luminance ${lum.toFixed(3)} must be below bloom threshold ${bloom[1]}`);
});

test('setting defaults off and is wired like the other per-frame toggles', () => {
    assert.match(src, /const BG_DEFAULTS = \{[^}]*noteNamesVisible: false/);
    assert.match(src, /const _BG_BOOL_KEYS = new Set\(\[[^\]]*'noteNamesVisible'/);
    assert.match(src, /window\.h3dBgSetNoteNamesVisible = \(v\) => _bgWriteGlobal\('noteNamesVisible', !!v\)/);
    assert.match(src, /changedKey === 'noteNamesVisible' \|\|/);
    assert.match(src, /noteNamesVisible = _bgReadSetting\(panelKey, 'noteNamesVisible'\)/);
});

test('labels come from a pool that is reset every frame', () => {
    assert.match(src, /pNoteNameLbl = pool\(lblG,/);
    assert.match(src, /pNoteNameLbl\.reset\(\);/);
});

test('only single notes get a name (chords keep their chord name)', () => {
    assert.match(src, /if \(noteNamesVisible && !fromChord && _noteNameOpenMidi\[s\] !== undefined\n/);
});

test('settings page has the checkbox and mirrors the default', () => {
    const html = fs.readFileSync(SETTINGS_HTML, 'utf8');
    assert.match(html, /id="h3d-note-names-visible"[\s\S]*?window\.h3dBgSetNoteNamesVisible\(this\.checked\)/);
    assert.match(html, /const DEFAULTS = \{[^}]*noteNamesVisible: false/);
    assert.match(html, /localStorage\.getItem\('h3d_bg_noteNamesVisible'\)/);
    assert.match(html, /id="h3d-note-names-long-only"[\s\S]*?h3dBgSetNoteNamesLongOnly\(this\.checked\)/);
    assert.match(html, /id="h3d-note-names-min-sustain" min="0\.05" max="2" step="0\.05"/);
    assert.match(html, /id="h3d-note-names-strings"/);
    // settings.html's DEFAULTS mirror must match the renderer's defaults.
    assert.match(html, /noteNamesLongOnly: false, noteNamesMinSustain: 0\.2, noteNamesStrings: 'lowE,A,D,G,B,highE,low7,low8'/);
});

// "Only notes held at least N s": runs of one repeated note count as long.
const runs = new Function(
    slice(/const NOTE_NAME_RUN_GAP = /, ';\n')
    + '\n' + slice(/function _noteNameRepeatedRuns\(/, '\n    }\n')
    + '\nreturn { NOTE_NAME_RUN_GAP, _noteNameRepeatedRuns };',
)();

test('a gallop on one note counts as long; each note in it gets a name', () => {
    // Heaven-and-Hell style: F# on the low E (fret 2), 16ths at ~0.11 s, 0.05 s each.
    const gallop = [0, 0.11, 0.22, 0.33].map((t) => ({ t, s: 0, f: 2, sus: 0 }));
    const set = runs._noteNameRepeatedRuns(gallop, 0.2, runs.NOTE_NAME_RUN_GAP);
    assert.equal(set.size, 4);
    for (const n of gallop) assert.ok(set.has(n));
});

test('a lone short note, or a run shorter than the minimum, stays unnamed', () => {
    const lone = [{ t: 0, s: 0, f: 2, sus: 0 }, { t: 0.1, s: 0, f: 3, sus: 0 }, { t: 0.2, s: 1, f: 3, sus: 0 }];
    assert.equal(runs._noteNameRepeatedRuns(lone, 0.2, 0.5).size, 0);
    const pair = [{ t: 0, s: 0, f: 2, sus: 0 }, { t: 0.1, s: 0, f: 2, sus: 0.05 }];   // lasts 0.15 s
    assert.equal(runs._noteNameRepeatedRuns(pair, 0.2, 0.5).size, 0);
    assert.equal(runs._noteNameRepeatedRuns(pair, 0.15, 0.5).size, 2, 'long enough at 0.15 s');
});

test('another note, another string or a rest ends the run', () => {
    const a = { t: 0, s: 0, f: 2 }, b = { t: 0.1, s: 0, f: 2 };
    const other = { t: 0.2, s: 0, f: 4 };                   // different fret breaks it
    const c = { t: 0.3, s: 0, f: 2 }, d = { t: 1.0, s: 0, f: 2 }, e = { t: 1.1, s: 0, f: 2 };
    const set = runs._noteNameRepeatedRuns([a, b, other, c, d, e], 0.1, 0.5);
    assert.ok(set.has(a) && set.has(b), 'first pair (0.1 s) qualifies at 0.1');
    assert.ok(!set.has(other));
    assert.ok(!set.has(c), 'c is alone: d comes 0.7 s later (a rest)');
    assert.ok(set.has(d) && set.has(e));
    const strings = [{ t: 0, s: 0, f: 2 }, { t: 0.1, s: 1, f: 2 }, { t: 0.2, s: 0, f: 2 }];
    assert.equal(runs._noteNameRepeatedRuns(strings, 0.05, 0.5).size, 0, 'same fret, other string: not a run');
});

test('garbage input gives no runs', () => {
    assert.equal(runs._noteNameRepeatedRuns(null, 0.2).size, 0);
    assert.equal(runs._noteNameRepeatedRuns([{ t: 0, s: 0, f: 1 }], 0.2).size, 0);
    assert.equal(runs._noteNameRepeatedRuns([{ t: NaN, s: 0, f: 1 }, { t: 0.1, s: 0, f: 1 }], 0).size, 0);
});

test('the filter consults the runs, recomputed per chart, not per frame', () => {
    assert.match(src, /\(!noteNamesLongOnly \|\| \(n\.sus \|\| 0\) >= noteNamesMinSustain \|\| _noteNameRuns\.has\(n\)\)/);
    assert.match(src, /bundle\.notes !== _noteNameRunsFor \|\| noteNamesMinSustain !== _noteNameRunsMin/);
});
