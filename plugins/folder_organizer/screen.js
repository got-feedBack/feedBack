/* Folder Browser — screen.js
 * Plain JS, global scope, IIFE. Follows slopsmith plugin conventions.
 */
(function () {
'use strict';

const PLUGIN_ID  = 'folder_organizer';
const SCREEN_ID  = 'plugin-' + PLUGIN_ID;
const API        = '/api/plugin/folder_organizer';

// ── Safe localStorage helpers ─────────────────────────────────────────
function _store(key, val) {
    try {
        if (val === undefined) return localStorage.getItem('fo:' + key);
        localStorage.setItem('fo:' + key, val);
    } catch (_) { return null; }
}
function _storeJSON(key, val) {
    try {
        if (val === undefined) return JSON.parse(localStorage.getItem('fo:' + key) || 'null');
        localStorage.setItem('fo:' + key, JSON.stringify(val));
    } catch (_) { return null; }
}

// ── State ─────────────────────────────────────────────────────────────
let _tree        = null;
let _openFolders = new Set(_storeJSON('open') || []);
let _unsortedOpen = _store('unsorted_open') !== 'false';
let _query       = '';
let _loaded      = false;
let _view        = _store('view') || 'list'; // 'list' | 'grid'
let _sort        = _store('sort') || 'default'; // 'default' | 'title' | 'artist' | 'duration'
let _sortDir     = _store('sortDir') || 'asc';  // 'asc' | 'desc'
let _hoveredFolder = null; // { wrap, hdr, btnGroup } — only the innermost folder is active

// ── Core arrangement order (pinned to top of filter panel) ───────────
const _CORE_ARRANGEMENTS = ['Lead', 'Rhythm', 'Bass', 'Combo'];

// ── Flat list of every song in the tree (root + all nested folders) ───
function _allSongs() {
    if (!_tree) return [];
    var result = _tree.root_songs.slice();
    function _collectFolder(f) {
        f.songs.forEach(function (s) { result.push(s); });
        (f.children || []).forEach(_collectFolder);
    }
    _tree.folders.forEach(_collectFolder);
    return result;
}

// ── Dynamic arrangement / stem discovery ──────────────────────────────
function _getArrangements() {
    var counts = {};
    _allSongs().forEach(function (s) {
        (s.arrangements || []).forEach(function (a) { counts[a] = (counts[a] || 0) + 1; });
    });
    return Object.keys(counts).sort(function (a, b) { return (counts[b] - counts[a]) || a.localeCompare(b); });
}

function _getStems() {
    var counts = {};
    _allSongs().forEach(function (s) {
        (s.stems || []).forEach(function (st) { counts[st] = (counts[st] || 0) + 1; });
    });
    return Object.keys(counts).sort(function (a, b) { return (counts[b] - counts[a]) || a.localeCompare(b); });
}

// Returns which filter sections have actual data in the current library.
// The filter panel uses this to show/hide sections automatically — no manual
// toggling needed. Add songs with stems and the stems section reappears on reload.
function _getAvailableFilters() {
    var out = { arrangements: false, stems: false, lyrics: false, tuning: false };
    _allSongs().forEach(function (s) {
        if ((s.arrangements || []).length) out.arrangements = true;
        if ((s.stems        || []).length) out.stems        = true;
        if (s.lyrics)                      out.lyrics       = true;
        if (s.tuning)                      out.tuning       = true;
    });
    return out;
}

var _filtersRaw = _storeJSON('filters') || {};
function _normFilterGroup(g) {
    var out = {};
    for (var k in (g || {})) {
        var v = g[k];
        // normalise legacy values: 'require' → 'on', 'any' → 'off'
        out[k] = v === 'require' ? 'on' : v === 'any' ? 'off' : v;
    }
    return out;
}
let _filters = {
    arrangements: _normFilterGroup(_filtersRaw.arrangements),
    stems:        _normFilterGroup(_filtersRaw.stems),
    lyrics:       (_filtersRaw.lyrics === 'require' || _filtersRaw.lyrics === 'on') ? 'on'
                : (_filtersRaw.lyrics === 'exclude') ? 'exclude' : 'off',
    tunings:      _filtersRaw.tunings || [],
};

// ── DOM helpers ───────────────────────────────────────────────────────
function _el(id) { return document.getElementById(id); }


// ── Force screen to have height (Slopsmith .screen has no height set) ─
function _fixHeight() {
    const el = document.getElementById('plugin-' + PLUGIN_ID);
    const nav = document.querySelector('nav');
    const navH = nav ? nav.offsetHeight : 64;
    if (el) el.style.minHeight = (window.innerHeight - navH) + 'px';
}

// ── Close the nav plugin dropdown (it sits at z-50 and blocks clicks) ─
function _closeDropdown() {
    var dd = _el('plugin-dropdown');
    if (dd) dd.classList.add('hidden');
}

// ── Status ────────────────────────────────────────────────────────────
function _status(msg, isErr) {
    const el = _el('fb-status');
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'text-xs ml-1 ' + (isErr ? 'text-red-400' : 'text-gray-500');
}

// ── API helpers ───────────────────────────────────────────────────────
async function _api(path, body) {
    const opts = body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body) }
        : {};
    const res = await fetch(API + path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

// ── Fetch tree ────────────────────────────────────────────────────────
async function _load() {
    _status('Loading…');
    try {
        const data = await _api('/tree');
        if (data.error) { _status('⚠ ' + data.error, true); return; }
        _tree   = data;
        _loaded = true;
        _status('');
        _render();
        // Rebuild filter panel if it's open so tuning list reflects new data
        var fp = _el('fb-filter-panel');
        if (fp && fp.style.display !== 'none') _buildFilterPanel();
    } catch (err) {
        _status('Load failed: ' + err.message, true);
    }
}

// ── Filter helpers ────────────────────────────────────────────────────
function _match(song) {
    if (!_query) return true;
    const q = _query.toLowerCase();
    return (
        (song.title  || '').toLowerCase().includes(q) ||
        (song.artist || '').toLowerCase().includes(q) ||
        (song.album  || '').toLowerCase().includes(q) ||
        song.filename.toLowerCase().includes(q)
    );
}

function _filtered() {
    if (!_tree) return { folders: [], root_songs: [] };
    const hasQuery   = !!_query;
    const hasFilters = _activeFilterCount() > 0;
    if (!hasQuery && !hasFilters) return _tree;
    function _keep(s) {
        return (!hasQuery || _match(s)) && (!hasFilters || _matchFilters(s));
    }
    function _filterFolder(f) {
        var filteredSongs    = f.songs.filter(_keep);
        var filteredChildren = (f.children || []).map(_filterFolder).filter(function (c) {
            return c.songs.length || c.children.length;
        });
        return { name: f.name, path: f.path, songs: filteredSongs, children: filteredChildren };
    }
    const folders = _tree.folders.map(_filterFolder).filter(function (f) {
        return f.songs.length || f.children.length;
    });
    return { folders: folders, root_songs: _tree.root_songs.filter(_keep) };
}

// ── Filter helpers ────────────────────────────────────────────────────
function _saveFilters() {
    _storeJSON('filters', _filters);
}

function _activeFilterCount() {
    var n = 0;
    var arrVals = _filters.arrangements || {};
    for (var a in arrVals) { if (arrVals[a] === 'on' || arrVals[a] === 'exclude') n++; }
    var stemVals = _filters.stems || {};
    for (var s in stemVals) { if (stemVals[s] === 'on' || stemVals[s] === 'exclude') n++; }
    if (_filters.lyrics === 'on' || _filters.lyrics === 'exclude') n++;
    n += (_filters.tunings || []).length;
    return n;
}

function _matchFilters(song) {
    // Arrangements — include uses OR (song needs at least one selected),
    //                exclude uses AND (each excluded tag independently removes)
    var arrF    = _filters.arrangements || {};
    var songArr = song.arrangements || [];
    var onArr   = Object.keys(arrF).filter(function (a) { return arrF[a] === 'on'; });
    if (onArr.length && !onArr.some(function (a) { return songArr.indexOf(a) !== -1; })) return false;
    for (var a in arrF) {
        if (arrF[a] === 'exclude' && songArr.indexOf(a) !== -1) return false;
    }

    // Stems — same OR-include / AND-exclude logic
    var stemsF    = _filters.stems || {};
    var songStems = song.stems || [];
    var onStems   = Object.keys(stemsF).filter(function (s) { return stemsF[s] === 'on'; });
    if (onStems.length && !onStems.some(function (s) { return songStems.indexOf(s) !== -1; })) return false;
    for (var s in stemsF) {
        if (stemsF[s] === 'exclude' && songStems.indexOf(s) !== -1) return false;
    }

    if (_filters.lyrics === 'on'      && !song.lyrics) return false;
    if (_filters.lyrics === 'exclude' &&  song.lyrics) return false;
    var tunings = _filters.tunings || [];
    if (tunings.length) {
        var t = (song.tuning || '').trim();
        if (!t || tunings.indexOf(t) === -1) return false;
    }
    return true;
}

function _getTunings() {
    var counts = {};
    _allSongs().forEach(function (s) {
        var t = s.tuning ? String(s.tuning).trim() : '';
        if (t) counts[t] = (counts[t] || 0) + 1;
    });
    return Object.keys(counts)
        .sort(function (a, b) { return a.localeCompare(b); }) // alphabetical
        .map(function (t) { return { tuning: t, count: counts[t] }; });
}

// Split pill: left zone = include, right zone = exclude
// state: 'off' | 'on' | 'exclude'
function _makeSplitPill(label, state, onChange) {
    var pill = document.createElement('div');
    pill.style.cssText = 'display:inline-flex; border-radius:20px; border:1px solid; overflow:hidden;';

    var incBtn = document.createElement('button');
    incBtn.style.cssText = 'padding:4px 10px; background:none; border:none; border-right:1px solid; font-size:12px; cursor:pointer; white-space:nowrap;';
    incBtn.textContent = label;

    var excBtn = document.createElement('button');
    excBtn.style.cssText = 'padding:4px 8px; background:none; border:none; font-size:11px; cursor:pointer; line-height:1;';
    excBtn.title = 'Exclude';
    excBtn.textContent = '✕';

    function _apply() {
        if (state === 'on') {
            pill.style.borderColor   = '#2563eb';
            incBtn.style.background  = '#1d4ed8';
            incBtn.style.color       = '#fff';
            incBtn.style.borderRightColor = '#3b82f6';
            excBtn.style.background  = '#1d4ed8';
            excBtn.style.color       = 'rgba(255,255,255,0.45)';
        } else if (state === 'exclude') {
            pill.style.borderColor   = '#991b1b';
            incBtn.style.background  = 'transparent';
            incBtn.style.color       = '#fca5a5';
            incBtn.style.borderRightColor = '#7f1d1d';
            excBtn.style.background  = 'transparent';
            excBtn.style.color       = '#ef4444';
        } else {
            pill.style.borderColor   = '#374151';
            incBtn.style.background  = 'transparent';
            incBtn.style.color       = '#6b7280';
            incBtn.style.borderRightColor = '#374151';
            excBtn.style.background  = 'transparent';
            excBtn.style.color       = '#4b5563';
        }
    }
    _apply();

    incBtn.addEventListener('click', function () {
        state = (state === 'on') ? 'off' : 'on';
        _apply();
        onChange(state);
    });
    excBtn.addEventListener('click', function () {
        state = (state === 'exclude') ? 'off' : 'exclude';
        _apply();
        onChange(state);
    });

    pill.appendChild(incBtn);
    pill.appendChild(excBtn);
    return pill;
}

// ── Song date info (year + date added) — separate hover reveal ────────
function _buildSongDateInfo(song) {
    var parts = [];
    if (song.year != null && song.year !== '') parts.push(String(song.year));
    if (song.added) {
        var d = new Date(song.added * 1000);
        parts.push(d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }));
    }
    if (!parts.length) return null;
    var el = document.createElement('div');
    el.style.cssText = 'font-size:11px; font-weight:500; color:#cbd5e1; ' +
        'max-height:0; opacity:0; overflow:hidden; margin-top:0; ' +
        'transition:max-height 0.2s ease, opacity 0.15s, margin-top 0.15s;';
    el.textContent = parts.join('  ·  ');
    return el;
}

// ── Song metadata badges (visible when filters are active) ────────────
function _badge(text, active, type) {
    var b = document.createElement('span');
    // inactive colour per badge category
    var _typeColors = {
        arrangement: { border: '#92400e', color: '#fcd34d' }, // amber
        stem:        { border: '#5b21b6', color: '#c4b5fd' }, // violet
        lyrics:      { border: '#9f1239', color: '#fda4af' }, // rose
        tuning:      { border: '#0f766e', color: '#5eead4' }, // teal
    };
    var tc = (!active && type) ? (_typeColors[type] || null) : null;
    b.style.cssText = 'display:inline-block; padding:1px 6px; border-radius:3px; ' +
        'font-size:10px; font-weight:500; white-space:nowrap; cursor:pointer; ' +
        'border:1px solid ' + (active ? '#3b82f6' : (tc ? tc.border : '#334155')) + '; ' +
        'background:' + (active ? '#1d4ed8' : 'transparent') + '; ' +
        'color:'      + (active ? '#fff'    : (tc ? tc.color : '#cbd5e1')) + ';';
    b.textContent = text;
    return b;
}

function _buildSongBadges(song) {
    var wrap = document.createElement('div');
    // hidden by default — revealed on hover by the caller
    wrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px; ' +
        'max-height:0; opacity:0; overflow:hidden; margin-top:0; ' +
        'transition:max-height 0.2s ease, opacity 0.15s, margin-top 0.15s;';
    var any = false;
    var _seenArr  = {};
    var _seenStem = {};

    (song.arrangements || []).forEach(function (a) {
        if (_seenArr[a]) return; _seenArr[a] = true;
        var active = ((_filters.arrangements || {})[a] === 'on');
        var b = _badge(a, active, 'arrangement');
        b.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!_filters.arrangements) _filters.arrangements = {};
            _filters.arrangements[a] = active ? 'off' : 'on';
            _saveFilters(); _updateFilterBadge(); _render();
        });
        wrap.appendChild(b); any = true;
    });

    (song.stems || []).forEach(function (s) {
        if (_seenStem[s]) return; _seenStem[s] = true;
        var active = ((_filters.stems || {})[s] === 'on');
        var b = _badge(s, active, 'stem');
        b.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!_filters.stems) _filters.stems = {};
            _filters.stems[s] = active ? 'off' : 'on';
            _saveFilters(); _updateFilterBadge(); _render();
        });
        wrap.appendChild(b); any = true;
    });

    if (song.lyrics) {
        var lyrActive = (_filters.lyrics === 'on');
        var lb = _badge('♪ Lyrics', lyrActive, 'lyrics');
        lb.addEventListener('click', function (e) {
            e.stopPropagation();
            _filters.lyrics = lyrActive ? 'off' : 'on';
            _saveFilters(); _updateFilterBadge(); _render();
        });
        wrap.appendChild(lb); any = true;
    }

    if (song.tuning) {
        var t = song.tuning.trim();
        var tunActive = (_filters.tunings || []).indexOf(t) !== -1;
        var tb = _badge(t, tunActive, 'tuning');
        tb.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!_filters.tunings) _filters.tunings = [];
            var idx = _filters.tunings.indexOf(t);
            if (idx !== -1) _filters.tunings.splice(idx, 1);
            else            _filters.tunings.push(t);
            _saveFilters(); _updateFilterBadge(); _render();
        });
        wrap.appendChild(tb); any = true;
    }

    return any ? wrap : null;
}

function _revealBadges(el) {
    el.style.maxHeight  = '120px';
    el.style.opacity    = '1';
    el.style.marginTop  = '4px';
}
function _hideBadges(el) {
    el.style.maxHeight  = '0';
    el.style.opacity    = '0';
    el.style.marginTop  = '0';
}

function _updateFilterBadge() {
    var badge = _el('fb-filter-badge');
    if (!badge) return;
    var n = _activeFilterCount();
    badge.style.display = n ? 'block' : 'none';
    badge.textContent   = String(n);
}

// ── Filter panel sections ─────────────────────────────────────────────
function _makePillSection(sectionTitle, items, filterKey, extraItems) {
    var section = document.createElement('div');
    section.style.marginBottom = '20px';

    var hdr = document.createElement('div');
    hdr.style.cssText = 'font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#6b7280; margin-bottom:8px;';
    hdr.textContent = sectionTitle;
    section.appendChild(hdr);

    var pills = document.createElement('div');
    pills.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px;';

    function _addPill(item) {
        var state = ((_filters[filterKey] || {})[item]) || 'off';
        pills.appendChild(_makeSplitPill(item, state, function (next) {
            if (!_filters[filterKey]) _filters[filterKey] = {};
            _filters[filterKey][item] = next;
            _saveFilters();
            _updateFilterBadge();
            _render();
        }));
    }

    items.forEach(_addPill);

    if (extraItems && extraItems.length) {
        var sep = document.createElement('div');
        sep.style.cssText = 'width:100%; height:1px; background:#1f2937; margin:4px 0 2px;';
        pills.appendChild(sep);
        extraItems.forEach(_addPill);
    }

    section.appendChild(pills);
    return section;
}

function _makeLyricsSection() {
    var section = document.createElement('div');
    section.style.marginBottom = '20px';

    var hdr = document.createElement('div');
    hdr.style.cssText = 'font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#6b7280; margin-bottom:8px;';
    hdr.textContent = 'LYRICS';
    section.appendChild(hdr);

    var state = _filters.lyrics || 'off';
    section.appendChild(_makeSplitPill('Lyrics', state, function (next) {
        _filters.lyrics = next;
        _saveFilters();
        _updateFilterBadge();
        _render();
    }));
    return section;
}

function _makeTuningSection() {
    var section = document.createElement('div');
    section.style.marginBottom = '20px';

    var tunings = _getTunings();
    if (!tunings.length) return section;

    // header row with "N selected / All tunings" label
    var titleRow = document.createElement('div');
    titleRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;';

    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:#6b7280;';
    titleEl.textContent = 'TUNING';

    var allLbl = document.createElement('span');
    allLbl.style.cssText = 'font-size:11px; color:#6b7280;';
    function _updateAllLbl() {
        var n = (_filters.tunings || []).length;
        allLbl.textContent = n ? n + ' selected' : 'All tunings';
    }
    _updateAllLbl();

    titleRow.appendChild(titleEl);
    titleRow.appendChild(allLbl);
    section.appendChild(titleRow);

    var list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:2px;';

    tunings.forEach(function (entry) {
        var row = document.createElement('label');
        row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:5px 4px; cursor:pointer; border-radius:4px;';
        row.addEventListener('mouseenter', function () { row.style.background = '#111827'; });
        row.addEventListener('mouseleave', function () { row.style.background = ''; });

        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.style.cssText = 'width:14px; height:14px; accent-color:#3b82f6; cursor:pointer; flex-shrink:0;';
        cb.checked = (_filters.tunings || []).indexOf(entry.tuning) !== -1;

        var lbl = document.createElement('span');
        lbl.style.cssText = 'flex:1; font-size:13px; color:#d1d5db;';
        lbl.textContent = entry.tuning;

        var cnt = document.createElement('span');
        cnt.style.cssText = 'font-size:12px; color:#6b7280; font-variant-numeric:tabular-nums;';
        cnt.textContent = entry.count;

        cb.addEventListener('change', function () {
            if (!_filters.tunings) _filters.tunings = [];
            if (cb.checked) {
                if (_filters.tunings.indexOf(entry.tuning) === -1)
                    _filters.tunings.push(entry.tuning);
            } else {
                _filters.tunings = _filters.tunings.filter(function (t) { return t !== entry.tuning; });
            }
            _saveFilters();
            _updateAllLbl();
            _updateFilterBadge();
            _render();
        });

        row.appendChild(cb);
        row.appendChild(lbl);
        row.appendChild(cnt);
        list.appendChild(row);
    });

    section.appendChild(list);
    return section;
}

// ── Filter panel open / close ─────────────────────────────────────────
function _buildFilterPanel() {
    var panel = _el('fb-filter-panel');
    if (!panel) return;
    panel.innerHTML = '';

    // header
    var hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-bottom:1px solid #1f2937; flex-shrink:0;';
    var titleEl = document.createElement('span');
    titleEl.style.cssText = 'font-size:15px; font-weight:600; color:#e5e7eb;';
    titleEl.textContent = 'Filters';
    var closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'padding:4px; color:#6b7280; background:none; border:none; cursor:pointer; border-radius:4px;';
    closeBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:16px;height:16px"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>';
    closeBtn.addEventListener('click', _closeFilterPanel);
    hdr.appendChild(titleEl);
    hdr.appendChild(closeBtn);
    panel.appendChild(hdr);

    // scrollable content
    var content = document.createElement('div');
    content.style.cssText = 'overflow-y:auto; flex:1; padding:16px 20px;';
    var arrangements = _getArrangements();
    var stems        = _getStems();
    var avail        = _getAvailableFilters();
    if (arrangements.length) {
        var coreArr  = _CORE_ARRANGEMENTS.filter(function (a) { return arrangements.indexOf(a) !== -1; });
        var otherArr = arrangements.filter(function (a) { return _CORE_ARRANGEMENTS.indexOf(a) === -1; });
        content.appendChild(_makePillSection('ARRANGEMENTS',
            coreArr.length ? coreArr : arrangements,
            'arrangements',
            coreArr.length ? otherArr : []
        ));
    }
    if (stems.length)  content.appendChild(_makePillSection('STEMS (sloppak)', stems, 'stems'));
    if (avail.lyrics)  content.appendChild(_makeLyricsSection());
    if (avail.tuning)  content.appendChild(_makeTuningSection());
    panel.appendChild(content);

    // footer
    var footer = document.createElement('div');
    footer.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:14px 20px; border-top:1px solid #1f2937; flex-shrink:0;';
    var clearBtn = document.createElement('button');
    clearBtn.style.cssText = 'font-size:13px; color:#6b7280; background:none; border:none; cursor:pointer; padding:0;';
    clearBtn.textContent = 'Clear all';
    clearBtn.addEventListener('click', function () {
        _filters = { arrangements: {}, stems: {}, lyrics: 'off', tunings: [] };

        _saveFilters();
        _updateFilterBadge();
        _render();
        _buildFilterPanel(); // reset pill states
    });
    var doneBtn = document.createElement('button');
    doneBtn.style.cssText = 'padding:6px 20px; border-radius:6px; border:none; background:#3b82f6; color:#fff; font-size:13px; cursor:pointer; font-weight:500;';
    doneBtn.textContent = 'Done';
    doneBtn.addEventListener('click', _closeFilterPanel);
    footer.appendChild(clearBtn);
    footer.appendChild(doneBtn);
    panel.appendChild(footer);
}

function _openFilterPanel() {
    _buildFilterPanel();
    var panel    = _el('fb-filter-panel');
    var backdrop = _el('fb-filter-backdrop');
    if (panel)    panel.style.display    = 'flex';
    if (backdrop) backdrop.style.display = 'block';
}

function _closeFilterPanel() {
    var panel    = _el('fb-filter-panel');
    var backdrop = _el('fb-filter-backdrop');
    if (panel)    panel.style.display    = 'none';
    if (backdrop) backdrop.style.display = 'none';
}

// ── Sort helper ───────────────────────────────────────────────────────
function _sortSongs(songs) {
    if (_sort === 'default') return songs;
    var arr = songs.slice();
    if (_sort === 'title') {
        arr.sort(function (a, b) {
            return (a.title || a.filename).localeCompare(b.title || b.filename);
        });
    } else if (_sort === 'artist') {
        arr.sort(function (a, b) {
            return (a.artist || '').localeCompare(b.artist || '');
        });
    } else if (_sort === 'duration') {
        arr.sort(function (a, b) {
            return (a.duration || 0) - (b.duration || 0);
        });
    } else if (_sort === 'year') {
        arr.sort(function (a, b) {
            return (a.year || 0) - (b.year || 0);
        });
    } else if (_sort === 'tuning') {
        arr.sort(function (a, b) {
            return (a.tuning || '').localeCompare(b.tuning || '');
        });
    } else if (_sort === 'added') {
        arr.sort(function (a, b) {
            return (a.added || 0) - (b.added || 0);
        });
    }
    if (_sortDir === 'desc') arr.reverse();
    return arr;
}

// ── Custom modal (Electron blocks prompt/confirm) ─────────────────────
function _showModal(msg, withInput, defaultVal) {
    return new Promise(function (resolve) {
        const modal  = _el('fb-modal');
        const msgEl  = _el('fb-modal-msg');
        const input  = _el('fb-modal-input');
        const okBtn  = _el('fb-modal-ok');
        const cancel = _el('fb-modal-cancel');
        if (!modal) { resolve(null); return; }

        msgEl.textContent = msg;
        if (withInput) {
            input.style.display = 'block';
            input.value = defaultVal || '';
            setTimeout(function () { input.focus(); input.select(); }, 50);
        } else {
            input.style.display = 'none';
        }
        modal.style.display = 'flex';

        function _done(val) {
            modal.style.display = 'none';
            okBtn.removeEventListener('click', _ok);
            cancel.removeEventListener('click', _cancel);
            input.removeEventListener('keydown', _key);
            resolve(val);
        }
        function _ok()     { _done(withInput ? input.value.trim() : true); }
        function _cancel() { _done(null); }
        function _key(e) {
            if (e.key === 'Enter')  { e.preventDefault(); _ok(); }
            if (e.key === 'Escape') { e.preventDefault(); _cancel(); }
        }

        okBtn.addEventListener('click', _ok);
        cancel.addEventListener('click', _cancel);
        if (withInput) input.addEventListener('keydown', _key);
    });
}

function _confirm(msg)         { return _showModal(msg, false, ''); }
function _prompt(msg, def)     { return _showModal(msg, true,  def || ''); }

// ── Song card (grid view) ─────────────────────────────────────────────
function _songCard(song, folderName) {
    const card = document.createElement('div');
    card.className = 'flex flex-col rounded-lg overflow-hidden cursor-pointer group transition-transform duration-100 hover:scale-105';
    card.style.background = '#1a1d2e';
    card.dataset.filename = song.filename;

    // art
    const artWrap = document.createElement('div');
    artWrap.style.cssText = 'position:relative; width:100%; padding-bottom:100%; background:#111827; overflow:hidden;';

    const img = document.createElement('img');
    img.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; object-fit:cover;';
    img.alt = '';
    img.loading = 'lazy';
    img.src = '/api/song/' + song.filename.split('/').map(encodeURIComponent).join('/') + '/art';

    // placeholder shown while loading or on error
    const placeholder = document.createElement('div');
    placeholder.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center;';
    placeholder.innerHTML = `<svg viewBox="0 0 48 48" fill="none" stroke="#374151" stroke-width="1.5" style="width:40px;height:40px">
        <path d="M6 12a4 4 0 014-4h4l4 4h16a4 4 0 014 4v16a4 4 0 01-4 4H10a4 4 0 01-4-4V12z"/>
        <circle cx="20" cy="26" r="3"/><path d="M23 26v-8l8-2v8"/><circle cx="31" cy="24" r="3"/>
    </svg>`;

    img.addEventListener('error', function () {
        img.style.display = 'none';
        placeholder.style.display = 'flex';
    });
    img.addEventListener('load', function () {
        placeholder.style.display = 'none';
    });

    artWrap.appendChild(placeholder);
    artWrap.appendChild(img);

    // duration badge — appended last so it sits above the image in stacking order
    if (song.duration != null) {
        const badge = document.createElement('span');
        badge.style.cssText = 'position:absolute; bottom:6px; right:6px; padding:2px 6px; border-radius:4px; font-size:11px; font-weight:600; color:#e5e7eb; background:rgba(0,0,0,0.7);';
        const m = Math.floor(song.duration / 60);
        const s = String(Math.floor(song.duration % 60)).padStart(2, '0');
        badge.textContent = m + ':' + s;
        artWrap.appendChild(badge);
    }

    // meta
    const meta = document.createElement('div');
    meta.style.cssText = 'padding:8px 10px 10px; flex:1; min-width:0;';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:13px; font-weight:600; color:#e5e7eb; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
    title.textContent = song.title || song.filename;

    const sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px; color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px;';
    sub.textContent = [song.artist, song.album].filter(Boolean).join(' — ') || '';

    var cardBadges = _buildSongBadges(song);
    if (cardBadges) {
        meta.appendChild(cardBadges);
        card.addEventListener('mouseenter', function () { _revealBadges(cardBadges); });
        card.addEventListener('mouseleave', function () { _hideBadges(cardBadges); });
    }
    var cardDateInfo = _buildSongDateInfo(song);
    if (cardDateInfo) {
        meta.appendChild(cardDateInfo);
        card.addEventListener('mouseenter', function () { _revealBadges(cardDateInfo); });
        card.addEventListener('mouseleave', function () { _hideBadges(cardDateInfo); });
    }

    // move button
    const moveBtn = document.createElement('button');
    moveBtn.style.cssText = 'position:absolute; top:6px; right:6px; padding:4px; border-radius:4px; background:rgba(0,0,0,0.6); color:#9ca3af; border:none; cursor:pointer; display:none;';
    moveBtn.title = 'Move to folder…';
    moveBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" style="width:12px;height:12px">
        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
        <path fill-rule="evenodd" d="M10 11a1 1 0 011 1v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2v-2a1 1 0 011-1z" clip-rule="evenodd"/>
    </svg>`;
    card.addEventListener('mouseenter', function () { moveBtn.style.display = 'block'; });
    card.addEventListener('mouseleave', function () { moveBtn.style.display = 'none'; });
    moveBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        _moveSong(song, folderName);
    });

    artWrap.style.position = 'relative';
    artWrap.appendChild(moveBtn);

    meta.appendChild(title);
    meta.appendChild(sub);
    card.appendChild(artWrap);
    card.appendChild(meta);

    card.addEventListener('click', function () {
        if (typeof window.playSong === 'function') window.playSong(song.filename);
    });

    _makeDraggable(card, song, folderName);
    return card;
}

// ── Song row ──────────────────────────────────────────────────────────
function _songRow(song, folderName) {
    const row = document.createElement('div');
    row.className = [
        'flex items-center gap-3 px-3 py-2 rounded cursor-pointer',
        'hover:bg-dark-500 group transition-colors duration-100',
    ].join(' ');
    row.dataset.filename = song.filename;

    // small album art thumbnail
    const thumb = document.createElement('div');
    thumb.style.cssText = 'shrink:0; width:36px; height:36px; border-radius:4px; overflow:hidden; background:#111827; flex-shrink:0; position:relative;';
    const thumbImg = document.createElement('img');
    thumbImg.loading = 'lazy';
    thumbImg.src = '/api/song/' + song.filename.split('/').map(encodeURIComponent).join('/') + '/art';
    thumbImg.alt = '';
    thumbImg.style.cssText = 'width:100%; height:100%; object-fit:cover;';
    const thumbPlaceholder = document.createElement('div');
    thumbPlaceholder.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center;';
    thumbPlaceholder.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="#374151" stroke-width="1.5" style="width:14px;height:14px">
        <path d="M9 19H5a2 2 0 01-2-2V7a2 2 0 012-2h2l2 2h6a2 2 0 012 2v2"/>
        <circle cx="13" cy="16" r="2"/><path d="M15 16v-4l3-1v4"/><circle cx="18" cy="15" r="2"/>
    </svg>`;
    thumbImg.addEventListener('error', function () {
        thumbImg.style.display = 'none';
        thumbPlaceholder.style.display = 'flex';
    });
    thumbImg.addEventListener('load', function () {
        thumbPlaceholder.style.display = 'none';
    });
    thumb.appendChild(thumbPlaceholder);
    thumb.appendChild(thumbImg);

    // meta
    const meta = document.createElement('div');
    meta.className = 'flex-1 min-w-0';
    const title = document.createElement('div');
    title.className = 'text-gray-200 truncate group-hover:text-white';
    title.style.cssText = 'font-size:13px; font-weight:600;';
    title.textContent = song.title || song.filename;
    const sub = document.createElement('div');
    sub.className = 'text-gray-500 truncate';
    sub.style.fontSize = '11px';
    sub.textContent = [song.artist, song.album].filter(Boolean).join(' — ') || '';
    meta.appendChild(title);
    meta.appendChild(sub);
    var rowBadges = _buildSongBadges(song);
    if (rowBadges) {
        meta.appendChild(rowBadges);
        row.addEventListener('mouseenter', function () { _revealBadges(rowBadges); });
        row.addEventListener('mouseleave', function () { _hideBadges(rowBadges); });
    }
    var rowDateInfo = _buildSongDateInfo(song);
    if (rowDateInfo) {
        meta.appendChild(rowDateInfo);
        row.addEventListener('mouseenter', function () { _revealBadges(rowDateInfo); });
        row.addEventListener('mouseleave', function () { _hideBadges(rowDateInfo); });
    }

    // play icon (right side)
    const icon = document.createElement('span');
    icon.className = 'shrink-0 w-4 h-4 text-dark-400 group-hover:text-blue-400 transition-colors opacity-0 group-hover:opacity-100';
    icon.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full">
        <path fill-rule="evenodd"
              d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z"
              clip-rule="evenodd"/></svg>`;

    // duration
    const dur = document.createElement('span');
    dur.className = 'shrink-0 text-xs text-gray-600 tabular-nums';
    if (song.duration != null) {
        const m = Math.floor(song.duration / 60);
        const s = String(Math.floor(song.duration % 60)).padStart(2, '0');
        dur.textContent = m + ':' + s;
    }

    // move button (hidden until hover)
    const moveBtn = document.createElement('button');
    moveBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400 opacity-0 group-hover:opacity-100 transition-opacity';
    moveBtn.title = 'Move to folder…';
    moveBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px">
        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
        <path fill-rule="evenodd" d="M10 11a1 1 0 011 1v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2v-2a1 1 0 011-1z" clip-rule="evenodd"/></svg>`;

    moveBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        _moveSong(song, folderName);
    });

    row.appendChild(thumb);
    row.appendChild(meta);
    row.appendChild(icon);
    row.appendChild(dur);
    row.appendChild(moveBtn);

    row.addEventListener('click', function () {
        if (typeof window.playSong === 'function') window.playSong(song.filename);
    });

    _makeDraggable(row, song, folderName);
    return row;
}

// ── Pointer-based drag (mousedown/mousemove/mouseup) ─────────────────
// HTML5 DnD blocks wheel events and gives unreliable edge positions in
// Electron — pointer events give full control over both.
let _dragState         = null;
let _dragCurrentTarget = null;

const _DRAG_THRESH = 5;
const _DRAG_ZONE   = 150;
const _DRAG_SPEED  = 50;

let _dragRafId = null;
let _scrollEl          = null;

function _getScrollEl() {
    if (_scrollEl) return _scrollEl;
    var el = document.getElementById('fb-tree');
    while (el && el !== document.documentElement) {
        var ov = window.getComputedStyle(el).overflowY;
        if ((ov === 'auto' || ov === 'scroll' || ov === 'overlay') && el.scrollHeight > el.clientHeight) {
            _scrollEl = el;
            return _scrollEl;
        }
        el = el.parentElement;
    }
    _scrollEl = document.scrollingElement || document.documentElement;
    return _scrollEl;
}

function _dragFindTarget(x, y) {
    const els = document.elementsFromPoint(x, y);
    for (var i = 0; i < els.length; i++) {
        if ('dropFolder' in (els[i].dataset || {})) return els[i];
    }
    return null;
}

function _dragHighlight(target) {
    if (_dragCurrentTarget === target) return;
    if (_dragCurrentTarget) _dragCurrentTarget.style.outline = '';
    _dragCurrentTarget = target;
    if (target) {
        target.style.outline = '2px solid #3b82f6';
        target.style.borderRadius = '6px';
    }
}

function _dragScrollTick() {
    if (!_dragState || !_dragState.live) { _dragRafId = null; return; }
    var h  = window.innerHeight;
    var y  = _dragState.y;
    var sc = _getScrollEl();
    sc.style.scrollBehavior = 'auto';
    if (y < _DRAG_ZONE)           sc.scrollTop -= _DRAG_SPEED;
    else if (y > h - _DRAG_ZONE)  sc.scrollTop += _DRAG_SPEED;
    _dragRafId = requestAnimationFrame(_dragScrollTick);
}

function _onDragMove(e) {
    if (!_dragState) return;
    _dragState.x = e.clientX;
    _dragState.y = e.clientY;

    if (!_dragState.live) {
        var dx = _dragState.x - _dragState.startX;
        var dy = _dragState.y - _dragState.startY;
        if (Math.sqrt(dx * dx + dy * dy) < _DRAG_THRESH) return;
        _dragState.live = true;
        var ghost = document.createElement('div');
        ghost.style.cssText = 'position:fixed; pointer-events:none; z-index:9999; ' +
            'padding:5px 12px; background:#1e2130; border:1px solid #3b82f6; ' +
            'border-radius:6px; color:#e5e7eb; font-size:12px; white-space:nowrap; ' +
            'box-shadow:0 4px 20px rgba(0,0,0,0.5);';
        ghost.textContent = _dragState.data.label;
        document.body.appendChild(ghost);
        _dragState.ghost = ghost;
        if (!_dragRafId) _dragRafId = requestAnimationFrame(_dragScrollTick);
    }

    if (_dragState.ghost) {
        _dragState.ghost.style.left = (_dragState.x + 14) + 'px';
        _dragState.ghost.style.top  = (_dragState.y + 14) + 'px';
    }
    _dragHighlight(_dragFindTarget(_dragState.x, _dragState.y));
}

function _onDragUp(e) {
    if (!_dragState) return;
    var wasDrag = _dragState.live;
    var data    = _dragState.data;
    var x = e.clientX, y = e.clientY;
    _endPointerDrag();

    if (wasDrag) {
        // Suppress the click event that fires after mouseup so song doesn't play
        document.addEventListener('click', function (ce) {
            ce.stopPropagation();
            ce.preventDefault();
        }, { capture: true, once: true });
        var target = _dragFindTarget(x, y);
        if (target && data) {
            var targetFolder = target.dataset.dropFolder;
            if (targetFolder !== data.folder) _executeDrop(data, targetFolder);
        }
    }
}

function _onDragKeyDown(e) {
    if (e.key === 'Escape') _endPointerDrag();
}

function _endPointerDrag() {
    if (_dragRafId) { cancelAnimationFrame(_dragRafId); _dragRafId = null; }
    if (_dragState && _dragState.ghost) _dragState.ghost.remove();
    if (_dragCurrentTarget) { _dragCurrentTarget.style.outline = ''; _dragCurrentTarget = null; }
    document.body.style.userSelect = '';
    _dragState = null;
    document.removeEventListener('mousemove', _onDragMove);
    document.removeEventListener('mouseup', _onDragUp);
    document.removeEventListener('keydown', _onDragKeyDown);
}

function _findFolderByPath(path, folders) {
    for (var i = 0; i < folders.length; i++) {
        if (folders[i].path === path) return folders[i];
        var found = _findFolderByPath(path, folders[i].children || []);
        if (found) return found;
    }
    return null;
}

async function _executeDrop(data, targetFolder) {
    // No optimistic tree mutation — the drag ghost gives instant visual
    // feedback, and racing optimistic updates against _load() caused
    // songs to snap back when dropping quickly in succession.
    // Just call the API and reload; on localhost this is imperceptible.
    if (targetFolder !== '') _openFolders.add(targetFolder);
    else _unsortedOpen = true;
    try {
        await _api('/song/move', { filename: data.filename, folder: targetFolder });
    } catch (err) {
        _status('Move failed: ' + err.message, true);
    }
    await _load();
}

function _makeDraggable(el, song, folderName) {
    el.style.cursor = 'grab';
    el.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        document.body.style.userSelect = 'none';
        var sel = window.getSelection();
        if (sel) sel.removeAllRanges();
        _dragState = {
            data: { filename: song.filename, folder: folderName || '', label: '↕  ' + (song.title || song.filename) },
            startX: e.clientX, startY: e.clientY,
            x: e.clientX, y: e.clientY,
            live: false, ghost: null,
        };
        document.addEventListener('mousemove', _onDragMove);
        document.addEventListener('mouseup', _onDragUp);
        document.addEventListener('keydown', _onDragKeyDown);
    });
    el.addEventListener('dragstart', function (e) { e.preventDefault(); });
}

function _makeDropTarget(el, targetFolder) {
    el.dataset.dropFolder = targetFolder == null ? '' : targetFolder;
}

// ── Move song dialog ──────────────────────────────────────────────────
async function _moveSong(song, currentFolderPath) {
    if (!_tree) return;
    // Collect all folder paths recursively
    var allPaths = [];
    function _collectPaths(f) {
        allPaths.push(f.path);
        (f.children || []).forEach(_collectPaths);
    }
    _tree.folders.forEach(_collectPaths);
    var folderPaths = allPaths.filter(function (p) { return p !== currentFolderPath; });
    const options = ['(Unsorted)', ...folderPaths];
    const choice = await _prompt(
        'Move "' + (song.title || song.filename) + '" to:\n' +
        options.map((n, i) => i + ': ' + n).join('\n') +
        '\n\nEnter number or folder path:',
        ''
    );
    if (!choice && choice !== 0) return;
    let dest = '';
    const idx = parseInt(choice, 10);
    if (!isNaN(idx) && idx >= 0 && idx < options.length) {
        dest = idx === 0 ? '' : options[idx];
    } else {
        dest = choice.trim() === '(Unsorted)' ? '' : choice.trim();
    }
    try {
        await _api('/song/move', { filename: song.filename, folder: dest });
        await _load();
    } catch (err) {
        await _prompt('Move failed: ' + err.message, '');
    }
}

// ── Folder header ─────────────────────────────────────────────────────
function _folderSection(folder, depth) {
    depth = depth || 0;
    const open = _query ? true : _openFolders.has(folder.path);
    const wrap = document.createElement('div');

    // deep song count — direct + all nested
    function _countDeep(f) {
        var n = f.songs.length;
        (f.children || []).forEach(function (c) { n += _countDeep(c); });
        return n;
    }
    // deep subfolder count — all nested subfolders
    function _countFoldersDeep(f) {
        var n = (f.children || []).length;
        (f.children || []).forEach(function (c) { n += _countFoldersDeep(c); });
        return n;
    }

    // header
    const hdr = document.createElement('div');
    hdr.className = 'flex items-center gap-2 px-3 py-2 rounded cursor-pointer group';
    hdr.style.transition = 'background-color 0.1s';

    // chevron
    const chev = document.createElement('span');
    chev.className = 'shrink-0 w-4 h-4 text-gray-500 transition-transform duration-150';
    chev.style.transform = open ? 'rotate(90deg)' : '';
    chev.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full">
        <path fill-rule="evenodd"
              d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
              clip-rule="evenodd"/></svg>`;

    // folder icon — slightly muted for nested folders
    const ico = document.createElement('span');
    ico.className = 'shrink-0 w-4 h-4 ' + (depth > 0 ? 'text-yellow-600' : 'text-yellow-500');
    ico.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full">
        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>`;

    const lbl = document.createElement('span');
    lbl.className = 'flex-1 truncate font-medium ' +
        (depth > 0 ? 'text-xs text-gray-400' : 'text-sm text-gray-200');
    lbl.textContent = folder.name;

    const cnt = document.createElement('span');
    cnt.className = 'shrink-0 text-xs text-gray-600 tabular-nums mr-1';
    cnt.textContent = String(folder.songs.length);

    // subfolder create button
    const subBtn = document.createElement('button');
    subBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400';
    subBtn.title = 'New subfolder';
    subBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px">
        <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
        <path fill-rule="evenodd" d="M10 11a1 1 0 011 1v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2v-2a1 1 0 011-1z" clip-rule="evenodd"/>
    </svg>`;
    subBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        _createFolder(folder.path);
    });

    // rename button
    const renameBtn = document.createElement('button');
    renameBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400';
    renameBtn.title = 'Rename folder';
    renameBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px">
        <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>`;
    renameBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        _renameFolder(folder.path);
    });

    // delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-red-400 hover:bg-dark-400';
    delBtn.title = 'Delete folder';
    delBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px">
        <path fill-rule="evenodd"
              d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
              clip-rule="evenodd"/></svg>`;
    delBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        _deleteFolder(folder.path, _countDeep(folder), _countFoldersDeep(folder));
    });

    // expand-all / collapse-all children buttons (only when folder has subfolders)
    const expandChildrenBtn  = document.createElement('button');
    const collapseChildrenBtn = document.createElement('button');
    if (folder.children && folder.children.length) {
        expandChildrenBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400';
        expandChildrenBtn.title = 'Expand all subfolders';
        expandChildrenBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px">
            <path d="M5 8l5 5 5-5"/>
            <path d="M5 4l5 5 5-5" opacity=".4"/>
        </svg>`;
        expandChildrenBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _openFolders.add(folder.path);
            (folder.children || []).forEach(function (c) { _openFolders.add(c.path); });
            _storeJSON('open', [..._openFolders]);
            _render();
        });

        collapseChildrenBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400';
        collapseChildrenBtn.title = 'Collapse all subfolders';
        collapseChildrenBtn.innerHTML = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px">
            <path d="M5 12l5-5 5 5"/>
            <path d="M5 16l5-5 5 5" opacity=".4"/>
        </svg>`;
        collapseChildrenBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            (folder.children || []).forEach(function (c) { _openFolders.delete(c.path); });
            _storeJSON('open', [..._openFolders]);
            _render();
        });
    }

    // Collapsing button group — takes 0 width when hidden, slides in on hover,
    // pushing the song count smoothly to the left.
    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex; align-items:center; gap:2px; max-width:0; overflow:hidden; transition:max-width 0.2s ease;';
    if (folder.children && folder.children.length) {
        btnGroup.appendChild(expandChildrenBtn);
        btnGroup.appendChild(collapseChildrenBtn);
    }
    btnGroup.appendChild(subBtn);
    btnGroup.appendChild(renameBtn);
    btnGroup.appendChild(delBtn);

    // Use mouseover (bubbles) + stopPropagation so only the innermost folder activates.
    // A module-level _hoveredFolder ref ensures the previously active folder is always
    // cleared before the new one lights up — avoiding the ancestor stack-highlight bug.
    wrap.style.cssText = 'border-radius:6px; margin:1px 0;';
    wrap.addEventListener('mouseover', function (e) {
        if (_dragState) return; // don't shift layout during drag
        e.stopPropagation();
        if (_hoveredFolder && _hoveredFolder.wrap !== wrap) {
            _hoveredFolder.hdr.style.backgroundColor = '';
            _hoveredFolder.wrap.style.backgroundColor = '';
            _hoveredFolder.btnGroup.style.maxWidth = '0';
        }
        _hoveredFolder = { wrap, hdr, btnGroup };
        hdr.style.backgroundColor = 'rgba(55,65,81,0.5)';
        wrap.style.backgroundColor = 'rgba(55,65,81,0.12)';
        btnGroup.style.maxWidth = '160px';
    });
    wrap.addEventListener('mouseout', function (e) {
        if (_dragState) return;
        if (wrap.contains(e.relatedTarget)) return;
        hdr.style.backgroundColor = '';
        wrap.style.backgroundColor = '';
        btnGroup.style.maxWidth = '0';
        if (_hoveredFolder && _hoveredFolder.wrap === wrap) _hoveredFolder = null;
    });

    // cnt sits after btnGroup so it rests at the far right when buttons are hidden
    hdr.appendChild(chev);
    hdr.appendChild(ico);
    hdr.appendChild(lbl);
    hdr.appendChild(btnGroup);
    hdr.appendChild(cnt);

    _makeDropTarget(hdr, folder.path);

    // content area — wraps song list + nested children, toggled as one unit
    const content = document.createElement('div');
    if (!open) content.style.display = 'none';

    // song list/grid — only populated for open folders to keep initial render fast
    const list = document.createElement('div');
    if (_view === 'grid') {
        list.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill,150px); justify-content:start; gap:12px; padding:8px 4px 8px 24px;';
    } else {
        list.className = 'ml-5 mt-0.5 space-y-0';
    }
    _makeDropTarget(list, folder.path);

    // nested children container (no border — border is applied at the wrap level below)
    const childrenWrap = document.createElement('div');

    // Suppress grid padding on empty song lists — prevents a blank amber stub
    // from appearing when a subfolder has children but no direct songs.
    if (_view === 'grid' && !folder.songs.length) list.style.padding = '0';

    let _listPopulated = open;
    function _populateFolderList() {
        // Songs first (primary content), then subfolders below
        _sortSongs(folder.songs).forEach(function (s) {
            list.appendChild(_view === 'grid' ? _songCard(s, folder.path) : _songRow(s, folder.path));
        });
        (folder.children || []).forEach(function (child) {
            childrenWrap.appendChild(_folderSection(child, depth + 1));
        });
    }
    if (open) _populateFolderList();

    // depth > 0: ONE container with a single continuous amber border-left so both
    // songs and child folders are visually grouped under this subfolder.
    // depth == 0: children get their own subtle neutral-border indent; root songs are unbordered.
    let innerWrap = null;
    if (depth > 0) {
        innerWrap = document.createElement('div');
        innerWrap.style.cssText = 'margin-left:32px; padding-left:10px; border-left:2px solid rgba(234,179,8,0.35);';
        innerWrap.appendChild(list);
        innerWrap.appendChild(childrenWrap);
        content.appendChild(innerWrap);
    } else {
        childrenWrap.style.marginLeft = '32px';
        content.appendChild(list);
        content.appendChild(childrenWrap);
    }

    // Clicking blank content area (not on a song/button/subfolder) also collapses
    content.addEventListener('click', function (e) {
        if (_query) return;
        var bgEls = [content, list, childrenWrap];
        if (innerWrap) bgEls.push(innerWrap);
        if (bgEls.indexOf(e.target) === -1) return;
        if (content.style.display !== 'none') {
            content.style.display = 'none';
            chev.style.transform = '';
            _openFolders.delete(folder.path);
            _storeJSON('open', [..._openFolders]);
        }
    });

    hdr.addEventListener('click', function () {
        if (_query) return;
        const nowOpen = content.style.display === 'none';
        if (nowOpen && !_listPopulated) { _populateFolderList(); _listPopulated = true; }
        content.style.display = nowOpen ? '' : 'none';
        chev.style.transform = nowOpen ? 'rotate(90deg)' : '';
        if (nowOpen) _openFolders.add(folder.path);
        else         _openFolders.delete(folder.path);
        _storeJSON('open', [..._openFolders]);
    });

    wrap.appendChild(hdr);
    wrap.appendChild(content);
    return wrap;
}

// ── Unsorted section ──────────────────────────────────────────────────
function _unsortedSection(songs) {
    if (!songs.length && _query) return null;
    const wrap = document.createElement('div');
    wrap.className = 'mb-1';

    const hdr = document.createElement('div');
    hdr.className = [
        'flex items-center gap-2 px-3 py-2 rounded cursor-pointer',
        'hover:bg-dark-500 transition-colors duration-100',
    ].join(' ');

    const chev = document.createElement('span');
    chev.className = 'shrink-0 w-4 h-4 text-gray-600 transition-transform duration-150';
    chev.style.transform = _unsortedOpen ? 'rotate(90deg)' : '';
    chev.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full">
        <path fill-rule="evenodd"
              d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
              clip-rule="evenodd"/></svg>`;

    const ico = document.createElement('span');
    ico.className = 'shrink-0 w-4 h-4 text-gray-600';
    ico.innerHTML = `<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full">
        <path d="M2 6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>`;

    const lbl = document.createElement('span');
    lbl.className = 'flex-1 text-xs font-semibold uppercase tracking-widest text-gray-600';
    lbl.textContent = 'Unsorted';

    const cnt = document.createElement('span');
    cnt.className = 'shrink-0 text-xs text-gray-700 tabular-nums';
    cnt.textContent = String(songs.length);

    hdr.appendChild(chev);
    hdr.appendChild(ico);
    hdr.appendChild(lbl);
    hdr.appendChild(cnt);

    _makeDropTarget(hdr, '');

    const list = document.createElement('div');
    if (_view === 'grid') {
        list.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill,150px); justify-content:start; gap:12px; padding:8px 4px 8px 24px;';
    } else {
        list.className = 'ml-5 mt-0.5 space-y-0';
    }
    let _unsortedPopulated = _unsortedOpen;
    function _populateUnsortedList() {
        _sortSongs(songs).forEach(function (s) {
            list.appendChild(_view === 'grid' ? _songCard(s, '') : _songRow(s, ''));
        });
    }
    if (_unsortedOpen) { _populateUnsortedList(); } else { list.style.display = 'none'; }
    _makeDropTarget(list, '');

    hdr.addEventListener('click', function () {
        if (_query) return;
        _unsortedOpen = list.style.display === 'none';
        if (_unsortedOpen && !_unsortedPopulated) { _populateUnsortedList(); _unsortedPopulated = true; }
        list.style.display = _unsortedOpen ? (_view === 'grid' ? 'grid' : '') : 'none';
        chev.style.transform = _unsortedOpen ? 'rotate(90deg)' : '';
        _store('unsorted_open', String(_unsortedOpen));
    });

    wrap.appendChild(hdr);
    wrap.appendChild(list);
    return wrap;
}

// ── Folder management ─────────────────────────────────────────────────
async function _createFolder(parentPath) {
    var promptMsg = parentPath
        ? 'New subfolder name in "' + parentPath.split('/').pop() + '":'
        : 'New folder name:';
    const name = await _prompt(promptMsg);
    if (!name || !name.trim()) return;
    try {
        const body = { name: name.trim() };
        if (parentPath) body.parent = parentPath;
        await _api('/folder/create', body);
        var newPath = parentPath ? parentPath + '/' + name.trim() : name.trim();
        if (parentPath) _openFolders.add(parentPath); // keep parent open so child is visible
        _openFolders.add(newPath);
        await _load();
    } catch (err) {
        await _prompt('Create failed: ' + err.message);
    }
}

async function _renameFolder(folderPath) {
    var oldName = folderPath.split('/').pop();
    const newName = await _prompt('Rename "' + oldName + '" to:', oldName);
    if (!newName || !newName.trim() || newName.trim() === oldName) return;
    try {
        await _api('/folder/rename', { old: folderPath, new: newName.trim() });
        // Update all open-folder paths that match or are beneath the renamed path
        var parts = folderPath.split('/');
        parts[parts.length - 1] = newName.trim();
        var newPath = parts.join('/');
        var updated = new Set();
        _openFolders.forEach(function (p) {
            if (p === folderPath) {
                updated.add(newPath);
            } else if (p.startsWith(folderPath + '/')) {
                updated.add(newPath + p.slice(folderPath.length));
            } else {
                updated.add(p);
            }
        });
        _openFolders = updated;
        _storeJSON('open', [..._openFolders]);
        await _load();
    } catch (err) {
        await _prompt('Rename failed: ' + err.message);
    }
}

async function _deleteFolder(folderPath, songCount, folderCount) {
    var folderName = folderPath.split('/').pop();
    var parts = [];
    if (songCount > 0)   parts.push(songCount  + ' song'      + (songCount  === 1 ? '' : 's'));
    if (folderCount > 0) parts.push(folderCount + ' subfolder' + (folderCount === 1 ? '' : 's'));
    var msg = parts.length
        ? 'Delete "' + folderName + '"? It contains ' + parts.join(' and ') + '. Songs will be moved to Unsorted.'
        : 'Delete empty folder "' + folderName + '"?';
    const ok = await _confirm(msg);
    if (!ok) return;
    try {
        await _api('/folder/delete', { name: folderPath });
        // Remove this path and all descendant paths from open state
        var toDelete = [];
        _openFolders.forEach(function (p) {
            if (p === folderPath || p.startsWith(folderPath + '/')) toDelete.push(p);
        });
        toDelete.forEach(function (p) { _openFolders.delete(p); });
        _storeJSON('open', [..._openFolders]);
        await _load();
    } catch (err) {
        await _prompt('Delete failed: ' + err.message);
    }
}

// ── Expand / collapse all ─────────────────────────────────────────────
function _expandAll() {
    if (!_tree) return;
    function _addPaths(f) {
        _openFolders.add(f.path);
        (f.children || []).forEach(_addPaths);
    }
    _tree.folders.forEach(_addPaths);
    _unsortedOpen = true;
    _storeJSON('open', [..._openFolders]);
    _store('unsorted_open', 'true');
    _render();
}
function _collapseAll() {
    _openFolders.clear();
    _unsortedOpen = false;
    _storeJSON('open', []);
    _store('unsorted_open', 'false');
    _render();
}

// ── Render ────────────────────────────────────────────────────────────
function _render() {
    _hoveredFolder = null; // DOM is rebuilt; discard any stale reference
    const treeEl = _el('fb-tree');
    if (!treeEl) return;

    const data = _filtered();
    const frag = document.createDocumentFragment();

    // Unsorted
    const unsorted = _unsortedSection(data.root_songs);
    if (unsorted) frag.appendChild(unsorted);

    // Folders
    data.folders.forEach(f => frag.appendChild(_folderSection(f)));

    // Empty state
    if (!data.folders.length && !data.root_songs.length) {
        const emp = document.createElement('div');
        emp.className = 'flex flex-col items-center justify-center py-24 gap-3 text-gray-700';
        emp.innerHTML = `
            <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" class="w-12 h-12">
              <path d="M6 12a4 4 0 014-4h8l4 4h16a4 4 0 014 4v20a4 4 0 01-4 4H10a4 4 0 01-4-4V12z"/>
            </svg>
            <p class="text-sm">${_query ? 'No songs match your search.' : 'No songs found.'}</p>`;
        frag.appendChild(emp);
    }

    treeEl.innerHTML = '';
    treeEl.appendChild(frag);
}

// ── Init ──────────────────────────────────────────────────────────────
function _init() {
    _closeDropdown();
    _fixHeight();
    window.addEventListener('resize', _fixHeight);

    const search      = _el('fb-search');
    const reload      = _el('fb-reload');
    const expandAll   = _el('fb-expand-all');
    const collapseAll = _el('fb-collapse-all');
    const newFolder   = _el('fb-new-folder');
    const filterBtn   = _el('fb-filter');
    const filterBack  = _el('fb-filter-backdrop');
    const viewList    = _el('fb-view-list');
    const viewGrid    = _el('fb-view-grid');
    const treeEl      = _el('fb-tree');

    if (!search) return;

    // Force the search bar above any overlay
    search.style.position = 'relative';
    search.style.zIndex   = '100';

    function _updateViewButtons() {
        if (!viewList || !viewGrid) return;
        viewList.style.color = _view === 'list' ? '#ffffff' : '';
        viewList.style.background = _view === 'list' ? '#1f2937' : '';
        viewGrid.style.color = _view === 'grid' ? '#ffffff' : '';
        viewGrid.style.background = _view === 'grid' ? '#1f2937' : '';
    }
    _updateViewButtons();

    if (viewList) viewList.addEventListener('click', function () {
        if (_view === 'list') return;
        _view = 'list';
        _store('view', 'list');
        _updateViewButtons();
        _render();
    });
    if (viewGrid) viewGrid.addEventListener('click', function () {
        if (_view === 'grid') return;
        _view = 'grid';
        _store('view', 'grid');
        _updateViewButtons();
        _render();
    });

    const sortSel    = _el('fb-sort');
    const sortDirBtn = _el('fb-sort-dir');
    const sortDirIco = _el('fb-sort-dir-icon');

    function _updateSortDir() {
        if (!sortDirBtn) return;
        var isAsc = _sortDir === 'asc';
        var active = _sort !== 'default';
        sortDirBtn.title = isAsc ? 'Ascending' : 'Descending';
        sortDirBtn.style.opacity = active ? '' : '0.35';
        sortDirBtn.style.cursor  = active ? '' : 'default';
        if (sortDirIco) {
            // up chevron for asc, down chevron for desc
            sortDirIco.innerHTML = isAsc
                ? '<path d="M5 12l5-5 5 5"/>'
                : '<path d="M5 8l5 5 5-5"/>';
        }
    }
    _updateSortDir();

    if (sortSel) {
        sortSel.value = _sort;
        sortSel.addEventListener('change', function () {
            _sort = sortSel.value;
            _store('sort', _sort);
            _updateSortDir();
            _render();
        });
    }

    if (sortDirBtn) {
        sortDirBtn.addEventListener('click', function () {
            if (_sort === 'default') return;
            _sortDir = _sortDir === 'asc' ? 'desc' : 'asc';
            _store('sortDir', _sortDir);
            _updateSortDir();
            _render();
        });
    }

    search.addEventListener('input', function (e) {
        _query = e.target.value.trim();
        _render();
    });
    search.addEventListener('click', function (e) {
        e.stopPropagation();
        _closeDropdown();
    });

    reload.addEventListener('click', function () { _loaded = false; _load(); });
    expandAll.addEventListener('click', _expandAll);
    collapseAll.addEventListener('click', _collapseAll);
    newFolder.addEventListener('click', function () { _createFolder(); });
    if (filterBtn)  filterBtn.addEventListener('click', _openFilterPanel);
    if (filterBack) filterBack.addEventListener('click', _closeFilterPanel);
    _updateFilterBadge();

    if (!_loaded) _load();
}

// ── Screen changed ────────────────────────────────────────────────────
function _onScreenChanged(ev) {
    const id = ev && ev.detail && ev.detail.id;
    if (id === SCREEN_ID) {
        _closeDropdown();
        if (!_loaded) _load();
    }
}

if (window.slopsmith && typeof window.slopsmith.on === 'function') {
    window.slopsmith.on('screen:changed', _onScreenChanged);
} else {
    var _deadline = performance.now() + 5000;
    var _pollId = setInterval(function () {
        if (window.slopsmith && typeof window.slopsmith.on === 'function') {
            clearInterval(_pollId);
            window.slopsmith.on('screen:changed', _onScreenChanged);
        } else if (performance.now() > _deadline) {
            clearInterval(_pollId);
        }
    }, 100);
}

// ── Keyboard shortcut ─────────────────────────────────────────────────
if (typeof window.registerShortcut === 'function') {
    window.registerShortcut({
        key: '/',
        description: 'Focus folder search',
        scope: 'plugin-' + PLUGIN_ID,
        handler: function (e) {
            e.preventDefault();
            _closeDropdown();
            var s = _el('fb-search');
            if (s) { s.focus(); s.select(); }
        },
    });
}

// ── Boot ──────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init, { once: true });
} else {
    _init();
}

})();

/* Folder Organizer — Library Integration (window.folderOrganizerLibrary)
 * Renders the folder tree into #lib-folder-tree and injects toolbar
 * controls into #lib-folder-controls when the user activates Folder view
 * in the main library. All logic is isolated in this IIFE so it never
 * conflicts with the plugin nav screen IIFE above.
 */
(function () {
'use strict';

const _LAPI = '/api/plugin/folder_organizer';
const _PFX  = 'fo:lib:';

// ── Safe localStorage ─────────────────────────────────────────────────
function _ls(key, val) {
    try {
        if (val === undefined) return localStorage.getItem(_PFX + key);
        localStorage.setItem(_PFX + key, val);
    } catch (_) { return null; }
}
function _lsJSON(key, val) {
    try {
        if (val === undefined) return JSON.parse(localStorage.getItem(_PFX + key) || 'null');
        localStorage.setItem(_PFX + key, JSON.stringify(val));
    } catch (_) { return null; }
}

// ── State (separate from the nav-screen IIFE) ─────────────────────────
var _tree              = null;
var _loaded            = false;
var _lastFilterParams  = null;   // params string used for the last /tree fetch
var _openFolders  = new Set(_lsJSON('open') || []);
var _unsortedOpen = _ls('unsorted') !== 'false';
var _view         = _ls('view') || 'list';    // 'list' | 'grid'
var _toolbarDone  = false;
var _hoveredFolder= null;

// ── API helper ────────────────────────────────────────────────────────
async function _api(path, body) {
    var opts = body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : {};
    var res  = await fetch(_LAPI + path, opts);
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
}

// ── Modal (self-contained — screen.html is only in the nav tab) ───────
var _modalEl = null;
function _getModal() {
    if (_modalEl && document.body.contains(_modalEl)) return _modalEl;
    _modalEl = document.createElement('div');
    _modalEl.style.cssText = 'display:none; position:fixed; inset:0; z-index:9999; align-items:center; justify-content:center; background:rgba(0,0,0,0.6);';
    var box = document.createElement('div');
    box.style.cssText = 'background:#1f2937; border:1px solid #374151; border-radius:10px; padding:24px; min-width:320px; max-width:480px; box-shadow:0 8px 40px rgba(0,0,0,0.7);';
    var msgEl = document.createElement('div');
    msgEl.id = 'flb-msg';
    msgEl.style.cssText = 'color:#e5e7eb; font-size:14px; white-space:pre-wrap; margin-bottom:16px; line-height:1.5;';
    var inp = document.createElement('input');
    inp.id = 'flb-inp'; inp.type = 'text';
    inp.style.cssText = 'display:none; width:100%; background:#111827; border:1px solid #4b5563; border-radius:6px; padding:8px 12px; color:#e5e7eb; font-size:14px; outline:none; box-sizing:border-box; margin-bottom:16px;';
    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex; justify-content:flex-end; gap:8px;';
    var cancelBtn = document.createElement('button');
    cancelBtn.id = 'flb-cancel';
    cancelBtn.style.cssText = 'padding:7px 18px; border-radius:6px; border:1px solid #374151; background:transparent; color:#9ca3af; font-size:13px; cursor:pointer;';
    cancelBtn.textContent = 'Cancel';
    var okBtn = document.createElement('button');
    okBtn.id = 'flb-ok';
    okBtn.style.cssText = 'padding:7px 18px; border-radius:6px; border:none; background:#3b82f6; color:#fff; font-size:13px; font-weight:500; cursor:pointer;';
    okBtn.textContent = 'OK';
    btns.appendChild(cancelBtn); btns.appendChild(okBtn);
    box.appendChild(msgEl); box.appendChild(inp); box.appendChild(btns);
    _modalEl.appendChild(box);
    document.body.appendChild(_modalEl);
    return _modalEl;
}

function _showModal(message, withInput, defaultVal) {
    return new Promise(function (resolve) {
        var modal  = _getModal();
        var msgEl  = document.getElementById('flb-msg');
        var input  = document.getElementById('flb-inp');
        var okBtn  = document.getElementById('flb-ok');
        var cancel = document.getElementById('flb-cancel');
        msgEl.textContent = message;
        if (withInput) {
            input.style.display = 'block';
            input.value = defaultVal || '';
            setTimeout(function () { input.focus(); input.select(); }, 50);
        } else {
            input.style.display = 'none';
        }
        modal.style.display = 'flex';
        function _done(val) {
            modal.style.display = 'none';
            okBtn.removeEventListener('click', _ok);
            cancel.removeEventListener('click', _cxl);
            input.removeEventListener('keydown', _key);
            resolve(val);
        }
        function _ok()  { _done(withInput ? input.value.trim() : true); }
        function _cxl() { _done(null); }
        function _key(e) {
            if (e.key === 'Enter')  { e.preventDefault(); _ok(); }
            if (e.key === 'Escape') { e.preventDefault(); _cxl(); }
        }
        okBtn.addEventListener('click', _ok);
        cancel.addEventListener('click', _cxl);
        if (withInput) input.addEventListener('keydown', _key);
    });
}
function _confirm(msg)     { return _showModal(msg, false, ''); }
function _prompt(msg, def) { return _showModal(msg, true, def || ''); }

// ── Search: read from core lib-filter input ───────────────────────────
function _query() {
    var el = document.getElementById('v3-search') || document.getElementById('lib-filter');
    return el ? el.value.trim() : '';
}

// ── Filtered tree (search only — lib filters are applied server-side by /tree) ──
function _filtered() {
    if (!_tree) return { folders: [], root_songs: [] };
    var q      = _query().toLowerCase();
    var artist = typeof window.v3Songs?.getArtist === 'function' ? window.v3Songs.getArtist() : '';
    var album  = typeof window.v3Songs?.getAlbum  === 'function' ? window.v3Songs.getAlbum()  : '';
    if (!q && !artist && !album) return _tree;
    function _keep(s) {
        if (artist && (s.artist || '') !== artist) return false;
        if (album  && (s.album  || '') !== album)  return false;
        if (q && !(
            (s.title  || '').toLowerCase().includes(q) ||
            (s.artist || '').toLowerCase().includes(q) ||
            (s.album  || '').toLowerCase().includes(q) ||
            s.filename.toLowerCase().includes(q)
        )) return false;
        return true;
    }
    function _filterFolder(f) {
        var songs    = f.songs.filter(_keep);
        var children = (f.children || []).map(_filterFolder).filter(function (c) {
            return c.songs.length || (c.children || []).length;
        });
        return { name: f.name, path: f.path, songs: songs, children: children };
    }
    var folders = _tree.folders.map(_filterFolder).filter(function (f) {
        return f.songs.length || (f.children || []).length;
    });
    return { folders: folders, root_songs: _tree.root_songs.filter(_keep) };
}

// ── Sort — reads from the core #lib-sort select ───────────────────────
function _sortSongs(songs) {
    var v = (typeof window.v3Songs?.getSort === 'function')
        ? window.v3Songs.getSort()
        : (document.getElementById('lib-sort') || document.getElementById('v3-songs-sort') || {}).value || '';
    if (!v) return songs;
    var arr = songs.slice();
    if (v === 'artist' || v === 'artist-desc') {
        arr.sort(function (a, b) { return (a.artist || '').localeCompare(b.artist || ''); });
        if (v === 'artist-desc') arr.reverse();
    } else if (v === 'title' || v === 'title-desc') {
        arr.sort(function (a, b) { return (a.title || a.filename).localeCompare(b.title || b.filename); });
        if (v === 'title-desc') arr.reverse();
    } else if (v === 'recent') {
        arr.sort(function (a, b) { return (b.added || 0) - (a.added || 0); });
    } else if (v === 'year-desc') {
        arr.sort(function (a, b) { return (b.year || 0) - (a.year || 0); });
    } else if (v === 'year') {
        arr.sort(function (a, b) { return (a.year || 0) - (b.year || 0); });
    } else if (v === 'tuning') {
        arr.sort(function (a, b) { return (a.tuning || '').localeCompare(b.tuning || ''); });
    }
    return arr;
}

// ── Pointer-based drag-and-drop ───────────────────────────────────────
var _dragState         = null;
var _dragCurrentTarget = null;
var _dragRafId         = null;
var _DRAG_THRESH = 5, _DRAG_ZONE = 150, _DRAG_SPEED = 50;

function _getScrollEl() {
    var el = document.getElementById('lib-folder-tree');
    while (el && el !== document.documentElement) {
        var ov = window.getComputedStyle(el).overflowY;
        if ((ov === 'auto' || ov === 'scroll' || ov === 'overlay') && el.scrollHeight > el.clientHeight) return el;
        el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
}

function _dragFindTarget(x, y) {
    var els = document.elementsFromPoint(x, y);
    for (var i = 0; i < els.length; i++) {
        if ('dropFolder' in (els[i].dataset || {})) return els[i];
    }
    return null;
}

function _dragHighlight(target) {
    if (_dragCurrentTarget === target) return;
    if (_dragCurrentTarget) _dragCurrentTarget.style.outline = '';
    _dragCurrentTarget = target;
    if (target) { target.style.outline = '2px solid #3b82f6'; target.style.borderRadius = '6px'; }
}

function _dragScrollTick() {
    if (!_dragState || !_dragState.live) { _dragRafId = null; return; }
    var h = window.innerHeight, y = _dragState.y;
    var sc = _getScrollEl();
    sc.style.scrollBehavior = 'auto';
    if (y < _DRAG_ZONE)          sc.scrollTop -= _DRAG_SPEED;
    else if (y > h - _DRAG_ZONE) sc.scrollTop += _DRAG_SPEED;
    _dragRafId = requestAnimationFrame(_dragScrollTick);
}

function _onDragMove(e) {
    if (!_dragState) return;
    _dragState.x = e.clientX; _dragState.y = e.clientY;
    if (!_dragState.live) {
        var dx = _dragState.x - _dragState.startX, dy = _dragState.y - _dragState.startY;
        if (Math.sqrt(dx * dx + dy * dy) < _DRAG_THRESH) return;
        _dragState.live = true;
        var ghost = document.createElement('div');
        ghost.style.cssText = 'position:fixed; pointer-events:none; z-index:9999; padding:5px 12px; background:#1e2130; border:1px solid #3b82f6; border-radius:6px; color:#e5e7eb; font-size:12px; white-space:nowrap; box-shadow:0 4px 20px rgba(0,0,0,0.5);';
        ghost.textContent = _dragState.data.label;
        document.body.appendChild(ghost);
        _dragState.ghost = ghost;
        if (!_dragRafId) _dragRafId = requestAnimationFrame(_dragScrollTick);
    }
    if (_dragState.ghost) {
        _dragState.ghost.style.left = (_dragState.x + 14) + 'px';
        _dragState.ghost.style.top  = (_dragState.y + 14) + 'px';
    }
    _dragHighlight(_dragFindTarget(_dragState.x, _dragState.y));
}

function _onDragUp(e) {
    if (!_dragState) return;
    var wasDrag = _dragState.live, data = _dragState.data;
    var x = e.clientX, y = e.clientY;
    _endDrag();
    if (wasDrag) {
        document.addEventListener('click', function (ce) {
            ce.stopPropagation(); ce.preventDefault();
        }, { capture: true, once: true });
        var target = _dragFindTarget(x, y);
        if (target && data) {
            var tf = target.dataset.dropFolder;
            if (tf !== data.folder) _executeDrop(data, tf);
        }
    }
}

function _onDragKey(e) { if (e.key === 'Escape') _endDrag(); }

function _endDrag() {
    if (_dragRafId) { cancelAnimationFrame(_dragRafId); _dragRafId = null; }
    if (_dragState && _dragState.ghost) _dragState.ghost.remove();
    if (_dragCurrentTarget) { _dragCurrentTarget.style.outline = ''; _dragCurrentTarget = null; }
    document.body.style.userSelect = '';
    _dragState = null;
    document.removeEventListener('mousemove', _onDragMove);
    document.removeEventListener('mouseup', _onDragUp);
    document.removeEventListener('keydown', _onDragKey);
}

async function _executeDrop(data, targetFolder) {
    if (targetFolder !== '') _openFolders.add(targetFolder);
    else _unsortedOpen = true;
    try {
        await _api('/song/move', { filename: data.filename, folder: targetFolder });
    } catch (_) { /* reload will show real state */ }
    await _load(true);
}

function _makeDraggable(el, song, folderName) {
    el.style.cursor = 'grab';
    el.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        document.body.style.userSelect = 'none';
        var sel = window.getSelection(); if (sel) sel.removeAllRanges();
        _dragState = {
            data: { filename: song.filename, folder: folderName || '', label: '↕  ' + (song.title || song.filename) },
            startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
            live: false, ghost: null,
        };
        document.addEventListener('mousemove', _onDragMove);
        document.addEventListener('mouseup', _onDragUp);
        document.addEventListener('keydown', _onDragKey);
    });
    el.addEventListener('dragstart', function (e) { e.preventDefault(); });
}

function _makeDropTarget(el, tf) {
    el.dataset.dropFolder = (tf == null) ? '' : tf;
}

// ── Move song dialog ──────────────────────────────────────────────────
async function _moveSong(song, currentFolderPath) {
    if (!_tree) return;
    var allPaths = [];
    function _collect(f) { allPaths.push(f.path); (f.children || []).forEach(_collect); }
    _tree.folders.forEach(_collect);
    var options = ['(Unsorted)'].concat(allPaths.filter(function (p) { return p !== currentFolderPath; }));
    var choice  = await _prompt(
        'Move "' + (song.title || song.filename) + '" to:\n' +
        options.map(function (n, i) { return i + ': ' + n; }).join('\n') +
        '\n\nEnter number or folder path:', ''
    );
    if (!choice && choice !== 0) return;
    var dest = '', idx = parseInt(choice, 10);
    if (!isNaN(idx) && idx >= 0 && idx < options.length) {
        dest = idx === 0 ? '' : options[idx];
    } else {
        dest = choice.trim() === '(Unsorted)' ? '' : choice.trim();
    }
    try {
        await _api('/song/move', { filename: song.filename, folder: dest });
        await _load(true);
    } catch (err) { await _prompt('Move failed: ' + err.message, ''); }
}

// ── Song card (grid view) ─────────────────────────────────────────────
function _songCard(song, folderName) {
    var card = document.createElement('div');
    card.className = 'flex flex-col rounded-lg overflow-hidden cursor-pointer group transition-transform duration-100 hover:scale-105';
    card.style.background = '#1a1d2e';
    card.dataset.filename  = song.filename;

    var artWrap = document.createElement('div');
    artWrap.style.cssText = 'position:relative; width:100%; padding-bottom:100%; background:#111827; overflow:hidden;';

    var img = document.createElement('img');
    img.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; object-fit:cover;';
    img.alt = ''; img.loading = 'lazy';
    img.src = '/api/song/' + song.filename.split('/').map(encodeURIComponent).join('/') + '/art';

    var ph = document.createElement('div');
    ph.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center;';
    ph.innerHTML = '<svg viewBox="0 0 48 48" fill="none" stroke="#374151" stroke-width="1.5" style="width:40px;height:40px"><path d="M6 12a4 4 0 014-4h4l4 4h16a4 4 0 014 4v16a4 4 0 01-4 4H10a4 4 0 01-4-4V12z"/><circle cx="20" cy="26" r="3"/><path d="M23 26v-8l8-2v8"/><circle cx="31" cy="24" r="3"/></svg>';
    img.addEventListener('error', function () { img.style.display = 'none'; ph.style.display = 'flex'; });
    img.addEventListener('load',  function () { ph.style.display = 'none'; });
    artWrap.appendChild(ph); artWrap.appendChild(img);

    if (song.duration != null) {
        var dur = document.createElement('span');
        dur.style.cssText = 'position:absolute; bottom:6px; right:6px; padding:2px 6px; border-radius:4px; font-size:11px; font-weight:600; color:#e5e7eb; background:rgba(0,0,0,0.7);';
        var m = Math.floor(song.duration / 60), s = String(Math.floor(song.duration % 60)).padStart(2, '0');
        dur.textContent = m + ':' + s;
        artWrap.appendChild(dur);
    }

    var moveBtn = document.createElement('button');
    moveBtn.style.cssText = 'position:absolute; top:6px; right:6px; padding:4px; border-radius:4px; background:rgba(0,0,0,0.6); color:#9ca3af; border:none; cursor:pointer; display:none;';
    moveBtn.title = 'Move to folder…';
    moveBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:12px;height:12px"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/><path fill-rule="evenodd" d="M10 11a1 1 0 011 1v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2v-2a1 1 0 011-1z" clip-rule="evenodd"/></svg>';
    card.addEventListener('mouseenter', function () { moveBtn.style.display = 'block'; });
    card.addEventListener('mouseleave', function () { moveBtn.style.display = 'none'; });
    moveBtn.addEventListener('click', function (e) { e.stopPropagation(); _moveSong(song, folderName); });
    artWrap.appendChild(moveBtn);

    var meta = document.createElement('div');
    meta.style.cssText = 'padding:8px 10px 10px; flex:1; min-width:0;';
    var title = document.createElement('div');
    title.style.cssText = 'font-size:13px; font-weight:600; color:#e5e7eb; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
    title.textContent = song.title || song.filename;
    var sub = document.createElement('div');
    sub.style.cssText = 'font-size:11px; color:#6b7280; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:2px;';
    sub.textContent = [song.artist, song.album].filter(Boolean).join(' — ') || '';
    meta.appendChild(title); meta.appendChild(sub);

    card.appendChild(artWrap); card.appendChild(meta);
    card.addEventListener('click', function () {
        if (typeof window.playSong === 'function') window.playSong(song.filename);
    });
    _makeDraggable(card, song, folderName);
    return card;
}

// ── Song row (list view) ──────────────────────────────────────────────
function _songRow(song, folderName) {
    var row = document.createElement('div');
    row.className = 'flex items-center gap-3 px-3 py-2 rounded cursor-pointer hover:bg-dark-500 group transition-colors duration-100';
    row.dataset.filename = song.filename;

    var thumb = document.createElement('div');
    thumb.style.cssText = 'width:36px; height:36px; border-radius:4px; overflow:hidden; background:#111827; flex-shrink:0; position:relative;';
    var tImg = document.createElement('img');
    tImg.loading = 'lazy';
    tImg.src = '/api/song/' + song.filename.split('/').map(encodeURIComponent).join('/') + '/art';
    tImg.alt = ''; tImg.style.cssText = 'width:100%; height:100%; object-fit:cover;';
    var tPh = document.createElement('div');
    tPh.style.cssText = 'position:absolute; inset:0; display:flex; align-items:center; justify-content:center;';
    tPh.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="#374151" stroke-width="1.5" style="width:14px;height:14px"><path d="M9 19H5a2 2 0 01-2-2V7a2 2 0 012-2h2l2 2h6a2 2 0 012 2v2"/><circle cx="13" cy="16" r="2"/><path d="M15 16v-4l3-1v4"/><circle cx="18" cy="15" r="2"/></svg>';
    tImg.addEventListener('error', function () { tImg.style.display = 'none'; tPh.style.display = 'flex'; });
    tImg.addEventListener('load',  function () { tPh.style.display = 'none'; });
    thumb.appendChild(tPh); thumb.appendChild(tImg);

    var meta = document.createElement('div');
    meta.className = 'flex-1 min-w-0';
    var title = document.createElement('div');
    title.className = 'text-gray-200 truncate group-hover:text-white';
    title.style.cssText = 'font-size:13px; font-weight:600;';
    title.textContent = song.title || song.filename;
    var sub = document.createElement('div');
    sub.className = 'text-gray-500 truncate'; sub.style.fontSize = '11px';
    sub.textContent = [song.artist, song.album].filter(Boolean).join(' — ') || '';
    meta.appendChild(title); meta.appendChild(sub);

    var icon = document.createElement('span');
    icon.className = 'shrink-0 w-4 h-4 text-dark-400 group-hover:text-blue-400 transition-colors opacity-0 group-hover:opacity-100';
    icon.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clip-rule="evenodd"/></svg>';

    var dur = document.createElement('span');
    dur.className = 'shrink-0 text-xs text-gray-600 tabular-nums';
    if (song.duration != null) {
        var m = Math.floor(song.duration / 60), s = String(Math.floor(song.duration % 60)).padStart(2, '0');
        dur.textContent = m + ':' + s;
    }

    var moveBtn = document.createElement('button');
    moveBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400 opacity-0 group-hover:opacity-100 transition-opacity';
    moveBtn.title = 'Move to folder…';
    moveBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/><path fill-rule="evenodd" d="M10 11a1 1 0 011 1v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2v-2a1 1 0 011-1z" clip-rule="evenodd"/></svg>';
    moveBtn.addEventListener('click', function (e) { e.stopPropagation(); _moveSong(song, folderName); });

    row.appendChild(thumb); row.appendChild(meta); row.appendChild(icon);
    row.appendChild(dur); row.appendChild(moveBtn);
    row.addEventListener('click', function () {
        if (typeof window.playSong === 'function') window.playSong(song.filename);
    });
    _makeDraggable(row, song, folderName);
    return row;
}

// ── Folder section ────────────────────────────────────────────────────
function _folderSection(folder, depth) {
    depth = depth || 0;
    var q    = _query();
    var open = q ? true : _openFolders.has(folder.path);
    var wrap = document.createElement('div');

    function _countDeep(f) {
        var n = f.songs.length;
        (f.children || []).forEach(function (c) { n += _countDeep(c); });
        return n;
    }
    function _countFoldersDeep(f) {
        var n = (f.children || []).length;
        (f.children || []).forEach(function (c) { n += _countFoldersDeep(c); });
        return n;
    }

    var hdr = document.createElement('div');
    hdr.className = 'flex items-center gap-2 px-3 py-2 rounded cursor-pointer group';
    hdr.style.transition = 'background-color 0.1s';

    var chev = document.createElement('span');
    chev.className = 'shrink-0 w-4 h-4 text-gray-500 transition-transform duration-150';
    chev.style.transform = open ? 'rotate(90deg)' : '';
    chev.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>';

    var ico = document.createElement('span');
    ico.className = 'shrink-0 w-4 h-4 ' + (depth > 0 ? 'text-yellow-600' : 'text-yellow-500');
    ico.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>';

    var lbl = document.createElement('span');
    lbl.className = 'flex-1 truncate font-medium ' + (depth > 0 ? 'text-xs text-gray-400' : 'text-sm text-gray-200');
    lbl.textContent = folder.name;

    var cnt = document.createElement('span');
    var _deepTotal = _countDeep(folder);
    var _subCount = _countFoldersDeep(folder);
    cnt.style.cssText = 'flex-shrink:0; font-size:12px; margin-right:4px; color:#6b7280;';
    var _cntText = _deepTotal + ' song' + (_deepTotal === 1 ? '' : 's');
    if (_subCount > 0) _cntText += ' · ' + _subCount + ' subfolder' + (_subCount === 1 ? '' : 's');
    cnt.textContent = _cntText;

    // subfolder create
    var subBtn = document.createElement('button');
    subBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400';
    subBtn.title = 'New subfolder';
    subBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/><path fill-rule="evenodd" d="M10 11a1 1 0 011 1v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2v-2a1 1 0 011-1z" clip-rule="evenodd"/></svg>';
    subBtn.addEventListener('click', function (e) { e.stopPropagation(); _createFolder(folder.path); });

    var renameBtn = document.createElement('button');
    renameBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400';
    renameBtn.title = 'Rename folder';
    renameBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>';
    renameBtn.addEventListener('click', function (e) { e.stopPropagation(); _renameFolder(folder.path); });

    var delBtn = document.createElement('button');
    delBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-red-400 hover:bg-dark-400';
    delBtn.title = 'Delete folder';
    delBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"/></svg>';
    delBtn.addEventListener('click', function (e) { e.stopPropagation(); _deleteFolder(folder.path, _countDeep(folder), _countFoldersDeep(folder)); });

    var expandChildBtn  = document.createElement('button');
    var collapseChildBtn = document.createElement('button');
    if (folder.children && folder.children.length) {
        expandChildBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400';
        expandChildBtn.title = 'Expand all subfolders';
        expandChildBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px"><path d="M5 8l5 5 5-5"/><path d="M5 4l5 5 5-5" opacity=".4"/></svg>';
        expandChildBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            _openFolders.add(folder.path);
            (folder.children || []).forEach(function (c) { _openFolders.add(c.path); });
            _lsJSON('open', [..._openFolders]); _render();
        });
        collapseChildBtn.className = 'shrink-0 p-1 rounded text-gray-600 hover:text-white hover:bg-dark-400';
        collapseChildBtn.title = 'Collapse all subfolders';
        collapseChildBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px"><path d="M5 12l5-5 5 5"/><path d="M5 16l5-5 5 5" opacity=".4"/></svg>';
        collapseChildBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            (folder.children || []).forEach(function (c) { _openFolders.delete(c.path); });
            _lsJSON('open', [..._openFolders]); _render();
        });
    }

    var btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex; align-items:center; gap:2px; max-width:0; overflow:hidden; transition:max-width 0.2s ease;';
    if (folder.children && folder.children.length) {
        btnGroup.appendChild(expandChildBtn); btnGroup.appendChild(collapseChildBtn);
    }
    btnGroup.appendChild(subBtn); btnGroup.appendChild(renameBtn); btnGroup.appendChild(delBtn);

    wrap.style.cssText = 'border-radius:6px; margin:1px 0;';
    wrap.addEventListener('mouseover', function (e) {
        if (_dragState) return;
        e.stopPropagation();
        if (_hoveredFolder && _hoveredFolder.wrap !== wrap) {
            _hoveredFolder.hdr.style.backgroundColor = '';
            _hoveredFolder.wrap.style.backgroundColor = '';
            _hoveredFolder.btnGroup.style.maxWidth = '0';
        }
        _hoveredFolder = { wrap: wrap, hdr: hdr, btnGroup: btnGroup };
        hdr.style.backgroundColor  = 'rgba(55,65,81,0.5)';
        wrap.style.backgroundColor = 'rgba(55,65,81,0.12)';
        btnGroup.style.maxWidth = '160px';
    });
    wrap.addEventListener('mouseout', function (e) {
        if (_dragState) return;
        if (wrap.contains(e.relatedTarget)) return;
        hdr.style.backgroundColor = ''; wrap.style.backgroundColor = '';
        btnGroup.style.maxWidth = '0';
        if (_hoveredFolder && _hoveredFolder.wrap === wrap) _hoveredFolder = null;
    });

    hdr.appendChild(chev); hdr.appendChild(ico); hdr.appendChild(lbl);
    hdr.appendChild(btnGroup); hdr.appendChild(cnt);
    _makeDropTarget(hdr, folder.path);

    var content = document.createElement('div');
    if (!open) content.style.display = 'none';

    var list = document.createElement('div');
    if (_view === 'grid') {
        list.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill,150px); justify-content:start; gap:12px; padding:8px 4px 8px 24px;';
    } else {
        list.className = 'ml-5 mt-0.5 space-y-0';
    }
    _makeDropTarget(list, folder.path);

    var childrenWrap = document.createElement('div');
    if (_view === 'grid' && !folder.songs.length) list.style.padding = '0';

    var _listPopulated = open;
    function _populateList() {
        _sortSongs(folder.songs).forEach(function (s) {
            list.appendChild(_view === 'grid' ? _songCard(s, folder.path) : _songRow(s, folder.path));
        });
        (folder.children || []).forEach(function (child) {
            childrenWrap.appendChild(_folderSection(child, depth + 1));
        });
    }
    if (open) _populateList();

    var innerWrap = null;
    if (depth > 0) {
        innerWrap = document.createElement('div');
        innerWrap.style.cssText = 'margin-left:32px; padding-left:10px; border-left:2px solid rgba(234,179,8,0.35);';
        innerWrap.appendChild(list); innerWrap.appendChild(childrenWrap);
        content.appendChild(innerWrap);
    } else {
        childrenWrap.style.marginLeft = '32px';
        content.appendChild(list); content.appendChild(childrenWrap);
    }

    content.addEventListener('click', function (e) {
        if (_query()) return;
        var bgEls = [content, list, childrenWrap];
        if (innerWrap) bgEls.push(innerWrap);
        if (bgEls.indexOf(e.target) === -1) return;
        if (content.style.display !== 'none') {
            content.style.display = 'none'; chev.style.transform = '';
            _openFolders.delete(folder.path); _lsJSON('open', [..._openFolders]);
        }
    });

    hdr.addEventListener('click', function () {
        if (_query()) return;
        var nowOpen = content.style.display === 'none';
        if (nowOpen && !_listPopulated) { _populateList(); _listPopulated = true; }
        content.style.display = nowOpen ? '' : 'none';
        chev.style.transform  = nowOpen ? 'rotate(90deg)' : '';
        if (nowOpen) _openFolders.add(folder.path);
        else         _openFolders.delete(folder.path);
        _lsJSON('open', [..._openFolders]);
    });

    wrap.appendChild(hdr); wrap.appendChild(content);
    return wrap;
}

// ── Unsorted section ──────────────────────────────────────────────────
function _unsortedSection(songs) {
    var q = _query();
    if (!songs.length && q) return null;
    var wrap = document.createElement('div');
    wrap.className = 'mb-1';

    var hdr = document.createElement('div');
    hdr.className = 'flex items-center gap-2 px-3 py-2 rounded cursor-pointer hover:bg-dark-500 transition-colors duration-100';

    var chev = document.createElement('span');
    chev.className = 'shrink-0 w-4 h-4 text-gray-600 transition-transform duration-150';
    chev.style.transform = _unsortedOpen ? 'rotate(90deg)' : '';
    chev.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>';

    var ico = document.createElement('span');
    ico.className = 'shrink-0 w-4 h-4 text-gray-600';
    ico.innerHTML = '<svg viewBox="0 0 20 20" fill="currentColor" class="w-full h-full"><path d="M2 6a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>';

    var lbl = document.createElement('span');
    lbl.className = 'flex-1 text-xs font-semibold uppercase tracking-widest text-gray-600';
    lbl.textContent = 'Unsorted';

    var cnt = document.createElement('span');
    cnt.className = 'shrink-0 text-xs text-gray-700 tabular-nums';
    cnt.textContent = String(songs.length);

    hdr.appendChild(chev); hdr.appendChild(ico); hdr.appendChild(lbl); hdr.appendChild(cnt);
    _makeDropTarget(hdr, '');

    var list = document.createElement('div');
    if (_view === 'grid') {
        list.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill,150px); justify-content:start; gap:12px; padding:8px 4px 8px 24px;';
    } else {
        list.className = 'ml-5 mt-0.5 space-y-0';
    }
    var _populated = _unsortedOpen;
    function _populate() {
        _sortSongs(songs).forEach(function (s) {
            list.appendChild(_view === 'grid' ? _songCard(s, '') : _songRow(s, ''));
        });
    }
    if (_unsortedOpen) { _populate(); } else { list.style.display = 'none'; }
    _makeDropTarget(list, '');

    hdr.addEventListener('click', function () {
        if (_query()) return;
        _unsortedOpen = list.style.display === 'none';
        if (_unsortedOpen && !_populated) { _populate(); _populated = true; }
        list.style.display = _unsortedOpen ? (_view === 'grid' ? 'grid' : '') : 'none';
        chev.style.transform = _unsortedOpen ? 'rotate(90deg)' : '';
        _ls('unsorted', String(_unsortedOpen));
    });

    wrap.appendChild(hdr); wrap.appendChild(list);
    return wrap;
}

// ── Folder management ─────────────────────────────────────────────────
async function _createFolder(parentPath) {
    var msg = parentPath ? 'New subfolder name in "' + parentPath.split('/').pop() + '":' : 'New folder name:';
    var name = await _prompt(msg);
    if (!name || !name.trim()) return;
    try {
        var body = { name: name.trim() };
        if (parentPath) body.parent = parentPath;
        await _api('/folder/create', body);
        var newPath = parentPath ? parentPath + '/' + name.trim() : name.trim();
        if (parentPath) _openFolders.add(parentPath);
        _openFolders.add(newPath);
        await _load(true);
    } catch (err) { await _prompt('Create failed: ' + err.message); }
}

async function _renameFolder(folderPath) {
    var oldName = folderPath.split('/').pop();
    var newName = await _prompt('Rename "' + oldName + '" to:', oldName);
    if (!newName || !newName.trim() || newName.trim() === oldName) return;
    try {
        await _api('/folder/rename', { old: folderPath, new: newName.trim() });
        var parts = folderPath.split('/');
        parts[parts.length - 1] = newName.trim();
        var newPath = parts.join('/');
        var updated = new Set();
        _openFolders.forEach(function (p) {
            if (p === folderPath) updated.add(newPath);
            else if (p.startsWith(folderPath + '/')) updated.add(newPath + p.slice(folderPath.length));
            else updated.add(p);
        });
        _openFolders = updated;
        _lsJSON('open', [..._openFolders]);
        await _load(true);
    } catch (err) { await _prompt('Rename failed: ' + err.message); }
}

async function _deleteFolder(folderPath, songCount, folderCount) {
    var folderName = folderPath.split('/').pop();
    var parts = [];
    if (songCount   > 0) parts.push(songCount   + ' song'      + (songCount   === 1 ? '' : 's'));
    if (folderCount > 0) parts.push(folderCount + ' subfolder' + (folderCount === 1 ? '' : 's'));
    var msg = parts.length
        ? 'Delete "' + folderName + '"? It contains ' + parts.join(' and ') + '. Songs will be moved to Unsorted.'
        : 'Delete empty folder "' + folderName + '"?';
    var ok = await _confirm(msg);
    if (!ok) return;
    try {
        await _api('/folder/delete', { name: folderPath });
        var toDelete = [];
        _openFolders.forEach(function (p) {
            if (p === folderPath || p.startsWith(folderPath + '/')) toDelete.push(p);
        });
        toDelete.forEach(function (p) { _openFolders.delete(p); });
        _lsJSON('open', [..._openFolders]);
        await _load(true);
    } catch (err) { await _prompt('Delete failed: ' + err.message); }
}

// ── Expand / collapse all ─────────────────────────────────────────────
function _expandAll() {
    if (!_tree) return;
    function _addPaths(f) { _openFolders.add(f.path); (f.children || []).forEach(_addPaths); }
    _tree.folders.forEach(_addPaths);
    _unsortedOpen = true;
    _lsJSON('open', [..._openFolders]); _ls('unsorted', 'true');
    _render();
}
function _collapseAll() {
    _openFolders.clear(); _unsortedOpen = false;
    _lsJSON('open', []); _ls('unsorted', 'false');
    _render();
}

// ── Render ────────────────────────────────────────────────────────────
function _render() {
    _hoveredFolder = null;
    var treeEl = document.getElementById('lib-folder-tree');
    if (!treeEl) return;
    var data = _filtered();
    var frag = document.createDocumentFragment();
    var unsorted = _unsortedSection(data.root_songs);
    if (unsorted) frag.appendChild(unsorted);
    data.folders.forEach(function (f) { frag.appendChild(_folderSection(f)); });
    if (!data.folders.length && !data.root_songs.length) {
        var emp = document.createElement('div');
        emp.className = 'flex flex-col items-center justify-center py-24 gap-3 text-gray-700';
        emp.innerHTML = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" class="w-12 h-12"><path d="M6 12a4 4 0 014-4h8l4 4h16a4 4 0 014 4v20a4 4 0 01-4 4H10a4 4 0 01-4-4V12z"/></svg>' +
            '<p class="text-sm">' + (_query() ? 'No songs match your search.' : 'No songs found.') + '</p>';
        frag.appendChild(emp);
    }
    treeEl.innerHTML = ''; treeEl.appendChild(frag);
    // Update the library count line ("Your Library / N songs · M folders")
    var countEl = document.getElementById('lib-count');
    if (countEl) {
        var total = data.root_songs.length;
        var folderCount = 0;
        function _countDeep(f) {
            total += f.songs.length;
            folderCount += 1;
            (f.children || []).forEach(_countDeep);
        }
        data.folders.forEach(_countDeep);
        var songStr   = total + ' song' + (total === 1 ? '' : 's');
        var folderStr = folderCount + ' folder' + (folderCount === 1 ? '' : 's');
        countEl.textContent = songStr + ' · ' + folderStr;
    }
}

// ── Toolbar injection (once) ──────────────────────────────────────────
function _injectToolbar() {
    if (_toolbarDone) return;
    var ctrl = document.getElementById('lib-folder-controls');
    if (!ctrl) {
        ctrl = document.createElement('div');
        ctrl.id = 'lib-folder-controls';
        var treeEl = document.getElementById('lib-folder-tree');
        if (!treeEl) return;
        treeEl.parentNode.insertBefore(ctrl, treeEl);
    }
    ctrl.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:12px;';
    ctrl.innerHTML = '';

    // View toggle: list | grid
    var viewGroup = document.createElement('div');
    viewGroup.style.cssText = 'display:flex; background:#1f2937; border:1px solid #374151; border-radius:10px; overflow:hidden;';

    var listBtn = document.createElement('button');
    listBtn.title = 'List view';
    listBtn.style.cssText = 'padding:7px 10px; border:none; cursor:pointer; transition:background 0.1s, color 0.1s;';
    listBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" style="width:14px;height:14px;display:block;"><rect x="1" y="1" width="14" height="3" rx="1"/><rect x="3" y="6" width="12" height="3" rx="1"/><rect x="3" y="11" width="12" height="3" rx="1"/></svg>';

    var gridBtn = document.createElement('button');
    gridBtn.title = 'Grid view';
    gridBtn.style.cssText = 'padding:7px 10px; border:none; cursor:pointer; transition:background 0.1s, color 0.1s;';
    gridBtn.innerHTML = '<svg viewBox="0 0 16 16" fill="currentColor" style="width:14px;height:14px;display:block;"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>';

    function _applyViewBtns() {
        listBtn.style.background = _view === 'list' ? '#374151' : 'transparent';
        listBtn.style.color      = _view === 'list' ? '#e5e7eb' : '#6b7280';
        gridBtn.style.background = _view === 'grid' ? '#374151' : 'transparent';
        gridBtn.style.color      = _view === 'grid' ? '#e5e7eb' : '#6b7280';
    }
    _applyViewBtns();
    listBtn.addEventListener('click', function () {
        if (_view === 'list') return;
        _view = 'list'; _ls('view', 'list'); _applyViewBtns(); _render();
    });
    gridBtn.addEventListener('click', function () {
        if (_view === 'grid') return;
        _view = 'grid'; _ls('view', 'grid'); _applyViewBtns(); _render();
    });
    viewGroup.appendChild(listBtn); viewGroup.appendChild(gridBtn);

    // New Folder
    var newBtn = _makeToolbarBtn(
        '<svg viewBox="0 0 20 20" fill="currentColor" style="width:14px;height:14px;flex-shrink:0"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/><path fill-rule="evenodd" d="M10 11a1 1 0 011 1v2h2a1 1 0 110 2h-2v2a1 1 0 11-2 0v-2H7a1 1 0 110-2h2v-2a1 1 0 011-1z" clip-rule="evenodd"/></svg>',
        null, 'New parent folder'
    );
    newBtn.addEventListener('click', function () { _createFolder(); });

    // Expand All
    var expBtn = _makeToolbarBtn(
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px"><path d="M5 8l5 5 5-5"/><path d="M5 4l5 5 5-5" opacity=".4"/></svg>',
        null, 'Expand all'
    );
    expBtn.addEventListener('click', _expandAll);

    // Collapse All
    var colBtn = _makeToolbarBtn(
        '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" style="width:14px;height:14px"><path d="M5 12l5-5 5 5"/><path d="M5 16l5-5 5 5" opacity=".4"/></svg>',
        null, 'Collapse all'
    );
    colBtn.addEventListener('click', _collapseAll);

    ctrl.appendChild(viewGroup);
    ctrl.appendChild(newBtn);
    ctrl.appendChild(expBtn);
    ctrl.appendChild(colBtn);

    _toolbarDone = true;
}

function _makeToolbarBtn(iconHtml, label, title) {
    var btn = document.createElement('button');
    btn.title = title || '';
    btn.style.cssText = 'display:flex; align-items:center; gap:6px; padding:7px 12px; background:#1f2937; border:1px solid #374151; border-radius:10px; color:#9ca3af; cursor:pointer; font-size:13px; white-space:nowrap; transition:color 0.1s, border-color 0.1s;';
    btn.innerHTML = iconHtml + (label ? '<span>' + label + '</span>' : '');
    btn.addEventListener('mouseenter', function () { btn.style.color = '#e5e7eb'; btn.style.borderColor = '#6b7280'; });
    btn.addEventListener('mouseleave', function () { btn.style.color = '#9ca3af'; btn.style.borderColor = '#374151'; });
    return btn;
}

// ── Load / unload ─────────────────────────────────────────────────────
function _unload() {
    var el = document.getElementById('lib-filter');
    if (el) el.style.maxWidth = '';
}

async function _load(force) {
    // Constrain the search bar width and clear any stale count from the
    // previous view — plugin owns these tweaks for both entry and exit.
    var filterEl = document.getElementById('lib-filter');
    if (filterEl) filterEl.style.maxWidth = '320px';
    var countEl = document.getElementById('lib-count');
    if (countEl) countEl.textContent = '';

    var params = typeof window.v3Songs?.filterParams === 'function'
        ? window.v3Songs.filterParams()
        : typeof window.slopsmithLibFilterParams === 'function'
        ? window.slopsmithLibFilterParams() : '';
    if (!force && _loaded && _tree && params === _lastFilterParams) {
        _injectToolbar();
        _render();
        return;
    }
    // Show a loading message immediately so the user knows work is in progress
    var treeEl = document.getElementById('lib-folder-tree');
    if (treeEl) {
        treeEl.innerHTML = '<div style="padding:48px;text-align:center;color:#4b5563;font-size:13px;">Loading folders…</div>';
    }
    try {
        var url  = '/tree' + (params ? '?' + params : '');
        var data = await _api(url);
        if (data.error) {
            if (treeEl) treeEl.innerHTML = '<div style="padding:48px;text-align:center;color:#ef4444;font-size:13px;">⚠ ' + data.error + '</div>';
            return;
        }
        _tree             = data;
        _loaded           = true;
        _lastFilterParams = params;
        // Auto-expand top-level folders on first visit (empty _openFolders)
        if (_openFolders.size === 0 && data.folders.length) {
            data.folders.forEach(function(f) { _openFolders.add(f.path); });
            _lsJSON('open', [..._openFolders]);
        }
        _injectToolbar();
        _render();
    } catch (err) {
        if (treeEl) treeEl.innerHTML = '<div style="padding:48px;text-align:center;color:#ef4444;font-size:13px;">⚠ Failed to load: ' + err.message + '</div>';
    }
}

// ── Public interface ──────────────────────────────────────────────────
window.folderOrganizerLibrary = {
    load:   function (force) { return _load(force); },
    unload: function ()      { _unload(); },
};

// Auto-load if folder view was already active when this script was injected.
// On a hard refresh, setLibView() runs before plugins load, so
// window.folderOrganizerLibrary didn't exist yet and loadLibrary() silently
// skipped. Now that we're defined, kick off the load if #lib-folder-tree is
// currently visible.
(function () {
    var treeEl = document.getElementById('lib-folder-tree');
    if (treeEl && !treeEl.classList.contains('hidden')) {
        _load();
    }
}());

})();
