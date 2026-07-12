// KEYBOARD SHORTCUTS: the panel registry, the global dispatchers, and the plugin-facing API.
//
// ━━━ MOST OF THIS SUBSYSTEM IS TOP-LEVEL STATEMENTS, NOT DECLARATIONS ━━━
//
// 10 declarations — and 18 top-level statements. window.registerShortcut,
// window.createShortcutPanel, getAllShortcuts, unregisterShortcut, clearWindowShortcuts, the
// panel registry, and BOTH global keydown dispatchers are all bare statements at app.js's top
// level. A dependency scan that walks declarations sees NONE of them, and would have reported
// this cluster as 246 lines. It is more than double that.
//
// That blind spot has now cost twice: it nearly shipped a dead library A-Z rail (#896), and it
// threw "Assignment to constant variable" in the session carve (#921), where the autoplay gate's
// top-level statements wrote state that had become a read-only import. The extractor takes them
// by construction now — any top-level statement that TOUCHES a moved binding comes along.
//
// window.registerShortcut and friends are a PLUGIN-FACING API. They keep working because app.js
// still publishes them; the definitions simply live here, next to the dispatcher they feed.

import {
    _lastLibSelected,
    _libNavItems,
    _moveSelectionInItems,
    _providerSupports,
    _setLibSelection,
    _toggleHeader,
} from './library.js';
import {
    _sectionPracticeBarContains,
    _sectionPracticePopoverOpen,
} from './section-practice.js';
import {
    _trapFocusInModal,
    esc,
} from './dom.js';
import {
    playSong,
} from './session.js';
import { host } from './host.js';
// ── Global keyboard shortcuts ─────────────────────────────────────────────
//
// `/` focuses the active screen's search input (Library / Favorites);
// `Esc` while focused blurs and clears it. Mirrors the GitHub / Gmail
// convention. The listener bails when the user is already typing in
// any text-accepting element so it can't intercept normal typing —
// including inputs inside the filters drawer, plugin settings, or
// modal dialogs.
export function _isTextInput(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT') {
        // Some <input> types (button, checkbox, radio, range, ...) don't
        // accept text; only intercept the ones that do.
        const t = (el.type || 'text').toLowerCase();
        return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t);
    }
    if (tag === 'TEXTAREA') return true;
    if (tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
}

export function _isShortcutHelpKey(e) {
    return e.key === '?' || (e.shiftKey && (e.code === 'Slash' || e.key === '/'));
}

export function _isShortcutHelpSuppressedTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT') {
        const t = (el.type || 'text').toLowerCase();
        return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t);
    }
    if (tag === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('#lib-filter-drawer, [role="dialog"], #edit-modal, .feedBack-modal')) return true;
    return false;
}

export function _activeSearchInput() {
    // Pick the search field for whichever screen is currently active.
    // No match (e.g. on the player or settings screen) means `/` does
    // nothing — the shortcut only fires where a search box exists.
    const active = document.querySelector('.screen.active');
    if (!active) return null;
    if (active.id === 'home') return document.getElementById('lib-filter');
    if (active.id === 'favorites') return document.getElementById('fav-filter');
    return null;
}

export function _gridColumns(container) {
    // Count columns by grouping the first row of children by their
    // top coordinate. Robust against any grid-template-columns syntax
    // (`repeat(...)`, `auto-fit`, named lines, etc.) where naively
    // splitting `getComputedStyle().gridTemplateColumns` on whitespace
    // would miscount because of spaces inside `repeat(...)` /
    // `minmax(...)`. Falls back to 1 when the container is empty
    // so callers' max(1, ...) clamps stay valid.
    if (!container) return 1;
    const children = Array.from(container.children).filter(
        c => c && c.offsetParent !== null
    );
    if (!children.length) return 1;
    const firstTop = children[0].getBoundingClientRect().top;
    let cols = 0;
    for (const c of children) {
        // Allow ~1px slop for sub-pixel rounding so two children that
        // would visually align still group together.
        if (Math.abs(c.getBoundingClientRect().top - firstTop) < 1.5) cols++;
        else break;
    }
    return Math.max(1, cols);
}

export function _isInsideInteractiveControl(el) {
    // Bail when the user is interacting with anything that has its
    // own keyboard semantics — form controls (checkbox / select /
    // button) consume arrow keys for their own behavior, and the
    // filters drawer is a focus trap of those. Without this guard the
    // library's arrow nav would steal arrow presses from a focused
    // tuning checkbox or sort dropdown.
    if (!el) return false;
    const tag = el.tagName;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('#lib-filter-drawer, [role="dialog"], #edit-modal')) return true;
    return false;
}

export function _isSpaceKey(e) {
    return e.key === ' ' || e.key === 'Spacebar';
}

export function _shortcutDispatchBlocked(e) {
    if (_isTextInput(e.target)) return true;
    // Space in Section Practice bar should pause/resume, not toggle checkboxes/buttons.
    if (_isSpaceKey(e) && _sectionPracticeBarContains(e.target)) return false;
    // While the Section Practice popover is open, Esc just closes it (handled by
    // the popover's own keydown listener) — suppress the player-scope
    // "back to library" Esc so the user doesn't get bounced out of the player.
    if (e.key === 'Escape' && _sectionPracticePopoverOpen()) return true;
    // Space on the player screen should always play/pause, even if focus is on a
    // sidebar nav link, player rail button, popover control, or any other
    // interactive element — the shortcut dispatcher calls preventDefault so the
    // focused element won't also activate. Two exceptions keep native Space:
    // text inputs (already exempted above), and focus inside a true modal
    // dialog (role="dialog" aria-modal="true", or a .feedBack-modal overlay)
    // layered over the player — a modal traps interaction, so Space must reach
    // its focused control (e.g. the Close button) rather than toggle playback
    // behind it. Non-modal player popovers/toasts (loop A/B, arrangement pin,
    // role="dialog" aria-modal="false") are not modals and stay covered.
    if (_isSpaceKey(e) && _getCurrentContext().isPlayer &&
        !(e.target && e.target.closest &&
          e.target.closest('[role="dialog"][aria-modal="true"], .feedBack-modal'))) {
        return false;
    }
    // Escape is the universal "back" action and must fire like Space above even
    // when a transport/rail control <button> holds keyboard focus after a click
    // — otherwise a focused control swallows Esc and the user can't leave the
    // song until they click empty canvas (feedBack — "Escape in song not
    // consistent"). It applies on the player (exit the song) AND settings
    // (return to the previous screen), both of which register an Escape=Back
    // shortcut. The earlier guards still win: text inputs are exempted at the
    // top (Esc there clears/blurs the field), and the Section Practice popover
    // already claimed Esc above. A true modal layered over the screen still
    // traps Esc — the modal-overlay check keeps Esc closing the modal rather
    // than ejecting past it to the screen behind.
    if (e.key === 'Escape') {
        const ctx = _getCurrentContext();
        if ((ctx.isPlayer || ctx.isSettings) &&
            !(e.target && e.target.closest &&
              e.target.closest('[role="dialog"][aria-modal="true"], .feedBack-modal'))) {
            return false;
        }
    }
    return _isInsideInteractiveControl(e.target);
}

export function _handleLibArrowNav(e) {
    // Space (' ') is the standard activation key for focusable
    // elements alongside Enter — without it, a screen-reader user
    // hitting Space on a focused card would just scroll the page
    // instead of activating it. We treat Space identically to Enter
    // inside this handler.
    const isActivate = e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
    if (!isActivate &&
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
        return false;
    }
    if (_isInsideInteractiveControl(document.activeElement)) return false;
    const { items, container, mode } = _libNavItems();
    if (!items.length) return false;

    const currentTarget = (document.activeElement && items.includes(document.activeElement))
        ? document.activeElement
        : (_lastLibSelected && items.includes(_lastLibSelected) ? _lastLibSelected : null);

    if (isActivate) {
        if (!currentTarget) return false;
        e.preventDefault();
        // Sync persistent selection before activating so Tab-then-Enter
        // (no prior arrow nav or mouse click) still lights up the `.selected`
        // ring and updates `_lastLibSelected`/localStorage — consistent with
        // the click delegate at the bottom of this file.
        _setLibSelection(currentTarget, { focus: false });
        if (currentTarget.classList.contains('song-row') ||
            currentTarget.classList.contains('song-card')) {
            if (currentTarget.dataset.librarySong && !currentTarget.dataset.play) {
                const providerId = decodeURIComponent(currentTarget.dataset.libraryProvider || '');
                if (!_providerSupports(providerId, 'song.sync')) return true;
                host.syncLibrarySong(
                    providerId,
                    decodeURIComponent(currentTarget.dataset.librarySong || ''),
                    { playWhenReady: true },
                );
                return true;
            }
            // Song row OR card → play it. Pass `dataset.play` raw to
            // match the click delegate; `playSong` handles decoding
            // internally so decoding here would double-decode and
            // throw `URIError` on filenames containing `%`.
            playSong(currentTarget.dataset.play, undefined, { bridge: false });
        } else if (currentTarget.classList.contains('artist-header') ||
                   currentTarget.classList.contains('album-header')) {
            // Header row → toggle the parent open/closed and re-derive
            // visible items so the next arrow press lands correctly.
            // `_toggleHeader` keeps `aria-expanded` in sync for
            // assistive tech.
            _toggleHeader(currentTarget);
            // Keep keyboard focus on the header we just toggled —
            // browsers sometimes drop focus to body when the
            // surrounding subtree changes display.
            currentTarget.focus({ preventScroll: true });
        }
        return true;
    }

    if (e.key === 'Home') { e.preventDefault(); _setLibSelection(items[0]); return true; }
    if (e.key === 'End')  { e.preventDefault(); _setLibSelection(items[items.length - 1]); return true; }

    if (mode === 'list') {
        if (e.key === 'ArrowDown') { e.preventDefault(); _moveSelectionInItems(items, 1); return true; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); _moveSelectionInItems(items, -1); return true; }
        // Right/Left expand and collapse the artist/album under focus,
        // file-manager style. With nothing selected yet, both keys
        // initialize selection on the first visible item (matches
        // Up/Down behavior in `_moveSelectionInItems`) so the first
        // press doesn't fall through to native scroll.
        if (!currentTarget && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
            e.preventDefault();
            _setLibSelection(items[0]);
            return true;
        }
        if (e.key === 'ArrowRight' && currentTarget) {
            const parent = (currentTarget.classList.contains('artist-header') ||
                            currentTarget.classList.contains('album-header'))
                ? currentTarget.parentElement : null;
            if (parent && !parent.classList.contains('open')) {
                e.preventDefault();
                // Use the shared toggle path so aria-expanded stays
                // synced with the visual state for screen readers.
                _toggleHeader(currentTarget);
                currentTarget.focus({ preventScroll: true });
                return true;
            }
            // Already open — step to the next visible item (which is
            // the first child of this header).
            e.preventDefault();
            _moveSelectionInItems(items, 1);
            return true;
        }
        if (e.key === 'ArrowLeft' && currentTarget) {
            // If on an open header, collapse it. If on a song row or
            // closed header, jump to the nearest enclosing header.
            const isHeader = currentTarget.classList.contains('artist-header') ||
                             currentTarget.classList.contains('album-header');
            const headerParent = isHeader ? currentTarget.parentElement : null;
            if (headerParent && headerParent.classList.contains('open')) {
                e.preventDefault();
                _toggleHeader(currentTarget);
                currentTarget.focus({ preventScroll: true });
                return true;
            }
            // Walk up to the nearest .album-header / .artist-header
            // ancestor's sibling header. Closest album-group → its
            // header; otherwise closest artist-row → its header.
            const albumGroup = currentTarget.closest('.album-group');
            if (albumGroup && albumGroup.contains(currentTarget) &&
                !currentTarget.classList.contains('album-header')) {
                e.preventDefault();
                _setLibSelection(albumGroup.querySelector('.album-header'));
                return true;
            }
            const artistRow = currentTarget.closest('.artist-row');
            if (artistRow && !currentTarget.classList.contains('artist-header')) {
                e.preventDefault();
                _setLibSelection(artistRow.querySelector('.artist-header'));
                return true;
            }
            return false;
        }
        return false;
    }
    // Grid mode: 2D nav. Columns are read from the live CSS grid so
    // we follow the responsive breakpoints automatically.
    const cols = _gridColumns(container);
    if (e.key === 'ArrowRight') { e.preventDefault(); _moveSelectionInItems(items, 1); return true; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); _moveSelectionInItems(items, -1); return true; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); _moveSelectionInItems(items, cols); return true; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); _moveSelectionInItems(items, -cols); return true; }
    return false;
}

// Shortcut cheat-sheet overlay. Opens on `?` (Shift+/), closes on
// Esc (handled by the generic modal close path) or on backdrop /
// close-button click. The list mirrors the canonical shortcut table
// in this file's keydown handler — when a shortcut changes here, the
// table below should change too. We keep it inline rather than
// fetching a separate file so the cheat sheet can never disagree
// with the version of app.js the user actually loaded.
export function _openShortcutsModal() {
    if (document.getElementById('shortcuts-modal')) return;

    function _isTreeMode() {
        // Check if we're in tree view (not grid) on the active library screen
        const screen = document.querySelector('.screen.active');
        if (!screen) return false;
        const tree = screen.querySelector('#lib-tree,#fav-tree');
        return tree && !tree.classList.contains('hidden');
    }

    const ctx = _getCurrentContext();

    // Library shortcuts that are handled by the navigation system (not in registry)
    const navShortcuts = [
        { keys: '↑ ↓', desc: 'Move selection' },
        { keys: '→', desc: 'Step in', condition: _isTreeMode },
        { keys: '←', desc: 'Step out', condition: _isTreeMode },
        { keys: 'Home / End', desc: 'Jump to first / last item' },
        { keys: 'Enter / Space', desc: 'Activate selection (play song / toggle header)' },
    ];

    // Filter out items whose condition returns false
    const filterNavItems = (items) => items.filter(item => !item.condition || item.condition());

    // Format a shortcut entry for display, including modifier prefixes
    const formatShortcut = (s) => {
        const mods = s.modifiers || {};
        let label = '';
        if (mods.ctrl) label += 'Ctrl+';
        if (mods.alt) label += 'Alt+';
        if (mods.shift) label += 'Shift+';
        if (mods.meta) label += 'Meta+';
        return label + s.key;
    };

    // Get shortcuts from active panel by scope
    const getPanelShortcuts = (panel, scope) => {
        const shortcuts = [];
        for (const [key, s] of panel.shortcuts) {
            if (s.scope === scope) {
                shortcuts.push({ keys: formatShortcut(s), desc: s.description });
            }
        }
        return shortcuts;
    };

    const activePanel = _panels.get(_activePanel);
    const defaultPanel = _panels.get('default');

    // Merge shortcuts from both active and default panel for display
    const mergeShortcuts = (scope) => {
        const result = [];
        if (activePanel) result.push(...getPanelShortcuts(activePanel, scope));
        if (defaultPanel && defaultPanel !== activePanel) result.push(...getPanelShortcuts(defaultPanel, scope));
        return result;
    };

    const playerShortcuts = mergeShortcuts('player');
    const globalShortcuts = mergeShortcuts('global');
    const libraryShortcuts = mergeShortcuts('library');

    // Get plugin shortcuts for current plugin screen
    const pluginShortcuts = [];
    if (ctx.isPlugin && activePanel) {
        for (const [key, s] of activePanel.shortcuts) {
            if (s.scope.startsWith('plugin-') && s.scope === ctx.screen) {
                pluginShortcuts.push({ keys: formatShortcut(s), desc: s.description });
            }
        }
    }

    // Get shortcuts from other panels (if multiple panels exist)
    const otherPanelShortcuts = [];
    if (_panels.size > 1) {
        for (const [panelId, panel] of _panels) {
            if (panelId === _activePanel) continue;
            for (const [key, s] of panel.shortcuts) {
                otherPanelShortcuts.push({ keys: formatShortcut(s), desc: s.description, panel: panelId });
            }
        }
    }

    // Build sections based on current context
    const sections = [];
    if (ctx.isSettings) {
        sections.push({ heading: 'Settings', items: mergeShortcuts('settings') });
    } else if (ctx.isLibrary) {
        sections.push({ heading: 'Library', items: [
            ...filterNavItems(navShortcuts),
            ...libraryShortcuts,
            { keys: 'Esc', desc: 'Clear search' }
        ]});
    }
    if (ctx.isPlayer) {
        sections.push({ heading: 'Player', items: playerShortcuts });
    }
    if (!ctx.isSettings && globalShortcuts.length > 0) {
        sections.push({ heading: 'Global', items: globalShortcuts });
    }
    if (pluginShortcuts.length > 0) {
        sections.push({ heading: 'Current Plugin', items: pluginShortcuts });
    }
    if (otherPanelShortcuts.length > 0) {
        // Group other panel shortcuts by panel
        const byPanel = new Map();
        for (const item of otherPanelShortcuts) {
            if (!byPanel.has(item.panel)) {
                byPanel.set(item.panel, []);
            }
            byPanel.get(item.panel).push(item);
        }
        for (const [panelId, items] of byPanel) {
            sections.push({ heading: `Panel ${panelId}`, items });
        }
    }

    const modal = document.createElement('div');
    modal.id = 'shortcuts-modal';
    modal.className = 'feedBack-modal fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Keyboard shortcuts');
    // Record the element that triggered the modal so Esc / close can
    // return focus to the correct entry even if _lastLibSelected drifts.
    // Scope to the active screen so a stale _lastLibSelected from a
    // different screen (e.g. Library vs Favorites) doesn't receive focus.
    const _scModal = document.querySelector('.screen.active');
    modal._opener = (_lastLibSelected && document.body.contains(_lastLibSelected)
        && _scModal && _scModal.contains(_lastLibSelected))
        ? _lastLibSelected : null;

    const sectionsHtml = sections.map(section => {
        const itemsHtml = section.items.map(({ keys, desc }) => `
            <div class="flex items-baseline justify-between gap-4 py-1.5">
                <span class="text-sm text-gray-300">${esc(desc)}</span>
                <kbd class="text-xs font-mono px-2 py-0.5 rounded bg-dark-600 border border-gray-700 text-gray-200 whitespace-nowrap">${esc(keys)}</kbd>
            </div>
        `).join('');
        return `
            <section class="mb-4 last:mb-0">
                <h4 class="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">${esc(section.heading)}</h4>
                ${itemsHtml}
            </section>
        `;
    }).join('');

    modal.innerHTML = `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-bold text-white">Keyboard shortcuts</h3>
                <button type="button" data-shortcuts-close
                        class="text-gray-500 hover:text-white transition flex items-center gap-1.5" aria-label="Close shortcuts">
                    <span class="text-xs text-gray-600">Esc</span>
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
            </div>
            ${sectionsHtml}
        </div>
    `;

    // Click outside the inner panel (i.e. on the backdrop) closes the
    // modal — matches the conventional dialog UX.
    modal.addEventListener('click', (ev) => {
        if (ev.target === modal || ev.target.closest('[data-shortcuts-close]')) {
            const opener = modal._opener;
            modal.remove();
            const focusTarget = (opener && document.body.contains(opener)) ? opener
                : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
            if (focusTarget) focusTarget.focus({ preventScroll: true });
        }
    });

    document.body.appendChild(modal);
    // Move focus into the dialog so background shortcuts (and arrow
    // nav) can't fire on the underlying library entry while the
    // overlay is open. Close button is the safe default — there's no
    // primary input to focus on a read-only cheat sheet.
    const closeBtn = modal.querySelector('[data-shortcuts-close]');
    if (closeBtn) closeBtn.focus({ preventScroll: true });
    // Trap Tab / Shift+Tab inside the modal so focus can't escape to
    // the library content underneath while the overlay is open.
    _trapFocusInModal(modal);
}

document.addEventListener('keydown', (e) => {
    // Modifier-key combos belong to the browser / OS shortcuts; never
    // intercept those.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (_handleLibArrowNav(e)) return;

    // `?` (Shift+/) opens the keyboard-shortcuts cheat sheet. Some
    // Linux/Electron stacks report Shift+/ as key='/' with code='Slash',
    // so check the help shape before treating plain '/' as search.
    if (_isShortcutHelpKey(e)) {
        if (_isShortcutHelpSuppressedTarget(e.target || document.activeElement)) return;
        e.preventDefault();
        // Stop other keydown listeners on document (notably the shortcut
        // registry below) from also consuming this event — otherwise a
        // Linux/Electron Shift+Slash reported as key='/' opens help here and
        // then the registry's plain `/` library-search shortcut focuses
        // #lib-filter behind the modal. (Copilot review on #602.)
        e.stopImmediatePropagation();
        _openShortcutsModal();
        return;
    }

    if (e.key === '/') {
        if (_isTextInput(document.activeElement)) return;
        // Also bail when focus is inside the filter drawer, a dialog, or
        // any other interactive region — those contexts have their own
        // keyboard semantics and shouldn't be hijacked by the search
        // shortcut (e.g. a focused checkbox inside the filters drawer).
        if (_isInsideInteractiveControl(document.activeElement)) return;
        const search = _activeSearchInput();
        if (!search) return;
        e.preventDefault();  // suppress the literal '/' the input would receive
        search.focus();
        // Move caret to end without mutating .value — round-tripping
        // the value resets the browser's undo stack and can fire
        // unexpected input events on some engines. setSelectionRange
        // is the no-side-effects path.
        try {
            const len = search.value.length;
            search.setSelectionRange(len, len);
        } catch {
            // Some input types (search/email/tel) don't support
            // selection APIs in older browsers; the focus alone is
            // still useful, just no caret-end guarantee.
        }
        return;
    }

    // Single-letter shortcuts that act on the focused / selected
    // library entry — works on both grid cards and tree rows. Each
    // dispatches to a button class that the entry markup already
    // exposes, so plugins can keep owning the actual behavior:
    //   f → .fav-btn              (favorite heart toggle)
    //   e → .edit-btn             (edit metadata modal)
    // No-op when no entry is currently focused / selected, when the
    // entry doesn't expose the requested button, or when the button is disabled.
    // Bails on text input / drawer focus so single-letter typing in
    // inputs still works.
    const entryShortcut = { f: 'button.fav-btn', e: 'button.edit-btn' }[e.key.toLowerCase()];
    if (entryShortcut) {
        if (_isInsideInteractiveControl(document.activeElement)) return;
        const ae = document.activeElement;
        const activeScreen = document.querySelector('.screen.active');
        const isEntry = el => el && el.classList && (el.classList.contains('song-card') || el.classList.contains('song-row'));
        // Scope both candidates to the active screen so that a stale
        // _lastLibSelected from Library doesn't fire when the user is
        // on Favorites (or vice-versa), and so pressing f/e/c on a
        // hidden screen can't accidentally persist that filename into
        // the current screen's localStorage key.
        const inActiveScreen = el => activeScreen && activeScreen.contains(el);
        const target = (isEntry(ae) && inActiveScreen(ae)) ? ae
            : (isEntry(_lastLibSelected) && inActiveScreen(_lastLibSelected) ? _lastLibSelected : null);
        if (!target) return;
        const btn = target.querySelector(entryShortcut);
        if (!btn || btn.disabled) return;
        e.preventDefault();
        // Sync the persistent selection to the acted-on entry so that
        // Esc-to-close-modal returns focus to the correct element and
        // the `.selected` highlight stays consistent with the action.
        _setLibSelection(target, { focus: false });
        btn.click();
        return;
    }

    if (e.key === 'Escape') {
        // Modal-first: close the topmost open modal (edit-metadata,
        // shortcuts cheat sheet, future modals) so Esc dismisses
        // from anywhere — including when keyboard focus is inside
        // a form field within the modal. Restores focus to the
        // element that opened the modal (tracked in modal._opener)
        // so arrow nav resumes without an extra Tab; falls back to
        // _lastLibSelected when the opener is no longer in the DOM.
        const modals = document.querySelectorAll('[role="dialog"][aria-modal="true"].feedBack-modal');
        if (modals.length) {
            e.preventDefault();
            e.stopImmediatePropagation();
            const modal = modals[modals.length - 1];
            const opener = modal._opener;
            modal.remove();
            const focusTarget = (opener && document.body.contains(opener)) ? opener
                : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
            if (focusTarget) focusTarget.focus({ preventScroll: true });
            return;
        }
        // Esc while typing in either search box clears + blurs. Other Esc
        // semantics (drawer close, screen back) are handled elsewhere; we
        // only act when a search box is the focused element.
        const ae = document.activeElement;
        if (ae && (ae.id === 'lib-filter' || ae.id === 'fav-filter')) {
            if (ae.value) {
                ae.value = '';
                ae.dispatchEvent(new Event('input', { bubbles: true }));
            }
            ae.blur();
        }
    }
});

export class ShortcutPanel {
    constructor(id) {
        this.id = id;
        this.shortcuts = new Map();
    }
    
    _compositeKey(key, scope) {
        return `${scope}::${key}`;
    }
    
    registerShortcut(options) {
        const { key, description, scope = 'global', condition = null, handler, modifiers = null } = options;
        
        if (!key || !handler) {
            console.error(`registerShortcut: key and handler are required`);
            return;
        }
        
        // Validate scope
        const validScopes = ['global', 'player', 'library', 'settings'];
        const isValidScope = validScopes.includes(scope) || 
                             scope.startsWith('plugin-');
        if (!isValidScope) {
            console.warn(`registerShortcut: invalid scope '${scope}'. Valid scopes are: global, player, library, settings, or plugin-{id}`);
        }
        
        // Conflict detection: warn if key+scope is already registered
        const compositeKey = this._compositeKey(key, scope);
        if (this.shortcuts.has(compositeKey)) {
            console.warn(`registerShortcut [${this.id}]: '${key}' in scope '${scope}' is already registered; overwriting. Previous:`, this.shortcuts.get(compositeKey));
        }
        
        this.shortcuts.set(compositeKey, { key, description, scope, condition, handler, modifiers });
    }
    
    unregisterShortcut(key, scope) {
        return this.shortcuts.delete(this._compositeKey(key, scope));
    }
    
    clearShortcuts() {
        this.shortcuts.clear();
    }
    
    listShortcuts() {
        return Array.from(this.shortcuts.entries()).map(([ck, s]) => [s.key, s]);
    }
}

// Global panel management
export const _panels = new Map();

export let _activePanel = null;

export let _defaultPanel = null;

// Create default panel on init
export const defaultPanel = new ShortcutPanel('default');

_panels.set('default', defaultPanel);

_defaultPanel = 'default';

_activePanel = 'default';

window.createShortcutPanel = (id) => {
    if (_panels.has(id)) {
        console.warn(`createShortcutPanel: panel '${id}' already exists`);
        return _panels.get(id);
    }
    const panel = new ShortcutPanel(id);
    _panels.set(id, panel);
    return panel;
};

window.setActiveShortcutPanel = (id) => {
    if (!_panels.has(id)) {
        console.error(`setActiveShortcutPanel: panel '${id}' does not exist`);
        return;
    }
    _activePanel = id;
};

window.getActiveShortcutPanel = () => _activePanel;

window.isInShortcutPanel = () => {
    return _activePanel !== 'default';
};

window.getGlobalShortcutContext = () => {
    console.warn('getGlobalShortcutContext: Global shortcuts are exceptional. Consider using panel-scoped shortcuts instead.');
    return _panels.get('default');
};

window.registerShortcut = (options) => {
    const panelId = _activePanel || _defaultPanel || 'default';
    const panel = _panels.get(panelId);
    
    if (!panel) {
        console.error(`registerShortcut: No panel found for registration: ${panelId}`);
        return;
    }
    
    panel.registerShortcut(options);
};

// Flat, read-only snapshot of every registered shortcut across all panels,
// for the Settings → Keybinds reference tab. Dedupes by combo+scope (the same
// shortcut can live in both the active panel and the default panel) and uses
// the same modifier-prefix formatting as the shortcuts modal. Returns
// [{ combo, description, scope }]; remapping is not supported, so this is
// purely informational.
window.getAllShortcuts = () => {
    const fmt = (s) => {
        const m = s.modifiers || {};
        return (m.ctrl ? 'Ctrl+' : '') + (m.alt ? 'Alt+' : '')
            + (m.shift ? 'Shift+' : '') + (m.meta ? 'Meta+' : '') + s.key;
    };
    const seen = new Set();
    const out = [];
    for (const [, panel] of _panels) {
        if (!panel || !panel.shortcuts) continue;
        for (const [, s] of panel.shortcuts) {
            const combo = fmt(s);
            const dedupe = combo + '|' + (s.scope || '');
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            out.push({ combo, description: s.description || '', scope: s.scope || 'global' });
        }
    }
    return out;
};

window.unregisterShortcut = (key, scope) => {
    // Try the active panel first to preserve panel isolation; fall back to
    // other panels so a shortcut registered before a panel switch is still
    // removable.
    const resolvedScope = scope || 'global';
    const activePanelId = _activePanel || _defaultPanel || 'default';
    const activePanel = _panels.get(activePanelId);
    if (activePanel && activePanel.unregisterShortcut(key, resolvedScope)) {
        return true;
    }
    for (const [panelId, panel] of _panels) {
        if (panelId === activePanelId) continue;
        if (panel.unregisterShortcut(key, resolvedScope)) {
            return true;
        }
    }
    return false;
};

window.clearWindowShortcuts = (windowId) => {
    // Remove all shortcuts registered for a specific window
    // This is for backward compatibility with window-specific shortcuts
    let removed = 0;
    for (const [panelId, panel] of _panels) {
        if (panelId.startsWith(`window-${windowId}`)) {
            panel.clearShortcuts();
            _panels.delete(panelId);
            removed++;
        }
    }
    return removed;
};

export function _getCurrentContext() {
    const currentScreen = document.querySelector('.screen.active')?.id;
    return {
        screen: currentScreen,
        windowId: window.getShortcutWindowId(),
        activePanel: _activePanel,
        isPlayer: currentScreen === 'player',
        isLibrary: ['home', 'favorites'].includes(currentScreen),
        isSettings: currentScreen === 'settings',
        isPlugin: currentScreen?.startsWith('plugin-')
    };
}

export function _isShortcutActive(shortcut, ctx) {
    if (shortcut.scope === 'global') return true;
    if (shortcut.scope === 'player' && ctx.isPlayer) return true;
    if (shortcut.scope === 'library' && ctx.isLibrary) return true;
    if (shortcut.scope === 'settings' && ctx.isSettings) return true;
    if (shortcut.scope.startsWith('plugin-')) {
        const pluginId = shortcut.scope.replace('plugin-', '');
        return ctx.screen === `plugin-${pluginId}`;
    }
    return false;
}

export function _modifiersMatch(e, modifiers) {
    if (!modifiers) return true;
    if (modifiers.ctrl !== undefined && modifiers.ctrl !== e.ctrlKey) return false;
    if (modifiers.alt !== undefined && modifiers.alt !== e.altKey) return false;
    if (modifiers.shift !== undefined && modifiers.shift !== e.shiftKey) return false;
    if (modifiers.meta !== undefined && modifiers.meta !== e.metaKey) return false;
    return true;
}

// Debug mode for keyboard shortcuts
export let _DEBUG_SHORTCUTS = false;

window._setDebugShortcuts = (enabled) => {
    _DEBUG_SHORTCUTS = enabled;
    console.log(`[Shortcuts] Debug mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
};

window._listShortcuts = () => {
    console.log('=== Registered Shortcuts ===');
    for (const [panelId, panel] of _panels) {
        console.log(`Panel: ${panelId}`);
        for (const [, s] of panel.shortcuts) {
            console.log(`  ${s.key.padEnd(15)} | ${s.scope.padEnd(10)} | ${s.description}`);
        }
    }
    console.log('=== End ===');
};

window._testShortcut = (key, scope) => {
    // Mirror the dispatcher: try the active panel first, then default.
    const resolvedScope = scope || 'global';
    const tried = new Set();
    const panelOrder = [_activePanel, _defaultPanel, 'default'].filter(id => {
        if (!id || tried.has(id)) return false;
        tried.add(id);
        return true;
    });

    for (const panelId of panelOrder) {
        const panel = _panels.get(panelId);
        if (!panel) continue;
        const shortcut = panel.shortcuts.get(panel._compositeKey(key, resolvedScope));
        if (!shortcut) continue;

        const ctx = _getCurrentContext();
        const active = _isShortcutActive(shortcut, ctx);
        let conditionMet = true;
        if (shortcut.condition) {
            try { conditionMet = !!shortcut.condition(); }
            catch (err) { conditionMet = `threw: ${err.message}`; }
        }
        console.log(`Shortcut '${key}' [${resolvedScope}] [${panelId}]:`, {
            description: shortcut.description,
            scope: shortcut.scope,
            currentContext: ctx,
            isActive: active,
            conditionMet
        });
        return;
    }

    console.log(`Shortcut '${key}' (scope: ${resolvedScope}) not registered in any panel`);
};

// Expose internals for debugging (prefixed with _ to indicate private)
// These are for development/debugging only and should not be used by plugins.
window._panels = _panels;

window._getCurrentContext = _getCurrentContext;

window._isShortcutActive = _isShortcutActive;

document.addEventListener('keydown', e => {
    if (_shortcutDispatchBlocked(e)) return;

    const ctx = _getCurrentContext();
    const activePanel = _panels.get(_activePanel);
    const defaultPanel = _panels.get('default');
    
    if (!activePanel && !defaultPanel) return;

    if (_DEBUG_SHORTCUTS) {
        console.log('[Shortcuts] Key pressed:', { key: e.key, code: e.code, ctx, activePanel: _activePanel });
    }

    // Try active panel first, then fall back to default
    const panelsToDispatch = [];
    if (activePanel && activePanel !== defaultPanel) panelsToDispatch.push(activePanel);
    if (defaultPanel) panelsToDispatch.push(defaultPanel);

    for (const panel of panelsToDispatch) {
        for (const [, shortcut] of panel.shortcuts) {
        // Match on both e.key (character produced) and e.code (physical key)
        if (e.key !== shortcut.key && e.code !== shortcut.key) continue;

        // Check modifier keys if specified
        if (!_modifiersMatch(e, shortcut.modifiers)) continue;

        if (_DEBUG_SHORTCUTS) {
            console.log('[Shortcuts] Matched shortcut:', shortcut.key, shortcut);
        }

        // Check scope
        if (!_isShortcutActive(shortcut, ctx)) {
            if (_DEBUG_SHORTCUTS) {
                console.log('[Shortcuts] Not active - scope mismatch:', shortcut.scope, ctx);
            }
            continue;
        }

        // Check condition callback — guard against plugin errors
        if (shortcut.condition) {
            try {
                if (!shortcut.condition()) {
                    if (_DEBUG_SHORTCUTS) {
                        console.log('[Shortcuts] Not active - condition failed');
                    }
                    continue;
                }
            } catch (err) {
                console.error('[Shortcuts] condition() threw for key:', shortcut.key, err);
                continue;
            }
        }

        e.preventDefault();
        if (_DEBUG_SHORTCUTS) {
            console.log('[Shortcuts] Executing handler for:', shortcut.key);
        }
        // Guard handler against plugin errors
        try {
            shortcut.handler(e);
        } catch (err) {
            console.error('[Shortcuts] handler() threw for key:', shortcut.key, err);
        }
        return;
    }
}

    if (_DEBUG_SHORTCUTS) {
        console.log('[Shortcuts] No shortcut matched for:', e.key, e.code);
    }
});

window.addEventListener('beforeunload', () => {
    const windowId = window.getShortcutWindowId();
    const removed = window.clearWindowShortcuts(windowId);
    if (removed > 0 && _DEBUG_SHORTCUTS) {
        console.log(`[Shortcuts] Cleaned up ${removed} shortcuts for window ${windowId}`);
    }
});

// Global shortcuts
registerShortcut({
    key: '?',
    description: 'Show keyboard shortcuts',
    scope: 'global',
    handler: () => _openShortcutsModal()
});

// Library shortcuts
registerShortcut({
    key: '/',
    description: 'Focus search',
    scope: 'library',
    handler: () => {
        const input = _activeSearchInput();
        if (input) input.focus();
    }
});
