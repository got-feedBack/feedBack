'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// Mirror of static/v3/songs.js buildLibraryStateHash — keep in sync.
function buildLibraryStateHash(st) {
    const f = (st && st.filters) || {};
    return JSON.stringify({
        view: st.view || 'grid',
        q: st.q || '',
        sort: st.sort || 'artist',
        provider: st.provider || 'local',
        format: st.format || '',
        artist: st.artist || '',
        album: st.album || '',
        filters: {
            arr_has: [...(f.arr_has || [])].sort(),
            arr_lacks: [...(f.arr_lacks || [])].sort(),
            stem_has: [...(f.stem_has || [])].sort(),
            stem_lacks: [...(f.stem_lacks || [])].sort(),
            lyrics: f.lyrics || '',
            tunings: [...(f.tunings || [])].sort(),
        },
    });
}

const SCROLL_STATE_KEY = 'v3:songs-scroll-state';

function makeStore() {
    const data = new Map();
    return {
        getItem(k) { return data.has(k) ? data.get(k) : null; },
        setItem(k, v) { data.set(k, v); },
        removeItem(k) { data.delete(k); },
        clear() { data.clear(); },
    };
}

// Mirror of static/v3/songs.js _saveLibraryScrollSnapshot. Under the windowed
// grid (#636 item 3 stage 2) geometry is stable, so the snapshot is just
// {hash, scrollTop, view} — no page/loadedCount depth bookkeeping (restore sets
// scrollTop and re-renders the window that maps to it).
function saveSnapshot(storage, state, scrollTop) {
    const snap = {
        hash: buildLibraryStateHash(state),
        scrollTop,
        view: state.view,
    };
    storage.setItem(SCROLL_STATE_KEY, JSON.stringify(snap));
}

function readSnapshot(storage) {
    const raw = storage.getItem(SCROLL_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
}

const baseState = {
    view: 'grid',
    q: '',
    sort: 'artist',
    provider: 'local',
    format: '',
    artist: '',
    album: '',
    filters: { arr_has: [], arr_lacks: [], stem_has: [], stem_lacks: [], lyrics: '', tunings: [] },
};

test('buildLibraryStateHash changes when sort changes', () => {
    const a = buildLibraryStateHash(baseState);
    const b = buildLibraryStateHash({ ...baseState, sort: 'title' });
    assert.notStrictEqual(a, b);
});

test('buildLibraryStateHash changes when filter provider changes', () => {
    const a = buildLibraryStateHash(baseState);
    const b = buildLibraryStateHash({ ...baseState, provider: 'remote:x' });
    assert.notStrictEqual(a, b);
});

test('buildLibraryStateHash is stable for equivalent filter arrays', () => {
    const s1 = {
        ...baseState,
        filters: { ...baseState.filters, arr_has: ['Lead', 'Bass'], tunings: ['Drop D', 'E Standard'] },
    };
    const s2 = {
        ...baseState,
        filters: { ...baseState.filters, arr_has: ['Bass', 'Lead'], tunings: ['E Standard', 'Drop D'] },
    };
    assert.strictEqual(buildLibraryStateHash(s1), buildLibraryStateHash(s2));
});

test('snapshot stores scrollTop + view + hash (geometry-stable restore)', () => {
    const storage = makeStore();
    saveSnapshot(storage, baseState, 1840);
    const snap = readSnapshot(storage);
    assert.strictEqual(snap.scrollTop, 1840);
    assert.strictEqual(snap.view, 'grid');
    assert.strictEqual(snap.hash, buildLibraryStateHash(baseState));
    // Page-depth bookkeeping is gone — the windowed grid restores from scrollTop.
    assert.strictEqual(snap.page, undefined);
    assert.strictEqual(snap.loadedCount, undefined);
});

test('stale snapshot is detected when filters change', () => {
    const storage = makeStore();
    saveSnapshot(storage, baseState, 500);
    const snap = readSnapshot(storage);
    const changed = buildLibraryStateHash({ ...baseState, q: 'beatles' });
    assert.notStrictEqual(snap.hash, changed);
});

test('state hash changes when artist or album changes', () => {
    const a = buildLibraryStateHash(baseState);
    const b = buildLibraryStateHash({ ...baseState, artist: 'A Band' });
    const c = buildLibraryStateHash({ ...baseState, artist: 'A Band', album: 'A Band - LP' });
    assert.notStrictEqual(a, b);
    assert.notStrictEqual(b, c);
});

test('clearing artist should use different hash than album-only selection', () => {
    const withArtist = buildLibraryStateHash({ ...baseState, artist: 'A Band', album: 'A Band - LP' });
    const cleared = buildLibraryStateHash({ ...baseState, artist: '', album: '' });
    assert.notStrictEqual(withArtist, cleared);
});
