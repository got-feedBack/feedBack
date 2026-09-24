# Browser seek synchronization

## Reproduction and scope

Reported on macOS, Chrome 153.0.8010.50, built-in speakers, Docker-hosted
feedBack. The affected HTML audio transport is shared across visualizations.
Clicking a section or pressing Left/Right triggers the problem reliably;
pause/resume alone is not established as its cause. The user reports roughly
100 ms, with -100 ms A/V compensation making it appear aligned.

The active transport is HTMLAudioElement, not JUCE. Both section navigation and
arrow keys reach `_audioSeek`, which sets the element's `currentTime`. The
visualization's clock follows the host sample; measurements showed normal
sub-frame sampling lag, not a persistent extra 100 ms in the renderer.

## Audio-level evidence

The diagnostic `scripts/check-browser-seek.cjs` compares emitted PCM against a
full decode of the same recording. It first plays continuously (without seeking)
to establish a baseline, then seeks forward/backward and pauses/resumes. It
correlates actual sample blocks, not merely two JavaScript clock readings.
Audio is observed before the speaker output; this measures **seek-dependent
changes**, not acoustic/device latency. An absolute probe offset is not an A/V
calibration value.

Initial probes of the original Ogg recordings showed a repeatable ~21.3 ms
change after seeking in Chromium 151, with additional inconsistent seek results
in Chrome 153. The committed probe on the original The Bad Touch Ogg measured
8.285 ms continuously, -50.025 ms after seeking to 30 seconds, and about
-13.1 ms after seeking to 90/100 seconds. At 20 seconds no reliable match was
found in the search window, so that run correctly reported itself inconclusive
rather than declaring a precise offset. The user's full 100 ms acoustic discrepancy has not been measured
directly. Therefore it should not be presented as a proven universal constant.

The patched server's decoded WAV, tested in Chrome 153 with The Bad Touch,
produced the following PCM-relative offsets (ms): continuous 8.220; seeks to
30/90/20/100 seconds: 8.308 / 8.167 / 8.282 / 8.068; pause/resume 8.166.
The spread was **0.24 ms**. This removes the reproduced compressed-seek error
without inserting a hard-coded -100 ms offset or changing chart timestamps.

## Smaller lossless workaround

Follow-up tests in Chrome 153.0.8010.53 isolated the Ogg container path:
fully preloading the Ogg as a Blob, remuxing into another Ogg, and re-encoding
with libvorbis all retained seek-dependent errors. Standalone FFmpeg 8.1 and
9.0.2 sought the original Ogg sample-accurately at all four test positions.

Stream-copying the same Vorbis packets into WebM gave 0.67 ms offset spread for
The Bad Touch and 0.73 ms for Do I Wanna Know, each measured against the original
fully decoded WAV reference. Both WebM files decoded to exactly the same PCM
sample count and SHA256 as their respective originals. The Bad Touch went from
5.22 MB Ogg to 5.28 MB WebM, compared with 52.12 MB WAV.

This points to Chrome's Ogg timestamp/decoder-priming interaction, not an
inherently unseekable codec. The exact Chromium defect remains unproven.
The repeated 21.33 ms shift corresponds to 1,024 samples at 48 kHz; it is not
proof of the user's entire reported 100 ms acoustic offset.

## Fix

Core HTML5 playback checks `canPlayType('audio/webm; codecs="vorbis"')` once.
Supporting browsers add `?playback=webm` to local Ogg audio URLs; other browsers
request `?playback=pcm`. The existing media endpoints retain their containment
checks and return the actual output MIME type with byte-range support.

For WebM requests, an Ogg Vorbis identification header enables an FFmpeg stream
copy (`-map 0:a:0 -c:a copy -f webm`): no re-encoding, resampling, or intentional
timeline adjustment. Opus and unrecognized headers use full-file PCM decoding.
A failed remux also falls back to WAV, caching that fallback so subsequent
range requests do not repeat the failed conversion. If conversion cannot
produce either format, the media routes serve the original Ogg so playback
remains available, though the reported seek drift may recur for that song.

The cache is `audio_cache_dir/browser-webm/` (WebM or fallback WAV) or the
backwards-compatible `browser-pcm/` (explicit PCM requests). Keys include source
path, size, nanosecond modification time, and conversion version. Publication
is atomic; concurrent requests reuse one conversion. FFmpeg is required; no
new binary or Python dependency is needed for conversion. Cached browser copies
are limited to 100 files across both directories; the original recordings and
direct `audio_` cache entries are untouched. Conversion locks are scoped to a
source version, so a slow conversion does not block cached songs. At most two
different source versions convert at once per server process. Cache use is
tracked explicitly on each hit, so eviction keeps frequently played copies
even on filesystems that do not update access times. A request waiting more
than five seconds for a conversion slot serves the original audio.
Fallback stereo 48 kHz, 16-bit WAV costs about 11.5 MB per minute.

Playback speed and pitch preservation still use HTMLAudioElement. Native JUCE
gets the original URL/path. Source packs, plugin repositories, settings, and
chart offsets are unchanged. Generated caches can be discarded while playback
is stopped and will be regenerated on demand.

## Verification

Run with a local song longer than 105 seconds and audible content around the
test positions (no copyrighted recording is bundled with the diagnostic):

```sh
node scripts/check-browser-seek.cjs 'http://localhost:8000/api/sloppak/SONG.feedpak/file/stems/full.ogg?playback=webm' 'http://localhost:8000/api/sloppak/SONG.feedpak/file/stems/full.ogg?playback=pcm'
```

Set `SEEK_BROWSER_EXECUTABLE` to a Chrome binary to test that exact version in a
disposable profile. The optional second URL supplies an independent decoded
reference; omit it to decode the playback file itself. Remove the first URL's
query string to compare original Ogg playback. The probe fails for >10 ms
spread or inconclusive/silent samples. Absolute offsets include the probe's
asynchronous delivery delay, so compare with a baseline rather than treating
them as acoustic A/V calibration.

Automated tests cover both cache modes, invalidation, concurrent requests,
remux failure/timeout/empty-output fallback, cleanup after conversion failure,
cache eviction, original-audio fallback, Opus/unknown headers, MIME types,
byte-range responses, and source-resolution
failures. JS tests cover browser capability selection and native/browser
rerouting. `transport.js` is unchanged.

Implementation checks (macOS Chrome 153.0.8010.53): the real media routes gave
0.70 ms and 0.75 ms spread on the two 48 kHz songs against their original WAV
references; a generated 44.1 kHz Vorbis recording gave 1.86 ms. Browser smoke
checks confirmed WebM capability selection, paused/repeated seeks, and 0.7x
playback with `preservesPitch` enabled for both WebM and WAV. A real Opus-in-Ogg
request returned range-seekable WAV. These are not acoustic pitch/latency tests
or validation of every browser. WebM container duration can include an extra
priming block (~21 ms in one tested file); the decoded PCM and measured playback
timeline still matched the original reference.
The restarted Docker fork (FFmpeg 8.1) also passed the PCM seek probe with
0.69 ms spread. The targeted backend suite passed 80 tests, the complete JS
suite passed 1,214 tests, and ESLint passed for the changed JS files.

For the user-facing check: fully reload the page, reset the temporary -100 ms
workaround to the usual A/V setting (start with 0), reopen the song, then compare
continuous playback, section clicks, Left/Right, repeated seeks, paused seeks,
and slow playback. Supporting browsers should request `playback=webm` and
receive `audio/webm` for Vorbis (or `audio/wav` on fallback). Other browsers
request `playback=pcm` and receive WAV. A fixed device/calibration offset, if present independently
of seeking, is a separate issue; do not conflate it with decoder seek drift.
