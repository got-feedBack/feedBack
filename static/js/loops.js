// Unified A-B loop controller. Bounds, armed/active lifecycle, activation
// policy, first-pass policy, and repeat policy all live here. UI entry points
// (manual A/B, saved loops, and Practice Section) configure this controller;
// none of them owns playback behavior.
//
// The long-standing plugin-facing setLoop(a, b) contract remains compatible:
// it seeks to A and activates the loop. Built-in UI paths opt into the new
// preference-driven behavior with { activation: 'preference' }.
import { uiPrompt } from './dom.js';
import { _audioSeek, _audioTime, audioSeekGen, togglePlay } from './transport.js';
import {
    _cancelCountIn,
    isCountingIn,
    pauseBackingForCountIn,
    startCountIn,
} from './count-in.js';
import { S } from './player-state.js';
import {
    loadLoopPreferences,
    normalizeLoopPreferences,
    saveLoopPreferences,
} from './loop-preferences.js';
import { formatTime } from './format.js';
import { host } from './host.js';
import {
    _setSectionPracticeMode,
    _syncSectionPracticeFromLoop,
    _updateSectionPracticeHighlight,
    resetSelection,
} from './section-practice.js';

export let loopA = null;
export let loopB = null;
export let _loopMutationGen = 0;

let _loopPhase = 'inactive'; // inactive | partial | armed | starting | active
let _loopSource = null;
let _loopOperationGen = 0;
let _loopWrapInFlight = false;
let _loopPreferences = loadLoopPreferences();
let _savedLoopsLoadGen = 0;
let _savedLoopsRetryTimer = null;
let _loopIndicatorPulseTimer = null;

function _validLoopBounds(a = loopA, b = loopB) {
    return Number.isFinite(a) && Number.isFinite(b) && b > a;
}

function _loopTransportSnapshot() {
    const valid = _validLoopBounds();
    return {
        startTime: valid ? loopA : null,
        endTime: valid ? loopB : null,
        enabled: valid && _loopPhase === 'active',
        state: valid ? _loopPhase : (_loopPhase === 'partial' ? 'partial' : 'inactive'),
    };
}

export function getLoopState() {
    return {
        loopA,
        loopB,
        active: _loopPhase === 'active',
        configured: _validLoopBounds(),
        state: _loopPhase,
        source: _loopSource,
        preferences: { ..._loopPreferences },
    };
}

export function isLoopActive() {
    return _loopPhase === 'active' && _validLoopBounds();
}

function _emitLoopSet(emitTransportEvent = true) {
    if (!emitTransportEvent || typeof window === 'undefined') return;
    window.feedBack?.playback?.transportEvent?.('loop-set', {
        requesterId: 'core.loop',
        loopA,
        loopB,
        loop: _loopTransportSnapshot(),
    });
}

function _emitLoopCleared(reason, emitTransportEvent = true) {
    if (!emitTransportEvent || typeof window === 'undefined') return;
    window.feedBack?.playback?.transportEvent?.('loop-cleared', {
        requesterId: 'core.loop',
        reason: reason || 'app loop cleared',
        loop: { enabled: false, state: 'inactive' },
    });
}

function _setPointButtonState(id, selected) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('loop-point-set', !!selected);
    el.setAttribute('aria-pressed', selected ? 'true' : 'false');
}

export function cancelLoopOperations(options = {}) {
    const { deactivate = false } = options;
    _loopOperationGen++;
    _loopWrapInFlight = false;
    _cancelCountIn();
    if (_loopPhase === 'starting' || (deactivate && _loopPhase === 'active')) {
        _loopPhase = _validLoopBounds() ? 'armed' : (loopA !== null ? 'partial' : 'inactive');
    }
    updateLoopUI();
    return _loopOperationGen;
}

export function setLoopStart() {
    const hadConfiguredLoop = _validLoopBounds();
    cancelLoopOperations({ deactivate: true });
    loopA = _audioTime();
    loopB = null;
    _loopPhase = Number.isFinite(loopA) ? 'partial' : 'inactive';
    _loopSource = 'manual';
    _loopMutationGen++;
    _setSectionPracticeMode(false, { skipClearLoop: true });
    resetSelection();
    updateLoopUI();
    _syncSavedLoopSelection();
    if (hadConfiguredLoop) _emitLoopCleared('loop bounds changed');
}

export async function setLoopEnd() {
    if (!Number.isFinite(loopA)) return false;
    const end = _audioTime();
    if (!Number.isFinite(end) || end <= loopA) {
        loopB = null;
        _loopPhase = 'partial';
        updateLoopUI();
        return false;
    }
    return setLoop(loopA, end, {
        activation: 'preference',
        source: 'manual',
    });
}

export function clearLoop(options) {
    const { emitTransportEvent = true } = options || {};
    const hadLoop = loopA !== null || loopB !== null;
    cancelLoopOperations({ deactivate: true });
    _setSectionPracticeMode(false, { skipClearLoop: true });
    loopA = null;
    loopB = null;
    _loopPhase = 'inactive';
    _loopSource = null;
    if (hadLoop) _loopMutationGen++;
    const saved = document.getElementById('saved-loops');
    if (saved) saved.value = '';
    resetSelection();
    _updateSectionPracticeHighlight(_audioTime());
    updateLoopUI();
    _syncSavedLoopSelection();
    if (hadLoop) _emitLoopCleared('app loop cleared', emitTransportEvent);
}

function _syncSavedLoopSelection() {
    const sel = document.getElementById('saved-loops');
    const delBtn = document.getElementById('btn-loop-delete');
    if (!sel) return;
    let selected = '';
    if (_validLoopBounds()) {
        for (const opt of sel.options) {
            if (Number(opt.dataset.start) === loopA && Number(opt.dataset.end) === loopB) {
                selected = opt.value;
                break;
            }
        }
    }
    sel.value = selected;
    if (delBtn) delBtn.disabled = !selected;
}

async function _configureLoop(aNum, bNum, options) {
    const {
        emitTransportEvent = true,
        skipSectionSync = false,
        commitGuard = null,
        source = 'ui',
    } = options;
    if (typeof commitGuard === 'function' && !commitGuard()) return false;

    cancelLoopOperations({ deactivate: true });
    if (typeof commitGuard === 'function' && !commitGuard()) return false;
    loopA = aNum;
    loopB = bNum;
    _loopPhase = 'armed';
    _loopSource = source;
    if (!skipSectionSync) _loopMutationGen++;
    updateLoopUI();
    _syncSavedLoopSelection();
    if (!skipSectionSync) _syncSectionPracticeFromLoop();
    _emitLoopSet(emitTransportEvent);

    if (_loopPreferences.activation === 'auto') {
        // A failed/cancelled auto-start leaves the valid loop visibly armed so
        // the user can retry with Start Loop once the transport is ready.
        await startLoop({ source });
    }
    return true;
}

// Backward-compatible public API plus a preference-driven built-in mode.
//
// Default/legacy: seek to A, then commit an active loop. This preserves plugin
// callers such as note-detection drill mode and the playback capability adapter.
//
// { activation: 'preference' }: configure without disturbing playback, then
// start only when the persisted activation preference says "automatic".
export async function setLoop(a, b, options) {
    const opts = options || {};
    const {
        activation = 'legacy',
        emitTransportEvent = true,
        skipSectionSync = false,
        commitGuard = null,
        source = 'plugin',
    } = opts;
    const aNum = Number(a);
    const bNum = Number(b);
    if (!Number.isFinite(aNum) || !Number.isFinite(bNum) || bNum <= aNum) {
        throw new Error(`setLoop: requires finite a and b with b > a (got a=${a}, b=${b})`);
    }
    if (activation === 'preference') {
        return _configureLoop(aNum, bNum, {
            emitTransportEvent,
            skipSectionSync,
            commitGuard,
            source,
        });
    }

    if (typeof commitGuard === 'function' && !commitGuard()) return false;
    const priorPhase = _loopPhase;
    const operation = ++_loopOperationGen;
    _loopWrapInFlight = false;
    _cancelCountIn();
    _loopPhase = 'starting';
    updateLoopUI();
    const seekGeneration = audioSeekGen();
    const r = await _audioSeek(aNum, 'loop-set', {
        guard: () => operation === _loopOperationGen
            && seekGeneration === audioSeekGen()
            && (typeof commitGuard !== 'function' || commitGuard()),
    });
    if (operation !== _loopOperationGen
        || seekGeneration !== audioSeekGen()
        || !r.completed
        || Math.abs(r.to - aNum) > 0.05
        || (typeof commitGuard === 'function' && !commitGuard())) {
        if (operation === _loopOperationGen) {
            _loopPhase = priorPhase;
            updateLoopUI();
        }
        return false;
    }
    loopA = aNum;
    loopB = bNum;
    _loopPhase = 'active';
    _loopSource = source;
    if (!skipSectionSync) _loopMutationGen++;
    updateLoopUI();
    _syncSavedLoopSelection();
    if (!skipSectionSync) _syncSectionPracticeFromLoop();
    _emitLoopSet(emitTransportEvent);
    return true;
}

export async function startLoop(options = {}) {
    if (!_validLoopBounds()) return false;
    const bounds = { a: loopA, b: loopB };
    const operation = cancelLoopOperations({ deactivate: true });
    const seekGeneration = audioSeekGen();
    _loopPhase = 'starting';
    _loopSource = options.source || _loopSource || 'ui';
    updateLoopUI();

    const currentBoundsStillMatch = () => operation === _loopOperationGen
        && seekGeneration === audioSeekGen()
        && loopA === bounds.a
        && loopB === bounds.b;
    const countInFirstPass = _loopPreferences.firstPass === 'count-in';
    if (countInFirstPass) {
        // On an initial start/restart, stop the native backing engine before
        // repositioning it. Seeking a still-running JUCE transport can leak a
        // short false start from A before the count-in owns playback.
        await pauseBackingForCountIn();
        if (!currentBoundsStillMatch()) return false;
    }
    const r = await _audioSeek(bounds.a, 'loop-start', { guard: currentBoundsStillMatch });
    if (!currentBoundsStillMatch() || !r.completed || Math.abs(r.to - bounds.a) > 0.05) {
        if (operation === _loopOperationGen) {
            _loopPhase = _validLoopBounds() ? 'armed' : 'inactive';
            updateLoopUI();
        }
        return false;
    }

    _loopPhase = 'active';
    updateLoopUI();
    if (countInFirstPass) {
        const started = await startCountIn({
            immediate: true,
            bounds,
            backingAlreadyPaused: true,
        });
        if (!started && currentBoundsStillMatch()) {
            _loopPhase = 'armed';
            updateLoopUI();
            return false;
        }
        return started;
    }

    if (window.feedBack) {
        window.feedBack.emit('loop:restart', {
            loopA: bounds.a,
            loopB: bounds.b,
            time: bounds.a,
        });
    }
    if (!S.isPlaying) await togglePlay();
    if (!currentBoundsStillMatch()) return false;
    if (!S.isPlaying) {
        _loopPhase = 'armed';
        updateLoopUI();
        return false;
    }
    return true;
}

export async function handleLoopBoundary(currentTime) {
    if (!isLoopActive()
        || !S.isPlaying
        || !Number.isFinite(currentTime)
        || currentTime < loopB
        || _loopWrapInFlight
        || isCountingIn()) {
        return false;
    }
    const bounds = { a: loopA, b: loopB };
    const operation = _loopOperationGen;
    _loopWrapInFlight = true;

    // Note-detection conductor loops already provide their own audible lead-in
    // and historically request a delay-free host wrap.
    const repeatMode = window._ndAnyDrillActive ? 'continuous' : _loopPreferences.repeat;
    if (repeatMode === 'count-in') {
        const started = await startCountIn({ bounds });
        _loopWrapInFlight = false;
        return started;
    }

    const stillCurrent = () => operation === _loopOperationGen
        && _loopPhase === 'active'
        && loopA === bounds.a
        && loopB === bounds.b;
    const r = await _audioSeek(bounds.a, 'loop-wrap-continuous', { guard: stillCurrent });
    _loopWrapInFlight = false;
    if (!stillCurrent() || !r.completed || Math.abs(r.to - bounds.a) > 0.05) return false;
    S.lastAudioTime = r.to;
    if (window.feedBack) {
        window.feedBack.emit('loop:restart', {
            loopA: bounds.a,
            loopB: bounds.b,
            time: bounds.a,
        });
    }
    return true;
}

export function updateLoopPreference(name, value) {
    if (!Object.prototype.hasOwnProperty.call(_loopPreferences, name)) {
        return { ..._loopPreferences };
    }
    _loopPreferences = saveLoopPreferences(normalizeLoopPreferences({
        ..._loopPreferences,
        [name]: value,
    }));
    updateLoopUI();
    return { ..._loopPreferences };
}

function _loopTimelineDuration() {
    const highwayDuration = Number(window.highway?.getSongInfo?.()?.duration);
    if (Number.isFinite(highwayDuration) && highwayDuration > 0) return highwayDuration;
    const songDuration = Number(window.feedBack?.currentSong?.duration);
    return Number.isFinite(songDuration) && songDuration > 0 ? songDuration : null;
}

function _updateLoopTimeline(valid) {
    const timeline = document.getElementById('v3-loop-timeline');
    if (!timeline) return;
    const hasStart = Number.isFinite(loopA);
    const duration = hasStart ? _loopTimelineDuration() : null;
    const visible = hasStart && Number.isFinite(duration) && duration > 0;
    timeline.hidden = !visible;
    timeline.dataset.state = visible ? (valid ? _loopPhase : 'partial') : 'inactive';
    if (!visible) return;

    const region = document.getElementById('v3-loop-timeline-region');
    if (!region) return;
    const startPercent = Math.max(0, Math.min(100, (loopA / duration) * 100));
    const endPercent = valid
        ? Math.max(startPercent, Math.min(100, (loopB / duration) * 100))
        : startPercent;
    region.style.left = `${startPercent}%`;
    region.style.width = `${endPercent - startPercent}%`;
}

export function pulseLoopIndicator() {
    const indicator = document.getElementById('v3-loop-indicator');
    if (!indicator || indicator.hidden) return;
    indicator.classList.remove('is-returning');
    // Restart the single, short animation even when two restart events arrive
    // close together (for example an outside seek immediately followed by A).
    void indicator.offsetWidth;
    indicator.classList.add('is-returning');
    if (_loopIndicatorPulseTimer !== null) clearTimeout(_loopIndicatorPulseTimer);
    _loopIndicatorPulseTimer = setTimeout(() => {
        indicator.classList.remove('is-returning');
        _loopIndicatorPulseTimer = null;
    }, 700);
}

export function updateLoopUI() {
    const valid = _validLoopBounds();
    const active = valid && _loopPhase === 'active';
    const label = document.getElementById('loop-label');
    if (label) {
        label.textContent = valid
            ? `${formatTime(loopA)} → ${formatTime(loopB)}`
            : (Number.isFinite(loopA) ? `${formatTime(loopA)} → ?` : '');
    }

    const status = document.getElementById('loop-status');
    if (status) {
        status.textContent = _loopPhase === 'active'
            ? 'Loop active'
            : (_loopPhase === 'starting'
                ? 'Starting loop…'
                : (_loopPhase === 'armed'
                    ? 'Loop configured — armed'
                    : (_loopPhase === 'partial' ? 'Set B to finish the loop' : 'No loop configured')));
        status.dataset.state = _loopPhase;
    }

    _setPointButtonState('btn-loop-a', Number.isFinite(loopA));
    _setPointButtonState('btn-loop-b', valid);
    const setB = document.getElementById('btn-loop-b');
    if (setB) setB.disabled = !Number.isFinite(loopA);
    const clear = document.getElementById('btn-loop-clear');
    if (clear) clear.disabled = loopA === null && loopB === null;
    const save = document.getElementById('btn-loop-save');
    if (save) save.disabled = !valid;
    const start = document.getElementById('btn-loop-start');
    if (start) {
        start.disabled = !valid || _loopPhase === 'starting';
        start.textContent = _loopPhase === 'active' ? 'Restart Loop' : 'Start Loop';
        start.setAttribute('aria-describedby', 'loop-status');
    }

    const activation = document.getElementById('loop-activation-preference');
    if (activation) activation.value = _loopPreferences.activation;
    const firstPass = document.getElementById('loop-first-pass-preference');
    if (firstPass) firstPass.value = _loopPreferences.firstPass;
    const repeat = document.getElementById('loop-repeat-preference');
    if (repeat) repeat.value = _loopPreferences.repeat;

    const pill = document.getElementById('section-practice-pill');
    if (pill) {
        pill.classList.toggle('section-practice-pill--active', active);
        pill.classList.toggle('section-practice-pill--armed', _loopPhase === 'armed' || _loopPhase === 'partial');
    }

    // Persistent, low-key feedback in the regular game HUD. The Practice &
    // Loops rail can auto-hide, so it cannot be the only explanation for why
    // playback keeps returning to the same region.
    const hudIndicator = document.getElementById('v3-loop-indicator');
    if (hudIndicator) {
        const hudLabel = document.getElementById('v3-loop-indicator-label');
        const range = document.getElementById('v3-loop-indicator-range');
        const openButton = document.getElementById('v3-loop-indicator-open');
        const announcement = document.getElementById('v3-loop-announcement');
        const rangeText = valid ? `${formatTime(loopA)} – ${formatTime(loopB)}` : '';
        const hudState = active ? 'active' : (_loopPhase === 'starting' ? 'starting' : 'armed');
        const stateText = active
            ? 'Loop on'
            : (_loopPhase === 'starting' ? 'Loop starting' : 'Loop ready');
        if (hudLabel) hudLabel.textContent = stateText;
        if (range) range.textContent = rangeText;
        hudIndicator.hidden = !valid;
        hudIndicator.dataset.state = valid ? hudState : 'inactive';
        if (openButton) {
            openButton.setAttribute(
                'aria-label',
                valid ? `${stateText}, ${rangeText}. Open Practice and Loops` : 'Open Practice and Loops',
            );
        }
        if (announcement) {
            announcement.textContent = valid ? `${stateText}, ${rangeText}` : 'Loop disabled';
        }
    }
    _updateLoopTimeline(valid);
    host._updateEditRegionBtn();
}

export async function loadSavedLoops() {
    const request = ++_savedLoopsLoadGen;
    const sel = document.getElementById('saved-loops');
    const delBtn = document.getElementById('btn-loop-delete');
    if (!sel) {
        if (_savedLoopsRetryTimer !== null) clearTimeout(_savedLoopsRetryTimer);
        _savedLoopsRetryTimer = setTimeout(() => {
            _savedLoopsRetryTimer = null;
            loadSavedLoops();
        }, 100);
        return;
    }
    const filename = host.currentFilename();
    if (!filename) {
        sel.innerHTML = '<option value="">Saved Loops</option>';
        sel.disabled = true;
        if (delBtn) delBtn.disabled = true;
        return;
    }

    try {
        const resp = await fetch(`/api/loops?filename=${encodeURIComponent(decodeURIComponent(filename))}`);
        const loops = await resp.json();
        if (request !== _savedLoopsLoadGen || filename !== host.currentFilename()) return;
        sel.innerHTML = loops.length
            ? '<option value="">Saved Loops</option>'
            : '<option value="">No saved loops</option>';
        for (const savedLoop of loops) {
            const option = document.createElement('option');
            option.value = String(savedLoop.id);
            option.dataset.start = String(savedLoop.start);
            option.dataset.end = String(savedLoop.end);
            option.textContent = `${savedLoop.name} (${formatTime(savedLoop.start)}→${formatTime(savedLoop.end)})`;
            sel.appendChild(option);
        }
        sel.disabled = loops.length === 0;
        _syncSavedLoopSelection();
    } catch (err) {
        if (request !== _savedLoopsLoadGen) return;
        console.warn('[loadSavedLoops] failed:', err);
        sel.innerHTML = '<option value="">Saved loops unavailable</option>';
        sel.disabled = true;
        if (delBtn) delBtn.disabled = true;
    }
}

export async function loadSavedLoop(loopId) {
    const sel = document.getElementById('saved-loops');
    if (!sel) return false;
    const opt = sel.selectedOptions[0];
    if (!loopId || !opt?.dataset.start) {
        _syncSavedLoopSelection();
        return false;
    }
    let ok = false;
    try {
        ok = await setLoop(opt.dataset.start, opt.dataset.end, {
            activation: 'preference',
            source: 'saved',
        });
    } catch (err) {
        console.warn('[loadSavedLoop] setLoop threw:', err);
    }
    if (!ok) _syncSavedLoopSelection();
    return ok;
}

export async function saveCurrentLoop() {
    if (!_validLoopBounds() || !host.currentFilename()) return;
    const name = await uiPrompt({
        title: 'Save Loop',
        label: 'Loop name',
        value: 'Loop',
        okLabel: 'Save',
    });
    if (name === null) return;
    const finalName = name.trim() || 'Loop';
    await fetch('/api/loops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename: decodeURIComponent(host.currentFilename()),
            name: finalName,
            start: loopA,
            end: loopB,
        }),
    });
    await loadSavedLoops();
}

export async function deleteSelectedLoop() {
    const sel = document.getElementById('saved-loops');
    const loopId = sel && sel.value;
    if (!loopId) return;
    await fetch(`/api/loops/${loopId}`, { method: 'DELETE' });
    clearLoop();
    await loadSavedLoops();
}
