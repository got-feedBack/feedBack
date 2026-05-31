# Research: Jobs Control Plane

## Decision: Implement `jobs` as a privileged provider-coordinator capability domain

**Rationale**: Long-running work is owned by different plugins and core-adjacent workflows, but users need one place to inspect state, progress, cancellation, retryability, and terminal failures. A provider-coordinator matches the existing `library`, `audio-input`, and `audio-monitoring` patterns: core owns public command normalization, provider registration, scheduling, diagnostics, and bridge accounting while providers own the actual conversion, import, update, preview, or studio work.

**Alternatives considered**:
- Exclusive core owner for all job execution: rejected because plugins own the real work and should not move conversion/update/studio internals into core.
- Leave plugin-specific queues in place only: rejected because support cannot reason about progress, cancellation, or failures across providers.
- Backend-only job registry: rejected for this slice because the existing capability runtime and inspector need browser-visible command and diagnostics state; backend routes remain a later privileged domain.

## Decision: Keep actual work provider-owned and expose only redaction-safe job state

**Rationale**: Jobs can touch local files, subprocesses, external services, downloads, native bridges, and plugin-private state. The jobs domain should record identity, state, progress, retryability, failure category, and safe summaries, but must not expose raw artifacts, command lines, paths, native handles, or provider-private payloads.

**Alternatives considered**:
- Store provider payloads in the jobs domain for retries: rejected because it risks leaking sensitive paths, tokens, or raw artifacts and duplicates provider ownership.
- Expose only textual status: rejected because commands and diagnostics need structured state for scheduling, cancellation, retry, and tests.

## Decision: Require explicit user approval for privileged enqueue scope

**Rationale**: Jobs may create, modify, delete, download, export, convert, or publish user-visible files or plugin state. The clarified approval scope is one job request plus provider-declared retries or continuations for the same provider, job type, target, requester, and inputs. This prevents broad background permission while keeping multi-step approved workflows usable.

**Alternatives considered**:
- Session-wide requester approval: rejected because one visible click could authorize unrelated background work.
- New approval for every retry/continuation: rejected because it would make recoverable provider-declared workflows unnecessarily noisy.

## Decision: Use selected/default provider only when multiple compatible providers exist

**Rationale**: If exactly one provider can handle a job type, enqueue can proceed without extra selection. If multiple compatible providers exist, a user-selected/default provider or explicit provider is required; otherwise the command returns `provider-selection-required`. This avoids hidden arbitrary choices for privileged work.

**Alternatives considered**:
- Always choose by registration order: rejected because registration order is not a user trust signal.
- Require provider on every request: rejected because single-provider cases should remain simple for users and plugin authors.

## Decision: Schedule user-approved interactive jobs before background/maintenance jobs

**Rationale**: Slopsmith is a single-user app. Work the user just approved should not wait behind background maintenance when both compete for the same provider capacity. FIFO within each priority keeps ordering understandable and testable while provider capacity remains authoritative.

**Alternatives considered**:
- Strict FIFO for all jobs: rejected because background work could delay visible user actions.
- Provider-defined ordering only: rejected because cross-provider diagnostics and user expectations would vary unpredictably.

## Decision: Treat cancellation as requested until the provider reports a terminal state

**Rationale**: Running work may not stop instantly, especially when subprocesses or external services are involved. A distinct `cancellation-requested` state lets users see that the request was accepted without falsely reporting the job as already cancelled.

**Alternatives considered**:
- Mark running jobs cancelled immediately: rejected because underlying work may still produce completion or failure.
- Reject cancellation unless providers can stop instantly: rejected because delayed cancellation is still valuable and common.

## Decision: Restore only jobs with provider-declared recovery support after reload

**Rationale**: A page reload or provider rehydration cannot prove that privileged work is still running unless the provider gives a recovery handle or equivalent safe metadata. Jobs without recovery support become orphaned or provider-unavailable with safe reasons.

**Alternatives considered**:
- Resume or rediscover every non-terminal job: rejected because it can invent state and accidentally continue privileged work.
- Mark all non-terminal jobs failed after reload: rejected because recoverable providers should be able to restore active or queued work.

## Decision: Bound diagnostics to active jobs, recent terminal jobs, and capped per-job history

**Rationale**: Diagnostics are not a log archive. Preserving all active jobs, at least five recent terminal jobs, and at most 50 progress/log entries per job gives support useful context while respecting the existing support snapshot budget.

**Alternatives considered**:
- Preserve the whole session: rejected because long-running jobs can generate excessive progress and logs.
- Preserve only active jobs: rejected because most support issues need recent terminal failure context.

## Decision: Use compatibility bridge hits for legacy queues and job-like route flows

**Rationale**: Existing plugin-specific queues and status screens must continue during migration. Bridge hits let support and removal gates identify legacy usage without forcing immediate rewrites.

**Alternatives considered**:
- Disable legacy queues when the domain appears: rejected because it would break current plugins.
- Ignore legacy usage: rejected because migrations need evidence before removing wrappers or duplicate status surfaces.
