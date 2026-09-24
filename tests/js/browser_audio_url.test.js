const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../../static/js/browser-audio-url.js'), 'utf8');
const context = { URLSearchParams };
vm.createContext(context);
vm.runInContext(source.replace('export function', 'function'), context);
const url = context.browserAudioUrl;

test('only core Ogg browser URLs request a PCM copy', () => {
    assert.equal(url('/audio/song.ogg'), '/audio/song.ogg?playback=pcm');
    assert.equal(url('/api/sloppak/My%20Song.feedpak/file/stems/full.ogg'),
        '/api/sloppak/My%20Song.feedpak/file/stems/full.ogg?playback=pcm');
    for (const unchanged of [null, '', '/audio/song.wav', '/audio/song.mp3',
        'blob:recording', 'https://example.com/song.ogg', '/api/plugins/stems/song.ogg']) {
        assert.equal(url(unchanged), unchanged);
    }
});

test('preserves query and fragment and does not accumulate flags', () => {
    const input = '/audio/song.ogg?v=3#part';
    const expected = '/audio/song.ogg?v=3&playback=pcm#part';
    assert.equal(url(input), expected);
    assert.equal(url(expected), expected);
});

for (const support of ['probably', 'maybe', '', 'no']) {
    test(`selects a supported format (canPlayType=${JSON.stringify(support)})`, () => {
        let probes = 0;
        const browser = { URLSearchParams, document: { createElement(tag) {
            probes++;
            assert.equal(tag, 'audio');
            return { canPlayType(type) {
                assert.equal(type, 'audio/webm; codecs="vorbis"');
                return support;
            } };
        } } };
        vm.createContext(browser);
        vm.runInContext(source.replace('export function', 'function'), browser);
        const format = ['probably', 'maybe'].includes(support) ? 'webm' : 'pcm';
        assert.equal(browser.browserAudioUrl('/audio/song.ogg?v=3#part'),
            `/audio/song.ogg?v=3&playback=${format}#part`);
        assert.equal(browser.browserAudioUrl(`/audio/song.OGG?playback=${format}`),
            `/audio/song.OGG?playback=${format}`);
        assert.equal(browser.browserAudioUrl('/api/sloppak/song.feedpak/file/full.oga'),
            `/api/sloppak/song.feedpak/file/full.oga?playback=${format}`);
        assert.equal(browser.browserAudioUrl('/audio/song.opus'), `/audio/song.opus?playback=${format}`);
        assert.equal(probes, 1, 'capability probe is cached');
    });
}
