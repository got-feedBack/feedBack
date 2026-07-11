// DOM + HTML-escaping primitives, and the modal dialogs built on them.
//
// Carved verbatim out of static/app.js (R3a). A LEAF module: imports nothing.
//
// This one is a GATHER, not a slice — the six lived in six different places in
// app.js. They belong together because they are the bottom of the UI stack:
// `esc` / `_escAttr` alone have ~48 call sites, and every later carve that
// renders HTML will need them. Giving them a home NOW means those carves can
// import them instead of inventing a host seam to reach back into app.js —
// which is exactly the trap the plugin-loader carve had to work around before
// the viz layer became a module.

export function _isElementVisible(el) {
    // Walk ancestors looking for display:none. Handles collapsed
    // `.album-body` / `.artist-body` subtrees (hidden via CSS class
    // rules). Using a DOM walk rather than `offsetParent` avoids the
    // false-negative for `position:fixed` elements whose offsetParent
    // is null even when they are perfectly visible.
    if (!el) return false;
    let node = el;
    while (node && node !== document.body) {
        if (getComputedStyle(node).display === 'none') return false;
        node = node.parentElement;
    }
    return true;
}

// Focus trap: keep Tab / Shift+Tab cycling inside `modal` so focus
// can't escape to the content underneath while the overlay is open.
// Call this once after the modal is in the DOM and initial focus is set.
export function _trapFocusInModal(modal) {
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    modal.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const els = Array.from(modal.querySelectorAll(FOCUSABLE)).filter(el => {
            if (!_isElementVisible(el)) return false;
            if (getComputedStyle(el).visibility === 'hidden') return false;
            if (el.disabled) return false;
            return true;
        });
        if (!els.length) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
            if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
}

// Styled async confirm dialog. Returns a Promise<boolean>. For destructive
// prompts pass `danger: true` — confirm button turns red and Cancel gets
// initial focus so an accidental Enter won't fire the action. `body` is
// inserted as HTML so callers can use formatting; callers are responsible
// for escaping any user-supplied content in it (use _escAttr).
export function _confirmDialog({ title, body = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
        const previouslyFocused = document.activeElement;
        const modal = document.createElement('div');
        modal.className = 'feedBack-modal fixed inset-0 z-[250] flex items-center justify-center bg-black/70 backdrop-blur-sm';
        modal.setAttribute('role', 'alertdialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', title || 'Confirm');
        const confirmClass = danger
            ? 'flex-1 bg-red-600 hover:bg-red-500 px-4 py-2 rounded-xl text-sm font-semibold text-white transition focus:outline-none focus:ring-2 focus:ring-red-400/60'
            : 'flex-1 bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-sm font-semibold text-white transition focus:outline-none focus:ring-2 focus:ring-accent/60';
        modal.innerHTML = `
            <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
                <h3 class="text-lg font-bold text-white mb-3">${_escAttr(title || '')}</h3>
                <div class="mb-5">${body}</div>
                <div class="flex gap-3">
                    <button type="button" data-confirm class="${confirmClass}">${_escAttr(confirmText)}</button>
                    <button type="button" data-cancel class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300 transition focus:outline-none focus:ring-2 focus:ring-gray-500/40">${_escAttr(cancelText)}</button>
                </div>
            </div>`;
        document.body.appendChild(modal);

        function finish(result) {
            modal.remove();
            document.removeEventListener('keydown', onKey, true);
            if (previouslyFocused && document.body.contains(previouslyFocused)) {
                try { previouslyFocused.focus({ preventScroll: true }); } catch {}
            }
            resolve(result);
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false); }
            else if (e.key === 'Enter' && document.activeElement === modal.querySelector('[data-confirm]')) {
                e.preventDefault(); finish(true);
            }
        }
        modal.addEventListener('click', (e) => {
            if (e.target === modal) finish(false);
            else if (e.target.closest('[data-confirm]')) finish(true);
            else if (e.target.closest('[data-cancel]')) finish(false);
        });
        document.addEventListener('keydown', onKey, true);
        _trapFocusInModal(modal);
        // Focus Cancel by default for destructive prompts so an accidental
        // Enter / Space won't fire the dangerous action; otherwise focus
        // the confirm button so Enter accepts.
        const focusTarget = modal.querySelector(danger ? '[data-cancel]' : '[data-confirm]');
        if (focusTarget) focusTarget.focus({ preventScroll: true });
    });
}

export function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// `esc()` escapes the HTML-content metacharacters (<, >, &) but not
// quotes — fine for text-node interpolation but unsafe when the
// result is used as an attribute value, where a literal `"` ends the
// attribute early. Use `_escAttr` for any `attr="${...}"` site.
export function _escAttr(s) {
    return esc(s == null ? '' : String(s))
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// In-app text prompt — replaces window.prompt(), which Electron does NOT
// implement (it logs "prompt() is and will not be supported" and returns null),
// so any prompt()-based flow is a silent no-op on desktop. Returns the entered
// string, or null if cancelled (Esc / Cancel / backdrop). Styled to match the
// edit modal; role=dialog so the global keyboard shortcuts ignore typing here.
// Injection-safe: all caller text is set via textContent / value, never innerHTML.
export function uiPrompt({ title = '', label = '', value = '', okLabel = 'Save', placeholder = '' } = {}) {
    return new Promise((resolve) => {
        const modal = document.createElement('div');
        modal.className = 'feedBack-modal fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        if (title) modal.setAttribute('aria-label', title);
        modal.innerHTML = `
            <form class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
                <h3 class="text-lg font-bold text-white mb-4" data-ui-prompt-title hidden></h3>
                <label class="text-xs text-gray-400 mb-1 block" data-ui-prompt-label hidden></label>
                <input type="text" data-ui-prompt-input autocomplete="off"
                    class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                <div class="flex gap-3 mt-5">
                    <button type="submit"
                        class="flex-1 bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-sm font-semibold text-white transition" data-ui-prompt-ok></button>
                    <button type="button" data-ui-prompt-cancel
                        class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300 transition">Cancel</button>
                </div>
            </form>`;
        const titleEl = modal.querySelector('[data-ui-prompt-title]');
        const labelEl = modal.querySelector('[data-ui-prompt-label]');
        const input = modal.querySelector('[data-ui-prompt-input]');
        const okEl = modal.querySelector('[data-ui-prompt-ok]');
        if (title) { titleEl.textContent = title; titleEl.hidden = false; }
        if (label) { labelEl.textContent = label; labelEl.hidden = false; }
        okEl.textContent = okLabel;
        input.value = value;
        if (placeholder) input.placeholder = placeholder;

        // Restore focus to wherever it was when we're done (matches the edit
        // modal's behavior so keyboard users aren't dumped at the page top).
        const previousActiveElement = document.activeElement;
        const focusables = () => Array.from(
            modal.querySelectorAll('input, button, [tabindex]:not([tabindex="-1"])'),
        ).filter((el) => !el.disabled && el.offsetParent !== null);

        let settled = false;
        const close = (result) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            modal.remove();
            if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
                previousActiveElement.focus();
            }
            resolve(result);
        };
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); return; }
            // Trap Tab inside the modal so focus can't wander to the page behind it.
            if (e.key === 'Tab') {
                const items = focusables();
                if (!items.length) return;
                const first = items[0];
                const last = items[items.length - 1];
                const active = document.activeElement;
                if (e.shiftKey && (active === first || !modal.contains(active))) {
                    e.preventDefault(); last.focus();
                } else if (!e.shiftKey && (active === last || !modal.contains(active))) {
                    e.preventDefault(); first.focus();
                }
            }
        };
        modal.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); close(input.value); });
        modal.querySelector('[data-ui-prompt-cancel]').addEventListener('click', () => close(null));
        // Backdrop (overlay itself, not the panel) cancels.
        modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(null); });
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(modal);
        input.focus();
        input.select();
    });
}
