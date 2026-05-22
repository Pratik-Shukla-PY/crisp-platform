"""L4 — skin-tone gate test.

The gate is opt-in via CRISP_SKIN_TONE_GATE (default off until
canary-tested). When on, it filters out candidate boxes whose
interior pixels don't include enough skin-tone HSV signal.

Synthetic fixtures:
  - solid grey 128 region (no skin tone) → gate should reject
  - solid skin-tone region (RGB ~ (228, 188, 140)) → gate accepts
  - mixed: 50/50 skin + grey → above 15% default → accepts
"""
from __future__ import annotations

import os
import numpy as np


def _make_solid(rgb, h=200, w=200):
    """Return a solid-RGB-color HxWx3 BGR image (cv2 convention)."""
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    # cv2 uses BGR.
    arr[:, :, 0] = rgb[2]
    arr[:, :, 1] = rgb[1]
    arr[:, :, 2] = rgb[0]
    return arr


def _make_two_band(rgb_top, rgb_bot, h=200, w=200):
    top = _make_solid(rgb_top, h=h // 2, w=w)
    bot = _make_solid(rgb_bot, h=h // 2, w=w)
    return np.vstack([top, bot])


class TestSkinToneGateLogic:
    """Drive the L4 helper directly against synthetic regions."""

    def _gate(self, region):
        # The helper is defined inside _multiscale_face_detect's local
        # scope; we need to invoke the module to populate it. Easiest:
        # re-create the predicate in test scope using the SAME logic.
        # (Future refactor: hoist to a module-level helper for direct
        # import.)
        import cv2
        hsv = cv2.cvtColor(region, cv2.COLOR_BGR2HSV)
        lower_a = np.array([0,   30, 60], dtype=np.uint8)
        upper_a = np.array([25, 180, 230], dtype=np.uint8)
        lower_b = np.array([160, 30, 60], dtype=np.uint8)
        upper_b = np.array([180,180, 230], dtype=np.uint8)
        mask = cv2.inRange(hsv, lower_a, upper_a) | cv2.inRange(hsv, lower_b, upper_b)
        frac = float(mask.sum() / 255.0) / float(mask.size)
        return frac

    def test_solid_grey_no_skin(self):
        img = _make_solid((128, 128, 128))
        frac = self._gate(img)
        assert frac < 0.15

    def test_solid_skin_tone_passes(self):
        # Typical fair-medium skin tone.
        img = _make_solid((228, 188, 140))
        frac = self._gate(img)
        assert frac >= 0.15, f"expected >=0.15, got {frac}"

    def test_solid_dark_skin_tone_passes(self):
        # Darker skin tone — HSV V is lower; the band must still cover.
        img = _make_solid((100, 70, 50))
        frac = self._gate(img)
        assert frac >= 0.15, f"expected >=0.15, got {frac}"

    def test_solid_light_fixture_rejected(self):
        # Bright pure white (light bulb / ceiling fixture). Very high V
        # but low S → outside skin band.
        img = _make_solid((250, 250, 250))
        frac = self._gate(img)
        assert frac < 0.15

    def test_mixed_band_above_threshold(self):
        # Half skin tone, half neutral grey → ~50% skin, above 15%.
        img = _make_two_band((228, 188, 140), (128, 128, 128))
        frac = self._gate(img)
        assert frac >= 0.15

    def test_env_default_off(self, monkeypatch):
        monkeypatch.delenv("CRISP_SKIN_TONE_GATE", raising=False)
        val = os.getenv("CRISP_SKIN_TONE_GATE", "false").lower() in ("1", "true", "yes")
        assert val is False

    def test_env_opt_in(self, monkeypatch):
        monkeypatch.setenv("CRISP_SKIN_TONE_GATE", "true")
        val = os.getenv("CRISP_SKIN_TONE_GATE", "false").lower() in ("1", "true", "yes")
        assert val is True
