"""Seek-stable caches and opt-in serving, independent of the server lifecycle."""

import concurrent.futures
import subprocess
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import browser_audio
from routers import media


@pytest.fixture
def decoder(tmp_path, monkeypatch):
    """Provide a source and a fake decoder that publishes complete audio files."""
    source = tmp_path / "song.ogg"
    source.write_bytes(b"original compressed recording")
    calls = []

    def decode(args, **kwargs):
        """Write a format marker to the requested temporary output."""
        calls.append((args, kwargs))
        # The cache publishes only a finished file, not this temporary output.
        prefix = b"\x1aE\xdf\xa3" if args[args.index("-f") + 1] == "webm" else b"RIFF"
        Path(args[-1]).write_bytes(prefix + b"x" * 100)

    monkeypatch.setattr(browser_audio, "_ffmpeg_cmd", lambda: "ffmpeg")
    monkeypatch.setattr(browser_audio.subprocess, "run", decode)
    return source, tmp_path / "cache", calls


def test_cache_is_reused_without_changing_original(decoder):
    """Reuse the decoded WAV while leaving the recording unchanged."""
    source, cache, calls = decoder
    result = browser_audio.browser_playback_copy(source, cache)
    assert result.suffix == ".wav"
    assert result.read_bytes().startswith(b"RIFF")
    assert browser_audio.browser_playback_copy(source, cache) == result
    assert len(calls) == 1
    assert source.read_bytes() == b"original compressed recording"
    args, options = calls[0]
    assert args[args.index("-c:a") + 1] == "pcm_s16le"
    assert "-ss" not in args  # full decode: no codec seek/padding ambiguity
    assert options["timeout"] == 120


def test_changed_source_gets_new_cache_entry(decoder):
    """Include the source version in the cache key."""
    source, cache, calls = decoder
    first = browser_audio.browser_playback_copy(source, cache)
    source.write_bytes(b"replacement recording of a different length")
    assert browser_audio.browser_playback_copy(source, cache) != first
    assert len(calls) == 2


def test_concurrent_requests_decode_once(decoder):
    """Concurrent requests for one song should share a conversion."""
    source, cache, calls = decoder
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: browser_audio.browser_playback_copy(source, cache), range(4)))
    assert len(set(results)) == 1
    assert len(calls) == 1


def test_cached_song_stays_available_during_another_conversion(decoder, monkeypatch):
    """A slow conversion must not block requests for an already cached song."""
    source, cache, _ = decoder
    cached = browser_audio.browser_playback_copy(source, cache)
    other = source.with_name("other.ogg")
    other.write_bytes(b"other compressed recording")
    decode = browser_audio.subprocess.run
    started = threading.Event()
    release = threading.Event()

    def slow_decode(args, **kwargs):
        """Pause only the new song's conversion."""
        if args[args.index("-i") + 1] == str(other):
            started.set()
            assert release.wait(5)
        return decode(args, **kwargs)

    monkeypatch.setattr(browser_audio.subprocess, "run", slow_decode)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        converting = pool.submit(browser_audio.browser_playback_copy, other, cache)
        try:
            assert started.wait(5)
            hit = pool.submit(browser_audio.browser_playback_copy, source, cache)
            assert hit.result(timeout=2) == cached
        finally:
            release.set()
        assert converting.result(timeout=5).is_file()


def test_different_songs_convert_concurrently(decoder, monkeypatch):
    """A conversion for one song must not stall a second uncached song."""
    source, cache, _ = decoder
    other = source.with_name("other.ogg")
    other.write_bytes(b"another recording")
    decode = browser_audio.subprocess.run
    started = {str(path): threading.Event() for path in (source, other)}
    release = threading.Event()

    def waiting_decode(args, **kwargs):
        """Wait until both source conversions have reached the decoder."""
        started[args[args.index("-i") + 1]].set()
        assert release.wait(5)
        return decode(args, **kwargs)

    monkeypatch.setattr(browser_audio.subprocess, "run", waiting_decode)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(browser_audio.browser_playback_copy, source, cache)
        second = pool.submit(browser_audio.browser_playback_copy, other, cache)
        try:
            assert all(event.wait(2) for event in started.values())
        finally:
            release.set()
        assert first.result(timeout=5).is_file()
        assert second.result(timeout=5).is_file()


def test_third_conversion_waits_for_an_ffmpeg_slot(decoder, monkeypatch):
    """Allow two conversions while a third waits for a free FFmpeg slot."""
    source, cache, _ = decoder
    sources = [source, source.with_name("second.ogg"), source.with_name("third.ogg")]
    for path in sources[1:]:
        path.write_bytes(b"another recording")
    decode = browser_audio.subprocess.run
    started = {str(path): threading.Event() for path in sources}
    release = {str(path): threading.Event() for path in sources}

    def waiting_decode(args, **kwargs):
        """Hold each decoder process until the test releases its slot."""
        path = args[args.index("-i") + 1]
        started[path].set()
        assert release[path].wait(5)
        return decode(args, **kwargs)

    monkeypatch.setattr(browser_audio.subprocess, "run", waiting_decode)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        first = pool.submit(browser_audio.browser_playback_copy, sources[0], cache)
        second = pool.submit(browser_audio.browser_playback_copy, sources[1], cache)
        try:
            assert started[str(sources[0])].wait(2)
            assert started[str(sources[1])].wait(2)
            third = pool.submit(browser_audio.browser_playback_copy, sources[2], cache)
            assert not started[str(sources[2])].wait(0.2)
            release[str(sources[0])].set()
            assert started[str(sources[2])].wait(2)
        finally:
            for event in release.values():
                event.set()
        assert all(task.result(timeout=5).is_file() for task in (first, second, third))


def test_full_conversion_queue_serves_original_audio(client, decoder, monkeypatch):
    """Do not hold a media request indefinitely while conversion slots are busy."""
    monkeypatch.setattr(browser_audio, "_conversion_slots", threading.BoundedSemaphore(0))
    monkeypatch.setattr(browser_audio, "_CONVERSION_WAIT_SECONDS", 0.01)
    response = client.get("/audio/song.ogg?playback=pcm")
    assert response.status_code == 200
    assert response.content == decoder[0].read_bytes()
    assert decoder[2] == []


def test_browser_copies_are_evicted_across_formats(vorbis, monkeypatch):
    """Keep the browser cache bounded without deleting direct audio files."""
    source, cache, _ = vorbis
    monkeypatch.setattr(browser_audio, "_MAX_BROWSER_COPIES", 2)
    cache.mkdir()
    direct = cache / "audio_original.ogg"
    direct.write_bytes(b"original")
    first = browser_audio.browser_playback_copy(source, cache)
    temporary = cache / "browser-pcm" / "tmp-in-progress.wav"
    temporary.write_bytes(b"unfinished")
    second = browser_audio.browser_playback_copy(source, cache, prefer_webm=True)
    source.write_bytes(source.read_bytes() + b"new version")
    newest = browser_audio.browser_playback_copy(source, cache)
    copies = [path for path in (cache / "browser-pcm").glob("*.wav") if path != temporary]
    copies += list((cache / "browser-webm").glob("*.webm"))
    assert len(copies) == 2
    assert newest in copies
    assert direct.read_bytes() == b"original"
    assert temporary.read_bytes() == b"unfinished"


def test_recent_cache_hit_survives_eviction(decoder, monkeypatch):
    """Use explicit hit recency when the underlying mount does not update atime."""
    source, cache, calls = decoder
    monkeypatch.setattr(browser_audio, "_MAX_BROWSER_COPIES", 2)
    first = browser_audio.browser_playback_copy(source, cache)
    second_source = source.with_name("second.ogg")
    second_source.write_bytes(b"second recording")
    second = browser_audio.browser_playback_copy(second_source, cache)
    assert browser_audio.browser_playback_copy(source, cache) == first
    third_source = source.with_name("third.ogg")
    third_source.write_bytes(b"third recording")
    third = browser_audio.browser_playback_copy(third_source, cache)
    assert first.is_file()
    assert third.is_file()
    assert not second.exists()
    assert len(calls) == 3


def test_failed_conversion_leaves_no_partial_cache(decoder, monkeypatch):
    """A timeout must remove the temporary audio output."""
    source, cache, _ = decoder

    def fail(*args, **kwargs):
        """Simulate a decoder timeout."""
        raise subprocess.TimeoutExpired("ffmpeg", 120)

    monkeypatch.setattr(browser_audio.subprocess, "run", fail)
    with pytest.raises(subprocess.TimeoutExpired):
        browser_audio.browser_playback_copy(source, cache)
    assert list((cache / "browser-pcm").iterdir()) == []


def test_other_file_types_do_not_need_ffmpeg(tmp_path, monkeypatch):
    """Pass through formats outside the Ogg family without conversion."""
    monkeypatch.setattr(browser_audio, "_ffmpeg_cmd", lambda: None)
    source = tmp_path / "original.wav"
    assert browser_audio.browser_playback_copy(source, tmp_path) == source


@pytest.fixture
def vorbis(decoder):
    """Provide an Ogg source with a Vorbis identification page."""
    source, cache, calls = decoder
    source.write_bytes(b"OggS\x00\x02" + b"\x00" * 20 + b"\x01\x1e\x01vorbis" + b"\x00" * 23)
    return source, cache, calls


def test_webm_copies_packets_and_reuses_cache(vorbis):
    """Remux Vorbis once without changing its compressed packets."""
    source, cache, calls = vorbis
    original = source.read_bytes()
    result = browser_audio.browser_playback_copy(source, cache, prefer_webm=True)
    assert result.suffix == ".webm"
    assert source.read_bytes() == original
    assert browser_audio.browser_playback_copy(source, cache, prefer_webm=True) == result
    assert len(calls) == 1
    args, _ = calls[0]
    assert args[args.index("-c:a") + 1] == "copy"
    assert args[args.index("-map") + 1] == "0:a:0"
    assert "-ss" not in args
    # A browser without WebM support still gets its separate WAV cache.
    assert browser_audio.browser_playback_copy(source, cache).suffix == ".wav"


def test_webm_cache_invalidates_on_source_change(vorbis):
    """Rebuild WebM when the source file changes."""
    source, cache, calls = vorbis
    first = browser_audio.browser_playback_copy(source, cache, prefer_webm=True)
    source.write_bytes(source.read_bytes() + b"changed")
    assert browser_audio.browser_playback_copy(source, cache, prefer_webm=True) != first
    assert len(calls) == 2


def test_concurrent_webm_requests_remux_once(vorbis):
    """Concurrent WebM requests should publish one copy."""
    source, cache, calls = vorbis
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(
            lambda _: browser_audio.browser_playback_copy(source, cache, prefer_webm=True), range(4)))
    assert len(set(results)) == 1
    assert len(calls) == 1


@pytest.mark.parametrize("content", [b"", b"OggS", b"OggS\x00\x02" + b"\x00" * 20 + b"\x01\x13OpusHead",
                                     b"unrecognized recording"])
def test_unknown_or_opus_headers_use_wav(decoder, content):
    """Use PCM when a safe Vorbis remux cannot be established."""
    source, cache, calls = decoder
    source.write_bytes(content)
    assert browser_audio.browser_playback_copy(source, cache, prefer_webm=True).suffix == ".wav"
    assert len(calls) == 1
    assert calls[0][0][calls[0][0].index("-c:a") + 1] == "pcm_s16le"


@pytest.mark.parametrize("failure", ["error", "timeout", "empty"])
def test_remux_failure_caches_wav_fallback(vorbis, monkeypatch, failure):
    """A failed remux should publish and reuse a WAV fallback."""
    source, cache, calls = vorbis
    convert = browser_audio.subprocess.run
    attempts = []

    def fail_remux(args, **kwargs):
        """Fail WebM creation while allowing the WAV decode."""
        attempts.append(args)
        if args[args.index("-f") + 1] == "webm":
            Path(args[-1]).write_bytes(b"partial")
            if failure == "timeout":
                raise subprocess.TimeoutExpired("ffmpeg", 120)
            if failure == "error":
                raise subprocess.CalledProcessError(1, "ffmpeg")
            return  # successful exit but empty/truncated output
        return convert(args, **kwargs)

    monkeypatch.setattr(browser_audio.subprocess, "run", fail_remux)
    result = browser_audio.browser_playback_copy(source, cache, prefer_webm=True)
    assert result.suffix == ".wav"
    assert browser_audio.browser_playback_copy(source, cache, prefer_webm=True) == result
    assert len(attempts) == 2
    assert list((cache / "browser-webm").iterdir()) == [result]


def test_both_conversions_failing_leaves_no_partial_files(vorbis, monkeypatch):
    """Do not publish partial output when both formats fail."""
    source, cache, _ = vorbis

    def fail(args, **kwargs):
        """Simulate a decoder that writes partial output before failing."""
        Path(args[-1]).write_bytes(b"partial")
        raise subprocess.CalledProcessError(1, "ffmpeg")

    monkeypatch.setattr(browser_audio.subprocess, "run", fail)
    with pytest.raises(subprocess.CalledProcessError):
        browser_audio.browser_playback_copy(source, cache, prefer_webm=True)
    assert list((cache / "browser-webm").iterdir()) == []


@pytest.fixture
def client(decoder, monkeypatch, tmp_path):
    """Exercise both media routes against a local test recording."""
    source, cache, _ = decoder
    monkeypatch.setattr(media, "_resolve_sloppak_local_file", lambda *args: source)
    monkeypatch.setattr(media.appstate, "audio_cache_dir", cache)
    monkeypatch.setattr(media.appstate, "static_dir", tmp_path)
    app = FastAPI()
    app.include_router(media.router)
    with TestClient(app) as client:
        yield client


@pytest.mark.parametrize("url", ["/audio/song.ogg", "/api/sloppak/song.feedpak/file/stems/full.ogg"])
def test_pcm_is_opt_in_and_supports_range_requests(client, decoder, url):
    """Serve original audio by default and byte ranges for the PCM copy."""
    original = client.get(url)
    assert original.content == b"original compressed recording"
    result = client.get(url + "?playback=pcm")
    assert result.headers["content-type"] in ("audio/wav", "audio/x-wav", "audio/vnd.wave")
    assert result.content.startswith(b"RIFF")
    ranged = client.get(url + "?playback=pcm", headers={"Range": "bytes=4-11"})
    assert ranged.status_code == 206
    assert ranged.content == result.content[4:12]
    assert len(decoder[2]) == 1


@pytest.mark.parametrize("playback", ["pcm", "webm"])
def test_resolution_error_never_reaches_decoder(client, monkeypatch, decoder, playback):
    """Reject an unsafe sloppak path before requesting conversion."""
    monkeypatch.setattr(media, "_resolve_sloppak_local_file", lambda *args: ("forbidden", 403))
    assert client.get(f"/api/sloppak/song.feedpak/file/stems/full.ogg?playback={playback}").status_code == 403
    assert decoder[2] == []


@pytest.mark.parametrize("playback", ["pcm", "webm"])
@pytest.mark.parametrize("url", ["/audio/song.ogg", "/api/sloppak/song.feedpak/file/stems/full.ogg"])
def test_conversion_failure_serves_original_audio(client, monkeypatch, playback, url):
    """Missing FFmpeg must not make an otherwise playable song silent."""
    monkeypatch.setattr(browser_audio, "_ffmpeg_cmd", lambda: None)
    response = client.get(f"{url}?playback={playback}")
    assert response.status_code == 200
    assert response.content == b"original compressed recording"


@pytest.mark.parametrize("url", ["/audio/song.ogg", "/api/sloppak/song.feedpak/file/stems/full.ogg"])
def test_webm_is_opt_in_and_range_seekable(client, vorbis, url):
    """Serve byte ranges from a remuxed WebM copy."""
    source, _, calls = vorbis
    assert client.get(url).content == source.read_bytes()
    result = client.get(url + "?playback=webm")
    assert result.headers["content-type"] == "audio/webm"
    assert result.content.startswith(b"\x1aE\xdf\xa3")
    ranged = client.get(url + "?playback=webm", headers={"Range": "bytes=4-11"})
    assert ranged.status_code == 206
    assert ranged.content == result.content[4:12]
    assert len(calls) == 1


def test_webm_request_can_return_wav(client):
    """Use WAV for Ogg content that cannot be safely remuxed."""
    result = client.get("/audio/song.ogg?playback=webm")
    assert result.headers["content-type"] in ("audio/wav", "audio/x-wav", "audio/vnd.wave")
    assert result.content.startswith(b"RIFF")


@pytest.mark.parametrize("playback", ["pcm", "webm"])
def test_audio_traversal_rejected_before_conversion(client, decoder, playback):
    """Reject path traversal before touching the decoder."""
    result = client.get(f"/audio/%2e%2e/song.ogg?playback={playback}")
    assert result.status_code == 404
    assert decoder[2] == []
