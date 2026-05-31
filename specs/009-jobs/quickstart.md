# Quickstart: Jobs Control Plane

## Purpose

Use this quickstart to validate the jobs control-plane slice during implementation. The feature promotes `jobs` into an active privileged provider-coordinator domain for long-running conversion, import, update, preview, and studio work.

## Expected Files

Planned implementation surface:

- `static/capabilities/jobs.js` - jobs domain owner, provider registry, scheduling, state, diagnostics, bridge hits.
- `static/capabilities.js` - promote `jobs` from reserved to active domain metadata and add any domain outcomes not already supported.
- `static/index.html` - load the jobs capability host after the capability runtime.
- `plugins/capability_inspector/screen.js` - render jobs providers, active jobs, recent terminal jobs, progress, outcomes, and bridge hits.
- `docs/capability-domains.md` - document jobs commands/events/provider migration.
- `docs/capability-roadmap.md` - mark jobs slice status and removal gates.
- `docs/capability-safety-matrix.md` - mark jobs as active privileged provider-coordinator.
- `docs/capability-recipes.md` - add provider/requester recipe.
- `tests/js/jobs_*.test.js` - domain, scheduling, diagnostics, compatibility, and inspector tests.

## Manual Validation Scenarios

### 1. Provider Registration

1. Register a fake jobs provider with one job type and capacity 1.
2. Inspect jobs providers.
3. Confirm one provider appears with safe label, actions, availability, capacity, and current load.
4. Re-register the same provider repeatedly.
5. Confirm it updates in place and does not duplicate.

### 2. User-Approved Enqueue

1. Dispatch a privileged enqueue with `authorization: user-action`.
2. Confirm the job enters queued or running state.
3. Send progress updates.
4. Confirm `list` and `inspect` show current state, step, progress, requester, provider, and action availability.
5. Complete the job.
6. Confirm the job becomes terminal and remains in recent terminal diagnostics.

### 3. Approval Boundary

1. Dispatch a privileged enqueue from a background requester with no user action.
2. Confirm the command returns denied or user-action-required.
3. Confirm no provider work starts.
4. Retry a failed job with the same provider, job type, target, requester, and inputs when provider declared retry support.
5. Confirm retry is accepted as approved continuation.
6. Change provider, job type, target, requester, or inputs and confirm new approval is required.

### 4. Provider Selection

1. Register exactly one compatible provider for a job type.
2. Enqueue without explicit provider and confirm it proceeds.
3. Register a second compatible provider.
4. Enqueue without selected/default provider and confirm provider-selection-required.
5. Select/default one provider and confirm enqueue proceeds through that provider.

### 5. Scheduling

1. Set provider capacity to one running job.
2. Enqueue a background/maintenance job.
3. Enqueue a user-approved interactive job before capacity opens.
4. Complete the running job or release capacity.
5. Confirm user-approved interactive job starts before background/maintenance work.
6. Confirm FIFO order within each priority.

### 6. Cancellation / Pause / Resume / Retry

1. Cancel a queued job and confirm it never starts.
2. Cancel a running job and confirm cancellation-requested appears before provider terminal result.
3. Pause a supported running job and confirm same job identity enters paused.
4. Resume it and confirm it returns to queued/running.
5. Retry a retryable failed job and confirm a linked attempt is created.

### 7. Reload Recovery

1. Simulate reload with a provider-recoverable queued/running/paused job.
2. Confirm it restores according to provider recovery metadata.
3. Simulate reload with a non-recoverable non-terminal job.
4. Confirm it becomes orphaned or provider-unavailable with safe reason.

### 8. Diagnostics Redaction

1. Force provider logs and reasons that include local paths, raw filenames, command lines, tokens, URLs, and raw artifact-like strings.
2. Export or inspect diagnostics.
3. Confirm exported jobs diagnostics preserve all active jobs, at least five recent terminal jobs, and no more than 50 progress/log entries per job.
4. Confirm sensitive data is redacted and no handles/artifacts/private payloads are present.

### 9. Compatibility Bridge Hits

1. Exercise a legacy plugin queue or status route while the jobs domain is active.
2. Record a bridge hit.
3. Confirm diagnostics show bridge id, plugin, operation, and safe reason.
4. Confirm native and compatibility-backed representations of the same logical job do not duplicate user-visible jobs.

## Suggested Validation Commands

```bash
node --check static/capabilities.js
node --check static/capabilities/jobs.js
node --check plugins/capability_inspector/screen.js
npm run test:js
```

If backend diagnostics, plugin loading, or redaction helpers are touched:

```bash
uv run pytest tests/test_diagnostics_bundle.py tests/test_diagnostics_redact.py tests/test_plugins.py tests/test_plugin_runtime_idempotence.py -q
```

For a browser smoke after UI wiring:

```bash
PYTHONPATH=lib:. uv run uvicorn server:app --host 127.0.0.1 --port 8000
npm test -- tests/browser/check-errors.spec.ts
```

## Out Of Scope Checks

During review, confirm this slice does not implement or redefine:

- media import/export file semantics
- plugin install/update trust and rollback policy
- external service trust policy
- recording capture or take storage
- audio-effects processing, model loading, or IR inventory
- backend route privilege review

Those workflows may submit/report jobs, but their own trust and data contracts belong to later specs.
