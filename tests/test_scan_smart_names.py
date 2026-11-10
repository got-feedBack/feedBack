"""Rescan rows whose cached smart_name is null but now classifiable (#1133)."""
import importlib
import json
import sys
import unittest.mock as mock

import pytest

from scan import _has_newly_resolvable_smart_names


def test_null_smart_name_with_a_now_known_name_is_resolvable():
    assert _has_newly_resolvable_smart_names(
        [{"name": "Lead", "smart_name": "Lead"}, {"name": "Rhythm 2", "smart_name": None}])


@pytest.mark.parametrize("arrs", [
    [{"name": "Take 5", "smart_name": None}],      # still unclassifiable: never re-queue
    [{"name": "Rhythm 2", "smart_name": "Rhythm"}],  # already stored
    [{"name": "Rhythm 2"}],                        # key absent: the older rule handles it
    [{"name": None, "smart_name": None}, "junk"],  # malformed cache rows
])
def test_other_rows_are_not_resolvable(arrs):
    assert not _has_newly_resolvable_smart_names(arrs)


@pytest.fixture()
def scan_server(tmp_path, monkeypatch, isolate_logging, reset_scan_state):
    import concurrent.futures
    monkeypatch.setenv("CONFIG_DIR", str(tmp_path))
    monkeypatch.delenv("DLC_DIR", raising=False)
    sys.modules.pop("server", None)
    mod = importlib.import_module("server")
    import scan as scan_mod
    monkeypatch.setattr(scan_mod, "_make_scan_executor",
                        lambda: concurrent.futures.ThreadPoolExecutor(max_workers=4))
    yield mod
    conn = getattr(getattr(mod, "meta_db", None), "conn", None)
    if conn is not None:
        getattr(sys.modules.get("server"), "_join_background_db_threads", lambda: None)()
        conn.close()


def test_refresh_backfills_a_stale_null_smart_name_once(tmp_path, scan_server):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    (dlc / "song.feedpak").write_bytes(b"")
    (tmp_path / "config.json").write_text(json.dumps({"dlc_dir": str(dlc)}), encoding="utf-8")
    scan = importlib.import_module("scan")
    seen: list[str] = []
    stored = {"smart": None}   # what the extractor writes: old fallback first

    def mock_extract(f, dlc_dir):
        seen.append(f.name)
        return {"title": f.name, "artist": "A", "album": "",
                "arrangements": [{"index": 0, "name": "Rhythm 2", "notes": 0,
                                  "smart_name": stored["smart"]}]}

    with mock.patch("scan_worker._extract_meta_for_file", new=mock_extract):
        scan.background_scan()
        assert "song.feedpak" in seen

        stored["smart"] = "Rhythm"   # the current fallback classifies it
        seen.clear()
        scan.background_scan(force=True)
        assert "song.feedpak" in seen, "a stale null must re-extract on Refresh"
        arrs = json.loads(scan.appstate.meta_db.conn.execute(
            "SELECT arrangements FROM songs WHERE filename = 'song.feedpak'").fetchone()[0])
        assert arrs[0]["smart_name"] == "Rhythm"

        seen.clear()
        scan.background_scan(force=True)
        assert "song.feedpak" not in seen, "converged: no re-extract once the type is stored"
