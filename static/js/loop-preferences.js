// Persistent policy for built-in loop entry points. Keep storage handling here
// so the playback controller can stay focused on transport and lifecycle.

export const LOOP_PREFERENCES_STORAGE_KEY = 'feedback.loop.preferences.v1';

export const LOOP_PREFERENCE_DEFAULTS = Object.freeze({
    activation: 'arm',
    firstPass: 'count-in',
    repeat: 'count-in',
});

const _VALID_LOOP_PREFERENCES = Object.freeze({
    activation: new Set(['arm', 'auto']),
    firstPass: new Set(['count-in', 'immediate']),
    repeat: new Set(['count-in', 'continuous']),
});

export function normalizeLoopPreferences(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        activation: _VALID_LOOP_PREFERENCES.activation.has(source.activation)
            ? source.activation
            : LOOP_PREFERENCE_DEFAULTS.activation,
        firstPass: _VALID_LOOP_PREFERENCES.firstPass.has(source.firstPass)
            ? source.firstPass
            : LOOP_PREFERENCE_DEFAULTS.firstPass,
        repeat: _VALID_LOOP_PREFERENCES.repeat.has(source.repeat)
            ? source.repeat
            : LOOP_PREFERENCE_DEFAULTS.repeat,
    };
}

export function loadLoopPreferences(storage) {
    if (arguments.length === 0) {
        try { storage = globalThis.localStorage; } catch (_) { storage = null; }
    }
    if (!storage || typeof storage.getItem !== 'function') {
        return normalizeLoopPreferences(null);
    }
    try {
        const raw = storage.getItem(LOOP_PREFERENCES_STORAGE_KEY);
        if (!raw) return normalizeLoopPreferences(null);
        return normalizeLoopPreferences(JSON.parse(raw));
    } catch (_) {
        return normalizeLoopPreferences(null);
    }
}

export function saveLoopPreferences(preferences, storage) {
    const normalized = normalizeLoopPreferences(preferences);
    if (arguments.length < 2) {
        try { storage = globalThis.localStorage; } catch (_) { storage = null; }
    }
    if (!storage || typeof storage.setItem !== 'function') return normalized;
    try {
        storage.setItem(LOOP_PREFERENCES_STORAGE_KEY, JSON.stringify(normalized));
    } catch (_) {
        // Storage can be unavailable in private mode or locked-down embeds.
        // Preferences still apply for the current page lifetime.
    }
    return normalized;
}
