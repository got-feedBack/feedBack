"""
Folder Browser plugin — routes.py
"""

from pathlib import Path
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
import shutil
import re


class FolderLibraryProvider:
    """Library provider that surfaces the DLC folder structure as artist/album grouping.

    Each top-level folder becomes an "artist", each subfolder becomes an "album", and
    songs sitting directly inside a folder land in a "(Unsorted)" album for that folder.
    Root-level songs (no folder) land under the "(Unsorted)" artist.
    """

    id = "folder_library"
    label = "Folders"
    kind = "local"
    capabilities = ("library.read",)

    def __init__(self, dlc_root_fn, scan_root_fn, is_song_fn, extract_meta_fn, log):
        self._dlc_root_fn = dlc_root_fn
        self._scan_root_fn = scan_root_fn
        self._is_song_fn = is_song_fn
        self._extract_meta_fn = extract_meta_fn
        self._log = log

    # ── scanning ───────────────────────────────────────────────────────

    def _get_all_songs(self):
        dlc = self._dlc_root_fn()
        if not dlc or not dlc.exists():
            return []
        root = self._scan_root_fn(dlc)
        songs = []
        self._scan_into(root, root, dlc, songs)
        return songs

    def _scan_into(self, path, root, dlc, songs):
        try:
            for entry in sorted(path.iterdir(), key=lambda p: p.name.lower()):
                if entry.name.startswith("."):
                    continue
                if self._is_song_fn(entry):
                    songs.append(self._song_dict(entry, root, dlc))
                elif entry.is_dir():
                    self._scan_into(entry, root, dlc, songs)
        except PermissionError:
            self._log.warning("folder_library provider: permission denied: %s", path)

    def _song_dict(self, p, root, dlc):
        """Build a library-compatible song dict; artist = top folder, album = subfolder."""
        try:
            rel = p.relative_to(dlc)
            filename = "/".join(rel.parts)
        except ValueError:
            filename = p.name

        # Map folder depth → artist / album
        try:
            parts = p.relative_to(root).parts  # excludes filename at end
            if len(parts) == 1:
                artist_folder = "(Unsorted)"
                album_folder = "(Unsorted)"
            elif len(parts) == 2:
                artist_folder = parts[0]
                album_folder = "(Unsorted)"
            else:
                artist_folder = parts[0]
                album_folder = "/".join(parts[1:-1])
        except ValueError:
            artist_folder = "(Unsorted)"
            album_folder = "(Unsorted)"

        d = {
            "filename": filename,
            "title": p.stem,
            "artist": artist_folder,
            "album": album_folder,
            "year": "",
            "duration": None,
            "tuning": None,
            "tuning_name": "",
            "arrangements": [],
            "has_lyrics": False,
            "mtime": None,
            "format": p.suffix.lower().lstrip(".") or "feedpak",
            "stem_count": 0,
            "stem_ids": [],
            "has_estd": False,
            "favorite": False,
        }

        try:
            d["mtime"] = p.stat().st_mtime
        except Exception:
            pass

        try:
            raw = self._extract_meta_fn(p)
            if raw:
                d["title"] = raw.get("title") or raw.get("name") or p.stem
                d["duration"] = raw.get("duration")
                raw_year = raw.get("year")
                d["year"] = str(raw_year) if raw_year is not None else ""

                tuning_raw = raw.get("tuning")
                if isinstance(tuning_raw, list):
                    d["tuning"] = tuning_raw
                elif tuning_raw is not None:
                    d["tuning"] = str(tuning_raw)

                d["tuning_name"] = raw.get("tuning_name") or (
                    raw.get("tuning") if isinstance(raw.get("tuning"), str) else ""
                ) or ""

                # arrangements — preserve full objects when available
                raw_arr = raw.get("arrangements") or []
                if isinstance(raw_arr, (list, tuple)):
                    d["arrangements"] = [
                        a if isinstance(a, dict) else {"index": i, "name": str(a), "notes": 0}
                        for i, a in enumerate(raw_arr)
                    ]

                # stems
                raw_stems = raw.get("stems") or []
                for _key in ("stems", "stem_types", "available_stems", "stemTypes"):
                    _v = raw.get(_key)
                    if _v:
                        raw_stems = _v
                        break
                if isinstance(raw_stems, (list, tuple)):
                    stem_ids = [
                        a["name"] if isinstance(a, dict) else str(a)
                        for a in raw_stems
                        if (isinstance(a, dict) and "name" in a) or isinstance(a, str)
                    ]
                    d["stem_count"] = len(stem_ids)
                    d["stem_ids"] = stem_ids

                # lyrics
                for _key in ("lyrics", "hasLyrics", "has_lyrics", "lyric", "hasLyric"):
                    _val = raw.get(_key)
                    if _val is not None:
                        if isinstance(_val, str):
                            d["has_lyrics"] = _val.lower() not in ("", "false", "no", "0")
                        else:
                            d["has_lyrics"] = bool(_val)
                        break
        except Exception as exc:
            self._log.debug("folder_library provider: meta failed for %s: %s", p.name, exc)

        return d

    # ── helpers ────────────────────────────────────────────────────────

    def _filter_search(self, songs, q):
        if not q:
            return songs
        ql = q.lower()
        return [s for s in songs if
                ql in (s.get("title") or "").lower() or
                ql in (s.get("artist") or "").lower() or
                ql in (s.get("album") or "").lower()]

    def _apply_filters(self, songs, favorites_only=False, format_filter="",
                       arrangements_has=None, arrangements_lacks=None,
                       stems_has=None, stems_lacks=None,
                       has_lyrics=None, tunings=None, **_ignored):
        def _arr_set(s):
            return {(a["name"] if isinstance(a, dict) else str(a)).lower()
                    for a in s.get("arrangements", [])}

        result = songs
        if favorites_only:
            result = [s for s in result if s.get("favorite")]
        if format_filter:
            result = [s for s in result if s.get("format") == format_filter]
        if arrangements_has:
            want = {n.lower() for n in arrangements_has}
            result = [s for s in result if _arr_set(s) & want]
        if arrangements_lacks:
            excl = {n.lower() for n in arrangements_lacks}
            result = [s for s in result if not (_arr_set(s) & excl)]
        if stems_has:
            result = [s for s in result if any(
                n.lower() in [x.lower() for x in s.get("stem_ids", [])] for n in stems_has
            )]
        if stems_lacks:
            result = [s for s in result if not any(
                n.lower() in [x.lower() for x in s.get("stem_ids", [])] for n in stems_lacks
            )]
        if has_lyrics is not None:
            result = [s for s in result if bool(s.get("has_lyrics")) == bool(has_lyrics)]
        if tunings:
            tl = {t.lower() for t in tunings}
            result = [s for s in result if (s.get("tuning_name") or "").lower() in tl]
        return result

    def _sort_songs(self, songs, sort, direction):
        reverse = (direction == "desc")
        if sort == "title":
            return sorted(songs, key=lambda s: (s.get("title") or "").lower(), reverse=reverse)
        if sort == "recent":
            return sorted(songs, key=lambda s: s.get("mtime") or 0, reverse=not reverse)
        if sort in ("year", "year-desc"):
            desc = (sort == "year-desc")
            return sorted(songs, key=lambda s: (
                not s.get("year"),
                int(s["year"]) if s.get("year", "").lstrip("-").isdigit() else 0,
            ), reverse=desc)
        if sort == "tuning":
            return sorted(songs, key=lambda s: (s.get("tuning_name") or "").lower())
        # default / artist
        return sorted(songs, key=lambda s: (s.get("artist") or "").lower(), reverse=reverse)

    # ── provider API ───────────────────────────────────────────────────

    def query_page(self, q="", page=0, size=24, sort="artist", direction="asc", **kwargs):
        songs = self._get_all_songs()
        songs = self._filter_search(songs, q)
        songs = self._apply_filters(songs, **kwargs)
        songs = self._sort_songs(songs, sort, direction)
        total = len(songs)
        return songs[page * size: page * size + size], total

    def query_artists(self, letter="", q="", page=0, size=50, **kwargs):
        from collections import OrderedDict
        songs = self._get_all_songs()
        songs = self._filter_search(songs, q)
        songs = self._apply_filters(songs, **kwargs)

        if letter == "#":
            songs = [s for s in songs if not (s.get("artist") or "?")[0:1].isalpha()]
        elif letter:
            songs = [s for s in songs
                     if (s.get("artist") or "?")[0:1].upper() == letter.upper()]

        # group folder → subfolder → songs
        artists = OrderedDict()
        for s in sorted(songs, key=lambda s: (
            (s.get("artist") or "").lower(),
            (s.get("album") or "").lower(),
            (s.get("title") or "").lower(),
        )):
            artist = s.get("artist") or "(Unsorted)"
            album = s.get("album") or "(Unsorted)"
            akey = artist.lower()
            if akey not in artists:
                artists[akey] = {"name": artist, "albums": OrderedDict()}
            bkey = album.lower()
            if bkey not in artists[akey]["albums"]:
                artists[akey]["albums"][bkey] = {"name": album, "songs": []}
            artists[akey]["albums"][bkey]["songs"].append(s)

        total_artists = len(artists)
        paged_keys = list(artists.keys())[page * size: (page + 1) * size]
        result = []
        for akey in paged_keys:
            aval = artists[akey]
            albums = [{"name": bval["name"], "songs": bval["songs"]}
                      for bval in aval["albums"].values()]
            result.append({
                "name": aval["name"],
                "album_count": len(albums),
                "song_count": sum(len(a["songs"]) for a in albums),
                "albums": albums,
            })
        return result, total_artists

    def query_stats(self, q="", **kwargs):
        from collections import defaultdict
        songs = self._get_all_songs()
        songs = self._filter_search(songs, q)
        songs = self._apply_filters(songs, **kwargs)

        total = len(songs)
        all_artists = {(s.get("artist") or "(Unsorted)").lower() for s in songs}

        letter_artists = defaultdict(set)
        for s in songs:
            artist = (s.get("artist") or "(Unsorted)").lower()
            first = (s.get("artist") or "?")[0:1].upper()
            if first.isascii() and first.isalpha():
                letter_artists[first].add(artist)
            else:
                letter_artists["#"].add(artist)

        return {
            "total_songs": total,
            "total_artists": len(all_artists),
            "letters": {k: len(v) for k, v in letter_artists.items()},
        }

    def tuning_names(self):
        from collections import defaultdict
        songs = self._get_all_songs()
        counts = defaultdict(int)
        sort_keys = {}
        for s in songs:
            name = s.get("tuning_name") or ""
            if not name:
                continue
            counts[name] += 1
            tuning = s.get("tuning")
            if isinstance(tuning, list) and name not in sort_keys:
                sort_keys[name] = sum(tuning)
        return {
            "tunings": sorted(
                [{"name": n, "sort_key": sort_keys.get(n, 0), "count": c}
                 for n, c in counts.items()],
                key=lambda x: (abs(x["sort_key"]), x["sort_key"], x["name"].lower()),
            )
        }


def setup(app, context):
    log = context["log"]
    router = APIRouter(prefix="/api/plugin/folder_library")

    # ── Two-level cache ────────────────────────────────────────────────
    # _meta_cache  — expensive extract_meta() results keyed by abs path
    #                (as_posix() string).  Never cleared; keys are updated
    #                in-place when files are moved so the data stays valid.
    # _cache       — tree structure ("folders" / "root_songs").  Cleared on
    #                every mutation so the next /tree request rebuilds it —
    #                but that rebuild is now fast because _meta_cache is warm.
    _cache      = {}   # "tree" → JSONResponse-ready dict
    _meta_cache = {}   # abs_posix_path → extracted meta (no filename/added)

    def _invalidate():
        """Clear the tree structure cache only.  _meta_cache is preserved."""
        _cache.clear()

    def _dlc_root() -> Path | None:
        try:
            return Path(context["get_dlc_dir"]())
        except Exception:
            return None

    def _scan_root(dlc: Path) -> Path:
        sloppak = dlc / "sloppak"
        return sloppak if sloppak.exists() else dlc

    def _is_song(p: Path) -> bool:
        ext = p.suffix.lower()
        if ext in (".sloppak", ".feedpak"):
            return True
        if p.is_dir() and ext in (".sloppak", ".feedpak"):
            return True
        return False

    def _safe_name(name: str) -> bool:
        if not name or name.strip() != name:
            return False
        if re.search(r'[\\/:*?"<>|]', name):
            return False
        if name in ('.', '..'):
            return False
        return True

    def _safe_path(path_str: str) -> bool:
        """Validate a slash-separated folder path — each segment must be a safe name."""
        if not path_str:
            return False
        return all(_safe_name(p) for p in path_str.split("/"))

    def _path_to_dir(root: Path, folder_path: str) -> Path:
        """Resolve a slash-separated folder path relative to root."""
        parts = folder_path.split("/")
        result = root
        for part in parts:
            result = result / part
        return result

    def _meta(p: Path, dlc: Path) -> dict:
        # filename and added are always computed fresh — they change when files move.
        try:
            filename = "/".join(p.relative_to(dlc).parts)
        except ValueError:
            filename = p.name
        added = None
        try:
            added = p.stat().st_mtime
        except Exception:
            pass

        # Return cached extracted metadata if available.
        cache_key = p.as_posix()
        if cache_key in _meta_cache:
            m = dict(_meta_cache[cache_key])   # shallow copy
            m["filename"] = filename
            m["added"]    = added
            return m

        # Cache miss — run the expensive extract.
        m = {"title": None, "artist": None, "album": None, "duration": None,
             "year": None, "tuning": None, "arrangements": [], "stems": [], "lyrics": False}
        try:
            raw = context["extract_meta"](p)
            if raw:
                m["title"]    = raw.get("title")    or raw.get("name")
                m["artist"]   = raw.get("artist")   or raw.get("artistName")
                m["album"]    = raw.get("album")     or raw.get("albumName")
                m["duration"] = raw.get("duration")
                m["year"]     = raw.get("year")
                m["tuning"]   = raw.get("tuning")

                # arrangements — objects with a "name" key e.g. [{name:"Lead",...}, ...]
                raw_arr = raw.get("arrangements") or []
                if isinstance(raw_arr, (list, tuple)):
                    m["arrangements"] = [
                        a["name"] if isinstance(a, dict) else str(a)
                        for a in raw_arr
                        if (isinstance(a, dict) and "name" in a) or isinstance(a, str)
                    ]

                # stems — may also be objects with a "name" key, same as arrangements
                raw_stems = raw.get("stems") or []
                for _key in ("stems", "stem_types", "available_stems", "stemTypes"):
                    _v = raw.get(_key)
                    if _v:
                        raw_stems = _v
                        break
                if isinstance(raw_stems, (list, tuple)):
                    m["stems"] = [
                        a["name"] if isinstance(a, dict) else str(a)
                        for a in raw_stems
                        if (isinstance(a, dict) and "name" in a) or isinstance(a, str)
                    ]

                # lyrics — try common key variants
                for _key in ("lyrics", "hasLyrics", "has_lyrics", "lyric", "hasLyric"):
                    _val = raw.get(_key)
                    if _val is not None:
                        if isinstance(_val, str):
                            m["lyrics"] = _val.lower() not in ("", "false", "no", "0")
                        else:
                            m["lyrics"] = bool(_val)
                        break
        except Exception as exc:
            log.debug("meta failed for %s: %s", p.name, exc)
        if not m["title"]:
            m["title"] = p.stem

        _meta_cache[cache_key] = m      # store without filename/added
        result = dict(m)
        result["filename"] = filename
        result["added"]    = added
        return result

    def _scan_dir(path: Path, root: Path, dlc: Path) -> dict:
        """Recursively scan a directory and return a folder node."""
        songs = []
        children = []
        try:
            for entry in sorted(path.iterdir(), key=lambda p: p.name.lower()):
                if entry.name.startswith("."):
                    continue
                if _is_song(entry):
                    songs.append(_meta(entry, dlc))
                elif entry.is_dir():
                    children.append(_scan_dir(entry, root, dlc))
        except PermissionError:
            log.warning("permission denied: %s", path)
        try:
            rel = path.relative_to(root)
            folder_path = "/".join(rel.parts)
        except ValueError:
            folder_path = path.name
        return {
            "name": path.name,
            "path": folder_path,
            "songs": songs,
            "children": children,
        }

    def _apply_tree_filters(tree, arrangements_has="", arrangements_lacks="",
                            stems_has="", stems_lacks="", has_lyrics="", tunings=""):
        """Filter a cached tree dict by arrangement/stem/lyrics/tuning params.
        The cache always holds the full unfiltered tree; this is applied per-request."""
        def _split(s):
            return [x.strip().lower() for x in s.split(",") if x.strip()] if s else []

        arr_has   = _split(arrangements_has)
        arr_lacks = _split(arrangements_lacks)
        st_has    = _split(stems_has)
        st_lacks  = _split(stems_lacks)
        tun_set   = set(_split(tunings))
        lyr       = None if has_lyrics == "" else (has_lyrics == "1")

        if not any([arr_has, arr_lacks, st_has, st_lacks, tun_set, lyr is not None]):
            return tree  # no filters active — return as-is

        def _song_ok(s):
            arrs = [a.lower() for a in (s.get("arrangements") or [])]
            stms = [x.lower() for x in (s.get("stems") or [])]
            if arr_has   and not any(a in arrs for a in arr_has):   return False
            if arr_lacks and     any(a in arrs for a in arr_lacks): return False
            if st_has    and not any(x in stms for x in st_has):    return False
            if st_lacks  and     any(x in stms for x in st_lacks):  return False
            if lyr is not None and bool(s.get("lyrics")) != lyr:    return False
            if tun_set and (s.get("tuning") or "").lower() not in tun_set: return False
            return True

        def _filter_node(node):
            return {
                "name": node["name"],
                "path": node["path"],
                "songs": [s for s in node["songs"] if _song_ok(s)],
                "children": [_filter_node(c) for c in node.get("children", [])],
            }

        return {
            "folders": [_filter_node(f) for f in tree["folders"]],
            "root_songs": [s for s in tree["root_songs"] if _song_ok(s)],
        }

    @router.get("/tree")
    def get_tree(
        arrangements_has:   str = "",
        arrangements_lacks: str = "",
        stems_has:          str = "",
        stems_lacks:        str = "",
        has_lyrics:         str = "",
        tunings:            str = "",
    ):
        if "tree" not in _cache:
            dlc = _dlc_root()
            if not dlc or not dlc.exists():
                return JSONResponse({"folders": [], "root_songs": [],
                                     "error": "DLC directory not found"})
            root = _scan_root(dlc)
            log.info("folder_browser: scanning %s", root)
            folders = []
            root_songs = []
            try:
                for entry in sorted(root.iterdir(), key=lambda p: p.name.lower()):
                    if entry.name.startswith("."):
                        continue
                    if _is_song(entry):
                        root_songs.append(_meta(entry, dlc))
                    elif entry.is_dir():
                        folders.append(_scan_dir(entry, root, dlc))
            except PermissionError:
                return JSONResponse({"folders": [], "root_songs": [],
                                     "error": "Permission denied"})
            _cache["tree"] = {"folders": folders, "root_songs": root_songs}

        result = _apply_tree_filters(
            _cache["tree"], arrangements_has, arrangements_lacks,
            stems_has, stems_lacks, has_lyrics, tunings,
        )
        return JSONResponse(result)

    @router.post("/folder/create")
    async def create_folder(request: Request):
        body = await request.json()
        name = (body.get("name") or "").strip()
        parent = (body.get("parent") or "").strip()
        if not _safe_name(name):
            return JSONResponse({"error": "Invalid folder name"}, status_code=400)
        if parent and not _safe_path(parent):
            return JSONResponse({"error": "Invalid parent path"}, status_code=400)
        dlc = _dlc_root()
        if not dlc:
            return JSONResponse({"error": "DLC dir not found"}, status_code=500)
        root = _scan_root(dlc)
        parent_dir = _path_to_dir(root, parent) if parent else root
        if parent and not parent_dir.exists():
            return JSONResponse({"error": "Parent folder not found"}, status_code=404)
        target = parent_dir / name
        if target.exists():
            return JSONResponse({"error": "Folder already exists"}, status_code=400)
        try:
            target.mkdir(parents=False)
            _invalidate()
            return JSONResponse({"ok": True})
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    @router.post("/folder/rename")
    async def rename_folder(request: Request):
        body = await request.json()
        old = (body.get("old") or "").strip()
        new = (body.get("new") or "").strip()
        if not _safe_path(old) or not _safe_name(new):
            return JSONResponse({"error": "Invalid folder name"}, status_code=400)
        dlc = _dlc_root()
        if not dlc:
            return JSONResponse({"error": "DLC dir not found"}, status_code=500)
        root = _scan_root(dlc)
        src = _path_to_dir(root, old)
        dst = src.parent / new  # rename within the same parent
        if not src.exists():
            return JSONResponse({"error": "Folder not found"}, status_code=404)
        if dst.exists():
            return JSONResponse({"error": "Name already taken"}, status_code=400)
        try:
            # Pre-compute meta cache key updates (keys change because the
            # folder path changes — all files under src get a new prefix).
            old_prefix = src.as_posix() + "/"
            new_prefix = dst.as_posix() + "/"
            meta_updates = {
                key: new_prefix + key[len(old_prefix):]
                for key in list(_meta_cache)
                if key.startswith(old_prefix)
            }
            src.rename(dst)
            _invalidate()
            for old_key, new_key in meta_updates.items():
                if old_key in _meta_cache:
                    _meta_cache[new_key] = _meta_cache.pop(old_key)
            return JSONResponse({"ok": True})
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    @router.post("/folder/delete")
    async def delete_folder(request: Request):
        body = await request.json()
        name = (body.get("name") or "").strip()
        if not _safe_path(name):
            return JSONResponse({"error": "Invalid folder path"}, status_code=400)
        dlc = _dlc_root()
        if not dlc:
            return JSONResponse({"error": "DLC dir not found"}, status_code=500)
        root = _scan_root(dlc)
        target = _path_to_dir(root, name)
        if not target.exists():
            return JSONResponse({"error": "Folder not found"}, status_code=404)
        try:
            # Move all songs (at any depth) to the scan root before deleting.
            # Keep _meta_cache keys in sync so the warm cache survives.
            for song_path in sorted(target.rglob("*")):
                if _is_song(song_path):
                    old_key = song_path.as_posix()
                    dest = root / song_path.name
                    if not dest.exists():
                        song_path.rename(dest)
                        if old_key in _meta_cache:
                            _meta_cache[dest.as_posix()] = _meta_cache.pop(old_key)
            shutil.rmtree(target)
            _invalidate()
            return JSONResponse({"ok": True})
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    @router.post("/song/move")
    async def move_song(request: Request):
        body = await request.json()
        filename = (body.get("filename") or "").strip()
        dest_folder = (body.get("folder") or "").strip()
        dlc = _dlc_root()
        if not dlc:
            return JSONResponse({"error": "DLC dir not found"}, status_code=500)
        src = dlc / Path(*filename.split("/"))
        if not src.exists():
            return JSONResponse({"error": "Song not found"}, status_code=404)
        root = _scan_root(dlc)
        if dest_folder:
            if not _safe_path(dest_folder):
                return JSONResponse({"error": "Invalid folder path"}, status_code=400)
            dst_dir = _path_to_dir(root, dest_folder)
            if not dst_dir.exists():
                return JSONResponse({"error": "Destination folder not found"}, status_code=404)
        else:
            dst_dir = root
        dst = dst_dir / src.name
        if dst.exists():
            return JSONResponse({"error": "File already exists at destination"}, status_code=400)
        try:
            old_key = src.as_posix()
            src.rename(dst)
            if old_key in _meta_cache:
                _meta_cache[dst.as_posix()] = _meta_cache.pop(old_key)
            _invalidate()
            return JSONResponse({"ok": True})
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    app.include_router(router)
    log.info("folder_browser routes registered")
