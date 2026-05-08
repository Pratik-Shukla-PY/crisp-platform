"""
Regression tests for `_detect_audio_format` in app.api.endpoints.reports.

Background — May 2026 audio playback bug. The legacy single-shot
base64 attach path (POST /reports + PATCH /reports/{id}/media/attach)
hardcoded `ext = "jpg" if "image" in header else "webm"`. iOS Safari
records audio as MP4/AAC; the bytes landed in S3 as `<id>.webm` with
Content-Type=audio/webm. Browser fed MP4 bytes into a WebM decoder ->
`Uncaught NotSupportedError: Failed to load because no supported
source was found`.

The fix uses magic bytes first (cannot lie) + the data: URL MIME
header second. These tests pin both paths down.
"""
from __future__ import annotations

import pytest

from app.api.endpoints.reports import _detect_audio_format


# ── Magic-byte detection (priority 1) ──────────────────────────────────────

class TestMagicByteDetection:
    """Bytes win over a lying data: URL header."""

    def test_mp4_ftyp_returns_m4a(self):
        # MP4 container: 4 bytes size + b'ftyp' at offset 4
        raw = b"\x00\x00\x00\x20ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 16
        # Header lies and says webm — bytes should win.
        ext, ct = _detect_audio_format("data:audio/webm;codecs=opus", raw)
        assert ext == "m4a"
        assert ct == "audio/mp4"

    def test_webm_ebml_returns_webm(self):
        raw = b"\x1a\x45\xdf\xa3" + b"\x00" * 28
        ext, ct = _detect_audio_format("data:audio/mp4", raw)
        assert ext == "webm"
        assert ct == "audio/webm"

    def test_ogg_returns_ogg(self):
        raw = b"OggS" + b"\x00" * 28
        ext, ct = _detect_audio_format("data:audio/anything", raw)
        assert ext == "ogg"
        assert ct == "audio/ogg"

    def test_wav_riff_returns_wav(self):
        raw = b"RIFF\x24\x00\x00\x00WAVEfmt " + b"\x00" * 16
        ext, ct = _detect_audio_format("", raw)
        assert ext == "wav"
        assert ct == "audio/wav"

    def test_caff_returns_caf(self):
        raw = b"caff" + b"\x00" * 28
        ext, ct = _detect_audio_format("data:audio/x-caf", raw)
        assert ext == "caf"
        assert ct == "audio/x-caf"

    def test_mp3_id3_returns_mp3(self):
        raw = b"ID3\x04\x00\x00" + b"\x00" * 26
        ext, ct = _detect_audio_format("", raw)
        assert ext == "mp3"
        assert ct == "audio/mpeg"

    def test_mp3_no_id3_starts_ff_returns_mp3(self):
        # No ID3 tag, MP3 frame sync byte 0xff
        raw = b"\xff\xfb\x90\x00" + b"\x00" * 28
        ext, ct = _detect_audio_format("", raw)
        assert ext == "mp3"
        assert ct == "audio/mpeg"


# ── Header fallback (priority 2) ──────────────────────────────────────────

class TestHeaderFallback:
    """When magic bytes are unrecognisable, trust the data: URL MIME."""

    def _opaque(self):
        # 32 bytes of nonsense — no magic-byte match.
        return b"\xde\xad\xbe\xef" + b"\xab" * 28

    def test_audio_mp4_header_returns_m4a(self):
        ext, ct = _detect_audio_format("data:audio/mp4;base64", self._opaque())
        assert ext == "m4a"
        assert ct == "audio/mp4"

    def test_audio_x_m4a_alias_returns_m4a(self):
        ext, ct = _detect_audio_format("data:audio/x-m4a", self._opaque())
        assert ext == "m4a"
        assert ct == "audio/mp4"

    def test_audio_aac_alias_returns_m4a(self):
        ext, ct = _detect_audio_format("data:audio/aac", self._opaque())
        assert ext == "m4a"

    def test_audio_webm_header_returns_webm(self):
        ext, ct = _detect_audio_format("data:audio/webm;codecs=opus", self._opaque())
        assert ext == "webm"
        assert ct == "audio/webm"

    def test_audio_ogg_header_returns_ogg(self):
        ext, ct = _detect_audio_format("data:audio/ogg", self._opaque())
        assert ext == "ogg"

    def test_audio_opus_alias_returns_ogg(self):
        ext, ct = _detect_audio_format("data:audio/opus", self._opaque())
        assert ext == "ogg"

    def test_audio_wav_header_returns_wav(self):
        ext, ct = _detect_audio_format("data:audio/wav", self._opaque())
        assert ext == "wav"

    def test_audio_x_wav_alias_returns_wav(self):
        ext, ct = _detect_audio_format("data:audio/x-wav", self._opaque())
        assert ext == "wav"

    def test_audio_mp3_header_returns_mp3(self):
        ext, ct = _detect_audio_format("data:audio/mp3", self._opaque())
        assert ext == "mp3"

    def test_audio_mpeg_alias_returns_mp3(self):
        ext, ct = _detect_audio_format("data:audio/mpeg", self._opaque())
        assert ext == "mp3"

    def test_case_insensitive(self):
        ext, _ = _detect_audio_format("DATA:AUDIO/MP4;BASE64", self._opaque())
        assert ext == "m4a"


# ── Default fallback (last resort) ────────────────────────────────────────

class TestDefaultFallback:
    def test_unknown_header_unknown_bytes_defaults_to_m4a(self):
        ext, ct = _detect_audio_format("data:audio/something-weird", b"\x00" * 32)
        assert ext == "m4a"  # most-portable default
        assert ct == "audio/mp4"

    def test_empty_inputs_default_to_m4a(self):
        ext, ct = _detect_audio_format("", b"")
        assert ext == "m4a"
        assert ct == "audio/mp4"

    def test_short_payload_no_magic_match(self):
        # 3 bytes — too short for any magic pattern
        ext, ct = _detect_audio_format("data:audio/anything", b"\x00\x01\x02")
        assert ext == "m4a"


# ── The exact production bug ──────────────────────────────────────────────

class TestProductionBug:
    """The specific iOS pattern that caused the May 2026 outage."""

    def test_ios_mp4_with_webm_lying_header(self):
        """iOS Safari sometimes sends data:audio/webm;... but the
        underlying MediaRecorder hands back MP4 bytes anyway. Without
        magic-byte priority the file would land as audio/webm and
        fail to decode in any browser."""
        # Real iOS m4a output starts with `ftyp` after 4 size bytes.
        ios_mp4_bytes = (
            b"\x00\x00\x00\x20ftypM4A "
            b"\x00\x00\x00\x00M4A mp42"
            + b"\x00" * 16
        )
        ext, ct = _detect_audio_format(
            "data:audio/webm;base64",  # the lie
            ios_mp4_bytes,             # the truth
        )
        # Magic bytes win → server stores .m4a with audio/mp4 → plays
        # cleanly in every browser including iOS Safari.
        assert ext == "m4a"
        assert ct == "audio/mp4"

    def test_old_behaviour_would_have_failed(self):
        """Demonstration that the new helper FIXES the production bug
        — pre-fix, every `audio/*` data: URL was renamed to .webm."""
        pre_fix_logic_result = "webm"  # what the old `else "webm"` produced
        new_logic_result, _ = _detect_audio_format(
            "data:audio/mp4",
            b"\x00\x00\x00\x20ftypisom\x00\x00\x00\x00" + b"\x00" * 16,
        )
        assert new_logic_result != pre_fix_logic_result
        assert new_logic_result == "m4a"
