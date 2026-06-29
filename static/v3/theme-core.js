/*
 * fee[dB]ack v0.3.0 — cosmetics applier (spec 010): shop themes + avatar frames.
 *
 * Replicates the proven plugins/themes CSS-variable pattern for the v3 `fb-*`
 * palette: one injected <style> re-points the fb utility classes at
 * `--fbv-*` variables under an `html[data-fb-theme]` gate, so the default
 * look is untouched until a theme is equipped and "unequip" is just removing
 * the attribute. No Tailwind build interaction (constitution P-II) — rules
 * are generated at runtime from the equipped item's color payload.
 *
 * Loads BEFORE profile.js so the equipped theme + avatar frame apply with the
 * first badge render (equipped cosmetics ride along on GET /api/profile).
 * Decorative accents (rings, shadows, placeholder tints) deliberately keep
 * their defaults — themes recolor surfaces, text, and borders.
 */
(function () {
    'use strict';
    const STYLE_ID = 'fb-theme-style';
    // Mirrors the `fb` palette in tailwind.config.js.
    const KEYS = ['bg', 'sidebar', 'card', 'cardMuted', 'primary', 'primaryHi', 'accent',
                  'text', 'textDim', 'border', 'good', 'mid', 'low', 'gold'];
    // Opacity suffixes used by v3 markup (bg-fb-card/80, border-fb-border/50, …).
    const OPACITY = { 95: '0.95', 90: '0.9', 80: '0.8', 70: '0.7', 60: '0.6',
                      50: '0.5', 40: '0.4', 30: '0.3', 20: '0.2', 10: '0.1' };

    // Default fb palette (mirrors tailwind.config.js `fb`). Emitted as
    // always-present `--fbv-*` on :root so `var(--fbv-accent)` resolves even
    // un-themed — the un-themed look is unchanged (the fb-* utilities still use
    // their compiled defaults; this only hands plugins a stable host token to
    // read + derive from). Adds two keystone ROLES the palette lacked:
    // `on-accent` (a foreground legible ON the accent fill — the missing piece
    // behind white-on-accent contrast bugs) and `focus-ring`.
    const DEFAULTS = {
        bg: '#0f172a', sidebar: '#111827', card: '#1e293b', cardMuted: '#0b1220',
        primary: '#0ea5e9', primaryHi: '#38bdf8', accent: '#ef4444',
        text: '#f8fafc', textDim: '#94a3b8', border: '#334155',
        good: '#22c55e', mid: '#eab308', low: '#ef4444', gold: '#e8c040',
        'on-accent': '#f8fafc', 'focus-ring': '#38bdf8',
    };

    let _frameStyle = '';   // equipped avatar-frame CSS fragment ('' = none)
    let _themeId = null;    // equipped theme id (null = default look)
    let _themeCaps = null;  // equipped theme's declared device capabilities, or null

    function hexToRgb(hex) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        if (!m) return null;
        const n = parseInt(m[1], 16);
        return ((n >> 16) & 255) + ' ' + ((n >> 8) & 255) + ' ' + (n & 255);
    }

    function cssFor(colors) {
        let vars = '';
        let rules = '';
        for (const key of KEYS) {
            const rgb = hexToRgb(colors[key]);
            if (!rgb) continue;
            vars += '  --fbv-' + key + ': ' + rgb + ';\n';
            const v = 'var(--fbv-' + key + ')';
            rules +=
                'html[data-fb-theme] .bg-fb-' + key + ' { background-color: rgb(' + v + '); }\n' +
                'html[data-fb-theme] .hover\\:bg-fb-' + key + ':hover { background-color: rgb(' + v + '); }\n' +
                'html[data-fb-theme] .text-fb-' + key + ' { color: rgb(' + v + '); }\n' +
                'html[data-fb-theme] .hover\\:text-fb-' + key + ':hover { color: rgb(' + v + '); }\n' +
                'html[data-fb-theme] .border-fb-' + key + ' { border-color: rgb(' + v + '); }\n';
            for (const suffix in OPACITY) {
                const op = OPACITY[suffix];
                rules +=
                    'html[data-fb-theme] .bg-fb-' + key + '\\/' + suffix + ' { background-color: rgb(' + v + ' / ' + op + '); }\n' +
                    'html[data-fb-theme] .text-fb-' + key + '\\/' + suffix + ' { color: rgb(' + v + ' / ' + op + '); }\n' +
                    'html[data-fb-theme] .border-fb-' + key + '\\/' + suffix + ' { border-color: rgb(' + v + ' / ' + op + '); }\n' +
                    'html[data-fb-theme] .divide-fb-' + key + '\\/' + suffix + ' > :not([hidden]) ~ :not([hidden]) { border-color: rgb(' + v + ' / ' + op + '); }\n';
            }
        }
        // The app shell paints body via bg-fb-sidebar (covered above); cover a
        // bare body too so the radial-gradient fallback areas follow the theme.
        rules += 'html[data-fb-theme] body { background-color: rgb(var(--fbv-sidebar)); color: rgb(var(--fbv-text)); }\n';
        // The sidebar's navy radial wash is hardcoded in v3.css (#v3-sidebar)
        // and carries NO fb-* utility class, so the per-utility loop above
        // can't reach it — it stayed navy under every theme, the most visible
        // "backgrounds don't change" gap. Re-point it at the theme, mirroring
        // v3.css's stops (#1e293b == default card, #0f172a == default bg).
        // Only background-image is overridden, so background-attachment:fixed
        // from v3.css is preserved. Gated by [data-fb-theme] => default look
        // untouched. (Scroll-thumb colors are deliberately left alone: theming
        // the resting thumb would out-specify v3.css's :hover lighten rule and
        // kill it, and there's no palette token between border and textDim to
        // reproduce the hover shade without color-mix, unused here.)
        rules += 'html[data-fb-theme] #v3-sidebar { background-image: radial-gradient(circle at top, rgb(var(--fbv-card)) 0%, rgb(var(--fbv-bg)) 100%); }\n';
        return 'html[data-fb-theme] {\n' + vars + '}\n' + rules;
    }

    function apply(payload, meta) {
        const colors = payload && payload.colors;
        let styleEl = document.getElementById(STYLE_ID);
        if (!colors) {
            if (styleEl) styleEl.remove();
            document.documentElement.removeAttribute('data-fb-theme');
            _themeId = null; _themeCaps = null;
            _emitThemeChanged();
            return;
        }
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = STYLE_ID;
            document.head.appendChild(styleEl);
        }
        styleEl.textContent = cssFor(colors);
        document.documentElement.setAttribute('data-fb-theme', '1');
        // Track identity + declared device capabilities for the read API. A
        // theme MAY carry `capabilities` (e.g. {glow:false}) in its payload;
        // recolor-only themes carry none (→ default affordances reported).
        _themeId = (meta && meta.id) || (payload && payload.id) || 'custom';
        _themeCaps = (payload && payload.capabilities)
            || (meta && meta.capabilities) || null;
        _emitThemeChanged();
    }

    function setFrame(payload) {
        // Bundled-content trust model; still keep it attribute-safe (it is set
        // via element.style, never innerHTML).
        _frameStyle = String((payload && payload.frame_style) || '').replace(/[{}<>]/g, '');
    }

    // Apply the equipped frame to an avatar wrapper element (badge, profile,
    // Progress). Always resets first so unequip clears previous frames.
    function applyFrame(el) {
        if (!el) return;
        el.style.boxShadow = '';
        if (_frameStyle) el.style.cssText += ';' + _frameStyle + ';';
    }

    function applyCosmetics(cosmetics) {
        cosmetics = cosmetics || {};
        apply((cosmetics.theme || {}).payload || null, cosmetics.theme || null);
        setFrame((cosmetics.avatar_frame || {}).payload || null);
    }

    async function refresh() {
        try {
            const r = await fetch('/api/profile');
            if (r.ok) {
                const profile = await r.json();
                applyCosmetics(profile.cosmetics);
                if (window.feedBack && typeof window.feedBack.emit === 'function') {
                    window.feedBack.emit('v3:cosmetics-applied', profile.cosmetics || {});
                }
            }
        } catch (e) { /* offline — keep current look */ }
    }

    // ── Host theme READ surface (window.feedBack.theme) ──────────────────────
    // The apply side stays on window.v3Theme; this is the read/capability side
    // plugins consume so a feature can render correctly under any theme instead
    // of binding to the one the dev happened to see. See docs/host-theme-contract.md.

    // Always-present `--fbv-*` defaults on :root (see DEFAULTS). Additive: the
    // un-themed look is unchanged; this only makes var(--fbv-*) resolve so a
    // plugin can derive surfaces from host tokens whether or not a theme is on.
    function _injectDefaults() {
        if (document.getElementById('fb-theme-defaults')) return;
        let vars = '';
        for (const key in DEFAULTS) {
            const rgb = hexToRgb(DEFAULTS[key]);
            if (rgb) vars += '  --fbv-' + key + ': ' + rgb + ';\n';
        }
        const el = document.createElement('style');
        el.id = 'fb-theme-defaults';
        el.textContent = ':root {\n' + vars + '}\n';
        (document.head || document.documentElement).appendChild(el);
    }

    function prefersReducedMotion() {
        try {
            return !!(window.matchMedia
                && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (e) { return false; }
    }

    // Live snapshot of the resolved role tokens ("r g b" triplets; use as
    // rgb(var(--fbv-<key>)) in CSS). Reflects the themed values when a theme is
    // equipped, the :root defaults otherwise.
    function _readTokens() {
        const t = {};
        try {
            const cs = getComputedStyle(document.documentElement);
            for (const key in DEFAULTS) {
                const v = cs.getPropertyValue('--fbv-' + key).trim();
                if (v) t[key] = v;
            }
        } catch (e) { /* no computed style available yet */ }
        return t;
    }

    // Whether the ACTIVE theme permits decorative DEVICES — the signal a feature
    // reads to pick a device (glow vs. solid) rather than hardcoding one. Today's
    // recolor-only themes declare nothing → default affordances; a theme may opt
    // out via `capabilities` in its payload (e.g. a clean theme = {glow:false}).
    // `motion` is additionally gated by the OS reduced-motion preference.
    function capabilities() {
        const c = _themeCaps || {};
        const allowMotion = c.motion !== undefined ? !!c.motion : true;
        return {
            glow: c.glow !== undefined ? !!c.glow : true,
            gradients: c.gradients !== undefined ? !!c.gradients : true,
            motion: allowMotion && !prefersReducedMotion(),
        };
    }

    function get() {
        return {
            id: _themeId,
            isThemed: document.documentElement.hasAttribute('data-fb-theme'),
            tokens: _readTokens(),
        };
    }

    function _emitThemeChanged() {
        if (window.feedBack && typeof window.feedBack.emit === 'function') {
            window.feedBack.emit('theme:changed', {
                id: _themeId,
                isThemed: document.documentElement.hasAttribute('data-fb-theme'),
                tokens: _readTokens(),
                capabilities: capabilities(),
            });
        }
    }

    window.v3Theme = {
        apply,            // preview/apply a theme payload directly (null = default)
        applyCosmetics,   // apply a {theme, avatar_frame} equipped map
        applyFrame,       // decorate an avatar wrapper with the equipped frame
        frameStyle: () => _frameStyle,
        refresh,          // re-read equipped cosmetics from /api/profile
    };

    // Host-owned theme READ surface. Attached defensively so it survives the
    // feedBack bus being (re)built by capabilities.js regardless of load order
    // (the bus constructor copies pre-existing keys onto itself).
    window.feedBack = window.feedBack || {};
    window.feedBack.theme = { get, capabilities, prefersReducedMotion };

    _injectDefaults();
    refresh();
    // Re-apply when an equip/unequip happens anywhere (shop screen, capability
    // command from a plugin).
    if (window.feedBack && typeof window.feedBack.on === 'function') {
        window.feedBack.on('progression:cosmetic-equipped', refresh);
    }
})();
