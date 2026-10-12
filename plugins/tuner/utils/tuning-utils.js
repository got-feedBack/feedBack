(function () {
    'use strict';
    function freqToMidi(f) { return 69 + 12 * Math.log2(f / 440); }
    function midiToFreq(m) { return Math.pow(2, (m - 69) / 12) * 440; }

    const _NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
    const _NOTE_FLAT  = ['C','Db','D','Eb', 'E','F','Gb','G','Ab','A','Bb', 'B'];
    // Returns true when the tuning name implies flat notation (e.g. "Eb Standard", "Bb Standard").
    function preferFlats(tuningName) {
        return typeof tuningName === 'string' && /\b[A-G]b\b/.test(tuningName);
    }
    function midiToNote(m, useFlats) {
        return (useFlats ? _NOTE_FLAT : _NOTE_NAMES)[((Math.round(m) % 12) + 12) % 12];
    }


    // Per-string-count standard open-string MIDI arrays
    const _BASE_MIDI = {
        4: [28, 33, 38, 43],                  // bass 4: E1 A1 D2 G2
        5: [23, 28, 33, 38, 43],              // bass 5: B0 E1 A1 D2 G2
        6: [40, 45, 50, 55, 59, 64],          // guitar 6: E2 A2 D3 G3 B3 E4
        7: [35, 40, 45, 50, 55, 59, 64],      // guitar 7: B1 E2 A2 D3 G3 B3 E4
        8: [30, 35, 40, 45, 50, 55, 59, 64],  // guitar 8: F#1 B1 E2 A2 D3 G3 B3 E4
    };
    const _BASS6_MIDI = [23, 28, 33, 38, 43, 48];  // bass 6: B0 E1 A1 D2 G2 C3

    function offsetsToFreqs(offsets, isBass) {
        const len = offsets.length;
        let base;
        if (len === 4 || len === 5) {
            base = isBass ? _BASE_MIDI[len] : _BASE_MIDI[6];
        } else if (len === 6 && isBass) {
            base = _BASS6_MIDI;
        } else {
            base = _BASE_MIDI[len] || _BASE_MIDI[6];
        }
        return offsets.map((offset, i) => {
            const root = i < base.length ? base[i] : base[base.length - 1];
            return midiToFreq(root + offset);
        });
    }

    function getTuningName(offsets) {
        if (!offsets || offsets.length === 0) return 'Unknown';
        const len = offsets.length;
        if (len < 4 || len > 8) return offsets.join(' ');

        // First-string open MIDI for this length (same table as _BASE_MIDI column 0).
        const firstStringMidi = (_BASE_MIDI[len] || _BASE_MIDI[6])[0];
        const noteNames = ['C','C#','D','Eb','E','F','F#','G','Ab','A','A#','B'];

        // All-equal: name by the note the lowest string becomes at this offset.
        if (offsets.every(o => o === offsets[0])) {
            const noteIdx = ((firstStringMidi + offsets[0]) % 12 + 12) % 12;
            return noteNames[noteIdx] + ' Standard';
        }

        // Drop tuning: first string is exactly 2 semitones below the rest (all equal).
        if (offsets[0] === offsets[1] - 2 && offsets.slice(1).every(o => o === offsets[1])) {
            const noteIdx = ((firstStringMidi + offsets[0]) % 12 + 12) % 12;
            return 'Drop ' + noteNames[noteIdx];
        }

        // Named lookup table for specific patterns
        const named = {
            // 6-string
            '-2,0,0,0,0,0': 'Drop D', '-4,-2,-2,-2,-2,-2': 'Drop C',
            '-2,-2,0,0,0,0': 'Double Drop D', '0,0,0,-1,0,0': 'Open G',
            '-2,-2,0,0,-2,-2': 'Open D', '-2,0,0,0,-2,0': 'DADGAD',
            '0,2,2,1,0,0': 'Open E', '-2,0,0,2,3,2': 'Open D (alt)',
            // 7-string
            '-2,0,0,0,0,0,0': 'Drop A',
            // 8-string
            '-2,0,0,0,0,0,0,0': 'Drop E',
        };
        const key = offsets.join(',');
        if (named[key]) return named[key];

        return offsets.join(' ');
    }

    window._tunerUtils = { freqToMidi, midiToFreq, midiToNote, offsetsToFreqs, getTuningName, preferFlats };
})();
