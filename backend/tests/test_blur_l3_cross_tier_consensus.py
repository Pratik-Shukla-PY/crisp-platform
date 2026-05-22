"""L3 — cross-tier consensus algorithm tests.

Validates the IoU-based consensus logic that distinguishes
resolution-consistent face detections (real faces) from
resolution-dependent ones (BlazeFace false positives).
"""
from __future__ import annotations

from app.services.pii_blur_l3 import (
    _box_iou,
    cross_tier_consensus,
    unconfirmed_per_tier,
)


class TestBoxIoU:
    def test_identical_boxes_iou_is_1(self):
        import pytest
        a = {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}
        b = {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}
        # Float precision: IoU computes as 0.04/0.04 with a tiny FP error.
        assert _box_iou(a, b) == pytest.approx(1.0, abs=1e-6)

    def test_no_overlap_iou_is_0(self):
        a = {"x": 0.0, "y": 0.0, "w": 0.1, "h": 0.1}
        b = {"x": 0.5, "y": 0.5, "w": 0.1, "h": 0.1}
        assert _box_iou(a, b) == 0.0

    def test_partial_overlap(self):
        # Two unit boxes offset by half — IoU ≈ 1/7
        a = {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
        b = {"x": 0.5, "y": 0.5, "w": 1.0, "h": 1.0}
        iou = _box_iou(a, b)
        assert 0.14 <= iou <= 0.15

    def test_degenerate_box_iou_is_0(self):
        a = {"x": 0.1, "y": 0.1, "w": 0.0, "h": 0.0}
        b = {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}
        assert _box_iou(a, b) == 0.0


class TestCrossTierConsensus:
    def test_real_face_appears_in_all_three_tiers_confirmed(self):
        # Same box across all 3 tiers → confirmed.
        box = {"x": 0.3, "y": 0.2, "w": 0.15, "h": 0.18}
        out = cross_tier_consensus({
            "SMALL":    [box],
            "MEDIUM":   [box],
            "ORIGINAL": [box],
        })
        assert len(out) == 1
        # Confirms across all 3 tiers.
        assert out[0]["tiers_confirmed"] == ["MEDIUM", "ORIGINAL", "SMALL"]

    def test_fp_only_at_one_tier_dropped(self):
        # Photo #A's iPhone repro: SMALL detects 5, MEDIUM detects 3 —
        # the 2 extra at SMALL that don't appear in MEDIUM are FPs.
        small_real = {"x": 0.3, "y": 0.2, "w": 0.15, "h": 0.18}
        small_fp1  = {"x": 0.7, "y": 0.7, "w": 0.05, "h": 0.05}  # light fixture
        small_fp2  = {"x": 0.1, "y": 0.8, "w": 0.04, "h": 0.05}  # vegetation
        medium_real = small_real
        out = cross_tier_consensus({
            "SMALL":  [small_real, small_fp1, small_fp2],
            "MEDIUM": [medium_real],
        })
        # Only the real-face cluster has ≥2 confirming tiers.
        assert len(out) == 1
        assert {"SMALL", "MEDIUM"} == set(out[0]["tiers_confirmed"])

    def test_no_consensus_returns_empty(self):
        # All boxes are FPs and each appears at only one tier → no
        # consensus.
        out = cross_tier_consensus({
            "SMALL":    [{"x": 0.1, "y": 0.1, "w": 0.05, "h": 0.05}],
            "MEDIUM":   [{"x": 0.5, "y": 0.5, "w": 0.05, "h": 0.05}],
            "ORIGINAL": [{"x": 0.9, "y": 0.9, "w": 0.05, "h": 0.05}],
        })
        assert out == []

    def test_min_tiers_3_requires_all_three(self):
        box = {"x": 0.3, "y": 0.2, "w": 0.15, "h": 0.18}
        # Only 2 of 3 tiers detect — fails min_tiers=3.
        out = cross_tier_consensus({
            "SMALL":  [box],
            "MEDIUM": [box],
        }, min_tiers=3)
        assert out == []
        # Now all 3 detect.
        out2 = cross_tier_consensus({
            "SMALL":    [box],
            "MEDIUM":   [box],
            "ORIGINAL": [box],
        }, min_tiers=3)
        assert len(out2) == 1


class TestUnconfirmedPerTier:
    def test_returns_per_tier_fp_candidates(self):
        # Photo with 1 real face + 1 SMALL-only FP.
        real = {"x": 0.3, "y": 0.2, "w": 0.15, "h": 0.18}
        small_only_fp = {"x": 0.7, "y": 0.7, "w": 0.05, "h": 0.05}
        out = unconfirmed_per_tier({
            "SMALL":    [real, small_only_fp],
            "MEDIUM":   [real],
            "ORIGINAL": [real],
        })
        # SMALL has the FP candidate; MEDIUM + ORIGINAL have none.
        assert len(out["SMALL"]) == 1
        assert out["SMALL"][0] == small_only_fp
        assert out["MEDIUM"] == []
        assert out["ORIGINAL"] == []

    def test_empty_input(self):
        out = unconfirmed_per_tier({"SMALL": [], "MEDIUM": [], "ORIGINAL": []})
        assert out == {"SMALL": [], "MEDIUM": [], "ORIGINAL": []}


class TestOperatorIPhoneScenarioRepro:
    """Replay the operator's iPhone test: 3 photos, 1 with a face,
    BlazeFace produces 5/3/5 detections on photo A (FPs), 2/3 on
    photo B (FPs), 1/1/1 on photo C (real). L3 vote should classify:
      Photo A: 0-1 boxes confirmed (depending on FP overlap)
      Photo B: 0-1 boxes confirmed
      Photo C: 1 box confirmed
    """

    def test_photo_c_real_face_confirms(self):
        # Photo C: one real face detected consistently.
        face = {"x": 0.4, "y": 0.3, "w": 0.20, "h": 0.25}
        out = cross_tier_consensus({
            "SMALL":    [face],
            "MEDIUM":   [face],
            "ORIGINAL": [face],
        })
        assert len(out) == 1

    def test_photo_a_disagreeing_fps_drop(self):
        # Photo A: BlazeFace at SMALL detects 5 things at random
        # locations; at MEDIUM detects 3 at DIFFERENT locations;
        # at ORIGINAL detects 5 at YET DIFFERENT locations. No
        # cluster has tiers from ≥2 sources → no consensus → 0 blurs.
        out = cross_tier_consensus({
            "SMALL": [
                {"x": 0.10, "y": 0.10, "w": 0.04, "h": 0.04},
                {"x": 0.20, "y": 0.20, "w": 0.04, "h": 0.04},
                {"x": 0.30, "y": 0.30, "w": 0.04, "h": 0.04},
                {"x": 0.40, "y": 0.40, "w": 0.04, "h": 0.04},
                {"x": 0.50, "y": 0.50, "w": 0.04, "h": 0.04},
            ],
            "MEDIUM": [
                {"x": 0.05, "y": 0.05, "w": 0.04, "h": 0.04},
                {"x": 0.15, "y": 0.15, "w": 0.04, "h": 0.04},
                {"x": 0.25, "y": 0.25, "w": 0.04, "h": 0.04},
            ],
            "ORIGINAL": [
                {"x": 0.60, "y": 0.60, "w": 0.04, "h": 0.04},
                {"x": 0.70, "y": 0.70, "w": 0.04, "h": 0.04},
                {"x": 0.80, "y": 0.80, "w": 0.04, "h": 0.04},
                {"x": 0.90, "y": 0.90, "w": 0.04, "h": 0.04},
                {"x": 0.95, "y": 0.95, "w": 0.04, "h": 0.04},
            ],
        })
        assert out == [], (
            "All disagreeing FPs should fail the ≥2-tier vote — got "
            f"{out}"
        )
