// Coaching feedback schema/builder tests — the contract is only real if it's
// verified. Pure builder, so we feed synthetic note_detect judgments and assert
// the PlayFeedback shape + the two load-bearing fields (faultVerdict per
// mistake, systematic-vs-random per hotspot).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPlayFeedback, FAILURE_TYPES, FAULT_VERDICTS, renderFeedbackHtml } = require('../coaching.js');

// Judgment shaped like note_detect's: { note:{s,f}, noteTime, expectedMidi,
// detectedMidi, confidence, hit, timingState, pitchState, timingError(ms),
// pitchError(cents) }.
function hit(t) {
    return { hit: true, note: { s: 1, f: 5 }, noteTime: t, expectedMidi: 38, detectedMidi: 38,
        confidence: 0.8, timingState: 'OK', pitchState: 'OK', timingError: 5, pitchError: 3 };
}
function lateMiss(t, te) {
    return { hit: false, note: { s: 1, f: 5 }, noteTime: t, expectedMidi: 38, detectedMidi: 38,
        confidence: 0.5, timingState: 'LATE', pitchState: 'OK', timingError: te, pitchError: 4 };
}
function noDetMiss(t) {
    return { hit: false, note: { s: 0, f: 3 }, noteTime: t, expectedMidi: 31, detectedMidi: null,
        confidence: 0, timingState: null, pitchState: null, timingError: null, pitchError: null };
}

function muteFailMiss(t) {
    // note_detect flagged the open string ringing in place of a fretted note.
    return { hit: false, note: { s: 1, f: 2 }, noteTime: t, expectedMidi: 35, detectedMidi: null,
        confidence: 0, timingState: null, pitchState: null, timingError: null, pitchError: null, muteFail: true };
}

function presentDropMiss(t) {
    // no_detection, but note_detect MEASURED the note present in the audio:
    // the player played it, the detector dropped it.
    return { hit: false, note: { s: 0, f: 3 }, noteTime: t, expectedMidi: 31, detectedMidi: null,
        confidence: 0, timingState: null, pitchState: null, timingError: null, pitchError: null, notePresent: true };
}

function sample() {
    const js = [];
    for (let i = 0; i < 20; i++) js.push(hit(i * 2));                 // 20 hits, t=0..38
    // Late cluster at non-hit timestamps (hits are at even t; 20 would collide
    // with hit(20) for the same note, which can't happen in one real pass).
    [ [19.5, 118], [20.5, 122], [21, 120], [21.5, 124] ].forEach(([t, te]) => js.push(lateMiss(t, te))); // systematic late
    [30, 30.5, 31].forEach(t => js.push(noDetMiss(t)));              // no-detection cluster
    return js;
}

test('builds the PlayFeedback shape with the documented top-level keys', () => {
    const fb = buildPlayFeedback(sample(), { song: 'Gasoline', arrangement: 'bass' });
    assert.equal(fb.schema, 'coaching.play_feedback.v1');
    assert.ok(fb.session && Array.isArray(fb.mistakes) && Array.isArray(fb.hotspots));
    assert.equal(fb.mistakes.length, 7);                            // 4 late + 3 no-detection
    // session score = hits / total
    assert.equal(fb.session.score, Math.round((20 / 27) * 1000) / 1000);
    assert.equal(fb.session.song, 'Gasoline');
});

test('every mistake carries the atom: id, chart anchor, failureType, faultVerdict', () => {
    const fb = buildPlayFeedback(sample(), {});
    for (const m of fb.mistakes) {
        assert.match(m.id, /^m\d+$/);
        assert.ok(m.chart && typeof m.chart.t === 'number' && m.chart.expectedMidi != null);
        assert.ok(FAILURE_TYPES.includes(m.failureType));
        assert.ok(FAULT_VERDICTS.includes(m.faultVerdict));
    }
    const late = fb.mistakes.find(m => m.failureType === 'late');
    const noDet = fb.mistakes.find(m => m.failureType === 'no_detection');
    assert.equal(late.faultVerdict, 'player_error', 'a detection that fired but was late = player_error');
    assert.equal(noDet.faultVerdict, 'detector_suspect', 'no detection = detector_suspect (route to harness)');
    assert.equal(noDet.detected, null);
});

test('mute_fail judgment → failureType mute_fail, player_error (not detector_suspect)', () => {
    const fb = buildPlayFeedback([hit(0), muteFailMiss(2)], {});
    const mf = fb.mistakes.find(m => m.failureType === 'mute_fail');
    assert.ok(mf, 'a mute_fail mistake is classified');
    assert.equal(mf.faultVerdict, 'player_error', 'open string rang instead of fretting = the player, not the detector');
    assert.equal(mf.detected, null);
});

test('notePresent promotes a no_detection miss to confirmed_detector_bug (not a player/drill target)', () => {
    const fb = buildPlayFeedback([hit(0), presentDropMiss(2), presentDropMiss(4), noDetMiss(6)], {});
    const present = fb.mistakes.find(m => m.notePresent);
    assert.equal(present.failureType, 'no_detection');
    assert.equal(present.faultVerdict, 'confirmed_detector_bug', 'measured present → confirmed tool miss, not a guess');
    // The ambiguous no_detection (no presence signal) stays detector_suspect.
    const ambiguous = fb.mistakes.find(m => m.failureType === 'no_detection' && !m.notePresent);
    assert.equal(ambiguous.faultVerdict, 'detector_suspect');
    // Confirmed tool misses are counted as detector misses and surfaced distinctly…
    assert.equal(fb.session.faultSplit.confirmedToolMisses, 2);
    assert.equal(fb.session.faultSplit.player, 0, 'a note the tool dropped is never a player miss');
    // …and never become a player hotspot to drill.
    assert.equal(fb.hotspots.length, 0, 'confirmed tool misses do not create player drill targets');
});

test('a note missed then nailed on a replay (seek-back) scores as a HIT, not a hotspot', () => {
    // note_detect re-judges replayed notes; coaching keeps the LATEST verdict.
    const sameNote = { s: 0, f: 3, t: 2 };
    const miss = { hit: false, note: { s: 0, f: 3 }, noteTime: 2, expectedMidi: 31, detectedMidi: null,
        confidence: 0, timingState: null, pitchState: null };
    const hitOnReplay = hit(2); hitOnReplay.note = { s: 0, f: 3 }; hitOnReplay.expectedMidi = 31; hitOnReplay.detectedMidi = 31;
    const fb = buildPlayFeedback([miss, hitOnReplay], {});
    assert.equal(fb.mistakes.length, 0, 'the replay hit supersedes the earlier miss');
    assert.equal(fb.session.faultSplit.player, 0);
    void sameNote;
});

test('latest-verdict wins both ways: a hit then a later miss scores as a miss', () => {
    const earlyHit = hit(5); earlyHit.note = { s: 1, f: 5 }; earlyHit.expectedMidi = 38;
    const laterMiss = { hit: false, note: { s: 1, f: 5 }, noteTime: 5, expectedMidi: 38, detectedMidi: 38,
        confidence: 0.5, timingState: 'LATE', pitchState: 'OK', timingError: 120, pitchError: 2 };
    const fb = buildPlayFeedback([earlyHit, laterMiss], {});
    assert.equal(fb.mistakes.length, 1, 'the later miss is the verdict that stands');
    assert.equal(fb.mistakes[0].failureType, 'late');
});

function silentMiss(t) {
    // no_detection AND note_detect measured the input silent → player stopped.
    return { hit: false, note: { s: 0, f: 3 }, noteTime: t, expectedMidi: 31, detectedMidi: null,
        confidence: 0, timingState: null, pitchState: null, silent: true };
}

test('a silent no_detection run is flagged stopped (you stopped — not the tool)', () => {
    const fb = buildPlayFeedback([hit(0), silentMiss(30), silentMiss(31), silentMiss(32)], {});
    assert.ok(fb.unheardSpots.length >= 1, 'a clustered unheard run is found');
    assert.equal(fb.unheardSpots[0].stopped, true, 'measured-silent run → confident "you stopped"');
    assert.ok(fb.mistakes.some(m => m.silent === true), 'the silent flag rides the mistake atom');
});

test('an energetic no_detection run is NOT flagged stopped (blind-spot stays hedged)', () => {
    const fb = buildPlayFeedback([hit(0), noDetMiss(30), noDetMiss(31), noDetMiss(32)], {});
    assert.ok(fb.unheardSpots.length >= 1);
    assert.ok(!fb.unheardSpots[0].stopped, 'no silence signal → ambiguous blind spot, not "stopped"');
});

test('systematic late cluster → one hotspot, signal=systematic, drill params present', () => {
    const fb = buildPlayFeedback(sample(), { song: 'Gasoline', arrangement: 'bass' });
    const late = fb.hotspots.find(h => h.bounds.startSec >= 19 && h.bounds.startSec <= 21);
    assert.ok(late, 'late cluster surfaced as a hotspot');
    assert.equal(late.mistakeIds.length, 4);
    assert.equal(late.signal.kind, 'systematic');                  // consistent +120 ms skew
    assert.ok(late.signal.medianTimingMs >= 118 && late.signal.medianTimingMs <= 124);
    assert.equal(late.drill.speedMul, 0.7);
    assert.equal(late.drill.goal, 0.85);
    // The drill loop is the raw musical span — note_detect.startDrill owns
    // the audible lead-in + first-note runway (no coaching-side run-in, which
    // used to double-stack with note_detect's own lead-in).
    assert.equal(late.drill.loopA, late.bounds.startSec, 'drill loopA = cluster start (no coaching run-in)');
    assert.equal(late.drill.loopB, late.bounds.endSec, 'drill loopB = cluster end (no coaching run-out)');
    assert.ok(late.severity > 0);
    assert.match(late.key, /Gasoline\|bass\|/);
});

test('no-detection cluster surfaces as an UNHEARD spot, never a player hotspot', () => {
    // Player hotspots cluster only player faults (late/early/sharp/flat). A run
    // of unheard notes must NOT contaminate those — but it DOES surface as a
    // distinct `unheardSpots` entry: an honest drill target with the caveat
    // that it may be the detector's low-string blind spot, not a flub.
    const fb = buildPlayFeedback(sample(), {});
    const inHotspots = fb.hotspots.find(h => h.bounds.startSec >= 29 && h.bounds.startSec <= 31);
    assert.equal(inHotspots, undefined, 'no-detection cluster must NOT become a player hotspot');
    const unheard = fb.unheardSpots.find(h => h.bounds.startSec >= 29 && h.bounds.startSec <= 31);
    assert.ok(unheard, 'no-detection cluster surfaces as an unheard spot');
    assert.equal(unheard.mistakeIds.length, 3, 'all three unheard notes clustered');
    // Drillable on raw bounds, with the gentler goal (detector may under-score).
    assert.ok(unheard.drill && unheard.drill.loopB > unheard.drill.loopA, 'unheard spot is drillable');
    assert.equal(unheard.drill.goal, 0.6, 'gentler goal for an unheard run');
    // Still tracked as detector_suspect mistakes for the breakdown / coverage.
    const ndMistakes = fb.mistakes.filter(m => m.faultVerdict === 'detector_suspect');
    assert.equal(ndMistakes.length, 3, 'detector-suspect misses still tracked');
});

test('hotspots reference mistakes by id, not nested copies', () => {
    const fb = buildPlayFeedback(sample(), {});
    for (const h of fb.hotspots) {
        for (const id of h.mistakeIds) {
            assert.equal(typeof id, 'string');
            assert.ok(fb.mistakes.some(m => m.id === id), 'id resolves to a real mistake');
        }
    }
});

test('scattered timing → random (not systematic)', () => {
    const js = [];
    for (let i = 0; i < 10; i++) js.push(hit(i));
    [[20, -90], [20.5, 110], [21, -40], [21.5, 130]].forEach(([t, te]) => js.push(lateMiss(t, te))); // big scatter
    const fb = buildPlayFeedback(js, {});
    const h = fb.hotspots[0];
    assert.ok(h);
    assert.equal(h.signal.kind, 'random');
});

test('a poor all-unheard play renders drillable Unregistered runs, never "nice"', () => {
    // The real bass case: the player flubbed a section and EVERY miss came back
    // no_detection (zero player faults). Old behaviour: no hotspots → "nice"/
    // consistency-gap → no coaching. New: an honest, drillable Unregistered run.
    const js = [];
    for (let i = 0; i < 12; i++) js.push(hit(i));                  // some clean hits
    [40, 40.5, 41, 41.5].forEach(t => js.push(noDetMiss(t)));     // a flubbed run, all unheard
    const fb = buildPlayFeedback(js, { song: 'Mexico', arrangement: 'bass' });
    assert.equal(fb.hotspots.length, 0, 'no player hotspots (no late/early/sharp/flat)');
    assert.equal(fb.unheardSpots.length, 1, 'the unheard run surfaces as a spot');
    const html = renderFeedbackHtml(fb);
    assert.match(html, /Unregistered runs/, 'shows the unheard section');
    assert.match(html, /Drill this run/, 'with a drill button');
    assert.doesNotMatch(html, /nice/i, 'must NOT say "nice" on a flubbed play');
});

test('empty / all-hits input is safe', () => {
    assert.equal(buildPlayFeedback([], {}).mistakes.length, 0);
    const fb = buildPlayFeedback([hit(0), hit(1)], {});
    assert.equal(fb.hotspots.length, 0);
    assert.equal(fb.session.score, 1);
});
