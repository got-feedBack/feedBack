# Implementation Plan: Jobs Control Plane

**Branch**: `009-jobs` | **Date**: 2026-05-31 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/009-jobs/spec.md`

## Summary

Promote long-running conversion, import, update, preview, and studio work into a first-class `jobs` capability domain. The implementation adds a privileged provider-coordinator host that owns provider registration, enqueue/list/inspect actions, cancellation, pause/resume, retry, scheduling, reload recovery state, compatibility bridge accounting, and redaction-safe diagnostics. Providers keep ownership of the actual work and private payloads; the jobs domain exposes safe state, outcomes, progress, and failure categories through the existing capability runtime and Capability Inspector.

## Technical Context

**Language/Version**: Vanilla JavaScript in the source-served frontend; Python 3.12/FastAPI only if existing diagnostics, plugin loading, or backend route attribution surfaces are touched  
**Primary Dependencies**: Existing `window.slopsmith` event bus, `static/capabilities.js` (`capability-pipelines.v1`), browser diagnostics contribution pattern, Capability Inspector, plugin manifest/runtime capability registration, `localStorage` for selected/default provider preference when available  
**Storage**: In-memory jobs provider registry, selected/default provider preference, active/queued/paused/recent terminal job state, bounded per-job progress/log history, bridge hits, and recent outcomes; browser persistence is limited to user-selected/default provider choices and redaction-safe provider-declared recoverable job references so reload can restore only explicitly recoverable queued/running/paused jobs; no raw provider payloads, non-recoverable active job state, or new database schema in this slice  
**Testing**: `node --check`; focused Node JS tests under `tests/js/` for jobs domain, scheduling, compatibility bridges, diagnostics redaction/retention, reload recovery, cancellation/retry behavior, and inspector rendering; focused pytest diagnostics/plugin tests only if backend diagnostics, redaction, or plugin loading changes; focused Playwright/browser smoke for console errors after inspector/runtime wiring  
**Target Platform**: Self-hosted single-user Slopsmith browser app served by Docker or local dev server, with optional desktop/native/plugin providers reporting jobs through the same safe control plane  
**Project Type**: Vanilla web app with FastAPI backend and plugin runtime  
**Performance Goals**: `list`/`inspect` and command outcomes return within 1 second in focused validation; determinate progress and state changes appear in diagnostics/inspector within 1 second; scheduler never starts more jobs than provider-declared capacity; diagnostics remain within the existing capability snapshot budget  
**Constraints**: No frontend framework/build step; no new auth, tenant model, mandatory env var, host path, database, or backend service; privileged enqueue requires explicit user action or approved continuation scope; exported diagnostics must not expose raw local paths, command lines, tokens, raw artifacts, media buffers, recordings, subprocess/native/browser handles, or provider-private payloads  
**Scale/Scope**: Single local user, multiple providers/plugins in one browser session, one shared jobs domain, provider-declared capacity limits, all active jobs retained, at least five recent terminal jobs retained, and no more than 50 progress/log entries per job unless snapshot budget trims harder

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Result | Notes |
|-----------|--------|-------|
| I. Self-Hosted, Single-User, Docker-First | PASS | No multi-user model, auth, mandatory env var, required host path, external service, or deployment dependency is introduced. Jobs coordinate local/provider work only. |
| II. Vanilla Frontend - No Frameworks | PASS | Plan uses source-served JavaScript, existing globals, existing capability/event modules, and existing DOM inspector surfaces only. |
| III. Plugins Are the Extension Point | PASS | Providers keep ownership of conversion/import/update/preview/studio work. Core coordinates the shared jobs control plane and compatibility accounting. |
| IV. Backwards-Compatible CDLC Library | PASS | The feature does not alter sloppak formats, DLC scan behavior, arrangement ids, or highway WebSocket payloads. Jobs that mutate files require explicit user approval. |
| V. Pure-Function Core Libraries, Tested | PASS | No new Python library architecture is required. Any backend helper changes, if needed, must remain side-effect-light and covered by focused pytest. |
| VI. Observability Over Chattiness | PASS | The slice improves observability through bounded job state, outcomes, bridge hits, progress, and redaction-safe diagnostics without raw payloads. |
| VII. Versioned, Migration-Aware Settings | PASS | No settings import/export schema change is required. Optional selected/default provider preference is local and migration-safe. |

## Project Structure

### Documentation (this feature)

```text
specs/009-jobs/
|-- plan.md
|-- research.md
|-- data-model.md
|-- quickstart.md
|-- checklists/
|   `-- requirements.md
|-- contracts/
|   |-- jobs-control-plane.md
|   |-- diagnostics-schema.md
|   |-- migration-notes.md
|   `-- testing-contract.md
`-- tasks.md              # Created later by /speckit-tasks
```

### Source Code (repository root)

```text
static/
|-- capabilities.js                   # Existing dispatch/outcome/diagnostics primitives; promote jobs active metadata/outcomes as needed
|-- capabilities/
|   `-- jobs.js                       # New jobs provider-coordinator host, state, scheduler, diagnostics, bridge hits
`-- index.html                        # Load jobs capability after capability runtime

plugins/
`-- capability_inspector/screen.js    # Surface providers, active/queued/paused/recent jobs, progress, actions, outcomes, bridges

docs/
|-- capability-domains.md             # Jobs commands/events/provider migration guidance
|-- capability-recipes.md             # Provider/requester recipe for jobs
|-- capability-roadmap.md             # 009 migration status and bridge removal gates
`-- capability-safety-matrix.md       # Jobs active privileged provider-coordinator row

tests/
|-- js/
|   |-- jobs_domain.test.js
|   |-- jobs_scheduling.test.js
|   |-- jobs_diagnostics.test.js
|   |-- jobs_compat.test.js
|   |-- jobs_test_harness.js
|   `-- capability_inspector_render.test.js
`-- browser/
    `-- check-errors.spec.ts          # Focused smoke if visible inspector/runtime wiring changes
```

**Structure Decision**: Add `static/capabilities/jobs.js` as the domain owner/coordinator and keep actual long-running work inside providers. The jobs host stores safe state, enforces approval/scheduling rules, normalizes provider updates, emits lifecycle events, records bridges, contributes diagnostics, and feeds the Capability Inspector. Backend routes, media import/export semantics, plugin install/update policy, external-service trust, recording, and audio-effects processing remain out of scope except for safe job summaries.

## Complexity Tracking

No constitutional violations are introduced. No complexity exceptions are required.

## Phase 0: Research Summary

See [research.md](research.md). Key decisions:

- Implement `jobs` as a privileged provider-coordinator capability domain.
- Keep actual work provider-owned and expose only redaction-safe job state.
- Require explicit user approval for privileged enqueue scope.
- Auto-select only when exactly one compatible provider exists; otherwise use selected/default provider or return `provider-selection-required`.
- Schedule user-approved interactive jobs before background/maintenance jobs, FIFO within each priority and provider capacity.
- Treat cancellation as requested until the provider reports a terminal state.
- Restore only jobs with provider-declared recovery support after reload.
- Bound diagnostics to all active jobs, at least five recent terminal jobs, and capped per-job history.
- Use compatibility bridge hits for legacy queues and job-like route flows.

## Phase 1: Design Summary

Design artifacts created:

- [data-model.md](data-model.md) defines job providers, requesters, approval scopes, selected providers, jobs, attempts, scheduling policies, progress snapshots, terminal outcomes, diagnostic logs, bridge hits, validation rules, and state transitions.
- [contracts/jobs-control-plane.md](contracts/jobs-control-plane.md) defines the jobs domain commands, provider metadata, provider operations, lifecycle events, approval rules, provider selection, scheduling, cancellation, pause/resume, retry, and bridge accounting.
- [contracts/diagnostics-schema.md](contracts/diagnostics-schema.md) defines exported/local diagnostics payloads, retention limits, redaction rules, provider summaries, job summaries, outcomes, and bridge hits.
- [contracts/migration-notes.md](contracts/migration-notes.md) defines native provider migration, compatibility bridges, provider adoption examples, removal gates, and out-of-scope privileged domains.
- [contracts/testing-contract.md](contracts/testing-contract.md) defines validation scenarios for providers, enqueue, scheduling, progress, terminal states, cancel/pause/resume/retry, reload recovery, diagnostics, compatibility, and inspector rendering.
- [quickstart.md](quickstart.md) defines manual validation flows and representative commands.

## Post-Design Constitution Check

| Principle | Result | Notes |
|-----------|--------|-------|
| I. Self-Hosted, Single-User, Docker-First | PASS | Design remains local/single-user and adds no deployment input. |
| II. Vanilla Frontend - No Frameworks | PASS | Runtime and inspector changes stay in source-served JS and existing DOM/CSS. |
| III. Plugins Are the Extension Point | PASS | Plugins/providers own real work; core owns coordination and diagnostics. |
| IV. Backwards-Compatible CDLC Library | PASS | Song formats, DLC files, and existing playback/library contracts remain stable. File-mutating jobs require user approval. |
| V. Pure-Function Core Libraries, Tested | PASS | No Python core library change is required by the design; any touched helpers remain focused and testable. |
| VI. Observability Over Chattiness | PASS | Diagnostics distinguish provider, job type, state, progress, retryability, failure category, bridges, and outcomes without raw privileged data. |
| VII. Versioned, Migration-Aware Settings | PASS | No settings schema change; optional selected/default provider preference can be stored as normal client preference and is not a backup schema. |
