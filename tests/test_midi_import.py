"""Tests for lib/midi_import.py — list_midi_tracks and convert_midi_track_to_keys_wire.

Synthetic mido.MidiFile objects are built in-memory and saved to tmp_path so
the helpers can be exercised without shipping fixture .mid files.

Covers:
  - format-0 per-channel splitting
  - drum-channel (GM channel 9) filtering
  - format-1 no-split (multi-channel track stays merged)
  - tempo-change-aware tick→seconds conversion
  - CC64 sustain pedal note extension
  - same-pitch retrigger (FIFO stacking — no dropped notes)
  - pitch encoding: s = pitch // 24, f = pitch % 24
"""

import pytest
import mido

from midi_import import list_midi_tracks, convert_midi_track_to_keys_wire


# ── helpers ───────────────────────────────────────────────────────────────────

def _save(mid: mido.MidiFile, tmp_path, name: str = "test.mid") -> str:
    p = tmp_path / name
    mid.save(str(p))
    return str(p)


# ── list_midi_tracks ──────────────────────────────────────────────────────────

def test_format0_splits_into_per_channel_entries(tmp_path):
    """Format-0 with two non-drum channels → two separate picker entries."""
    mid = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    # Channel 0: piano (program 0)
    track.append(mido.Message("program_change", channel=0, program=0, time=0))
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=480))
    # Channel 1: bass (program 33)
    track.append(mido.Message("program_change", channel=1, program=33, time=0))
    track.append(mido.Message("note_on",  channel=1, note=48, velocity=64, time=0))
    track.append(mido.Message("note_off", channel=1, note=48, velocity=0,  time=480))

    tracks = list_midi_tracks(_save(mid, tmp_path))
    assert len(tracks) == 2
    channels = {t["channel"] for t in tracks}
    assert channels == {0, 1}
    # Each entry should carry a channel_filter for isolation
    assert all(t["channel_filter"] is not None for t in tracks)


def test_format0_drum_channel_excluded(tmp_path):
    """Channel-9 notes are not returned, even in format-0 split mode."""
    mid = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    # Melodic channel
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=480))
    # Drum channel — must be filtered out
    track.append(mido.Message("note_on",  channel=9, note=36, velocity=64, time=0))
    track.append(mido.Message("note_off", channel=9, note=36, velocity=0,  time=480))

    tracks = list_midi_tracks(_save(mid, tmp_path))
    assert len(tracks) == 1
    assert tracks[0]["channel"] == 0
    assert all(t["channel"] != 9 for t in tracks)


def test_format0_drums_only_returns_empty(tmp_path):
    """A format-0 file with only channel-9 notes yields an empty list."""
    mid = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.Message("note_on",  channel=9, note=36, velocity=64, time=0))
    track.append(mido.Message("note_off", channel=9, note=36, velocity=0,  time=480))

    tracks = list_midi_tracks(_save(mid, tmp_path))
    assert tracks == []


def test_format1_multi_channel_not_split(tmp_path):
    """Format-1 tracks are not split per-channel — the whole track is one entry."""
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    # Conductor track (required for type-1)
    conductor = mido.MidiTrack()
    mid.tracks.append(conductor)
    conductor.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))
    # Multi-channel note track
    note_track = mido.MidiTrack()
    mid.tracks.append(note_track)
    note_track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    note_track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=480))
    note_track.append(mido.Message("note_on",  channel=1, note=48, velocity=64, time=0))
    note_track.append(mido.Message("note_off", channel=1, note=48, velocity=0,  time=480))

    tracks = list_midi_tracks(_save(mid, tmp_path))
    # Conductor track has no melodic notes → skipped; note track → 1 merged entry
    assert len(tracks) == 1
    assert tracks[0]["channel_filter"] is None


def test_piano_program_flagged(tmp_path):
    """Tracks with a piano-family program are flagged is_piano=True."""
    mid = mido.MidiFile(type=1, ticks_per_beat=480)
    conductor = mido.MidiTrack()
    mid.tracks.append(conductor)
    note_track = mido.MidiTrack()
    mid.tracks.append(note_track)
    note_track.append(mido.MetaMessage("track_name", name="Piano", time=0))
    note_track.append(mido.Message("program_change", channel=0, program=0, time=0))
    note_track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    note_track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=480))

    tracks = list_midi_tracks(_save(mid, tmp_path))
    assert len(tracks) == 1
    assert tracks[0]["is_piano"] is True


# ── convert_midi_track_to_keys_wire ──────────────────────────────────────────

def test_pitch_encoding(tmp_path):
    """MIDI pitch is encoded as s = pitch // 24, f = pitch % 24."""
    mid = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    # Middle C = MIDI 60 → s=2, f=12
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=480))

    result = convert_midi_track_to_keys_wire(_save(mid, tmp_path), track_index=0)
    assert len(result["notes"]) == 1
    n = result["notes"][0]
    assert n["s"] == 60 // 24
    assert n["f"] == 60 % 24
    # Reconstruct: s*24 + f should recover original MIDI pitch
    assert n["s"] * 24 + n["f"] == 60


def test_constant_tempo_timing(tmp_path):
    """At 120 BPM with 480 ticks/beat, one beat = 0.5 s."""
    tpb = 480
    mid = mido.MidiFile(type=0, ticks_per_beat=tpb)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    # One-beat note starting at tick 0
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=tpb))

    result = convert_midi_track_to_keys_wire(_save(mid, tmp_path), track_index=0)
    assert len(result["notes"]) == 1
    n = result["notes"][0]
    assert n["t"] == pytest.approx(0.0)
    assert n["sus"] == pytest.approx(0.5)


def test_tempo_change_boundary(tmp_path):
    """Notes crossing a tempo change get correct durations on each side."""
    tpb = 480
    mid = mido.MidiFile(type=1, ticks_per_beat=tpb)
    # Conductor: 120 BPM → switch to 60 BPM at tick 480
    conductor = mido.MidiTrack()
    mid.tracks.append(conductor)
    conductor.append(mido.MetaMessage("set_tempo", tempo=500000, time=0))     # 120 BPM
    conductor.append(mido.MetaMessage("set_tempo", tempo=1000000, time=tpb))  # 60 BPM

    note_track = mido.MidiTrack()
    mid.tracks.append(note_track)
    # Note before tempo change: starts tick 0, ends tick 480 → 0.5 s
    note_track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    note_track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=tpb))
    # Note after tempo change: starts tick 480, ends tick 960 → 1.0 s
    note_track.append(mido.Message("note_on",  channel=0, note=62, velocity=64, time=0))
    note_track.append(mido.Message("note_off", channel=0, note=62, velocity=0,  time=tpb))

    result = convert_midi_track_to_keys_wire(_save(mid, tmp_path), track_index=1)
    notes = sorted(result["notes"], key=lambda n: n["t"])
    assert len(notes) == 2
    assert notes[0]["t"] == pytest.approx(0.0)
    assert notes[0]["sus"] == pytest.approx(0.5)   # 1 beat at 120 BPM
    assert notes[1]["t"] == pytest.approx(0.5)
    assert notes[1]["sus"] == pytest.approx(1.0)   # 1 beat at 60 BPM


def test_cc64_sustain_extends_note(tmp_path):
    """While the sustain pedal is held, note-off defers end time to pedal-up."""
    tpb = 480
    mid = mido.MidiFile(type=0, ticks_per_beat=tpb)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    # Pedal down at tick 0
    track.append(mido.Message("control_change", channel=0, control=64, value=64, time=0))
    # Note starts at tick 0
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    # Key released at tick 240 (while pedal still held)
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=240))
    # Pedal up at tick 480 → note should end here (0.5 s total duration)
    track.append(mido.Message("control_change", channel=0, control=64, value=0, time=240))

    result = convert_midi_track_to_keys_wire(_save(mid, tmp_path), track_index=0)
    assert len(result["notes"]) == 1
    n = result["notes"][0]
    assert n["t"] == pytest.approx(0.0)
    assert n["sus"] == pytest.approx(0.5)  # extended to pedal-up at tick 480


def test_same_pitch_retrigger(tmp_path):
    """Rapid same-pitch retrigger emits two separate notes (FIFO stack)."""
    tpb = 480
    mid = mido.MidiFile(type=0, ticks_per_beat=tpb)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    # First note on
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    # Retrigger: second note_on before first note_off
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=240))
    # First note_off (FIFO: closes the first note_on at tick 0)
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=240))
    # Second note_off
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=240))

    result = convert_midi_track_to_keys_wire(_save(mid, tmp_path), track_index=0)
    assert len(result["notes"]) == 2
    notes = sorted(result["notes"], key=lambda n: n["t"])
    assert notes[0]["t"] == pytest.approx(0.0)
    # Duration: from tick 0 to first note_off at tick 480 (cumulative)
    assert notes[0]["sus"] == pytest.approx(0.5, abs=0.01)
    assert notes[1]["t"] == pytest.approx(0.25)


def test_channel_filter_isolates_channel(tmp_path):
    """channel_filter restricts conversion to the specified channel only."""
    mid = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    # Ch 0: pitch 60
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=480))
    # Ch 1: pitch 72
    track.append(mido.Message("note_on",  channel=1, note=72, velocity=64, time=0))
    track.append(mido.Message("note_off", channel=1, note=72, velocity=0,  time=480))

    path = _save(mid, tmp_path)
    result = convert_midi_track_to_keys_wire(path, track_index=0, channel_filter=0)
    pitches = {n["s"] * 24 + n["f"] for n in result["notes"]}
    assert 60 in pitches
    assert 72 not in pitches


def test_audio_offset_applied(tmp_path):
    """audio_offset shifts all note start times by the given amount."""
    mid = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=480))

    path = _save(mid, tmp_path)
    result = convert_midi_track_to_keys_wire(path, track_index=0, audio_offset=1.5)
    assert result["notes"][0]["t"] == pytest.approx(1.5)


def test_wire_format_shape(tmp_path):
    """Returned dict has all required sloppak arrangement keys."""
    mid = mido.MidiFile(type=0, ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=0))
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=480))

    result = convert_midi_track_to_keys_wire(_save(mid, tmp_path), track_index=0, name="Keys")
    assert result["name"] == "Keys"
    assert "notes" in result
    assert "chords" in result
    assert "anchors" in result
    assert "tuning" in result
    assert "capo" in result


# ── non-positive division guard (legacy inline tempo path) ───────────────────

def test_zero_division_does_not_crash(tmp_path):
    """A malformed header (ticks_per_beat == 0) must not raise ZeroDivisionError.

    The legacy inline tempo map in convert_midi_track_to_keys_wire divides by
    ticks_per_beat at two sites; a 0 division falls back to the SMF default so
    the note is still emitted with a sane, non-negative time.
    """
    mid = mido.MidiFile(ticks_per_beat=0)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    # Note starts after a one-"beat" rest so a bad divisor would skew its start.
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=480))
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=480))

    path = _save(mid, tmp_path)
    assert mido.MidiFile(path).ticks_per_beat == 0  # precondition: divisor is 0
    result = convert_midi_track_to_keys_wire(path, track_index=0)
    assert len(result["notes"]) == 1
    n = result["notes"][0]
    # 480-tick fallback @ 120 BPM: one beat = 0.5 s.
    assert n["t"] == pytest.approx(0.5)
    assert n["t"] >= 0.0
    assert n["sus"] == pytest.approx(0.5)


def test_smpte_negative_division_produces_nonnegative_times(tmp_path):
    """SMPTE division (mido returns a NEGATIVE ticks_per_beat) must not yield
    negative times through the legacy inline path.

    ``or 480`` would miss this (a negative value is truthy); the ``> 0`` guard
    falls back so the emitted note keeps a sane, non-negative start time.
    """
    mid = mido.MidiFile()
    mid.ticks_per_beat = -1  # simulate a SMPTE / malformed signed-short division
    track = mido.MidiTrack()
    mid.tracks.append(track)
    track.append(mido.Message("note_on",  channel=0, note=60, velocity=64, time=480))
    track.append(mido.Message("note_off", channel=0, note=60, velocity=0,  time=480))

    path = _save(mid, tmp_path)
    assert mido.MidiFile(path).ticks_per_beat < 0  # precondition: negative divisor
    result = convert_midi_track_to_keys_wire(path, track_index=0)
    assert len(result["notes"]) == 1
    n = result["notes"][0]
    assert n["t"] >= 0.0
    assert n["sus"] >= 0.0
    # 480-tick fallback @ 120 BPM: one beat = 0.5 s.
    assert n["t"] == pytest.approx(0.5)
    assert n["sus"] == pytest.approx(0.5)
