// Mute Master — the first skill-drill game (docs/TEACHING_NARRATIVE.md).
//
// Trains MUTING on bass: when you fret a note, the OPEN string under it must not
// ring. coaching's taxonomy points a `mute_fail` hotspot here, so this is the
// game a muting slip deep-links into — the skill → game → SHARED
// rep/streak/pass half of the contract.
//
// HONEST SCOPE — this game infers muting from a self-contained MONOPHONIC pitch
// scorer (`scoring.createContinuous` — its own mic + YIN), NOT from note_detect:
// note_detect does not currently emit a `mute_fail` judgment, so the detector→
// mute_fail leg of the taxonomy is aspirational. A mono detector can't truly
// prove an open string is silent (it reports one dominant pitch), and octave
// folding collapses pitch to pitch-class, so muting is only scoreable on
// targets whose pitch class differs from every open string (see VALID_TARGETS)
// — a best-effort proxy, not ground truth. Real mute verification needs a
// polyphonic/spectral signal note_detect would have to produce.
//
// Design per the "fast iteration, no lead-in, no slow animations" steer: it is
// CHART-FREE and self-paced. It prompts one fret target at a time and scores
// each note the instant you play it:
//   - you hit the target pitch        → a CLEAN muting rep
//   - the OPEN string rings instead   → a mute_fail (you didn't mute it)
// New target immediately, no count-in, no transitions. Eight clean in a row wins.
//
// The rep/streak/pass loop is the SHARED engine (createSkillDrill / step / view)
// published by coaching and bridged through the minigames SDK as `sdk.skillDrill`
// — this file owns only the wiring + a thin skin. Swap the skin freely.
(function () {
    'use strict';

    const GAME_ID = 'mute_master';
    const GOAL_STREAK = 8;
    // YIN confidence floor to accept a note. Was 0.85, which low bass notes
    // rarely clear (note_detect's own floor is 0.20) — so every attempt got
    // silently dropped and the game looked dead. 0.5 keeps out noise while
    // accepting real bass. The live input readout shows the actual confidence.
    const CONF_MIN = 0.5;
    const NEAR_SEMITONES = 0.6;   // how close counts as "that pitch"

    // Standard 4-string bass open strings (MIDI). The low strings are where
    // open-string bleed under a fretted note actually bites.
    const STRINGS = [
        { name: 'E', openMidi: 28 },
        { name: 'A', openMidi: 33 },
        { name: 'D', openMidi: 38 },
    ];
    const CAND_FRETS = [2, 3, 4, 5, 6, 7, 8, 9];   // candidate frets, filtered below
    const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const midiName = (m) => NOTE[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
    // Nearest-OCTAVE semitone distance. The continuous scorer's YIN (minHz 70)
    // can't lock a bass fundamental (open E ≈ 41 Hz) and reports the octave-up
    // harmonic instead, so a played note reads ~12 semitones off its true MIDI.
    // Fold to the nearest octave (as note_detect does) so a correct note still
    // matches. The catch: folding collapses pitch to pitch-CLASS, so a target
    // that shares a class with ANY open string is indistinguishable from that
    // open ringing — the muting signal we're trying to score. See VALID_TARGETS.
    const _foldSemi = (a, b) => { let d = a - b; d -= Math.round(d / 12) * 12; return Math.abs(d); };

    // Every open string, for collision checks (E A D G — G isn't prompted but
    // its open can still bleed and alias a fretted target).
    const BASS_OPENS = [28, 33, 38, 43];
    // Exclude only EXACT pitch-class unisons with an open string (< 1 semitone
    // after folding). Anything ≥1 semitone from every open is safely
    // distinguishable at the NEAR_SEMITONES=0.6 match threshold.
    const SEP_SEMITONES = 1.0;
    // A monophonic detector under octave-folding can only score muting on a
    // target whose pitch class differs from every open string — otherwise
    // "fretted note, opens muted" reads identically to "that open rang", and a
    // failed mute scores as clean. Precompute the scoreable (string, fret) set
    // once (E-fret5 == open A, E-fret3 == open G one octave up, etc. drop out).
    const VALID_TARGETS = [];
    for (const s of STRINGS) {
        for (const fret of CAND_FRETS) {
            const midi = s.openMidi + fret;
            const collides = BASS_OPENS.some(o => o !== s.openMidi && _foldSemi(midi, o) < SEP_SEMITONES);
            if (!collides) VALID_TARGETS.push({ stringName: s.name, fret, targetMidi: midi, openMidi: s.openMidi });
        }
    }

    let _sdk = null, _cont = null, _drill = null, _sd = null;
    let _startedAt = 0, _finished = false;
    let _target = null;           // { stringName, fret, targetMidi, openMidi }
    let _armed = true;            // ready to count the next attack (debounce)
    let _lastPitch = null;        // last pitch frame, for the live "heard" readout
    let _container = null;

    // Live input indicator so the player can see the scorer IS hearing them.
    function _updateHeard(p) {
        const el = _container && _container.querySelector('#mm-heard');
        if (!el) return;
        if (p && p.freqHz > 0 && isFinite(p.midiFloat) && p.confidence >= CONF_MIN) {
            el.textContent = `🎧 heard ${midiName(p.midiFloat)} · ${p.freqHz.toFixed(0)} Hz`;
            el.style.color = '#7ddb7d';
        } else {
            el.textContent = '🎧 listening…';
            el.style.color = '#6b7280';
        }
    }

    function _mechanics(sdk) {
        return (sdk && sdk.skillDrill) || (typeof window !== 'undefined' ? window.slopsmithSkillDrills : null);
    }

    function _nextTarget() {
        // Rotate through the scoreable targets by rep index (no Math.random
        // dependency, deterministic rotation). VALID_TARGETS already excludes
        // any pitch that aliases an open string under octave folding.
        const i = _drill ? _drill.reps : 0;
        _target = VALID_TARGETS[i % VALID_TARGETS.length];
        _armed = true;
        _render();
    }

    function scoreFromView(v) {
        if (!v) return 0;
        return (v.clean * 100) + (v.bestStreak * 50) + (v.passed ? 500 : 0);
    }

    async function start(ctx) {
        _sdk = (ctx && ctx.sdk) || (typeof window !== 'undefined' ? window.slopsmithMinigames : null);
        _container = ctx && ctx.container;
        _finished = false;
        _startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
        _sd = _mechanics(_sdk);
        if (!_sd || !_sdk || !_sdk.scoring || typeof _sdk.scoring.createContinuous !== 'function') {
            _message('Mute Master needs the coaching + minigames plugins to score muting.');
            return;
        }
        _drill = _sd.createSkillDrill({ failureType: 'mute_fail', goalStreak: GOAL_STREAK });
        _nextTarget();

        _cont = _sdk.scoring.createContinuous({});
        _cont.on('pitch', _onPitch);
        _cont.on('end', () => { if (!_finished) _finish(); });
    }

    function _onPitch(p) {
        if (_finished || !p) return;
        _lastPitch = p;
        _updateHeard(p);
        if (!_target) return;
        const midi = p.midiFloat;
        const conf = p.confidence;
        // Re-arm on a clear release (quiet / unconfident) so a sustained note is
        // ONE rep, and the next attack is counted fresh. No timers, no delay.
        if (!(conf >= CONF_MIN) || !isFinite(midi)) { _armed = true; return; }
        if (!_armed) return;

        // Octave-tolerant: fold to the nearest octave so an octave-up harmonic
        // still matches the target / open string (see _foldSemi).
        const dTarget = _foldSemi(midi, _target.targetMidi);
        const dOpen = _foldSemi(midi, _target.openMidi);
        let ev = null;
        if (dTarget <= NEAR_SEMITONES) ev = { hit: true, failureType: null };           // muted clean → fretted note sounds
        else if (_target.targetMidi !== _target.openMidi && dOpen <= NEAR_SEMITONES) ev = { hit: false, failureType: 'mute_fail' }; // open rang
        if (!ev) return;   // some other pitch (wrong fret / noise) — not a muting rep

        _armed = false;    // consumed this attack; wait for release
        _sd.skillDrillStep(_drill, ev);
        const view = _sd.skillDrillView(_drill);
        _render(ev);
        if (view.passed) _finish();
        else _nextTarget();
    }

    function _finish() {
        if (_finished) return;
        _finished = true;
        const view = (_sd && _drill) ? _sd.skillDrillView(_drill) : null;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
        try { if (_cont) _cont.stop(); } catch (_) {}
        _cont = null;
        if (view) _render(null, view.passed);
        if (_sdk && typeof _sdk.end === 'function') {
            _sdk.end({
                score: scoreFromView(view),
                durationMs: Math.max(0, Math.round(now - _startedAt)),
                meta: { skill: 'muting', failureType: 'mute_fail', view },
            });
        }
    }

    function stop() {
        try { if (_cont) _cont.stop(); } catch (_) {}
        _cont = null; _drill = null; _finished = true;
    }

    // ── Thin reference skin (instant updates, no transitions) ──────────────
    function _message(msg) {
        if (!_container) return;
        _container.innerHTML = `<div style="padding:2rem;text-align:center;color:#cbd5e1;font:14px system-ui">${msg}</div>`;
    }

    function _render(ev, passed) {
        if (!_container) return;
        const view = (_sd && _drill) ? _sd.skillDrillView(_drill) : { streak: 0, goalStreak: GOAL_STREAK, clean: 0, reps: 0, bestStreak: 0 };
        const pips = Array.from({ length: view.goalStreak }, (_, i) =>
            `<span style="display:inline-block;width:16px;height:16px;border-radius:50%;margin:0 3px;background:${i < view.streak ? '#e8c040' : '#3a3f4b'}"></span>`).join('');
        const flash = ev && ev.failureType === 'mute_fail'
            ? `<div style="color:#ff5555;font-weight:800;font-size:1.1rem">✗ open ${_target ? _target.stringName : ''} rang — mute it</div>`
            : (ev && ev.hit ? `<div style="color:#7ddb7d;font-weight:700;font-size:1.1rem">✓ clean</div>` : `<div style="height:1.4rem">&nbsp;</div>`);
        const prompt = passed
            ? `<div style="color:#7ddb7d;font-weight:800;font-size:1.5rem">✓ Muting locked in!</div>`
            : (_target
                ? `<div style="font-size:2.2rem;font-weight:800;color:#e5e7eb">${_target.stringName} string · fret ${_target.fret}</div>
                   <div style="color:#9ca3af;margin-top:.2rem">play <b style="color:#e8c040">${midiName(_target.targetMidi)}</b> — keep the open ${_target.stringName} silent</div>`
                : '');
        _container.innerHTML = `
          <div style="padding:1.5rem;text-align:center;color:#e5e7eb;font:14px system-ui">
            <div style="font-size:1.1rem;font-weight:800;color:#e8c040;margin-bottom:1rem">Mute Master</div>
            ${prompt}
            <div style="margin:1.25rem 0 .5rem">${pips}</div>
            <div style="color:#9ca3af">streak <b style="color:#e5e7eb">${view.streak}</b>/${view.goalStreak}
              · clean <b style="color:#e5e7eb">${view.clean}</b>/${view.reps}
              · best <b style="color:#e5e7eb">${view.bestStreak}</b></div>
            <div style="margin-top:.5rem;min-height:1.4rem">${flash}</div>
            <div id="mm-heard" style="font-size:10px;color:#6b7280;margin-top:.5rem">🎧 listening…</div>
          </div>`;
        _updateHeard(_lastPitch);
    }

    // ── Register (safe late-binding: we may load before the SDK) ───────────
    const spec = {
        id: GAME_ID,
        title: 'Mute Master',
        tagline: 'Kill the open-string ring',
        skill: 'muting',
        trains: ['mute_fail'],
        start,
        stop,
    };
    if (typeof window !== 'undefined') {
        if (window.slopsmithMinigames && typeof window.slopsmithMinigames.register === 'function') {
            window.slopsmithMinigames.register(spec);
        } else {
            (window.__slopsmithMinigamesPending = window.__slopsmithMinigamesPending || []).push(spec);
        }
    }
})();
