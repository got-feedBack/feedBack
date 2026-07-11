// Verify loadPlugins' plugin-DOM wipe loops in static/js/plugin-loader.js: a plugin that is
// merely ABSENT from the current /api/plugins response (transient partial
// response while the backend's plugin registry is repopulating after a
// restart) must keep its settings panel and screen DOM. Wiping it while its
// _loadedPluginScripts entry survives made the next refetch fail the
// DOM-existence check and re-evaluate the plugin's screen.js mid-session —
// which duplicated the desktop audio_engine's native signal chain. Plugins
// the response knows about but that failed hydration are still wiped, as is
// junk DOM carrying no plugin id.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLUGIN_LOADER_JS = path.join(__dirname, '..', '..', 'static', 'js', 'plugin-loader.js');

// Slice the wipe block out of loadPlugins by its stable landmarks: from the
// nav reset that opens it to the comment introducing the next section.
function extractWipeBlock(src) {
    const start = src.indexOf("navContainer.innerHTML = '';");
    assert.ok(start !== -1, 'wipe block start (nav reset) not found');
    const end = src.indexOf('// Plugin settings area hosts', start);
    assert.ok(end !== -1, 'wipe block end marker not found');
    return src.slice(start, end);
}

function makeEl(pluginId, id) {
    return {
        dataset: pluginId != null ? { pluginId } : {},
        id: id || (pluginId != null ? `plugin-${pluginId}` : ''),
        removed: false,
        remove() {
            this.removed = true;
            const idx = this._parent ? this._parent.indexOf(this) : -1;
            if (idx >= 0) this._parent.splice(idx, 1);
        },
    };
}

function runWipe({ respondedIds, alreadyHydrated, settingsChildren, screens }) {
    const src = fs.readFileSync(PLUGIN_LOADER_JS, 'utf8');
    const block = extractWipeBlock(src);
    settingsChildren.forEach((el) => { el._parent = settingsChildren; });
    const container = { children: settingsChildren };
    const sandbox = {
        navContainer: { innerHTML: 'seed' },
        mobileNavContainer: { innerHTML: 'seed' },
        _pluginSettingsContainers: () => [container],
        respondedIds,
        alreadyHydrated,
        document: {
            querySelectorAll: (sel) => {
                assert.equal(sel, '.screen[id^="plugin-"]');
                return screens.slice();
            },
        },
    };
    vm.runInNewContext(block, sandbox, { filename: 'wipe-block.js' });
    return sandbox;
}

test('plugin absent from the response keeps its settings + screen DOM', () => {
    const settings = makeEl('audio_engine');
    const screen = makeEl('audio_engine');
    runWipe({
        respondedIds: new Set(),               // partial response: plugin missing
        alreadyHydrated: new Set(),            // scan loop never saw it either
        settingsChildren: [settings],
        screens: [screen],
    });
    assert.equal(settings.removed, false, 'settings panel must survive a partial response');
    assert.equal(screen.removed, false, 'screen must survive a partial response');
});

test('plugin present in the response but not hydrated is wiped', () => {
    const settings = makeEl('stale_plugin');
    const screen = makeEl('stale_plugin');
    runWipe({
        respondedIds: new Set(['stale_plugin']),
        alreadyHydrated: new Set(),
        settingsChildren: [settings],
        screens: [screen],
    });
    assert.equal(settings.removed, true);
    assert.equal(screen.removed, true);
});

test('hydrated plugin present in the response is preserved', () => {
    const settings = makeEl('audio_engine');
    const screen = makeEl('audio_engine');
    runWipe({
        respondedIds: new Set(['audio_engine']),
        alreadyHydrated: new Set(['audio_engine']),
        settingsChildren: [settings],
        screens: [screen],
    });
    assert.equal(settings.removed, false);
    assert.equal(screen.removed, false);
});

test('junk DOM without a plugin id is still removed', () => {
    const junkSettings = makeEl(null);
    // Screen whose id strips to '' (no dataset.pluginId, bare "plugin-" id).
    const junkScreen = makeEl(null, 'plugin-');
    runWipe({
        respondedIds: new Set(['whatever']),
        alreadyHydrated: new Set(),
        settingsChildren: [junkSettings],
        screens: [junkScreen],
    });
    assert.equal(junkSettings.removed, true);
    assert.equal(junkScreen.removed, true);
});
