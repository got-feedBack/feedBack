# Contract: Jobs Migration Notes

## Migration Goal

Move plugin-specific long-running work into the shared `jobs` domain without breaking existing plugin queues, status screens, or backend routes during the transition.

## Native Provider Pattern

A migrated plugin should:

1. Declare the `jobs` domain in its manifest as a provider/requester as appropriate.
2. Register a native job provider after hydration.
3. Report supported job types, actions, availability, capacity, and recovery support.
4. Accept public jobs commands only through the jobs control plane.
5. Emit or report progress, log, completion, cancellation, failure, retryability, and recovery state through normalized provider operations.
6. Keep actual artifacts, file paths, command lines, downloads, subprocess handles, and plugin-private state inside the provider.

## Compatibility Bridge Pattern

Existing plugin queues and status screens remain allowed during migration. Core or the plugin should record a bridge hit when a legacy queue, status surface, or job-like route is used.

Recommended bridge ids:

- `jobs.legacy-plugin-queue`
- `jobs.legacy-status-screen`
- `jobs.legacy-backend-route`
- `jobs.legacy-progress-poll`
- `jobs.legacy-update-flow`

A compatibility bridge may create or update a diagnostic job summary only when it can identify a logical job without exposing private payloads. If a native provider describes the same logical job, the native provider owns the user-visible job and the compatibility record remains diagnostics-only.

## Provider Adoption Examples

### Sloppak Converter

- Job types: conversion and optional stem-prep coordination.
- Expected actions: enqueue, inspect, cancel when supported, retry when inputs are unchanged.
- Bridge sources: existing converter queue UI and backend conversion routes.

### Tab/Profile Import

- Job types: import and validation.
- Expected actions: enqueue, inspect, cancel before start, retry failed validation/import when safe.
- Bridge sources: plugin-specific import routes and status screens.

### Update Manager / Plugin Manager

- Job types: update check, download, install, rollback coordination.
- Expected actions: enqueue, inspect, cancel during safe phases, retry failed downloads.
- Extra care: plugin install/update policy and external-service trust remain outside this slice; jobs records only safe state and outcome summaries.

### Studio / Preview Work

- Job types: preview generation, render, analysis, studio processing.
- Expected actions: enqueue, inspect, cancel, pause/resume only when provider can safely preserve state.
- Extra care: recording and audio processing semantics remain outside this slice.

## Removal Gates

Legacy job bridges can be removed only when:

1. Bundled providers use native `jobs` registration for normal queue/progress/cancel/retry flows.
2. Normal conversion, import, update, preview, and studio smoke runs show no unexpected bridge hits.
3. Provider rehydration does not duplicate providers, active jobs, terminal jobs, or status listeners.
4. Privileged enqueue without explicit user approval returns denied or user-action-required before work begins.
5. Provider-selection-required is observable when multiple compatible providers lack selected/default choice.
6. Scheduling tests show user-approved interactive jobs before background/maintenance jobs and FIFO within priority.
7. Reload tests show only provider-recoverable jobs restored; other non-terminal jobs become orphaned or provider-unavailable with safe reasons.
8. Diagnostics contain no unredacted paths, tokens, command lines, raw artifacts, media data, native handles, subprocess handles, or provider-private payloads.

## Out Of Scope During Migration

The jobs domain does not define:

- media import/export file semantics
- plugin installation trust or rollback policy
- external service endpoint trust rules
- recording capture or take storage semantics
- audio-effects processing, model loading, or IR inventory
- backend route privilege review

Those domains may use jobs state later, but they should not hide their own trust and data contracts inside this slice.
