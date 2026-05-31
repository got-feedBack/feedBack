# Contract: Jobs Testing

## Static And Syntax Checks

- Validate new source-served JavaScript with `node --check`.
- Keep new capability host code runnable in Node test harnesses without a browser-only dependency.
- Validate docs and contracts have no unresolved `NEEDS CLARIFICATION` markers.

## Unit / Node Scenarios

### Provider Registration

- Register one provider and inspect provider metadata.
- Re-register the same provider five times and confirm one provider record remains.
- Register incompatible provider version and confirm it is visible but cannot accept jobs.
- Register unavailable/degraded provider and inspect safe reason.

### Enqueue And State

- Enqueue user-approved job with one compatible provider and confirm `queued` or `running` outcome.
- Enqueue without provider when no provider exists and confirm `no-owner` or `unavailable`.
- Enqueue invalid parameters and confirm `validation-failed` before provider work starts.
- Enqueue privileged background job without approval and confirm denied/user-action-required before provider work starts.
- Enqueue with multiple compatible providers and no selected/default provider and confirm `provider-selection-required`.

### Scheduling

- Provider capacity prevents overrun.
- User-approved interactive jobs start before background/maintenance jobs for same provider capacity.
- FIFO order is preserved within each priority class.
- Queued cancelled jobs never start later.

### Progress And Terminal States

- Determinate progress updates current percentage and step within 1 second in test harness.
- Indeterminate progress remains active without invented percent.
- Decreasing progress is flagged or normalized by attempt/step.
- Progress after terminal state is stale unless tied to a newer retry attempt.
- Completion records terminal state, safe result summary, and no active indicator.
- Failure records category, safe reason, and retryability.

### Cancel / Pause / Resume / Retry

- Queued cancel transitions directly to cancelled.
- Running cancel transitions to cancellation-requested until provider terminal result.
- Unsupported cancel/pause/resume/retry returns unsupported-operation without inaccurate state changes.
- Pause preserves job identity and resume returns to queued/running.
- Retry creates linked attempt for retryable terminal job.
- Retry without matching approval scope returns denied/user-action-required.
- Concurrent retry attempts for same job are rejected or marked stale.

### Reload / Recovery

- Provider-recoverable queued/running/paused jobs restore according to provider metadata.
- Non-recoverable non-terminal jobs become orphaned or provider-unavailable with safe reason.
- Terminal jobs remain terminal across reload/recovery simulation.

### Diagnostics / Redaction

- Exported diagnostics preserve all active jobs and at least five recent terminal jobs.
- Per-job progress/log history is capped at 50 entries or stricter budget trimming.
- Diagnostics redact local paths, raw filenames when sensitive, secret URLs, tokens, command lines, raw artifacts, media buffers, recordings, subprocess handles, native handles, and plugin-private payloads.
- Bridge hits are recorded without creating duplicate user-visible jobs when native provider owns the same logical job.

## Browser / Inspector Scenarios

- Capability Inspector renders jobs provider summary, active jobs, queued jobs, recent terminal jobs, progress, action availability, bridge hits, and recent outcomes.
- Inspector can distinguish queued, running, paused, cancellation-requested, cancelled, completed, failed, provider-unavailable, and orphaned.
- Inspector does not show raw paths, command lines, tokens, handles, or artifacts.

## Python / Backend Regression Scenarios

Run focused pytest only if implementation touches diagnostics bundle export/import, plugin loading, backend route attribution, or redaction helpers.

Recommended focused files if touched:

```bash
uv run pytest tests/test_diagnostics_bundle.py tests/test_diagnostics_redact.py tests/test_plugins.py tests/test_plugin_runtime_idempotence.py -q
```

## Acceptance Validation

A complete implementation should be able to demonstrate:

1. One provider can enqueue, progress, and complete a job.
2. Cancel, pause, resume, and retry produce distinct safe outcomes.
3. Multiple providers without selection return provider-selection-required.
4. User-approved jobs outrank background jobs while respecting provider capacity.
5. Reload recovery follows provider-declared support.
6. Diagnostics preserve useful active/recent context and redact privileged data.
7. Legacy bridge hits are counted for plugin-specific queues/status surfaces during migration.
