/*
 * fee[dB]ack — the pop-out window host.
 *
 * Opens a real OS window and MOVES THE PANE'S ELEMENT INTO IT.
 *
 * The move is the whole trick, and it works because the pane window is same-origin
 * and opener-linked: `document.adoptNode()` re-parents a live node into another
 * window's document, and an adopted node keeps its event listeners, its closures,
 * and every reference anything else holds to it. So the plugin's panel goes on
 * running the plugin's own code in the plugin's own realm — it is just being
 * *displayed* somewhere else. It looks and behaves exactly like what was popped
 * out, because it is exactly what was popped out.
 *
 * That is why this file must use `window.open()` and not ask the desktop's main
 * process to make a BrowserWindow: a window we didn't open gives us no handle to
 * its document, and without the handle there is nothing to adopt into. Electron
 * turns this same-origin `window.open()` into a real BrowserWindow anyway (see
 * main.ts's setWindowOpenHandler → `action: 'allow'`), and the main process
 * recognises it by its frame name and gives it remembered bounds, always-on-top
 * and the system tray. We get the OS window AND the DOM link.
 *
 * Styles come across too — the pane document starts empty, so we copy the app's
 * stylesheets into it. Without that the panel would land unstyled, which is the
 * one thing a "pop out exactly this" feature cannot do.
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    if (!panes || typeof panes.registerHost !== 'function') {
        console.error('[panes] pane-manager.js must load before pane-window-host.js');
        return;
    }

    // The desktop's main process finds a pane window by this name and attaches
    // bounds, tray and always-on-top to it. Keep it in sync with pane-hosts.ts.
    const FRAME_PREFIX = 'fbpane-';

    const wins = new Map();   // paneId -> Window
    let reaper = null;

    // A pane window the user closed with the OS X button gets no reliable
    // beforeunload (a crashed renderer certainly gets none). Poll `closed` and
    // reap — otherwise the pane stays "open" forever, its chip stays stubbed out,
    // and the element it holds is stranded in a dead document with no way back.
    function _startReaper() {
        if (reaper != null) return;
        reaper = setInterval(() => {
            wins.forEach((w, id) => { if (w.closed) panes.close(id); });
            if (!wins.size) { clearInterval(reaper); reaper = null; }
        }, 400);
    }

    // Give the pane document the app's styles, so the panel looks identical.
    // Cloned rather than shared: a <link> node can only live in one document, and
    // we are not about to steal the app's own stylesheet out of its head.
    function _copyStyles(doc) {
        // pane.html already links panes.css, so don't clone a second copy of it —
        // duplicate sheets cost a redundant fetch and an extra style recalc for no
        // change in appearance.
        const have = new Set(
            Array.from(doc.querySelectorAll('link[rel="stylesheet"]')).map((l) => l.href));
        document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
            if (node.tagName === 'LINK' && have.has(node.href)) return;
            try { doc.head.appendChild(node.cloneNode(true)); } catch (e) { /* skip a node we can't clone */ }
        });
        // Carry the theme/scale hooks the app hangs on <html> and <body>. v3 keys
        // off these for its colour tokens and interface scale, and a panel that
        // lands without them renders in the wrong palette at the wrong size.
        //
        // MERGE, don't assign: pane.html sets `class="fb-pane-window"` on <html>,
        // and panes.css hangs the pane window's own chrome off it. Overwriting the
        // class list would take that with it and the window would lose its own
        // layout — the app's classes and the pane document's are both wanted.
        try {
            document.documentElement.classList.forEach((c) => doc.documentElement.classList.add(c));
            document.body.classList.forEach((c) => doc.body.classList.add(c));
            // The inline style on <html> carries the interface-scale custom property
            // (--fb-scale). Merge it in rather than replacing the attribute, for the
            // same reason.
            const scale = document.documentElement.style.cssText;
            if (scale) doc.documentElement.style.cssText += ';' + scale;
        } catch (e) { /* non-fatal */ }
    }

    // Wait for the REAL pane document.
    //
    // window.open() returns immediately, with an `about:blank` document that is
    // already readyState 'complete'. Adopt into that and it works for a few
    // milliseconds — and then /pane finishes loading, replaces the document, and
    // takes the panel with it. The window is left blank and the element is gone.
    //
    // So we do not trust readyState, and we do not trust 'load' (which may have
    // fired for about:blank before we could listen). We wait for the one thing that
    // only exists in the document we actually want: pane.html's #fb-pane-root.
    function _whenReady(w, onReady, onFail) {
        const deadline = performance.now() + 10000;
        let reachFailure = null;   // why we could never see the pop-out's document
        const tick = () => {
            if (w.closed) return;

            let doc = null;
            try { doc = w.document; }
            catch (e) {
                // A SecurityError here is the one that matters: it means the pop-out
                // is not reachable from this realm at all (a separate process /
                // browsing-context group), and no amount of waiting will fix it —
                // adoptNode can never work.
                doc = null;
                reachFailure = e;
            }

            if (doc && doc.readyState !== 'loading') {
                // Only ever adopt into the document we actually navigated TO.
                // about:blank reports readyState 'complete' from the moment
                // window.open() returns, and adopting into it means the panel is
                // destroyed when /pane replaces it a moment later.
                const href = (doc.location && doc.location.href) || '';
                const isPaneDoc = href.indexOf('/pane') >= 0;
                if (isPaneDoc) {
                    // Prefer pane.html's own root, but never fail for want of it —
                    // a stale cached copy of the page (or a future rename) must not
                    // leave the user with a blank window and no panel.
                    const root = doc.getElementById('fb-pane-root') || doc.body;
                    if (root) { onReady(root); return; }
                }
            }

            if (performance.now() > deadline) {
                let why;
                if (reachFailure) {
                    why = 'the pane window\'s document is NOT reachable from this window ('
                        + reachFailure.name + ': ' + reachFailure.message
                        + ') — it is in a separate process, so the element cannot be moved into it';
                } else if (!doc) {
                    why = 'the pane window exposed no document at all';
                } else {
                    why = 'the pane window never loaded /pane (it is showing '
                        + ((doc.location && doc.location.href) || 'an unknown URL')
                        + ', readyState ' + doc.readyState + ')';
                }
                onFail(new Error(why));
                return;
            }
            setTimeout(tick, 25);
        };
        tick();
    }

    function _adopt(w, root, spec, el) {
        const doc = w.document;
        _copyStyles(doc);
        // The panel was almost certainly a fixed/absolute overlay pinned to a
        // corner of the app. In a window of its own that positioning is nonsense —
        // it would sit 72px from the top of a 380px window, still 288px wide, still
        // casting a drop shadow over nothing. Neutralise the *placement* while
        // touching nothing else about how it looks.
        el.classList.add('fb-paned');
        root.appendChild(doc.adoptNode(el));
        doc.title = spec.title + ' — fee[dB]ack';

        // THE ELEMENT MUST LEAVE BEFORE THE DOCUMENT DIES.
        //
        // When the user closes a pane window, its document is torn down — and the
        // panel is inside it. The node itself survives (we hold a reference) and
        // comes home looking perfect: right markup, right classes, right size. But
        // it comes home DEAD: every event listener in the subtree is gone with the
        // document that hosted them. A panel that renders and does nothing.
        //
        // The `closed` poll cannot save us: by the time `w.closed` is true, the
        // document is already gone. `beforeunload` fires while it is still alive, so
        // this is the last moment we can get the element out — and panes.close()
        // adopts it back into the main document synchronously.
        //
        // We attach it HERE, not when the window was opened: back then the window
        // still held its throwaway about:blank document, and a listener registered
        // on that is discarded when /pane replaces it.
        w.addEventListener('beforeunload', () => {
            if (panes.isOpen(spec.id)) panes.close(spec.id);
        });

        // Measure LATE. The pane window has not laid out yet at this point (it is
        // still being created and shown), so anything read now reports 0x0 whether
        // or not there is a real problem.
        setTimeout(() => {
            if (w.closed || !el.isConnected) return;
            const view = doc.defaultView;
            const cs = view.getComputedStyle(el);
            const rootCs = view.getComputedStyle(root);
            console.info('[panes] adopted', spec.id,
                '| el:', el.id || el.className,
                '| size:', el.offsetWidth + 'x' + el.offsetHeight,
                '| display:', cs.display, '| visibility:', cs.visibility, '| opacity:', cs.opacity,
                '| position:', cs.position, '| w/h:', cs.width + '/' + cs.height,
                '| children:', el.childElementCount,
                '| hidden attr:', el.hasAttribute('hidden'),
                '| inline style:', el.getAttribute('style') || '(none)',
                '| root size:', root.offsetWidth + 'x' + root.offsetHeight, '/', rootCs.display,
                '| window inner:', view.innerWidth + 'x' + view.innerHeight,
                '| styles:', doc.querySelectorAll('link[rel="stylesheet"], style').length);
        }, 400);
    }

    function place(spec, el) {
        const w = window.open(
            window.location.origin + '/pane',
            FRAME_PREFIX + spec.id,
            'popup,width=' + spec.width + ',height=' + spec.height,
        );

        if (!w) {
            // Popup blocked. Throw BEFORE the manager records anything, so the
            // caller's panel stays exactly where it is — and say so out loud rather
            // than appearing to do nothing.
            if (window.fbNotify) {
                window.fbNotify.show({
                    title: 'Pop-out blocked',
                    message: 'Allow pop-ups for this site to detach ' + spec.title + '.',
                    icon: '⚠️', accent: '#f59e0b',
                });
            }
            throw new Error('pop-up blocked');
        }

        wins.set(spec.id, w);
        _startReaper();

        // Take the element out of the document NOW, not when the window is ready.
        //
        // Everything below this line is async: the window has to load /pane before
        // there is anything to adopt into. But the manager emits `panes:opened` as
        // soon as we return, and the chip reacts by putting its "popped out" stub
        // where the element used to be — so for that whole gap the user would see
        // BOTH the real panel and a stub claiming it had left. On a window that
        // never loads, that lasts the full 10s timeout.
        //
        // Detaching is not destructive: the node keeps its owner document (this
        // one), its listeners and its closures. It is simply out of the tree,
        // waiting — and if the window never loads, closePane() puts it straight
        // back at its home.
        el.remove();

        _whenReady(w, (root) => {
            try { _adopt(w, root, spec, el); }
            catch (e) {
                console.error('[panes] failed to move', spec.id, 'into its window', e);
                panes.close(spec.id);   // brings the element home
            }
        }, (err) => {
            console.error('[panes]', spec.id, err);
            panes.close(spec.id);       // never strand the element in a dead window
        });

        // The pane window's 'beforeunload' listener is registered in _adopt(), NOT
        // here: a listener added now would attach to the window's throwaway
        // about:blank document and be discarded when /pane replaces it.
    }

    function unplace(id, el) {
        // Hand the element back unmarked. The manager returns it to its home right
        // after this, and it must arrive as the plugin left it — a panel that
        // stayed .fb-paned would come back with its own positioning stripped.
        if (el) el.classList.remove('fb-paned');
        const w = wins.get(id);
        wins.delete(id);
        // The manager adopts the element back into this document immediately after
        // this returns, so the window is empty by the time it closes.
        if (w && !w.closed) { try { w.close(); } catch (e) { /* already gone */ } }
    }

    function focus(id) {
        const w = wins.get(id);
        if (w && !w.closed) { try { w.focus(); } catch (e) { /* the OS may refuse */ } }
    }

    // A BROWSER blocks window.open() outside a user gesture, so a pane remembered
    // here cannot be restored on page load — it would only ever produce a "blocked"
    // toast. Such a pane comes back in the dock, and the chip pops it out again on
    // the user's next click. The DESKTOP app has no such restriction, so there a
    // pane left popped out comes back popped out, where you left it.
    const isDesktop = !!(window.feedBackDesktop && window.feedBackDesktop.panes);

    panes.registerHost({
        id: 'window',
        priority: 10,
        autoRestore: isDesktop,
        place, unplace, focus,
    });

    // Our windows; they must not outlive us. A pane window whose opener is gone
    // holds an element belonging to a dead document — there is nothing left to
    // dock it back into.
    window.addEventListener('beforeunload', () => {
        wins.forEach((w) => { if (!w.closed) { try { w.close(); } catch (e) { /* ignore */ } } });
    });
})();
