'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { extractFunction } = require('./test_utils');

const SONGS_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'songs.js');

function loadLifecycle() {
    const src = fs.readFileSync(SONGS_JS, 'utf8');
    const coordinator = extractFunction(src, 'function createSongsEntryCoordinator');
    const lifecycle = extractFunction(src, 'function createSongsEntryLifecycle');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(
        `${coordinator}\n${lifecycle}\nglobalThis.__createLifecycle = createSongsEntryLifecycle;`,
        sandbox,
    );
    return { createLifecycle: sandbox.__createLifecycle, source: src };
}

function loadScreenEnter({ dirty, built }) {
    const src = fs.readFileSync(SONGS_JS, 'utf8');
    const screenEnter = extractFunction(src, 'async function onV3SongsScreenEnter');
    const calls = { reload: 0, render: 0 };
    const sandbox = { calls };
    vm.createContext(sandbox);
    vm.runInContext(`
        let _libraryDirty = ${dirty};
        const state = { built: ${built}, artistPage: null, view: 'grid' };
        const document = { getElementById() { return null; } };
        function refreshArtistPageGates() {}
        async function applyScoreRefresh() {}
        function _readLibraryScrollSnapshot() { return null; }
        function _libraryStateHash() { return ''; }
        function _chromeIntact() { return false; }
        async function reload() { calls.reload++; }
        async function render() { calls.render++; }
        function _clearLibraryScrollSnapshot() {}
        function _applyMainScrollTop() {}
        function requestWindowRender() {}
        ${screenEnter}
        globalThis.__screenEnter = onV3SongsScreenEnter;
    `, sandbox);
    return { enter: sandbox.__screenEnter, calls };
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

test('class activation renders when the initial screen:changed event was missed', async () => {
    const { createLifecycle } = loadLifecycle();
    let active = false;
    let entries = 0;
    const lifecycle = createLifecycle(async () => { entries++; }, () => active);

    lifecycle.syncActiveClass();
    active = true;
    await lifecycle.syncActiveClass();

    assert.equal(entries, 1);
});

test('an already-active screen enters once when songs.js registers late', async () => {
    const { createLifecycle } = loadLifecycle();
    let entries = 0;
    const lifecycle = createLifecycle(async () => { entries++; }, () => true);

    await lifecycle.syncActiveClass();

    assert.equal(entries, 1);
});

test('screen event and observer edge coalesce while entry is in flight', async () => {
    const { createLifecycle } = loadLifecycle();
    let active = true;
    let entries = 0;
    const gate = deferred();
    const lifecycle = createLifecycle(async () => {
        entries++;
        await gate.promise;
    }, () => active);

    const fromEvent = lifecycle.onScreenChanged({ detail: { id: 'v3-songs' } });
    const fromObserver = lifecycle.syncActiveClass();
    // The coordinator starts entry in a microtask so synchronous event +
    // initial-state triggers can share the same in-flight Promise.
    await Promise.resolve();

    assert.equal(entries, 1);
    assert.equal(fromObserver, null);
    gate.resolve();
    await fromEvent;
    assert.equal(entries, 1);
});

test('leaving and entering again runs the full entry lifecycle again', async () => {
    const { createLifecycle } = loadLifecycle();
    let active = true;
    let entries = 0;
    const lifecycle = createLifecycle(async () => { entries++; }, () => active);

    await lifecycle.onScreenChanged({ detail: { id: 'v3-songs' } });
    active = false;
    lifecycle.onScreenChanged({ detail: { id: 'v3-home' } });
    active = true;
    await lifecycle.syncActiveClass();

    assert.equal(entries, 2);
});

test('rapid leave and re-entry queues one follow-up while entry is in flight', async () => {
    const { createLifecycle } = loadLifecycle();
    let active = true;
    let entries = 0;
    const gate = deferred();
    const lifecycle = createLifecycle(async () => {
        entries++;
        if (entries === 1) await gate.promise;
    }, () => active);

    const first = lifecycle.onScreenChanged({ detail: { id: 'v3-songs' } });
    await Promise.resolve();
    active = false;
    lifecycle.onScreenChanged({ detail: { id: 'v3-home' } });
    active = true;
    const reentry = lifecycle.onScreenChanged({ detail: { id: 'v3-songs' } });
    gate.resolve();
    await Promise.all([first, reentry]);

    assert.equal(entries, 2);
});

test('a rejected entry clears coordinator state so a later navigation retries', async () => {
    const { createLifecycle } = loadLifecycle();
    let entries = 0;
    const lifecycle = createLifecycle(async () => {
        entries++;
        if (entries === 1) throw new Error('entry failed');
    }, () => true);

    await assert.rejects(lifecycle.onScreenChanged({ detail: { id: 'v3-songs' } }), /entry failed/);
    await lifecycle.onScreenChanged({ detail: { id: 'v3-songs' } });

    assert.equal(entries, 2);
});

test('dirty first entry builds the Songs shell instead of reloading absent DOM', async () => {
    const { enter, calls } = loadScreenEnter({ dirty: true, built: false });

    await enter();

    assert.deepEqual(calls, { reload: 0, render: 1 });
});

test('repeated navigation has one entry per return and no observer wiring', async () => {
    const { createLifecycle, source } = loadLifecycle();
    let active = false;
    let entries = 0;
    const lifecycle = createLifecycle(async () => { entries++; }, () => active);

    for (let i = 0; i < 3; i++) {
        active = true;
        await lifecycle.onScreenChanged({ detail: { id: 'v3-songs' } });
        active = false;
        lifecycle.onScreenChanged({ detail: { id: 'v3-home' } });
    }

    assert.equal(entries, 3);
    assert.equal((source.match(/sm\.on\('screen:changed'/g) || []).length, 1);
    assert.doesNotMatch(source, /new MutationObserver\(/);
    assert.match(source, /DOMContentLoaded[^\n]*syncActiveClass/);
});
