/*
 * Coaching feedback — the schema CONTRACT + the builder that emits it.
 *
 * This is the data model the coaching UI / LLM coach / drill loop will all
 * build on, defined and emitted from a play BEFORE any UI exists. It consumes
 * note_detect's per-note judgments (the `notedetect:hit` / `notedetect:miss`
 * window CustomEvents) plus the `notedetect:session` aggregate, and produces
 * ONE `PlayFeedback` object per play: the per-mistake atoms, the hotspots that
 * group them, and a session wrapper.
 *
 * Design (per FEEDBACK.md). The two load-bearing fields:
 *   - `faultVerdict` per mistake — routes a miss to DRILL IT (player_error) vs
 *     FEED IT TO THE HARNESS (detector_suspect / confirmed_detector_bug). Without
 *     it the player-fault/tool-fault split the whole narrative hinges on isn't
 *     expressible.
 *   - `signal.kind` per hotspot — systematic (a consistent timing/pitch skew →
 *     a tool/calibration problem, e.g. the 188 ms A/V offset that masqueraded as
 *     misses) vs random (scatter → a real skill gap). Keeps the drill loop from
 *     training the player on the detector's blind spots.
 *
 * Hotspots reference mistakes by id (no nested copies) so one mistake can feed
 * both a hotspot and the session-level tool-fault list.
 *
 * The builder is pure (no DOM) so it runs under plain `node --test`; the
 * browser event wiring is an opt-in block at the bottom, guarded on `window`.
 */

// ── Skill-drills: failure type → skill → game (the practice bridge) ────
// Turns "what you missed" into "go practice THIS" — see
// docs/TEACHING_NARRATIVE.md. Inlined here (not a sibling module) because the
// plugin loader serves a single script per plugin. Two pure pieces: the
// practice TAXONOMY (failure → skill + cue + game) and the skill-drill ENGINE
// (the fast rep/streak loop a drill game scores against). Both are exported and
// node-tested; nothing here touches the DOM.
//
// gameId is the minigame plugin id the skill drills against (the minigames SDK
// indexes games by what they `train`). null gameId = no game yet → show the cue
// only. Keep ids stable — coaching deep-links to them.
const SKILL_DRILLS = {
    mute_fail:    { skill: 'muting',     gameId: 'mute_master',    cue: 'mute the string you are not fretting — let the charted note ring alone', blurb: 'an open string rang in place of the fretted note' },
    late:         { skill: 'timing',     gameId: 'metronome_lock', cue: 'lock to the click — anticipate the beat instead of chasing it',          blurb: 'notes landing behind the beat' },
    early:        { skill: 'timing',     gameId: 'metronome_lock', cue: 'lock to the click — stop rushing the attack',                            blurb: 'notes landing ahead of the beat' },
    sharp:        { skill: 'intonation', gameId: 'pitch_match',    cue: 'press straight down behind the fret; check your tuning',                 blurb: 'notes reading sharp' },
    flat:         { skill: 'intonation', gameId: 'pitch_match',    cue: 'press firmly behind the fret; check your tuning',                        blurb: 'notes reading flat' },
    // no_detection is ambiguous (a real flub OR the low-string detector blind
    // spot), so there is no skill game yet — just a clarity cue.
    no_detection: { skill: 'clarity',    gameId: null,             cue: 'play it cleaner and a touch louder (some low notes are hard to hear)',   blurb: 'no pitch registered — could be a flub or a detection gap' },
};

function practiceForFailure(failureType) {
    return SKILL_DRILLS[failureType] || null;
}

// Foundational "vitamins" — drills loved regardless of any specific failure,
// because they transfer across several skills at once (which is why they're
// universally endorsed). Surfaced as always-available warm-ups, NOT gated behind
// a logged failure (`trains: []`). See docs/bass-drills-research.md. gameId is
// null until the game exists; the cue still stands as advice.
const FOUNDATIONAL_DRILLS = [
    { id: 'chromatic_spider', skill: 'finger independence', gameId: null, trains: [], cue: 'chromatic 1-2-3-4 across the strings with a click — even, economical, one finger per fret' },
    { id: 'scale_shapes',     skill: 'fretboard',           gameId: null, trains: [], cue: 'major scale shapes in position, ascending/descending to the click' },
    { id: 'slow_metronome',   skill: 'precision',           gameId: null, trains: [], cue: 'the meta-drill: slow it down until every rep is perfect, then nudge the tempo up' },
    { id: 'play_along',       skill: 'groove',              gameId: null, trains: [], cue: 'play the whole tune with the track — time, ear, and endurance at once' },
];

// The dominant failure type across a set of mistakes — the one skill worth
// drilling for a hotspot. Ties break toward the first seen.
function dominantFailure(mistakes) {
    const tally = {};
    for (const m of (mistakes || [])) {
        const t = m && m.failureType;
        if (t) tally[t] = (tally[t] || 0) + 1;
    }
    let best = null;
    let bestN = 0;
    for (const t of Object.keys(tally)) {
        if (tally[t] > bestN) { best = t; bestN = tally[t]; }
    }
    return best;
}

// Deep link into the minigames hub, pre-loaded with the game and the trouble
// spot (so the drill is your actual passage, not a generic exercise).
function deepLinkForGame(gameId, ctx) {
    ctx = ctx || {};
    // Built by hand (not URLSearchParams) so it works identically in node, the
    // browser, AND the vm sandbox the panel tests run coaching.js in.
    const parts = ['game=' + encodeURIComponent(gameId)];
    if (ctx.failureType) parts.push('skill=' + encodeURIComponent(ctx.failureType));
    if (Number.isFinite(ctx.loopA)) parts.push('loopA=' + ctx.loopA.toFixed(2));
    if (Number.isFinite(ctx.loopB)) parts.push('loopB=' + ctx.loopB.toFixed(2));
    if (ctx.song) parts.push('song=' + encodeURIComponent(ctx.song));
    return '#/plugin-minigames?' + parts.join('&');
}

// Resolve a hotspot → the "work on this thing here <game>" recommendation.
// `mistakesById` maps mistake id → the mistake atom (carries failureType).
function practiceForHotspot(hotspot, mistakesById) {
    if (!hotspot) return null;
    const ms = (hotspot.mistakeIds || []).map(id => (mistakesById || {})[id]).filter(Boolean);
    const failureType = dominantFailure(ms);
    const drill = practiceForFailure(failureType);
    if (!drill) return null;
    const b = hotspot.bounds || {};
    return {
        failureType,
        skill: drill.skill,
        cue: drill.cue,
        blurb: drill.blurb,
        gameId: drill.gameId,
        deepLink: drill.gameId
            ? deepLinkForGame(drill.gameId, { failureType, loopA: b.startSec, loopB: b.endSec, song: hotspot.song })
            : null,
    };
}

// Skill-drill engine — the game mechanics. A drill game runs ONE skill as a fast
// rep loop. A "rep" is a target note the drill judged; it is "clean" for this
// skill when the targeted failure did NOT occur (a hit, or a miss of a DIFFERENT
// type — we train one skill at a time). Pass = `goalStreak` clean reps in a row.
// Pure: feed { hit, failureType } events, read skillDrillView(); the game skin
// renders the view and never touches these internals.
function createSkillDrill(opts) {
    opts = opts || {};
    return {
        failureType: opts.failureType || null,
        goalStreak: Number.isFinite(opts.goalStreak) ? Math.max(1, opts.goalStreak) : 5,
        reps: 0, clean: 0, streak: 0, bestStreak: 0, lastClean: null, passed: false,
    };
}
function skillDrillStep(state, ev) {
    if (!state || !ev) return state;
    const hit = !!ev.hit;
    const type = ev.failureType || null;
    // An ambiguous no_detection (detector blind spot, not a judgeable attempt) is
    // not a rep for any OTHER skill — skip it so a detection gap can't tank a
    // muting/timing drill. When the drill IS no_detection, it counts.
    if (!hit && type === 'no_detection' && state.failureType !== 'no_detection') return state;
    state.reps++;
    const failed = !hit && type === state.failureType;
    state.lastClean = !failed;
    if (failed) {
        state.streak = 0;
    } else {
        state.clean++;
        state.streak++;
        if (state.streak > state.bestStreak) state.bestStreak = state.streak;
        if (state.streak >= state.goalStreak) state.passed = true;
    }
    return state;
}
function skillDrillView(state) {
    if (!state) return null;
    return {
        failureType: state.failureType,
        reps: state.reps, clean: state.clean, streak: state.streak, bestStreak: state.bestStreak,
        goalStreak: state.goalStreak,
        progress: Math.min(1, state.streak / Math.max(1, state.goalStreak)),
        accuracy: state.reps ? Math.round((state.clean / state.reps) * 1000) / 1000 : 0,
        passed: state.passed,
    };
}
// Back-compat handle used by the builder below (was an external module).
const _skillDrills = { SKILL_DRILLS, FOUNDATIONAL_DRILLS, practiceForFailure, dominantFailure, deepLinkForGame, practiceForHotspot, createSkillDrill, skillDrillStep, skillDrillView };

// ── Contract: enums ───────────────────────────────────────────────────
// Derivable from a note_detect judgment TODAY:
const FAILURE_TYPES_LIVE = ['no_detection', 'early', 'late', 'sharp', 'flat', 'mute_fail'];
// Reserved until the data exists (need detected-pitch alternatives for
// wrong_note/wrong_string, or per-instrument REST markers in the chart for
// string_noise / muted_ghosted / played_during_rest — see TEACHING_NARRATIVE):
const FAILURE_TYPES_RESERVED = ['wrong_note', 'wrong_string', 'string_noise', 'muted_ghosted', 'played_during_rest'];
const FAILURE_TYPES = FAILURE_TYPES_LIVE.concat(FAILURE_TYPES_RESERVED);
const FAULT_VERDICTS = ['player_error', 'detector_suspect', 'confirmed_detector_bug'];

/**
 * @typedef {Object} Mistake  The atom. Addressable + harness-routable.
 * @property {string} id                         // stable within a play: "m{index}"
 * @property {{t:number,s:number,f:number,expectedMidi:?number}} chart  // chart anchor
 * @property {?{midi:number,confidence:?number}} detected               // null = nothing fired
 * @property {?number} timingErrorMs             // signed: + late / - early
 * @property {?number} pitchErrorCents           // signed: + sharp / - flat (octave-folded)
 * @property {string} failureType                // one of FAILURE_TYPES
 * @property {string} faultVerdict               // one of FAULT_VERDICTS
 */

/**
 * @typedef {Object} Hotspot
 * @property {string} key                        // stable identity: song|arr|secRange
 * @property {{startSec:number,endSec:number,section:?string,bars:?number[]}} bounds
 * @property {string[]} mistakeIds               // reference by id, NOT nested
 * @property {{missRate:number,noteCount:number,misses:number,plays:number}} evidence
 * @property {{medianTimingMs:?number,medianPitchCents:?number,kind:string}} signal
 * @property {number} severity                   // 0..1, ranked (drill worst first)
 * @property {{loopA:number,loopB:number,speedMul:number,goal:number}} drill  // drives the loop directly
 */

/**
 * @typedef {Object} PlayFeedback
 * @property {string} schema
 * @property {Object} session  // song/arrangement/tuning/capo/settings/recording/score/sections/summary
 * @property {Mistake[]} mistakes
 * @property {Hotspot[]} hotspots
 */

// ── Small stats helpers ───────────────────────────────────────────────
function _median(xs) {
    if (!xs.length) return null;
    const s = xs.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function _mad(xs, med) {
    if (!xs.length || med == null) return null;
    return _median(xs.map(x => Math.abs(x - med)));
}

// ── Per-mistake ───────────────────────────────────────────────────────
function _classifyFailure(j) {
    if (j.muteFail) return 'mute_fail';                  // open string rang instead of the fretted note
    if (j.detectedMidi == null) return 'no_detection';   // window expired, no pitch
    if (j.timingState === 'EARLY') return 'early';
    if (j.timingState === 'LATE')  return 'late';
    if (j.pitchState  === 'SHARP') return 'sharp';
    if (j.pitchState  === 'FLAT')  return 'flat';
    // A detection fired and matched but wasn't flagged clean on either axis —
    // shouldn't reach here for a miss, but stay defensive.
    return 'no_detection';
}
// A note_detect judgment → the lightweight { hit, failureType } event a drill
// game feeds the skill-drill engine. Hits carry no failureType. This is the one
// classification a skill-drill game needs, exported so games don't re-derive it.
function classifyFailureForDrill(j) {
    if (!j) return { hit: false, failureType: null };
    if (j.hit === true) return { hit: true, failureType: null };
    return { hit: false, failureType: _classifyFailure(j) };
}
function _faultVerdict(failureType, j) {
    // A detection that fired but was off means the detector HEARD the player →
    // player_error. `no_detection` is the ambiguous case (didn't play / wrong
    // note / detector missed) → detector_suspect by default. But when note_detect
    // measured the expected note as PRESENT in the audio at miss time
    // (`notePresent`, the post-miss harmonic-presence check), the player DID play
    // it and the tool dropped it — promote the guess to a measurement:
    // `confirmed_detector_bug`. (Previously only an external harness replay set
    // this; the in-app presence check is that replay, moved in-app.)
    if (failureType === 'no_detection') {
        return (j && j.notePresent) ? 'confirmed_detector_bug' : 'detector_suspect';
    }
    return 'player_error';
}
function mistakeFromJudgment(j, idx) {
    const failureType = _classifyFailure(j);
    return {
        id: 'm' + idx,
        chart: {
            t: (typeof j.noteTime === 'number') ? j.noteTime : null,
            s: j.note ? j.note.s : null,
            f: j.note ? j.note.f : null,
            expectedMidi: (j.expectedMidi != null) ? j.expectedMidi : null,
        },
        detected: (j.detectedMidi != null)
            ? { midi: j.detectedMidi, confidence: (typeof j.confidence === 'number') ? j.confidence : null }
            : null,
        timingErrorMs: (typeof j.timingError === 'number') ? j.timingError : null,
        pitchErrorCents: (typeof j.pitchError === 'number') ? j.pitchError : null,
        // Per-string energy at this note (fraction of spectral energy in each
        // string's band, index = string). From note_detect's `se` — the raw
        // signal for wrong-string / ambient / not-played on a miss. May be
        // absent (non-bass, or audio unavailable at the expected time).
        stringEnergy: Array.isArray(j.stringEnergy) ? j.stringEnergy : null,
        // note_detect measured the expected note as present in the audio despite
        // the miss → the player played it, the tool dropped it (drives the
        // confirmed_detector_bug verdict). Absent on hits / non-bass / no audio.
        notePresent: j.notePresent === true,
        // note_detect measured the input as SILENT here → the player stopped /
        // didn't play (a confident "not played"), NOT the detector's blind spot.
        // Lets the coach say "you stopped here" instead of hedging.
        silent: j.silent === true,
        failureType,
        faultVerdict: _faultVerdict(failureType, j),
    };
}

// ── Loose hits ─────────────────────────────────────────────────────────
// A loose hit is a note note_detect scored as a HIT (inside the wide hit
// window) but graded NOT clean — it landed outside the tight quality band on
// timing or pitch (`j.clean === false`, `j.looseReason`). It is unambiguously
// the player (the detector heard it fine — no low-string-blind-spot caveat),
// so it routes to a confident timing/intonation drill, NOT counted as a miss.
function _classifyLoose(j) {
    const lr = j.looseReason;
    // Pitch-only loose → sharp/flat. Timing or 'both' → timing primary (timing
    // is the reliably-measured axis on bass; pitch is the noisier one).
    if (lr === 'pitch') return (j.pitchError > 0 ? 'sharp' : 'flat');
    if (Number.isFinite(j.timingError)) return (j.timingError > 0 ? 'late' : 'early');
    if (Number.isFinite(j.pitchError))  return (j.pitchError > 0 ? 'sharp' : 'flat');
    return 'late';
}
function looseFromJudgment(j, idx) {
    const failureType = _classifyLoose(j);
    return {
        id: 'L' + idx,
        chart: {
            t: (typeof j.noteTime === 'number') ? j.noteTime : null,
            s: j.note ? j.note.s : null,
            f: j.note ? j.note.f : null,
            expectedMidi: (j.expectedMidi != null) ? j.expectedMidi : null,
        },
        detected: (j.detectedMidi != null)
            ? { midi: j.detectedMidi, confidence: (typeof j.confidence === 'number') ? j.confidence : null }
            : null,
        timingErrorMs: (typeof j.timingError === 'number') ? j.timingError : null,
        pitchErrorCents: (typeof j.pitchError === 'number') ? j.pitchError : null,
        failureType,
        faultVerdict: 'player_error',   // detector heard it; the imprecision is the player's
        loose: true,
        looseReason: j.looseReason || null,
    };
}

// ── Hotspots ──────────────────────────────────────────────────────────
function _signalKind(tes, pes, medT, medP) {
    // systematic = a consistent, ACTIONABLE skew on either axis (a tool /
    // calibration problem, e.g. an A/V offset); random = scatter (a skill gap).
    // Systematic requires both: the median magnitude clears a floor (a 5 ms /
    // 4 cent constant error is not worth "fix your tooling"), AND it dominates
    // the spread (MAD). If neither axis qualifies, it's random.
    function isSystematic(xs, med, minMag) {
        if (!xs.length || med == null) return false;
        if (Math.abs(med) < minMag) return false;
        const mad = _mad(xs, med);
        return Math.abs(med) >= 2 * (mad + 1e-9);
    }
    const sysT = isSystematic(tes, medT, 25);   // ms
    const sysP = isSystematic(pes, medP, 15);   // cents
    return (sysT || sysP) ? 'systematic' : 'random';
}
function findHotspots(mistakes, allJudgments, opts) {
    opts = opts || {};
    // Cluster misses that fall within `gap` seconds of the previous one, and
    // flag a run of at least `minMisses`. These started stricter (3 within
    // 2s), which only caught tightly-bunched fumbles and returned NOTHING for
    // a sloppy-but-spread play (e.g. a 75% bass take whose misses sit >2s
    // apart) — so the panel wrongly said "no trouble spots". Loosened to 2
    // within 3s: two flubs a phrase apart is a real spot worth a slow loop.
    const gap = (opts.gapSec != null) ? opts.gapSec : 3.0;       // cluster misses within this gap (s)
    const minMisses = (opts.minMisses != null) ? opts.minMisses : 2;
    // NB: no run-in/run-out here. The drill loop is the raw musical span of
    // the cluster; note_detect.startDrill owns the audible lead-in + first-
    // note runway. Adding our own padding double-stacked it (1s here + 3s
    // there), pushing the real notes ~4s into the loop and desyncing the
    // count-in. Single ownership = note_detect.

    const sorted = mistakes.filter(m => Number.isFinite(m.chart.t)).sort((a, b) => a.chart.t - b.chart.t);
    const clusters = [];
    let cur = null;
    for (const m of sorted) {
        if (cur && m.chart.t - cur.lastT <= gap) { cur.items.push(m); cur.lastT = m.chart.t; }
        else { cur = { items: [m], lastT: m.chart.t }; clusters.push(cur); }
    }
    const noteTimes = allJudgments.map(j => j.noteTime).filter(Number.isFinite);

    const out = [];
    for (const c of clusters) {
        if (c.items.length < minMisses) continue;
        const startSec = c.items[0].chart.t;
        const endSec = c.items[c.items.length - 1].chart.t;
        const noteCount = noteTimes.filter(t => t >= startSec && t <= endSec).length || c.items.length;
        const missRate = Math.min(1, c.items.length / Math.max(1, noteCount));
        const tes = c.items.map(m => m.timingErrorMs).filter(x => typeof x === 'number');
        const pes = c.items.map(m => m.pitchErrorCents).filter(x => typeof x === 'number');
        const medT = tes.length ? _median(tes) : null;
        const medP = pes.length ? _median(pes) : null;
        out.push({
            key: (opts.song || '?') + '|' + (opts.arrangement || '?') + '|' + Math.round(startSec) + '-' + Math.round(endSec),
            bounds: { startSec, endSec, section: null, bars: null },  // musical bars/section TODO (need getSections)
            mistakeIds: c.items.map(m => m.id),
            evidence: { missRate: Math.round(missRate * 100) / 100, noteCount, misses: c.items.length, plays: 1 },
            signal: { medianTimingMs: medT, medianPitchCents: medP, kind: _signalKind(tes, pes, medT, medP) },
            severity: Math.round(1000 * missRate * Math.min(1, c.items.length / 8)) / 1000,
            drill: { loopA: startSec, loopB: endSec, speedMul: 0.7, goal: 0.85 },  // raw bounds; note_detect adds the lead-in
        });
    }
    out.sort((a, b) => b.severity - a.severity);
    return out;
}

// ── Top-level builder ─────────────────────────────────────────────────
// One note can be judged more than once in a session — when the player backs
// the track up and replays a section, note_detect re-opens and re-scores those
// notes (see _ndKeysToReopenOnSeek). The note's verdict for the play is its
// LAST judgment: nail the intro on the retry and the earlier miss must not
// still surface as a hotspot. Collapse to the latest judgment per chart note
// (time+string+fret), preserving order. Notes without a usable key pass through.
function _latestPerNote(judgments) {
    const byKey = new Map();
    const passthrough = [];
    for (const j of judgments) {
        const n = j && j.note;
        const t = j && j.noteTime;
        if (!n || typeof t !== 'number' || n.s == null || n.f == null) { passthrough.push(j); continue; }
        byKey.set(`${t}_${n.s}_${n.f}`, j);   // later judgment overwrites earlier
    }
    return passthrough.concat(Array.from(byKey.values()));
}

function buildPlayFeedback(judgments, sessionMeta) {
    sessionMeta = sessionMeta || {};
    const raw = Array.isArray(judgments) ? judgments.filter(Boolean) : [];
    const all = _latestPerNote(raw);
    const mistakes = all.filter(j => j.hit !== true).map((j, i) => mistakeFromJudgment(j, i));
    // Hotspots = where YOU had trouble, not where the detector did. Cluster
    // only player-fault mistakes (late/early/sharp/flat — detector heard you
    // and you were off); detector_suspect misses are unheard dropouts (the
    // tool's sub-60 Hz blind spot), which would otherwise plant "practice
    // spots" next to a 100% clean score. A clean play has no player faults →
    // no hotspots → "nice, clean". Timing faults are reliably detected even
    // on bass, so a rushed/dragged section still surfaces.
    const playerMistakes = mistakes.filter(m => m.faultVerdict === 'player_error');
    const hotspots = findHotspots(playerMistakes, all, { song: sessionMeta.song, arrangement: sessionMeta.arrangement });
    // Unheard runs: clusters of no_detection (detector_suspect) misses, kept
    // DISTINCT from `hotspots` (confirmed player faults). A poor bass play is
    // ALL no_detection, so without these it would get no practice targets at
    // all. They carry a caveat in the UI: some may be the detector's low-string
    // blind spot, not a flub. Gentler drill goal (0.6) — the detector may
    // under-score the run even when played right, so 0.85 could never graduate.
    const detectorSuspect = mistakes.filter(m => m.faultVerdict === 'detector_suspect');
    const unheardSpots = findHotspots(detectorSuspect, all, { song: sessionMeta.song, arrangement: sessionMeta.arrangement });
    for (const s of unheardSpots) { if (s.drill) s.drill.goal = 0.6; }
    // Loose hits — notes scored as hits but graded not-clean (sloppy timing /
    // intonation inside the wide hit window). These never appear in `mistakes`
    // (they ARE hits), so without this a high-accuracy-but-sloppy take gets no
    // practice targets. Cluster them like misses, but require a denser run
    // (minMisses 3) since loose hits are individually minor — we only want
    // SECTIONS the player is consistently loose through, not one rushed note.
    const looseMistakes = all
        .filter(j => j.hit === true && j.clean === false)
        .map((j, i) => looseFromJudgment(j, i));
    const looseHotspots = findHotspots(looseMistakes, all,
        { song: sessionMeta.song, arrangement: sessionMeta.arrangement, minMisses: 3 });
    for (const h of looseHotspots) { h.kind = 'loose'; if (h.drill) h.drill.goal = 0.9; }
    // Mark an unheard run as a confident "you STOPPED here" when the input was
    // measured silent across most of it (note_detect's `silent`), vs the
    // ambiguous low-string blind spot. A stopped run is unambiguously the player
    // — drill it confidently (no "maybe the tool" caveat) and at the normal goal.
    {
        const byId = {};
        for (const m of mistakes) byId[m.id] = m;
        for (const s of unheardSpots) {
            const ms = (s.mistakeIds || []).map(id => byId[id]).filter(Boolean);
            const silentN = ms.filter(m => m.silent).length;
            s.stopped = ms.length > 0 && silentN >= Math.ceil(ms.length / 2);
            if (s.stopped && s.drill) s.drill.goal = 0.85;   // you genuinely stopped → hold the real bar
        }
    }
    // Attach the "work on THIS thing here <game>" recommendation: resolve each
    // hotspot's dominant failure → skill + cue + drill game + deep link. This is
    // the bone that turns a diagnosis into a thing to go practice (see
    // docs/TEACHING_NARRATIVE.md). Pure metadata — the panel renders the link.
    if (_skillDrills) {
        const byId = {};
        for (const m of mistakes) byId[m.id] = m;
        for (const m of looseMistakes) byId[m.id] = m;
        for (const h of hotspots) { h.song = sessionMeta.song || null; h.practice = _skillDrills.practiceForHotspot(h, byId); }
        for (const s of unheardSpots) { s.song = sessionMeta.song || null; s.practice = _skillDrills.practiceForHotspot(s, byId); }
        for (const h of looseHotspots) { h.song = sessionMeta.song || null; h.practice = _skillDrills.practiceForHotspot(h, byId); }
    }
    const hits = all.filter(j => j.hit === true).length;
    // Of the hits, how many cleared the tight clean band. A judgment without a
    // `clean` field (older note_detect) counts as clean → no regression.
    const looseHits = looseMistakes.length;
    const cleanHits = hits - looseHits;
    const total = all.length;
    // Two-score split (the "fix detection vs fix my playing" question).
    // player_error  = the detector HEARD you and you were late/early/sharp/flat.
    // detector_suspect = no_detection — the detector never registered a pitch
    //   (e.g. sub-60 Hz bass fundamentals it can't resolve). Counting those
    //   against the player is a lie: a note it never heard isn't a note you
    //   missed. So:
    //     playerAccuracy   = hits / notes-the-detector-could-verify
    //     detectionCoverage = notes-it-verified / total
    //   Low coverage + high accuracy ⇒ clean playing the tool couldn't see.
    const playerMisses   = mistakes.filter(m => m.faultVerdict === 'player_error').length;
    // Both detector verdicts are tool misses, not player misses: detector_suspect
    // (ambiguous) + confirmed_detector_bug (measured present-but-dropped).
    const confirmedBugs  = mistakes.filter(m => m.faultVerdict === 'confirmed_detector_bug').length;
    const detectorMisses = mistakes.filter(m => m.faultVerdict === 'detector_suspect').length + confirmedBugs;
    const heard = hits + playerMisses;   // notes the detector verified (hit or heard-but-wrong)
    const missByType = { late: 0, early: 0, sharp: 0, flat: 0, no_detection: 0, mute_fail: 0 };
    for (const m of mistakes) if (missByType[m.failureType] != null) missByType[m.failureType]++;
    return {
        schema: 'coaching.play_feedback.v1',
        session: {
            song: sessionMeta.song || null,
            arrangement: sessionMeta.arrangement || null,
            tuning: sessionMeta.tuning || null,
            capo: (sessionMeta.capo != null) ? sessionMeta.capo : 0,
            settings: sessionMeta.settings || null,    // {method, frameSize, avOffsetMs, tolerances, pluginVersion}
            recording: sessionMeta.recording || null,  // {wavPath, judgmentStream}
            score: total ? Math.round((hits / total) * 1000) / 1000 : 0,   // legacy: hits/total
            playerAccuracy:   heard  > 0 ? Math.round((hits / heard) * 1000) / 1000 : null,
            detectionCoverage: total > 0 ? Math.round((heard / total) * 1000) / 1000 : 0,
            // Hit-quality: of the notes scored as hits, the fraction that were
            // tight (clean). Low cleanRate next to high playerAccuracy = the
            // "technically hit but sloppy" take — drill timing/intonation, not
            // notes. cleanRate is null when there are no hits to grade.
            cleanRate: hits > 0 ? Math.round((cleanHits / hits) * 1000) / 1000 : null,
            looseHits,
            faultSplit: { player: playerMisses, detector: detectorMisses, confirmedToolMisses: confirmedBugs },
            missByType,
            sections: sessionMeta.sections || [],
            summary: null,                             // free-form — filled by the LLM coach later
        },
        mistakes,
        hotspots,
        looseHotspots,
        unheardSpots,
        timing: _buildTimingReport(all),   // rush/drag histogram over all heard notes
    };
}

// ── LLM coach (task #14) ──────────────────────────────────────────────
// Turn a PlayFeedback into session.summary: a prioritized, specific,
// encouraging practice plan. The call is CLIENT-SIDE — the user's own
// Anthropic key, read from localStorage, posted straight from the browser
// to the Messages API. The key never touches the slopsmith server.
//
// Split into pure pieces (distill → build request → parse response) so the
// prompt assembly and the robust parsing are node-testable without a network
// or a real key, exactly like the builder above. requestCoaching() is the one
// impure seam and takes an injectable fetch so even it is testable.

const COACH_MODEL = 'claude-haiku-4-5';          // cheapest tier ($1/$5 per 1M) while we prove out the flow; supports structured outputs + prompt caching. Bump to claude-opus-4-8 once coaching quality is validated.
const COACH_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const COACH_API_VERSION = '2023-06-01';

// localStorage keys. The API key is a SECRET and lives only here, browser-side.
const LS_KEY = 'coaching.anthropicApiKey';
const LS_MODEL = 'coaching.model';
const LS_ENABLED = 'coaching.llmEnabled';

// Static system prompt — frozen so the prompt-cache prefix is stable across
// plays (cache_control breakpoint goes on this block). Keep volatile per-play
// data out of here; it rides in the user turn.
const COACH_SYSTEM = [
    'You are a bass and guitar practice coach embedded in a Rocksmith-style practice tool.',
    'After each play you receive a `coaching.play_feedback.v1` distillation with:',
    '- the session: song, arrangement, tuning, and TWO scores — `playerAccuracy` (hits over notes the',
    '  detector could verify) and `detectionCoverage` (fraction of all charted notes it registered);',
    '- the full PER-NOTE mistake stream `mistakes[]` — each with time `t`, string `s`/fret `f`, `note`',
    '  name, timing error `te` (ms; +late/-early), pitch error `pe` (cents; +sharp/-flat), `type`, `fault`,',
    '  and (bass, when available) a string-energy signal: `seSelf` = how much the string you SHOULD have',
    '  played rang (0..1), `seTop` = the loudest string that actually rang, `seTopStr` = which string that was;',
    '- `missedNotes` — the dropped notes grouped by fretboard position with counts;',
    '- HOTSPOTS — time-clustered PLAYER-fault groups with median errors, `severity`, and `signal.kind`;',
    '- `cleanRate` + `looseHits` — of the notes scored as HITS, the fraction that were TIGHT vs how many',
    '  were "loose hits" (right note, but timing/intonation outside the tight quality band — still counted a hit);',
    '- `looseHotspots` — time-clustered runs of those loose hits (sloppy-but-hit sections);',
    '- `unheardSpots` — time-clustered runs of `no_detection` misses (the detector registered no pitch).',
    '',
    'Load-bearing rules you MUST honor:',
    '1. TOOL vs PLAYER. The detector is UNRELIABLE on low bass: below ~60 Hz (roughly open E up through',
    '   ~B on the E and A strings) a "no_detection" / `detector_suspect` miss is AMBIGUOUS — it may be the',
    '   TOOL failing to hear a note the player actually played, OR a note the player genuinely flubbed. You',
    '   CANNOT tell which. So: never SCOLD the player for no_detection, but do NOT stay silent on a poor play',
    '   either. When `unheardSpots` are present (or `detectionCoverage` is low), name them as HONEST practice',
    '   targets WITH the caveat — e.g. "the detector lost the run at 0:40–0:42; if you know you flubbed it,',
    '   drill it slow; if you played it clean, that\'s the low-string detection gap." Emit `loops` for the',
    '   densest unheardSpots too, not just hotspots. Coach CONFIDENTLY (skill language) only on `player_error`',
    '   evidence: late/early (`te`), sharp/flat (`pe`).',
    '1a. STOPPED / NOT PLAYED. A miss with `silent: true`, or an unheardSpot with `stopped: true`, means note_detect',
    '   MEASURED the input as quiet there — the player STOPPED or didn\'t play, NOT the low-string blind spot. Here you',
    '   CAN tell: drop the "maybe the tool" caveat and name it plainly ("you stopped for a few seconds around 2:30 —',
    '   that\'s where the song got away from you; drill the lead-in into it"). It is the player, but it is a lost-the-thread',
    '   moment, not a botched fret — coach it as a confidence/recovery spot, not a skill error.',
    '1b. CONFIRMED TOOL MISS. A mistake with `fault` = `confirmed_detector_bug` (count in `faultSplit.confirmedToolMisses`)',
    '   is a no_detection where note_detect MEASURED your note present in the audio — you played it, the tool dropped it.',
    '   This is not a guess. Reassure confidently and explicitly ("the detector lost N notes you actually played — not your',
    '   fault"); never drill these or count them against the player.',
    '2. `signal.kind` "systematic" = a consistent skew (a TOOL/CALIBRATION issue like an A/V offset), not a',
    '   skill gap — flag it as calibration, do not tell the player to "practice" it. "random" = a real gap.',
    '3. STRING-ENERGY (the `seSelf`/`seTop`/`seTopStr` signal on a miss, bass) disambiguates a no_detection:',
    '   - `seSelf` HIGH (the right string rang) but still a miss → likely the TOOL\'s blind spot; reassure, don\'t scold.',
    '   - `seSelf` LOW and `seTop` HIGH on a DIFFERENT string (`seTopStr` ≠ `s`) → WRONG STRING: say it plainly,',
    '     e.g. "at 1:04 you hit string {seTopStr} but the chart wanted string {s}." This IS player-actionable.',
    '   - everything LOW → the note simply wasn\'t played (a drop), not a wrong note.',
    '   - everything HIGH / broad → ringing or unmuted strings; suggest muting. Only use `se` when it\'s present.',
    '4. MUTE FAIL. A `mute_fail` type (fault `player_error`) means the detector confirmed the OPEN string rang',
    '   where the chart wanted a FRETTED note — the player didn\'t fret/mute it. This is UNAMBIGUOUS and',
    '   player-actionable (not a detector blind spot): say it plainly, e.g. "at 0:64 the open A rang but the',
    '   chart wanted fret 2 — fret it cleanly or mute the open string." Coach it confidently.',
    '5. LOOSE HITS / TIGHTNESS. A high `playerAccuracy` does NOT mean a clean take. If `cleanRate` is low',
    '   (say < 0.85) the player is hitting the right notes but loosely — rushed/dragged timing or shaky',
    '   intonation. This is UNAMBIGUOUS and player-actionable (the detector heard every note — never caveat it',
    '   as a tool issue). Do NOT call a low-cleanRate take "clean"; name the tightness gap and drill the',
    '   `looseHotspots` (use their `signal.medianTimingMs`/`medianPitchCents` to say which way it skews — e.g.',
    '   "you\'re landing ~50 ms late through the 1:10-1:30 run; loop it at 80% with a metronome"). Treat',
    '   looseHotspots as real drill targets alongside hotspots, worst-first by `severity`.',
    '',
    'Produce a SHORT, prioritized, specific, encouraging plan, worst-first by severity. Every priority must',
    'be concrete and tied to evidence — the section time, the median error, the missed positions ("drill',
    '1:40-1:55 at 70% to a 90% goal", not "play better"). Set `hotspotKey` to the mapped hotspot.key or "".',
    '',
    'ALSO emit `loops`: the concrete drill loops to practice. Each has a `label`, `startSec`/`endSec` (lift',
    'tight bounds from the hotspots or the clustered mistake `t` times), a `speedMul` (0.5-1.0; slower for',
    'harder spots), and a `goal` accuracy (0-1). These drive the practice loop directly, so make the bounds',
    'real and tight. Lift loop bounds from hotspots AND looseHotspots. Only return an empty `loops` array when',
    'the play was clean on BOTH axes — no hotspots AND a high `cleanRate` (>= ~0.9); then suggest the next',
    'stretch goal. A high accuracy with a low cleanRate is NOT clean: emit tightness loops.',
].join('\n');

// JSON-schema for output_config.format — guarantees the response is one valid
// JSON object so parsing is deterministic. Constraints kept inside the
// structured-outputs supported subset (additionalProperties:false everywhere,
// no min/max/length keywords).
const COACH_SUMMARY_SCHEMA = {
    type: 'object',
    properties: {
        headline: { type: 'string' },               // one-line encouraging takeaway
        priorities: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    focus: { type: 'string' },       // what to work on
                    why: { type: 'string' },         // the evidence / why it matters
                    drill: { type: 'string' },       // a concrete practice action
                    hotspotKey: { type: 'string' },  // the hotspot.key it maps to, or ""
                },
                required: ['focus', 'why', 'drill', 'hotspotKey'],
                additionalProperties: false,
            },
        },
        loops: {                                      // the drill loops to practice — LLM-defined
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    label: { type: 'string' },        // what this loop drills
                    startSec: { type: 'number' },
                    endSec: { type: 'number' },
                    speedMul: { type: 'number' },      // 0.5..1.0 playback speed
                    goal: { type: 'number' },          // target accuracy 0..1
                },
                required: ['label', 'startSec', 'endSec', 'speedMul', 'goal'],
                additionalProperties: false,
            },
        },
        toolNotes: { type: 'string' },               // systematic-signal / detector_suspect routing
        encouragement: { type: 'string' },           // closing motivation
    },
    required: ['headline', 'priorities', 'loops', 'toolNotes', 'encouragement'],
    additionalProperties: false,
};

// Distill a PlayFeedback into the compact, privacy-light payload the model
// actually needs. We send the session block + hotspots (already the summarized,
// actionable layer) + failureType/faultVerdict tallies — NOT every raw mistake
// atom (those can be large and the hotspots already group them).
function summarizeForCoach(feedback) {
    const fb = feedback || {};
    const s = fb.session || {};
    const mistakes = Array.isArray(fb.mistakes) ? fb.mistakes : [];
    const tally = (arr, key) => arr.reduce((m, x) => { const k = x[key]; m[k] = (m[k] || 0) + 1; return m; }, {});
    const r2 = (x) => (typeof x === 'number') ? Math.round(x * 100) / 100 : null;
    const noteName = (m) => (m.chart && m.chart.expectedMidi != null) ? _midiName(m.chart.expectedMidi) : null;
    // The PER-NOTE mistake stream — the LLM reasons over the actual notes, not
    // just counts. Compact; capped so a pathological take can't blow the turn.
    // Compact the per-string energy into the wrong-string signal: energy on
    // the string you SHOULD have played (seSelf) vs the loudest string that
    // actually rang (seTop on string seTopStr). Cheaper than the raw array and
    // already framed for the model. Omitted when energy is unavailable.
    const seSignal = (m) => {
        const se = Array.isArray(m.stringEnergy) ? m.stringEnergy : null;
        const cs = m.chart ? m.chart.s : null;
        if (!se || cs == null || se[cs] == null) return {};
        let top = 0;
        for (let i = 1; i < se.length; i++) if (se[i] > se[top]) top = i;
        return { seSelf: r2(se[cs]), seTop: r2(se[top]), seTopStr: top };
    };
    const perNote = mistakes.slice(0, 150).map((m) => ({
        t: (m.chart && typeof m.chart.t === 'number') ? r2(m.chart.t) : null,
        s: m.chart ? m.chart.s : null,
        f: m.chart ? m.chart.f : null,
        note: noteName(m),
        te: m.timingErrorMs,          // +late / -early ms
        pe: m.pitchErrorCents,         // +sharp / -flat cents (octave-folded)
        type: m.failureType,
        fault: m.faultVerdict,
        silent: m.silent || undefined,   // input was quiet here = player stopped/didn't play (not the tool)
        ...seSignal(m),                // seSelf / seTop / seTopStr when available
    }));
    // "What you missed" grouped by fretboard position, most-missed first.
    const posMap = new Map();
    for (const m of mistakes) {
        const c = m.chart || {};
        if (c.s == null || c.f == null) continue;
        const k = c.s + '_' + c.f;
        const g = posMap.get(k) || { s: c.s, f: c.f, note: noteName(m), n: 0 };
        g.n++; posMap.set(k, g);
    }
    const missedNotes = [...posMap.values()].sort((a, b) => b.n - a.n).slice(0, 12);
    return {
        schema: fb.schema || 'coaching.play_feedback.v1',
        session: {
            song: s.song || null,
            arrangement: s.arrangement || null,
            tuning: s.tuning || null,
            capo: (s.capo != null) ? s.capo : 0,
            // Two-score split: playerAccuracy (of notes the detector could
            // verify) vs detectionCoverage (fraction it registered at all).
            // Low coverage + high accuracy = the tool dropped notes you played.
            playerAccuracy: r2(s.playerAccuracy),
            detectionCoverage: r2(s.detectionCoverage),
            // Hit-quality: fraction of hits that were tight. Low next to a high
            // playerAccuracy = sloppy-but-technically-hit (drill timing, not notes).
            cleanRate: r2(s.cleanRate),
            looseHits: (typeof s.looseHits === 'number') ? s.looseHits : null,
            faultSplit: s.faultSplit || null,
            missByType: s.missByType || null,
            score: (typeof s.score === 'number') ? s.score : null,
            settings: s.settings || null,
        },
        totals: {
            mistakes: mistakes.length,
            byFailureType: tally(mistakes, 'failureType'),
            byFaultVerdict: tally(mistakes, 'faultVerdict'),
        },
        missedNotes,
        mistakes: perNote,
        // hotspots are the pre-clustered actionable layer — drill straight off these
        hotspots: (Array.isArray(fb.hotspots) ? fb.hotspots : []).map(h => ({
            key: h.key,
            bounds: h.bounds,
            evidence: h.evidence,
            signal: h.signal,
            severity: h.severity,
            drill: h.drill,
        })),
        // Loose-hit runs — sections the player HIT but consistently sloppily
        // (timing/intonation outside the tight clean band). The detector heard
        // every note, so these are unambiguously player-actionable: drill for
        // tightness, never caveated as a tool issue. `evidence.missRate` here is
        // the loose RATE through the run, and `signal.medianTimingMs` /
        // `medianPitchCents` say which way it skews.
        looseHotspots: (Array.isArray(fb.looseHotspots) ? fb.looseHotspots : []).map(h => ({
            key: h.key,
            bounds: h.bounds,
            evidence: h.evidence,
            signal: h.signal,
            severity: h.severity,
            drill: h.drill,
        })),
        // Unheard runs — clusters of no_detection misses. `stopped: true` means
        // the input was measured SILENT across the run (the player stopped /
        // lost the thread — confident, not the tool); otherwise it's the
        // ambiguous low-string blind spot (real flubs mixed with tool misses).
        unheardSpots: (Array.isArray(fb.unheardSpots) ? fb.unheardSpots : []).map(h => ({
            key: h.key,
            bounds: h.bounds,
            evidence: h.evidence,
            drill: h.drill,
            stopped: h.stopped || undefined,
        })),
    };
}

// Pure: assemble the Messages API request body. Static system block carries the
// cache_control breakpoint; the per-play distilled JSON rides in the user turn
// (after the breakpoint) so the cached prefix stays byte-stable across plays.
function buildCoachRequest(feedback, opts) {
    opts = opts || {};
    return {
        model: opts.model || COACH_MODEL,
        max_tokens: opts.maxTokens || 2048,
        system: [{ type: 'text', text: COACH_SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{
            role: 'user',
            content: 'Here is the play feedback. Return the practice plan.\n\n'
                + JSON.stringify(summarizeForCoach(feedback)),
        }],
        output_config: { format: { type: 'json_schema', schema: COACH_SUMMARY_SCHEMA } },
    };
}

// Pure: pull the structured summary out of a Messages API response, defensively.
// output_config.format guarantees the first text block is valid JSON, but we
// still handle refusals, truncation, and a stray ```json fence as fallbacks.
function parseCoachSummary(apiJson) {
    const r = apiJson || {};
    if (r.type === 'error') throw new Error('coach API error: ' + ((r.error && r.error.message) || 'unknown'));
    if (r.stop_reason === 'refusal') throw new Error('coach refused to generate a plan');
    const blocks = Array.isArray(r.content) ? r.content : [];
    const textBlock = blocks.find(b => b && b.type === 'text' && typeof b.text === 'string');
    if (!textBlock) throw new Error('coach response had no text block');
    let raw = textBlock.text.trim();
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (_) {
        // fallback: a fenced or prose-wrapped object — grab the outermost braces
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('coach response was not JSON' + (r.stop_reason === 'max_tokens' ? ' (truncated — raise max_tokens)' : ''));
        parsed = JSON.parse(m[0]);
    }
    if (!parsed || typeof parsed.headline !== 'string' || !Array.isArray(parsed.priorities)) {
        throw new Error('coach response missing required fields (headline/priorities)');
    }
    return parsed;
}

// Impure seam: do the actual browser → Anthropic call. fetchImpl injectable for
// tests. Returns the parsed summary object (also stamps the model used).
async function requestCoaching(feedback, opts) {
    opts = opts || {};
    const apiKey = opts.apiKey;
    if (!apiKey) throw new Error('no Anthropic API key (set it in coaching settings)');
    const f = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('no fetch available');
    const model = opts.model || COACH_MODEL;
    const body = buildCoachRequest(feedback, { model, maxTokens: opts.maxTokens });

    const resp = await f(COACH_ENDPOINT, {
        method: 'POST',
        signal: opts.signal,
        headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': COACH_API_VERSION,
            // required for direct browser-origin calls (CORS); key stays client-side
            'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify(body),
    });

    let json;
    try { json = await resp.json(); } catch (_) { json = null; }
    if (!resp.ok) {
        const msg = (json && json.error && json.error.message) || ('HTTP ' + resp.status);
        if (resp.status === 401) throw new Error('coach auth failed (check your API key): ' + msg);
        if (resp.status === 429) throw new Error('coach rate-limited — try again shortly: ' + msg);
        throw new Error('coach request failed: ' + msg);
    }
    const summary = parseCoachSummary(json);
    summary._model = model;
    return summary;
}

// ── Settings (the API key lives client-side, never on the server) ─────
// Factory over a Storage-like object so the secret-handling logic is pure and
// node-testable with a fake map. The browser passes window.localStorage; the
// settings.html panel writes the same keys directly so wiring doesn't depend on
// this module's load order.
function makeSettings(storage) {
    const get = (k) => { try { return storage && storage.getItem(k); } catch (_) { return null; } };
    const set = (k, v) => { try { if (!storage) return; if (v == null || v === '') storage.removeItem(k); else storage.setItem(k, v); } catch (_) {} };
    return {
        getApiKey: () => get(LS_KEY) || null,
        setApiKey: (k) => set(LS_KEY, k),
        getModel: () => get(LS_MODEL) || COACH_MODEL,
        setModel: (m) => set(LS_MODEL, m),
        // enabled by default once a key is present; explicit "false" opts out
        isEnabled: () => !!(get(LS_KEY)) && get(LS_ENABLED) !== 'false',
        setEnabled: (on) => set(LS_ENABLED, on ? 'true' : 'false'),
    };
}

// ── Rendering (pure → HTML string; the DOM shell just injects it) ──────
function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// Map a hotspot's single `speedMul` into the conductor's ascending speed
// ladder (slow → full). Two intermediate steps so the drill ramps rather
// than jumping straight to full speed. Pure — node-testable.
function drillLadderFromSpeedMul(speedMul) {
    const base = (Number.isFinite(speedMul) && speedMul > 0 && speedMul < 1) ? speedMul : 0.7;
    const mid = Math.round(((base + 1) / 2) * 100) / 100;
    return [base, mid, 1.0];
}

// Pure: translate a "Practice this" button's data-attrs (a DOMStringMap-like
// object) into the argument triple for window.noteDetect.startDrill. Returns
// null when there's no usable drill range, so the click handler can show a
// hint instead of calling the conductor with garbage. Exported + node-tested;
// _startDrillFromButton is the thin DOM wrapper around it.
function drillArgsFromDataset(ds) {
    ds = ds || {};
    const a = parseFloat(ds.loopA);
    const b = parseFloat(ds.loopB);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const goal = parseFloat(ds.goal);
    const speedMul = parseFloat(ds.speedMul);
    const focus = ds.focus || null;
    return {
        start: a,
        end: b,
        opts: {
            label: ds.key || focus || 'Hotspot',
            focus,
            // undefined → startDrill applies its own default goal.
            goal: Number.isFinite(goal) ? goal : undefined,
            speedLadder: drillLadderFromSpeedMul(speedMul),
            // Once the tight trouble spot is nailed, widen the loop a bar each
            // side and re-earn it — practice playing INTO and OUT of the hard
            // passage, not just the isolated bar (bass-drill research, l.134).
            expandContext: true,
        },
    };
}

// Render a coach summary object into a safe HTML fragment for the end-of-song
// panel. ALL model-produced text is escaped — it's untrusted output injected via
// innerHTML. Uses only core Tailwind utilities so no plugin stylesheet is needed.
//
// `hotspots` (optional, from the PlayFeedback) lets a priority that maps to a
// hotspot (via hotspotKey) sprout a "Practice this" button carrying that
// hotspot's drill range as data-attrs; _showSummaryPanel wires the click to
// window.noteDetect.startDrill. Omit it (e.g. in unit tests) and no button is
// rendered — the summary text is unchanged.
function renderSummaryHtml(summary, hotspots) {
    const s = summary || {};
    const prios = Array.isArray(s.priorities) ? s.priorities : [];
    // Index drillable hotspots by key for O(1) priority → drill lookup.
    const drillByKey = new Map();
    if (Array.isArray(hotspots)) {
        for (const h of hotspots) {
            const d = h && h.drill;
            if (h && h.key && d && Number.isFinite(d.loopA) && Number.isFinite(d.loopB) && d.loopB > d.loopA) {
                drillByKey.set(h.key, d);
            }
        }
    }
    const items = prios.map((p, i) => {
        const key = p && p.hotspotKey ? `<span class="text-xs text-gray-500 font-mono">${escapeHtml(p.hotspotKey)}</span>` : '';
        const d = (p && p.hotspotKey) ? drillByKey.get(p.hotspotKey) : null;
        const drillBtn = d
            ? `<button class="coaching-drill-btn mt-2 px-3 py-1.5 bg-accent hover:bg-accent-light text-white rounded-lg text-xs font-semibold transition"
                   data-loop-a="${d.loopA}" data-loop-b="${d.loopB}" data-speed-mul="${d.speedMul}" data-goal="${d.goal}"
                   data-focus="${escapeHtml(p && p.focus)}" data-key="${escapeHtml(p.hotspotKey)}">&#9654; Practice this</button>`
            : '';
        return `<li class="bg-dark-700/60 border border-gray-800 rounded-lg p-3">
            <div class="flex items-center justify-between gap-2">
                <span class="text-sm font-semibold text-gray-200">${i + 1}. ${escapeHtml(p && p.focus)}</span>
                ${key}
            </div>
            <p class="text-xs text-gray-400 mt-1">${escapeHtml(p && p.why)}</p>
            <p class="text-sm text-gray-300 mt-1"><span class="text-gold">Drill:</span> ${escapeHtml(p && p.drill)}</p>
            ${drillBtn}
        </li>`;
    }).join('');
    const tool = s.toolNotes
        ? `<p class="text-xs text-gray-400 mt-3"><span class="text-gray-500">Tooling:</span> ${escapeHtml(s.toolNotes)}</p>`
        : '';
    const enc = s.encouragement
        ? `<p class="text-sm text-gray-300 mt-3 italic">${escapeHtml(s.encouragement)}</p>`
        : '';
    // LLM-defined drill loops — directly drillable via the same data-attrs the
    // hotspot Practice buttons use (drillArgsFromDataset / startDrill).
    const loops = Array.isArray(s.loops) ? s.loops : [];
    const mmss = (x) => (Number.isFinite(x) ? `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}` : '?');
    const loopItems = loops
        .filter(l => l && Number.isFinite(l.startSec) && Number.isFinite(l.endSec) && l.endSec > l.startSec)
        .map(l => `<li class="flex items-center justify-between gap-2 bg-dark-700/60 border border-gray-800 rounded-lg p-2">
            <span class="text-xs text-gray-200">${escapeHtml(l.label)} <span class="text-gray-500 font-mono">${mmss(l.startSec)}–${mmss(l.endSec)}</span></span>
            <button class="coaching-drill-btn px-3 py-1.5 bg-accent hover:bg-accent-light text-white rounded-lg text-xs font-semibold transition"
                data-loop-a="${l.startSec}" data-loop-b="${l.endSec}" data-speed-mul="${Number.isFinite(l.speedMul) ? l.speedMul : 0.7}" data-goal="${Number.isFinite(l.goal) ? l.goal : 0.85}"
                data-focus="${escapeHtml(l.label)}" data-key="${escapeHtml(l.label)}">&#9654; Drill</button>
        </li>`).join('');
    const loopsHtml = loopItems
        ? `<div class="mt-3"><div class="text-xs font-semibold text-gray-300 mb-1">Drill loops</div><ul class="space-y-1">${loopItems}</ul></div>`
        : '';
    return `<h3 class="text-base font-semibold text-gold mb-2">${escapeHtml(s.headline) || 'Practice plan'}</h3>
        <ul class="space-y-2">${items}</ul>${loopsHtml}${tool}${enc}`;
}

function _midiName(m) {
    if (m == null || !Number.isFinite(m)) return '?';
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const r = Math.round(m);
    return names[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
}

// The honest two-score split + a failure-type histogram. Pure → node-testable.
// "Played clean" is your hit rate over notes the detector COULD verify;
// "Detector heard" is how many of all charted notes it registered at all. A
// high played-clean next to a low detector-heard = clean playing the tool
// couldn't see (e.g. sub-60 Hz bass) — NOT a skill gap. Returns '' when the
// feedback predates the split (no playerAccuracy/detectionCoverage) so the
// legacy panel still works unchanged.
// ── Post-play timing report (rush/drag) ────────────────────────────────
// "Record and zoom the waveform to see how close to the beat" is a top bass-
// drill technique; slopsmith already measures per-note timing error, so we can
// hand it back automatically. Buckets every heard note's signed timing error
// (+late / -early ms) into a small histogram + a median-based verdict. Returns
// null when too few notes carry a timing measurement to be meaningful.
function _buildTimingReport(judgments) {
    const tes = [];
    for (const j of (judgments || [])) {
        if (j && typeof j.timingError === 'number' && Number.isFinite(j.timingError)) tes.push(j.timingError);
    }
    if (tes.length < 4) return null;
    const sorted = tes.slice().sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
    const median = q(0.5);
    // Seven bins centred on the ±15 ms "in the pocket" window.
    const edges = [-80, -40, -15, 15, 40, 80];
    const labels = ['≤−80', '−80…−40', '−40…−15', '±15', '15…40', '40…80', '>80'];
    const buckets = new Array(edges.length + 1).fill(0);
    for (const t of tes) {
        let bi = edges.length;
        for (let i = 0; i < edges.length; i++) { if (t <= edges[i]) { bi = i; break; } }
        buckets[bi]++;
    }
    const early = tes.filter(t => t < -15).length;
    const late = tes.filter(t => t > 15).length;
    const on = tes.length - early - late;
    let verdict;
    if (Math.abs(median) <= 12) verdict = { kind: 'on', text: `Solid pocket — median ${median > 0 ? '+' : ''}${median} ms` };
    else if (median > 0) verdict = { kind: 'drag', text: `You DRAG — median +${median} ms behind the beat` };
    else verdict = { kind: 'rush', text: `You RUSH — median ${median} ms ahead of the beat` };
    return { count: tes.length, median, p10: q(0.1), p90: q(0.9), buckets, labels, early, on, late, verdict };
}

function renderTimingHtml(feedback) {
    const t = feedback && feedback.timing;
    if (!t || !t.count) return '';
    const H = 40;
    const CENTER = 3;   // index of the ±15 bucket
    const max = Math.max(1, ...t.buckets);
    const bars = t.buckets.map((n, i) => {
        const h = Math.round((n / max) * H);
        const color = i < CENTER ? '#4080e0' : (i > CENTER ? '#e05a5a' : '#7ddb7d');
        return `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:${H}px" title="${t.labels[i]} ms: ${n} notes">`
            + `<div style="width:70%;height:${h}px;background:${color};border-radius:2px 2px 0 0"></div></div>`;
    }).join('');
    const vColor = t.verdict.kind === 'on' ? '#7ddb7d' : (t.verdict.kind === 'drag' ? '#e05a5a' : '#4080e0');
    return `<h3 class="text-base font-semibold text-gold mb-1">Timing</h3>`
        + `<div class="mb-3">`
        + `<div style="display:flex;align-items:flex-end;gap:2px;height:${H}px">${bars}</div>`
        + `<div style="display:flex;justify-content:space-between;font-size:9px;color:#6b7280;margin-top:2px"><span>early</span><span>on beat</span><span>late</span></div>`
        + `<p class="text-xs mt-1" style="color:${vColor}">${escapeHtml(t.verdict.text)} · ${t.on}/${t.count} in the pocket</p>`
        + `</div>`;
}

function renderBreakdownHtml(feedback) {
    const s = (feedback && feedback.session) || {};
    if (!Number.isFinite(s.playerAccuracy) && !Number.isFinite(s.detectionCoverage)) return '';
    const pa = Number.isFinite(s.playerAccuracy) ? Math.round(s.playerAccuracy * 100) : null;
    const dc = Number.isFinite(s.detectionCoverage) ? Math.round(s.detectionCoverage * 100) : null;
    const mistakes = Array.isArray(feedback && feedback.mistakes) ? feedback.mistakes : [];
    const fs = s.faultSplit || { player: 0, detector: 0 };
    const mt = s.missByType || {};

    let html = `<div class="grid grid-cols-2 gap-2 mb-2">
        <div class="bg-dark-700/60 border border-gray-800 rounded-lg p-2 text-center">
            <div class="text-2xl font-bold text-green-300">${pa == null ? '—' : pa + '%'}</div>
            <div class="text-[10px] uppercase tracking-wider text-gray-500">played clean</div>
            <div class="text-[10px] text-gray-600">of notes it could verify</div>
        </div>
        <div class="bg-dark-700/60 border border-gray-800 rounded-lg p-2 text-center">
            <div class="text-2xl font-bold ${(dc != null && dc < 85) ? 'text-amber-300' : 'text-gray-200'}">${dc == null ? '—' : dc + '%'}</div>
            <div class="text-[10px] uppercase tracking-wider text-gray-500">detector heard</div>
            <div class="text-[10px] text-gray-600">of all charted notes</div>
        </div>
    </div>`;

    // Verdict: tool-fault dominant vs player-fault dominant.
    if (fs.detector > fs.player && (dc == null || dc < 90)) {
        const dropped = mistakes.filter(m => m.faultVerdict === 'detector_suspect' && m.chart && m.chart.expectedMidi != null);
        const names = [...new Set(dropped.map(m => _midiName(m.chart.expectedMidi)))].slice(0, 4);
        html += `<p class="text-xs text-gray-300 mb-2"><span class="text-amber-300 font-semibold">Tool, not you:</span> the detector never registered ${fs.detector} note${fs.detector === 1 ? '' : 's'} you likely played fine${names.length ? ` (${escapeHtml(names.join(', '))})` : ''} — below what the detector reliably hears, not misses you made.</p>`;
    } else if (fs.player > 0) {
        html += `<p class="text-xs text-gray-300 mb-2"><span class="text-green-300 font-semibold">${fs.player} thing${fs.player === 1 ? '' : 's'} to work on</span> — breakdown below.</p>`;
    }

    // Failure-type histogram. Player faults (you can fix these) then the
    // tool fault (unheard). Sharp/flat shown as the user's words: high/low.
    const rows = [
        { label: 'Late',    cls: 'bg-amber-500', n: mt.late || 0,  tool: false },
        { label: 'Early',   cls: 'bg-amber-500', n: mt.early || 0, tool: false },
        { label: 'High',    cls: 'bg-rose-500',  n: mt.sharp || 0, tool: false },
        { label: 'Low',     cls: 'bg-rose-500',  n: mt.flat || 0,  tool: false },
        { label: 'Unheard', cls: 'bg-gray-600',  n: mt.no_detection || 0, tool: true },
    ].filter(r => r.n > 0);
    if (rows.length) {
        const max = Math.max(1, ...rows.map(r => r.n));
        const bars = rows.map(r => {
            const pct = Math.round((r.n / max) * 100);
            const tag = r.tool ? ' <span class="text-[10px] text-gray-500">tool</span>' : '';
            return `<div class="flex items-center gap-2 text-xs">
                <div class="w-16 text-right text-gray-400">${r.label}${tag}</div>
                <div class="flex-1 bg-dark-700 rounded h-3"><div class="${r.cls} h-3 rounded" style="width:${pct}%"></div></div>
                <div class="w-6 text-gray-400">${r.n}</div>
            </div>`;
        }).join('');
        html += `<div class="space-y-1 mb-3">${bars}</div>`;
    }
    return html;
}

// Render a basic, NO-LLM panel straight from PlayFeedback: this play's
// score + the hotspots, each with a "Practice this" button. This is what
// shows after every play even without an API key — the drill loop must not
// be gated behind the paid LLM coach. When the LLM plan lands it replaces
// this with the richer renderSummaryHtml. Pure → node-testable.
// Open-string label by index, low→high. Standard 4-string bass is EADG and
// standard 6-string guitar EADGBe; indices 4–5 in the bass row (C, B) are a
// best-effort fallback for extended-range basses whose true string set the
// arrangement name doesn't disclose — treat them as approximate, not canonical.
function _stringLabel(s, arrangement) {
    const bass = ['E', 'A', 'D', 'G', 'C', 'B'];
    const gtr = ['E', 'A', 'D', 'G', 'B', 'e'];
    const names = (arrangement && /bass/i.test(arrangement)) ? bass : gtr;
    return (names[s] != null) ? names[s] : `string ${s}`;
}

// "What you missed": the actual notes you dropped, grouped by fretboard
// position and counted, so you know WHERE to look — not just a percentage.
// Pure → node-testable.
function renderMissedNotesHtml(feedback) {
    const fb = feedback || {};
    const mistakes = Array.isArray(fb.mistakes) ? fb.mistakes : [];
    if (!mistakes.length) return '';
    const arr = fb.session && fb.session.arrangement;
    const groups = new Map();
    for (const m of mistakes) {
        const c = m.chart || {};
        if (c.s == null || c.f == null) continue;
        const key = c.s + '_' + c.f;
        const g = groups.get(key) || { s: c.s, f: c.f, midi: c.expectedMidi, n: 0 };
        g.n++;
        groups.set(key, g);
    }
    if (!groups.size) return '';
    const rows = [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 8);
    const items = rows.map((g) => {
        const note = (g.midi != null) ? _midiName(g.midi) : '?';
        const pos = `${_stringLabel(g.s, arr)} string · fret ${g.f}`;
        return `<li class="flex items-center justify-between text-xs py-0.5">
            <span class="text-gray-200 font-mono">${escapeHtml(note)} <span class="text-gray-500 font-sans">${escapeHtml(pos)}</span></span>
            <span class="text-amber-300">${g.n}×</span>
        </li>`;
    }).join('');
    return `<div class="mb-3">
        <div class="text-xs font-semibold text-gray-300 mb-1">What you missed</div>
        <ul class="bg-dark-700/40 border border-gray-800 rounded-lg px-3 py-2">${items}</ul>
    </div>`;
}

function renderFeedbackHtml(feedback) {
    const fb = feedback || {};
    const hotspots = Array.isArray(fb.hotspots) ? fb.hotspots : [];
    const score = (fb.session && Number.isFinite(fb.session.score))
        ? Math.round(fb.session.score * 100) : null;
    const missCount = Array.isArray(fb.mistakes) ? fb.mistakes.length : 0;
    const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`;
    // Two-score breakdown owns the score display when present; fall back to
    // the legacy "% clean" subline for pre-split feedback (and the tests
    // that exercise it).
    const breakdown = renderBreakdownHtml(fb);
    const head = breakdown
        + renderMissedNotesHtml(fb)
        + renderTimingHtml(fb)
        + `<h3 class="text-base font-semibold text-gold mb-1">Practice spots</h3>`
        + ((!breakdown && score != null) ? `<p class="text-xs text-gray-400 mb-2">This play: ${score}% clean${missCount ? ` · ${missCount} miss${missCount === 1 ? '' : 'es'}` : ''}</p>` : '');
    const unheardHtml = renderUnheardSpotsHtml(fb, mmss);
    const unheardCount = (Array.isArray(fb.unheardSpots) ? fb.unheardSpots : []).length;
    if (!hotspots.length) {
        // Be honest about the empty state. DON'T say "nice" when the play
        // wasn't clean:
        //   - score < 100% but ZERO mistakes recorded → no notes were judged.
        //   - unheard runs exist → those ARE the practice targets (below); say
        //     so rather than "nice"/"consistency gap".
        //   - real player misses that just don't bunch → a consistency gap.
        //   - genuinely clean → "nice".
        const noData = missCount === 0 && score != null && score < 100;
        let body;
        if (noData) {
            body = `No notes were scored — the detector wasn't running for this play (Detect off, input dropped, or a looped/drill pass). Turn Detect on and replay to score it.`;
        } else if (unheardCount) {
            body = `No timing/pitch faults the detector could pin on you — but it lost whole runs of notes (below). On bass that's a mix of notes you flubbed and its low-string blind spot.`;
        } else if (missCount >= 1) {
            body = `Your misses are spread across the song rather than bunched in one spot — a consistency gap, not a single hotspot. A slower full pass (drop the speed slider) helps more than looping one bar.`;
        } else {
            body = `No recurring trouble spots this play — nice. Keep going, or raise the difficulty.`;
        }
        return head + `<p class="text-sm text-gray-300">${body}</p>` + unheardHtml;
    }
    const items = hotspots.map((h, i) => {
        const b = h.bounds || {}; const d = h.drill || {}; const ev = h.evidence || {};
        const range = (Number.isFinite(b.startSec) ? mmss(b.startSec) : '?')
            + '–' + (Number.isFinite(b.endSec) ? mmss(b.endSec) : '?');
        const drillable = d && Number.isFinite(d.loopA) && Number.isFinite(d.loopB) && d.loopB > d.loopA;
        const sys = (h.signal && h.signal.kind === 'systematic')
            ? ` <span class="text-[10px] text-amber-300">systematic — may be calibration, not a skill gap</span>` : '';
        const btn = drillable
            ? `<button class="coaching-drill-btn mt-2 px-3 py-1.5 bg-accent hover:bg-accent-light text-white rounded-lg text-xs font-semibold transition"
                   data-loop-a="${d.loopA}" data-loop-b="${d.loopB}" data-speed-mul="${d.speedMul}" data-goal="${d.goal}"
                   data-focus="${escapeHtml(range)}" data-key="${escapeHtml(h.key || '')}">&#9654; Practice this</button>`
            : '';
        // "Work on THIS thing here <game>" — the skill behind the misses + a link
        // into its drill game (docs/TEACHING_NARRATIVE.md). Cue always; game link
        // when one trains the skill.
        const p = h.practice;
        const skillBlock = p
            ? `<div class="mt-2 pt-2 border-t border-gray-800 text-xs">
                 <span class="text-gray-400">Skill:</span> <span class="text-gray-200 font-semibold">${escapeHtml(p.skill)}</span>
                 <div class="text-gray-500 mt-0.5">${escapeHtml(p.cue)}</div>
                 ${p.gameId && p.deepLink
                    ? `<a class="coaching-skill-game inline-block mt-1.5 px-3 py-1 bg-gold/20 hover:bg-gold/30 text-gold rounded-lg font-semibold transition"
                          href="${escapeHtml(p.deepLink)}" data-game="${escapeHtml(p.gameId)}" data-skill="${escapeHtml(p.failureType)}">&#127918; Drill ${escapeHtml(p.skill)}</a>`
                    : ''}
               </div>`
            : '';
        return `<li class="bg-dark-700/60 border border-gray-800 rounded-lg p-3">
            <div class="text-sm font-semibold text-gray-200">${i + 1}. ${escapeHtml(range)}</div>
            <p class="text-xs text-gray-400 mt-1">${ev.noteCount || 0} note${ev.noteCount === 1 ? '' : 's'} · ${Math.round((ev.missRate || 0) * 100)}% miss${sys}</p>
            ${btn}
            ${skillBlock}
        </li>`;
    }).join('');
    return head + `<ul class="space-y-2">${items}</ul>` + unheardHtml;
}

// Honest "unheard runs" section — clusters of no_detection misses surfaced as
// drillable targets, with the caveat that on bass the detector can't tell a
// flub from its own low-string blind spot. Reuses the .coaching-drill-btn
// contract (drillArgsFromDataset → startDrill), so the run loops slow on click.
function renderUnheardSpotsHtml(feedback, mmss) {
    const fb = feedback || {};
    const spots = Array.isArray(fb.unheardSpots) ? fb.unheardSpots : [];
    if (!spots.length) return '';
    mmss = mmss || ((x) => `${Math.floor(x / 60)}:${String(Math.floor(x % 60)).padStart(2, '0')}`);
    const items = spots.map((h, i) => {
        const b = h.bounds || {}; const d = h.drill || {}; const ev = h.evidence || {};
        const range = (Number.isFinite(b.startSec) ? mmss(b.startSec) : '?')
            + '–' + (Number.isFinite(b.endSec) ? mmss(b.endSec) : '?');
        const drillable = d && Number.isFinite(d.loopA) && Number.isFinite(d.loopB) && d.loopB > d.loopA;
        const btn = drillable
            ? `<button class="coaching-drill-btn mt-2 px-3 py-1.5 bg-dark-600 hover:bg-dark-500 text-gray-200 rounded-lg text-xs font-semibold transition"
                   data-loop-a="${d.loopA}" data-loop-b="${d.loopB}" data-speed-mul="${d.speedMul}" data-goal="${d.goal}"
                   data-focus="${escapeHtml(range)}" data-key="${escapeHtml(h.key || '')}">&#9654; Drill this run</button>`
            : '';
        return `<li class="bg-dark-700/60 border border-gray-800 rounded-lg p-3">
            <div class="text-sm font-semibold text-gray-200">${i + 1}. ${escapeHtml(range)}</div>
            <p class="text-xs text-gray-400 mt-1">${ev.misses || 0} note${ev.misses === 1 ? '' : 's'} unregistered</p>
            ${btn}
        </li>`;
    }).join('');
    return `<h3 class="text-base font-semibold text-gold mt-4 mb-1">Unregistered runs</h3>`
        + `<p class="text-xs text-gray-400 mb-2">The detector heard no note here. On bass this is a mix of notes you flubbed and its low-string blind spot — it can't yet tell which. Drill the ones you know you missed; if you played them clean, it's the detection gap we're improving.</p>`
        + `<ul class="space-y-2">${items}</ul>`;
}

// ── Exports for tests ─────────────────────────────────────────────────
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        buildPlayFeedback, mistakeFromJudgment, findHotspots,
        FAILURE_TYPES, FAILURE_TYPES_LIVE, FAULT_VERDICTS,
        // LLM coach
        summarizeForCoach, buildCoachRequest, parseCoachSummary, requestCoaching,
        COACH_MODEL, COACH_SUMMARY_SCHEMA, COACH_SYSTEM,
        // settings + rendering
        makeSettings, escapeHtml, renderSummaryHtml, renderFeedbackHtml,
        renderBreakdownHtml, renderMissedNotesHtml, renderUnheardSpotsHtml, renderTimingHtml, _buildTimingReport, _midiName, _stringLabel,
        drillLadderFromSpeedMul, drillArgsFromDataset,
        // Skill-drill bridge: practice taxonomy (failure → skill → game) + the
        // skill-drill rep/streak engine. See docs/TEACHING_NARRATIVE.md.
        SKILL_DRILLS, FOUNDATIONAL_DRILLS, practiceForFailure, dominantFailure, deepLinkForGame, practiceForHotspot,
        createSkillDrill, skillDrillStep, skillDrillView, classifyFailureForDrill,
    };
}

// ── Browser wiring: accumulate judgments, build + emit on song end ────
// Opt-in (guarded on window). Consumes note_detect's existing events so this
// plugin never forks note_detect — exactly the "separate plugin consuming
// notedetect:* events" boundary. No UI yet: it emits `coaching:feedback`,
// logs the object, and stashes it on `window.__coachingLastFeedback`.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    (function () {
        // Claim the post-play surface: tell note_detect to stand down its
        // full-screen end-of-song modal (it still fires notedetect:session,
        // which feeds the panel below). Our dismissable panel is the single
        // post-play surface now; the diagnostic download lives on it.
        try { window.slopsmithSuppressNoteDetectSummary = true; } catch (_) {}

        // Publish the skill-drill taxonomy + mechanics for drill-game plugins.
        // Cross-plugin sharing only travels via a global (one script per plugin),
        // and coaching loads before the games alphabetically. See
        // docs/TEACHING_NARRATIVE.md. Games read window.slopsmithSkillDrills (or
        // the minigames SDK's `skillDrill`, which bridges to this).
        try {
            window.slopsmithSkillDrills = {
                SKILL_DRILLS, FOUNDATIONAL_DRILLS, practiceForFailure, dominantFailure, deepLinkForGame, practiceForHotspot,
                createSkillDrill, skillDrillStep, skillDrillView, classifyFailureForDrill,
            };
        } catch (_) {}

        let _judgments = [];
        const _reset = () => { _judgments = []; };
        // Accumulate this play's judgments — but NOT during a drill. A drill
        // loops one passage, re-judging the same notes every pass, so counting
        // them inflates a later full play's feedback (a note looped 16× showed
        // up as "missed 16×"). note_detect flags the drill via
        // window._ndAnyDrillActive; skip while it's set so the panel only ever
        // reflects a real full play, not the practice reps.
        const _push = (e) => {
            if (!e || !e.detail) return;
            try { if (window._ndAnyDrillActive) return; } catch (_) {}
            _judgments.push(e.detail);
        };
        window.addEventListener('notedetect:hit', _push);
        window.addEventListener('notedetect:miss', _push);
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            window.slopsmith.on('song:loaded', _reset);
        }
        window.addEventListener('notedetect:session', (e) => {
            const agg = (e && e.detail) || {};
            const hadJudgments = _judgments.length > 0;
            const feedback = buildPlayFeedback(_judgments, _gatherSessionMeta(agg));
            _reset();
            // A zero-judgment session is a false-start (press play, stop) or a
            // detect-off pass. Don't let it CLOBBER a panel that's already
            // showing a scored play — that overwrite ("99% play, then a 0% /
            // no-notes-scored panel appears") is what read as broken. If a
            // panel is already up, leave it; a fresh detect-off play with no
            // panel still gets the single calm message below.
            if (!hadJudgments && typeof document !== 'undefined'
                && document.getElementById('coaching-summary-panel')) {
                return;
            }
            try { if (window.slopsmith && window.slopsmith.emit) window.slopsmith.emit('coaching:feedback', feedback); } catch (_) {}
            try { console.log('[coaching] play feedback:', feedback); } catch (_) {}
            try { window.__coachingLastFeedback = feedback; } catch (_) {}
            // Always surface the free, no-key panel (score + hotspots +
            // Practice buttons) so the drill loop is visible without an API
            // key. If the LLM coach is enabled, it upgrades this panel in
            // place when the plan lands.
            _showFeedbackPanel(feedback);
            // Make the LLM path observable, and don't fire (or hang on
            // "Generating…") when there's nothing to coach. If the detector
            // heard nothing this play (coverage 0 — Detect off, dead input, a
            // silent/looped take) there's no signal for the coach: say so
            // instead of spending a call and leaving the status spinning.
            const heard = !!(feedback.session && feedback.session.detectionCoverage > 0);
            if (!heard) {
                // The feedback panel already explains "no notes scored" in one
                // place — don't stack a second alarm here (the double-message
                // read as "broken"). Just don't fire the coach: nothing to coach.
                _setLlmStatus('');
            } else if (settings.isEnabled()) {
                _setLlmStatus('Generating coaching plan with ' + settings.getModel() + '…');
                // Fire-and-forget. Never throws into the event loop; mutates
                // feedback.session.summary in place and emits when it lands.
                _coachIfEnabled(feedback);
            } else {
                _setLlmStatus('LLM coach off — add an Anthropic key in Settings → Coaching for a practice plan.');
            }
        });

        // localStorage-backed settings — the API key is a secret and stays here.
        // Same keys the settings.html panel reads/writes (see makeSettings()).
        let _settingsStore = null;
        try { _settingsStore = window.localStorage; } catch (_) {}
        const settings = makeSettings(_settingsStore);

        async function _coachIfEnabled(feedback) {
            if (!settings.isEnabled()) return null;
            // Bound the call so "Generating…" can't spin forever on a stalled
            // network / hung fetch.
            const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
            const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, 30000) : null;
            try {
                const summary = await requestCoaching(feedback, {
                    apiKey: settings.getApiKey(), model: settings.getModel(),
                    signal: ctrl ? ctrl.signal : undefined,
                });
                feedback.session.summary = summary;
                try { window.__coachingLastSummary = summary; } catch (_) {}
                try { if (window.slopsmith && window.slopsmith.emit) window.slopsmith.emit('coaching:summary', { feedback, summary }); } catch (_) {}
                try { console.log('[coaching] LLM practice plan:', summary); } catch (_) {}
                return summary;
            } catch (err) {
                const aborted = err && (err.name === 'AbortError' || /abort/i.test(err.message || ''));
                const msg = aborted ? 'timed out after 30s — try again' : ((err && err.message) || 'unknown error');
                try { console.warn('[coaching] LLM coach failed:', msg); } catch (_) {}
                try { _setLlmStatus('Coaching plan failed: ' + msg, true); } catch (_) {}
                try { if (window.slopsmith && window.slopsmith.emit) window.slopsmith.emit('coaching:summary-error', { feedback, error: msg }); } catch (_) {}
                return null;
            } finally {
                if (timer) clearTimeout(timer);
            }
        }

        // Visible LLM state — a single status line appended to the panel so
        // the coach is never a silent no-op. Idempotent: reuses the node.
        function _setLlmStatus(text, isError) {
            try {
                const panel = document.getElementById('coaching-summary-panel');
                if (!panel) return;
                let el = panel.querySelector('#coaching-llm-status');
                if (!el) {
                    el = document.createElement('div');
                    el.id = 'coaching-llm-status';
                    panel.appendChild(el);
                }
                el.className = 'mt-3 text-xs rounded-lg px-3 py-2 border '
                    + (isError ? 'border-red-700 bg-red-900/30 text-red-300' : 'border-gray-700 bg-dark-600 text-gray-400');
                el.textContent = text || '';
                el.style.display = text ? '' : 'none';
            } catch (_) {}
        }

        // End-of-song panel. Shared shell — create/update the single panel
        // element, then wire the close button and every "Practice this"
        // button to the drill conductor. Defensive + idempotent; uses only
        // core utilities so no plugin stylesheet is needed. Returns the
        // panel (or null if there's no host yet).
        function _renderPanel(innerHtml) {
            const host = document.getElementById('player') || document.body;
            if (!host) return null;
            let panel = document.getElementById('coaching-summary-panel');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'coaching-summary-panel';
                panel.className = 'fixed top-16 right-4 z-[150] w-96 max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] overflow-y-auto bg-dark-700 border border-gray-700 rounded-xl p-4 shadow-2xl';
                host.appendChild(panel);
            }
            // Diagnostic download lives here now (note_detect's modal, which
            // used to carry it, is suppressed). Only show it when the export
            // is actually reachable on the note_detect API.
            const canDiag = typeof window !== 'undefined' && window.noteDetect
                && typeof window.noteDetect.downloadDiagnostic === 'function';
            const diagBtn = canDiag
                ? '<button id="coaching-diag-dl" class="float-right mr-3 mt-1 text-[11px] text-gray-500 hover:text-accent">Download diagnostic</button>'
                : '';
            panel.innerHTML = '<button id="coaching-summary-close" class="float-right text-gray-500 hover:text-white text-lg leading-none">&times;</button>'
                + diagBtn + innerHtml;
            const close = panel.querySelector('#coaching-summary-close');
            if (close) close.onclick = () => { try { panel.remove(); } catch (_) {} };
            const diag = panel.querySelector('#coaching-diag-dl');
            if (diag) diag.onclick = () => { try { window.noteDetect.downloadDiagnostic(); } catch (_) {} };
            panel.querySelectorAll('.coaching-drill-btn').forEach((btn) => {
                btn.onclick = () => _startDrillFromButton(btn);
            });
            // If this play has ≥2 drillable trouble spots, offer a one-tap
            // session that drills them worst-first in sequence. Injected here
            // (not in the pure render fns) so both the no-key and LLM panels
            // get it; distinct class from .coaching-drill-btn so the per-spot
            // button count / tests are unaffected.
            try {
                const drillable = _drillableHotspots();
                if (drillable.length >= 2 && !panel.querySelector('#coaching-drill-all')) {
                    const allBtn = document.createElement('button');
                    allBtn.id = 'coaching-drill-all';
                    allBtn.className = 'block w-full mb-3 px-3 py-2 bg-accent hover:bg-accent-light text-white rounded-lg text-sm font-bold transition';
                    allBtn.innerHTML = '&#9654; Drill all ' + drillable.length + ' spots (worst first)';
                    allBtn.onclick = () => _startDrillAll();
                    const anchor = panel.querySelector('#coaching-diag-dl') || panel.querySelector('#coaching-summary-close');
                    if (anchor && anchor.nextSibling) panel.insertBefore(allBtn, anchor.nextSibling);
                    else panel.appendChild(allBtn);
                }
            } catch (_) {}
            return panel;
        }

        // The free, no-key panel built straight from PlayFeedback (score +
        // hotspots + Practice buttons). Shown at every song end so the drill
        // loop is reachable without the LLM coach.
        function _showFeedbackPanel(feedback) {
            try { if (feedback) _renderPanel(renderFeedbackHtml(feedback)); }
            catch (err) { try { console.warn('[coaching] feedback panel failed:', err && err.message); } catch (_) {} }
        }

        // The richer LLM-plan panel. Replaces the feedback panel in place
        // when the plan lands. Model output is escaped in renderSummaryHtml.
        function _showSummaryPanel(summary, feedback) {
            try {
                const fb = feedback || (typeof window !== 'undefined' ? window.__coachingLastFeedback : null);
                const hotspots = (fb && Array.isArray(fb.hotspots)) ? fb.hotspots : [];
                _renderPanel(renderSummaryHtml(summary, hotspots));
            } catch (err) {
                try { console.warn('[coaching] panel render failed:', err && err.message); } catch (_) {}
            }
        }

        // Click handler for a "Practice this" button: read the hotspot's drill
        // range off the data-attrs and hand it to note_detect's conductor. The
        // conductor (window.noteDetect.startDrill) owns the slowed A-B loop +
        // goal-gated speed ramp; coaching just supplies the where/how-slow.
        function _startDrillFromButton(btn) {
            const nd = (typeof window !== 'undefined') ? window.noteDetect : null;
            if (!nd || typeof nd.startDrill !== 'function') {
                btn.textContent = 'Drill needs note_detect ≥ 1.16';
                return;
            }
            const args = drillArgsFromDataset(btn.dataset);
            if (!args) { btn.textContent = 'No drill range'; return; }
            Promise.resolve(nd.startDrill(args.start, args.end, args.opts)).then((ok) => {
                // Collapse the panel so the highway is visible while drilling.
                if (ok) { try { const p = document.getElementById('coaching-summary-panel'); if (p) p.remove(); } catch (_) {} }
                else { btn.textContent = 'Couldn’t start drill'; }
            }).catch(() => { btn.textContent = 'Drill failed'; });
        }

        // ── "Drill all" session ──────────────────────────────────────────
        // Chain the worst-first hotspots into one guided run: drill spot 1 →
        // (nail, or Skip) → spot 2 → … → recap. Each spot reuses the SAME
        // note_detect conductor; we only orchestrate advancement by polling
        // its public isDrilling() — no note_detect changes, no drill-end event
        // needed. The stepper is inline-styled so a runtime-installed plugin
        // needs no stylesheet (arbitrary Tailwind values aren't in core's CSS).
        let _session = null;

        function _drillableHotspots() {
            const fb = (typeof window !== 'undefined') ? window.__coachingLastFeedback : null;
            const hs = (fb && Array.isArray(fb.hotspots)) ? fb.hotspots : [];
            // findHotspots already sorts by severity desc → worst-first.
            return hs.filter((h) => h && h.drill
                && Number.isFinite(h.drill.loopA) && Number.isFinite(h.drill.loopB)
                && h.drill.loopB > h.drill.loopA);
        }

        function _sessionStepperEl() {
            let el = document.getElementById('coaching-drill-session');
            if (!el) {
                el = document.createElement('div');
                el.id = 'coaching-drill-session';
                el.style.cssText = 'position:fixed;top:64px;left:50%;transform:translateX(-50%);'
                    + 'z-index:160;background:#1f2430;border:1px solid #4080e0;border-radius:12px;'
                    + 'padding:8px 14px;box-shadow:0 10px 30px rgba(0,0,0,.5);color:#e5e7eb;'
                    + 'font:14px system-ui;display:flex;align-items:center;gap:10px';
                (document.getElementById('player') || document.body).appendChild(el);
            }
            return el;
        }

        function _sessionRenderStepper(msg, opts) {
            opts = opts || {};
            const el = _sessionStepperEl();
            const b = (id, label, bg) => `<button id="${id}" style="padding:4px 10px;border:0;border-radius:6px;`
                + `background:${bg};color:#fff;font:600 12px system-ui;cursor:pointer">${label}</button>`;
            el.innerHTML = '<span>' + msg + '</span>'
                + (opts.showSkip ? b('coaching-sess-skip', 'Skip &#9654;', '#3a4150') : '')
                + (opts.showAgain ? b('coaching-sess-again', '&#9654; Again', '#4080e0') : '')
                + b('coaching-sess-end', '&times; End', '#3a4150');
            const wire = (id, fn) => { const n = el.querySelector('#' + id); if (n) n.onclick = fn; };
            wire('coaching-sess-skip', _sessionSkip);
            wire('coaching-sess-again', _startDrillAll);
            wire('coaching-sess-end', () => _sessionEnd());
        }

        function _sessionClearStepper() {
            const el = document.getElementById('coaching-drill-session');
            if (el) { try { el.remove(); } catch (_) {} }
        }

        function _startDrillAll() {
            const nd = (typeof window !== 'undefined') ? window.noteDetect : null;
            if (!nd || typeof nd.startDrill !== 'function') return;
            const queue = _drillableHotspots();
            if (!queue.length) return;
            // Collapse the feedback panel so the highway is visible for the run.
            try { const p = document.getElementById('coaching-summary-panel'); if (p) p.remove(); } catch (_) {}
            _sessionStop();
            _session = { queue, idx: 0, ended: false, sawDrilling: false, timer: null, advTimer: null };
            _sessionStartSpot(0);
        }

        function _sessionStartSpot(i) {
            const nd = window.noteDetect;
            const s = _session;
            if (!s || !nd) return;
            s.idx = i;
            s.sawDrilling = false;
            const n = s.queue.length;
            const h = s.queue[i];
            const args = drillArgsFromDataset({
                loopA: h.drill.loopA, loopB: h.drill.loopB,
                speedMul: h.drill.speedMul, goal: h.drill.goal,
                key: 'Spot ' + (i + 1) + '/' + n,
            });
            _sessionRenderStepper('🎯 Drilling spot <b>' + (i + 1) + '</b> of ' + n + '…', { showSkip: true });
            Promise.resolve(args ? nd.startDrill(args.start, args.end, args.opts) : false).then((ok) => {
                if (!_session || _session !== s) return;
                if (!ok) { _sessionAdvance(); return; }   // couldn't arm this spot — skip it
                _sessionStartPoll();
            }).catch(() => { if (_session === s) _sessionAdvance(); });
        }

        function _sessionStartPoll() {
            const s = _session;
            if (!s) return;
            if (s.timer) { clearInterval(s.timer); s.timer = null; }
            s.timer = setInterval(() => {
                const nd = window.noteDetect;
                if (!_session || _session !== s || !nd) return;
                const drilling = (typeof nd.isDrilling === 'function') ? nd.isDrilling() : false;
                if (drilling) { s.sawDrilling = true; return; }
                if (s.sawDrilling) {   // was drilling, now stopped → this spot ended (nailed or closed)
                    clearInterval(s.timer); s.timer = null;
                    _sessionSpotEnded();
                }
            }, 600);
        }

        function _sessionSpotEnded() {
            const s = _session;
            if (!s || s.ended) return;
            if (s.idx + 1 >= s.queue.length) { _sessionFinish(); return; }
            _sessionRenderStepper('✓ Spot ' + (s.idx + 1) + ' done — next in a moment…', { showSkip: false });
            s.advTimer = setTimeout(() => { if (_session === s && !s.ended) _sessionAdvance(); }, 1100);
        }

        function _sessionAdvance() {
            const s = _session;
            if (!s || s.ended) return;
            if (s.advTimer) { clearTimeout(s.advTimer); s.advTimer = null; }
            const next = s.idx + 1;
            if (next >= s.queue.length) { _sessionFinish(); return; }
            _sessionStartSpot(next);
        }

        function _sessionSkip() {
            const nd = window.noteDetect;
            try { if (nd && typeof nd.endDrill === 'function') nd.endDrill('session-skip'); } catch (_) {}
            const s = _session;
            if (!s) return;
            if (s.timer) { clearInterval(s.timer); s.timer = null; }
            _sessionAdvance();
        }

        function _sessionFinish() {
            const s = _session;
            if (!s) return;
            if (s.timer) { clearInterval(s.timer); s.timer = null; }
            if (s.advTimer) { clearTimeout(s.advTimer); s.advTimer = null; }
            const n = s.queue.length;
            s.ended = true;
            _sessionRenderStepper('✓ Session done — drilled <b>' + n + '</b> spot' + (n === 1 ? '' : 's') + '.', { showAgain: true });
            _session = null;
        }

        function _sessionEnd() {
            const nd = window.noteDetect;
            try { if (nd && typeof nd.endDrill === 'function') nd.endDrill('session-end'); } catch (_) {}
            _sessionStop();
            _sessionClearStepper();
        }

        function _sessionStop() {
            const s = _session;
            if (s) {
                if (s.timer) { clearInterval(s.timer); s.timer = null; }
                if (s.advTimer) { clearTimeout(s.advTimer); s.advTimer = null; }
                s.ended = true;
            }
            _session = null;
        }

        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            window.slopsmith.on('coaching:summary', (ev) => {
                // feedBack's window.feedBack bus is an EventTarget: on()
                // delivers a CustomEvent with the payload on `.detail`.
                // slopsmith's bus passed the payload directly. Accept both.
                const p = (ev && ev.detail) ? ev.detail : ev;
                if (p && p.summary) _showSummaryPanel(p.summary, p && p.feedback);
            });
        }

        // Console / inter-plugin API. Settings + manual triggers; the panel
        // mirrors what the settings.html UI writes.
        try {
            window.coaching = Object.assign(window.coaching || {}, {
                getApiKey: settings.getApiKey, setApiKey: settings.setApiKey,
                getModel: settings.getModel, setModel: settings.setModel,
                isEnabled: settings.isEnabled, setEnabled: settings.setEnabled,
                requestCoaching, summarizeForCoach, buildCoachRequest, parseCoachSummary, renderSummaryHtml,
                showSummaryPanel: _showSummaryPanel,
                showFeedbackPanel: _showFeedbackPanel,
                renderFeedbackHtml,
                // Manually pop the panel for the last play — handy for testing
                // the drill buttons without replaying.
                showLast: () => _showFeedbackPanel(window.__coachingLastFeedback),
                coachLast: () => _coachIfEnabled(window.__coachingLastFeedback),
                // Kick the worst-first drill-all session for the last play.
                drillAll: () => _startDrillAll(),
                endDrillSession: () => _sessionEnd(),
            });
        } catch (_) {}

        function _gatherSessionMeta(agg) {
            const nd = window.noteDetect;
            let settings = null, song = agg.song || null, arrangement = agg.arrangement || null;
            let recording = null, tuning = agg.tuning || null, capo = agg.capo;
            try {
                if (nd && nd.getDiagnostic) {
                    const d = nd.getDiagnostic() || {};
                    settings = d.settings || null;
                    if (d.song) {
                        song = song || d.song.title || null;
                        arrangement = arrangement || d.song.arrangement || null;
                        tuning = tuning || d.song.tuning || null;
                        if (capo == null) capo = d.song.capo;
                    }
                }
            } catch (_) {}
            try { if (nd && nd.getRecordingState) { const r = nd.getRecordingState() || {}; recording = { wavPath: r.lastSavePath || null }; } } catch (_) {}
            return { song, arrangement, settings, recording, tuning, capo, sections: agg.sections || [] };
        }
    })();
}
