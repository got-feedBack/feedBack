"""Tests for lib/solo_sections.py — guitar-solo detection + section insertion.

Synthetic charts: a 40-bar song (2 s bars at 120 BPM 4/4) whose lead part
chugs a repeating power-chord riff, with an optional 8-bar solo of fast,
high, non-repeating single notes dropped in.
"""

from __future__ import annotations

import copy

import solo_sections as solo

BAR = 2.0
N_BARS = 40


def _beats(n_bars: int = N_BARS) -> list[dict]:
    out = []
    for k in range(n_bars):
        for q in range(4):
            out.append({"time": k * BAR + q * BAR / 4, "measure": k + 1 if q == 0 else -1})
    return out


def _riff_bar(k: int) -> list[dict]:
    """Four identical power chords — the same pitch content every bar."""
    return [{"t": k * BAR + q * BAR / 4, "notes": [{"s": 0, "f": 3}, {"s": 1, "f": 5}]}
            for q in range(4)]


def _solo_bar(k: int, base_fret: int = 12) -> list[dict]:
    """Sixteen single notes; the fret window shifts per bar so no bar repeats."""
    return [{"t": k * BAR + i * BAR / 16, "s": 3 + i % 3, "f": base_fret + k % 8 + i % 4}
            for i in range(16)]


def _chart(solo_bars=range(20, 28), base_fret: int = 12, n_bars: int = N_BARS) -> dict:
    notes, chords = [], []
    for k in range(n_bars):
        if k in solo_bars:
            notes += _solo_bar(k, base_fret)
        else:
            chords += _riff_bar(k)
    return {"notes": notes, "chords": chords, "beats": _beats(n_bars),
            "sections": [{"name": "verse", "number": 1, "time": 0.0},
                         {"name": "chorus", "number": 1, "time": 30.0},
                         {"name": "verse", "number": 2, "time": 60.0}]}


def _rhythm(n_bars: int = N_BARS) -> dict:
    chords = []
    for k in range(n_bars):
        chords += _riff_bar(k)
    return {"notes": [], "chords": chords}


# ── bars / bar stats ─────────────────────────────────────────────────────────

def test_bars_from_beats_uses_downbeats_only():
    bars = solo.bars_from_beats(_beats(3))
    assert bars == [(0.0, 2.0), (2.0, 4.0), (4.0, 6.0)]


def test_bars_from_beats_needs_two_downbeats():
    assert solo.bars_from_beats([{"time": 0.0, "measure": 1}]) == []
    assert solo.bars_from_beats(None) == []
    # junk entries are ignored, not fatal
    assert solo.bars_from_beats([{"time": "x", "measure": 1}, 3,
                                 {"time": 0, "measure": 1}, {"time": 1, "measure": 2}]) == [(0, 1), (1, 2)]


def test_bar_stats_flags_solo_bars_not_riff_bars():
    chart = _chart()
    stats = solo.bar_stats(chart, solo.bars_from_beats(chart["beats"]))
    assert len(stats) == N_BARS
    riff, lead = stats[0], stats[20]
    assert riff["chords"] == 4 and riff["singles"] == 0
    assert not riff["soloish"] and not riff["unique"]   # the riff repeats all song long
    assert lead["singles"] == 16 and lead["nps"] == 8.0
    assert lead["soloish"] and lead["unique"]


def test_bar_stats_ignores_muted_notes():
    chart = {"notes": [{"t": 0.1, "s": 0, "f": 0, "mt": True}], "chords": []}
    assert solo.bar_stats(chart, [(0.0, 2.0)])[0]["n"] == 0


# ── find_solos ───────────────────────────────────────────────────────────────

def test_find_solos_finds_the_solo():
    regions, lead = solo.find_solos({"Lead": _chart(), "Rhythm": _rhythm()})
    assert lead == "Lead"
    chosen = [r for r in regions if r["solo"]]
    assert len(chosen) == 1
    r = chosen[0]
    assert (r["start"], r["end"], r["bars"]) == (40.0, 56.0, 8)
    assert r["rhythm_chords"] == 1.0


def test_find_solos_prefers_lead_then_combo():
    assert solo.pick_lead(["Rhythm", "Combo", "Lead"]) == "Lead"
    assert solo.pick_lead(["Rhythm", "combo"]) == "combo"
    assert solo.pick_lead(["Rhythm"]) == "Rhythm"
    assert solo.pick_lead([]) is None


def test_find_solos_none_in_a_riff_only_song():
    regions, _ = solo.find_solos({"Lead": _chart(solo_bars=())})
    assert regions == []


def test_find_solos_rejects_a_solo_at_the_very_start():
    # Bars 2-9 start at 10 % of the song — an intro lick, not a solo.
    regions, _ = solo.find_solos({"Lead": _chart(solo_bars=range(2, 10))})
    assert regions and not any(r["solo"] for r in regions)


def test_find_solos_rejects_short_runs():
    regions, _ = solo.find_solos({"Lead": _chart(solo_bars=range(20, 23))})
    assert not any(r["solo"] for r in regions)


def test_find_solos_rejects_a_line_the_rhythm_part_doubles():
    # Fast but low (frets 3-10): only a solo if the rhythm part isn't playing
    # the same line note for note.
    lead = _chart(base_fret=3)
    doubled, _ = solo.find_solos({"Lead": lead, "Rhythm": copy.deepcopy(lead)})
    assert not any(r["solo"] for r in doubled)
    chorded, _ = solo.find_solos({"Lead": lead, "Rhythm": _rhythm()})
    assert any(r["solo"] for r in chorded)


def test_find_solos_uses_song_level_beats_when_given():
    chart = _chart()
    del chart["beats"]
    assert solo.find_solos({"Lead": chart}) == ([], "Lead")
    regions, _ = solo.find_solos({"Lead": chart}, _beats())
    assert any(r["solo"] for r in regions)


def test_find_solos_picks_only_one():
    regions, _ = solo.find_solos({"Lead": _chart(solo_bars=list(range(12, 18)) + list(range(26, 32)))})
    assert sum(r["solo"] for r in regions) == 1


# ── sections ─────────────────────────────────────────────────────────────────

def test_has_solo_is_case_insensitive_substring():
    assert solo.has_solo([{"name": "Guitar Solo", "time": 1}])
    assert solo.has_solo([{"name": "solo", "time": 1}])
    assert not solo.has_solo([{"name": "verse", "time": 1}])
    assert not solo.has_solo(None)


def test_insert_solo_resumes_running_section_and_absorbs_inner():
    secs = _chart()["sections"]
    before = copy.deepcopy(secs)
    out, absorbed = solo.insert_solo(secs, 40.0, 56.0)
    assert secs == before   # input not mutated
    assert absorbed == 0
    assert [(s["name"], s["number"], s["time"]) for s in out] == [
        ("verse", 1, 0.0), ("chorus", 1, 30.0), ("solo", 1, 40.0),
        ("chorus", 2, 56.0), ("verse", 2, 60.0)]


def test_insert_solo_absorbs_sections_inside_and_renumbers():
    secs = [{"name": "verse", "number": 1, "time": 0.0},
            {"name": "chorus", "number": 1, "time": 45.0},
            {"name": "chorus", "number": 2, "time": 70.0}]
    out, absorbed = solo.insert_solo(secs, 40.0, 56.0)
    assert absorbed == 1
    assert [(s["name"], s["number"], s["time"]) for s in out] == [
        ("verse", 1, 0.0), ("solo", 1, 40.0), ("chorus", 1, 56.0), ("chorus", 2, 70.0)]


def test_insert_solo_no_duplicate_when_a_section_starts_at_the_end():
    secs = [{"name": "verse", "number": 1, "time": 0.0},
            {"name": "outro", "number": 1, "time": 56.0}]
    out, _ = solo.insert_solo(secs, 40.0, 56.0)
    assert [s["name"] for s in out] == ["verse", "solo", "outro"]


def test_insert_solo_empty_sections_seeds_default():
    out, _ = solo.insert_solo([], 40.0, 56.0)
    assert [(s["name"], s["time"]) for s in out] == [
        ("default", 0.0), ("solo", 40.0), ("default", 56.0)]


def test_insert_solo_accepts_legacy_start_time_key():
    out, _ = solo.insert_solo([{"name": "verse", "number": 1, "start_time": 0.0}], 40.0, 56.0)
    assert all("start_time" not in s for s in out)
    assert [s["time"] for s in out] == [0.0, 40.0, 56.0]
