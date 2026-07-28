// Pitch Match — the intonation skill-drill game (docs/TEACHING_NARRATIVE.md).
//
// Trains INTONATION: coaching flags notes that read `sharp` / `flat` (off the
// charted pitch) and points an intonation hotspot here. This is the second
// game proving the failure → skill → game → shared-rep-engine contract, after
// mute_master.
//
// Design mirrors mute_master (chart-free, self-paced, the SDK's own mic+YIN via
// `scoring.createContinuous`, and the SHARED rep/streak/pass engine bridged as
// `sdk.skillDrill`). One target note at a time; you hold it, and on release we
// judge the MEDIAN cents over the held note — landing within ±CLEAN_CENTS is a
// clean rep, sharp/flat is a miss. Judging the held median (not the attack
// transient, which is noisy) is the one design difference from mute_master.
// Eight clean in a row wins. Skin is thin; swap it freely.
(function () {
    'use strict';

    const GAME_ID = 'pitch_match';
    const GOAL_STREAK = 8;
    const CONF_MIN = 0.5;         // YIN confidence floor — low bass rarely clears 0.85 (note_detect's floor is 0.20)
    const CLEAN_CENTS = 15;       // within this of the target = in tune
    const CAPTURE_CENTS = 70;     // within this of the target (octave-folded) = an attempt AT this note
    const MIN_HOLD = 3;           // frames needed before a note is judged

    // A few comfortable fretted bass targets (MIDI). Rotated deterministically
    // so the prompt sequence is stable (no Math.random dependency).
    const STRINGS = [
        { name: 'E', openMidi: 28 },
        { name: 'A', openMidi: 33 },
        { name: 'D', openMidi: 38 },
        { name: 'G', openMidi: 43 },
    ];
    const FRETS = [0, 2, 3, 5, 7];
    const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const midiName = (m) => NOTE[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
    const median = (xs) => {
        if (!xs.length) return 0;
        const s = xs.slice().sort((a, b) => a - b);
        const m = s.length >> 1;
        return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    // Cents from the target, folded to the NEAREST octave. The scorer's YIN
    // (minHz 70) reports the octave-up harmonic on low bass, so raw cents can be
    // ~1200 off; folding makes a correct note read near 0 (as note_detect does).
    const _foldCents = (midi, targetMidi) => { const c = (midi - targetMidi) * 100; return c - Math.round(c / 1200) * 1200; };

    let _sdk = null, _cont = null, _drill = null, _sd = null;
    let _startedAt = 0, _finished = false;
    let _target = null;           // { stringName, fret, targetMidi }
    let _hold = [];               // cents-from-target samples for the current note
    let _lastPitch = null;        // last pitch frame, for the live "heard" readout
    let _container = null;

    function _updateHeard(p) {
        const el = _container && _container.querySelector('#pm-heard');
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

    function _nextTarget(ev) {
        const i = _drill ? _drill.reps : 0;
        const s = STRINGS[i % STRINGS.length];
        const fret = FRETS[(Math.floor(i / STRINGS.length)) % FRETS.length];
        _target = { stringName: s.name, fret, targetMidi: s.openMidi + fret };
        _hold = [];
        _render(ev);   // keep the just-judged feedback flash while showing the next target
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
            _message('Pitch Match needs the coaching + minigames plugins to score intonation.');
            return;
        }
        // One canonical drill key for both sharp & flat — the engine trains one
        // axis; the skin shows the direction. (createSkillDrill compares a single
        // failureType, so sharp/flat must collapse to one key here.)
        _drill = _sd.createSkillDrill({ failureType: 'intonation', goalStreak: GOAL_STREAK });
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
        const cents = _foldCents(midi, _target.targetMidi);   // octave-folded deviation
        const onTarget = isFinite(midi) && p.confidence >= CONF_MIN && Math.abs(cents) <= CAPTURE_CENTS;
        if (onTarget) {
            // Accumulate octave-folded cents while the note is held & confident.
            _hold.push(cents);
            return;
        }
        // Release / off-target: judge the held note (median cents) if we got a
        // real sustain; otherwise discard (a blip, not an attempt).
        if (_hold.length >= MIN_HOLD) {
            const cents = Math.round(median(_hold));
            const clean = Math.abs(cents) <= CLEAN_CENTS;
            const ev = clean
                ? { hit: true, cents }
                : { hit: false, failureType: 'intonation', dir: cents > 0 ? 'sharp' : 'flat', cents };
            _hold = [];
            _sd.skillDrillStep(_drill, ev);
            const view = _sd.skillDrillView(_drill);
            if (view.passed) { _render(ev); _finish(); }
            else _nextTarget(ev);
        } else {
            _hold = [];
        }
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
                meta: { skill: 'intonation', failureType: 'intonation', view },
            });
        }
    }

    function stop() {
        try { if (_cont) _cont.stop(); } catch (_) {}
        _cont = null; _drill = null; _finished = true;
    }

    // ── Thin reference skin ────────────────────────────────────────────────
    function _message(msg) {
        if (!_container) return;
        _container.innerHTML = `<div style="padding:2rem;text-align:center;color:#cbd5e1;font:14px system-ui">${msg}</div>`;
    }

    function _render(ev, passed) {
        if (!_container) return;
        const view = (_sd && _drill) ? _sd.skillDrillView(_drill) : { streak: 0, goalStreak: GOAL_STREAK, clean: 0, reps: 0, bestStreak: 0 };
        const pips = Array.from({ length: view.goalStreak }, (_, i) =>
            `<span style="display:inline-block;width:16px;height:16px;border-radius:50%;margin:0 3px;background:${i < view.streak ? '#e8c040' : '#3a3f4b'}"></span>`).join('');
        let flash = `<div style="height:1.4rem">&nbsp;</div>`;
        if (ev && ev.hit) {
            flash = `<div style="color:#7ddb7d;font-weight:700;font-size:1.1rem">✓ in tune (${ev.cents > 0 ? '+' : ''}${ev.cents}c)</div>`;
        } else if (ev && ev.failureType === 'intonation') {
            const word = ev.dir === 'sharp' ? 'sharp' : 'flat';
            flash = `<div style="color:#ff5555;font-weight:800;font-size:1.1rem">✗ ${ev.cents > 0 ? '+' : ''}${ev.cents}c ${word} — ${ev.dir === 'sharp' ? 'ease off / tune down' : 'press firmly / tune up'}</div>`;
        }
        const prompt = passed
            ? `<div style="color:#7ddb7d;font-weight:800;font-size:1.5rem">✓ Intonation locked in!</div>`
            : (_target
                ? `<div style="font-size:2.2rem;font-weight:800;color:#e5e7eb">${_target.stringName} string · ${_target.fret === 0 ? 'open' : 'fret ' + _target.fret}</div>
                   <div style="color:#9ca3af;margin-top:.2rem">play <b style="color:#e8c040">${midiName(_target.targetMidi)}</b> and hold it — land it dead in tune</div>`
                : '');
        _container.innerHTML = `
          <div style="padding:1.5rem;text-align:center;color:#e5e7eb;font:14px system-ui">
            <div style="font-size:1.1rem;font-weight:800;color:#e8c040;margin-bottom:1rem">Pitch Match</div>
            ${prompt}
            <div style="margin:1.25rem 0 .5rem">${pips}</div>
            <div style="color:#9ca3af">streak <b style="color:#e5e7eb">${view.streak}</b>/${view.goalStreak}
              · clean <b style="color:#e5e7eb">${view.clean}</b>/${view.reps}
              · best <b style="color:#e5e7eb">${view.bestStreak}</b></div>
            <div style="margin-top:.5rem;min-height:1.4rem">${flash}</div>
            <div id="pm-heard" style="font-size:10px;color:#6b7280;margin-top:.5rem">🎧 listening…</div>
          </div>`;
        _updateHeard(_lastPitch);
    }

    // ── Register (safe late-binding: we may load before the SDK) ───────────
    const spec = {
        id: GAME_ID,
        title: 'Pitch Match',
        tagline: 'Land it dead in tune',
        skill: 'intonation',
        trains: ['sharp', 'flat'],
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
