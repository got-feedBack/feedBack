# Capability Authoring Recipes

Use these examples as small manifest fragments when migrating plugin-facing integrations to capability pipelines. The capability model is system-wide; these recipes focus on plugin manifests because core-owned domains are registered by Slopsmith itself. Each example is intentionally complete enough to pass the loader contract in [plugin-manifest.schema.json](plugin-manifest.schema.json).

> **Self-hosted CSS?** If your plugin uses Tailwind classes core doesn't ship (notably arbitrary values like `text-[11px]`), declare a `styles` key and bundle your own preflight-off stylesheet — see [plugin-styles.md](plugin-styles.md). That is separate from the capability-pipeline recipes below.

## Owner And Provider

A plugin that owns a domain and handles commands declares `owner` and `provider`. Use this for a single canonical implementation in a plugin-owned domain, such as a future stem-control capability.

```json
{
  "id": "stems",
  "name": "Stems",
  "standards": ["capability-pipelines.v1", "plugin-runtime-idempotent.v1"],
  "capabilities": {
    "stems": {
      "roles": ["owner", "provider"],
      "commands": ["mute", "restore", "inspect"],
      "events": ["claim:created", "claim:released", "stems.ready"],
      "mode": "active",
      "compatibility": "none",
      "ownership": "exclusive-owner",
      "safety": "safe",
      "version": 1
    }
  }
}
```

## Requester And Observer

A plugin that requests work from another domain and listens for lifecycle events declares `requester` and `observer`.

```json
{
  "id": "example_requester",
  "name": "Example Requester",
  "standards": ["capability-pipelines.v1", "plugin-runtime-idempotent.v1"],
  "capabilities": {
    "example.plugin-domain": {
      "roles": ["requester", "observer"],
      "commands": ["apply", "restore", "inspect"],
      "events": ["claim:created", "claim:released", "example.manual-override"],
      "mode": "active",
      "compatibility": "none",
      "ownership": "requester-only",
      "safety": "safe",
      "version": 1
    }
  }
}
```

## Observer Only

A plugin that only reads public events should declare `observer` and no command handlers. In PR1, this is most useful for participants that observe the delivered `library` workflow; future plugin-owned domains can use the same pattern once promoted.

```json
{
  "id": "practice_hud",
  "name": "Practice HUD",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "example.plugin-domain": {
      "roles": ["observer"],
      "commands": [],
      "events": ["claim:created", "claim:released", "example.manual-override"],
      "mode": "active",
      "compatibility": "degrade-noop",
      "ownership": "observer-only",
      "safety": "safe",
      "version": 1
    }
  }
}
```

## Library Provider

A plugin that registers a remote client or generated library source declares itself as a `library` provider. The backend registration call is still made from `routes.py` with `context["register_library_provider"](...)`; the native browser library capability turns the provider registry into runtime provider participants. A thin server wrapper that only exposes the local library over HTTP should not declare `library` as a provider unless it also registers a provider in the library registry.

```json
{
  "id": "remote_library_client",
  "name": "Remote Library Client",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "library": {
      "roles": ["provider"],
      "operations": ["query-page", "query-artists", "query-stats", "tuning-names", "get-art", "sync-song"],
      "mode": "active",
      "compatibility": "none",
      "safety": "safe",
      "version": 1
    }
  }
}
```

## Library Requester And Observer

A route-only wrapper that uses the library capability without registering a browsable provider declares requester/observer intent instead of provider ownership. This is a generic manifest shape for external plugins to adopt in their own repositories; it does not make the wrapper part of this PR's delivered domain set.

```json
{
  "id": "library_route_wrapper",
  "name": "Library Route Wrapper",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "library": {
      "roles": ["requester", "observer"],
      "requests": ["list-providers", "get-current", "inspect"],
      "observes": ["providers-refreshed", "source-changed"],
      "description": "Uses the library source list through its own route surface without registering a provider.",
      "mode": "active",
      "compatibility": "none",
      "safety": "safe",
      "version": 1
    }
  }
}
```

## Audio Mix Fader Provider

Existing plugins can keep using `window.slopsmith.audio.registerFader(spec)` while migrating. The compatibility bridge records the fader as an `audio-mix` participant. New bundled code should prefer a native participant declaration plus the audio-session helper once available in its integration point.

```json
{
  "id": "delay_fx",
  "name": "Delay FX",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "audio-mix": {
      "roles": ["provider"],
      "operations": ["fader.get-value", "fader.set-value"],
      "events": ["fader-value-changed", "fader-unavailable"],
      "mode": "active",
      "compatibility": "none",
      "safety": "safe",
      "version": 1
    }
  }
}
```

Native audio-mix fader providers should register a stable participant id and fader id, return the committed value from every set operation, and settle get/set operations within two seconds. The player mixer displays the committed value rather than the raw requested value. If the fader is temporarily unavailable, keep the participant registered with unavailable/disabled state so the mixer can render a disabled control and diagnostics can explain why it cannot be changed.

## Audio Input And Monitoring Requester

Plugins that need live instrument input declare requester/observer intent and let the host expose redaction-safe source identity. Diagnostics must not contain raw device labels, stable hardware ids, or audio buffers.

```json
{
  "id": "note_detect",
  "name": "Note Detect",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "audio-input": {
      "roles": ["requester", "observer"],
      "requests": ["inspect", "list-sources", "select-source", "open-source", "close-source"],
      "observes": ["source-registered", "source-selected", "source-opened", "source-open-degraded", "source-closed", "permission-denied"],
      "mode": "active",
      "compatibility": "none",
      "ownership": "requester-only",
      "safety": "sensitive",
      "version": 1
    },
    "audio-monitoring": {
      "roles": ["requester", "observer"],
      "requests": ["inspect", "list-providers", "select-provider", "start", "stop", "set-direct-monitor"],
      "observes": ["provider-registered", "provider-selected", "provider-selection-required", "monitoring-started", "monitoring-degraded", "monitoring-unavailable", "monitoring-failed", "monitoring-denied", "monitoring-stopped", "direct-monitor-changed"],
      "mode": "active",
      "compatibility": "none",
      "ownership": "requester-only",
      "safety": "sensitive",
      "version": 1
    }
  }
}
```

Requesters should list or inspect sources before opening them. `inspect`, `list-sources`, and `select-source` are prompt-free and must not call provider enumeration or open live input. When a requester needs audio, it dispatches `open-source` with a purpose and required channel shape. The requester identity is taken from the dispatch `source` (the authenticated caller) — a payload-supplied `requesterId` is ignored, so a requester cannot spoof another's identity or release a shared session it does not own. Compatible requesters share one open session; each requester later dispatches `close-source`, and the provider is closed only after the last requester releases it.

```js
const api = window.slopsmith.capabilities;
await api.dispatch({ capability: 'audio-input', command: 'select-source', source: 'user', payload: { logicalSourceKey: 'browser:instrument:primary' } });
const opened = await api.dispatch({
  capability: 'audio-input',
  command: 'open-source',
  source: 'note_detect', // identity for the open session; payload requesterId is ignored
  payload: { purpose: 'note-detection', requiredChannelShape: 'mono' },
});
// Keep provider-owned streams/nodes private. Diagnostics receive only opened.payload summaries.
await api.dispatch({ capability: 'audio-input', command: 'close-source', source: 'note_detect', payload: { openSessionId: opened.payload.openSessionId } });
```

Monitoring is a separate lifecycle layered on top of input readiness. A fresh live monitoring start must come from an explicit user action; background requesters can attach only when an already-active compatible session exists.

```js
const monitoring = await api.dispatch({
  capability: 'audio-monitoring',
  command: 'start',
  source: 'note_detect',
  payload: {
    authorization: 'user-action',
    requiredChannelShape: 'mono',
    directMonitorRequirement: 'muted'
  },
});

if (monitoring.outcome === 'user-action-required') {
  // Show your own UI affordance; do not trigger a device prompt in the background.
}

await api.dispatch({
  capability: 'audio-monitoring',
  command: 'stop',
  source: 'note_detect',
  payload: { monitoringId: monitoring.payload && monitoring.payload.monitoringId },
});
```

## Audio Input Provider

Native input providers register redaction-safe source summaries with stable logical keys. Use `source.enumerate` only for an explicit user/provider discovery action; normal list/inspect/select flows should use already-registered summaries.

```json
{
  "id": "desktop_audio",
  "name": "Desktop Audio",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "audio-input": {
      "roles": ["provider", "observer"],
      "operations": ["source.enumerate", "source.open", "source.close"],
      "events": ["source-registered", "source-opened", "source-closed", "source-open-degraded", "permission-denied"],
      "mode": "active",
      "compatibility": "none",
      "safety": "sensitive",
      "version": 1
    }
  }
}
```

Provider source records should include `sourceId`, `providerId`, `logicalSourceKey`, `kind`, safe label or diagnostics pseudonym, availability, `channelSummary`, and supported operations/handlers. Do not put browser `MediaStream`, `AudioNode`, native handles, buffers, samples, waveform data, raw device labels, stable hardware ids, paths, or secrets in returned payloads; keep those in provider-private state.

## Audio Monitoring Provider

Native monitoring providers register a stable `logicalMonitoringKey` and keep actual audio streams, native handles, and device labels provider-private. The core host coordinates selected provider, requester sharing, direct-monitor policy, and diagnostics, but the provider owns the actual live monitor graph.

```json
{
  "id": "desktop_audio",
  "name": "Desktop Audio",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "audio-monitoring": {
      "roles": ["provider", "observer"],
      "operations": ["monitoring.start", "monitoring.stop", "monitoring.status", "monitoring.set-direct-monitor"],
      "events": ["provider-registered", "monitoring-started", "monitoring-stopped", "direct-monitor-changed"],
      "mode": "active",
      "compatibility": "none",
      "safety": "sensitive",
      "version": 1
    }
  }
}
```

Provider records should include `providerId`, `logicalMonitoringKey`, safe label or diagnostics pseudonym, `availability`, `sourceMode`, supported operations, `directMonitor` summary, and `latencySummary`. `monitoring.start` receives a redaction-safe `sourceRef`, `requesterId`, `requiredChannelShape`, `directMonitorPreference`, and optional `directMonitorRequirement`; it should return only status summaries such as active/degraded/denied/unavailable/failed. `monitoring.status` must be prompt-free and must not open audio input. `monitoring.set-direct-monitor` may apply the user's preference for active sessions; requester requirements must never mutate the user's stored preference.

## Stems Provider Behind Audio Session Coordination

The Stems plugin remains the provider/owner of actual stem playback state. `core.audio.session` coordinates dispatch, claims, overrides, orphan detection, and diagnostics, but it does not replace the provider.

```json
{
  "id": "stems",
  "name": "Stems",
  "standards": ["capability-pipelines.v1", "plugin-runtime-idempotent.v1"],
  "capabilities": {
    "stems": {
      "roles": ["owner", "provider"],
      "commands": ["mute", "restore", "inspect"],
      "operations": ["stem.get-state", "stem.apply-automation", "stem.restore-automation"],
      "events": ["owner-available", "automation-applied", "automation-restored", "automation-overridden", "claim-orphaned"],
      "mode": "active",
      "compatibility": "none",
      "ownership": "exclusive-owner",
      "safety": "safe",
      "version": 1
    }
  }
}
```

## Playback Requester And Observer

Plugins that need to inspect or coordinate song transport declare `playback` requester/observer intent and use the capability dispatch surface. Raw media handles stay private to core; diagnostics expose only pseudonymous targets, sanitized timing, route, loop, requester, observer, and recent outcome summaries.

```json
{
  "id": "practice_hud",
  "name": "Practice HUD",
  "standards": ["capability-pipelines.v1"],
  "capabilities": {
    "playback": {
      "roles": ["requester", "observer"],
      "requests": ["inspect", "pause", "resume", "seek", "set-loop", "clear-loop"],
      "observes": ["ready", "started", "paused", "resumed", "seeking", "seeked", "stopped", "loop-set", "loop-cleared"],
      "mode": "active",
      "compatibility": "none",
      "ownership": "requester-only",
      "safety": "safe",
      "version": 1
    }
  }
}
```

Fresh audible starts require a user action. Background plugins should call `inspect` first and attach to an existing compatible session; if a plugin needs to offer a play/start action, wire it to a visible user gesture and pass `authorization: "user-action"`.

```js
const api = window.slopsmith.capabilities;

const state = await api.dispatch({
  capability: 'playback',
  command: 'inspect',
  source: 'practice_hud',
  args: {},
});

if (state.status !== 'idle') {
  await api.dispatch({
    capability: 'playback',
    command: 'seek',
    source: 'practice_hud',
    args: { time: 42.0, reason: 'practice segment jump' },
  });
}
```

## Future Expansion Domains

Some domain names are reserved for expected future contracts, but they are not registered in the runtime graph yet. For example, `ui.player-panels` is documented as a likely panel-host surface, but Slopsmith does not currently expose a capability command for panel contributions. See [capability-roadmap.md](capability-roadmap.md) for the PR1 domain set and deferred-domain checklist.

Do not declare future expansion domains until the corresponding host workflow ships. For current integrations, use active domains such as `library`, `playback`, `audio-mix`, `audio-input`, `audio-monitoring`, or `stems` intent matching the recipes above.

Invalid capability metadata is excluded from the capability graph. The `library` workflow is native in PR1 and does not use compatibility shim metadata. Unsupported `capability-pipelines` versions are reported as incompatible and their runtime handlers must not execute.
