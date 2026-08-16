# Feature Specification: Progression Contributors — Plugin-Shipped Challenge Content And Custom Events

**Feature Branch**: `spec/011-progression-contributors`
**Created**: 2026-06-12
**Status**: Draft
**Input**: User description: "Design the deferred `contributor` slice of the progression domain (spec 010) so plugins can ship their own challenge/quest content and emit their own progression event types. Driving use case: the SlopScale practice plugin's leveling mechanisms (tempo-tier flips, clean-BPM personal bests, key travels, proof-loop claims)."

> Companion to spec 010 (`specs/010-progression-domain/spec.md`), which ships the core
> progression engine with core-bundled content only and documents this slice as
> deferred. The driving requirements come from SlopScale's progression design
> (`progression-leveling-detail.md`, v0.7.23-dev): a plugin with a rich internal
> ladder whose *proven outcomes* — a tempo-tier flip, a monotonic PB raise, a
> key traveled, a verified voice-leading claim — are exactly the events a
> Mastery-Rank challenge wants to count, and none of which are expressible in
> spec 010's goal vocabulary (`minigame_run` carries only `game_id` + `score`).

## Clarifications

### Session 2026-06-12

- Q: How does contributed content reach the engine — runtime registration or declarative file? → A: Declarative. A plugin ships a progression content JSON in its own directory and references it from `plugin.json`; core loads it at plugin load with the same warn-and-skip validation as bundled content. No runtime content-mutation API in this slice (content stays reviewable, restart-stable, and inspectable).
- Q: Can plugins append challenges to core paths' levels? → A: No (deferred). Appending would let a plugin silently change another path's level-up closure. Plugins contribute whole new paths and quest-pool entries only.
- Q: Do contributed quests dilute the core daily/weekly rotation? → A: Yes, deliberately: contributed quest entries join the shared pools and the same deterministic rotation. Per-plugin bonus quest slots are deferred until dilution is observed to be a real problem.
- Q: What happens to earned progress when a contributing plugin is disabled or uninstalled? → A: It persists. Mastery Rank never decreases (spec 010 invariant): contributed path levels keep counting, completed challenges stay completed, and the orphan-path rendering shipped in spec 010 (`_progression_overview`) already shows them. Active (incomplete) contributed content is hidden and the event whitelist shrinks.
- Q: Are contributed rewards bounded? → A: Yes. Contributed quest `reward_db` is clamped to a per-quest cap with a load warning (core's richest weekly quest pays 300 dB; the cap is 500). Challenges award no dB directly, same as core content. Decibels remain earn-by-playing only — contributed content cannot create a money path.
- Q: Who may emit a plugin's event types? → A: Anyone on the local honor system (constitution: single trusted user; validation guards accidents, not cheaters) — but the whitelist only admits event types declared by an ENABLED plugin's validated content, and the type namespace binds events to their declaring plugin.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A Practice Plugin Ships Its Own Path (Priority: P1)

The SlopScale developer ships a "Woodshed" instrument path whose challenges count his plugin's proven outcomes — "clear the Push rung on any pathway", "raise a clean-tempo PB past 90 BPM", "travel 3 keys on one pathway" — without any core code change, and players level that path into their Mastery Rank exactly like a core path.

**Why this priority**: This is the whole point of the slice — the richest progression content lives in plugins that know what "proven" means for their own mechanics, and core's job is counting, not understanding tempo tiers.

**Independent Test**: Install a fixture plugin declaring a path with `plugin_event` goals; emit matching events; the path levels and Mastery Rank rises; core content and tests are untouched.

**Acceptance Scenarios**:

1. **Given** a plugin whose `plugin.json` references a progression content file declaring path `slopscale.woodshed`, **When** the plugin loads, **Then** the path appears in `available_paths`, is selectable, and its challenges render on the Progress screen like core content.
2. **Given** a challenge with goal `{type: "plugin_event", event: "slopscale.tier_cleared", match: {tier: 4}, target: 1}`, **When** the plugin records `slopscale.tier_cleared {pathway: "blues_foundation", tier: 4, bpm: 96}`, **Then** the challenge completes and a level-up follows the same required-count rules as core paths.
3. **Given** numeric threshold params, **When** a goal declares `min: {bpm: 90}`, **Then** only events whose `bpm` payload is ≥ 90 advance it.
4. **Given** content edits in a plugin update, **Then** new levels/challenges appear after restart with zero core changes, and previously completed challenges stay completed.
5. **Given** mis-authored contributed content (duplicate ids, unknown goal types, missing event namespace), **Then** core logs warnings and skips the invalid entries — a plugin can never crash or block core progression (contrast: the plugin's own internal `assert`-and-throw guards are its business; contributed content is always degraded, never fatal).

---

### User Story 2 - Namespaced Custom Events Through One Choke Point (Priority: P1)

A plugin records its proven outcomes as namespaced progression events through the existing surfaces — the backend `record_progression_event` context hook or the frontend `progression` capability `record-event` command — and the external whitelist extends automatically to the event types its validated content declares.

**Why this priority**: Without event intake there is nothing for contributed goals to count; without namespacing and whitelist discipline the single-authority model of spec 010 (server-derived `song_completed`) erodes.

**Acceptance Scenarios**:

1. **Given** content declaring `events: ["slopscale.tier_cleared", "slopscale.pb_raised", "slopscale.key_traveled"]`, **When** the plugin is enabled, **Then** `POST /api/progression/events` (and the capability `record-event`) accepts exactly those types in addition to the spec 010 whitelist; unknown or undeclared types are still rejected with a safe outcome.
2. **Given** an event type not prefixed with the declaring plugin's id, **When** content loads, **Then** the declaration is skipped with a warning (a plugin cannot claim another plugin's — or core's — namespace, including `song_completed`).
3. **Given** the plugin is disabled, **When** its event type is posted, **Then** it is rejected like any unknown type, and nothing already earned changes.
4. **Given** an event with a payload that violates the scalar/size rules of spec 010, **Then** it is rejected identically to v1 intake (same validation, same caps).
5. **Given** a recorded plugin event, **Then** the outcome summary (completed challenges/quests, level-ups) returns to the caller and the standard lifecycle events fire, so the plugin can render the completion in its own UI (e.g. SlopScale's run-end recognizer surface).

---

### User Story 3 - Contributed Quests Join The Rotation (Priority: P2)

A plugin contributes quest-pool entries ("hold a groove at 80 BPM for a daily", "clear two rungs this week") that rotate, reward dB, and feed `quest_completed` challenges exactly like core quests.

**Acceptance Scenarios**:

1. **Given** contributed daily/weekly pool entries, **When** a new period instantiates, **Then** the deterministic rotation draws from the combined core+contributed pool (same period key → same selection, restart-safe).
2. **Given** a contributed quest with `reward_db: 5000`, **When** content loads, **Then** the reward clamps to the cap (500) with a warning; completion awards through `award_xp(…, "quests")` like any quest.
3. **Given** the contributing plugin is disabled mid-period, **Then** its live quest instances are hidden from the API payload (same as a quest removed from a core pool mid-period) and re-enabled content reappears without duplication.

---

### User Story 4 - Support Tooling Sees Contributors (Priority: P3)

A maintainer can tell which plugin contributed which paths/quests/event types, and see that plugin's content-load warnings, through the Capability Inspector and the progression diagnostics contributor.

**Acceptance Scenarios**:

1. **Given** a contributing plugin, **Then** it appears in the `progression` pipeline as a `contributor` participant (manifest `capabilities.progression.roles: ["contributor", …]`), visible in the Inspector with its declared event types.
2. **Given** content-load warnings for a plugin, **Then** the progression diagnostics snapshot (`slopsmith.progression.diag.v1`) attributes them to that plugin id, within the existing redaction rules (counts and ids only — no song filenames, no display names).
3. **Given** an event recorded through the capability command, **Then** the decision log attributes it to the requesting plugin.

### Edge Cases

- Two plugins (or a plugin and core) declaring the same path/challenge/quest/event id → first loaded wins, later duplicates skipped with warnings (deterministic: core first, then plugins alphabetically).
- A contributed path selected by the player, then the plugin's content shrinks (level removed) → same rules as core content edits: completed stays completed, orphaned progress rows are harmless, max level drops only the *next* target.
- `distinct`-style dedupe on plugin events → supported via the same `progress_detail` mechanism keyed on a declared payload field (e.g. `distinct_by: "pathway"` counts unique pathways), since "travel 3 keys" must not count the same key thrice.
- Event flood from a buggy plugin → same per-event payload caps as v1; rate limiting is out of scope (honor system), but the 64 KB diagnostics cap and bounded recent-outcome history must hold.
- Integrity guidance (unenforceable but specified): contributors SHOULD emit an event only when the underlying outcome was actually proven by their own standards — SlopScale's "a claim exists only when something was proven" anti-inflation rule is the reference model. Core's defense stays structural: namespacing, whitelisting, bounded rewards, and rank deriving only from challenge closure.
- A `plugin_event` goal in CORE content referencing a plugin event type is allowed (core may count "clear a SlopScale rung" in a core path) and simply never advances while the plugin is absent — same satisfiable-later semantics as drums content in spec 010.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: A plugin MUST be able to contribute progression content by referencing a JSON file from its manifest; core MUST load it at plugin load through the same validation pipeline as bundled content (warn-and-skip, never fatal).
- **FR-002**: Contributed ids (paths, challenges, quests, event types) MUST be namespaced under the contributing plugin's id; declarations outside that namespace MUST be skipped with a warning. Core ids and core event types (`song_completed`, `minigame_run`, `quest_completed`, …) are unclaimable.
- **FR-003**: Contributed content MAY declare new paths and daily/weekly quest-pool entries; it MUST NOT modify core paths, core levels, core quests, or the shop. Shop contribution is explicitly out of scope.
- **FR-004**: The engine MUST support a `plugin_event` goal type: `{type: "plugin_event", event: <namespaced type>, match?: {field: scalar, …}, min?: {field: number, …}, distinct_by?: <payload field>, target}` — equality on `match` fields, ≥ thresholds on `min` fields, optional unique-value counting via the existing `progress_detail` mechanism.
- **FR-005**: The external event whitelist (HTTP + capability `record-event`) MUST extend to exactly the event types declared by enabled plugins' validated content, shrinking when a plugin is disabled; all other spec 010 intake rules (scalar payloads, size caps, safe rejection outcomes) apply unchanged.
- **FR-006**: The backend `record_progression_event` context hook MUST keep working unchanged for trusted backend code, including for namespaced types.
- **FR-007**: Contributed paths MUST integrate with Mastery Rank, the Progress screen, level-up closure, and the orphan-path rendering identically to core paths; earned levels and completions MUST persist across plugin disable/uninstall (rank never decreases).
- **FR-008**: Contributed quest `reward_db` MUST clamp to 500 with a load warning; Decibels remain earn-by-playing only — contributed content MUST NOT introduce any purchase or exchange surface.
- **FR-009**: Quest rotation MUST stay deterministic over the combined pool; a disabled plugin's live quest instances are hidden (not deleted) and reappear without duplication on re-enable within the same period.
- **FR-010**: Contributing plugins MUST be able to declare the `contributor` role in their manifest `capabilities.progression` block; the runtime MUST surface them as participants of the `progression` pipeline with their declared event types, visible in the Capability Inspector.
- **FR-011**: Progression diagnostics MUST attribute contributed content counts and load warnings per plugin id, within spec 010's redaction rules and size cap.
- **FR-012**: Duplicate-id resolution MUST be deterministic: core content first, then plugins in alphabetical plugin-id order; later duplicates skip with warnings.
- **FR-013**: All schema/storage changes MUST remain additive and idempotent; contributed challenges/quests reuse the spec 010 tables unchanged (namespaced ids are sufficient).
- **FR-014**: Content contributed by a plugin whose manifest declares an unsupported progression-content schema version MUST be skipped with a warning (versioned: `progression-content.v1`).
- **FR-015**: A plugin's outcome summary and lifecycle events for its own recorded events MUST be delivered to it like any requester, so contributed completions can render inside the plugin's own UI moments (e.g. a run-end modal).

### Key Entities

- **Contributed Content Bundle**: The validated, namespaced set of paths/quests/event-type declarations one plugin ships (`progression-content.v1`).
- **Plugin Event Type**: A namespaced progression event (`<plugin_id>.<name>`) declared by content; the unit the whitelist and `plugin_event` goals bind to.
- **`plugin_event` Goal**: The content-side matcher (event + equality `match` + numeric `min` + optional `distinct_by` + `target`) that turns plugin outcomes into challenge/quest progress.
- **Contributor Participant**: The plugin's `progression` pipeline membership (role `contributor`), carrying its declared event types for inspection.
- **Orphaned Contribution**: Progress earned from content whose plugin is now absent — persisted, rank-counting, rendered via the spec 010 orphan path.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: The SlopScale pilot can express "clear the Push rung", "PB past 90 BPM (clean)", and "travel 3 distinct keys" as contributed challenges with zero core code changes — content + events only.
- **SC-002**: Disabling/uninstalling the contributing plugin mid-progress leaves the full test suite green, Mastery Rank unchanged, and the Progress screen rendering without errors.
- **SC-003**: Undeclared, foreign-namespace, and disabled-plugin event types are all rejected at external intake with safe outcomes (verified by API tests).
- **SC-004**: Same period key + same combined pool yields identical quest rotation across restarts with contributed entries present.
- **SC-005**: A deliberately mis-authored fixture bundle (duplicate ids, foreign namespace, absurd rewards, unknown goal type) loads as warnings only, with every invalid entry skipped and every valid sibling alive.
- **SC-006**: The Inspector lists the contributor participant with its event types; diagnostics stay under the 64 KB cap with per-plugin warning attribution.

## Assumptions

- Spec 010 is merged and its engine/tables/API are the substrate; this slice adds no new tables.
- Single trusted local user (constitution): event intake remains honor-system; the controls here (namespacing, whitelist, clamps, determinism) guard accidents and content mistakes, not adversaries.
- SlopScale remains the pilot consumer; its internal woodshed XP/levels stay plugin-internal by design (non-spendable practice evidence ≠ the dB wallet) — this slice transports its *proven outcomes*, not its ledger.
- Per-plugin bonus quest slots, challenge injection into core path levels, plugin-contributed shop items, and runtime content registration are explicitly deferred.
