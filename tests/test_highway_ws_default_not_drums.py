"""The highway's no-preference default must not land a player on a drum chart.

With no explicit `?arrangement=`, no instrument routing and no saved default,
the highway WS falls back to the arrangement with the most notes. Packs from
GP imports (gp2rs.convert_drum_track) and older converters carry drums as a
FRETTED arrangement named "Drums" whose notes are GM drum numbers — and a drum
chart nearly always out-counts the guitar parts, so every such song opened on
Drums, drawn as fret gems. Drum parts only win when the song has nothing else.
"""

from __future__ import annotations

import importlib
import json
import sys

import pytest
import yaml
from fastapi.testclient import TestClient

from song import Arrangement, Chord, Note
from routers.ws_highway import _most_notes_arrangement


def _arr(name, n):
    return Arrangement(name=name, notes=[Note(time=i * 0.1, string=0, fret=0) for i in range(n)])


# ── _most_notes_arrangement unit tests ──────────────────────────────────────


def test_most_notes_skips_drums():
    arrs = [_arr("Lead", 100), _arr("Rhythm", 300), _arr("Drums", 2000)]
    assert _most_notes_arrangement(arrs) == 1


def test_most_notes_skips_every_drum_spelling():
    arrs = [_arr("Percussion", 900), _arr("Drum Kit", 800), _arr("Drums 2", 700),
            _arr("Bass", 10)]
    assert _most_notes_arrangement(arrs) == 3


def test_only_drums_still_picks_the_biggest_drum_part():
    assert _most_notes_arrangement([_arr("Drums", 10)]) == 0
    assert _most_notes_arrangement([_arr("Drums", 10), _arr("Percussion", 30)]) == 1


def test_chord_notes_count_towards_the_total():
    lead = _arr("Lead", 5)
    rhythm = Arrangement(name="Rhythm", chords=[
        Chord(time=0, chord_id=0, notes=[Note(time=0, string=s, fret=2) for s in range(3)])
    ] * 3)
    assert _most_notes_arrangement([lead, rhythm, _arr("Drum Kit", 99)]) == 1


def test_names_merely_containing_drum_are_not_drums():
    # Word-boundary match: a guitar part called "Drumline Lead" is not a drum part.
    assert _most_notes_arrangement([_arr("Lead", 5), _arr("Drumline Lead", 50)]) == 1


def test_empty_song_defaults_to_first():
    assert _most_notes_arrangement([_arr("Lead", 0), _arr("Rhythm", 0)]) == 0


# ── Highway WS end-to-end ───────────────────────────────────────────────────


def _wire_arr(n):
    return {
        "notes": [{"t": i * 0.1, "s": 0, "f": 0} for i in range(n)],
        "chords": [], "anchors": [], "handshapes": [], "templates": [],
        "beats": [{"time": 0.0, "measure": 1}],
        "sections": [{"name": "intro", "number": 1, "time": 0.0}],
    }


def _write_sloppak(dlc_root, name, parts):
    """Directory-form sloppak; `parts` is [(id, display-name, note_count)]."""
    pak = dlc_root / f"{name}.sloppak"
    (pak / "arrangements").mkdir(parents=True)
    entries = []
    for arr_id, arr_name, n in parts:
        (pak / "arrangements" / f"{arr_id}.json").write_text(json.dumps(_wire_arr(n)))
        entries.append({"id": arr_id, "name": arr_name, "file": f"arrangements/{arr_id}.json"})
    (pak / "manifest.yaml").write_text(yaml.safe_dump({
        "title": name, "artist": "Tester", "duration": 10.0,
        "arrangements": entries, "stems": [],
    }, sort_keys=False))


@pytest.fixture()
def server_mod(tmp_path, monkeypatch):
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("DLC_DIR", str(tmp_path / "dlc"))
    monkeypatch.setenv("FEEDBACK_SYNC_STARTUP", "1")
    (tmp_path / "config").mkdir()
    (tmp_path / "dlc").mkdir()
    sys.modules.pop("server", None)
    server = importlib.import_module("server")
    monkeypatch.setattr(server, "load_plugins", lambda *a, **kw: None)
    monkeypatch.setattr(server, "startup_scan", lambda: None)
    import appstate as _appstate
    monkeypatch.setattr(_appstate, "sloppak_cache_dir", tmp_path / "cache")
    yield server
    conn = getattr(getattr(server, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(sys.modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


def _default_arrangement(client, filename):
    with client.websocket_connect(f"/ws/highway/{filename}") as ws:
        for _ in range(200):
            msg = ws.receive_json()
            if msg.get("error"):
                raise AssertionError(f"WS error frame: {msg}")
            if msg.get("type") == "song_info":
                return msg["arrangement"]
    raise AssertionError("no song_info frame received")


def test_ws_default_skips_a_fretted_drums_arrangement(server_mod):
    _write_sloppak(server_mod._get_dlc_dir(), "band",
                   [("drums", "Drums", 400), ("rhythm", "Rhythm", 40), ("lead", "Lead", 20)])
    with TestClient(server_mod.app) as client:
        assert _default_arrangement(client, "band.sloppak") == "Rhythm"


def test_ws_default_drum_only_song_still_loads_drums(server_mod):
    _write_sloppak(server_mod._get_dlc_dir(), "kit", [("drums", "Drums", 50)])
    with TestClient(server_mod.app) as client:
        assert _default_arrangement(client, "kit.sloppak") == "Drums"
