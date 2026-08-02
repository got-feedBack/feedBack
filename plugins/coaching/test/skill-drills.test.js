// Skill-drill bones: the practice taxonomy (failure → skill → game), the
// hotspot → "drill this <game>" resolver, and the skill-drill rep/streak engine.
// See docs/TEACHING_NARRATIVE.md.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const sd = require('../coaching.js');
const { buildPlayFeedback } = require('../coaching.js');

// ── Taxonomy ──────────────────────────────────────────────────────────
test('practiceForFailure: every live failure type maps to a skill + cue', () => {
    for (const ft of ['mute_fail', 'late', 'early', 'sharp', 'flat', 'no_detection']) {
        const p = sd.practiceForFailure(ft);
        assert.ok(p, `${ft} has a practice entry`);
        assert.ok(p.skill && typeof p.skill === 'string');
        assert.ok(p.cue && typeof p.cue === 'string');
    }
    assert.equal(sd.practiceForFailure('nonsense'), null);
});

test('practiceForFailure: mute_fail → muting + a real game; no_detection → cue only', () => {
    assert.equal(sd.practiceForFailure('mute_fail').skill, 'muting');
    assert.equal(sd.practiceForFailure('mute_fail').gameId, 'mute_master');
    assert.equal(sd.practiceForFailure('late').skill, 'timing');
    // no_detection is ambiguous (flub vs detector blind spot) → no game yet.
    assert.equal(sd.practiceForFailure('no_detection').gameId, null);
});

test('dominantFailure: the most common failure across the cluster wins', () => {
    const ms = [{ failureType: 'late' }, { failureType: 'mute_fail' }, { failureType: 'late' }];
    assert.equal(sd.dominantFailure(ms), 'late');
    assert.equal(sd.dominantFailure([]), null);
});

test('FOUNDATIONAL_DRILLS: failure-agnostic warm-ups (trains: []), each with a cue', () => {
    assert.ok(Array.isArray(sd.FOUNDATIONAL_DRILLS) && sd.FOUNDATIONAL_DRILLS.length >= 3);
    for (const d of sd.FOUNDATIONAL_DRILLS) {
        assert.ok(d.id && d.skill && d.cue);
        assert.deepEqual(d.trains, [], 'foundational drills are not gated behind a failure type');
    }
});

// ── Deep link + hotspot resolver ───────────────────────────────────────
test('deepLinkForGame: carries the game, skill, and the trouble-spot loop', () => {
    const link = sd.deepLinkForGame('mute_master', { failureType: 'mute_fail', loopA: 64.2, loopB: 66.0, song: 'WYOC' });
    assert.match(link, /^#\/plugin-minigames\?/);
    assert.match(link, /game=mute_master/);
    assert.match(link, /skill=mute_fail/);
    assert.match(link, /loopA=64\.20/);
    assert.match(link, /loopB=66\.00/);
});

test('practiceForHotspot: resolves dominant failure → skill + game + deep link', () => {
    const hotspot = {
        mistakeIds: ['m1', 'm2', 'm3'],
        bounds: { startSec: 64.2, endSec: 66.0 },
        song: 'WYOC',
    };
    const byId = {
        m1: { id: 'm1', failureType: 'mute_fail' },
        m2: { id: 'm2', failureType: 'mute_fail' },
        m3: { id: 'm3', failureType: 'late' },
    };
    const p = sd.practiceForHotspot(hotspot, byId);
    assert.equal(p.failureType, 'mute_fail');
    assert.equal(p.skill, 'muting');
    assert.equal(p.gameId, 'mute_master');
    assert.match(p.deepLink, /game=mute_master.*loopA=64\.20/);
});

test('practiceForHotspot: a skill with no game yet yields a cue but null deepLink', () => {
    const hotspot = { mistakeIds: ['m1'], bounds: { startSec: 10, endSec: 12 } };
    const byId = { m1: { id: 'm1', failureType: 'no_detection' } };
    const p = sd.practiceForHotspot(hotspot, byId);
    assert.equal(p.skill, 'clarity');
    assert.equal(p.gameId, null);
    assert.equal(p.deepLink, null);
});

// ── Judgment → drill event (what a drill game feeds the engine) ────────
test('classifyFailureForDrill: maps a note_detect judgment to { hit, failureType }', () => {
    assert.deepEqual(sd.classifyFailureForDrill({ hit: true }), { hit: true, failureType: null });
    assert.deepEqual(sd.classifyFailureForDrill({ hit: false, muteFail: true, detectedMidi: null }), { hit: false, failureType: 'mute_fail' });
    assert.deepEqual(sd.classifyFailureForDrill({ hit: false, detectedMidi: 45, timingState: 'LATE' }), { hit: false, failureType: 'late' });
    assert.deepEqual(sd.classifyFailureForDrill({ hit: false, detectedMidi: null }), { hit: false, failureType: 'no_detection' });
});

// ── Skill-drill engine (game mechanics) ────────────────────────────────
test('skillDrill: clean reps build a streak; the targeted failure breaks it; pass at goal', () => {
    let s = sd.createSkillDrill({ failureType: 'mute_fail', goalStreak: 3 });
    // a hit and a DIFFERENT-failure miss both count as clean for THIS skill
    s = sd.skillDrillStep(s, { hit: true });
    s = sd.skillDrillStep(s, { hit: false, failureType: 'late' });
    let v = sd.skillDrillView(s);
    assert.equal(v.streak, 2);
    assert.equal(v.passed, false);
    // the targeted failure resets the streak
    s = sd.skillDrillStep(s, { hit: false, failureType: 'mute_fail' });
    assert.equal(sd.skillDrillView(s).streak, 0);
    assert.equal(sd.skillDrillView(s).reps, 3);
    // three clean in a row → pass
    s = sd.skillDrillStep(s, { hit: true });
    s = sd.skillDrillStep(s, { hit: true });
    s = sd.skillDrillStep(s, { hit: true });
    v = sd.skillDrillView(s);
    assert.equal(v.streak, 3);
    assert.equal(v.passed, true);
    assert.equal(v.bestStreak, 3);
});

test('skillDrill: an ambiguous no_detection is NOT a rep for another skill', () => {
    let s = sd.createSkillDrill({ failureType: 'mute_fail', goalStreak: 3 });
    s = sd.skillDrillStep(s, { hit: false, failureType: 'no_detection' });
    const v = sd.skillDrillView(s);
    assert.equal(v.reps, 0, 'a detector blind-spot miss cannot tank a muting drill');
});

test('skillDrill: a no_detection drill DOES count no_detection reps', () => {
    let s = sd.createSkillDrill({ failureType: 'no_detection', goalStreak: 2 });
    s = sd.skillDrillStep(s, { hit: false, failureType: 'no_detection' }); // a fail
    s = sd.skillDrillStep(s, { hit: true });
    const v = sd.skillDrillView(s);
    assert.equal(v.reps, 2);
    assert.equal(v.streak, 1);
});

// ── End-to-end: buildPlayFeedback attaches practice to hotspots ─────────
test('buildPlayFeedback: a player-fault hotspot carries a practice recommendation', () => {
    const js = [];
    for (let i = 0; i < 12; i++) js.push({ hit: true, note: { s: 1, f: 5 }, noteTime: i, expectedMidi: 38, detectedMidi: 38, timingState: 'OK', pitchState: 'OK', timingError: 3, pitchError: 2 });
    // two late misses a phrase apart → one hotspot, dominant failure = late
    [20, 21].forEach(t => js.push({ hit: false, note: { s: 1, f: 5 }, noteTime: t, expectedMidi: 38, detectedMidi: 38, timingState: 'LATE', pitchState: 'OK', timingError: 120, pitchError: 2 }));
    const fb = buildPlayFeedback(js, { song: 'WYOC', arrangement: 'bass' });
    assert.ok(fb.hotspots.length >= 1, 'a hotspot was found');
    const h = fb.hotspots[0];
    assert.ok(h.practice, 'the hotspot carries a practice block');
    assert.equal(h.practice.skill, 'timing');
    assert.match(h.practice.deepLink, /game=metronome_lock/);
});
