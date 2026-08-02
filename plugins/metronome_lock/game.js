// Metronome Lock — the timing skill-drill game (docs/TEACHING_NARRATIVE.md).
//
// Trains TIMING: coaching flags notes landing `late` / `early` (off the beat)
// and points a timing hotspot here. Third game on the failure → skill → game →
// shared-rep-engine contract, after mute_master (muting) and pitch_match
// (intonation).
//
// Design follows the others (chart-free, self-paced, the SDK's own mic+YIN via
// `scoring.createContinuous`, and the SHARED rep/streak/pass engine bridged as
// `sdk.skillDrill`) plus a Web-Audio metronome and onset timing. A click runs
// at a chosen tempo; play ONE note per beat. On each onset we measure the error
// to the nearest grid point — within ±WINDOW is a clean rep, else late/early.
// Eight clean in a row wins.
//
// Modifiers (from the "biggest improvement on bass" bass-drill research —
// timing was the #1 answer):
//   • CLICK MODE — straight (every beat), backbeat (only 2 & 4, the Carol Kaye
//     groove trick), or eighths (every 8th). The scoring grid follows the mode.
//   • DROPPED BEAT — the top-voted technique: the click mutes for two bars then
//     returns, so you have to hold your own pocket through the silence; the beat
//     grid + scoring keep running underneath, so drift shows the moment a note
//     lands and audibly when the click comes back. Beat 1 stays accented.
//
// Clock: createContinuous stamps each pitch frame with `tMs = performance.now()`
// and the metronome grid is anchored in the same performance.now() clock, so
// onset-vs-grid is a direct subtraction. The detector adds a roughly constant
// analysis latency between the physical pluck and the first confident frame; we
// subtract DETECT_LATENCY_MS so the drill reads true rush/drag rather than a
// constant lateness. That constant is approximate — tune it if your rig reads
// systematically late/early on dead-on playing.
(function () {
    'use strict';

    const GAME_ID = 'metronome_lock';
    const GOAL_STREAK = 8;
    const CONF_MIN = 0.85;        // YIN confidence to accept a note onset
    const RELEASE_MS = 60;        // sub-threshold must persist this long to re-arm
    const WINDOW_MS = 70;         // within this of the grid point = on time (generous v1)
    const DETECT_LATENCY_MS = 45; // approx pluck → first-confident-frame lag, removed
    const BPMS = [60, 80, 100];   // selectable tempos
    const SCHED_INTERVAL_MS = 25; // metronome lookahead scheduler tick
    const LOOKAHEAD_S = 0.1;      // schedule clicks this far ahead
    const BEATS_PER_BAR = 4;      // assume 4/4 for backbeat + drop cycling
    const DROP_ON_BARS = 2;       // dropped-beat cycle: N bars audible …
    const DROP_OFF_BARS = 2;      // … then N bars muted (grid keeps running)

    let _sdk = null, _cont = null, _drill = null, _sd = null;
    let _startedAt = 0, _finished = false;
    let _container = null;
    let _armed = true;            // ready to count the next attack (debounce)
    let _releaseSince = null;     // tMs the note first dropped below CONF_MIN (release debounce)
    let _lastEv = null;           // last judged event, for the skin

    // Metronome state.
    let _clickCtx = null, _bpm = 80, _beatPeriodMs = 750;
    let _metronomeRun = 0;        // token: a newer _startMetronome/_stopMetronome supersedes older awaits
    let _clickMode = 'straight';  // 'straight' | 'backbeat' | 'eighths'
    let _dropOn = false;          // dropped-beat modifier
    let _subdivPerBeat = 1, _subdivPeriodMs = 750;   // scoring/tick grid
    let _anchorPerf = 0, _anchorAudio = 0, _nextTickAudio = 0, _tickNum = 0, _schedTimer = null;

    function _mechanics(sdk) {
        return (sdk && sdk.skillDrill) || (typeof window !== 'undefined' ? window.slopsmithSkillDrills : null);
    }

    function scoreFromView(v) {
        if (!v) return 0;
        return (v.clean * 100) + (v.bestStreak * 50) + (v.passed ? 500 : 0);
    }

    // ── Metronome (Web Audio, lookahead-scheduled for sample-accurate clicks) ──
    // Ticks at the SUBDIVISION rate; audibility per tick depends on the click
    // mode + dropped-beat phase. The scoring grid IS the subdivision grid.
    function _tickInfo(n) {
        const beatIndex = Math.floor(n / _subdivPerBeat);
        const posInBeat = n % _subdivPerBeat;             // 0 = on the beat
        const beatInBar = ((beatIndex % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR; // 0..3 = beats 1..4
        const barIndex = Math.floor(beatIndex / BEATS_PER_BAR);
        const accent = posInBeat === 0 && beatInBar === 0;
        // Dropped-beat: mute the audible click during the OFF bars of the cycle,
        // but keep the grid running underneath so scoring never pauses.
        const cycle = DROP_ON_BARS + DROP_OFF_BARS;
        const muted = _dropOn && ((barIndex % cycle) >= DROP_ON_BARS);
        let audibleByMode;
        if (_clickMode === 'eighths')      audibleByMode = true;                       // every subdivision
        else if (_clickMode === 'backbeat') audibleByMode = posInBeat === 0 && (beatInBar === 1 || beatInBar === 3); // 2 & 4
        else                                audibleByMode = posInBeat === 0;           // straight: every beat
        return { audible: audibleByMode && !muted, accent };
    }

    function _click(atAudio, accent) {
        if (!_clickCtx) return;
        const o = _clickCtx.createOscillator();
        const g = _clickCtx.createGain();
        o.frequency.value = accent ? 1600 : 1000;
        g.gain.setValueAtTime(0.0001, atAudio);
        g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, atAudio + 0.001);
        g.gain.exponentialRampToValueAtTime(0.0001, atAudio + 0.05);
        o.connect(g); g.connect(_clickCtx.destination);
        o.start(atAudio); o.stop(atAudio + 0.06);
    }

    function _scheduler() {
        if (!_clickCtx) return;
        while (_nextTickAudio < _clickCtx.currentTime + LOOKAHEAD_S) {
            const info = _tickInfo(_tickNum);
            if (info.audible) _click(_nextTickAudio, info.accent);
            _nextTickAudio += _subdivPeriodMs / 1000;
            _tickNum++;
        }
    }

    async function _startMetronome(bpm) {
        _stopMetronome();
        const run = ++_metronomeRun;   // claim this run; a later start/stop invalidates us
        _bpm = bpm;
        _beatPeriodMs = 60000 / bpm;
        _subdivPerBeat = (_clickMode === 'eighths') ? 2 : 1;
        _subdivPeriodMs = _beatPeriodMs / _subdivPerBeat;
        const AC = window.AudioContext || window.webkitAudioContext;
        const ctx = new AC();
        try { await ctx.resume(); } catch (_) {}
        // A newer _startMetronome (rapid BPM/mode/drop changes) or a _stopMetronome
        // ran while we awaited resume() — abandon this stale context so we don't
        // leave two schedulers ticking at once.
        if (run !== _metronomeRun) { try { ctx.close(); } catch (_) {} return; }
        _clickCtx = ctx;
        const lead = 0.25;   // small runway before tick 0
        _anchorAudio = _clickCtx.currentTime + lead;
        _anchorPerf = performance.now() + lead * 1000;
        _nextTickAudio = _anchorAudio;
        _tickNum = 0;
        _armed = true;
        _releaseSince = null;
        _schedTimer = setInterval(_scheduler, SCHED_INTERVAL_MS);
    }

    function _stopMetronome() {
        _metronomeRun++;   // invalidate any _startMetronome currently awaiting resume()
        if (_schedTimer) { clearInterval(_schedTimer); _schedTimer = null; }
        try { if (_clickCtx) _clickCtx.close(); } catch (_) {}
        _clickCtx = null;
    }

    function _setBpm(bpm) { if (!_finished) { _startMetronome(bpm); _render(); } }
    function _setMode(mode) { if (!_finished) { _clickMode = mode; _startMetronome(_bpm); _render(); } }
    function _toggleDrop() { if (!_finished) { _dropOn = !_dropOn; _startMetronome(_bpm); _render(); } }

    async function start(ctx) {
        _sdk = (ctx && ctx.sdk) || (typeof window !== 'undefined' ? window.slopsmithMinigames : null);
        _container = ctx && ctx.container;
        _finished = false;
        _lastEv = null;
        _startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
        _sd = _mechanics(_sdk);
        if (!_sd || !_sdk || !_sdk.scoring || typeof _sdk.scoring.createContinuous !== 'function') {
            _message('Metronome Lock needs the coaching + minigames plugins to score timing.');
            return;
        }
        // One canonical drill key for both late & early — the engine trains one
        // axis; the skin shows the direction.
        _drill = _sd.createSkillDrill({ failureType: 'timing', goalStreak: GOAL_STREAK });
        await _startMetronome(_bpm);
        _render();

        _cont = _sdk.scoring.createContinuous({});
        _cont.on('pitch', _onPitch);
        _cont.on('end', () => { if (!_finished) _finish(); });
    }

    function _onPitch(p) {
        if (_finished || !p || !_clickCtx) return;
        // Re-arm only after a SUSTAINED release: a single sub-threshold frame is a
        // dropout mid-note, not a new attack. Requiring RELEASE_MS below the floor
        // keeps one played note from scoring as two grid hits.
        if (!(p.confidence >= CONF_MIN) || !isFinite(p.midiFloat)) {
            if (_releaseSince == null) _releaseSince = p.tMs;
            if (p.tMs - _releaseSince >= RELEASE_MS) _armed = true;
            return;
        }
        _releaseSince = null;   // confident frame — we're inside a note again
        if (!_armed) return;
        _armed = false;   // consume this attack until release

        const tOnset = p.tMs - DETECT_LATENCY_MS;
        const k = Math.round((tOnset - _anchorPerf) / _subdivPeriodMs);
        if (k < 0) return;   // before the first grid point — ignore the count-in
        const gridPerf = _anchorPerf + k * _subdivPeriodMs;
        const err = Math.round(tOnset - gridPerf);   // + late / - early
        const clean = Math.abs(err) <= WINDOW_MS;
        const ev = clean
            ? { hit: true, err }
            : { hit: false, failureType: 'timing', dir: err > 0 ? 'late' : 'early', err };

        _lastEv = ev;
        _sd.skillDrillStep(_drill, ev);
        const view = _sd.skillDrillView(_drill);
        _render(ev);
        if (view.passed) _finish();
    }

    function _finish() {
        if (_finished) return;
        _finished = true;
        const view = (_sd && _drill) ? _sd.skillDrillView(_drill) : null;
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
        _stopMetronome();
        try { if (_cont) _cont.stop(); } catch (_) {}
        _cont = null;
        if (view) _render(null, view.passed);
        if (_sdk && typeof _sdk.end === 'function') {
            _sdk.end({
                score: scoreFromView(view),
                durationMs: Math.max(0, Math.round(now - _startedAt)),
                meta: { skill: 'timing', failureType: 'timing', bpm: _bpm, clickMode: _clickMode, droppedBeat: _dropOn, view },
            });
        }
    }

    function stop() {
        _stopMetronome();
        try { if (_cont) _cont.stop(); } catch (_) {}
        _cont = null; _drill = null; _finished = true;
    }

    // ── Thin reference skin ────────────────────────────────────────────────
    function _message(msg) {
        if (!_container) return;
        _container.innerHTML = `<div style="padding:2rem;text-align:center;color:#cbd5e1;font:14px system-ui">${msg}</div>`;
    }

    function _btn(label, active, onclick) {
        return `<button onclick="${onclick}" style="margin:0 3px;padding:2px 8px;border-radius:4px;border:1px solid #374151;cursor:pointer;background:${active ? '#4080e0' : '#2a3340'};color:${active ? '#fff' : '#cbd5e1'};font:11px system-ui">${label}</button>`;
    }

    function _render(ev, passed) {
        if (!_container) return;
        const view = (_sd && _drill) ? _sd.skillDrillView(_drill) : { streak: 0, goalStreak: GOAL_STREAK, clean: 0, reps: 0, bestStreak: 0 };
        const pips = Array.from({ length: view.goalStreak }, (_, i) =>
            `<span style="display:inline-block;width:16px;height:16px;border-radius:50%;margin:0 3px;background:${i < view.streak ? '#e8c040' : '#3a3f4b'}"></span>`).join('');
        const shown = ev || _lastEv;
        let flash = `<div style="height:1.4rem">&nbsp;</div>`;
        if (shown && shown.hit) {
            flash = `<div style="color:#7ddb7d;font-weight:700;font-size:1.1rem">✓ on it (${shown.err > 0 ? '+' : ''}${shown.err}ms)</div>`;
        } else if (shown && shown.failureType === 'timing') {
            flash = `<div style="color:#ff5555;font-weight:800;font-size:1.1rem">✗ ${shown.err > 0 ? '+' : ''}${shown.err}ms ${shown.dir === 'late' ? 'late — drag less / anticipate' : 'early — stop rushing'}</div>`;
        }
        const tempo = BPMS.map(b => _btn(String(b), b === _bpm, `window.__metronomeLock&&window.__metronomeLock.setBpm(${b})`)).join('');
        const modes = [['straight', 'Straight'], ['backbeat', 'Backbeat'], ['eighths', '8ths']]
            .map(([m, label]) => _btn(label, _clickMode === m, `window.__metronomeLock&&window.__metronomeLock.setMode('${m}')`)).join('');
        const drop = _btn(_dropOn ? 'Drop: 2+2 ✓' : 'Drop beats', _dropOn, `window.__metronomeLock&&window.__metronomeLock.toggleDrop()`);
        const prompt = passed
            ? `<div style="color:#7ddb7d;font-weight:800;font-size:1.5rem">✓ Locked to the click!</div>`
            : `<div style="font-size:1.6rem;font-weight:800;color:#e5e7eb">Play one note on every ${_clickMode === 'eighths' ? '8th' : 'beat'}</div>
               <div style="color:#9ca3af;margin-top:.2rem">${_dropOn ? 'hold your pocket through the silent bars — the click returns to check you' : 'any note — land it right on the grid'}</div>`;
        _container.innerHTML = `
          <div style="padding:1.5rem;text-align:center;color:#e5e7eb;font:14px system-ui">
            <div style="font-size:1.1rem;font-weight:800;color:#e8c040;margin-bottom:1rem">Metronome Lock</div>
            ${prompt}
            <div style="margin:.75rem 0 .25rem;color:#9ca3af">tempo ${tempo} bpm</div>
            <div style="margin:.35rem 0;color:#9ca3af">click ${modes} &nbsp; ${drop}</div>
            <div style="margin:1rem 0 .5rem">${pips}</div>
            <div style="color:#9ca3af">streak <b style="color:#e5e7eb">${view.streak}</b>/${view.goalStreak}
              · clean <b style="color:#e5e7eb">${view.clean}</b>/${view.reps}
              · best <b style="color:#e5e7eb">${view.bestStreak}</b></div>
            <div style="margin-top:.5rem;min-height:1.4rem">${flash}</div>
          </div>`;
        if (typeof window !== 'undefined') {
            window.__metronomeLock = { setBpm: _setBpm, setMode: _setMode, toggleDrop: _toggleDrop };
        }
    }

    // ── Register (safe late-binding: we may load before the SDK) ───────────
    const spec = {
        id: GAME_ID,
        title: 'Metronome Lock',
        tagline: 'Lock every note to the click',
        skill: 'timing',
        trains: ['late', 'early'],
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
