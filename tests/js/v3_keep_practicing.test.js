// Pins the practice-aware library home in static/v3/songs.js:
//   - a "Repertoire" progress meter (mastered / total library songs), and
//   - a "Keep practicing" shelf (recently played, not yet mastered).
// Both reuse existing data (/api/stats/best already in state.accuracy, and
// /api/stats/recent) and are shown only on the unfiltered grid front door.
//
// Source-level only — same strategy as tests/js/v3_az_rail.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SONGS_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'songs.js');
const src = fs.readFileSync(SONGS_JS, 'utf8');

test('repertoire uses the same mastery threshold as the green accuracy badge', () => {
    assert.match(src, /const\s+MASTERY_ACCURACY\s*=\s*0\.9/);
    assert.match(
        src,
        /function\s+_repertoireCounts[\s\S]*?v\s*>=\s*MASTERY_ACCURACY\s*\)\s*mastered\+\+;\s*else\s+learning\+\+/,
        'repertoire counts must bucket scored songs into mastered/learning at MASTERY_ACCURACY',
    );
});

test('the home is the unfiltered grid front door, local provider only', () => {
    assert.match(
        src,
        /function\s+libHomeVisible[\s\S]*?state\.view === 'grid'[\s\S]*?state\.provider === 'local'[\s\S]*?!state\.selectMode[\s\S]*?!state\.q[\s\S]*?activeFilterCount\(\)\s*===\s*0/,
        'libHomeVisible must require grid view, the local provider, no select mode, no search, no active filters',
    );
});

test('the shelf is the server-side practice-suggestions recommender', () => {
    // The old client-side pipeline (fetch /api/stats/recent, dedupe by
    // filename, gate on state.accuracy) moved server-side: the growth-edge
    // recommender gates (not-mastered) + aggregates per song and picks the
    // arrangement closest to mastery. The client renders its rows as-is.
    assert.match(src, /\/api\/library\/practice-suggestions\?limit=/);
    // A shelf card click opens the row's recommended arrangement, not the
    // song's default.
    assert.match(
        src,
        /data-arr="[\s\S]*?getAttribute\('data-arr'\)[\s\S]*?playSong\(enc\(fn\), arr === '' \? undefined : Number\(arr\)\)/,
        'shelf cards must pass the recommended arrangement to playSong',
    );
});

test('the meter + shelf fetch together and a stale render is discarded', () => {
    assert.match(src, /Promise\.all\(\[[\s\S]*?library\/stats[\s\S]*?practice-suggestions/,
        'the two reads must be issued together (Promise.all), not sequentially');
    assert.match(src, /_homeToken[\s\S]*?_homeToken !== myToken/,
        'a stale render must be superseded by a newer one via a token');
});

test('the repertoire denominator is the unfiltered library total', () => {
    assert.match(src, /\/api\/library\/stats\?provider='/);
    assert.match(src, /total_songs\s*\?\?\s*stats\.total/);
    assert.match(src, /Math\.round\(\(mastered\s*\/\s*total\)\s*\*\s*100\)/);
});

test('the home + #v3-lib-home host are wired into render and reload', () => {
    assert.match(src, /id="v3-lib-home"/, 'render() must include the #v3-lib-home host');
    assert.match(src, /function reload\s*\([\s\S]*?updateLibraryHome\(\)/,
        'reload() must refresh/toggle the home');
    assert.match(src, /function applyScoreRefresh[\s\S]*?renderLibraryHome\(\)/,
        'a new score must refresh the meter + shelf');
});

test('shelf cards play the song on click', () => {
    assert.match(
        src,
        /querySelectorAll\('\.v3-kp-card'\)[\s\S]*?window\.playSong\(enc\(fn\)/,
        'a shelf card click must call window.playSong with the recents filename',
    );
});
