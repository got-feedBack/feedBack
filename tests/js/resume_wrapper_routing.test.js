// Resume-through-a-playSong-wrapper regression (feedBack#74 review finding).
//
// resumeLastSession() calls window.playSong(...) instead of the bare session.js
// binding, specifically so playSong-wrapping plugins (splitscreen, section_map,
// ...) observe resume loads like any other fresh play. But every real wrapper in
// the ecosystem forwards only (filename, arrangement) to the next link in the
// chain and drops the options object — so options.resume never survives the
// wrapper hop. Without a fix, core's own playSong() would then see
// options === undefined and clobber S.pendingResume to null on the very call
// meant to restore it: resume plays from the top, and the snapshot consumption
// throws away the only copy of the saved position.
//
// The fix has two halves that only work together:
//   1. resume-session.js pre-arms S.pendingResume directly, synchronously,
//      immediately before calling window.playSong — nothing else can touch
//      S.pendingResume in between (single JS thread, no intervening await at
//      that callsite) — tagged with `f` (the resumed filename).
//   2. session.js's playSong() preserves an already-armed S.pendingResume
//      instead of nulling it when its own options.resume is absent, but ONLY
//      when its `f` tag matches the filename actually being loaded.
//
// The filename tag closes a second bug caught in review of the first fix:
// playSong() never awaits chart readiness before resolving, so a WS-level
// load failure for the resumed song neither rejects resumeLastSession()'s
// call (its catch never runs) nor clears S.pendingResume — nothing else does
// either, since consumption only happens at song:ready. Without the tag, a
// stale armed value from that failed resume would be silently inherited by
// the next unrelated fresh play (a library click, transport start — anything
// else routed through window.playSong) and seek THAT song to the old one's
// saved position with autostart suppressed.
//
// A THIRD bug, caught in review of the filename-tag fix: a bare filename
// match isn't unique enough either. If THIS resume's own load is the one
// that stalls, a LATER *normal* play of the SAME filename (no resume intent
// at all — a plain library re-click) also matches on `f` and would wrongly
// inherit the stale position. S._pendingResumeArmed is a one-shot gate:
// resume-session.js sets it true in the same synchronous span as the arm,
// and playSong() consumes it (forces it false) the first time ANY call
// reads it — matched or not — so it can only ever satisfy the single call
// it was armed for, never a later unrelated one.
//
// This can't be exercised as a headless unit test (playSong() is deeply coupled
// to the DOM/audio element/highway instance) — the behavioral case lives in
// tests/browser/resume-session.spec.ts's "...through a playSong wrapper that
// drops options" test, run via Playwright (not part of the node --test CI job).
// This file pins the static shape of the fix itself, in the spirit of
// host_contract.test.js, so CI catches a regression even though the behavioral
// test isn't wired into it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const RESUME_SESSION_JS = fs.readFileSync(path.join(ROOT, 'static', 'js', 'resume-session.js'), 'utf8');
const SESSION_JS = fs.readFileSync(path.join(ROOT, 'static', 'js', 'session.js'), 'utf8');

test('resumeLastSession() pre-arms S.pendingResume, tagged with the resumed filename, before (not after) calling window.playSong', () => {
    const fnStart = RESUME_SESSION_JS.indexOf('export async function resumeLastSession');
    assert.ok(fnStart >= 0, 'resumeLastSession() not found in resume-session.js');
    const fnEnd = RESUME_SESSION_JS.indexOf('\n}', fnStart);
    const body = RESUME_SESSION_JS.slice(fnStart, fnEnd);

    const resumeObjMatch = body.match(/const resume = \{[^}]*\};/);
    assert.ok(resumeObjMatch, 'resumeLastSession() must build a `resume` object');
    assert.ok(
        /\bf:\s*snap\.f\b/.test(resumeObjMatch[0]),
        'the armed `resume` object must be tagged with `f: snap.f` — without it, a stale pre-armed '
        + 'value from a resume whose chart never reached song:ready would be indistinguishable from '
        + 'one that legitimately belongs to the next, unrelated fresh play',
    );

    const armIdx = body.indexOf('S.pendingResume = resume;');
    const gateIdx = body.indexOf('S._pendingResumeArmed = true;');
    const callIdx = body.indexOf('await window.playSong(snap.f, snap.a, { resume });');
    assert.ok(armIdx >= 0, 'resumeLastSession() must pre-arm S.pendingResume before calling window.playSong');
    assert.ok(gateIdx >= 0, 'resumeLastSession() must set S._pendingResumeArmed = true — the one-shot gate '
        + 'that stops a stale filename match from leaking onto a later, unrelated play of the same song');
    assert.ok(callIdx >= 0, 'resumeLastSession() must call window.playSong(snap.f, snap.a, { resume })');
    assert.ok(
        armIdx < callIdx && gateIdx < callIdx,
        'S.pendingResume and S._pendingResumeArmed must both be set BEFORE the window.playSong call, not '
        + 'after — setting them after the call is too late for a wrapper-forwarded invocation to see them',
    );

    // No await between the two — an intervening await would give something else
    // a chance to run and touch S.pendingResume before playSong() reads it,
    // breaking the single-threaded guarantee the fix relies on.
    const between = body.slice(armIdx, callIdx);
    assert.ok(
        !/\bawait\b/.test(between),
        'no `await` may appear between arming S.pendingResume and calling window.playSong — '
        + 'that gap is what makes the pre-arm race-free',
    );
});

test("session.js's playSong() preserves a pre-armed S.pendingResume instead of clobbering it to null, but only when it's tagged for the song being loaded", () => {
    const fnStart = SESSION_JS.indexOf('export async function playSong(');
    assert.ok(fnStart >= 0, 'playSong() not found in session.js');
    // The pendingResume/_pendingAutostart decision sits in the first ~150 lines
    // of the function body; bound the search so a match elsewhere in the file
    // (there is none today, but this is a source-scan, not a parser) can't
    // produce a false pass.
    const body = SESSION_JS.slice(fnStart, fnStart + 8000);

    const optionsArmMatch = body.match(/if\s*\(\s*options\s*&&\s*options\.resume[\s\S]*?\)\s*\{([\s\S]*?)\}\s*else if/);
    assert.ok(optionsArmMatch, 'playSong() must have an `if (options && options.resume ...)` branch');
    assert.ok(
        /S\.pendingResume\s*=\s*options\.resume;/.test(optionsArmMatch[1]),
        'playSong() must still arm S.pendingResume from options.resume when present',
    );
    assert.ok(
        /S\._pendingResumeArmed\s*=\s*false;/.test(optionsArmMatch[1]),
        'the options.resume branch must also clear S._pendingResumeArmed defensively — otherwise a stale '
        + '`true` left by an earlier stalled wrapped resume could combine with a later, unrelated wrapped '
        + 'resume of a coincidentally-matching filename and wrongly preserve',
    );

    const preserveMatch = body.match(/else if\s*\(\s*S\.pendingResume\s*&&\s*S\._pendingResumeArmed\s*&&\s*S\.pendingResume\.f\s*===\s*filename\s*&&\s*Number\(S\.pendingResume\.position\)\s*>\s*0\s*\)\s*\{([\s\S]*?)\}/);
    assert.ok(
        preserveMatch,
        'playSong() must have an `else if (S.pendingResume && S._pendingResumeArmed && S.pendingResume.f '
        + '=== filename && ...)` branch between the options.resume branch and the final else — preserving '
        + 'a pre-armed resume request that a wrapper dropped from options, but ONLY when it is both tagged '
        + 'for the filename actually being loaded AND the one-shot gate is still armed. Filename alone '
        + 'isn\'t enough: without the gate, a resume whose chart never reached song:ready would leak its '
        + 'stale position onto a LATER, unrelated normal play of the same filename',
    );
    assert.ok(
        !/S\.pendingResume\s*=[^=]/.test(preserveMatch[1]),
        'the branch preserving a pre-armed S.pendingResume must not itself reassign it — that would '
        + 'defeat the whole point of preserving it',
    );
    assert.ok(
        /S\._pendingResumeArmed\s*=\s*false;/.test(preserveMatch[1]),
        'the preserve branch must consume the one-shot gate (set S._pendingResumeArmed = false) so it '
        + 'can never satisfy a second, later call',
    );

    const finalElseMatch = body.match(/\}\s*else\s*\{\s*S\.pendingResume\s*=\s*null;/);
    assert.ok(finalElseMatch, 'playSong() must still null S.pendingResume on a genuine fresh (non-resume) play');
});
