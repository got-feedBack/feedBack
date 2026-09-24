// Browser-only playback copy. Keep song metadata, native JUCE paths, downloads,
// and plugin stem URLs pointing at the original recording.
let supportsVorbisWebm;

/** Select a seek-stable browser copy for local Ogg audio URLs. */
export function browserAudioUrl(url) {
    if (typeof url !== 'string') return url;
    const [pathAndQuery, fragment] = url.split('#', 2);
    const [path, query = ''] = pathAndQuery.split('?', 2);
    if (!/^\/(?:audio\/|api\/sloppak\/).+\.(?:ogg|oga|opus)$/i.test(path)) return url;
    if (supportsVorbisWebm === undefined) {
        const support = typeof document !== 'undefined'
            ? document.createElement('audio').canPlayType('audio/webm; codecs="vorbis"') : '';
        supportsVorbisWebm = support === 'probably' || support === 'maybe';
    }
    const params = new URLSearchParams(query);
    params.set('playback', supportsVorbisWebm ? 'webm' : 'pcm');
    return path + '?' + params.toString() + (fragment === undefined ? '' : '#' + fragment);
}
