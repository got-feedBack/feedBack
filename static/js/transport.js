// The playback transport — the play/pause/seek core, and the two clocks it reads.
//
// WHY THIS IS A MODULE AND NOT A HOOK BUNDLE. Every carve before this one ADDED host
// hooks: a module pulled out of app.js still had to call back into it. This one SUBTRACTS
// them. count-in, juce-audio, loops, and section-practice were all reaching through the
// seam for the same handful of names — _audioSeek, _audioTime, setPlayButtonState,
// _songEventPayload, jucePlayer. Those names have an owner, and it isn't app.js. Give
// them one and the four consumers import them directly:
//
//     count-in.js    5 hooks -> 0        juce-audio.js  4 hooks -> 0
//     loops.js       6 hooks -> 4        section-practice.js  10 hooks -> 7
//
// A hook is a cycle you agreed to live with. An import is a dependency you actually have.
// Prefer the import whenever the name has a real owner.
//
// TWO THINGS DELIBERATELY LEFT IN app.js, both for the same reason — they would close a
// cycle, and app.js is the root, so it can import from both sides for free:
//
//   * _currentPlaybackSnapshot  reads loopA/loopB from ./loops.js, and loops.js imports
//                               this module. The dependency scan MISSED this at first: it
//                               only walked app.js's own top-level decls, and loopA stopped
//                               being one the moment loops.js was carved out. Any scan of a
//                               partly-carved monolith has to resolve the imports too.
//   * restartCurrentSong        calls _cancelCountIn() from ./count-in.js, which imports
//                               this module.
//
// The seek generation (_audioSeekGen) stays PRIVATE. It has exactly one writer —
// _resetAudioSeekState(), right here — so readers get audioSeekGen() and nobody outside
// can desync it. That is strictly better than the host hook it replaces, which handed out
// a getter and left the writer in app.js.
import { audio } from './audio-el.js';
import { S } from './player-state.js';

// Sync the play/pause button's icon and accessible state in one place so
// screen readers, tooltips, and aria-pressed stay aligned with playback.
// Updates the existing <img> child's src in place rather than rewriting
// innerHTML, so any future children (fallback label, loading spinner, …)
// survive state changes.
export function setPlayButtonState(isPlaying) {
    const btn = document.getElementById('btn-play');
    if (!btn) return;
    const label = isPlaying ? 'Pause' : 'Play';
    const icon = isPlaying ? 'pause' : 'play';
    let img = btn.querySelector('img.button-icon-svg');
    if (!img) {
        img = document.createElement('img');
        img.className = 'button-icon-svg';
        img.alt = '';
        img.setAttribute('aria-hidden', 'true');
        btn.appendChild(img);
    }
    img.src = `/static/svg/${icon}.svg`;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
    btn.title = label;
}

// ── Player ───────────────────────────────────────────────────────────────
// `audio` now lives in ./js/audio-el.js so carved-out modules can reach the
// player without importing app.js back (which would close a cycle). Same
// element, same handle, same lookup — just imported instead of declared here.
let _lastSongPositionEventAt = 0;

export function _emitSongPositionChanged(time, duration) {
    const now = Date.now();
    if (now - _lastSongPositionEventAt < 250) return;
    _lastSongPositionEventAt = now;
    const payload = (typeof _songEventPayload === 'function') ? _songEventPayload() : { time };
    window.feedBack.emit('song:position-changed', Object.assign(payload, { duration }));
}

// JUCE-mode clock tuning (see jucePlayer._applySample).
// A poll whose IPC round trip took longer than this can't say WHEN in that
// window the engine read its position, so it only counts if it disagrees by
// more than _JUCE_SNAP_S (a real discontinuity).
const _JUCE_MAX_RTT_MS = 40;
// Errors at or above this are a discontinuity (engine-side loop, stall,
// device restart): jump to the sample. Below it, slew.
const _JUCE_SNAP_S = 0.25;
// Slew limit as a fraction of playback speed: a residual error is absorbed by
// running the clock up to 10% fast/slow, so the clock never moves backwards.
const _JUCE_SLEW = 0.1;

export const jucePlayer = {
    _timer: null,
    _pos: 0,
    _dur: 0,
    _pollAt: 0,    // performance.now() the anchor _pos refers to
    _polling: false,
    _speed: 1,
    _slew: 0,      // seconds still to absorb into the clock since _pollAt
    _floor: 0,     // last value handed out while playing (monotonic guard)
    _gen: 0,       // bumped on every reposition; stale poll replies are dropped
    get currentTime() {
        if (!this._polling) return this._pos;
        // Interpolate between IPC polls so highway motion is smooth at 60fps
        // Scale by _speed so at 0.7x the interpolated clock advances 0.7s/s
        const elapsed = Math.max(0, (performance.now() - this._pollAt) / 1000);
        const maxSlew = elapsed * this._speed * _JUCE_SLEW;
        const slew = Math.max(-maxSlew, Math.min(maxSlew, this._slew));
        const t = Math.max(this._floor, this._pos + elapsed * this._speed + slew);
        this._floor = t;
        return Math.min(t, this._dur > 0 ? this._dur : Infinity);
    },
    get duration() { return this._dur; },
    // Re-anchor the clock at `pos` (a seek, pause point, rate change or route
    // hand-off): drops any pending slew, the monotonic floor, and poll
    // replies that were in flight across the reposition.
    _setAnchor(pos, at = performance.now()) {
        this._pos = pos;
        this._pollAt = at;
        this._slew = 0;
        this._floor = -Infinity;
        this._gen++;
    },
    // Fold one getBackingPosition() reply into the clock. `t0`/`t1` bracket
    // the IPC round trip; the engine read its position somewhere inside it,
    // so the sample is anchored at the midpoint (anchoring at t1, after the
    // await, made every anchor stale by the round trip and the clock stepped
    // back on each poll). Small errors are slewed, never stepped.
    _applySample(pos, t0, t1) {
        const rtt = t1 - t0;
        const target = pos + ((t1 - (t0 + t1) / 2) / 1000) * this._speed;
        const now = this.currentTime;
        const err = target - now;
        if (Math.abs(err) >= _JUCE_SNAP_S) {
            this._setAnchor(target, t1);
            return;
        }
        if (rtt > _JUCE_MAX_RTT_MS) return;
        this._pos = now;
        this._pollAt = t1;
        this._slew = err;
    },
    async play() {
        try {
            await window.feedBackDesktop.audio.startBacking();
        } catch (err) {
            console.warn('[jucePlayer] startBacking failed:', err);
            return false;
        }
        this._startPolling();
        return true;
    },
    async pause() {
        // Snapshot the interpolated position before stopping the poll so
        // _pos stays at the visible pause point rather than jumping back
        // to the last raw IPC sample (which can be up to 100ms behind).
        this._setAnchor(this.currentTime);
        this._stopPolling();
        try {
            await window.feedBackDesktop.audio.stopBacking();
        } catch (err) {
            console.warn('[jucePlayer] stopBacking failed:', err);
        }
    },
    async seek(s) {
        const prev = this._pos;
        this._setAnchor(s);
        try {
            await window.feedBackDesktop.audio.seekBacking(s);
        } catch (err) {
            console.warn('[jucePlayer] seekBacking failed:', err);
            this._setAnchor(prev);
        }
    },
    _startPolling() {
        this._stopPolling();
        this._setAnchor(this._pos);
        this._polling = true;
        const self = this;
        function scheduleNext() {
            self._timer = setTimeout(async () => {
                if (!self._polling) return;
                const gen = self._gen;
                try {
                    const t0 = performance.now();
                    const pos = await window.feedBackDesktop.audio.getBackingPosition();
                    if (self._polling && gen === self._gen) {
                        self._applySample(pos, t0, performance.now());
                        _emitSongPositionChanged(self.currentTime, self.duration || null);
                    }
                } catch (err) {
                    console.warn('[jucePlayer] position poll failed:', err);
                } finally {
                    if (self._polling) scheduleNext();
                }
            }, 100);
        }
        scheduleNext();
    },
    _stopPolling() {
        this._polling = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    },
    setRate(rate) {
        this._setAnchor(this.currentTime);
        this._speed = rate;
    },
    async stop() {
        await this.pause();
        this._setAnchor(0, 0);
        this._dur = 0;
        this._speed = 1;
    },
};

export function _audioTime() { return window._juceMode ? jucePlayer.currentTime : audio.currentTime; }

export function _audioDuration() { return window._juceMode ? jucePlayer.duration : audio.duration; }

// Canonical payload for song:play/song:pause/song:ended. Plugins anchor
// their own clocks against `perfNow` (a monotonic timestamp at the same
// moment audio reports `audioT`) so they don't have to chase the chart
// clock with a follow-up call. `time` is kept as an alias for `audioT`
// because pre-existing plugins read e.detail.time.
export function _songEventPayload() {
    const audioT = _audioTime();
    return {
        time: audioT,
        audioT,
        chartT: window.highway.getTime(),
        perfNow: performance.now(),
    };
}

export function _markPlaybackPaused() {
    S.isPlaying = false;
    setPlayButtonState(false);
    if (window.feedBack) {
        window.feedBack.isPlaying = false;
        window.feedBack.emit('song:pause', _songEventPayload());
    }
}

export function _markPlaybackResumed() {
    S.isPlaying = true;
    setPlayButtonState(true);
    if (window.feedBack) {
        window.feedBack.isPlaying = true;
        const payload = _songEventPayload();
        window.feedBack.emit('song:play', payload);
        window.feedBack.emit('song:resume', payload);
    }
}

export function _emitPlaybackStopped(time, screen = 'playback-command') {
    if (window.feedBack) window.feedBack.emit('song:stop', { time: time || 0, screen });
}

export function _waitForSongReady(expectedSeekGen, timeoutMs = 10000) {
    if (!window.feedBack || typeof window.feedBack.on !== 'function') return Promise.resolve(false);
    return new Promise(resolve => {
        let timer = null;
        const done = value => {
            if (timer !== null) clearTimeout(timer);
            window.feedBack.off('song:ready', onReady);
            resolve(value);
        };
        const onReady = () => done(expectedSeekGen == null || expectedSeekGen === _audioSeekGen);
        window.feedBack.on('song:ready', onReady);
        timer = setTimeout(() => done(false), timeoutMs);
    });
}

// Serializes seeks so concurrent callers (e.g. user ⏪ during a loop wrap)
// don't interleave their from/to reads — each call captures `from` only
// once the previous seek + emit have completed. The generation token
// lets session teardown invalidate queued seeks so they don't run against
// the new player and emit a stale song:seek.
let _audioSeekChain = Promise.resolve();

let _audioSeekGen = 0;

export function _resetAudioSeekState() {
    // Bump the generation — in-flight chain callbacks see the mismatch on
    // their next guard check and short-circuit (no emit, no further state
    // mutation by us). Don't reset the chain head: new seeks must still
    // queue behind the in-flight old seek's IPC so two `jucePlayer.seek()`
    // calls can't race in the JUCE backing engine. The queue drains
    // quickly because each subsequent old-gen step bails on the first
    // guard the moment its predecessor resolves.
    _audioSeekGen++;
}

// Time-box the JUCE IPC so a single hung seek can't block the global
// _audioSeekChain forever (which would freeze every subsequent reposition
// path: seekBy, loop-wrap, jump-fix, shimmed audio.currentTime).
const _JUCE_SEEK_TIMEOUT_MS = 2000;

function _juceSeekWithTimeout(s) {
    let timer;
    const seekP = jucePlayer.seek(s);
    const timeoutP = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('JUCE seek timed out')), _JUCE_SEEK_TIMEOUT_MS);
    });
    // Clear the timer once the race settles either way; without this the
    // pending timeout keeps the event loop alive (and eventually rejects
    // an unawaited promise) even after a successful seek.
    return Promise.race([seekP, timeoutP]).finally(() => clearTimeout(timer));
}

// Resolves to `{ completed, from, to }`:
//   - completed: true if the seek ran to completion and emitted song:seek;
//                false if cancelled by a teardown gen bump (or threw).
//   - from: chart clock just before the seek (NaN on cancel before from-read).
//   - to:   verified post-seek clock (NaN on cancel/throw).
// Callers that fire follow-up work after the seek (count-in, arrangement
// restore, etc.) should check `completed` so they don't act on a torn-down
// session. Callers that need the actual landed position (because JUCE may
// clamp or HTML5 may snap to the seekable range) should read `to` rather
// than re-using the requested `s`.
export async function _audioSeek(s, reason) {
    // Single funnel for every audio repositioning. Emits song:seek so
    // plugins (notedetect detection-suppression during seek transients,
    // practice-journal segment tracking) can react to any chart-time
    // jump regardless of which UI path triggered it. `reason` is a
    // free-form short string ('seek-by', 'loop-wrap', 'loop-set',
    // 'arrangement-restore', 'jump-fix') so subscribers can filter.
    const gen = _audioSeekGen;
    _audioSeekChain = _audioSeekChain.then(async () => {
        if (gen !== _audioSeekGen) return { completed: false, from: NaN, to: NaN };
        const from = _audioTime();
        if (window._juceMode) await _juceSeekWithTimeout(s);
        else audio.currentTime = s;
        if (gen !== _audioSeekGen) return { completed: false, from, to: NaN };
        // Read the verified post-seek position rather than the requested `s`
        // so plugins observe the actual clock — JUCE may clamp or roll back,
        // and HTML5 may snap to the nearest seekable range.
        const to = _audioTime();
        // Sync the jump-fix tracker so the next 60Hz tick doesn't see a
        // legitimate far seek (e.g. saved-loop jump > 30s) as a browser
        // bug and revert it.
        S.lastAudioTime = to;
        // Sync the chart clock too so any song:* emit fired right after
        // _audioSeek resolves (e.g. the auto-resume song:play in
        // changeArrangement) sees an in-sync chartT via _songEventPayload.
        // Without this, chartT lags by one 60Hz tick after a seek.
        if (window.highway && typeof window.highway.setTime === 'function') {
            window.highway.setTime(to);
        }
        window.feedBack.emit('song:seek', { from, to, reason: reason || null });
        return { completed: true, from, to };
    }).catch((err) => {
        // Don't let one failed seek poison subsequent ones.
        console.warn('[_audioSeek]', err);
        return { completed: false, from: NaN, to: NaN };
    });
    return _audioSeekChain;
}

// Per-attempt counter for HTML5 audio.play() invocations. Bumped on
// every play branch entry so a slow rejection from attempt N can't
// clobber the UI of a newer attempt N+1 within the same session.
let _playAttemptGen = 0;

export async function togglePlay() {
    if (window._juceMode) {
        if (S.isPlaying) {
            await jucePlayer.pause();
            S.isPlaying = false;
            setPlayButtonState(false);
            window.feedBack.isPlaying = false;
            window.feedBack.emit('song:pause', _songEventPayload());
        } else {
            const started = await jucePlayer.play();
            if (!started) return; // startBacking() failed — IPC error already logged
            S.isPlaying = true;
            setPlayButtonState(true);
            window.feedBack.isPlaying = true;
            const payload = _songEventPayload();
            window.feedBack.emit('song:play', payload);
            window.feedBack.emit('song:resume', payload);
        }
        return;
    }
    if (S.isPlaying) {
        audio.pause(); S.isPlaying = false;
        setPlayButtonState(false);
    } else {
        // Flip the UI optimistically before awaiting the play() Promise so
        // a quick second click during a slow start (buffering, device
        // wake, etc.) still enters the pause branch above. Two stale-
        // resolution guards:
        //   - _audioSeekGen: bumped in showScreen() teardown and
        //     playSong(), so a rejection from a torn-down session can't
        //     touch new-session UI. Survives same-URL reloads.
        //   - _playAttemptGen: bumped on every play branch entry, so
        //     within a single session a slow rejection from attempt N
        //     can't clobber a faster attempt N+1 (Play → Pause → Play).
        const sessionGen = _audioSeekGen;
        const attempt = ++_playAttemptGen;
        S.isPlaying = true;
        setPlayButtonState(true);
        try {
            await audio.play();
        } catch (err) {
            if (sessionGen !== _audioSeekGen) return;
            if (attempt !== _playAttemptGen) return;
            // An engine reroute (HTML5 -> JUCE) deliberately pauses the <audio>
            // element mid-migration, which rejects this in-flight play() with an
            // AbortError even though playback continues on the JUCE transport.
            // The reroute owns isPlaying / the button while it runs (same guard
            // the <audio> 'play'/'pause' listeners use); resetting here would
            // leave the button showing Play while the song keeps playing — the
            // "two clicks to pause on the first song after a fresh load" bug.
            if (window._juceRerouteInProgress) return;
            console.error('[app] audio.play() rejected:', err);
            S.isPlaying = false;
            setPlayButtonState(false);
        }
    }
}

export async function seekBy(s) {
    await _audioSeek(Math.max(0, _audioTime() + s), 'seek-by');
}

/**
 * Read-only view of the seek generation. Bumped by _resetAudioSeekState() on session
 * teardown; callers capture it before an await and compare after, so a resolution from a
 * torn-down session can't touch new-session state.
 */
export function audioSeekGen() { return _audioSeekGen; }
