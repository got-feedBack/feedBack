// Unit tests for the App-updates panel's status → view-model state machine
// (_appUpdateStatusView in static/js/settings.js). settings.js pulls a large
// ES-module graph (highway-colors, library, player-controls), so rather than
// import it, the pure function is sliced out of source and evaluated on its
// own — it's DOM-free by construction, which is the whole point of extracting
// it. The slice marker is asserted so a rename fails loudly instead of testing
// nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'static', 'js', 'settings.js'), 'utf8');

function extractFn(source, name) {
    const marker = `export function ${name}`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `${name} must exist in settings.js`);
    // Skip the parameter list first (it contains a destructured `{ … } = {}`
    // default, so the body's opening brace isn't the first `{` after the name).
    let pd = 0, i = source.indexOf('(', start);
    for (; i < source.length; i++) {
        if (source[i] === '(') pd++;
        else if (source[i] === ')' && --pd === 0) break;
    }
    const open = source.indexOf('{', i);
    let depth = 0;
    for (let j = open; j < source.length; j++) {
        if (source[j] === '{') depth++;
        else if (source[j] === '}' && --depth === 0) {
            return source.slice(start, j + 1).replace('export function', 'function');
        }
    }
    throw new Error(`unbalanced braces extracting ${name}`);
}

const _appUpdateStatusView = new Function(
    `${extractFn(SRC, '_appUpdateStatusView')}\nreturn _appUpdateStatusView;`,
)();

const FMT = () => 'just now';
const view = (s, opts) => _appUpdateStatusView(s, { channelValue: 'nightly', fmtTimestamp: FMT, ...opts });

test('null status → unavailable', () => {
    assert.deepEqual(_appUpdateStatusView(null), { kind: 'unavailable' });
});

test('unsupported / any linux-platform status → unsupported', () => {
    assert.equal(view({ status: 'unsupported', platform: 'linux' }).kind, 'unsupported');
    assert.equal(view({ status: 'idle', platform: 'linux' }).kind, 'unsupported',
        'a stray platform:linux still routes to the fallback, matching renderFrom');
});

test('idle shows "up to date" with the formatted last-checked time, controls enabled', () => {
    const v = view({ status: 'idle', currentVersion: '1.2.3', channel: 'nightly', lastChecked: 123 });
    assert.equal(v.kind, 'status');
    assert.equal(v.line, 'Version 1.2.3 · nightly · up to date · last checked just now');
    assert.equal(v.btnLabel, 'Check for updates');
    assert.equal(v.btnMode, 'check');
    assert.equal(v.btnDisabled, false);
    assert.equal(v.channelDisabled, false);
});

test('checking and downloading disable the button AND lock the channel selector', () => {
    const chk = view({ status: 'checking', currentVersion: '1', channel: 'nightly' });
    assert.equal(chk.btnDisabled, true);
    assert.equal(chk.channelDisabled, true);
    assert.match(chk.line, /checking for updates…$/);

    const dl = view({ status: 'downloading', currentVersion: '1', channel: 'nightly', percent: 42 });
    assert.equal(dl.btnDisabled, true);
    assert.equal(dl.channelDisabled, true);
    assert.match(dl.line, /downloading update… 42%$/);
});

test('downloading without a percent falls back to the indeterminate label', () => {
    const v = view({ status: 'downloading', currentVersion: '1', channel: 'nightly', percent: null });
    assert.match(v.line, /update available — downloading…$/);
});

test('downloaded flips the button to Restart when apply() exists', () => {
    const v = view({ status: 'downloaded', currentVersion: '1', channel: 'nightly' }, { canApply: true });
    assert.equal(v.btnLabel, 'Restart now');
    assert.equal(v.btnMode, 'restart');
    assert.equal(v.channelDisabled, false, 'staged is not in-flight — channel stays switchable');
    assert.match(v.line, /update ready$/);
});

test('downloaded on an older bridge (no apply) stays a plain check button with text-only guidance', () => {
    const v = view({ status: 'downloaded', currentVersion: '1', channel: 'nightly' }, { canApply: false });
    assert.equal(v.btnMode, 'check');
    assert.equal(v.btnLabel, 'Check for updates');
    assert.match(v.line, /update ready — restart to apply$/);
});

test('error surfaces the message, or a generic fallback when absent', () => {
    assert.match(view({ status: 'error', currentVersion: '1', channel: 'nightly', message: 'boom' }).line, /update error: boom$/);
    assert.match(view({ status: 'error', currentVersion: '1', channel: 'nightly' }).line, /update check failed$/);
});

test('missing version and channel fall back to "?" and the dropdown value', () => {
    const v = view({ status: 'idle', lastChecked: 0 }, { channelValue: 'beta' });
    assert.match(v.line, /^Version \? · beta · /);
});
