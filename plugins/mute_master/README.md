# Mute Master

The first **skill-drill game** for Slopsmith — see
[`docs/TEACHING_NARRATIVE.md`](../../docs/TEACHING_NARRATIVE.md).

It trains **muting**: when the chart wants a fretted note, the open string must
not ring. note_detect flags that exact failure as `mute_fail`; coaching's
practice taxonomy points a `mute_fail` hotspot here, deep-linking into the
passage you fumbled. The game scores your muting off the live note_detect
judgment stream using the **shared** skill-drill mechanics
(`createSkillDrill` / `skillDrillStep` / `skillDrillView`, published by the
coaching plugin and bridged through the minigames SDK as `sdk.skillDrill`).

**Chart-free and self-paced** (per the "fast, no lead-in, no slow animations"
steer): it prompts one fret target at a time and scores each note the instant
you play it — target pitch sounds → a **clean** muting rep; the **open string**
rings instead → a **mute_fail**. New target immediately, no count-in, no
transitions. Eight clean in a row graduates. The rep/streak/pass loop is the
**shared** engine, node-tested in `plugins/coaching/test/skill-drills.test.js`;
this file is a deliberately **thin reference skin** — swap it freely.

## Status / next

- ✅ Registers with the minigames SDK declaring `trains: ['mute_fail']` + `skill: 'muting'`, so `gamesForFailure('mute_fail')` resolves to it and coaching's "Drill muting" link launches it.
- ✅ Chart-free, self-paced, fast: scores muting off `sdk.scoring.createContinuous` (its own mic + YIN — no song, no lead-in). Each played note is an instant clean / mute-fail rep.
- ▢ Deferred: aim the target frets at the strings/frets from the fumbled passage the deep link carries (`skill`/`loopA`/`loopB`/`song` params) instead of the fixed E/A/D rotation.
- ▢ Deferred: a real skin (functional-but-plain on purpose) and rotating across all four strings / more frets.
