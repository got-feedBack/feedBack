// Two venue bugs reported from a live career session.
//
// 1. Changing arrangement mid-song replayed the venue arrival flyover. The
//    camera flew in from the back of the room again, every time the player
//    switched lead -> rhythm. changeArrangement() reloads the song through the
//    normal load path, so highway.js re-emits `song:loaded` — same filename,
//    new arrangement — and the venue could not tell that from a fresh arrival.
//    The player is already on stage; the room should just carry on.
//
// 2. With Venue selected, the venue backdrop showed up on the VIRTUOSO highway.
//    The venue was gated purely on the viz selection, which is a global
//    preference and says nothing about what is on screen. Virtuoso borrows the
//    same highway_3d renderer for its practice charts, so it inherited the
//    crowd and the stage behind a chromatic exercise. The venue belongs to the
//    song player and nowhere else.

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const crowd = require('../../static/v3/venue-crowd.js');

// ── 1. arrangement switch is not an arrival ────────────────────────────────

test('same filename = arrangement switch (no arrival flyover)', () => {
    // changeArrangement() re-emits song:loaded for the song already on stage.
    assert.equal(crowd.isArrangementSwitch('song.feedpak', 'song.feedpak'), true);
});

test('different filename = a genuinely new song (flyover is correct)', () => {
    assert.equal(crowd.isArrangementSwitch('a.feedpak', 'b.feedpak'), false);
});

test('first load of the session is an arrival, not a switch', () => {
    // No previous song -> the flyover must play.
    assert.equal(crowd.isArrangementSwitch('', 'a.feedpak'), false);
});

test('a missing filename is never treated as a switch', () => {
    // Otherwise a malformed payload would silently suppress the flyover for the
    // rest of the session.
    assert.equal(crowd.isArrangementSwitch('a.feedpak', ''), false);
    assert.equal(crowd.isArrangementSwitch('a.feedpak', undefined), false);
    assert.equal(crowd.isArrangementSwitch('', ''), false);
});

// ── 2. the venue belongs to the player screen ──────────────────────────────

const scene = require('../../static/v3/venue-scene-3d.js');

// Venue MUST be the selected visualization for these to mean anything: if the
// viz were unset, shouldBeActive() would be false for the wrong reason and the
// virtuoso assertion below would pass vacuously. Force the viz on, so the only
// thing under test is the SCREEN gate.
function withScreen(id, fn) {
    const prevDoc = global.document;
    const prevViz = global.v3VenueViz;
    global.v3VenueViz = {
        isVenueVisualization: (v) => String(v) === 'venue',
        getSelectedVizId: () => 'venue',
    };
    global.document = {
        querySelector(sel) {
            if (sel !== '.screen.active') return null;
            return id ? { id } : null;
        },
    };
    try { return fn(); } finally { global.document = prevDoc; global.v3VenueViz = prevViz; }
}

test('guard: with Venue selected AND on the player, the venue IS active', () => {
    // If this ever fails, every "not active" test below is vacuous.
    withScreen('player', () => {
        assert.equal(scene.shouldBeActive(), true,
            'the screen gate must not break the normal case');
    });
});

test('venue is active on the player screen', () => {
    withScreen('player', () => {
        assert.equal(scene.isPlayerScreen(), true);
    });
});

test('venue is NOT active on the virtuoso screen (the bug)', () => {
    withScreen('virtuoso', () => {
        assert.equal(scene.isPlayerScreen(), false,
            'Virtuoso borrows the same highway_3d renderer — the venue backdrop ' +
            'must not follow it there');
        assert.equal(scene.shouldBeActive(), false,
            'selecting Venue is a preference for the PLAYER; it is not a licence ' +
            'to paint the venue over whatever else is using the renderer');
    });
});

test('venue is not active on any other screen either', () => {
    for (const id of ['v3-home', 'plugin-folder_library', 'settings', 'career']) {
        withScreen(id, () => {
            assert.equal(scene.shouldBeActive(), false, `venue must not be active on ${id}`);
        });
    }
});

test('no active screen at all is not the player', () => {
    withScreen(null, () => {
        assert.equal(scene.isPlayerScreen(), false);
    });
});

test('a throwing document does not take the venue down with it', () => {
    const prev = global.document;
    global.document = { querySelector() { throw new Error('detached'); } };
    try {
        assert.equal(scene.isPlayerScreen(), false, 'must fail closed, not throw');
    } finally {
        global.document = prev;
    }
});
