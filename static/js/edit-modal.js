// The library's edit-song modal: open, validate, save, delete.
//
// Interface width ZERO — nothing in app.js calls into this cluster; app.js only needs the four
// names on the window contract so the markup's onclick= handlers resolve. That is what makes it
// the cleanest slice left, and it only became clean because the LIBRARY came out first (#896):
// every dependency this modal has is now a module.
//
// It reads six bindings out of ./library.js (loadLibrary, loadFavorites, loadTreeView,
// _removeLibCardsForFilename, libView, _lastLibSelected) and never writes one — checked, which
// matters: an imported binding is READ-ONLY, so a single write would have forced a setter or a
// container. Every use is a read, so plain imports suffice.
//
// Acyclic: edit-modal -> { dom, library-state, library }, and library imports none of them back.
import { _confirmDialog, _escAttr, _trapFocusInModal } from './dom.js';
import { L } from './library-state.js';
import {
    _lastLibSelected, _removeLibCardsForFilename, libView, loadFavorites, loadLibrary, loadTreeView,
} from './library.js';

// ── Edit metadata modal ─────────────────────────────────────────────────
export function openEditModal(songData, openerEl) {
    const artUrl = `/api/song/${encodeURIComponent(songData.f)}/art?t=${Date.now()}`;
    const modal = document.createElement('div');
    modal.id = 'edit-modal';
    modal.className = 'feedBack-modal fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    // role=dialog: assistive tech announces it as a modal; also lets
    // the global keyboard listener's `_isInsideInteractiveControl`
    // bail when typing inside the modal so Library shortcuts don't
    // hijack keys from the edit form.
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Edit song metadata');
    // Record the element that triggered the modal so Esc / Cancel can
    // return focus to the exact entry the user was on, even if
    // _lastLibSelected changes before the modal closes.
    // Prefer the explicitly-passed openerEl (from the edit-btn click
    // handler, which has the exact [data-play] parent) over
    // _lastLibSelected, which may not have been updated when the
    // click's stopPropagation() prevented the card-click handler.
    const _emActive = document.querySelector('.screen.active');
    const _emLast = (_lastLibSelected && document.body.contains(_lastLibSelected)
        && _emActive && _emActive.contains(_lastLibSelected)) ? _lastLibSelected : null;
    modal._opener = (openerEl && document.body.contains(openerEl)) ? openerEl : _emLast;
    modal.innerHTML = `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            <h3 class="text-lg font-bold text-white mb-4">Edit Song</h3>
            <div class="space-y-3">
                <div class="flex items-center gap-4 mb-2">
                    <div class="relative group cursor-pointer" id="edit-art-wrapper">
                        <img src="${artUrl}" alt="" class="w-20 h-20 rounded-lg object-cover bg-dark-600" id="edit-art-preview">
                        <div class="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
                            <span class="text-white text-xs">Change</span>
                        </div>
                        <input type="file" accept="image/*" id="edit-art-file" class="hidden" onchange="previewEditArt(this)">
                    </div>
                    <p class="text-xs text-gray-500 flex-1">Click image to change album art</p>
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Title</label>
                    <input type="text" id="edit-title" value="${_escAttr(songData.t)}"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Artist</label>
                    <input type="text" id="edit-artist" value="${_escAttr(songData.a)}"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Album</label>
                    <input type="text" id="edit-album" value="${_escAttr(songData.al)}"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Year</label>
                    <input type="text" inputmode="numeric" id="edit-year" value="${_escAttr(songData.y)}" placeholder="e.g. 2024"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
            </div>
            <div class="flex gap-3 mt-5">
                <button data-edit-save
                    class="flex-1 bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-sm font-semibold text-white transition">Save</button>
                <button data-edit-close
                    class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300 transition">Cancel</button>
            </div>
            <div class="mt-4 pt-4 border-t border-gray-800">
                <button data-delete-filename="${_escAttr(songData.f)}"
                    class="w-full px-4 py-2 bg-red-900/30 hover:bg-red-900/60 border border-red-900/50 hover:border-red-700 rounded-xl text-sm text-red-300 hover:text-red-100 transition">Remove from library</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    // Move focus into the dialog's first text input so background
    // shortcuts (and arrow nav) can't fire on the underlying library
    // entry while the edit form is open. Title is the natural primary
    // field — most edits are correcting spelling there. Caret-end
    // selection so the user can keep typing rather than overtype the
    // current value.
    const titleInput = document.getElementById('edit-title');
    if (titleInput) {
        titleInput.focus({ preventScroll: true });
        try {
            const len = titleInput.value.length;
            titleInput.setSelectionRange(len, len);
        } catch { /* some browsers reject selection on certain input types */ }
    }

    // Trap Tab / Shift+Tab inside the modal so focus can't escape to
    // the library content underneath while the edit form is open.
    _trapFocusInModal(modal);

    // Click on art triggers file input
    document.getElementById('edit-art-wrapper').addEventListener('click', () => {
        document.getElementById('edit-art-file').click();
    });

    // Save — wired in JS (not an inline onclick) so the filename never has to
    // survive embedding in a single-quoted attribute string. encodeURIComponent
    // does NOT escape `'`, so a filename like `Bob's Song.sloppak` used to break
    // the inline `saveEditModal('…')` handler and silently fail the save. The
    // raw filename lives in the closure; encode it here for saveEditModal.
    const saveBtn = modal.querySelector('[data-edit-save]');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => saveEditModal(encodeURIComponent(songData.f)));
    }

    const deleteBtn = modal.querySelector('[data-delete-filename]');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            deleteSongFromModal(deleteBtn.dataset.deleteFilename);
        });
    }

    // Close on backdrop click or Cancel button; restore focus to opener.
    // Backdrop dismissal requires the gesture's mousedown to have STARTED on
    // the backdrop — not just the click/mouseup to land there. Otherwise a
    // click-drag that begins inside a field (e.g. selecting text) and is
    // released past the modal edge resolves its `click` target to the backdrop
    // and silently discards the edit. Cancel / ✕ (data-edit-close) always close.
    let _downOnBackdrop = false;
    modal.addEventListener('mousedown', (e) => { _downOnBackdrop = (e.target === modal); });
    modal.addEventListener('click', (e) => {
        if (!_editModalShouldClose(e.target, modal, _downOnBackdrop)) return;
        const opener = modal._opener;
        modal.remove();
        const focusTarget = (opener && document.body.contains(opener)) ? opener
            : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
        if (focusTarget) focusTarget.focus({ preventScroll: true });
    });
}

// Whether a click on the edit-metadata modal should dismiss it. The Cancel / ✕
// control (data-edit-close) always dismisses. A backdrop dismissal needs BOTH
// the click target to be the backdrop element itself AND the gesture to have
// started there (downOnBackdrop) — so a click-drag begun inside a field and
// released on the backdrop does not discard the form. Pure + top-level so it's
// unit-testable in isolation.
export function _editModalShouldClose(clickTarget, modalEl, downOnBackdrop) {
    if (clickTarget && clickTarget.closest && clickTarget.closest('[data-edit-close]')) return true;
    return clickTarget === modalEl && downOnBackdrop === true;
}

export async function saveEditModal(encodedFilename) {
    const filename = decodeURIComponent(encodedFilename);

    // Save metadata
    await fetch(`/api/song/${encodeURIComponent(filename)}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: document.getElementById('edit-title').value.trim(),
            artist: document.getElementById('edit-artist').value.trim(),
            album: document.getElementById('edit-album').value.trim(),
            // Year is normalised server-side (non-numeric/empty → ""), so a
            // blank or cleared field round-trips safely.
            year: document.getElementById('edit-year').value.trim(),
        }),
    });

    // Upload art if changed
    const fileInput = document.getElementById('edit-art-file');
    if (fileInput.files && fileInput.files[0]) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            await fetch(`/api/song/${encodeURIComponent(filename)}/art/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: e.target.result }),
            });
        };
        reader.readAsDataURL(fileInput.files[0]);
    }

    const modal = document.getElementById('edit-modal');
    const opener = modal ? modal._opener : null;
    if (modal) modal.remove();
    // Restore focus to the entry the modal was opened from so subsequent
    // keyboard navigation resumes correctly (same as Esc / Cancel paths).
    const focusTarget = (opener && document.body.contains(opener)) ? opener
        : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
    if (focusTarget) focusTarget.focus({ preventScroll: true });
    // Refresh current view
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen?.id === 'favorites') loadFavorites();
    else loadLibrary();
}

export async function deleteSongFromModal(filename) {
    const title = (document.getElementById('edit-title')?.value || filename).trim();
    const ok = await _confirmDialog({
        title: 'Remove from library?',
        body: `<p class="text-sm text-gray-300">Remove <span class="font-semibold text-white">${_escAttr(title)}</span> from your library?</p>
               <p class="text-xs text-red-400/90 mt-2">This permanently deletes the file from disk. This cannot be undone.</p>`,
        confirmText: 'Remove',
        cancelText: 'Cancel',
        danger: true,
    });
    if (!ok) return;
    let resp;
    try {
        resp = await fetch(`/api/song/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    } catch (e) {
        alert(`Delete failed: ${e.message}`);
        return;
    }
    if (!resp.ok) {
        let msg = resp.statusText;
        try { msg = (await resp.json()).error || msg; } catch (_) {}
        alert(`Delete failed: ${msg}`);
        return;
    }
    const modal = document.getElementById('edit-modal');
    if (modal) modal.remove();
    L.treeStats = null;
    L.favTreeStats = null;
    L.tuningNames = null;

    // Remove the deleted song's card from any currently-rendered grid/tree
    // so the user sees it disappear without waiting for a refetch. A full
    // loadLibrary() here would re-call loadGridPage(currentPage), which
    // uses 'append' mode when currentPage > 0 and re-appends the same
    // (now-shortened) page on top of what's already rendered — leaving
    // the deleted card visible. Direct DOM removal also preserves scroll
    // position, which a refetch from page 0 would lose.
    _removeLibCardsForFilename(filename);

    // Tree views group by artist with song counts; a single card removal
    // leaves stale counts, so refresh the tree for whichever screen we're
    // looking at (each tree-view renderer replaces innerHTML cleanly).
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen?.id === 'favorites') {
        // loadFavorites() routes to either loadFavGridPage (always
        // 'replace') or loadFavTreeView — both safe for a single delete.
        loadFavorites();
    } else if (libView === 'tree') {
        loadTreeView();
    }
    // Main library grid view: DOM removal above is sufficient.
}
