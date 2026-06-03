# Plugin Authoring Guide

Slopsmith's plugin system is the primary extension point. Each plugin lives in `plugins/<name>/` with a `plugin.json` manifest that declares the capability domains, UI contributions, settings metadata, diagnostics, and runtime files the plugin participates in.

This guide is the entry point. Each topic below has a dedicated doc — read what's relevant to what you're building.

## Quickstart

```text
plugins/my_plugin/
├── plugin.json          Manifest (required) — see docs/plugin-manifest.md
├── screen.html          Optional — UI declared through `ui` contributions
├── screen.js            Optional — hydrates declared frontend capabilities
├── routes.py            Optional — backend provider/requester implementation
├── settings.html        Optional — settings UI declared through `ui.settings`
└── requirements.txt     Optional — pip deps auto-installed on load
```

Start every plugin by describing its Slopsmith-facing behavior in the manifest with `standards: ["capability-pipelines.v1"]`, native `capabilities`, and redaction-safe `ui` metadata. A plugin with no app-facing behavior beyond metadata can still be this small:

```json
{
  "id": "my_plugin",
  "name": "My Plugin",
  "version": "0.1.0"
}
```

Capability declarations are the source of truth for diagnostics, the Capability Inspector, and plugin tooling. Treat missing capability metadata as an intentional exception for metadata-only or transitional plugin manifests.

## Topics

| Topic | Doc | When to read |
|---|---|---|
| **Manifest reference** | [plugin-manifest.md](plugin-manifest.md) | Field-by-field reference for `plugin.json`. Read first. |
| **Capability declarations** | [plugin-manifest.md#capabilities](plugin-manifest.md#capabilities) | Declaring provider/requester/observer intent with `capability-pipelines.v1`. |
| **Capability domains** | [capability-domains.md](capability-domains.md) | Active domains, planned domains, and promotion rules. |
| **Capability recipes** | [capability-recipes.md](capability-recipes.md) | Copyable manifest patterns for provider/requester/observer plugins. |
| **Visualization contracts** | [plugin-visualization-contracts.md](plugin-visualization-contracts.md) | Building a highway renderer (setRenderer), an overlay layer, or a note-state provider. |
| **Plugin styles** | [plugin-styles.md](plugin-styles.md) | Shipping a plugin-owned prebuilt stylesheet via `styles: "assets/plugin.css"`. |
| **Backend logging** | [plugin-logging.md](plugin-logging.md) | Plugin has a `routes.py`. Use `context["log"]`, never `print()`. |
| **Diagnostics contribution** | [plugin-diagnostics.md](plugin-diagnostics.md) | Adding plugin state to the Export Diagnostics bundle. |
| **Sibling Python imports** | [plugin-sibling-imports.md](plugin-sibling-imports.md) | Multi-file backend plugins. Use `context["load_sibling"]`. |
| **WebSocket protocol** | [websocket-protocol.md](websocket-protocol.md) | Plugins that read the highway stream directly. |
| **Testing plugins** | [testing-plugins.md](testing-plugins.md) | Conftest fixtures and Playwright patterns for plugin tests. |
| **Diagnostics bundle spec** | [diagnostics-bundle-spec.md](diagnostics-bundle-spec.md) | Existing in-depth spec — what's inside a diagnostics export. |
| **Sloppak format spec** | [sloppak-spec.md](sloppak-spec.md) | Existing in-depth spec — for plugins that read/write sloppaks. |

## General guidelines

- Wrap your plugin code in an IIFE: `(function () { 'use strict'; ... })();`
- Declare `standards: ["capability-pipelines.v1"]` and native `capabilities` for the plugin's Slopsmith-facing behavior.
- Use `ui` / `ui_contributions` for plugin-owned UI surfaces so the host can attribute them in diagnostics and support bundles.
- Use `localStorage` for user-facing settings, prefixed with your plugin id.
- Prefer native capability commands, events, and provider registration over private globals. If a domain you need is not active yet, document the gap in the PR instead of baking in a new private integration.

## Licensing for curated plugins

Plugins submitted for inclusion in the curated list must be AGPL-3.0 or AGPL-compatible (MIT, BSD, Apache-2.0). See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full policy. The `plugin.json` schema enforces this via the `license` field enum — see [plugin-manifest.md](plugin-manifest.md).
