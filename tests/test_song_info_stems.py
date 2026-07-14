"""`/api/song/{f}?stems=1` — the playable stem list, for preloading.

The stems plugin could only learn its stem list from the highway's WS `ready`,
which arrives once the highway is already up. So it decoded the stems and then
copied the whole song's PCM to its audio worklet with the player on screen —
half a gigabyte of memcpy in one frame, ~700 ms, which froze the venue video.

Given the list at `song:loading` it can do all of that BEFORE the highway
appears, behind the loading overlay where a stall costs nothing.

The safety property these tests exist for: the REST payload must be the SAME
list the WS builds. If they disagree, the plugin preloads one graph and then
throws it away and rebuilds another — strictly worse than not preloading. So
they are pinned against each other, not just against a snapshot.
"""

import zipfile

import yaml

import sloppak


def _pak(tmp_path, stems, full=None, name="song.feedpak"):
    manifest = {
        "title": "T", "artist": "A", "duration": 10.0,
        "arrangements": [],
        "stems": stems,
    }
    if full:
        manifest["stems"] = stems + [full]
    p = tmp_path / name
    with zipfile.ZipFile(p, "w") as z:
        # Real packs carry manifest.yaml — a JSON manifest is not read at all.
        z.writestr("manifest.yaml", yaml.safe_dump(manifest))
    return p


def test_extract_meta_carries_file_and_default(tmp_path):
    p = _pak(tmp_path, [
        {"id": "guitar", "file": "stems/guitar.ogg"},                 # absent => on
        {"id": "vocals", "file": "stems/vocals.ogg", "default": False},
        {"id": "drums", "file": "stems/drums.ogg", "default": "off"},  # string form
    ])
    meta = sloppak.extract_meta(p)
    by_id = {s["id"]: s for s in meta["stems"]}
    assert by_id["guitar"]["default"] is True, "absent default means ON"
    assert by_id["vocals"]["default"] is False
    assert by_id["drums"]["default"] is False, "'off' must be honoured"
    assert by_id["guitar"]["file"] == "stems/guitar.ogg"


def test_the_mixdown_is_lifted_out_of_the_stem_list(tmp_path):
    # `full` is the mixdown, not a layer (spec 5.3). Listing it beside the
    # instruments would make the plugin play the whole song ON TOP of the stems.
    p = _pak(tmp_path,
             [{"id": "guitar", "file": "stems/guitar.ogg"},
              {"id": "bass", "file": "stems/bass.ogg"}],
             full={"id": "full", "file": "stems/full.ogg"})
    meta = sloppak.extract_meta(p)
    ids = [s["id"] for s in meta["stems"]]
    assert ids == ["guitar", "bass"], "the mixdown must not be a layer"
    assert meta["full_mix_file"] == "stems/full.ogg", "...but it must still be reachable"


def test_a_single_full_pack_keeps_full_as_its_only_stem(tmp_path):
    # A pack whose ONLY stem is `full` is a single-mix pack: there is nothing to
    # be pristine against, so `full` stays playable and no mixdown is surfaced.
    p = _pak(tmp_path, [{"id": "full", "file": "stems/full.ogg"}])
    meta = sloppak.extract_meta(p)
    assert [s["id"] for s in meta["stems"]] == ["full"]
    assert meta["full_mix_file"] is None


def test_default_resolution_is_shared_with_load_song(tmp_path):
    # The whole point: REST and the WS must not drift. Both go through
    # stem_default_on, so pin the helper's contract directly.
    assert sloppak.stem_default_on(True) is True
    assert sloppak.stem_default_on(False) is False
    assert sloppak.stem_default_on("off") is False
    assert sloppak.stem_default_on("false") is False
    assert sloppak.stem_default_on("0") is False
    assert sloppak.stem_default_on("no") is False
    assert sloppak.stem_default_on("on") is True
    assert sloppak.stem_default_on(1) is True


def test_rest_payload_matches_what_the_ws_would_build(tmp_path):
    """The safety property, pinned end to end.

    Rebuild the WS's stems_payload from load_song exactly as ws_highway does,
    and require the REST helper to produce the identical list.
    """
    from urllib.parse import quote
    from routers.song import _playable_stems_payload

    p = _pak(tmp_path,
             [{"id": "guitar", "file": "stems/guitar.ogg"},
              {"id": "vocals", "file": "stems/vocals.ogg", "default": "off"}],
             full={"id": "full", "file": "stems/full.ogg"},
             name="Iron Maiden - Phantom.feedpak")

    cache = tmp_path / "cache"
    cache.mkdir()
    loaded = sloppak.load_song(p.name, tmp_path, cache)

    q_fn = quote(p.name, safe="")
    ws_stems = [
        {"id": s["id"], "url": f"/api/sloppak/{q_fn}/file/{quote(s['file'])}",
         "default": s["default"]}
        for s in loaded.stems
    ]
    ws_full = f"/api/sloppak/{q_fn}/file/{quote(loaded.full_mix)}" if loaded.full_mix else None

    rest = _playable_stems_payload(p, p.name)

    assert rest["stems"] == ws_stems, (
        "REST and the WS must publish the SAME stem list — a mismatch means the "
        "plugin preloads a graph and then rebuilds it, which is worse than not "
        "preloading at all"
    )
    assert rest["full_mix_url"] == ws_full


def test_a_broken_pack_yields_an_empty_list_not_an_error(tmp_path):
    # Preloading is an optimisation. A pack we cannot read must fall back to the
    # normal WS-driven path, never break the song-info request.
    from routers.song import _playable_stems_payload
    bad = tmp_path / "bad.feedpak"
    bad.write_bytes(b"not a zip")
    assert _playable_stems_payload(bad, "bad.feedpak") == {"stems": [], "full_mix_url": None}
