# Implementation Plan: Note-Detection Capability Domain

**Status**: Draft stub. This plan records scope, dependencies, and the migration-gate posture so the slice can be scheduled. The full plan/data-model/contracts/tasks are generated when the slice starts.

## Scope

Introduce a `note-detection` capability domain: a per-binding, chart-decoupled, multi-consumer control plane over the existing detection DSP. It exposes two primitives — a monophonic pitch estimate and a polyphonic note-set verification verdict — each scored against a requester-supplied tuning context, and consolidates today's two fragmented surfaces (`slopsmithMinigames.scoring.createContinuous` and `window.noteDetect`) behind one contract. It does **not** implement DSP and does **not** own consumer judgment.

See `spec.md` for requirements, entities, and success criteria.

## Dependencies / ordering

- **Depends on** Spec 006 (audio-input domain — source identity, open-session state; consumed, not redefined) and Spec 007 (audio-monitoring domain). 007 is currently paused (PR #667); this slice should not start until 006/007 are settled enough to consume.
- **Builds on** the capability-pipeline runtime (Spec 002, PR #245) and follows the migration standard (Spec 003).
- **Interim bridge already shipped/in-flight**: notedetect `setVerifyTarget(notes, ctx)` (plugin PR #62). Its per-call tuning context is the forward-compatible seed of this domain's per-binding context; the SlopScale consumer adapter (fork PR) and Chord Sprint are the first non-chart requesters.

## Migration gate (per Spec 003)

This slice must pass the central + per-domain migration checklist:
- Per-slice legacy inventory: the chart-coupled `note_detect` scoring/verify path, Step Mode verify consumption, minigames YIN scoring, and the `setVerifyTarget` bridge.
- Staged deprecation gates + compatibility-bridge accounting (record legacy handoffs; native wins on overlap).
- Diagnostics/Inspector expectations: bindings, provider attribution, per-binding context summary, outcomes — redaction-safe, no raw audio.
- Removal gate: legacy detection handoffs removed only after consumers migrate, migration notes are published, and external usage review completes.

## Providers

- Desktop: JUCE engine verifier (harmonic-comb `scoreChord`, bass temporal-persistence floor) + monophonic pitch.
- Web/dev: JS harmonic-comb / YIN fallback.
Both sit behind one provider abstraction so DSP improvements land once and reach all consumers.

## Explicitly out of scope

Detection DSP/model accuracy, consumer judgment/scoring UX, audio-input source ownership (006), monitoring lifecycle (007), recording, playback transport (008), plugin installation, and tunings outside the provider's current tables (e.g. 6-string bass).
