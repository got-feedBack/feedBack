const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = path.join(__dirname, '..', '..', 'static', 'js', 'loop-preferences.js');

function loadPreferencesModule() {
    const sandbox = {};
    vm.createContext(sandbox);
    const src = fs.readFileSync(SOURCE, 'utf8').replace(/^export /gm, '');
    vm.runInContext(`${src}
        globalThis.__prefs = {
            defaults: LOOP_PREFERENCE_DEFAULTS,
            key: LOOP_PREFERENCES_STORAGE_KEY,
            normalizeLoopPreferences,
            loadLoopPreferences,
            saveLoopPreferences,
        };
    `, sandbox);
    return sandbox.__prefs;
}

test('loop preferences use conservative defaults', () => {
    const api = loadPreferencesModule();
    const prefs = api.loadLoopPreferences(null);
    assert.equal(prefs.activation, 'arm');
    assert.equal(prefs.firstPass, 'count-in');
    assert.equal(prefs.repeat, 'count-in');
});

test('valid loop preferences persist and reload', () => {
    const api = loadPreferencesModule();
    const values = new Map();
    const storage = {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, value); },
    };
    const saved = api.saveLoopPreferences({
        activation: 'auto',
        firstPass: 'immediate',
        repeat: 'continuous',
    }, storage);
    const loaded = api.loadLoopPreferences(storage);
    assert.equal(JSON.stringify(saved), JSON.stringify(loaded));
    assert.equal(loaded.activation, 'auto');
    assert.equal(loaded.firstPass, 'immediate');
    assert.equal(loaded.repeat, 'continuous');
});

test('corrupt and partially invalid persisted values fall back field by field', () => {
    const api = loadPreferencesModule();
    const corrupt = { getItem() { return '{not-json'; } };
    assert.equal(JSON.stringify(api.loadLoopPreferences(corrupt)), JSON.stringify(api.defaults));

    const partial = {
        getItem() {
            return JSON.stringify({
                activation: 'launch-now',
                firstPass: 'immediate',
                repeat: 42,
            });
        },
    };
    const loaded = api.loadLoopPreferences(partial);
    assert.equal(loaded.activation, 'arm');
    assert.equal(loaded.firstPass, 'immediate');
    assert.equal(loaded.repeat, 'count-in');
});

test('unavailable storage never breaks preference load or save', () => {
    const api = loadPreferencesModule();
    const unavailable = {
        getItem() { throw new Error('denied'); },
        setItem() { throw new Error('quota'); },
    };
    assert.doesNotThrow(() => api.loadLoopPreferences(unavailable));
    assert.doesNotThrow(() => api.saveLoopPreferences({
        activation: 'auto',
        firstPass: 'immediate',
        repeat: 'continuous',
    }, unavailable));
});
