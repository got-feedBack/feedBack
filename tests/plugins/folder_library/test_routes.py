"""Tests for the folder_library plugin backend.

Covers the pure path-safety helpers and end-to-end behaviour of the two
filesystem-mutating endpoints whose bugs this guards against:
  * /song/move must reject path traversal in `filename` (no escaping DLC_DIR).
  * /folder/delete must relocate EVERY song to the root, never destroy a song
    whose name collides with an existing root song.

The plugin's routes.py is loaded under a unique module name via importlib so it
does not collide in sys.modules with other bundled plugins' routes.py.
"""

import importlib.util
import logging
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

_ROUTES_PATH = (
    Path(__file__).resolve().parents[3]
    / "plugins" / "folder_library" / "routes.py"
)
_spec = importlib.util.spec_from_file_location("folder_library_routes", _ROUTES_PATH)
fl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fl)


# ── Pure helpers ────────────────────────────────────────────────────────────

class TestSafeName:
    @pytest.mark.parametrize("name", ["Rock", "Folder 1", "A-B_C", "über", "AC.DC"])
    def test_accepts_ordinary_names(self, name):
        assert fl._safe_name(name) is True

    @pytest.mark.parametrize("name", [
        "", "..", ".", "../x", "a/b", "a\\b", "a:b", "a*b", "a?b",
        'a"b', "a<b", "a>b", "a|b", " lead", "lead ",
    ])
    def test_rejects_unsafe_names(self, name):
        assert fl._safe_name(name) is False


class TestSafePath:
    @pytest.mark.parametrize("path", ["A", "A/B", "A/B/C", "Rock/Sub Folder"])
    def test_accepts_safe_paths(self, path):
        assert fl._safe_path(path) is True

    @pytest.mark.parametrize("path", [
        "", "..", "../x", "A/../B", "A/..", "/A", "A//B", "A/b\\c",
    ])
    def test_rejects_traversal_and_empty(self, path):
        assert fl._safe_path(path) is False


class TestIsWithin:
    def test_inside(self, tmp_path):
        assert fl._is_within(tmp_path, tmp_path / "a" / "b") is True

    def test_traversal_escapes(self, tmp_path):
        root = tmp_path / "dlc"
        root.mkdir()
        assert fl._is_within(root, root / ".." / "secret") is False

    def test_sibling_prefix_not_within(self, tmp_path):
        root = tmp_path / "dlc"
        root.mkdir()
        (tmp_path / "dlc-evil").mkdir()
        assert fl._is_within(root, tmp_path / "dlc-evil" / "x") is False


class TestIsSong:
    @pytest.mark.parametrize("name", ["a.sloppak", "a.feedpak", "A.SLOPPAK"])
    def test_song_extensions(self, name, tmp_path):
        assert fl._is_song(tmp_path / name) is True

    @pytest.mark.parametrize("name", ["a.txt", "a", "a.zip"])
    def test_non_song(self, name, tmp_path):
        assert fl._is_song(tmp_path / name) is False


# ── Endpoint behaviour ──────────────────────────────────────────────────────

@pytest.fixture
def env(tmp_path):
    dlc = tmp_path / "dlc"
    dlc.mkdir()
    app = FastAPI()
    fl.setup(app, {
        "log": logging.getLogger("folder_library_test"),
        "get_dlc_dir": lambda: str(dlc),
        "extract_meta": lambda p: {},
    })
    return TestClient(app), dlc, tmp_path


def _song(path: Path, content: str):
    path.write_text(content)


def _loose_song(folder: Path):
    """Minimal valid loose-folder song: audio + an arrangement XML (<song> root)."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "audio.wem").write_bytes(b"\x00")
    (folder / "lead.xml").write_text("<song><title>Loose</title></song>")


class TestLooseFolderRecognition:
    def test_is_song_detects_loose_folder_dir(self, tmp_path):
        loose = tmp_path / "MyLoose"
        _loose_song(loose)
        assert fl._is_song(loose) is True

    def test_plain_folder_is_not_a_song(self, tmp_path):
        plain = tmp_path / "Plain"
        plain.mkdir()
        (plain / "notes.txt").write_text("x")
        assert fl._is_song(plain) is False

    def test_loose_folder_surfaces_as_song_not_child_folder(self, env):
        client, dlc, _ = env
        _loose_song(dlc / "Rock" / "LooseSong")
        r = client.get("/api/plugins/folder_library/tree")
        assert r.status_code == 200, r.text
        rock = next(f for f in r.json()["folders"] if f["name"] == "Rock")
        assert "LooseSong" in {s["title"] for s in rock["songs"]}
        assert "LooseSong" not in {c["name"] for c in rock["children"]}


class TestMoveTraversal:
    def test_rejects_parent_traversal_and_does_not_move(self, env):
        client, dlc, tmp = env
        secret = tmp / "secret.sloppak"
        _song(secret, "TOP SECRET")
        r = client.post("/api/plugins/folder_library/song/move",
                        json={"filename": "../secret.sloppak", "folder": ""})
        assert r.status_code == 400
        # The external file must NOT have been moved into the served library.
        assert secret.exists()
        assert not (dlc / "secret.sloppak").exists()

    def test_rejects_absolute_style_traversal(self, env):
        client, dlc, tmp = env
        r = client.post("/api/plugins/folder_library/song/move",
                        json={"filename": "../../etc/passwd", "folder": ""})
        assert r.status_code == 400

    def test_valid_move_succeeds(self, env):
        client, dlc, _ = env
        _song(dlc / "A.sloppak", "a")
        (dlc / "Dest").mkdir()
        r = client.post("/api/plugins/folder_library/song/move",
                        json={"filename": "A.sloppak", "folder": "Dest"})
        assert r.status_code == 200
        assert not (dlc / "A.sloppak").exists()
        assert (dlc / "Dest" / "A.sloppak").read_text() == "a"


class TestDeleteFolderNoDataLoss:
    def test_colliding_song_is_relocated_not_destroyed(self, env):
        client, dlc, _ = env
        # A root song and a same-named song inside the folder being deleted.
        _song(dlc / "song.sloppak", "ROOT")
        (dlc / "F").mkdir()
        _song(dlc / "F" / "song.sloppak", "INSIDE")

        r = client.post("/api/plugins/folder_library/folder/delete",
                        json={"name": "F"})
        assert r.status_code == 200, r.text

        # Folder gone, original root song intact, and the colliding song
        # survived under a de-duplicated name (NOT destroyed by rmtree).
        assert not (dlc / "F").exists()
        assert (dlc / "song.sloppak").read_text() == "ROOT"
        survivors = {p.read_text() for p in dlc.glob("*.sloppak")}
        assert "INSIDE" in survivors
        assert len(list(dlc.glob("*.sloppak"))) == 2

    def test_nested_songs_all_relocated(self, env):
        client, dlc, _ = env
        (dlc / "F" / "Sub").mkdir(parents=True)
        _song(dlc / "F" / "a.sloppak", "a")
        _song(dlc / "F" / "Sub" / "b.sloppak", "b")
        r = client.post("/api/plugins/folder_library/folder/delete",
                        json={"name": "F"})
        assert r.status_code == 200, r.text
        assert not (dlc / "F").exists()
        names = {p.name for p in dlc.glob("*.sloppak")}
        assert names == {"a.sloppak", "b.sloppak"}


class TestFolderOpsValidation:
    def test_create_rejects_unsafe_name(self, env):
        client, _, _ = env
        r = client.post("/api/plugins/folder_library/folder/create",
                        json={"name": "../evil"})
        assert r.status_code == 400

    def test_create_and_rename_roundtrip(self, env):
        client, dlc, _ = env
        assert client.post("/api/plugins/folder_library/folder/create",
                           json={"name": "New"}).status_code == 200
        assert (dlc / "New").is_dir()
        assert client.post("/api/plugins/folder_library/folder/rename",
                           json={"old": "New", "new": "Renamed"}).status_code == 200
        assert (dlc / "Renamed").is_dir()
        assert not (dlc / "New").exists()
