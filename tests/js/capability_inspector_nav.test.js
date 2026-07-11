const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN_LOADER_JS = path.join(ROOT, 'static', 'js', 'plugin-loader.js');
const MANIFEST = path.join(ROOT, 'plugins', 'capability_inspector', 'plugin.json');
const SCREEN_HTML = path.join(ROOT, 'plugins', 'capability_inspector', 'screen.html');
const SETTINGS_HTML = path.join(ROOT, 'plugins', 'capability_inspector', 'settings.html');

function source(file) {
    return fs.readFileSync(file, 'utf8');
}

function region(src, needle, length = 1800) {
    const start = src.indexOf(needle);
    assert.ok(start !== -1, `missing source needle: ${needle}`);
    return src.slice(start, start + length);
}

test('capability inspector manifest ships settings but no default nav entry', () => {
    const manifest = JSON.parse(source(MANIFEST));

    assert.equal(manifest.id, 'capability_inspector');
    assert.equal(manifest.nav, undefined);
    assert.equal(manifest.settings.html, 'settings.html');
});

test('capability inspector plugins menu entry is localStorage opt-in', () => {
    const src = source(PLUGIN_LOADER_JS);
    const helper = region(src, "const CAPABILITY_INSPECTOR_NAV_SETTING = 'capability_inspector.showInPluginsMenu'", 1400);
    const menu = region(src, 'const navPlugins = plugins.map', 1000);
    const contributions = region(src, 'async function _registerLegacyPluginUiContributions(plugin)', 1400);

    assert.match(helper, /localStorage\.getItem\(CAPABILITY_INSPECTOR_NAV_SETTING\)\s*===\s*['"]1['"]/);
    assert.match(helper, /if \(plugin\.id === ['"]capability_inspector['"]\)/);
    assert.match(helper, /return null/);
    assert.match(helper, /label:\s*['"]Capabilities['"]/);
    assert.match(menu, /_pluginNav\(plugin\)/);
    assert.match(contributions, /const nav = _pluginNav\(plugin\)/);
    assert.doesNotMatch(contributions, /if \(plugin\.nav\)/);
});

test('capability inspector settings toggles the plugins menu setting', () => {
    const html = source(SETTINGS_HTML);

    assert.match(html, /id="capability-inspector-show-nav"/);
    assert.match(html, /capability_inspector\.showInPluginsMenu/);
    assert.match(html, /localStorage\.setItem\(key, '1'\)/);
    assert.match(html, /localStorage\.removeItem\(key\)/);
    assert.match(html, /window\.loadPlugins\(\)/);
    assert.match(html, /window\.showScreen\('plugin-capability_inspector'\)/);
});

test('capability inspector screen ships scoped graph lane CSS', () => {
    const html = source(SCREEN_HTML);

    assert.match(html, /<style>/);
    assert.match(html, /\.capability-inspector \[data-domain-graph-fallback\]/);
    assert.match(html, /display: flex !important/);
    assert.match(html, /\.capability-inspector \[data-domain-provider-card\]/);
    assert.match(html, /\.capability-inspector \[data-domain-participant-lane\]/);
    assert.match(html, /flex: 0 0 24rem/);
    assert.match(html, /\.capability-inspector \[data-domain-graph-cy\]/);
    assert.match(html, /display: block !important/);
    assert.match(html, /\.capability-inspector \[data-endpoint-icon="command"\]/);
    assert.match(html, /background: #fb923c !important/);
    assert.match(html, /\.capability-inspector \[data-endpoint-icon="operation"\]/);
    assert.match(html, /background: #c084fc !important/);
    assert.match(html, /\.capability-inspector \[data-endpoint-flow="provider-operation"\]/);
    assert.match(html, /background: #d8b4fe !important/);
    assert.match(html, /\.capability-inspector \[data-toggle-graph-group\]/);
    assert.match(html, /gap: 0\.625rem !important/);
    assert.match(html, /\.capability-inspector \[data-graph-provider-endpoint-row\]/);
    assert.match(html, /\.capability-inspector \[data-graph-participant-endpoint-row\]/);
    assert.match(html, /\.capability-inspector \[data-role-icon\]/);
    assert.match(html, /\.capability-inspector \[data-origin-icon\]/);
    assert.match(html, /\.capability-inspector \[data-availability-icon\]/);
    assert.match(html, /width: 2\.125rem !important/);
    assert.match(html, /margin-left: 0\.5rem !important/);
    assert.match(html, /\.capability-inspector \[data-domain-owner-footer\]/);
    assert.match(html, /padding-top: 1rem !important/);
    assert.match(html, /\.capability-inspector \[data-domain-owner-description\]/);
    assert.match(html, /line-height: 1\.45 !important/);
    assert.match(html, /\.capability-inspector \[data-domain-graph-filter\]/);
    assert.match(html, /background: rgba\(31, 41, 55, 0\.72\) !important/);
    assert.match(html, /\.capability-inspector \[data-domain-graph-filter\]\[aria-pressed="true"\]/);
    assert.match(html, /background: rgba\(126, 34, 206, 0\.55\) !important/);
    assert.match(html, /\.capability-inspector \[data-legend-icon="command"\]/);
    assert.match(html, /background: #fb923c !important/);
    assert.match(html, /\.capability-inspector \[data-legend-line="shimmed"\]/);
    assert.match(html, /border-top: 2px dashed #9ca3af !important/);
    assert.match(html, /<div class="max-w-7xl mx-auto px-6 pt-24 pb-16 capability-inspector">/);
    assert.match(html, /data-inspector-header/);
    assert.match(html, /\.capability-inspector \[data-summary-dashboard\]/);
    assert.match(html, /width: 100% !important/);
    assert.match(html, /grid-template-columns: repeat\(4, minmax\(0, 1fr\)\) !important/);
    assert.match(html, /\.capability-inspector \[data-summary-card\]\[data-tone="clean"\]/);
    assert.match(html, /border-color: rgba\(52, 211, 153, 0\.55\) !important/);
    assert.match(html, /\.capability-inspector \[data-summary-status-value\]/);
    assert.match(html, /color: #34d399 !important/);
    assert.match(html, /\.capability-inspector \[data-graph-capability-port\]/);
    assert.match(html, /right: -1\.75rem/);
    assert.match(html, /\.capability-inspector \[data-graph-participant-port\]/);
    assert.match(html, /left: -1\.75rem/);
});
test('_navLabel resolves string, object, synthesized, and empty nav values', () => {
    const src = source(PLUGIN_LOADER_JS);
    const m = src.match(/function _navLabel\(nav, plugin\) \{[\s\S]*?\n\}/);
    assert.ok(m, 'could not extract _navLabel from app.js');
    const _navLabel = new Function(`${m[0]}; return _navLabel;`)();
    // String nav (manifest "nav": "Declared") must win over the plugin name.
    assert.equal(_navLabel('Declared', { name: 'Fallback', id: 'x' }), 'Declared');
    // Object nav with a label.
    assert.equal(_navLabel({ label: 'Capabilities' }, { name: 'Fallback', id: 'x' }), 'Capabilities');
    // Object nav without a label falls back to name then id.
    assert.equal(_navLabel({}, { name: 'My Plugin', id: 'x' }), 'My Plugin');
    assert.equal(_navLabel({}, { id: 'x' }), 'x');
    // Null / whitespace-only nav falls back too.
    assert.equal(_navLabel(null, { name: 'My Plugin' }), 'My Plugin');
    assert.equal(_navLabel('   ', { name: 'My Plugin' }), 'My Plugin');
});

test('plugin nav dropdown label uses the computed nav, not the raw plugin.nav', () => {
    const src = source(PLUGIN_LOADER_JS);
    // Regression guard for the string/synthesized-nav label fix: the dropdown
    // label must derive from the loop's computed nav via _navLabel, not from
    // plugin.nav?.label (which drops string and synthesized labels).
    assert.match(src, /const label = _navLabel\(nav, plugin\);/);
    assert.doesNotMatch(src, /const label = plugin\.nav\?\.label/);
});
