'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const crowd = require('../../static/v3/venue-crowd.js');

const H3D_JS = path.join(__dirname, '..', '..', 'plugins', 'highway_3d', 'screen.js');
const INDEX_HTML = path.join(__dirname, '..', '..', 'static', 'v3', 'index.html');
const SCENE_JS = path.join(__dirname, '..', '..', 'static', 'v3', 'venue-scene-3d.js');

test('perf state → crowd state mapping', () => {
    assert.equal(crowd.crowdStateOfPerf('smoke'), 'bored');
    assert.equal(crowd.crowdStateOfPerf('recovery'), 'bored');
    assert.equal(crowd.crowdStateOfPerf('idle'), 'neutral');
    assert.equal(crowd.crowdStateOfPerf('steady'), 'neutral');
    assert.equal(crowd.crowdStateOfPerf('strong'), 'engaged');
    assert.equal(crowd.crowdStateOfPerf('fire'), 'ecstatic');
    assert.equal(crowd.crowdStateOfPerf('FIRE'), 'ecstatic');
    assert.equal(crowd.crowdStateOfPerf('bogus'), 'neutral');
    assert.equal(crowd.crowdStateOfPerf(undefined), 'neutral');
});

test('machine: target must be stable for STABLE_MS before committing', () => {
    const m = crowd.createCrowdMachine();
    assert.equal(m.current, 'neutral');
    assert.equal(m.update('fire', 0), null);
    assert.equal(m.update('fire', crowd.STABLE_MS - 1), null);
    assert.equal(m.update('fire', crowd.STABLE_MS), 'ecstatic');
    assert.equal(m.current, 'ecstatic');
});

test('machine: flapping target restarts the stability window', () => {
    const m = crowd.createCrowdMachine();
    m.update('fire', 0);
    // Target changes → candidate resets.
    m.update('strong', 1000);
    assert.equal(m.update('strong', 1000 + crowd.STABLE_MS - 1), null);
    assert.equal(m.update('strong', 1000 + crowd.STABLE_MS), 'engaged');
});

test('machine: returning to current state clears the candidate', () => {
    const m = crowd.createCrowdMachine();
    m.update('fire', 0);
    m.update('steady', 1000); // back to neutral (current) — candidate dropped
    // 'fire' again must wait a full stability window from scratch.
    assert.equal(m.update('fire', 2000), null);
    assert.equal(m.update('fire', 2000 + crowd.STABLE_MS - 1), null);
    assert.equal(m.update('fire', 2000 + crowd.STABLE_MS), 'ecstatic');
});

test('machine: DWELL_MS enforced between switches', () => {
    const m = crowd.createCrowdMachine();
    m.update('fire', 0);
    assert.equal(m.update('fire', crowd.STABLE_MS), 'ecstatic'); // switch at t=3000
    const t = crowd.STABLE_MS;
    // Immediately drop to smoke: stable window passes but dwell hasn't.
    m.update('smoke', t + 1);
    assert.equal(m.update('smoke', t + 1 + crowd.STABLE_MS), null);
    // After the dwell expires the pending candidate commits.
    assert.equal(m.update('smoke', t + crowd.DWELL_MS), 'bored');
});

test('machine: multi-step jumps allowed (bored → ecstatic)', () => {
    const m = crowd.createCrowdMachine();
    m.update('smoke', 0);
    assert.equal(m.update('smoke', crowd.STABLE_MS), 'bored');
    const t = crowd.DWELL_MS + 1000;
    m.update('fire', t);
    assert.equal(m.update('fire', t + crowd.STABLE_MS), 'ecstatic');
});

test('stingerForStreak fires on rising milestone crossings only', () => {
    assert.equal(crowd.stingerForStreak(24, 25), 'cheer');
    assert.equal(crowd.stingerForStreak(0, 100), 'cheer');
    assert.equal(crowd.stingerForStreak(25, 26), null);
    assert.equal(crowd.stingerForStreak(50, 50), null);
    assert.equal(crowd.stingerForStreak(30, 0), null); // streak reset
});

test('stingerForAccuracy thresholds', () => {
    assert.equal(crowd.stingerForAccuracy(95), 'cheer');
    assert.equal(crowd.stingerForAccuracy(90), 'cheer');
    assert.equal(crowd.stingerForAccuracy(80), 'clap');
    assert.equal(crowd.stingerForAccuracy(75), 'clap');
    assert.equal(crowd.stingerForAccuracy(60), null);
    assert.equal(crowd.stingerForAccuracy('nope'), null);
    assert.equal(crowd.stingerForAccuracy(undefined), null);
});

test('normalizeManifest requires all four loops, resolves base', () => {
    assert.equal(crowd.normalizeManifest(null), null);
    assert.equal(crowd.normalizeManifest({}), null);
    assert.equal(crowd.normalizeManifest({ loops: { bored: 'b.mp4' } }), null);
    const m = crowd.normalizeManifest({
        base: '/api/plugins/career/venues/bar/',
        loops: { bored: 'bored.mp4', neutral: 'neutral.mp4', engaged: 'engaged.mp4', ecstatic: 'ecstatic.mp4' },
        stingers: { cheer: 'cheer.mp4' },
    });
    assert.equal(m.loops.ecstatic, '/api/plugins/career/venues/bar/ecstatic.mp4');
    assert.equal(m.stingers.cheer, '/api/plugins/career/venues/bar/cheer.mp4');
    assert.equal(m.stingers.clap, '');
});

test('highway_3d exposes the crowd backdrop globals', () => {
    const src = fs.readFileSync(H3D_JS, 'utf8');
    assert.match(src, /window\.h3dVenueBackdropSetVideo\s*=/);
    assert.match(src, /window\.h3dVenueBackdropSetMix\s*=/);
    // The venue style must own crowd plane teardown (VideoTexture dispose).
    assert.match(src, /_venueCrowdVideos/);
    assert.match(src, /_venueCrowdMix/);
});

test('index.html loads venue-crowd.js deferred, after venue-scene-3d.js', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const crowdIdx = html.indexOf('/static/v3/venue-crowd.js');
    const sceneIdx = html.indexOf('/static/v3/venue-scene-3d.js');
    assert.ok(crowdIdx > 0, 'venue-crowd.js script tag missing');
    assert.ok(crowdIdx > sceneIdx, 'venue-crowd.js must load after venue-scene-3d.js');
    assert.match(html, /<script defer src="\/static\/v3\/venue-crowd\.js"><\/script>/);
});

test('venue-scene-3d activates/deactivates the crowd layer', () => {
    const src = fs.readFileSync(SCENE_JS, 'utf8');
    assert.match(src, /syncCrowd\(true\)/);
    assert.match(src, /syncCrowd\(false\)/);
    assert.match(src, /v3VenueCrowd/);
});
