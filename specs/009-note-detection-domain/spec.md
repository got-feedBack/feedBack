# Feature Specification: Note-Detection Capability Domain

**Status**: Draft stub — scheduling placeholder for the next capability-domain slice after audio-input (006) and audio-monitoring (007). Authored 2026-06-06 from a concrete non-chart consumer requirement (SlopScale, Chord Sprint). Full plan / data-model / contracts / tasks to be generated when the slice is scheduled, passing the Spec 003 migration gate.

## Why now

The capability-domain roadmap has been laying foundations *for* this slice from the start: Spec 002 names note detection on the roadmap; Spec 003 lists it among the domains that must pass the migration gate; Spec 004 defines `audio-input` named source identity explicitly so "a later note-detection domain needs per-source binding … without inheriting a single global detector assumption"; Specs 006/007 already carry `{ requesterId: 'note_detect', purpose: 'note-detection' }` requesters. This spec turns that anticipated slice into a concrete one, driven by a real consumer that the current surfaces cannot serve.

**Concrete trigger.** Detection capability is today fragmented across two surfaces and coupled to the host chart:
- `slopsmithMinigames.scoring.createContinuous` — monophonic YIN, reachable from contained playback but weak (no chords, 70 Hz floor, distortion-unprobed).
- `window.noteDetect` verify/scoring — the strong harmonic-comb verifier, but its tuning/arrangement state is mutated by the host's loaded song (`song:loaded`), so it is a **single global detector** that two consumers with different tuning needs fight over.

A contained-playback consumer (SlopScale runs its own transport and computes targets from the *player's real instrument*, not the chart's nominal tuning; Chord Sprint similarly) has no clean way to use the strong verifier against its own tuning. The interim bridge (notedetect `setVerifyTarget(notes, ctx)`, PR #62 on the plugin repo) proves the requirement and is forward-compatible with this domain's per-binding context, but it still relies on a single shared detector instance. This domain is the long-term home.

## Clarifications

### Session 2026-06-06
- Q: Does this domain perform detection DSP itself? → A: No. It is a capability/control plane over existing detection providers (the desktop JUCE engine verifier and the JS harmonic-comb / YIN fallback). The DSP stays where it is; the domain gives it a per-binding, chart-decoupled, multi-consumer contract.
- Q: Does this domain own scoring/judgment (hit windows, gems, tiers)? → A: No. Consumers own judgment semantics. The domain exposes detection PRIMITIVES only: a monophonic pitch estimate, and a "is this (string,fret) note-set ringing now?" verification verdict against caller-supplied tuning. (Doctrine: host owns detection DSP; consumers own judgment.)
- Q: Is detection bound to the host highway's loaded song? → A: No. That single-global-detector coupling is the problem this slice removes. Each requester binds its own tuning context.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Verify against the player's own tuning from contained playback (Priority: P1)

A contained-playback consumer (SlopScale) that runs its own transport and has no host song loaded asks "is the expected note/chord ringing now?" against the *player's* instrument tuning, and receives polyphonic, distortion-robust verdicts — without reading plugin-private globals and without the result being perturbed by whatever song the host highway has open.

**Why P1**: This is the requirement no current surface satisfies; it is the reason the slice exists.

**Acceptance**:
- **Given** no host song is loaded, **When** a requester opens a detection binding with its own arrangement + tuning and registers a target note set, **Then** it receives verification verdicts scored against that tuning.
- **Given** the host loads or switches a song underneath, **When** the requester's binding is active, **Then** its verdicts are unaffected (no shared-state perturbation).

### User Story 2 - Two consumers detect concurrently with different tunings (Priority: P2)

The highway (chart tuning) and a minigame (player tuning) request detection at the same time, each against its own context, without a single global detector's mutable arrangement/tuning state being clobbered by the other.

**Why P2**: Spec 004 deliberately avoided the single-global-detector assumption for exactly this; the domain realizes it.

**Acceptance**:
- **Given** two active detection bindings with different arrangement/tuning, **When** both score concurrently, **Then** neither alters the other's tuning context or verdicts.

### User Story 3 - One detection capability, two primitives (Priority: P3)

A consumer that needs a live monophonic pitch (a tuner, a pitch strip) and a consumer that needs polyphonic note-set verification (a chord drill) use the **same** capability domain — not two unrelated surfaces (`createContinuous` vs `noteDetect`) — so DSP improvements (the bass temporal-persistence floor, distortion handling, future models) land once and reach every consumer.

**Acceptance**:
- **Given** a single capability contract, **When** a consumer requests a monophonic pitch primitive or a polyphonic verify primitive, **Then** both are served by one provider over one input binding.
- **Given** a DSP improvement lands in the provider, **When** any consumer requests detection, **Then** it benefits without consumer changes.

### User Story 4 - Migrate detection consumers and providers safely (Priority: P4)

The existing chart-coupled `note_detect` path, the minigames YIN scoring, Step Mode's verify consumption, and the bridge `setVerifyTarget(notes, ctx)` all migrate onto the domain behind the Spec 003 migration gate, with compatibility bridges and a removal gate, leaving each app area cleaner.

**Acceptance**:
- **Given** the domain exists, **When** a legacy detection handoff occurs during migration, **Then** it is mapped into domain diagnostics and recorded as a compatibility bridge hit.
- **Given** a new detection consumer is added after this slice, **When** it needs detection, **Then** it uses the domain rather than a new legacy-only handoff.

### Edge Cases

- No microphone / insecure context / no detection provider → detection bindings report unavailable; consumers degrade (scoring disables, never blocks).
- A requester's declared tuning references strings the provider's tuning tables cannot represent (e.g. 6-string bass) → bounded `incompatible` outcome, not a silent NaN verdict.
- Host song-switch while a player-tuning binding is active → the binding's context is unchanged.
- Capo / drop tunings / re-tunings → the binding carries the real open-string pitches; no double transposition.
- Polyphony the provider cannot resolve (heavy distortion, sub-floor strings) → verdict reports it honestly rather than guessing.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide an authoritative note-detection control plane for opening a detection binding, registering/clearing a target, requesting verification verdicts, requesting a monophonic pitch estimate, and reporting provider/availability state.
- **FR-002**: System MUST let each requester supply its own tuning context (arrangement, per-string tuning as absolute open MIDI or standard-tuning offsets, capo, string count) per binding, and MUST score that binding only against that context.
- **FR-003**: System MUST NOT bind detection to the host highway's loaded song or any single global arrangement/tuning state; concurrent bindings with different contexts MUST NOT perturb one another.
- **FR-004**: System MUST consume audio-input (Spec 006) source identity and open-session state for its capture rather than redefining input or assuming one global detector.
- **FR-005**: System MUST expose detection as PRIMITIVES — a monophonic pitch estimate and a polyphonic note-set verification verdict — and MUST NOT perform consumer-side judgment (hit windows, streaks, gems, accuracy, tiers).
- **FR-006**: System MUST provide a timing-free verification mode (score a registered target every frame independent of any playhead) so a frozen-playhead or self-transported consumer can ask "is this note-set ringing now?".
- **FR-007**: System MUST surface per-binding verdict detail sufficient for consumer judgment (at minimum: overall hit, and per-string/per-note ring state for a multi-note target) without exposing raw audio buffers or sample data.
- **FR-008**: System MUST report distinct outcomes for unavailable, denied, degraded, failed, no-provider, unsupported-context, and incompatible-version, rather than silently producing a verdict.
- **FR-009**: System MUST reject or degrade tuning contexts the provider cannot represent (unsupported arrangement/string-count) with an `incompatible` outcome and MUST NOT emit NaN/garbage verdicts.
- **FR-010**: System MUST route every detection request through one provider abstraction so DSP improvements reach all consumers at once (single source of truth), with the desktop engine verifier and a JS fallback as interchangeable providers.
- **FR-011**: System MUST preserve the existing chart-coupled detection path during the compatibility period by mapping it onto the domain, recording compatibility bridge hits.
- **FR-012**: System MUST document the migration path for detection providers and requesters (the chart `note_detect` consumer, Step Mode verify, minigames YIN scoring, and the `setVerifyTarget` bridge), including a removal gate, per Spec 003.
- **FR-013**: System MUST emit observable events when bindings open/close, targets change, verdicts are produced, and availability changes.
- **FR-014**: System MUST include active bindings, provider attribution, per-binding context summary, availability, and recent outcomes in diagnostics, redaction-safe.
- **FR-015**: System MUST NOT expose raw audio buffers, sample/waveform data, or live capture handles through detection state, verdicts, diagnostics, or capability payloads.
- **FR-016**: System MUST leave audio-input source ownership, monitoring lifecycle, recording, playback transport, and plugin installation outside this feature except as state it consumes.
- **FR-017**: System MUST avoid creating new legacy-only detection integration points once the native domain exists.

### Key Entities

- **Detection Binding**: A requester-owned, context-scoped detection session over a selected audio-input source — carries the requester's tuning context and target, independent of any host song. Multiple bindings coexist.
- **Tuning Context**: Arrangement + per-string tuning (absolute open MIDI or standard offsets) + capo + string count, supplied by the requester; the only tuning a binding's verdicts are scored against.
- **Verify Target**: A registered note set (string/fret + technique flags) the binding scores against live audio every frame, independent of any playhead.
- **Verification Verdict**: A bounded result — overall hit, per-note/per-string ring state, score, hit/total counts — with no raw audio.
- **Pitch Estimate**: A monophonic frequency/MIDI + confidence primitive (the tuner/pitch-strip use case), the consolidation target for `createContinuous`.
- **Detection Provider**: The participant performing DSP — the desktop JUCE engine verifier, or the JS harmonic-comb / YIN fallback — interchangeable behind the domain contract.
- **Detection Requester**: A consumer (note_detect chart path, Step Mode, SlopScale, Chord Sprint, a tuner) that needs detection primitives but owns its own judgment.
- **Compatibility Bridge Hit**: A record that a legacy chart-coupled or minigames-YIN detection handoff was used during migration.
- **Detection Outcome**: A bounded diagnostic record (provider, binding, requester, status, outcome, safe reason) with no live handles or sample data.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A contained-playback requester with no host song loaded receives verification verdicts scored against its own tuning in 100% of focused scenarios.
- **SC-002**: A host song-switch while a player-tuning binding is active changes that binding's verdicts in 0% of focused scenarios.
- **SC-003**: Two concurrent bindings with different arrangement/tuning never alter each other's context or verdicts in 100% of focused scenarios.
- **SC-004**: A polyphonic (chord) target produces a real per-note/overall verdict — not an all-or-nothing exemption — in 100% of focused chord scenarios.
- **SC-005**: A DSP improvement landed in the provider reaches every domain consumer with zero consumer code changes in representative cases.
- **SC-006**: Unsupported tuning contexts produce an `incompatible` outcome and zero NaN/garbage verdicts in 100% of focused scenarios.
- **SC-007**: 100% of detection verdicts, state snapshots, and diagnostics contain zero raw audio buffers, sample/waveform data, or live capture handles.
- **SC-008**: New detection consumers added after this slice use the domain rather than a new legacy-only handoff in 100% of reviewed cases.
- **SC-009**: A maintainer can identify provider, binding context, availability, and outcome for a representative detection failure in under 5 minutes from diagnostics/inspector.

## Assumptions

- Audio-input (006) and audio-monitoring (007) slices are available as foundation; this slice consumes their source identity and monitoring facts rather than redefining them.
- The detection DSP (desktop JUCE engine verifier; JS harmonic-comb / YIN fallback) already exists and is correct; this slice gives it a per-binding, chart-decoupled, multi-consumer contract — it does not reimplement DSP.
- Consumers retain ownership of judgment semantics (hit windows, streaks, gems, accuracy, tiers); the domain provides primitives only.
- The notedetect `setVerifyTarget(notes, ctx)` bridge (plugin PR #62) is the interim, forward-compatible step; its per-call context maps onto this domain's per-binding context.
- Detection is sensitive: raw audio must never cross the capability boundary.
- Existing chart-coupled and minigames-YIN detection paths may coexist during migration behind the Spec 003 gate.

## Out of scope

- Detection DSP/model implementation or accuracy improvements (owned by the provider plugins).
- Consumer judgment/scoring UX (gems, tiers, accuracy) — owned by each requester.
- Audio-input source ownership/selection (006), monitoring lifecycle (007), recording, playback transport (008), and plugin installation.
- 6-string bass and other tunings outside the provider's current tuning tables (tracked separately).
