const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadJobs, dispatch, makeProvider, enqueuePayload, diagnosticsSnapshot, storageEntries } = require('./jobs_test_harness');

test('diagnostics schema redacts raw payloads, paths, command lines, and provider-private fields', async () => {
    const window = loadJobs();
    const { provider } = makeProvider();
    await dispatch(window, 'register-provider', { provider });
    const enqueued = await dispatch(window, 'enqueue', enqueuePayload({
        safeLabel: 'Generate cache',
        target: { path: '/Users/example/Music/Secret Artist - Secret Song_p.sloppak', filename: 'Secret Song_p.sloppak' },
        inputs: { token: 'abc123', rawPayload: 'never export', commandLine: 'ffmpeg -i secret.wav out.ogg', safeFingerprint: 'fingerprint-public' },
    }));
    window.slopsmith.jobs.log(provider.providerId, enqueued.payload.job.jobId, 'ran ffmpeg -i /Users/example/secret.wav with token=abc123');
    window.slopsmith.jobs.fail(provider.providerId, enqueued.payload.job.jobId, { safeReason: 'failed near /Users/example/private/path', retryable: true });

    const json = JSON.stringify(diagnosticsSnapshot(window));
    assert.match(json, /Generate cache/);
    assert.match(json, /fingerprint-public/);
    assert.doesNotMatch(json, /Secret Artist|Secret Song|secret\.wav|abc123|rawPayload|commandLine|never export|ffmpeg -i/);
});

test('caller-supplied refs and fingerprints are exported as safe correlation keys', async () => {
    const window = loadJobs();
    const { provider } = makeProvider();
    await dispatch(window, 'register-provider', { provider });
    const enqueued = await dispatch(window, 'enqueue', enqueuePayload({
        target: { targetRef: 'Secret Song_p.sloppak', id: 'Private Library Entry' },
        inputs: { fingerprint: 'Secret Input Cache.sloppak' },
        logicalJobKey: 'Secret Song_p.sloppak',
    }));
    const bridge = await dispatch(window, 'record-bridge-hit', { logicalJobKey: 'Secret Song_p.sloppak', safeReason: 'legacy path observed' });
    const snapshot = diagnosticsSnapshot(window);
    const job = snapshot.jobs.active[0];

    assert.equal(bridge.payload.bridge.jobId, enqueued.payload.job.jobId);
    assert.equal(job.targetRef.startsWith('target-'), true);
    assert.equal(job.inputFingerprint.startsWith('input-'), true);
    assert.doesNotMatch(JSON.stringify(snapshot), /Secret Song|Secret Input|Private Library|\.sloppak/);
});

test('raw-only target and input fields hash distinctly without exporting raw values', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({ capacity: { maxRunning: 1, maxQueued: 10 } });
    await dispatch(window, 'register-provider', { provider });

    const first = await dispatch(window, 'enqueue', enqueuePayload({ target: { path: '/Users/example/DLC/Secret A.sloppak' }, inputs: { token: 'secret-a' }, logicalJobKey: '' }));
    const second = await dispatch(window, 'enqueue', enqueuePayload({ target: { path: '/Users/example/DLC/Secret B.sloppak' }, inputs: { token: 'secret-b' }, logicalJobKey: '' }));
    const json = JSON.stringify(diagnosticsSnapshot(window));

    assert.notEqual(first.payload.job.targetRef, second.payload.job.targetRef);
    assert.notEqual(first.payload.job.inputFingerprint, second.payload.job.inputFingerprint);
    assert.doesNotMatch(json, /Secret A|Secret B|secret-a|secret-b|\.sloppak/);
});

test('recoverable job references are the only active state persisted across reloads', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({ providerId: 'provider.recover', recoverySupport: { queued: true, running: true, paused: false } });
    await dispatch(window, 'register-provider', { provider });
    await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'recoverable-running', safeLabel: 'Recoverable' }));

    const entries = storageEntries(window);
    assert.ok(entries['slopsmith.jobs.recoverableRefs.v1']);
    assert.doesNotMatch(entries['slopsmith.jobs.recoverableRefs.v1'], /operationHandlers|rawPayload|token/);

    const sameWindow = window;
    sameWindow.slopsmith.jobs.resetForTests({ clearStorage: false });
    assert.equal(sameWindow.slopsmith.jobs._test.pendingRecoverableRefs.size, 1);
    await dispatch(sameWindow, 'register-provider', { provider });
    const snapshot = diagnosticsSnapshot(sameWindow);
    assert.equal(snapshot.jobs.active.length + snapshot.jobs.queued.length, 1);
    assert.equal(snapshot.jobs.active[0]?.safeLabel || snapshot.jobs.queued[0]?.safeLabel, 'Recoverable');
});

test('async recovery handlers are awaited before restoring jobs', async () => {
    const window = loadJobs();
    const initial = makeProvider({ providerId: 'provider.async-recover', recoverySupport: { queued: true, running: true, paused: true } });
    await dispatch(window, 'register-provider', { provider: initial.provider });
    await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'async-recover', safeLabel: 'Async Recover' }));

    window.slopsmith.jobs.resetForTests({ clearStorage: false });
    const recovered = makeProvider({
        providerId: 'provider.async-recover',
        recoverySupport: { queued: true, running: true, paused: true },
        operationHandlers: {
            'job.recover': async () => ({ outcome: 'handled', state: 'paused' }),
        },
    });
    await dispatch(window, 'register-provider', { provider: recovered.provider });
    const snapshot = diagnosticsSnapshot(window);

    assert.equal(snapshot.jobs.paused.length, 1);
    assert.equal(snapshot.jobs.paused[0].safeLabel, 'Async Recover');
});

test('async recovery rejections become provider-unavailable terminal jobs', async () => {
    const window = loadJobs();
    const initial = makeProvider({ providerId: 'provider.recover-reject', recoverySupport: { queued: true, running: true, paused: true } });
    await dispatch(window, 'register-provider', { provider: initial.provider });
    await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'recover-reject', safeLabel: 'Reject Recover' }));

    window.slopsmith.jobs.resetForTests({ clearStorage: false });
    const rejecting = makeProvider({
        providerId: 'provider.recover-reject',
        recoverySupport: { queued: true, running: true, paused: true },
        operationHandlers: {
            'job.recover': async () => { throw new Error('failed near /Users/example/private/recovery.db'); },
        },
    });
    await dispatch(window, 'register-provider', { provider: rejecting.provider });
    const snapshot = diagnosticsSnapshot(window);

    assert.equal(snapshot.jobs.recentTerminal[0].state, 'provider-unavailable');
    assert.equal(snapshot.jobs.recentTerminal[0].terminalOutcome.category, 'provider-unavailable');
    assert.doesNotMatch(JSON.stringify(snapshot), /Users\/example|recovery\.db/);
});

test('recovery handlers can restore terminal provider-owned jobs', async () => {
    const window = loadJobs();
    const initial = makeProvider({ providerId: 'provider.recover-terminal', recoverySupport: { queued: true, running: true, paused: true } });
    await dispatch(window, 'register-provider', { provider: initial.provider });
    await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: 'recover-terminal', safeLabel: 'Terminal Recover' }));

    window.slopsmith.jobs.resetForTests({ clearStorage: false });
    const recovered = makeProvider({
        providerId: 'provider.recover-terminal',
        recoverySupport: { queued: true, running: true, paused: true },
        operationHandlers: {
            'job.recover': async () => ({ outcome: 'handled', state: 'completed', resultSummary: 'Backend finished while reloading' }),
        },
    });
    await dispatch(window, 'register-provider', { provider: recovered.provider });
    const snapshot = diagnosticsSnapshot(window);

    assert.equal(snapshot.jobs.active.length, 0);
    assert.equal(snapshot.jobs.queued.length, 0);
    assert.equal(snapshot.jobs.recentTerminal.length, 1);
    assert.equal(snapshot.jobs.recentTerminal[0].state, 'completed');
    assert.equal(snapshot.jobs.recentTerminal[0].terminalOutcome.resultSummary, 'Backend finished while reloading');
});

test('reload marks non-recoverable jobs orphaned or provider-unavailable without restoring raw payloads', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({ providerId: 'provider.no-recover', recoverySupport: { queued: false, running: false, paused: false } });
    await dispatch(window, 'register-provider', { provider });
    const enqueued = await dispatch(window, 'enqueue', enqueuePayload({ providerId: 'provider.no-recover', logicalJobKey: 'no-recover' }));

    window.slopsmith.jobs.simulateReload();
    const inspected = await dispatch(window, 'inspect', { jobId: enqueued.payload.job.jobId });

    assert.equal(inspected.payload.job.state, 'orphaned');
    assert.equal(inspected.payload.job.terminalOutcome.retryable, false);
    assert.doesNotMatch(JSON.stringify(inspected.payload.job), /operationHandlers|rawPayload/);
});

test('diagnostics enforce per-job history and bounded snapshot size with terminal minimum retained', async () => {
    const window = loadJobs();
    const { provider } = makeProvider({ capacity: { maxRunning: 1, maxQueued: 100 } });
    await dispatch(window, 'register-provider', { provider });
    let lastJobId = null;

    for (let index = 0; index < 8; index += 1) {
        const enqueued = await dispatch(window, 'enqueue', enqueuePayload({ logicalJobKey: `terminal-${index}`, safeLabel: `Terminal ${index}` }));
        lastJobId = enqueued.payload.job.jobId;
        for (let line = 0; line < 80; line += 1) window.slopsmith.jobs.log(provider.providerId, lastJobId, `line ${line} /Users/example/private/file-${line}.sloppak`);
        window.slopsmith.jobs.complete(provider.providerId, lastJobId, { resultSummary: 'done' });
    }

    const snapshot = diagnosticsSnapshot(window);
    assert.ok(snapshot.snapshotBytes <= snapshot.limits.snapshotBudgetBytes + 1024);
    assert.ok(snapshot.jobs.recentTerminal.length >= 5);
    assert.ok(snapshot.jobs.recentTerminal.every(job => job.history.length <= 50));
});