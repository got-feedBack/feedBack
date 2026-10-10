"""lib/drumchart.py, lib/drumchart_gen.py and scripts/ch_to_sloppak.py with synthetic
Clone Hero / YARG charts (no ffmpeg or real audio needed)."""

from __future__ import annotations

import json
import zipfile

import pytest
import yaml

import drumchart
import drumchart_gen
from tests.drum_fixtures import FAKE_OGG, TPQ, write_chart, write_ini, write_mid

KICK, RED, YEL, BLU, ORG, GRN = 96, 97, 98, 99, 100, 101


def _hits(chart):
    return [(round(h.time, 3), h.pad, h.cymbal, h.kick2x, h.dyn) for h in chart.hits]


# ── MIDI ────────────────────────────────────────────────────────────────────

def test_mid_tempo_map_with_tempo_change(tmp_path):
    p = write_mid(tmp_path / "notes.mid", [(0, KICK, 100, 10), (1920, RED, 100, 10), (2400, RED, 100, 10)],
                  tempos=[(0, 120.0), (1920, 60.0)])
    c = drumchart.parse_mid(p)
    assert [round(h.time, 4) for h in c.hits] == [0.0, 2.0, 3.0]
    assert c.tempo.tick_to_time(1920 + 960) == pytest.approx(4.0)
    assert c.tempo.time_to_tick(3.0) == pytest.approx(2400)


def test_mid_cymbals_default_and_tom_markers_toggle(tmp_path):
    notes = [(0, YEL, 100, 10), (0, BLU, 100, 10), (0, ORG, 100, 10),
             (480, YEL, 100, 10), (480, BLU, 100, 10), (480, ORG, 100, 10),
             (960, YEL, 100, 10),
             (480, 110, 100, 480), (480, 111, 100, 1), (480, 112, 100, 10)]
    c = drumchart.parse_mid(write_mid(tmp_path / "n.mid", notes))
    got = {(round(h.time, 2), h.pad): h.cymbal for h in c.hits}
    assert got[(0.0, "yellow")] and got[(0.0, "blue")] and got[(0.0, "green")]
    # tom markers flip the pads they cover...
    assert not got[(0.5, "yellow")] and not got[(0.5, "blue")] and not got[(0.5, "green")]
    # ...over [start, end-1]: the note on the marker's end tick stays a cymbal
    assert got[(1.0, "yellow")]
    assert not c.five_lane


def test_mid_double_kick(tmp_path):
    c = drumchart.parse_mid(write_mid(tmp_path / "n.mid", [(0, KICK, 100, 10), (240, 95, 100, 10)]))
    assert _hits(c) == [(0.0, "kick", False, False, None), (0.25, "kick", False, True, None)]


def test_mid_dynamics_need_enable_chart_dynamics(tmp_path):
    notes = [(0, RED, 127, 10), (480, RED, 1, 10), (960, KICK, 127, 10), (1440, YEL, 64, 10)]
    off = drumchart.parse_mid(write_mid(tmp_path / "a.mid", notes))
    assert [h.dyn for h in off.hits] == [None, None, None, None]
    on = drumchart.parse_mid(write_mid(tmp_path / "b.mid", notes, texts=[(0, "[ENABLE_CHART_DYNAMICS]")]))
    assert [h.dyn for h in on.hits] == ["accent", "ghost", None, None]   # kicks never get dynamics
    assert on.dynamics


def test_mid_phrases_sections_and_delay(tmp_path):
    notes = [(0, KICK, 100, 10), (1920, RED, 100, 10),
             (960, 116, 100, 1920),          # star power: 1.0 .. 3.0 s
             (2880, 120, 100, 960), (2880, 121, 100, 960),   # one fill (lane notes 120-124 share it)
             (3840, 103, 100, 480)]          # solo
    write_mid(tmp_path / "notes.mid", notes, sections=[(0, "Intro"), (1920, "verse_1")])
    write_ini(tmp_path / "song.ini", name="Song", artist="Band", delay=250)
    c, ini = drumchart.load_song_folder(tmp_path)
    assert ini["name"] == "Song"
    assert c.offset == pytest.approx(0.25)
    assert [round(h.time, 3) for h in c.hits] == [0.25, 2.25]
    assert c.star_power == [(1.25, 3.25)]
    assert c.fills == [(3.25, 4.25)]
    assert c.solos == [(4.25, 4.75)]
    assert c.sections == [(0.25, "Intro"), (2.25, "verse 1")]


def test_mid_five_lane_converts_to_pro_four_lane(tmp_path):
    notes = [(0, YEL, 100, 10), (480, BLU, 100, 10), (960, ORG, 100, 10), (1440, GRN, 100, 10),
             (1920, ORG, 100, 10), (1920, GRN, 100, 10)]
    c = drumchart.parse_mid(write_mid(tmp_path / "n.mid", notes))
    assert c.five_lane
    assert [(h.pad, h.cymbal) for h in c.hits] == [
        ("yellow", True), ("blue", False), ("green", True), ("green", False),
        ("blue", True), ("green", False)]     # orange+green chord -> blue cym + green tom


def test_mid_disco_flip_swaps_red_and_yellow(tmp_path):
    notes = [(0, RED, 100, 10), (480, RED, 100, 10), (480, YEL, 100, 10), (1440, RED, 100, 10)]
    texts = [(480, "[mix 3 drums0d]"), (960, "[mix 3 drums0]")]
    c = drumchart.parse_mid(write_mid(tmp_path / "n.mid", notes, texts=texts))
    assert [(round(h.time, 2), h.pad, h.cymbal) for h in c.hits] == [
        (0.0, "red", False), (0.5, "red", False), (0.5, "yellow", True), (1.5, "red", False)]


def test_mid_only_part_drums_expert(tmp_path):
    notes = [(0, 60, 100, 10), (0, 72, 100, 10), (0, 84, 100, 10), (480, RED, 100, 10)]
    c = drumchart.parse_mid(write_mid(tmp_path / "n.mid", notes))
    assert _hits(c) == [(0.5, "red", False, False, None)]
    with pytest.raises(ValueError):
        drumchart.parse_mid(write_mid(tmp_path / "g.mid", notes, track_name="PART GUITAR"))


def test_beats_follow_time_signatures(tmp_path):
    notes = [(0, KICK, 100, 10), (TPQ * 10, KICK, 100, 10)]
    c = drumchart.parse_mid(write_mid(tmp_path / "n.mid", notes, sigs=[(0, 4, 4), (TPQ * 4, 3, 4)]))
    beats = c.beat_list()
    assert [b["measure"] for b in beats[:8]] == [1, -1, -1, -1, 2, -1, -1, 3]
    assert beats[4]["time"] == pytest.approx(2.0)
    assert beats[-1]["time"] >= c.hits[-1].time - 0.5


# ── .chart ──────────────────────────────────────────────────────────────────

def test_chart_markers_dynamics_and_phrases(tmp_path):
    R = 192
    lines = [(0, "N", 0, 0), (0, "N", 2, 0), (0, "N", 66, 0),         # kick + yellow cymbal
             (R, "N", 2, 0),                                          # yellow tom (default)
             (2 * R, "N", 1, 0), (2 * R, "N", 34, 0),                 # red accent
             (3 * R, "N", 3, 0), (3 * R, "N", 42, 0), (3 * R, "N", 67, 0),   # blue ghost cymbal
             (4 * R, "N", 32, 0), (4 * R, "N", 4, 0), (4 * R, "N", 68, 0),   # 2x kick + green cymbal
             (5 * R, "N", 4, 0),                                      # green tom
             (0, "S", 2, 4 * R), (4 * R, "S", 64, 2 * R)]
    write_chart(tmp_path / "notes.chart", lines, events=[(0, "Intro")], offset=0.1)
    write_ini(tmp_path / "song.ini", pro_drums="True")
    c, ini = drumchart.load_song_folder(tmp_path)
    assert c.source_format == "chart" and ini["name"] == "Song" and ini["artist"] == "Band"
    assert c.offset == pytest.approx(0.1)
    assert [(round(h.time - 0.1, 3), h.pad, h.cymbal, h.kick2x, h.dyn) for h in c.hits] == [
        (0.0, "kick", False, False, None), (0.0, "yellow", True, False, None),
        (0.5, "yellow", False, False, None),
        (1.0, "red", False, False, "accent"),
        (1.5, "blue", True, False, "ghost"),
        (2.0, "kick", False, True, None), (2.0, "green", True, False, None),
        (2.5, "green", False, False, None)]
    assert c.star_power == [(0.1, 2.1)]
    assert c.fills == [(2.1, 3.1)]
    assert c.sections == [(0.1, "Intro")]


def test_ini_delay_beats_chart_offset(tmp_path):
    write_chart(tmp_path / "notes.chart", [(0, "N", 1, 0)], offset=0.5)
    write_ini(tmp_path / "song.ini", delay=-120)
    c, _ = drumchart.load_song_folder(tmp_path)
    assert c.hits[0].time == pytest.approx(-0.12)


# ── drum_tab / song_timeline encoding ───────────────────────────────────────

def test_every_pad_maps_to_a_drums_piece_and_back():
    hits = [drumchart.DrumHit(1.0, "kick"), drumchart.DrumHit(1.0, "kick", kick2x=True),
            drumchart.DrumHit(1.0, "red", dyn="ghost"), drumchart.DrumHit(1.0, "yellow", True),
            drumchart.DrumHit(1.0, "yellow", False), drumchart.DrumHit(1.0, "blue", True, dyn="accent"),
            drumchart.DrumHit(1.0, "blue", False), drumchart.DrumHit(1.0, "green", True),
            drumchart.DrumHit(1.0, "green", False)]
    tab = [drumchart.hit_to_tab(h) for h in hits]
    assert [d["p"] for d in tab] == ["kick", "kick", "snare", "hh_closed", "tom_hi", "ride", "tom_mid",
                                     "crash_l", "tom_floor"]
    assert tab[1]["x2"] and tab[2]["g"] and tab[5]["a"]
    assert "a" not in tab[2] and "g" not in tab[5] and "x2" not in tab[0]
    key = lambda h: (h.pad, h.cymbal, h.kick2x, h.dyn)  # noqa: E731
    assert sorted(map(key, drumchart.tab_to_hits(tab))) == sorted(map(key, hits))


def test_piece_to_pad_covers_the_closed_vocabulary():
    import drums
    assert set(drumchart.PIECE_TO_PAD) == set(drums.PIECES)
    back = drumchart.tab_to_hits([{"t": 1, "p": "cowbell"}, {"t": 0.5, "p": "snare", "x2": True},
                                  {"t": "x", "p": "kick"}, "junk"])
    assert [(h.time, h.pad, h.kick2x) for h in back] == [(0.5, "red", False)]   # x2 only on kicks


def test_drum_tab_carries_gameplay_metadata_and_validates():
    import drums
    hits = [drumchart.DrumHit(0.5 * i, "red" if i % 2 else "kick") for i in range(8)]
    hits.append(drumchart.DrumHit(1.25, "kick", kick2x=True))
    c = drumchart.DrumChart(hits=hits, tempo=drumchart.TempoMap(480), star_power=[(0.0, 1.0)],
                            fills=[(2.0, 3.0)], solos=[(1.0, 2.0)],
                            levels={"hard": hits[:4], "easy": [hits[0]]}, levels_generated=["easy"])
    tab = drumchart.drum_tab(c)
    assert drums.validate_drum_tab(tab) == (True, "")
    assert tab["version"] == drums.SCHEMA_VERSION and tab["name"] == "Drums"
    assert [k["id"] for k in tab["kit"]] == ["kick", "snare"]
    assert sum(1 for h in tab["hits"] if h.get("x2")) == 1
    assert tab["star_power"] == [{"start_time": 0.0, "end_time": 1.0}]
    assert tab["fills"] == [{"start_time": 2.0, "end_time": 3.0}]
    assert tab["solos"] == [{"start_time": 1.0, "end_time": 2.0}]
    assert set(tab["levels"]) == {"hard", "easy"}
    assert tab["levels"]["easy"]["generated"] is True and "generated" not in tab["levels"]["hard"]
    # every hit survives the core wire normaliser the highway WS streams through
    assert len(drums.hits_to_wire(tab["hits"])) == len(hits)
    # empty metadata is omitted, not written as []
    bare = drumchart.drum_tab(drumchart.DrumChart(hits=hits[:1], tempo=drumchart.TempoMap(480)))
    assert set(bare) == {"version", "name", "kit", "hits"}


def test_level_hits_never_carry_x2():
    k2 = drumchart.DrumHit(0.25, "kick", kick2x=True)
    c = drumchart.DrumChart(hits=[k2], tempo=drumchart.TempoMap(480), levels={"hard": [k2]})
    tab = drumchart.drum_tab(c)
    assert tab["hits"][0]["x2"] and "x2" not in tab["levels"]["hard"]["hits"][0]


def test_song_timeline_has_tempo_map_beats_and_sections(tmp_path):
    p = write_mid(tmp_path / "notes.mid", [(0, KICK, 100, 10), (TPQ * 8, KICK, 100, 10)],
                  tempos=[(0, 120.0), (TPQ * 4, 60.0)], sigs=[(0, 4, 4), (TPQ * 4, 3, 4)],
                  sections=[(0, "Intro"), (TPQ * 4, "Verse")])
    write_ini(tmp_path / "song.ini", delay=100)
    c, _ = drumchart.load_song_folder(tmp_path)
    tl = drumchart.song_timeline(c)
    assert tl["version"] == 1
    assert tl["tempos"] == [{"time": 0.1, "bpm": 120.0}, {"time": 2.1, "bpm": 60.0}]
    assert tl["time_signatures"] == [{"time": 0.1, "ts": [4, 4]}, {"time": 2.1, "ts": [3, 4]}]
    assert tl["beats"][0] == {"time": 0.1, "measure": 1}
    assert [(s["name"], s["number"], s["time"]) for s in tl["sections"]] == [("Intro", 1, 0.1), ("Verse", 2, 2.1)]
    assert p.exists()


# ── difficulty levels ───────────────────────────────────────────────────────

def test_mid_lower_difficulties_are_read(tmp_path):
    notes = [(0, KICK, 100, 10), (0, RED, 100, 10), (480, YEL, 100, 10),      # expert
             (0, 84, 100, 10), (480, 86, 100, 10),                            # hard: kick + yellow
             (0, 73, 100, 10),                                                # medium: red
             (480, 62, 100, 10), (480, 110, 100, 10)]                         # easy: yellow tom
    write_mid(tmp_path / "notes.mid", notes)
    c, _ = drumchart.load_song_folder(tmp_path)
    assert len(c.hits) == 3
    assert [(h.pad, h.cymbal) for h in c.levels["hard"]] == [("kick", False), ("yellow", False)]
    assert [(h.pad, h.cymbal) for h in c.levels["medium"]] == [("red", False)]
    assert [(h.pad, h.cymbal) for h in c.levels["easy"]] == [("yellow", False)]   # tom markers apply to all
    tab = drumchart.drum_tab(c)
    assert tab["levels"]["hard"] == {"hits": [{"t": 0.0, "p": "kick"}, {"t": 0.5, "p": "tom_hi"}]}


def test_chart_lower_difficulties(tmp_path):
    p = tmp_path / "notes.chart"
    write_chart(p, [(0, "N", 1, 0), (192, "N", 2, 0), (192, "N", 66, 0)])
    p.write_text(p.read_text() + "[EasyDrums]\n{\n  0 = N 1 0\n}\n")
    c, _ = drumchart.load_song_folder(tmp_path)
    assert list(c.levels) == ["easy"] and len(c.levels["easy"]) == 1


def test_reduce_levels_follow_charting_rules():
    beats = [(0.5 * i, i // 4 + 1 if i % 4 == 0 else -1) for i in range(200)]
    hits = []
    for i in range(320):                                   # 16th-note groove at 120 BPM
        t = 0.125 * i
        hits.append(drumchart.DrumHit(t, "yellow", True))
        if i % 8 == 0:
            hits += [drumchart.DrumHit(t, "kick"), drumchart.DrumHit(t, "green", True)]
        if i % 8 == 4:
            hits.append(drumchart.DrumHit(t, "red"))
        if i % 16 == 15:
            hits += [drumchart.DrumHit(t, "kick", kick2x=True), drumchart.DrumHit(t, "red", dyn="ghost")]
    out = {lv: drumchart_gen.reduce_level(hits, beats, lv) for lv in drumchart.LOWER_LEVELS}
    for lv, hs in out.items():
        assert not any(h.kick2x or h.dyn == "ghost" for h in hs)
        by_t = {}
        for h in hs:
            by_t.setdefault(h.time, []).append(h)
        cap = drumchart_gen.REDUCE[lv][1]
        assert max(len(v) for v in by_t.values()) <= cap
        ts = sorted(by_t)
        gaps = [b - a for a, b in zip(ts, ts[1:])]
        assert min(gaps) >= drumchart_gen.REDUCE[lv][0] * 0.5 - 1e-6 or lv == "hard"
        if lv == "easy":
            assert not any(len(v) > 1 and any(h.pad == "kick" for h in v) for v in by_t.values())
    assert len(out["easy"]) <= len(out["medium"]) < len(out["hard"]) < len(hits)


def test_ensure_levels_marks_generated_and_keeps_authored():
    hits = [drumchart.DrumHit(0.25 * i, "red") for i in range(64)]
    c = drumchart.DrumChart(hits=hits, tempo=drumchart.TempoMap(480), levels={"easy": hits[::4]})
    drumchart_gen.ensure_levels(c)
    assert c.levels["easy"] == hits[::4] and sorted(c.levels_generated) == ["hard", "medium"]
    tab = drumchart.drum_tab(c)
    assert "generated" not in tab["levels"]["easy"] and tab["levels"]["hard"]["generated"]


def test_reduce_level_tolerates_repeated_beat_times():
    # a beat map can repeat a time; that used to divide by zero
    beats = [(0.5 * i, -1) for i in range(20)]
    beats.insert(5, beats[4])
    hits = [drumchart.DrumHit(0.25 * i, "red") for i in range(32)]
    for lv in drumchart.LOWER_LEVELS:
        assert drumchart_gen.reduce_level(hits, beats, lv)


def test_auto_fills_need_star_power_and_respect_spacing():
    beats = [(0.5 * i, i // 4 + 1 if i % 4 == 0 else -1) for i in range(160)]   # 40 bars, 2 s each
    notes = [0.125 * i for i in range(640)]
    assert drumchart_gen.auto_fills(notes, beats, []) == []
    fills = drumchart_gen.auto_fills(notes, beats, [(0.0, 8.0)])
    assert fills and all(b - a == pytest.approx(2.0) for a, b in fills)       # one measure each
    assert fills[0][1] - 8.0 >= 2.0                                           # >= 2 s after the SP phrase
    assert all(b2 - b1 >= 2.0 for (_, b1), (_, b2) in zip(fills, fills[1:]))


# ── end to end: song folder -> pack -> core loader ──────────────────────────

def _song_folder(tmp_path, *, stems=False):
    folder = tmp_path / "Band - Song"
    folder.mkdir()
    notes = [(i * 480, KICK if i % 2 == 0 else RED, 100, 10) for i in range(16)]
    notes += [(i * 240, YEL, 100, 10) for i in range(32)]
    notes += [(0, 116, 100, 1920), (TPQ * 2, 95, 100, 10)]
    write_mid(folder / "notes.mid", notes, sections=[(0, "Intro"), (3840, "Verse")])
    write_ini(folder / "song.ini", name="Song", artist="Band", album="Record", year="2004", delay=0, charter="me")
    if stems:
        for name in ("drums.ogg", "song.ogg", "crowd.ogg"):
            (folder / name).write_bytes(FAKE_OGG)
    else:
        (folder / "song.ogg").write_bytes(FAKE_OGG)
    (folder / "album.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    return folder


def test_convert_folder_to_pack_and_load(tmp_path):
    from scripts import ch_to_sloppak
    from sloppak import load_song
    folder = _song_folder(tmp_path)
    out = tmp_path / "dlc" / "Song_-_Band.sloppak"
    out.parent.mkdir()
    s = ch_to_sloppak.convert(folder, out)
    assert s["notes"] == 49 and s["stems"] == ["full"] and s["star_power"] == 1
    assert s["levels_generated"] == ["easy", "hard", "medium"]
    with zipfile.ZipFile(out) as z:
        man = yaml.safe_load(z.read("manifest.yaml"))
        tab = json.loads(z.read("drum_tab.json"))
        tl = json.loads(z.read("song_timeline.json"))
        assert z.read("stems/full.ogg") == FAKE_OGG
    assert man["feedpak_version"] == "1.20.0"
    assert man["title"] == "Song" and man["artist"] == "Band" and man["album"] == "Record" and man["year"] == 2004
    assert man["arrangements"] == [{"id": "drums", "name": "Drums", "type": "drums", "drum_tab": "drum_tab.json"}]
    assert man["drum_tab"] == "drum_tab.json" and man["song_timeline"] == "song_timeline.json"
    assert man["stems"] == [{"id": "full", "file": "stems/full.ogg", "default": True}]
    assert man["cover"] == "cover.png"
    assert man["duration"] >= 8.0
    assert tab["star_power"] == [{"start_time": 0.0, "end_time": 2.0}]
    assert {lv["generated"] for lv in tab["levels"].values()} == {True}
    assert tl["beats"][0] == {"time": 0.0, "measure": 1}
    assert [s["name"] for s in tl["sections"]] == ["Intro", "Verse"]

    loaded = load_song(out.name, out.parent, tmp_path / "cache")
    assert loaded.drum_tab is not None and len(loaded.drum_tab["hits"]) == 49
    assert [p["id"] for p in loaded.drum_parts] == ["drums"]
    # no pitched arrangement: never graded as a fretted part, only the drum placeholder
    assert [a.name for a in loaded.song.arrangements] == ["Drums"]
    assert not loaded.song.arrangements[0].notes
    assert loaded.song.beats and [s.name for s in loaded.song.sections] == ["Intro", "Verse"]
    assert loaded.tempos and loaded.time_signatures


def test_convert_maps_ch_stems_and_dir_form(tmp_path):
    from scripts import ch_to_sloppak
    folder = _song_folder(tmp_path, stems=True)
    out = tmp_path / "x.sloppak"
    s = ch_to_sloppak.convert(folder, out, title="Other Title", as_dir=True)
    assert s["stems"] == ["drums", "other"]    # crowd dropped, song -> other
    assert (out / "stems" / "drums.ogg").is_file() and (out / "stems" / "other.ogg").is_file()
    assert yaml.safe_load((out / "manifest.yaml").read_text())["title"] == "Other Title"


def test_convert_sng_package(tmp_path):
    from scripts import ch_to_sloppak
    from tests.drum_fixtures import write_sng
    folder = _song_folder(tmp_path)
    files = {n: (folder / n).read_bytes() for n in ("notes.mid", "song.ogg")}
    sng = write_sng(tmp_path / "song.sng", files, {"name": "Packed", "artist": "Band", "delay": "0"})
    out = tmp_path / "p.sloppak"
    s = ch_to_sloppak.convert(sng, out)
    assert s["notes"] == 49
    with zipfile.ZipFile(out) as z:
        assert yaml.safe_load(z.read("manifest.yaml"))["title"] == "Packed"
        assert z.read("stems/full.ogg") == FAKE_OGG


def test_convert_cli_reports_errors(tmp_path, caplog):
    from scripts import ch_to_sloppak
    empty = tmp_path / "empty"
    empty.mkdir()
    assert ch_to_sloppak.main([str(empty), str(tmp_path / "o.sloppak")]) == 1
    assert "no notes.mid or notes.chart" in caplog.text
    assert not (tmp_path / "o.sloppak").exists()
