const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LOOPS_JS = path.join(__dirname, '..', '..', 'static', 'js', 'loops.js');

function normalizePreferences(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        activation: ['arm', 'auto'].includes(source.activation) ? source.activation : 'arm',
        firstPass: ['count-in', 'immediate'].includes(source.firstPass) ? source.firstPass : 'count-in',
        repeat: ['count-in', 'continuous'].includes(source.repeat) ? source.repeat : 'count-in',
    };
}

function buildHarness(preferences = {}, { juce = false, isPlaying = false } = {}) {
    const seekCalls = [];
    const countInCalls = [];
    const operationCalls = [];
    const transportEvents = [];
    const loopEvents = [];
    const persisted = [];
    const elements = new Map();
    let currentTime = 33;
    let seekGeneration = 0;

    const sandbox = {
        seekCalls,
        countInCalls,
        operationCalls,
        transportEvents,
        loopEvents,
        persisted,
        S: { isPlaying, lastAudioTime: currentTime },
        document: {
            getElementById(id) { return elements.get(id) || null; },
        },
        window: {
            _juceMode: juce,
            _ndAnyDrillActive: false,
            feedBack: {
                emit(name, detail) {
                    loopEvents.push({ name, detail });
                },
                playback: {
                    transportEvent(name, detail) {
                        transportEvents.push({ name, detail });
                    },
                },
            },
        },
        loadLoopPreferences() {
            return normalizePreferences(preferences);
        },
        normalizeLoopPreferences: normalizePreferences,
        saveLoopPreferences(value) {
            const normalized = normalizePreferences(value);
            persisted.push(normalized);
            return normalized;
        },
        _audioTime() { return currentTime; },
        audioSeekGen() { return seekGeneration; },
        async _audioSeek(seconds, reason, options = {}) {
            if (typeof options.guard === 'function' && !options.guard()) {
                return { completed: false, from: NaN, to: NaN };
            }
            const from = currentTime;
            currentTime = seconds;
            operationCalls.push(`seek:${reason}`);
            seekCalls.push({ seconds, reason, juce });
            loopEvents.push({ name: 'song:seek', detail: { from, to: seconds, reason } });
            return { completed: true, from, to: seconds };
        },
        async togglePlay() {
            sandbox.__playCalls++;
            sandbox.S.isPlaying = true;
        },
        _cancelCountIn() {
            sandbox.__cancelCalls++;
        },
        isCountingIn() {
            return false;
        },
        async pauseBackingForCountIn() {
            operationCalls.push('pause-count-in-backing');
        },
        async startCountIn(options) {
            operationCalls.push('start-count-in');
            countInCalls.push(options);
            loopEvents.push({
                name: 'loop:restart',
                detail: {
                    loopA: options.bounds.a,
                    loopB: options.bounds.b,
                    time: options.bounds.a,
                },
            });
            return true;
        },
        formatTime(value) { return String(value); },
        esc(value) { return String(value); },
        async uiPrompt() { return null; },
        fetch: async () => ({ json: async () => [] }),
        _setSectionPracticeMode() {},
        _syncSectionPracticeFromLoop() {},
        _updateSectionPracticeHighlight() {},
        resetSelection() {},
        host: {
            _updateEditRegionBtn() {},
            currentFilename() { return 'song.sloppak'; },
        },
        __playCalls: 0,
        __cancelCalls: 0,
        __setCurrentTime(value) { currentTime = value; },
        __bumpSeekGeneration() { seekGeneration++; },
        setTimeout,
        clearTimeout,
        console,
    };
    vm.createContext(sandbox);
    const raw = fs.readFileSync(LOOPS_JS, 'utf8');
    const moduleStart = raw.indexOf('export let loopA');
    assert.notEqual(moduleStart, -1, 'loop module state declaration not found');
    const body = raw.slice(moduleStart).replace(/^export /gm, '');
    vm.runInContext(`${body}
        globalThis.__loop = {
            setLoop,
            setLoopStart,
            setLoopEnd,
            startLoop,
            clearLoop,
            cancelLoopOperations,
            handleLoopBoundary,
            getLoopState,
            updateLoopPreference,
        };
    `, sandbox);
    return { sandbox, api: sandbox.__loop };
}

test('legacy plugin setLoop still seeks to A and activates without forcing play', async () => {
    const { sandbox, api } = buildHarness({}, { isPlaying: false });
    assert.equal(await api.setLoop(4, 9), true);
    assert.equal(sandbox.seekCalls.length, 1);
    assert.equal(sandbox.seekCalls[0].seconds, 4);
    assert.equal(sandbox.seekCalls[0].reason, 'loop-set');
    assert.equal(api.getLoopState().state, 'active');
    assert.equal(sandbox.__playCalls, 0);
});

test('arm-only configuration preserves the current transport and does not wrap at B', async () => {
    const { sandbox, api } = buildHarness({
        activation: 'arm',
        firstPass: 'count-in',
        repeat: 'count-in',
    }, { isPlaying: true });
    sandbox.__setCurrentTime(27);
    assert.equal(await api.setLoop(5, 10, { activation: 'preference', source: 'saved' }), true);
    assert.equal(api.getLoopState().state, 'armed');
    assert.equal(sandbox.seekCalls.length, 0);
    assert.equal(sandbox.__playCalls, 0);
    assert.equal(await api.handleLoopBoundary(10), false);
    assert.equal(sandbox.countInCalls.length, 0);
});

test('manual A/B completion uses the same arm-only controller path', async () => {
    const { sandbox, api } = buildHarness({ activation: 'arm' }, { isPlaying: true });
    sandbox.__setCurrentTime(6);
    api.setLoopStart();
    assert.equal(api.getLoopState().state, 'partial');
    sandbox.__setCurrentTime(14);
    assert.equal(await api.setLoopEnd(), true);
    const state = api.getLoopState();
    assert.equal(state.loopA, 6);
    assert.equal(state.loopB, 14);
    assert.equal(state.state, 'armed');
    assert.equal(state.source, 'manual');
    assert.equal(sandbox.seekCalls.length, 0);
});

test('all activation, first-pass, and repeat combinations follow one policy matrix', async (t) => {
    const activations = ['arm', 'auto'];
    const firstPasses = ['count-in', 'immediate'];
    const repeats = ['count-in', 'continuous'];

    for (const activation of activations) {
        for (const firstPass of firstPasses) {
            for (const repeat of repeats) {
                await t.test(`${activation}/${firstPass}/${repeat}`, async () => {
                    const { sandbox, api } = buildHarness({
                        activation,
                        firstPass,
                        repeat,
                    });
                    const configured = api.setLoop(8, 12, {
                        activation: 'preference',
                        source: 'section',
                    });
                    assert.equal(await configured, true);
                    if (activation === 'arm') {
                        assert.equal(api.getLoopState().state, 'armed');
                        assert.equal(sandbox.seekCalls.length, 0);
                        assert.equal(await api.startLoop({ source: 'ui' }), true);
                    }
                    assert.equal(api.getLoopState().state, 'active');
                    assert.equal(sandbox.seekCalls.filter(call => call.reason === 'loop-start').length, 1);

                    if (firstPass === 'count-in') {
                        assert.equal(sandbox.countInCalls.length, 1);
                        assert.equal(sandbox.countInCalls[0].immediate, true);
                        assert.equal(sandbox.__playCalls, 0);
                    } else {
                        assert.equal(sandbox.countInCalls.length, 0);
                        assert.equal(sandbox.__playCalls, 1);
                    }

                    sandbox.S.isPlaying = true;
                    sandbox.countInCalls.length = 0;
                    sandbox.seekCalls.length = 0;
                    sandbox.loopEvents.length = 0;
                    assert.equal(await api.handleLoopBoundary(12), true);
                    if (repeat === 'count-in') {
                        assert.equal(sandbox.countInCalls.length, 1);
                        assert.equal(!!sandbox.countInCalls[0].immediate, false);
                        assert.equal(sandbox.seekCalls.length, 0);
                    } else {
                        assert.equal(sandbox.countInCalls.length, 0);
                        assert.equal(sandbox.seekCalls.length, 1);
                        assert.equal(sandbox.seekCalls[0].reason, 'loop-wrap-continuous');
                        assert.equal(sandbox.loopEvents[0].name, 'song:seek');
                        assert.equal(sandbox.loopEvents[1].name, 'loop:restart');
                    }
                });
            }
        }
    }
});

test('pause/resume of an active loop does not replay the initial count-in', async () => {
    const { sandbox, api } = buildHarness({
        activation: 'auto',
        firstPass: 'count-in',
        repeat: 'continuous',
    });
    await api.setLoop(2, 6, { activation: 'preference' });
    assert.equal(sandbox.countInCalls.length, 1);
    sandbox.S.isPlaying = false;
    assert.equal(await api.handleLoopBoundary(6), false);
    sandbox.S.isPlaying = true;
    assert.equal(await api.handleLoopBoundary(5), false);
    assert.equal(sandbox.countInCalls.length, 1);
});

test('initial count-in pauses backing before seeking A without pausing twice', async () => {
    const { sandbox, api } = buildHarness({
        activation: 'auto',
        firstPass: 'count-in',
        repeat: 'count-in',
    }, { isPlaying: true });

    assert.equal(await api.setLoop(3, 7, { activation: 'preference' }), true);
    assert.deepEqual(
        Array.from(sandbox.operationCalls),
        ['pause-count-in-backing', 'seek:loop-start', 'start-count-in'],
    );
    assert.equal(sandbox.countInCalls.length, 1);
    assert.equal(sandbox.countInCalls[0].backingAlreadyPaused, true);

    sandbox.operationCalls.length = 0;
    sandbox.countInCalls.length = 0;
    sandbox.S.isPlaying = true;
    assert.equal(await api.handleLoopBoundary(7), true);
    assert.deepEqual(Array.from(sandbox.operationCalls), ['start-count-in']);
    assert.equal(!!sandbox.countInCalls[0].backingAlreadyPaused, false);
});

test('clear cancels a pending automatic start and cannot activate stale bounds', async () => {
    const { sandbox, api } = buildHarness({
        activation: 'auto',
        firstPass: 'immediate',
        repeat: 'continuous',
    });
    let release;
    sandbox._audioSeek = (seconds, reason, options = {}) => new Promise(resolve => {
        release = () => {
            const allowed = typeof options.guard !== 'function' || options.guard();
            resolve(allowed
                ? { completed: true, from: 20, to: seconds }
                : { completed: false, from: NaN, to: NaN });
        };
    });
    const pending = api.setLoop(3, 7, { activation: 'preference' });
    api.clearLoop();
    release();
    await pending;
    assert.equal(api.getLoopState().state, 'inactive');
    assert.equal(api.getLoopState().loopA, null);
    assert.equal(sandbox.__playCalls, 0);
});

test('arrangement cancellation leaves a pending selection armed, never stale-active', async () => {
    const { sandbox, api } = buildHarness({
        activation: 'auto',
        firstPass: 'immediate',
    });
    let release;
    sandbox._audioSeek = (seconds, reason, options = {}) => new Promise(resolve => {
        release = () => resolve({
            completed: typeof options.guard !== 'function' || options.guard(),
            from: 20,
            to: seconds,
        });
    });
    const pending = api.setLoop(4, 8, { activation: 'preference', source: 'section' });
    api.cancelLoopOperations();
    release();
    await pending;
    assert.equal(api.getLoopState().state, 'armed');
    assert.equal(sandbox.__playCalls, 0);
});

test('rapid loop selections only allow the newest start operation to activate', async () => {
    const { sandbox, api } = buildHarness({
        activation: 'auto',
        firstPass: 'immediate',
    });
    const pendingSeeks = [];
    sandbox._audioSeek = (seconds, reason, options = {}) => new Promise(resolve => {
        pendingSeeks.push({
            seconds,
            release() {
                const allowed = typeof options.guard !== 'function' || options.guard();
                resolve(allowed
                    ? { completed: true, from: 20, to: seconds }
                    : { completed: false, from: NaN, to: NaN });
            },
        });
    });
    const first = api.setLoop(1, 5, { activation: 'preference', source: 'section' });
    const second = api.setLoop(10, 15, { activation: 'preference', source: 'saved' });
    assert.equal(pendingSeeks.length, 2);
    pendingSeeks[0].release();
    await first;
    assert.equal(api.getLoopState().loopA, 10);
    assert.notEqual(api.getLoopState().state, 'active');
    pendingSeeks[1].release();
    await second;
    assert.equal(api.getLoopState().loopA, 10);
    assert.equal(api.getLoopState().loopB, 15);
    assert.equal(api.getLoopState().state, 'active');
    assert.equal(sandbox.__playCalls, 1);
});

test('continuous wrapping uses the canonical seek path in HTML5 and mocked JUCE modes', async (t) => {
    for (const juce of [false, true]) {
        await t.test(juce ? 'JUCE' : 'HTML5', async () => {
            const { sandbox, api } = buildHarness({
                activation: 'auto',
                firstPass: 'immediate',
                repeat: 'continuous',
            }, { juce });
            await api.setLoop(5, 9, { activation: 'preference' });
            sandbox.S.isPlaying = true;
            sandbox.seekCalls.length = 0;
            assert.equal(await api.handleLoopBoundary(9), true);
            assert.equal(sandbox.seekCalls.length, 1);
            assert.equal(sandbox.seekCalls[0].seconds, 5);
            assert.equal(sandbox.seekCalls[0].reason, 'loop-wrap-continuous');
            assert.equal(sandbox.seekCalls[0].juce, juce);
        });
    }
});

test('configured and cleared transport events are emitted once with armed/active state', async () => {
    const { sandbox, api } = buildHarness({ activation: 'arm' });
    await api.setLoop(5, 10, { activation: 'preference' });
    assert.equal(sandbox.transportEvents.length, 1);
    assert.equal(sandbox.transportEvents[0].name, 'loop-set');
    assert.equal(sandbox.transportEvents[0].detail.loop.state, 'armed');
    assert.equal(sandbox.transportEvents[0].detail.loop.enabled, false);
    api.clearLoop();
    assert.equal(sandbox.transportEvents.length, 2);
    assert.equal(sandbox.transportEvents[1].name, 'loop-cleared');
});
