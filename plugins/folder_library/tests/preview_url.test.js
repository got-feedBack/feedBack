// Hover-preview audio URL (folder_library preview-on-hover).
//
// The preview delegates to the canonical `song_preview` plugin instead of
// resolving pack audio itself: `song_preview` reads the pack's manifest
// (`preview:` key -> default stem) and serves the clip with Range support.
// So `_previewUrl` just has to build that endpoint's URL from the song's
// filename — with the filename URL-encoded as a query value (a '/', '#', '&',
// or space in a folder/song name must not break the query). Returns null when
// there's nothing to build from.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
    const window = {
        console,
        document: {
            readyState: 'complete',
            addEventListener() {},
            getElementById() { return null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
            createElement() { return { style: {}, classList: { add() {}, remove() {}, contains() { return false; } }, addEventListener() {}, appendChild() {} }; },
        },
        addEventListener() {},
        localStorage: { getItem() { return null; }, setItem() {} },
        performance: { now: () => 0 },
        setInterval() { return 0; },
        clearInterval() {},
        requestAnimationFrame() { return 0; },
        cancelAnimationFrame() {},
        getComputedStyle() { return { overflowY: 'visible', paddingTop: '0px', paddingBottom: '0px' }; },
        innerHeight: 800,
        encodeURIComponent,   // the plugin encodes the filename query value with this
    };
    window.window = window;
    window.globalThis = window;
    const ctx = vm.createContext(window);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'screen.js'), 'utf8'), ctx, { filename: 'screen.js' });
    assert.ok(window.folderLibrary && window.folderLibrary.__test, 'plugin must expose __test');
    return window.folderLibrary.__test;
}

const { previewUrl } = load();

test('null when there is no filename to build from', () => {
    assert.equal(previewUrl(null), null);
    assert.equal(previewUrl({}), null);
    assert.equal(previewUrl({ filename: '' }), null);
});

test('delegates to the song_preview endpoint with the filename as a query value', () => {
    const url = previewUrl({ filename: 'Test/song.sloppak' });
    assert.equal(url, '/api/plugins/song_preview/audio?file=Test%2Fsong.sloppak');
});

test('encodes the whole filename (slashes, #, &, spaces) as one query value', () => {
    const url = previewUrl({ filename: 'AC#DC/Back & Forth.sloppak' });
    // As a query value, '/' is encoded too — song_preview decodes it back to the path.
    assert.equal(url, '/api/plugins/song_preview/audio?file=AC%23DC%2FBack%20%26%20Forth.sloppak');
});

test('does not read a per-pack audio member (resolution is song_preview\'s job)', () => {
    // Even if a caller passes a stale audio_member, it must be ignored — the
    // folder plugin no longer resolves pack audio itself.
    const url = previewUrl({ filename: 'CH/Song.sloppak', audio_member: 'stems/guitar.ogg' });
    assert.equal(url, '/api/plugins/song_preview/audio?file=CH%2FSong.sloppak');
});
