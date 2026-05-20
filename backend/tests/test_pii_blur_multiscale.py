"""P1 — multi-face detection regression test.

Operator-reported (May 2026): "face blur failed completely when
more than 2 people were present in the image." Backend log showed
`faces=1` repeated for every uploaded variant — BlazeFace's
short-range model + 0.3 confidence + single-pass detection was
missing faces beyond the closest one.

Fix:
  - Lowered min_detection_confidence 0.3 → 0.2.
  - Multi-scale tiled detection (full image + 4 overlapping 60%×60%
    tiles).
  - IoU-based NMS to dedupe detections across scales.
  - Increased server-side padding 5% → 15% to absorb cross-scale
    coordinate drift.

These tests prove:
  1. _nms_merge_faces correctly dedupes overlapping bboxes from
     multi-scale detection passes.
  2. _multiscale_face_detect doesn't crash on edge-case inputs
     (tiny image, single colour, etc).
  3. The full blur_pii() path runs without error end-to-end
     (using the OPERATOR's actual model + library if present, or
     skipping cleanly if not — same pattern as the existing
     test_pii_blur_hardening.py).
"""
from __future__ import annotations

import io
import os
from pathlib import Path

import pytest

from app.services.pii_blur import (
    _nms_merge_faces,
    blur_pii,
)


# ── _nms_merge_faces — pure unit tests, no MediaPipe required ───────────────


def test_nms_dedupes_overlapping_bboxes():
    """Two highly-overlapping detections from different scales should
    collapse to one bbox (the larger of the two)."""
    detections = [
        (100, 100, 80, 80),   # 80×80 box at (100, 100) — IoU with next ~0.6
        (105, 105, 90, 90),   # 90×90 box at (105, 105) — same face, slightly off
    ]
    merged = _nms_merge_faces(detections, iou_threshold=0.4)
    assert len(merged) == 1, (
        f"Two highly-overlapping detections (one face) should NMS to 1; "
        f"got {len(merged)}"
    )
    # Largest area survives
    assert merged[0] == (105, 105, 90, 90)


def test_nms_keeps_distinct_faces():
    """Two distinct, non-overlapping faces in the same image must
    NOT be merged — that's the multi-face support."""
    detections = [
        (100, 100, 50, 50),    # Top-left face
        (500, 400, 60, 60),    # Bottom-right face
    ]
    merged = _nms_merge_faces(detections, iou_threshold=0.4)
    assert len(merged) == 2, (
        f"Distinct faces with 0 overlap must both survive NMS; got "
        f"{len(merged)} ({merged})"
    )


def test_nms_handles_3_faces_with_2_overlaps_and_1_distinct():
    """Realistic scenario: multi-scale produces 5 detections for 3
    faces — 2 detections for face A (overlapping), 2 for face B
    (overlapping), 1 for face C (alone).
    """
    detections = [
        # Face A — detected twice (full image + 1 tile)
        (100, 100, 80, 80),
        (110, 110, 70, 70),
        # Face B — detected twice (full image + 1 tile)
        (400, 200, 60, 60),
        (405, 205, 65, 65),
        # Face C — only detected by a single tile (distant face)
        (700, 500, 40, 40),
    ]
    merged = _nms_merge_faces(detections, iou_threshold=0.4)
    assert len(merged) == 3, (
        f"3 distinct faces (with 2 having duplicate detections from "
        f"multi-scale) should NMS to 3; got {len(merged)} ({merged})"
    )


def test_nms_handles_empty_list():
    assert _nms_merge_faces([]) == []


def test_nms_handles_single_detection():
    detections = [(50, 50, 100, 100)]
    assert _nms_merge_faces(detections) == detections


# ── blur_pii end-to-end smoke ───────────────────────────────────────────────


def test_blur_pii_runs_without_error_on_plain_jpeg(tmp_path):
    """End-to-end: a synthetic JPEG with no faces should run through
    blur_pii without crashing. The multi-scale loop iterates 5 times;
    none of them should raise.
    """
    # Use PIL to write a tiny synthetic JPEG (200×150 grey)
    try:
        from PIL import Image
    except ImportError:
        pytest.skip("PIL not installed")

    img = Image.new("RGB", (200, 150), color=(128, 128, 128))
    fpath = tmp_path / "synthetic.jpg"
    img.save(str(fpath), "JPEG", quality=85)

    result = blur_pii(str(fpath))

    # Contract: returns a dict with the expected shape regardless
    # of MediaPipe availability.
    assert "ran" in result
    assert "blurred" in result
    assert "faces" in result
    # No faces in synthetic grey → faces should be 0 (multi-scale
    # passes either find nothing or false-positive on noise; NMS
    # collapses any false-positives.)
    # Don't assert faces==0 strictly because the model can
    # spuriously fire on textured patterns; just confirm no crash.
    assert isinstance(result["faces"], int)
    assert result["faces"] >= 0


def test_multiscale_helper_handles_small_image(tmp_path):
    """Edge case: image smaller than the 60% tile threshold —
    multi-scale should degrade gracefully (still run the full-image
    pass; skip tiles).
    """
    try:
        from PIL import Image
    except ImportError:
        pytest.skip("PIL not installed")

    # Tiny 50×50 image — tiles at 60% would be 30×30, smaller than
    # the image, so tiles DO run; just verify nothing crashes.
    img = Image.new("RGB", (50, 50), color=(255, 0, 0))
    fpath = tmp_path / "tiny.jpg"
    img.save(str(fpath), "JPEG", quality=85)

    result = blur_pii(str(fpath))
    assert "ran" in result  # no crash
