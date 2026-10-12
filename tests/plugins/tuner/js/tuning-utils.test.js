'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// tuning-utils.js targets browsers (uses window global). Provide a stub so
// the IIFE's final line `window._tunerUtils = {...}` writes into this object.
const window = {};
global.window = window;
require('../../../../plugins/tuner/utils/tuning-utils.js');
const { freqToMidi, midiToFreq, midiToNote, offsetsToFreqs, getTuningName, preferFlats } = window._tunerUtils;

// ── preferFlats ──────────────────────────────────────────────────────────────

test('preferFlats: returns true for "Eb Standard"', () => {
    assert.equal(preferFlats('Eb Standard'), true);
});

test('preferFlats: returns true for "Bb Standard"', () => {
    assert.equal(preferFlats('Bb Standard'), true);
});

test('preferFlats: returns true for "Ab Standard"', () => {
    assert.equal(preferFlats('Ab Standard'), true);
});

test('preferFlats: returns true for "Db Standard"', () => {
    assert.equal(preferFlats('Db Standard'), true);
});

test('preferFlats: returns false for "Standard"', () => {
    assert.equal(preferFlats('Standard'), false);
});

test('preferFlats: returns false for "Drop D"', () => {
    assert.equal(preferFlats('Drop D'), false);
});

test('preferFlats: returns false for "D Standard"', () => {
    assert.equal(preferFlats('D Standard'), false);
});

test('preferFlats: returns false for "Drop C#"', () => {
    assert.equal(preferFlats('Drop C#'), false);
});

test('preferFlats: returns false for null', () => {
    assert.equal(preferFlats(null), false);
});

test('preferFlats: returns false for undefined', () => {
    assert.equal(preferFlats(undefined), false);
});

test('preferFlats: returns false for empty string', () => {
    assert.equal(preferFlats(''), false);
});

// ── midiToNote (sharp names) ──────────────────────────────────────────────────

test('midiToNote: A4 (midi 69) is "A" regardless of useFlats', () => {
    assert.equal(midiToNote(69, false), 'A');
    assert.equal(midiToNote(69, true),  'A');
});

test('midiToNote: C4 (midi 60) is "C" regardless of useFlats', () => {
    assert.equal(midiToNote(60, false), 'C');
    assert.equal(midiToNote(60, true),  'C');
});

test('midiToNote: midi 61 is "C#" with sharps', () => {
    assert.equal(midiToNote(61, false), 'C#');
});

test('midiToNote: midi 61 is "Db" with flats', () => {
    assert.equal(midiToNote(61, true), 'Db');
});

test('midiToNote: midi 63 is "D#" with sharps', () => {
    assert.equal(midiToNote(63, false), 'D#');
});

test('midiToNote: midi 63 is "Eb" with flats', () => {
    assert.equal(midiToNote(63, true), 'Eb');
});

test('midiToNote: midi 66 is "F#" with sharps', () => {
    assert.equal(midiToNote(66, false), 'F#');
});

test('midiToNote: midi 66 is "Gb" with flats', () => {
    assert.equal(midiToNote(66, true), 'Gb');
});

test('midiToNote: midi 68 is "G#" with sharps', () => {
    assert.equal(midiToNote(68, false), 'G#');
});

test('midiToNote: midi 68 is "Ab" with flats', () => {
    assert.equal(midiToNote(68, true), 'Ab');
});

test('midiToNote: midi 70 is "A#" with sharps', () => {
    assert.equal(midiToNote(70, false), 'A#');
});

test('midiToNote: midi 70 is "Bb" with flats', () => {
    assert.equal(midiToNote(70, true), 'Bb');
});

test('midiToNote: natural notes are identical regardless of useFlats (E)', () => {
    // E2 = midi 40
    assert.equal(midiToNote(40, false), midiToNote(40, true));
});

test('midiToNote: natural notes are identical regardless of useFlats (B)', () => {
    // B3 = midi 59
    assert.equal(midiToNote(59, false), midiToNote(59, true));
});

test('midiToNote: works with fractional midi (rounds to nearest semitone)', () => {
    // 60.4 rounds to 60 → C
    assert.equal(midiToNote(60.4, false), 'C');
    // 60.6 rounds to 61 → C#
    assert.equal(midiToNote(60.6, false), 'C#');
});

test('midiToNote: handles midi values below C4 (wraps correctly)', () => {
    // midi 48 = C3
    assert.equal(midiToNote(48, false), 'C');
    // midi 47 = B2
    assert.equal(midiToNote(47, false), 'B');
});

// ── freqToMidi / midiToFreq round-trip ───────────────────────────────────────

test('freqToMidi(440) equals 69', () => {
    assert.ok(Math.abs(freqToMidi(440) - 69) < 0.001);
});

test('midiToFreq(69) equals 440 Hz', () => {
    assert.ok(Math.abs(midiToFreq(69) - 440) < 0.01);
});

test('freqToMidi / midiToFreq round-trip within 0.01 Hz', () => {
    for (const freq of [82.41, 110, 146.83, 196, 246.94, 329.63]) {
        const back = midiToFreq(freqToMidi(freq));
        assert.ok(Math.abs(back - freq) < 0.01, `round-trip failed for ${freq} Hz`);
    }
});

// ── offsetsToFreqs ────────────────────────────────────────────────────────────

test('offsetsToFreqs: all-zero 6-string is E Standard open strings', () => {
    const freqs = offsetsToFreqs([0, 0, 0, 0, 0, 0], false);
    // E2 A2 D3 G3 B3 E4 = 82.41 110 146.83 196 246.94 329.63
    const expected = [82.41, 110.00, 146.83, 196.00, 246.94, 329.63];
    freqs.forEach((f, i) => assert.ok(Math.abs(f - expected[i]) < 0.5, `string ${i}: ${f} vs ${expected[i]}`));
});

test('offsetsToFreqs: -1 offset on all strings gives Eb Standard', () => {
    const freqs = offsetsToFreqs([-1, -1, -1, -1, -1, -1], false);
    const eStandard = offsetsToFreqs([0, 0, 0, 0, 0, 0], false);
    // Each string should be one semitone below E Standard
    freqs.forEach((f, i) => {
        const ratio = eStandard[i] / f;
        assert.ok(Math.abs(ratio - Math.pow(2, 1/12)) < 0.01, `string ${i} ratio off`);
    });
});

test('offsetsToFreqs: all-zero 4-string bass is E Standard bass', () => {
    const freqs = offsetsToFreqs([0, 0, 0, 0], true);
    // E1 A1 D2 G2 = 41.20 55.00 73.42 98.00
    const expected = [41.20, 55.00, 73.42, 98.00];
    freqs.forEach((f, i) => assert.ok(Math.abs(f - expected[i]) < 0.5, `string ${i}: ${f} vs ${expected[i]}`));
});

test('offsetsToFreqs: all-zero 6-string bass is B E A D G C', () => {
    const freqs = offsetsToFreqs([0, 0, 0, 0, 0, 0], true);
    // B0 E1 A1 D2 G2 C3 = 30.87 41.20 55.00 73.42 98.00 130.81
    const expected = [30.87, 41.20, 55.00, 73.42, 98.00, 130.81];
    freqs.forEach((f, i) => assert.ok(Math.abs(f - expected[i]) < 0.5, `string ${i}: ${f} vs ${expected[i]}`));
});

// ── getTuningName ─────────────────────────────────────────────────────────────

test('getTuningName: all zeros → "E Standard"', () => {
    assert.equal(getTuningName([0, 0, 0, 0, 0, 0]), 'E Standard');
});

test('getTuningName: all -1 → "Eb Standard"', () => {
    assert.equal(getTuningName([-1, -1, -1, -1, -1, -1]), 'Eb Standard');
});

test('getTuningName: Drop D pattern → "Drop D"', () => {
    assert.equal(getTuningName([-2, 0, 0, 0, 0, 0]), 'Drop D');
});

test('getTuningName: empty → "Unknown"', () => {
    assert.equal(getTuningName([]), 'Unknown');
});

test('getTuningName: null → "Unknown"', () => {
    assert.equal(getTuningName(null), 'Unknown');
});
