"""The tuning facet grouping key keeps 7/8-string tunings apart from 6-string
ones that share their name (#1074): a 7-string "Drop A" (A E A D G B E) and a
6-string "Drop A" (A E A D F# B) are different tunings."""

import sqlite3

import pytest

from metadata_db import _tuning_group_key_sql
from tunings import tuning_name

ROWS = [
    [-7, -5, -5, -5, -5, -5],    # 6-string Drop A
    [-2, 0, 0, 0, 0, 0, 0],      # 7-string Drop A
    [-2, 0, 0, 0, 0, 0, 0],      # 7-string Drop A (second song)
    [-5] * 6,                    # 6-string B Standard
    [0] * 7,                     # 7-string B Standard
    [-2, 0, 0, 0, 0, 0],         # 6-string Drop D
]


def _db():
    conn = sqlite3.connect(":memory:")
    conn.execute(
        "CREATE TABLE songs (tuning_name TEXT, tuning_offsets TEXT, "
        "rhythm_tuning_name TEXT, rhythm_tuning_offsets TEXT, rhythm_tuning_key TEXT)")
    for offs in ROWS:
        s = " ".join(str(o) for o in offs)
        name = tuning_name(offs)
        conn.execute("INSERT INTO songs VALUES (?, ?, ?, ?, ?)",
                     (name, s, name, s, "guitar-rhythm:" + s.replace(" ", ":")))
    return conn


@pytest.mark.parametrize("perspective", ["guitar-lead", "guitar-rhythm"])
def test_extended_range_named_tunings_get_their_own_group(perspective):
    key = _tuning_group_key_sql("songs", perspective)
    groups = _db().execute(
        f"SELECT {key} AS g, COUNT(*), MIN(tuning_name) FROM songs GROUP BY g").fetchall()
    by_name = {}
    for _, count, name in groups:
        by_name.setdefault(name, []).append(count)
    # One 6-string and one 7-string entry each, never merged.
    assert sorted(by_name["Drop A"]) == [1, 2]
    assert sorted(by_name["B Standard"]) == [1, 1]
    assert by_name["Drop D"] == [1]


def test_six_string_named_tunings_still_group_by_name():
    key = _tuning_group_key_sql("songs")
    keys = {g for (g,) in _db().execute(f"SELECT {key} FROM songs")}
    assert "Drop D" in keys and "Drop A" in keys and "B Standard" in keys
