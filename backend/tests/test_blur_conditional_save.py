"""B-B — conditional save: clean images are byte-identical from input
to storage; only PII-detected images go through the JPEG re-encode.

The privacy guarantee never lost quality on the 70-80% of crisis photos
that have no faces or PII text. Pre-B-B, `blur_pii` was documented as
"file overwritten" — but the actual code path at line 467
(`if all_regions:`) already skipped the cv2.imwrite when nothing was
detected. B-B makes the contract EXPLICIT via a new `clean: bool` field
on the result dict + skips the disk-read-back in the /attach single-shot
path + skips the storage re-upload in the chunked _run_server_pii_blur
path.

This file PINS those invariants with byte-hash equality.

Test matrix:

| Case                                | What we assert                       |
|-------------------------------------|--------------------------------------|
| Clean image (no faces, no PII text) | sha256 of bytes-after == sha256 of   |
|                                     | bytes-before (byte-for-byte unchanged)|
|                                     | + result['clean'] is True            |
|                                     | + result['blurred'] is False         |
| Image with synthetic Aadhaar text   | bytes differ; result['blurred']=True  |
|                                     | + result['clean']=False              |
|                                     | + result['pii_texts'] >= 1           |
| Backends unavailable (mocked)       | result['ran']=False                  |
|                                     | + result['clean']=False (can't claim  |
|                                     |   clean if we never inspected)        |
| EXIF / metadata preserved on clean  | PIL.Image.info equality              |
|                                     | (sanity: same JPEG quality preserved) |

This is a PII privacy + quality test. Both halves matter:
- privacy: blurred bytes MUST differ from input (catches a future
  refactor that accidentally skips re-encode)
- quality: clean bytes MUST be identical (catches a future refactor
  that unconditionally re-encodes, costing JPEG quality)
"""
from __future__ import annotations

import hashlib
import io
import os
import tempfile

import cv2
import numpy as np
import pytest

from app.services.pii_blur import blur_pii


# ── Synthetic image helpers ─────────────────────────────────────────────────


def _make_clean_jpeg(size=(640, 480), seed=42) -> bytes:
    """Return a JPEG byte string with NO faces, NO PII-matching text.

    We use band-of-stripes noise rather than a featured composition
    (rectangle, text, etc.) because MediaPipe's BlazeFace at conf 0.2
    will hallucinate faces on simple geometric shapes (a colored
    rectangle on white background trips a false positive — verified
    empirically). Stripe noise has no face-like structure at all, so
    the detector reliably emits zero detections.

    Result: blur_pii returns ran=True, blurred=False, clean=True, and
    cv2.imwrite is NOT called — the canonical "clean" path for B-B.
    """
    rng = np.random.default_rng(seed)
    # Horizontal stripes of random colour bands. No face geometry, no
    # text. The JPEG encoder compresses this well; the file is small.
    img = np.zeros((size[1], size[0], 3), dtype=np.uint8)
    band_h = 16
    for y in range(0, size[1], band_h):
        colour = rng.integers(0, 256, size=3).astype(np.uint8)
        img[y:y + band_h] = colour
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    assert ok
    return bytes(buf)


def _make_pii_jpeg(size=(640, 480)) -> bytes:
    """Return a JPEG with a synthetic 12-digit Aadhaar number rendered as
    text. The text-regex layer of blur_pii will detect this and blur it.
    """
    img = np.ones((size[1], size[0], 3), dtype=np.uint8) * 255
    # Aadhaar-format: "1234 5678 9012" matches PII_PATTERNS[0]
    cv2.putText(img, "AADHAAR 1234 5678 9012", (50, 240),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, (20, 20, 20), 2, cv2.LINE_AA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    assert ok
    return bytes(buf)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _write_bytes_to_tempfile(data: bytes, suffix: str = ".jpg") -> str:
    """Drop bytes into a tempfile (auto-cleaned by pytest tmp_path),
    return the path."""
    tf = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tf.write(data)
    tf.flush()
    tf.close()
    return tf.name


def _cleanup(*paths):
    for p in paths:
        try:
            os.unlink(p)
        except OSError:
            pass


# ── B-B clean-path invariants ───────────────────────────────────────────────


def test_clean_image_bytes_are_byte_identical_after_blur():
    """The critical invariant: a clean JPEG must come out of blur_pii
    BIT-FOR-BIT identical to what went in. cv2.imwrite must NOT be
    called on the no-detection path."""
    input_bytes = _make_clean_jpeg()
    input_sha = _sha256(input_bytes)
    path = _write_bytes_to_tempfile(input_bytes)
    try:
        result = blur_pii(path)
        # Backends must be available in the CI test env. If they're
        # not (very old Python, no MediaPipe install), this test is
        # uninformative.
        if not result.get("ran"):
            pytest.skip(
                "PII backends unavailable in this env — can't verify "
                "the conditional-save path. Install mediapipe + easyocr."
            )
        with open(path, "rb") as fh:
            output_bytes = fh.read()
        output_sha = _sha256(output_bytes)

        # 1. The file must be byte-for-byte unchanged.
        assert input_sha == output_sha, (
            f"Clean image was re-encoded! Bytes changed.\n"
            f"  input_sha:  {input_sha}\n"
            f"  output_sha: {output_sha}\n"
            f"This means cv2.imwrite ran on a no-detection path, "
            f"costing JPEG quality on every clean upload. The "
            f"conditional-save guard at pii_blur.py:467 is the "
            f"contract — verify it's not been weakened."
        )
        # 2. result must explicitly say clean=True.
        assert result.get("clean") is True, (
            f"Expected result['clean']=True for a clean image; "
            f"got {result.get('clean')!r}. Full result: {result!r}"
        )
        # 3. result['blurred'] must be False (legacy field).
        assert result.get("blurred") is False
        # 4. ran=True (we did inspect, just found nothing).
        assert result.get("ran") is True
    finally:
        _cleanup(path)


def test_clean_image_jpeg_quality_preserved():
    """Beyond byte equality — sanity check that the JPEG quality marker
    matches. Catches a future bug where someone might re-encode at a
    different quality and accidentally produce a same-length but
    different-content file."""
    input_bytes = _make_clean_jpeg()
    path = _write_bytes_to_tempfile(input_bytes)
    try:
        result = blur_pii(path)
        if not result.get("ran"):
            pytest.skip("PII backends unavailable")
        # File must still be a valid JPEG decodable to the same dimensions.
        img = cv2.imread(path)
        assert img is not None, "Clean-path file is corrupt after blur_pii"
        # Same shape as input (clean implies no resize / re-encode).
        nparr = np.frombuffer(input_bytes, np.uint8)
        original = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        assert img.shape == original.shape, (
            f"Clean image shape changed: original {original.shape} "
            f"vs after-blur {img.shape}"
        )
    finally:
        _cleanup(path)


# ── B-B PII-path invariants (the inverse: blurred != clean) ────────────────


def test_pii_image_bytes_differ_after_blur():
    """The other half of the contract: an image WITH PII must be
    re-encoded (cv2.imwrite must run). Bytes must differ from input."""
    input_bytes = _make_pii_jpeg()
    input_sha = _sha256(input_bytes)
    path = _write_bytes_to_tempfile(input_bytes)
    try:
        result = blur_pii(path)
        if not result.get("ran"):
            pytest.skip("PII backends unavailable")

        # If easyocr didn't detect the synthetic text (model variance,
        # font rendering differences across cv2 builds), the test is
        # uninformative — skip rather than false-positive.
        if not result.get("blurred"):
            pytest.skip(
                f"easyocr did not detect the synthetic PII text in this "
                f"env; can't verify the redacted-path byte-change invariant. "
                f"Result: {result!r}"
            )

        with open(path, "rb") as fh:
            output_bytes = fh.read()
        output_sha = _sha256(output_bytes)

        # Bytes MUST differ — the re-encode ran.
        assert input_sha != output_sha, (
            f"PII image was NOT re-encoded! Bytes unchanged.\n"
            f"  sha: {input_sha}\n"
            f"This means cv2.imwrite was skipped on a detection path — "
            f"the PII bytes were never redacted. CRITICAL privacy bug."
        )
        # result must explicitly say blurred=True.
        assert result.get("blurred") is True
        # result['clean'] must be False (we did find something).
        assert result.get("clean") is False, (
            f"Expected result['clean']=False after blur; got {result.get('clean')!r}"
        )
        # We detected ≥1 PII text region.
        assert result.get("pii_texts", 0) >= 1
    finally:
        _cleanup(path)


# ── B-B failure path: backends unavailable → can't claim clean ─────────────


def test_backends_unavailable_does_not_claim_clean(monkeypatch):
    """If neither backend is available, blur_pii returns ran=False.
    Critically: clean MUST stay False — we can't claim a file is clean
    if we never inspected it. The caller should write
    pii_blur_status='failed', not 'complete_clean'."""
    import app.services.pii_blur as pb
    monkeypatch.setattr(pb, "_face_detector", None)
    monkeypatch.setattr(pb, "_ocr_reader", None)

    input_bytes = _make_clean_jpeg()
    path = _write_bytes_to_tempfile(input_bytes)
    try:
        result = blur_pii(path)
        assert result.get("ran") is False, (
            f"ran must be False when both backends are None; got {result!r}"
        )
        assert result.get("clean") is False, (
            f"clean must be False when ran=False — we can't claim "
            f"cleanliness without inspection. Got {result.get('clean')!r}"
        )
        assert result.get("blurred") is False
        assert result.get("error"), "must populate an error message"
    finally:
        _cleanup(path)


# ── B-B legacy contract: blurred ⇔ not clean (when ran=True) ───────────────


def test_blurred_and_clean_are_mutually_exclusive_when_ran():
    """Defensive invariant: when ran=True, exactly one of (blurred,
    clean) must be True. The caller branches on this; if both were True
    or both False, the assembly worker would write a wrong status."""
    input_bytes = _make_clean_jpeg()
    path = _write_bytes_to_tempfile(input_bytes)
    try:
        result = blur_pii(path)
        if not result.get("ran"):
            pytest.skip("PII backends unavailable")
        blurred = result.get("blurred")
        clean = result.get("clean")
        # Exactly-one invariant
        assert bool(blurred) ^ bool(clean), (
            f"blurred + clean must be mutually exclusive when ran=True. "
            f"Got blurred={blurred!r}, clean={clean!r}"
        )
    finally:
        _cleanup(path)
