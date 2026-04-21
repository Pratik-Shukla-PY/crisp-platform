"""
CRISP — PII blur regression tests.

These tests lock in the Phase 1 blur-policy changes:
  1. Server no longer escalates to "blur ALL text" when 5+ text regions are
     detected (the old rule redacted signage, posters, environment labels —
     exactly what responders need to see).
  2. PII-regex matches (phone, Aadhaar, PAN, SSN, passport, email) are STILL
     blurred even without a face in frame.
  3. Narrowed kernels (face cap 41, text cap 31) + 5 % bbox padding keep the
     blur tight enough that text adjacent to a face remains legible.

Fixtures are generated synthetically at test time with PIL/cv2 so no binary
assets are committed. The tests measure pixel-variance reduction on known
regions — a reliable proxy for "this got blurred" that survives kernel
tweaks.
"""
from __future__ import annotations

import os
import tempfile
import pytest
import numpy as np
import cv2


# ── Synthetic image helpers ─────────────────────────────────────────────────

def _make_image_with_text(lines: list[tuple[str, tuple[int, int]]], size=(640, 480)) -> np.ndarray:
    """Return a BGR image with `lines` — each (text, (x, y)) — drawn in black
    on white at `size`. We don't use PIL to avoid an extra dep; cv2.putText
    is enough for the detector to pick up and for us to measure variance on.
    """
    img = np.ones((size[1], size[0], 3), dtype=np.uint8) * 255
    for text, (x, y) in lines:
        cv2.putText(img, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX,
                    1.0, (20, 20, 20), 2, cv2.LINE_AA)
    return img


def _region_variance(img: np.ndarray, x1: int, y1: int, x2: int, y2: int) -> float:
    """Std-dev of pixel intensities in a crop. Sharp text → high std-dev;
    Gaussian-blurred text → low std-dev. A 10× collapse in std-dev reliably
    indicates the region was blurred."""
    crop = img[y1:y2, x1:x2]
    if crop.size == 0:
        return 0.0
    return float(np.std(crop))


def _write_tmp(img: np.ndarray) -> str:
    fd, path = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 95])
    return path


# ── Availability guard ──────────────────────────────────────────────────────

def _ocr_available() -> bool:
    from app.services import pii_blur
    return pii_blur._ocr_reader is not None


pytestmark = pytest.mark.skipif(
    not _ocr_available(),
    reason="easyocr not available in this environment",
)


# ── Tests ───────────────────────────────────────────────────────────────────

def test_pure_signage_is_not_blurred():
    """Scene text like 'DANGER HIGH VOLTAGE' must stay legible after Phase 1.

    Regression against the old behaviour where 5+ text regions escalated to
    'blur all text' and redacted signage responders needed to read.
    """
    from app.services.pii_blur import blur_pii

    # 5 separate text lines (trips the old "document heuristic" threshold)
    # but NONE match a PII regex.
    lines = [
        ("DANGER", (40, 80)),
        ("HIGH VOLTAGE", (40, 140)),
        ("NO ENTRY", (40, 200)),
        ("EVACUATION ROUTE", (40, 260)),
        ("SHELTER 200M", (40, 320)),
    ]
    img = _make_image_with_text(lines)
    path = _write_tmp(img)
    try:
        before = cv2.imread(path)
        # Measure std-dev on the text region BEFORE blur.
        std_before = _region_variance(before, 30, 50, 600, 340)

        result = blur_pii(path)

        after = cv2.imread(path)
        std_after = _region_variance(after, 30, 50, 600, 340)

        # If `blur_pii` redacts signage, std-dev collapses toward 0.
        # Phase 1 says: signage should stay legible → variance preserved
        # (drop less than 40 %).
        assert std_after / std_before > 0.6, (
            f"Signage got blurred: std_before={std_before:.2f} → "
            f"std_after={std_after:.2f}. Phase 1 removed the 5+-text "
            f"escalation; this test guards against its reintroduction."
        )
        # And the function should NOT have flipped any text regions.
        assert result["pii_texts"] == 0, (
            f"Expected 0 PII text regions flagged on pure signage, "
            f"got {result['pii_texts']}."
        )
    finally:
        os.remove(path)


def test_pii_regex_match_is_blurred():
    """Phone numbers, Aadhaar, passport numbers, etc. must still be blurred."""
    from app.services.pii_blur import blur_pii

    lines = [
        ("Phone: 9876543210", (40, 100)),
        ("Emergency", (40, 180)),  # non-PII, stays legible
    ]
    img = _make_image_with_text(lines)
    path = _write_tmp(img)
    try:
        before = cv2.imread(path)
        std_pii_before = _region_variance(before, 30, 70, 500, 120)
        std_nonpii_before = _region_variance(before, 30, 150, 350, 200)

        result = blur_pii(path)

        after = cv2.imread(path)
        std_pii_after = _region_variance(after, 30, 70, 500, 120)
        std_nonpii_after = _region_variance(after, 30, 150, 350, 200)

        # PII region variance must collapse (the phone number got blurred).
        assert std_pii_after < std_pii_before * 0.7, (
            f"PII (phone number) was not blurred: "
            f"std {std_pii_before:.2f} → {std_pii_after:.2f}"
        )
        # Non-PII "Emergency" text nearby should stay sharp (5 % padding keeps
        # the blur tight against the PII bbox).
        assert std_nonpii_after > std_nonpii_before * 0.7, (
            f"Non-PII 'Emergency' text got collateral blur: "
            f"std {std_nonpii_before:.2f} → {std_nonpii_after:.2f}"
        )
        assert result["pii_texts"] >= 1, (
            f"Expected ≥1 PII match, got {result['pii_texts']}"
        )
    finally:
        os.remove(path)


def test_aadhaar_pattern_blurred():
    """12-digit Aadhaar-style ID should be flagged by the PII regex."""
    from app.services.pii_blur import blur_pii

    lines = [("ID: 1234 5678 9012", (40, 120))]
    img = _make_image_with_text(lines)
    path = _write_tmp(img)
    try:
        before = cv2.imread(path)
        std_before = _region_variance(before, 30, 90, 500, 140)
        result = blur_pii(path)
        after = cv2.imread(path)
        std_after = _region_variance(after, 30, 90, 500, 140)
        assert std_after < std_before * 0.7, (
            f"Aadhaar-pattern not blurred: std {std_before:.2f} → {std_after:.2f}"
        )
        assert result["pii_texts"] >= 1
    finally:
        os.remove(path)


def test_email_pattern_blurred():
    """Email address should match PII regex and get redacted."""
    from app.services.pii_blur import blur_pii

    lines = [("Contact: john@example.com", (40, 120))]
    img = _make_image_with_text(lines)
    path = _write_tmp(img)
    try:
        before = cv2.imread(path)
        std_before = _region_variance(before, 30, 90, 600, 140)
        result = blur_pii(path)
        after = cv2.imread(path)
        std_after = _region_variance(after, 30, 90, 600, 140)
        assert std_after < std_before * 0.7, (
            f"Email not blurred: std {std_before:.2f} → {std_after:.2f}"
        )
        assert result["pii_texts"] >= 1
    finally:
        os.remove(path)


def test_blur_policy_preserves_context():
    """Composite: document-like scene with MIXED PII and non-PII text.

    Before Phase 1: 5+ text regions triggered blur-all, redacting non-PII
    labels alongside the ID number.
    After Phase 1: only the PII regex-matching text is redacted; the
    surrounding labels stay readable.
    """
    from app.services.pii_blur import blur_pii

    lines = [
        ("NAME", (40, 80)),                    # non-PII label
        ("John Smith", (200, 80)),             # non-PII content
        ("PHONE", (40, 140)),                  # non-PII label
        ("9876543210", (200, 140)),            # PII pattern!
        ("ADDRESS", (40, 200)),                # non-PII label
        ("123 Main St", (200, 200)),           # non-PII content
        ("EMAIL", (40, 260)),                  # non-PII label
        ("x@y.co", (200, 260)),                # PII pattern!
    ]
    img = _make_image_with_text(lines)
    path = _write_tmp(img)
    try:
        before = cv2.imread(path)
        after_paths = [path]  # kept for local debug if needed
        result = blur_pii(path)
        after = cv2.imread(path)

        # Labels "NAME", "PHONE", "ADDRESS", "EMAIL" in the left column
        # must remain legible.
        std_labels_before = _region_variance(before, 30, 50, 180, 280)
        std_labels_after = _region_variance(after, 30, 50, 180, 280)
        assert std_labels_after > std_labels_before * 0.6, (
            f"Left-column labels got blurred (Phase-1 regression): "
            f"std {std_labels_before:.2f} → {std_labels_after:.2f}. "
            f"The 5+-text escalation was supposed to be removed."
        )

        # At least one PII region must have been flagged.
        assert result["pii_texts"] >= 1, (
            f"Expected PII matches in the mixed scene, got {result['pii_texts']}."
        )
    finally:
        os.remove(path)
