// Real decoder regression probe (not a fake currentTime test).
// npm install; node scripts/check-browser-seek.cjs 'http://localhost:8000/api/sloppak/SONG.feedpak/file/stems/full.ogg?playback=webm'
// Optional second URL: original decoded WAV reference, to detect a constant
// timeline shift introduced by repackaging as well as seek-dependent drift.
// Set SEEK_BROWSER_EXECUTABLE to test a specific Chrome binary in a disposable
// profile. No access to an existing browser profile; output is silent.
const { chromium } = require('playwright');

/** Compare browser output with decoded PCM across continuous play and seeks. */
async function main() {
    const input = process.argv[2];
    if (!input) throw new Error('Pass a local feedBack audio URL (a song longer than 105 seconds).');
    const url = new URL(input);
    const referenceUrl = new URL(process.argv[3] || input);
    for (const candidate of [url, referenceUrl]) {
        if (!['http:', 'https:'].includes(candidate.protocol)
                || !['localhost', '127.0.0.1', '[::1]'].includes(candidate.hostname)) {
            throw new Error('This diagnostic accepts only a local feedBack server.');
        }
    }
    const browser = await chromium.launch({
        executablePath: process.env.SEEK_BROWSER_EXECUTABLE || undefined,
        args: ['--autoplay-policy=no-user-gesture-required'],
    });
    try {
        const page = await browser.newPage();
        await page.route(url.origin + '/seek-clock-probe', route => route.fulfill({
            contentType: 'text/html', body: '<!doctype html><audio id="audio"></audio>',
        }));
        await page.goto(url.origin + '/seek-clock-probe');
        const results = await page.evaluate(async ({ input, referenceUrl }) => {
            const audio = document.getElementById('audio');
            const ctx = new AudioContext({ sampleRate: 48000 });
            const decoded = await ctx.decodeAudioData(await (await fetch(referenceUrl)).arrayBuffer());
            const reference = decoded.getChannelData(0);
            const workletUrl = URL.createObjectURL(new Blob([`
                class Probe extends AudioWorkletProcessor {
                    constructor() { super(); this.samples = []; this.active = false; }
                    process(inputs) {
                        const channel = inputs[0]?.[0];
                        if (!channel) return true;
                        if (currentFrame % 8192 === 0) { this.samples = []; this.active = true; }
                        if (this.active) {
                            this.samples.push(...channel);
                            if (this.samples.length >= 512) {
                                this.port.postMessage(this.samples); this.active = false;
                            }
                        }
                        return true; // output is silent, input PCM is observed only
                    }
                }
                registerProcessor('seek-probe', Probe);
            `], { type: 'text/javascript' }));
            await ctx.audioWorklet.addModule(workletUrl);
            URL.revokeObjectURL(workletUrl);
            const probe = new AudioWorkletNode(ctx, 'seek-probe');
            ctx.createMediaElementSource(audio).connect(probe);
            probe.connect(ctx.destination);
            let records = [];
            probe.port.onmessage = e => {
                if (!audio.seeking) records.push({ samples: e.data, media: audio.currentTime });
            };
            audio.src = input;
            await ctx.resume();
            await audio.play();
            const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
            const results = [];
            /** Correlate recent playback samples with the decoded reference. */
            async function measure(label) {
                records = [];
                await wait(1200);
                const offsets = [];
                for (const record of records.slice(-3)) {
                    let power = 0;
                    for (let k = 0; k < 512; k += 4) power += record.samples[k] ** 2;
                    if (power < 1e-8) continue;
                    const center = Math.round(record.media * 48000);
                    let best = -1, at = 0;
                    for (let pos = Math.max(0, center - 24000); pos < Math.min(reference.length - 512, center + 24000); pos++) {
                        let dot = 0, norm = 0;
                        for (let k = 0; k < 512; k += 4) {
                            dot += record.samples[k] * reference[pos + k];
                            norm += reference[pos + k] ** 2;
                        }
                        const score = dot / Math.sqrt(norm * power);
                        if (score > best) { best = score; at = pos; }
                    }
                    if (best > 0.98) offsets.push((record.media - at / 48000) * 1000);
                }
                offsets.sort((a, b) => a - b);
                results.push({ label, samples: offsets.length, offsetMs: offsets.length ? offsets[Math.floor(offsets.length / 2)] : null });
            }
            // Reach non-silent music without seeking: this baseline is essential.
            await wait(30000);
            await measure('continuous');
            for (const target of [30, 90, 20, 100]) {
                audio.currentTime = target;
                await measure('seek ' + target);
            }
            audio.pause();
            await wait(300);
            await audio.play();
            await measure('pause/resume');
            audio.pause();
            await ctx.close();
            return results;
        }, { input: url.href, referenceUrl: referenceUrl.href });
        console.log(JSON.stringify(results, null, 2));
        if (results.some(r => r.offsetMs === null)) throw new Error('Inconclusive: silence or no reliable PCM match. Try another song.');
        const offsets = results.map(r => r.offsetMs);
        const spread = Math.max(...offsets) - Math.min(...offsets);
        console.log(`Seek-dependent clock spread: ${spread.toFixed(2)} ms`);
        if (spread > 10) throw new Error('Playback clock changed relative to PCM after seeking (>10 ms).');
    } finally {
        await browser.close();
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
