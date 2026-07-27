// Practice Journal plugin

// ── Auto-tracking (feedBack-native) ─────────────────────────────────────
// The legacy build wrapped window.playSong / showScreen / setSpeed /
// loadSavedLoop. In feedBack those are LOCAL functions in app.js — core
// calls the locals, never the window globals — so wrappers never fire. We
// drive tracking off the core event bus (`window.feedBack`, an EventTarget:
// handlers get a CustomEvent with the payload on `.detail`) instead:
//   song:play / song:loaded  → begin a session
//   song:ended / song:stop   → close it
//   screen:changed           → leaving the player closes it; entering the
//                              journal refreshes the dashboard.

let _pjSessionStart = null;
let _pjFilename = null;
let _pjTitle = null;
let _pjArtist = null;
let _pjArrangement = null;

function _pjSongMeta() {
    // The canonical current-song identity lives on window.feedBack.currentSong
    // (highway.js sets it from the WS path — { filename, title, artist,
    // duration, arrangement, ... }). getSongInfo() does NOT carry `filename`
    // (the song_info WS message has no filename field), so currentSong is the
    // reliable source; getSongInfo() + the HUD DOM are fallbacks.
    const cur = (window.feedBack && window.feedBack.currentSong) || null;
    let info = {};
    try {
        info = (window.highway && typeof window.highway.getSongInfo === 'function'
            && window.highway.getSongInfo()) || {};
    } catch (_) {}
    const dom = (id) => document.getElementById(id)?.textContent || '';
    return {
        filename: (cur && cur.filename) || info.filename || null,
        title: (cur && cur.title) || info.title || dom('hud-title'),
        artist: (cur && cur.artist) || info.artist || dom('hud-artist'),
        arrangement: (cur && cur.arrangement) || info.arrangement || dom('hud-arrangement'),
    };
}

function _pjCurrentSpeed() {
    try {
        if (window._juceMode && window.jucePlayer && window.jucePlayer._speed) {
            return window.jucePlayer._speed;
        }
        return document.getElementById('audio')?.playbackRate || 1.0;
    } catch (_) { return 1.0; }
}

function _pjStartSession() {
    const meta = _pjSongMeta();
    if (!meta.filename) return;                              // nothing playable yet
    if (_pjSessionStart && _pjFilename === meta.filename) return;  // already tracking it
    _pjEndSession();                                         // close a prior song's session
    _pjFilename = meta.filename;
    _pjTitle = meta.title;
    _pjArtist = meta.artist;
    _pjArrangement = meta.arrangement;
    _pjSessionStart = new Date().toISOString();
}

function _pjEndSession() {
    if (!_pjSessionStart || !_pjFilename) return;

    const duration = (Date.now() - new Date(_pjSessionStart).getTime()) / 1000;
    const avgSpeed = Math.round(_pjCurrentSpeed() * 100) / 100;

    // Fire and forget (backend ignores sessions under 5s)
    fetch('/api/plugins/practice_journal/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename: _pjFilename,
            title: _pjTitle,
            artist: _pjArtist,
            started_at: _pjSessionStart,
            duration: duration,
            avg_speed: avgSpeed,
            loops_used: [],
            arrangement: _pjArrangement,
        }),
    }).catch(() => {});

    _pjSessionStart = null;
    _pjFilename = null;
}

(function _pjInstall() {
    // Idempotency: don't double-register listeners on a re-eval / hot reload.
    const HOOK_KEY = '__feedBackPracticeHooksInstalled';
    if (window[HOOK_KEY]) return;
    window[HOOK_KEY] = true;

    const bus = window.feedBack || window.slopsmith;
    if (bus && typeof bus.on === 'function') {
        bus.on('song:play', _pjStartSession);
        bus.on('song:loaded', _pjStartSession);
        bus.on('song:ended', _pjEndSession);
        bus.on('song:stop', _pjEndSession);
        bus.on('screen:changed', (ev) => {
            const id = (ev && ev.detail && ev.detail.id) || null;
            if (id && id !== 'player') _pjEndSession();
            if (id === 'plugin-practice_journal') _pjLoadDashboard();
        });
    }
    // Backstop for closing the tab mid-session.
    window.addEventListener('beforeunload', _pjEndSession);
})();

// ── Dashboard ───────────────────────────────────────────────────────────

function _pjFormatDuration(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

async function _pjLoadDashboard() {
    try {
        const resp = await fetch('/api/plugins/practice_journal/stats');
        const data = await resp.json();

        // Stats cards
        document.getElementById('pj-today').textContent = _pjFormatDuration(data.today_time);
        document.getElementById('pj-week').textContent = _pjFormatDuration(data.week_time);
        document.getElementById('pj-total').textContent = _pjFormatDuration(data.total_time);
        document.getElementById('pj-songs').textContent = data.unique_songs;

        // Daily chart (bar chart)
        const chart = document.getElementById('pj-chart');
        if (data.daily.length === 0) {
            chart.innerHTML = '<p class="text-gray-600 text-sm w-full text-center">No practice data yet</p>';
        } else {
            const maxVal = Math.max(...data.daily.map(d => d.seconds), 1);
            // Fill in missing days
            const days = [];
            const now = new Date();
            for (let i = 29; i >= 0; i--) {
                const d = new Date(now);
                d.setDate(d.getDate() - i);
                const key = d.toISOString().split('T')[0];
                const found = data.daily.find(x => x.date === key);
                days.push({ date: key, seconds: found ? found.seconds : 0 });
            }
            chart.innerHTML = days.map(d => {
                const pct = Math.max(2, (d.seconds / maxVal) * 100);
                const day = new Date(d.date + 'T12:00:00').toLocaleDateString('en', { weekday: 'narrow' });
                const title = `${d.date}: ${_pjFormatDuration(d.seconds)}`;
                return `<div class="flex-1 flex flex-col items-center gap-1">
                    <div class="w-full rounded-t transition-all ${d.seconds > 0 ? 'bg-accent' : 'bg-dark-600'}"
                         style="height:${pct}%" title="${title}"></div>
                    <span class="text-gray-600 text-[9px]">${day}</span>
                </div>`;
            }).join('');
        }

        // Top songs
        const top = document.getElementById('pj-top');
        if (data.top_songs.length === 0) {
            top.innerHTML = '<p class="text-gray-600 text-sm">No songs practiced yet</p>';
        } else {
            const maxTime = data.top_songs[0]?.total_time || 1;
            top.innerHTML = data.top_songs.map(s => {
                const pct = (s.total_time / maxTime) * 100;
                return `<div class="bg-dark-700/50 border border-gray-800/50 rounded-lg p-3">
                    <div class="flex justify-between items-center mb-1">
                        <div class="min-w-0 flex-1">
                            <span class="text-sm text-white truncate block">${esc(s.title || s.filename)}</span>
                            <span class="text-xs text-gray-500">${esc(s.artist)}</span>
                        </div>
                        <span class="text-xs text-gray-400 ml-2 flex-shrink-0">${_pjFormatDuration(s.total_time)} · ${s.sessions}x</span>
                    </div>
                    <div class="h-1 bg-dark-600 rounded-full"><div class="h-1 bg-accent rounded-full" style="width:${pct}%"></div></div>
                </div>`;
            }).join('');
        }

        // Recent sessions
        const recent = document.getElementById('pj-recent');
        if (data.recent.length === 0) {
            recent.innerHTML = '<p class="text-gray-600 text-sm">No sessions yet. Play a song to start tracking!</p>';
        } else {
            recent.innerHTML = data.recent.map(s => {
                const date = new Date(s.started_at);
                const timeStr = date.toLocaleDateString('en', { month: 'short', day: 'numeric' })
                    + ' ' + date.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
                const speedStr = s.speed !== 1.0 ? ` · ${s.speed.toFixed(2)}x` : '';
                const arrStr = s.arrangement ? ` · ${s.arrangement}` : '';
                return `<div class="flex items-center justify-between py-2 px-3 bg-dark-700/30 rounded-lg">
                    <div class="min-w-0">
                        <span class="text-sm text-white truncate block">${esc(s.title || s.filename)}</span>
                        <span class="text-xs text-gray-500">${esc(s.artist)}${arrStr}</span>
                    </div>
                    <div class="text-right flex-shrink-0 ml-2">
                        <span class="text-xs text-gray-300 block">${_pjFormatDuration(s.duration)}${speedStr}</span>
                        <span class="text-xs text-gray-600">${timeStr}</span>
                    </div>
                </div>`;
            }).join('');
        }

    } catch (e) {
        console.error('Practice Journal load failed:', e);
    }
}
