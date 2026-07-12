/*
 * fee[dB]ack — pane manager.
 *
 * The registry and host router behind `window.feedBack.panes`.
 *
 * A "pane" is a piece of UI a plugin already has — a mixer panel, a camera rig,
 * a settings board — that the user can pop out into its own OS window and leave
 * open: while they play, across song switches, on a second monitor, minimized to
 * the tray.
 *
 * The whole design is one sentence: WE MOVE THE REAL ELEMENT.
 *
 * Not a copy of it, not a re-implementation of it in the pop-out window — the
 * actual DOM node. Same-origin windows can adopt each other's nodes, and an
 * adopted node keeps its event listeners and its closures. So the panel goes on
 * running the plugin's own code, against the plugin's own state, in the plugin's
 * own realm. It looks and behaves exactly like the thing that was popped out,
 * because it IS the thing that was popped out.
 *
 * That is what makes the plugin's side of this two lines:
 *
 *     feedBack.panes.register({ id: 'camera_director', title: 'Camera', element: () => panelEl });
 *     feedBack.panes.attachChip(panelEl, 'camera_director');
 *
 * No state mirroring, no cross-window RPC, no second copy of the UI to keep in
 * step with the first. Those were all workarounds for a problem we simply do not
 * have once the node itself moves.
 *
 * The manager owns which pane is open and where, and — crucially — where each
 * pane's element CAME FROM, so docking it puts it back exactly where it was.
 */
(function () {
    'use strict';

    const HOSTS_KEY = 'fbPaneHosts';       // { paneId: hostId } — panes open at last unload

    // id -> normalized spec
    const specs = new Map();
    // id -> { spec, hostId, el, home: { parent, next } }
    const open = new Map();
    // hostId -> host provider
    const hosts = new Map();

    // ── Persistence ──────────────────────────────────────────────────────────
    // Only which pane was open, and where. A pane's CONTENTS are the plugin's own
    // DOM and the plugin's own state — none of our business.

    // A pane id is plugin-controlled and is used as a key in the persisted
    // host map. `__proto__` and friends are not ids, they are booby traps: writing
    // `map['__proto__'] = 'window'` on a plain object corrupts the map (and can
    // reach Object.prototype), and reading `map[id]` can pick a value straight off
    // the prototype chain for a pane that was never remembered at all.
    //
    // Rejected at registration, so the id never reaches storage — and the reads
    // below are own-property checks anyway, because defence in depth is cheap here.
    const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];
    function _isUnsafeId(id) { return UNSAFE_KEYS.indexOf(id) >= 0; }

    function _readJSON(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
            // Re-key onto a null-prototype object: whatever was in storage (hand
            // edited, corrupt, polluted) can no longer smuggle in a prototype.
            const safe = Object.create(null);
            Object.keys(parsed).forEach((k) => { if (!_isUnsafeId(k)) safe[k] = parsed[k]; });
            return safe;
        } catch (e) { return fallback; }   // private mode / corrupt value
    }
    function _writeJSON(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota / private mode: non-fatal */ }
    }
    function _rememberHost(id, hostId) {
        if (_isUnsafeId(id)) return;
        const map = _readJSON(HOSTS_KEY, Object.create(null));
        if (hostId) map[id] = hostId; else delete map[id];
        _writeJSON(HOSTS_KEY, map);
    }
    function _rememberedHost(id) {
        const map = _readJSON(HOSTS_KEY, Object.create(null));
        return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined;
    }

    // ── Spec ─────────────────────────────────────────────────────────────────

    function _normalize(spec) {
        if (!spec || typeof spec !== 'object') throw new TypeError('panes.register: spec must be an object');
        if (!spec.id || typeof spec.id !== 'string') throw new TypeError('panes.register: spec.id is required');
        // See UNSAFE_KEYS: a pane id becomes a key in the persisted host map.
        if (_isUnsafeId(spec.id)) throw new TypeError('panes.register: unsafe pane id: ' + spec.id);
        if (typeof spec.element !== 'function' && !(spec.element instanceof Element)) {
            throw new TypeError('panes.register(' + spec.id + '): spec.element must be an Element, or a function returning one');
        }
        return {
            id: spec.id,
            title: spec.title || spec.id,
            icon: spec.icon || '▣',
            // Resolved lazily: a plugin often builds its panel on first use, so the
            // element may not exist at registration time — and it may be rebuilt
            // later (Camera Director rebuilds its panel on every mode change).
            // Asking for it at open time means we always move the live one.
            element: typeof spec.element === 'function' ? spec.element : () => spec.element,
            width: spec.width || 380,
            height: spec.height || 560,
            defaultHost: spec.defaultHost || 'window',
            // Called after the element lands in (or returns from) a pane window,
            // for a plugin that needs to re-measure or re-anchor something.
            onHost: typeof spec.onHost === 'function' ? spec.onHost : null,
        };
    }

    // ── Host routing ─────────────────────────────────────────────────────────

    function _resolveHost(preferred) {
        const wanted = hosts.get(preferred);
        if (wanted && wanted.available()) return wanted;
        // Fall back to the best available host. The dock registers at priority 0
        // and is always available, so a pane can never fail to open.
        let best = null;
        hosts.forEach((h) => {
            if (!h.available()) return;
            if (!best || h.priority > best.priority) best = h;
        });
        return best;
    }

    function _emit(name, detail) {
        const bus = window.feedBack;
        if (bus && typeof bus.emit === 'function') bus.emit(name, detail);
    }

    // ── Open / close ─────────────────────────────────────────────────────────

    function openPane(id, opts) {
        opts = opts || {};
        const spec = specs.get(id);
        if (!spec) { console.warn('[panes] open: no such pane:', id); return false; }
        if (open.has(id)) { focusPane(id); return true; }

        let el;
        try { el = spec.element(); } catch (e) { el = null; }
        if (!(el instanceof Element)) {
            console.warn('[panes] open: pane has no element yet:', id);
            return false;
        }

        const host = _resolveHost(opts.host || spec.defaultHost);
        if (!host) { console.error('[panes] open: no host available for', id); return false; }

        // Where the element lives right now, so docking can put it back EXACTLY
        // there — same parent, same position among its siblings. Anything less and
        // a docked panel reappears at the bottom of its container, or not at all.
        const home = { parent: el.parentNode, next: el.nextSibling };

        // An element on its way OUT of this document must not carry a class whose
        // whole job is to hide it IN this document. `.fb-pane-detached` is
        // `display:none !important`, and it travels with the node — straight into
        // the pane window, which then renders nothing at all.
        el.classList.remove('fb-pane-detached');

        // Make it visible, and remember exactly how it wasn't.
        //
        // A plugin's panel is usually hidden until its launcher is clicked, and a
        // pane can be opened from the tray or the rail without that ever happening.
        // So we un-hide it — but only in the two ways a panel is actually hidden
        // (`hidden`, or an inline `display:none`), and we put both back on dock.
        //
        // Note what we do NOT do: force a `display`. A panel that is `display:flex`
        // must stay flex. Neutralising placement is one thing; silently re-laying
        // out someone's panel is another.
        const vis = { hidden: el.hidden, display: el.style.display };
        el.hidden = false;
        if (el.style.display === 'none') el.style.display = '';

        try {
            host.place(spec, el);
        } catch (e) {
            console.error('[panes] host', host.id, 'failed to take', id, e);
            el.hidden = vis.hidden;
            el.style.display = vis.display;
            return false;
        }

        open.set(id, { spec, hostId: host.id, el, home, vis });
        if (opts.remember !== false) _rememberHost(id, host.id);
        if (spec.onHost) { try { spec.onHost(host.id, el); } catch (e) { console.error('[panes]', id, 'onHost threw', e); } }
        // `home` rides along because the element has LEFT this document — anything
        // that wants to mark the hole it left (the chip's stub) needs to know where
        // the hole is, and can no longer ask the element itself.
        _emit('panes:opened', { id: id, host: host.id, el: el, home: home });
        return true;
    }

    function closePane(id, opts) {
        opts = opts || {};
        const entry = open.get(id);
        if (!entry) return false;
        open.delete(id);

        // ORDER IS LOAD-BEARING: bring the element home BEFORE the host lets go of
        // it. The host's unplace() closes the pane window, and closing a window
        // tears down its document — with the element still inside it. The node
        // survives (we hold a reference) but comes back stripped of its event
        // listeners, so the panel returns looking perfect and completely dead: no
        // buttons, no sliders, nothing.
        //
        // Adopt first, while the pane window is still alive, and the node moves out
        // of a living document into a living document, which is the only case the
        // DOM actually guarantees.
        // ADOPT UNCONDITIONALLY, INSERT CONDITIONALLY. The rescue and the
        // re-homing are two different jobs, and only one of them is allowed to
        // fail.
        //
        // Adopting is what saves the element: it transfers ownership away from the
        // pane window's document, so that document can be destroyed without taking
        // the listeners with it. Do that FIRST, and always — even when there is
        // nowhere to put the element afterwards.
        //
        // Re-homing can legitimately be impossible: the panel may never have had a
        // parent (a plugin that builds it lazily and hands it straight to us), or
        // its container may have been torn down while the pane was out (a screen
        // change). Gating the adopt on a reachable home would mean that in exactly
        // those cases we leave the element inside a window we are about to close —
        // which is the "comes home dead" failure this whole ordering exists to
        // prevent. It just moves it from the common path to the rare one, where it
        // is far harder to spot.
        //
        // With no home, the element ends up owned by this document but not in it:
        // detached, intact, listeners alive, and ready for the plugin to re-insert
        // whenever it rebuilds its UI.
        try {
            // adoptNode, not appendChild: the node's owner is currently the pane
            // window's document, and adopting is what transfers ownership back.
            const node = document.adoptNode(entry.el);
            const home = entry.home;
            if (home && home.parent && home.parent.isConnected) {
                if (home.next && home.next.parentNode === home.parent) home.parent.insertBefore(node, home.next);
                else home.parent.appendChild(node);
            } else {
                console.warn('[panes]', id, 'has no home to return to — the element is detached but intact');
            }
        } catch (e) {
            console.error('[panes] could not bring', id, 'back out of its pane window', e);
        }

        const host = hosts.get(entry.hostId);
        try { if (host) host.unplace(id, entry.el); } catch (e) { console.error('[panes] host', entry.hostId, 'threw releasing', id, e); }

        // Put its visibility back exactly as we found it. A panel that was closed
        // when the pane was opened from the tray goes back to being closed; one that
        // was open stays open. We forced it visible; we un-force it.
        if (entry.vis) {
            entry.el.hidden = entry.vis.hidden;
            entry.el.style.display = entry.vis.display;
        }

        if (opts.remember !== false) _rememberHost(id, null);
        if (entry.spec.onHost) { try { entry.spec.onHost(null, entry.el); } catch (e) { /* non-fatal */ } }
        _emit('panes:closed', { id: id, host: entry.hostId });

        return true;
    }

    function focusPane(id) {
        const entry = open.get(id);
        if (!entry) return false;
        const host = hosts.get(entry.hostId);
        if (host && typeof host.focus === 'function') host.focus(id);
        return true;
    }

    // What the pop-out chip calls: put this pane wherever a pane most wants to
    // live. That is a window if one can be had, and the dock otherwise.
    function detach(id) {
        const spec = specs.get(id);
        return openPane(id, { host: (spec && spec.defaultHost) || 'window' });
    }

    function dock(id) {
        if (open.has(id)) closePane(id, { remember: false });
        return openPane(id, { host: 'dock' });
    }

    // ── Registry ─────────────────────────────────────────────────────────────

    function register(spec) {
        const s = _normalize(spec);
        if (specs.has(s.id)) {
            // First registration wins, matching libraryCardActions.register. A
            // silent overwrite would swap the element out from under an open pane.
            console.warn('[panes] pane already registered, ignoring:', s.id);
            return () => {};
        }
        specs.set(s.id, s);
        _emit('panes:registered', { id: s.id, title: s.title });

        // Reopen where the user left it. Deferred a tick so a plugin can call
        // register() and attachChip() back to back — the chip must exist before
        // the pane opens, or it has nothing to hide.
        //
        // A host may refuse to be auto-restored: a browser blocks window.open()
        // without a user gesture, so restoring a popped-out pane on page load
        // would only ever produce a "pop-up blocked" toast. Such a pane comes back
        // in the dock, and the chip pops it out again on the user's next click.
        let remembered = _rememberedHost(s.id);
        if (remembered) {
            const h = hosts.get(remembered);
            if (h && h.autoRestore === false) remembered = 'dock';
            setTimeout(() => { if (specs.has(s.id) && !open.has(s.id)) openPane(s.id, { host: remembered, remember: false }); }, 0);
        }

        return () => unregister(s.id);
    }

    function unregister(id) {
        if (open.has(id)) closePane(id, { remember: false });
        specs.delete(id);
        _emit('panes:unregistered', { id: id });
    }

    function registerHost(host) {
        if (!host || !host.id) throw new TypeError('panes: host needs an id');
        hosts.set(host.id, {
            id: host.id,
            priority: host.priority || 0,
            autoRestore: host.autoRestore !== false,
            available: typeof host.available === 'function' ? host.available : () => true,
            place: host.place,
            unplace: host.unplace,
            focus: host.focus,
        });
    }

    const api = {
        version: 2,
        register,
        unregister,
        open: openPane,
        close: closePane,
        detach,
        dock,
        focus: focusPane,
        isOpen: (id) => open.has(id),
        hostOf: (id) => { const e = open.get(id); return e ? e.hostId : null; },
        // Where an open pane's element came from. The chip needs this to mark the
        // hole the element left, since it can no longer ask the element itself.
        homeOf: (id) => { const e = open.get(id); return e ? e.home : null; },
        // The element a host actually took. The chip needs this to tell "the pane
        // took MY element" from "the pane took something else" — and it cannot ask
        // the element, which may now be in a dock card or another window entirely.
        elementOf: (id) => { const e = open.get(id); return e ? e.el : null; },
        get: (id) => specs.get(id) || null,
        list: () => Array.from(specs.values()).map((s) => ({
            id: s.id, title: s.title, icon: s.icon,
            open: open.has(s.id), host: (open.get(s.id) || {}).hostId || null,
        })),
        registerHost,
    };

    window.feedBack = window.feedBack || {};
    window.feedBack.panes = Object.assign(window.feedBack.panes || {}, api);
})();
