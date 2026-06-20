/*
 * fee[dB]ack — highway scoreboard preference.
 *
 * The 3D/2D highway can show note-detection scoring two ways: the core v3
 * live-performance HUD (#v3-live-performance-hud) and the note_detect plugin's
 * own HUD (.nd-hud). Both auto-render off the same note:hit/note:miss events,
 * so without a preference you get two overlapping scoreboards.
 *
 * This module is the single source of truth: it writes <html data-scoreboard>
 * (core | detailed | off) and CSS in v3.css hides the non-selected HUD(s).
 * Default is 'core'. The CSS keys the default off "not detailed and not off",
 * so the right HUD is correct even before this script runs (no flash).
 */
(function () {
    'use strict';

    var KEY = 'highwayScoreboard';
    var VALID = { core: 1, detailed: 1, off: 1 };

    function read() {
        var v = null;
        try { v = localStorage.getItem(KEY); } catch (_e) { /* private mode */ }
        return VALID[v] ? v : 'core';
    }

    function apply(v) {
        if (document.documentElement) {
            document.documentElement.setAttribute('data-scoreboard', v);
        }
    }

    function setScoreboard(v) {
        if (!VALID[v]) v = 'core';
        try { localStorage.setItem(KEY, v); } catch (_e) { /* private mode */ }
        apply(v);
        var sel = document.getElementById('scoreboard-select');
        if (sel && sel.value !== v) sel.value = v;
    }

    // Apply immediately so the correct HUD is set before the first note arrives.
    apply(read());

    // onchange="setScoreboard(this.value)" on the Settings select.
    window.setScoreboard = setScoreboard;

    document.addEventListener('DOMContentLoaded', function () {
        var sel = document.getElementById('scoreboard-select');
        if (sel) sel.value = read();
    });
})();
