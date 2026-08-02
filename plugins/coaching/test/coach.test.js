// LLM coach tests — the client-side Anthropic call that fills session.summary.
// Pure pieces (distill / build request / parse response) are tested directly;
// the one impure seam (requestCoaching) is tested with an injected fake fetch,
// so nothing here touches the network or needs a real key.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    buildPlayFeedback,
    summarizeForCoach, buildCoachRequest, parseCoachSummary, requestCoaching,
    COACH_MODEL, COACH_SUMMARY_SCHEMA,
    makeSettings, escapeHtml, renderSummaryHtml, renderFeedbackHtml,
    renderBreakdownHtml, renderMissedNotesHtml, renderTimingHtml,
    drillLadderFromSpeedMul, drillArgsFromDataset,
} = require('../coaching.js');

// Minimal Storage-like fake for settings tests.
function fakeStorage(seed) {
    const m = new Map(Object.entries(seed || {}));
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
        _map: m,
    };
}

function hit(t) {
    return { hit: true, note: { s: 1, f: 5 }, noteTime: t, expectedMidi: 38, detectedMidi: 38,
        confidence: 0.8, timingState: 'OK', pitchState: 'OK', timingError: 5, pitchError: 3 };
}
function lateMiss(t, te) {
    return { hit: false, note: { s: 1, f: 5 }, noteTime: t, expectedMidi: 38, detectedMidi: 38,
        confidence: 0.5, timingState: 'LATE', pitchState: 'OK', timingError: te, pitchError: 4 };
}
function noDetMiss(t) {
    return { hit: false, note: { s: 0, f: 3 }, noteTime: t, expectedMidi: 31, detectedMidi: null,
        confidence: 0, timingState: null, pitchState: null, timingError: null, pitchError: null };
}
function sampleFeedback() {
    const js = [];
    for (let i = 0; i < 20; i++) js.push(hit(i * 2));
    [[20, 118], [20.5, 122], [21, 120], [21.5, 124]].forEach(([t, te]) => js.push(lateMiss(t, te)));
    [30, 30.5, 31].forEach(t => js.push(noDetMiss(t)));
    return buildPlayFeedback(js, { song: 'Gasoline', arrangement: 'bass' });
}

// A well-formed Messages API response carrying the structured summary.
function apiOk(summary) {
    return { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(summary) }] };
}
const goodSummary = {
    headline: 'Strong run — one timing skew to chase.',
    priorities: [
        { focus: 'Bars around 0:20', why: 'consistent +120ms late', drill: 'Metronome at 70%', hotspotKey: 'Gasoline|bass|20-21' },
    ],
    toolNotes: 'The 0:20 skew looks systematic — check A/V calibration before drilling it.',
    encouragement: 'Great consistency overall, keep it up!',
};

test('summarizeForCoach surfaces the wrong-string signal (seSelf/seTop/seTopStr) on a miss', () => {
    // A no-detection miss on charted string 0, but the per-string energy shows
    // string 1 rang loudest → the coach should be handed "wrong string".
    const wrong = { hit: false, note: { s: 0, f: 3 }, noteTime: 42, expectedMidi: 31, detectedMidi: null,
        confidence: 0, timingState: null, pitchState: null, timingError: null, pitchError: null,
        stringEnergy: [0.1, 0.9, 0.2, 0.2] };
    const fb = buildPlayFeedback([hit(0), hit(2), wrong], { song: 'X', arrangement: 'bass' });
    const d = summarizeForCoach(fb);
    const note = d.mistakes.find((m) => m.t === 42);
    assert.ok(note, 'the miss is in the per-note stream');
    assert.equal(note.seSelf, 0.1, 'energy on the string the player should have hit');
    assert.equal(note.seTop, 0.9, 'loudest string energy');
    assert.equal(note.seTopStr, 1, 'loudest string was string 1 — not the charted string 0');
});

test('summarizeForCoach sends session + totals + hotspots + the per-note mistake stream', () => {
    const d = summarizeForCoach(sampleFeedback());
    assert.equal(d.schema, 'coaching.play_feedback.v1');
    assert.equal(d.session.song, 'Gasoline');
    assert.equal(d.totals.mistakes, 7);
    assert.equal(d.totals.byFailureType.late, 4);
    assert.equal(d.totals.byFailureType.no_detection, 3);
    assert.equal(d.totals.byFaultVerdict.detector_suspect, 3);
    assert.ok(Array.isArray(d.hotspots) && d.hotspots.length >= 1);
    assert.ok('signal' in d.hotspots[0] && 'drill' in d.hotspots[0]);
    // The LLM now reasons over the actual notes, not just counts.
    assert.ok(Array.isArray(d.mistakes) && d.mistakes.length === 7, 'per-note mistake stream sent');
    assert.ok('t' in d.mistakes[0] && 's' in d.mistakes[0] && 'type' in d.mistakes[0] && 'fault' in d.mistakes[0]);
    assert.ok(Array.isArray(d.missedNotes), 'missed-by-position grouping sent');
});

test('buildCoachRequest: model, cache_control on static system, structured-output schema, play data in user turn', () => {
    const req = buildCoachRequest(sampleFeedback());
    assert.equal(req.model, COACH_MODEL);
    assert.equal(req.system[0].cache_control.type, 'ephemeral');
    assert.deepEqual(req.output_config.format.schema, COACH_SUMMARY_SCHEMA);
    // distilled play data rides AFTER the cached system prefix
    assert.equal(req.messages[0].role, 'user');
    assert.match(req.messages[0].content, /play_feedback\.v1/);
    // model override honored
    assert.equal(buildCoachRequest(sampleFeedback(), { model: 'claude-haiku-4-5' }).model, 'claude-haiku-4-5');
});

test('summary schema stays within the structured-outputs supported subset', () => {
    const walk = (s) => {
        if (s.type === 'object') {
            assert.equal(s.additionalProperties, false, 'objects must set additionalProperties:false');
            for (const k of Object.keys(s.properties || {})) walk(s.properties[k]);
        } else if (s.type === 'array') {
            walk(s.items);
        }
        for (const banned of ['minLength', 'maxLength', 'minimum', 'maximum', 'multipleOf', 'minItems', 'maxItems']) {
            assert.ok(!(banned in s), 'unsupported keyword: ' + banned);
        }
    };
    walk(COACH_SUMMARY_SCHEMA);
});

test('parseCoachSummary: valid structured JSON', () => {
    const out = parseCoachSummary(apiOk(goodSummary));
    assert.equal(out.headline, goodSummary.headline);
    assert.equal(out.priorities.length, 1);
});

test('parseCoachSummary: recovers a fenced / prose-wrapped object', () => {
    const fenced = { stop_reason: 'end_turn', content: [{ type: 'text', text: '```json\n' + JSON.stringify(goodSummary) + '\n```' }] };
    assert.equal(parseCoachSummary(fenced).headline, goodSummary.headline);
});

test('parseCoachSummary: throws on refusal, error, missing fields, no text', () => {
    assert.throws(() => parseCoachSummary({ stop_reason: 'refusal', content: [] }), /refused/);
    assert.throws(() => parseCoachSummary({ type: 'error', error: { message: 'bad key' } }), /bad key/);
    assert.throws(() => parseCoachSummary(apiOk({ priorities: [] })), /required fields/);
    assert.throws(() => parseCoachSummary({ content: [{ type: 'thinking', thinking: 'x' }] }), /no text block/);
});

test('requestCoaching: posts with browser-direct headers, returns parsed summary, stamps model', async () => {
    let captured = null;
    const fakeFetch = async (url, init) => {
        captured = { url, init };
        return { ok: true, status: 200, json: async () => apiOk(goodSummary) };
    };
    const out = await requestCoaching(sampleFeedback(), { apiKey: 'sk-ant-test', fetchImpl: fakeFetch });
    assert.equal(out.headline, goodSummary.headline);
    assert.equal(out._model, COACH_MODEL);
    assert.match(captured.url, /api\.anthropic\.com\/v1\/messages/);
    assert.equal(captured.init.headers['x-api-key'], 'sk-ant-test');
    assert.equal(captured.init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.equal(captured.init.headers['anthropic-version'], '2023-06-01');
    const body = JSON.parse(captured.init.body);
    assert.equal(body.model, COACH_MODEL);
    assert.ok(body.output_config.format.schema);
});

test('requestCoaching: no key throws before any fetch', async () => {
    let called = false;
    await assert.rejects(
        requestCoaching(sampleFeedback(), { fetchImpl: async () => { called = true; return {}; } }),
        /no Anthropic API key/);
    assert.equal(called, false);
});

test('requestCoaching: surfaces 401 as an auth error', async () => {
    const fakeFetch = async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'invalid x-api-key' } }) });
    await assert.rejects(requestCoaching(sampleFeedback(), { apiKey: 'bad', fetchImpl: fakeFetch }), /auth failed/);
});

test('requestCoaching: surfaces 429 as rate-limit', async () => {
    const fakeFetch = async () => ({ ok: false, status: 429, json: async () => ({ error: { message: 'slow down' } }) });
    await assert.rejects(requestCoaching(sampleFeedback(), { apiKey: 'k', fetchImpl: fakeFetch }), /rate-limited/);
});

test('makeSettings: round-trips key/model, defaults, and enable semantics', () => {
    const st = fakeStorage();
    const s = makeSettings(st);
    // defaults with no key
    assert.equal(s.getApiKey(), null);
    assert.equal(s.getModel(), COACH_MODEL);
    assert.equal(s.isEnabled(), false, 'no key → disabled even if flag unset');
    // set a key → enabled by default
    s.setApiKey('sk-ant-xyz');
    assert.equal(s.getApiKey(), 'sk-ant-xyz');
    assert.equal(s.isEnabled(), true, 'key present + flag unset → enabled');
    // explicit opt-out
    s.setEnabled(false);
    assert.equal(s.isEnabled(), false);
    s.setEnabled(true);
    assert.equal(s.isEnabled(), true);
    // model override + clear
    s.setModel('claude-haiku-4-5');
    assert.equal(s.getModel(), 'claude-haiku-4-5');
    s.setModel('');
    assert.equal(s.getModel(), COACH_MODEL, 'empty model clears back to default');
    // clearing the key
    s.setApiKey('');
    assert.equal(s.getApiKey(), null);
    assert.equal(st.getItem('coaching.anthropicApiKey'), null);
});

test('makeSettings: tolerates a null storage (private mode / no localStorage)', () => {
    const s = makeSettings(null);
    assert.doesNotThrow(() => s.setApiKey('x'));
    assert.equal(s.getApiKey(), null);
    assert.equal(s.getModel(), COACH_MODEL);
    assert.equal(s.isEnabled(), false);
});

test('escapeHtml: neutralizes angle brackets, quotes, ampersands', () => {
    assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(escapeHtml('a & "b" \'c\''), 'a &amp; &quot;b&quot; &#39;c&#39;');
    assert.equal(escapeHtml(null), '');
});

test('renderSummaryHtml: includes fields and escapes untrusted model text', () => {
    const html = renderSummaryHtml({
        headline: 'Nice <b>run</b>',
        priorities: [{ focus: 'Bars 0:20', why: 'late', drill: 'metronome', hotspotKey: 'Gasoline|bass|20-21' }],
        toolNotes: 'check A/V',
        encouragement: 'keep going',
    });
    assert.match(html, /Nice &lt;b&gt;run&lt;\/b&gt;/, 'headline escaped, no raw tags');
    assert.ok(!/<b>run<\/b>/.test(html), 'no unescaped tag leaks through');
    assert.match(html, /Bars 0:20/);
    assert.match(html, /metronome/);
    assert.match(html, /Gasoline\|bass\|20-21/);
    assert.match(html, /check A\/V/);
    assert.match(html, /keep going/);
});

test('renderSummaryHtml: safe on empty/partial summary', () => {
    assert.match(renderSummaryHtml({}), /Practice plan/);
    assert.doesNotThrow(() => renderSummaryHtml(null));
    assert.doesNotThrow(() => renderSummaryHtml({ priorities: [{}] }));
});

test('renderFeedbackHtml: no-key panel shows score + a Practice button per hotspot', () => {
    const fb = {
        session: { score: 0.62 },
        hotspots: [{
            key: 'Gasoline|bass|20-21',
            bounds: { startSec: 20, endSec: 22 },
            evidence: { noteCount: 4, missRate: 0.75 },
            signal: { kind: 'random' },
            drill: { loopA: 18.5, loopB: 23, speedMul: 0.7, goal: 0.85 },
        }],
    };
    const html = renderFeedbackHtml(fb);
    assert.match(html, /Practice spots/);
    assert.match(html, /62% clean/);
    assert.match(html, /coaching-drill-btn/, 'drill button present without any LLM summary');
    assert.match(html, /data-loop-a="18\.5"/);
    assert.match(html, /0:20–0:22/, 'mm:ss range');
    assert.match(html, /4 notes/);
});

test('buildPlayFeedback: two-score split separates tool-fault from player-fault', () => {
    const js = [];
    for (let i = 0; i < 8; i++) js.push({ hit: true, noteTime: i, note: { s: 1, f: 5 }, expectedMidi: 45, detectedMidi: 45 });
    js.push({ hit: false, noteTime: 8, note: { s: 1, f: 5 }, expectedMidi: 45, detectedMidi: 45, timingState: 'LATE', timingError: 130 });
    for (const t of [9, 10, 11]) js.push({ hit: false, noteTime: t, note: { s: 0, f: 3 }, expectedMidi: 31, detectedMidi: null });
    const fb = buildPlayFeedback(js, { song: 'Gasoline', arrangement: 'bass' });
    const s = fb.session;
    // hits=8, player-fault=1 (late), tool-fault=3 (unheard). heard=9, total=12.
    assert.equal(s.faultSplit.player, 1);
    assert.equal(s.faultSplit.detector, 3);
    assert.equal(s.playerAccuracy, Math.round((8 / 9) * 1000) / 1000);     // of verifiable notes
    assert.equal(s.detectionCoverage, Math.round((9 / 12) * 1000) / 1000); // of all notes
    assert.equal(s.score, Math.round((8 / 12) * 1000) / 1000);             // legacy stays hits/total
    assert.equal(s.missByType.late, 1);
    assert.equal(s.missByType.no_detection, 3);
});

test('renderSummaryHtml: LLM loops render as drillable Practice buttons', () => {
    const summary = {
        headline: 'Solid', priorities: [], toolNotes: '', encouragement: 'nice',
        loops: [{ label: 'Chorus run', startSec: 100, endSec: 115, speedMul: 0.7, goal: 0.9 }],
    };
    const html = renderSummaryHtml(summary, []);
    assert.match(html, /Drill loops/);
    assert.match(html, /Chorus run/);
    assert.match(html, /1:40.1:55/);
    assert.match(html, /data-loop-a="100"/);
    assert.match(html, /data-loop-b="115"/);
    assert.match(html, /coaching-drill-btn/);
});

test('renderMissedNotesHtml: groups missed notes by string/fret with counts', () => {
    const js = [];
    for (let i = 0; i < 5; i++) js.push({ hit: true, noteTime: i, note: { s: 1, f: 5 }, expectedMidi: 38, detectedMidi: 38 });
    for (const t of [9, 10, 11]) js.push({ hit: false, noteTime: t, note: { s: 0, f: 5 }, expectedMidi: 33, detectedMidi: null }); // A1 x3
    js.push({ hit: false, noteTime: 12, note: { s: 0, f: 2 }, expectedMidi: 30, detectedMidi: null }); // F#1 x1
    const fb = buildPlayFeedback(js, { song: 'Whyd', arrangement: 'bass' });
    const html = renderMissedNotesHtml(fb);
    assert.match(html, /What you missed/);
    assert.match(html, /A1/);
    assert.match(html, /E string . fret 5/);
    assert.match(html, /F#1/);
    assert.ok(html.indexOf('A1') < html.indexOf('F#1'), 'most-missed first');
    assert.equal(renderMissedNotesHtml({ mistakes: [] }), '');
});

test('renderBreakdownHtml: shows both scores, the tool-fault verdict, and an Unheard bar', () => {
    const js = [];
    for (let i = 0; i < 8; i++) js.push({ hit: true, noteTime: i, note: { s: 1, f: 5 }, expectedMidi: 45, detectedMidi: 45 });
    for (const t of [9, 10, 11]) js.push({ hit: false, noteTime: t, note: { s: 0, f: 3 }, expectedMidi: 31, detectedMidi: null });
    const fb = buildPlayFeedback(js, { song: 'Gasoline', arrangement: 'bass' });
    const html = renderBreakdownHtml(fb);
    assert.match(html, /played clean/);
    assert.match(html, /detector heard/);
    assert.match(html, /Tool, not you/, 'tool-fault dominant verdict');
    assert.match(html, /Unheard/);
    assert.match(html, /G1/, 'names the dropped low pitch');
    // Pre-split feedback (legacy shape) renders nothing.
    assert.equal(renderBreakdownHtml({ session: { score: 0.5 } }), '');
});

test('findHotspots: loosely-spread misses (a sloppy 75% play) still surface a hotspot', () => {
    // 20 notes every 2s; miss every other one from t=20 (misses ~4s apart in
    // pairs ~2s where adjacent) — the old 3-within-2s rule found nothing.
    const js = [];
    for (let i = 0; i < 10; i++) js.push({ hit: true, noteTime: i * 2, note: { s: 1, f: 0 }, expectedMidi: 40 });
    // Two misses 3s apart — a phrase flubbed twice. Under the new 2-within-3s
    // rule this is a hotspot; under the old rule it was invisible. These are
    // PLAYER faults (late) — hotspots cluster player faults, not unheard
    // dropouts.
    [{ t: 21 }, { t: 24 }].forEach(({ t }) =>
        js.push({ hit: false, noteTime: t, note: { s: 1, f: 5 }, expectedMidi: 45, detectedMidi: 45, timingState: 'LATE', timingError: 130 }));
    const fb = buildPlayFeedback(js, { song: 'Oxygen', arrangement: 'bass' });
    assert.ok(fb.hotspots.length >= 1, 'a 2-miss spread now yields a hotspot');
});

test('buildPlayFeedback: loose hits (sloppy-but-hit) cluster into looseHotspots and drop cleanRate', () => {
    // A note_detect hit that graded NOT clean: still hit:true, but clean:false
    // with a looseReason. The detector heard it — it's a tightness gap.
    function looseHit(t, te, reason) {
        return { hit: true, clean: false, looseReason: reason, note: { s: 1, f: 5 },
            noteTime: t, expectedMidi: 38, detectedMidi: 38, confidence: 0.8,
            timingState: 'OK', pitchState: 'OK', timingError: te, pitchError: 4 };
    }
    const js = [];
    // 12 tight hits scattered, then a run of consistently-late-but-hit notes.
    for (let i = 0; i < 12; i++) js.push(hit(i));
    [13, 13.6, 14.2, 14.8, 15.4].forEach(t => js.push(looseHit(t, 70, 'timing')));
    const fb = buildPlayFeedback(js, { song: 'Tight', arrangement: 'bass' });

    // Loose hits never become misses (they ARE hits) — so accuracy stays high…
    assert.equal(fb.mistakes.length, 0, 'loose hits are not misses');
    assert.equal(fb.session.playerAccuracy, 1, 'all notes hit');
    // …but cleanRate exposes the sloppiness, and a looseHotspot is raised.
    assert.equal(fb.session.looseHits, 5, 'five loose hits counted');
    assert.ok(fb.session.cleanRate < 0.8, `cleanRate reflects loose hits (got ${fb.session.cleanRate})`);
    assert.ok(fb.looseHotspots.length >= 1, 'the loose run surfaces a looseHotspot');
    assert.equal(fb.looseHotspots[0].kind, 'loose');
    assert.ok(fb.looseHotspots[0].practice, 'looseHotspot carries a drill recommendation');
});

test('buildPlayFeedback: timing report buckets heard notes and calls consistent drag', () => {
    const js = [];
    // 12 heard notes, all ~+35ms behind the beat → a DRAG verdict.
    for (let i = 0; i < 12; i++) js.push({ hit: true, note: { s: 1, f: 5 }, noteTime: i,
        expectedMidi: 38, detectedMidi: 38, confidence: 0.8, timingState: 'OK', pitchState: 'OK', timingError: 35, pitchError: 2 });
    const fb = buildPlayFeedback(js, { song: 'X', arrangement: 'bass' });
    assert.ok(fb.timing, 'timing report attached');
    assert.equal(fb.timing.count, 12);
    assert.equal(fb.timing.verdict.kind, 'drag');
    assert.equal(fb.timing.median, 35);
    const html = renderTimingHtml(fb);
    assert.match(html, /Timing/);
    assert.match(html, /DRAG/);
});

test('buildPlayFeedback: too few timing samples → no report, empty render', () => {
    const fb = buildPlayFeedback([{ hit: true, note: { s: 1, f: 5 }, noteTime: 0, timingError: 5, timingState: 'OK' }], {});
    assert.equal(fb.timing, null);
    assert.equal(renderTimingHtml(fb), '');
});

test('buildPlayFeedback: a clean take has cleanRate 1 and no looseHotspots', () => {
    const js = [];
    for (let i = 0; i < 10; i++) js.push({ ...hit(i), clean: true });
    const fb = buildPlayFeedback(js, { song: 'Clean', arrangement: 'bass' });
    assert.equal(fb.session.cleanRate, 1);
    assert.equal(fb.session.looseHits, 0);
    assert.equal(fb.looseHotspots.length, 0);
});

test('renderFeedbackHtml: a play with spread misses says consistency, not "nice"', () => {
    // No cluster (misses far apart) but several of them — honest message.
    const fb = { session: { score: 0.75 }, mistakes: [{}, {}, {}, {}], hotspots: [] };
    const html = renderFeedbackHtml(fb);
    assert.match(html, /4 misses/);
    assert.match(html, /consistency/);
    assert.ok(!/nice/.test(html), 'no "nice" when there are real misses');
});

test('renderFeedbackHtml: a non-clean play with zero recorded misses says "no notes scored", not "nice"', () => {
    // The 0%-clean-but-no-mistakes case: nothing was judged. Must NOT say nice.
    const html = renderFeedbackHtml({ session: { score: 0 }, mistakes: [], hotspots: [] });
    assert.match(html, /No notes were scored/);
    assert.ok(!/nice/.test(html), 'no false "nice" at 0% with no data');
});

test('renderFeedbackHtml: clean play and empty/degenerate input are safe', () => {
    assert.match(renderFeedbackHtml({ session: { score: 1 }, hotspots: [] }), /No recurring trouble spots/);
    assert.doesNotThrow(() => renderFeedbackHtml(null));
    assert.doesNotThrow(() => renderFeedbackHtml({}));
    // A hotspot with a degenerate drill range renders the row but no button.
    const html = renderFeedbackHtml({ hotspots: [{ key: 'k', bounds: { startSec: 5, endSec: 6 }, evidence: {}, drill: { loopA: 5, loopB: 5 } }] });
    assert.ok(!/coaching-drill-btn/.test(html), 'no button for an unusable drill range');
});

test('renderFeedbackHtml: flags a systematic hotspot as possible calibration', () => {
    const html = renderFeedbackHtml({
        hotspots: [{ key: 'k', bounds: { startSec: 1, endSec: 2 }, evidence: { noteCount: 3, missRate: 0.9 },
                     signal: { kind: 'systematic' }, drill: { loopA: 0, loopB: 3, speedMul: 0.7, goal: 0.85 } }],
    });
    assert.match(html, /systematic/);
});

test('drillArgsFromDataset: parses a Practice button into startDrill args', () => {
    const args = drillArgsFromDataset({
        loopA: '18.5', loopB: '22', speedMul: '0.7', goal: '0.85',
        focus: 'Bars 0:20', key: 'Gasoline|bass|20-21',
    });
    assert.equal(args.start, 18.5);
    assert.equal(args.end, 22);
    assert.equal(args.opts.label, 'Gasoline|bass|20-21');
    assert.equal(args.opts.focus, 'Bars 0:20');
    assert.equal(args.opts.goal, 0.85);
    assert.deepEqual(args.opts.speedLadder, [0.7, 0.85, 1.0]);
});

test('drillArgsFromDataset: null when the range is unusable; goal defaults when absent', () => {
    assert.equal(drillArgsFromDataset({ loopB: '22' }), null, 'missing loopA → null');
    assert.equal(drillArgsFromDataset({ loopA: 'x', loopB: '22' }), null, 'non-numeric loopA → null');
    assert.equal(drillArgsFromDataset(null), null, 'no dataset → null');
    // No goal attr → undefined so startDrill applies its own default. Label
    // falls back to focus, then 'Hotspot'.
    const a = drillArgsFromDataset({ loopA: '1', loopB: '3' });
    assert.equal(a.opts.goal, undefined);
    assert.equal(a.opts.label, 'Hotspot');
    assert.deepEqual(a.opts.speedLadder, [0.7, 0.85, 1.0], 'junk speedMul → default ladder');
});

test('drillLadderFromSpeedMul: ascending ladder slow → full, defaults on junk', () => {
    assert.deepEqual(drillLadderFromSpeedMul(0.7), [0.7, 0.85, 1.0]);
    assert.deepEqual(drillLadderFromSpeedMul(0.5), [0.5, 0.75, 1.0]);
    // >=1 / 0 / NaN / negative all fall back to the 0.7 base.
    assert.deepEqual(drillLadderFromSpeedMul(1.0), [0.7, 0.85, 1.0]);
    assert.deepEqual(drillLadderFromSpeedMul(0), [0.7, 0.85, 1.0]);
    assert.deepEqual(drillLadderFromSpeedMul(NaN), [0.7, 0.85, 1.0]);
    assert.deepEqual(drillLadderFromSpeedMul(-0.5), [0.7, 0.85, 1.0]);
});

test('renderSummaryHtml: a priority mapped to a drillable hotspot sprouts a Practice button', () => {
    const summary = {
        headline: 'Plan',
        priorities: [{ focus: 'Bars 0:20', why: 'late', drill: 'metronome', hotspotKey: 'Gasoline|bass|20-21' }],
    };
    const hotspots = [{
        key: 'Gasoline|bass|20-21',
        drill: { loopA: 18.5, loopB: 22.0, speedMul: 0.7, goal: 0.85 },
    }];
    const html = renderSummaryHtml(summary, hotspots);
    assert.match(html, /coaching-drill-btn/, 'button rendered for the matched hotspot');
    assert.match(html, /data-loop-a="18\.5"/);
    assert.match(html, /data-loop-b="22"/);
    assert.match(html, /data-goal="0\.85"/);
    assert.match(html, /Practice this/);
});

test('renderSummaryHtml: no button without hotspots (backward-compatible) or on key mismatch / bad range', () => {
    const summary = {
        priorities: [{ focus: 'Bars 0:20', why: 'late', drill: 'metronome', hotspotKey: 'Gasoline|bass|20-21' }],
    };
    // No hotspots arg at all — the original one-arg call site.
    assert.ok(!/coaching-drill-btn/.test(renderSummaryHtml(summary)));
    // Key mismatch.
    assert.ok(!/coaching-drill-btn/.test(renderSummaryHtml(summary, [{ key: 'other', drill: { loopA: 1, loopB: 2, speedMul: 0.7, goal: 0.85 } }])));
    // Degenerate range (loopB <= loopA) is not drillable.
    assert.ok(!/coaching-drill-btn/.test(renderSummaryHtml(summary, [{ key: 'Gasoline|bass|20-21', drill: { loopA: 5, loopB: 5, speedMul: 0.7, goal: 0.85 } }])));
});
