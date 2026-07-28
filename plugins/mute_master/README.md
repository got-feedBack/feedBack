# Mute Master

The first **skill-drill game** for Slopsmith — see
[`docs/TEACHING_NARRATIVE.md`](../../docs/TEACHING_NARRATIVE.md).

It trains **muting**: when the chart wants a fretted note, the open string must
not ring. coaching's practice taxonomy points a `mute_fail` hotspot here,
deep-linking into the passage you fumbled, and the game runs the **shared**
skill-drill mechanics (`createSkillDrill` / `skillDrillStep` / `skillDrillView`,
published by the coaching plugin and bridged through the minigames SDK as
`sdk.skillDrill`).

**How it actually scores (honest scope):** the game uses its **own**
self-contained *monophonic* pitch scorer (`scoring.createContinuous` — mic +
YIN), **not** the note_detect judgment stream — note_detect does not currently
emit a `mute_fail`, so the detector→`mute_fail` leg of the taxonomy is
aspirational. A mono detector can't truly prove an open string is silent, and
octave folding collapses pitch to pitch-class, so muting is only scoreable on
targets whose pitch class differs from every open string (E-string fret 5 =
open A, E-string fret 3 = open G an octave up, … are excluded). Treat the score
as a best-effort proxy; true mute verification needs a polyphonic/spectral
signal note_detect would have to produce.

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
