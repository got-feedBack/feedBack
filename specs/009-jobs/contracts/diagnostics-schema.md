# Contract: Jobs Diagnostics Schema

## Schema

Jobs diagnostics are contributed under:

```json
{
  "schema": "slopsmith.jobs.diagnostics.v1"
}
```

The payload is included in browser diagnostics and the Capability Inspector. Export mode is redaction-safe by default. Local inspector mode may show user-visible labels that are already present in the UI, but must still avoid raw paths, tokens, command lines, handles, and artifacts.

## Top-Level Shape

```json
{
  "schema": "slopsmith.jobs.diagnostics.v1",
  "generatedAt": "2026-05-31T00:00:00.000Z",
  "providers": [],
  "selectedProviders": [],
  "jobs": {
    "active": [],
    "queued": [],
    "paused": [],
    "recentTerminal": []
  },
  "outcomes": [],
  "bridgeHits": [],
  "limits": {
    "terminalJobsRetained": 5,
    "perJobHistoryLimit": 50,
    "snapshotBudgetBytes": 65536
  },
  "notes": []
}
```

## Provider Summary

```json
{
  "providerId": "provider-1",
  "pluginId": "sloppak_converter",
  "label": "Sloppak Converter",
  "jobTypes": ["conversion.sloppak"],
  "actions": ["enqueue", "cancel", "retry"],
  "availability": "available",
  "capacity": { "maxRunning": 1, "maxQueued": 10 },
  "currentLoad": { "running": 0, "queued": 1 },
  "recoverySupport": { "queued": true, "running": false, "paused": false },
  "safeReason": null,
  "lastSeenAt": "2026-05-31T00:00:00.000Z"
}
```

## Job Summary

```json
{
  "jobId": "job-1",
  "jobType": "conversion.sloppak",
  "providerId": "provider-1",
  "requesterId": "core.user",
  "targetRef": "target-1",
  "state": "running",
  "priority": "user-approved-interactive",
  "safeLabel": "Conversion job",
  "progress": {
    "mode": "determinate",
    "percent": 42,
    "step": "convert",
    "message": "Converting arrangement data",
    "updatedAt": "2026-05-31T00:00:00.000Z"
  },
  "actionsAvailable": ["cancel"],
  "retryable": false,
  "attempts": [{ "attemptId": "attempt-1", "attemptNumber": 1, "state": "running" }],
  "safeReason": null,
  "timestamps": {
    "createdAt": "2026-05-31T00:00:00.000Z",
    "queuedAt": "2026-05-31T00:00:00.000Z",
    "startedAt": "2026-05-31T00:00:01.000Z",
    "updatedAt": "2026-05-31T00:00:02.000Z",
    "terminalAt": null
  },
  "history": []
}
```

## Outcome Summary

```json
{
  "seq": 1,
  "operation": "enqueue",
  "jobId": "job-1",
  "providerId": "provider-1",
  "requesterId": "core.user",
  "status": "queued",
  "category": null,
  "safeReason": null,
  "timestamp": "2026-05-31T00:00:00.000Z"
}
```

## Bridge Hit

```json
{
  "bridgeId": "jobs.legacy-sloppak-queue",
  "legacySurface": "plugin-queue",
  "pluginId": "sloppak_converter",
  "operation": "enqueue",
  "jobId": "job-1",
  "providerId": "provider-1",
  "timestamp": "2026-05-31T00:00:00.000Z",
  "safeReason": "legacy queue observed"
}
```

## Retention Rules

- Preserve all active, queued, paused, and cancellation-requested jobs.
- Preserve at least five most recent terminal jobs when available.
- Cap per-job progress/log history at 50 entries unless the support snapshot budget requires stricter trimming.
- Trim oldest terminal jobs and oldest per-job history first.
- Never trim active job identity, current state, current progress, current action availability, or latest terminal outcome.

## Redaction Rules

Diagnostics must not include:

- unredacted local paths or raw filenames when sensitive
- secret-bearing URLs, tokens, cookies, API keys, or environment values
- raw command lines or subprocess invocation details
- raw media files, converted artifacts, downloaded payloads, recordings, audio buffers, waveform/sample data
- subprocess handles, native handles, browser handles, or plugin-private objects
- provider-private request payloads or unreviewed artifacts

Diagnostics may include:

- provider id and plugin id
- safe job type
- pseudonymous target ids
- bounded safe labels and reasons
- failure categories
- retryability and action availability
- bridge ids and legacy surface categories
