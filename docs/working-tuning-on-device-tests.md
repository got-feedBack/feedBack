# Working-tuning — on-device test checklist

The working-tuning series (PRs 1–9) ships with headless unit tests for every state
machine (`tests/js/working_tuning*.test.js`, `tests/js/tuner_auto_open.test.js`). The
items below are the parts that **cannot** be covered headlessly — they need a real mic,
a real instrument, and (for the ASIO item) a specific audio backend. Run these on a
build before shipping the feature to users.

Prereq: enable the opt-in in **Tuner → settings → "Auto-open on tuning change"** (it's
off by default). Have a guitar (and a bass, for the per-instrument checks) on hand.

## 1. Auto-open + gate ("tune before you play")
- [ ] Load a song whose tuning differs from your instrument's current tuning → the tuner
      **auto-opens** and playback **waits** (does not start underneath it).
- [ ] Load a song already covered by your tuning → **no** auto-open, playback starts.
- [ ] **Skip** ("I've tuned") → playback starts, and the tuner badge stops flagging this
      song's tuning (a working tuning was recorded).
- [ ] **Back to library** / **Esc** → leaves the song, records **nothing** (re-enter the
      same song → it still prompts).
- [ ] Take **longer than 12 s** to tune with the panel open → playback does **not** start
      underneath you (the fail-open backstop was settled once the panel opened).
- [ ] Hit **Play** manually while the panel is open → Play wins; no double-start.

## 2. Both-directions retune prompt
- [ ] From standard, load a Drop-C# song → prompted **down** (E→C#). Tune down, Skip.
- [ ] Now load a standard song → prompted **back up** (C#→E). (Pre-series, this direction
      was silent.)
- [ ] Switch guitar↔bass in the instrument card → each instrument remembers its **own**
      working tuning; the card label follows the selection (dim = home, amber = retuned).

## 3. Mic-verify (assumed → verified)
- [ ] With a selected (non-free) tuning, tap **Verify tuning** and play each string in tune.
      Each string needs ~8 stable in-tune frames (±6 ¢); the per-string progress advances.
- [ ] Play a string **out of tune** → it never completes; drifting out mid-streak resets it.
- [ ] Complete all strings → the instrument card's provenance glyph flips to the **filled**
      (verified) diamond, and the recorded working tuning carries the tuning you verified
      (not a stale one).
- [ ] Load the **next** song → the verified state **decays to assumed** (per-session only).
- [ ] Verify against a **manually-selected** tuning (tuner opened off a song) → the stamped
      offsets match that tuning, not the last song's.

## 4. Mic contention with note-detection (the ASIO / exclusive-mode risk)
This is the item flagged in the design charrette: the tuner's mic capture must not starve
note_detect's scoring input.
- [ ] Desktop, **ASIO / WASAPI-exclusive** device: auto-open the tuner mid-song, tune, Skip
      → scoring resumes cleanly; no dropped input, no device-in-use error, no crash.
- [ ] Shared/`auto` device: same flow → both the tuner and scoring read the mic without a
      stall.
- [ ] Leave the tuner's background badge audio running + start a scored song → note_detect
      still scores (the badge auto-start doesn't hold the device exclusively).

Log the build hash and OS/audio backend with results; file any failure against the
working-tuning series.
