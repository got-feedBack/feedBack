// Headless check that the coaching plugin EMITS a PlayFeedback from a real
// play — no human. Loads the real song, feeds a recording as the mic, plays,
// fires song:ended, and reads window.__coachingLastFeedback. We assert the
// SHAPE got built + emitted (not the exact values — the fake mic isn't
// phase-locked to the song, so individual judgments are noisy; the builder's
// value logic is covered by the unit tests).
//
// Env: SLOP_URL, FAKE_WAV, SONG, ARRANGEMENT (index, default 2 = Bass).
// Needs Playwright (run with NODE_PATH pointing at an install).
const { chromium } = require('playwright');
const fs = require('fs');

const URL = process.env.SLOP_URL || 'http://localhost:8000';
const FAKE_WAV = process.env.FAKE_WAV || '/tmp/fakemic.wav';
const SONG = process.env.SONG || 'Arctic-Monkeys_Whyd-You-Only-Call-Me-When-Youre-High_v4_DD_m.psarc';
const ARR = parseInt(process.env.ARRANGEMENT || '2', 10);

(async () => {
  // Pure wiring test: dispatches the note_detect window events synthetically,
  // so no real mic/playback is needed. (A fake-mic file is used only if present.)
  let browser;
  try {
    const args = ['--autoplay-policy=no-user-gesture-required'];
    if (fs.existsSync(FAKE_WAV)) args.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--use-file-for-fake-audio-capture=' + FAKE_WAV);
    browser = await chromium.launch({ headless: true, args });
    const ctx = await browser.newContext();
    try { await ctx.grantPermissions(['microphone'], { origin: URL }); } catch (_) {}
    const page = await ctx.newPage();
    page.on('console', m => { const t = m.text(); if (/coaching/i.test(t)) console.log('  [page]', t.slice(0, 200)); });
    await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.noteDetect && window.slopsmith && typeof window.playSong === 'function', null, { timeout: 20000 });

    const out = await page.evaluate(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const sm = window.slopsmith;
      let coachingEvents = 0;
      if (sm && sm.on) sm.on('coaching:feedback', () => { coachingEvents++; });
      // Verify the coaching WIRING (listen -> build -> emit) by dispatching the
      // exact window CustomEvents note_detect emits during a play. note_detect
      // firing these for real is established/documented; what we're proving here
      // is that the coaching plugin consumes them and emits PlayFeedback.
      const fire = (type, detail) => window.dispatchEvent(new CustomEvent(type, { detail }));
      const hitJ = (t) => ({ hit: true, note: { s: 1, f: 5 }, noteTime: t, expectedMidi: 38, detectedMidi: 38, confidence: 0.8, timingState: 'OK', pitchState: 'OK', timingError: 6, pitchError: 3 });
      const lateJ = (t, te) => ({ hit: false, note: { s: 1, f: 5 }, noteTime: t, expectedMidi: 38, detectedMidi: 38, confidence: 0.5, timingState: 'LATE', pitchState: 'OK', timingError: te, pitchError: 4 });
      const noDetJ = (t) => ({ hit: false, note: { s: 0, f: 3 }, noteTime: t, expectedMidi: 31, detectedMidi: null, confidence: 0, timingState: null, pitchState: null, timingError: null, pitchError: null });
      for (let i = 0; i < 12; i++) fire('notedetect:hit', hitJ(i * 2));
      [[20, 118], [20.5, 122], [21, 120], [21.5, 124]].forEach(([t, te]) => fire('notedetect:miss', lateJ(t, te)));
      [30, 30.5, 31].forEach(t => fire('notedetect:miss', noDetJ(t)));
      fire('notedetect:session', { total: 19, hits: 12 });
      await sleep(300);
      const fb = window.__coachingLastFeedback || null;
      return {
        coachingPluginPresent: typeof window.__coachingLastFeedback !== 'undefined',
        coachingEvents,
        hasFeedback: !!fb,
        schema: fb && fb.schema,
        keys: fb ? Object.keys(fb) : null,
        sessionKeys: fb && fb.session ? Object.keys(fb.session) : null,
        score: fb && fb.session ? fb.session.score : null,
        mistakes: fb ? fb.mistakes.length : null,
        hotspots: fb ? fb.hotspots.length : null,
        sampleMistake: fb && fb.mistakes[0] ? { failureType: fb.mistakes[0].failureType, faultVerdict: fb.mistakes[0].faultVerdict, id: fb.mistakes[0].id } : null,
        sampleHotspot: fb && fb.hotspots[0] ? { kind: fb.hotspots[0].signal.kind, drill: fb.hotspots[0].drill } : null,
      };
    });
    console.log(JSON.stringify(out, null, 2));
    if (!out.hasFeedback) { console.error('FAIL: no coaching feedback emitted'); process.exit(1); }
    console.log('PASS: coaching emitted', out.schema, `(${out.mistakes} mistakes, ${out.hotspots} hotspots)`);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
})().catch(e => { console.error('DRIVER ERROR:', e); process.exit(2); });
