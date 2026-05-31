# Data Model: Jobs Control Plane

## Job Provider

Represents a participant that can accept one or more long-running job types.

**Fields**:
- `providerId`: stable participant id, unique within the jobs domain.
- `pluginId`: owning plugin id or `core`.
- `label`: redaction-safe display label.
- `supportedJobTypes`: list of job type ids the provider can handle.
- `supportedActions`: subset of `enqueue`, `inspect`, `cancel`, `pause`, `resume`, `retry`, `recover`.
- `availability`: `available`, `unavailable`, `degraded`, `disabled`, or `incompatible`.
- `capacity`: provider-declared running and queued limits.
- `currentLoad`: running/queued counts visible to scheduling.
- `selectionEligible`: whether the provider can be user-selected/default for a job type.
- `recoverySupport`: provider-level summary of reload recovery support.
- `safeReason`: bounded redaction-safe reason for unavailable/degraded/incompatible state.
- `lastSeenAt`: timestamp of latest registration/status update.

**Validation rules**:
- `providerId` must be stable and unique.
- Unsupported or incompatible provider versions must not accept new jobs.
- Repeated registration for the same provider updates the record instead of creating duplicates.
- Capacity values must be non-negative and must not be exceeded by scheduler decisions.

## Job Requester

Represents a user action, plugin, or app workflow that asks for job work.

**Fields**:
- `requesterId`: stable requester id.
- `pluginId`: plugin id, `core`, or `user`.
- `kind`: `user`, `plugin`, `core-workflow`, `background`, or `compatibility`.
- `displayLabel`: redaction-safe requester label.
- `authorization`: `user-action`, `approved-continuation`, `background`, or `none`.

**Validation rules**:
- Privileged enqueue requires `user-action` or an approved continuation matching the approval scope.
- Background requesters may list/inspect but may not start privileged work without approval.

## Job Approval Scope

Represents what one explicit user approval covers.

**Fields**:
- `approvalId`: ephemeral approval id.
- `providerId`: provider covered by approval.
- `jobType`: job type covered by approval.
- `targetRef`: redaction-safe target identity.
- `requesterId`: requester covered by approval.
- `inputFingerprint`: redaction-safe fingerprint for approved inputs.
- `allowsRetry`: whether provider-declared retry attempts can reuse approval.
- `allowsContinuation`: whether provider-declared continuation attempts can reuse approval.
- `createdAt`: approval timestamp.

**Validation rules**:
- Approval cannot widen across provider, job type, target, requester, or inputs.
- Retry/continuation use is allowed only when the provider declares it and the scope still matches.

## Selected Job Provider

Represents the user-selected/default provider for a job type when multiple providers are compatible.

**Fields**:
- `jobType`: job type id.
- `providerId`: selected/default provider id.
- `source`: `user-selected`, `default`, or `request-explicit`.
- `updatedAt`: timestamp.

**Validation rules**:
- If exactly one compatible provider exists, explicit selection is not required.
- If multiple compatible providers exist, enqueue requires a selected/default/explicit provider or returns `provider-selection-required`.
- Selection must not point to unavailable or incompatible providers for new work.

## Job

Represents a user-visible unit of long-running work.

**Fields**:
- `jobId`: stable job id.
- `jobType`: conversion, import, update, preview, studio, compatibility-backed, or future typed work.
- `providerId`: provider handling the job.
- `requesterId`: requester that enqueued the job.
- `targetRef`: redaction-safe target identity.
- `state`: current lifecycle state.
- `priority`: `user-approved-interactive` or `background-maintenance`.
- `safeLabel`: redaction-safe display label.
- `progress`: latest progress snapshot.
- `attempts`: ordered job attempt ids.
- `retryable`: whether retry is currently allowed.
- `actionsAvailable`: currently valid user/requester actions.
- `createdAt`, `queuedAt`, `startedAt`, `updatedAt`, `terminalAt`: timestamps.
- `terminalOutcome`: terminal outcome when state is terminal.
- `safeReason`: bounded reason for current or terminal state.
- `bridgeSource`: compatibility bridge source when applicable.

**Validation rules**:
- `jobId` must remain stable across progress updates and supported recovery.
- State updates after terminal state are stale unless tied to a newer retry attempt.
- Queued jobs can cancel immediately and must not start later.
- Running cancellation enters `cancellation-requested` until provider terminal report.

## Job Attempt

Represents one run of a job, including retries.

**Fields**:
- `attemptId`: stable attempt id.
- `jobId`: parent job id.
- `attemptNumber`: 1-based attempt number.
- `providerId`: provider running the attempt.
- `approvalScopeId`: approval scope used for this attempt.
- `state`: attempt state.
- `startedAt`, `updatedAt`, `terminalAt`: timestamps.
- `terminalOutcome`: terminal attempt outcome.

**Validation rules**:
- Retry attempts must link to the original job.
- Retry requires terminal parent state and matching approval scope or new user approval.
- Only one active retry attempt may exist for a job at a time.

## Scheduling Policy

Represents provider capacity and ordering behavior.

**Fields**:
- `providerId`: provider whose queue is governed.
- `maxRunning`: maximum simultaneous running jobs.
- `maxQueued`: optional maximum queued jobs.
- `priorityOrder`: user-approved interactive before background/maintenance.
- `withinPriorityOrder`: FIFO.
- `blockedReason`: safe reason when queued work cannot start.

**Validation rules**:
- Running jobs must not exceed `maxRunning`.
- Background jobs cannot start ahead of queued user-approved interactive jobs for the same provider capacity.
- FIFO order applies inside each priority class unless jobs are cancelled or become invalid.

## Progress Snapshot

Represents latest progress for a job.

**Fields**:
- `mode`: `determinate`, `indeterminate`, or `step-only`.
- `percent`: number from 0 to 100 when determinate.
- `step`: redaction-safe current step id or label.
- `message`: bounded redaction-safe message.
- `updatedAt`: timestamp.

**Validation rules**:
- Determinate progress must stay in range 0..100.
- Decreasing progress is flagged unless provider marks a new step/attempt.
- Progress after terminal state is stale unless tied to a newer attempt.

## Terminal Outcome

Represents final state and reason.

**Fields**:
- `status`: `completed`, `cancelled`, `failed`, `timeout`, `provider-unavailable`, or `orphaned`.
- `category`: invalid-input, permission-denied, provider-unavailable, unsupported-operation, timeout, cancellation, external-dependency, storage, provider-failure, or unknown.
- `retryable`: boolean.
- `safeReason`: bounded redaction-safe reason.
- `resultSummary`: redaction-safe completion summary.

**Validation rules**:
- Terminal outcome must not expose raw artifacts, paths, command lines, tokens, native handles, or provider-private payloads.
- Terminal state is final for an attempt; retries create a new attempt.

## Job Diagnostic Log Entry

Represents bounded log/progress history.

**Fields**:
- `entryId`: local sequence id.
- `jobId`: associated job.
- `attemptId`: associated attempt when known.
- `kind`: `progress`, `log`, `warning`, `error`, or `event`.
- `message`: redacted bounded text.
- `timestamp`: timestamp.

**Validation rules**:
- Per-job progress/log history is capped at 50 entries or stricter support snapshot trimming.
- Entries must be redacted before export.

## Compatibility Bridge Hit

Represents legacy job-like behavior observed during migration.

**Fields**:
- `bridgeId`: stable bridge id.
- `providerId`: associated provider when known.
- `jobId`: associated job when known.
- `legacySurface`: plugin queue, status view, backend route, or compatibility status source.
- `operation`: observed operation.
- `timestamp`: timestamp.
- `safeReason`: bounded reason.

**Validation rules**:
- Bridge hits are diagnostics; they must not become a second user-visible job when a native provider describes the same logical job.

## State Transitions

```text
queued -> running
queued -> cancelled
queued -> provider-unavailable
queued -> orphaned
running -> progress-updated -> running
running -> cancellation-requested
running -> paused
running -> completed
running -> failed
running -> provider-unavailable
running -> orphaned
cancellation-requested -> cancelled
cancellation-requested -> completed
cancellation-requested -> failed
paused -> queued
paused -> running
paused -> cancelled
paused -> provider-unavailable
paused -> orphaned
failed -> retry-started -> queued
cancelled -> retry-started -> queued
completed -> terminal
provider-unavailable -> retry-started -> queued when retryable
orphaned -> retry-started -> queued when retryable
```

Terminal attempt states are `completed`, `cancelled`, `failed`, `timeout`, `provider-unavailable`, and `orphaned`. A retry creates a new attempt linked to the original job rather than mutating the prior attempt.
