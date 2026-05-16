"""
H3 hexagonal hierarchical spatial index helper.

Phase 5.1 (May 2026, docs/NEARBY_REPORTS_PIPELINE.md §9.4) — geospatial
scaling roadmap step G3.

Two responsibilities:

  1. `compute_cell(lat, lng)` — derive the H3 cell index for a point.
     Called from the report-creation path so `Location.h3_idx` is
     populated on insert.

  2. `cells_within_radius(lat, lng, radius_km)` — return the set of
     H3 cells covering a circle around the caller's location. Fed
     into the /nearby query as `WHERE h3_idx IN (...)` when the
     `CRISP_NEARBY_H3_MODE=1` env flag is set.

GRACEFUL DEGRADATION:

  The `h3` wheel may not install on every target arch (notably some
  Alpine variants without musl-compatible binary wheels). Import is
  wrapped: when the wheel is missing, every helper returns None /
  empty set and the caller falls back to the bbox + haversine /
  ST_DWithin paths. Production deployments include the wheel.

RESOLUTION CHOICE:

  Default resolution = 9. Per H3 reference:
    res 9 ≈ 174 m edge length ≈ 0.11 km² per hex
    res 10 ≈ 66 m edge, 4× denser
    res 8 ≈ 461 m edge, 4× sparser
  Phase 5.1 picks res 9 because the existing block-level cluster
  bucket is geohash7 (~150 m) — H3 res 9 is approximately the same
  granularity, so a future "use H3 cells for clustering, not bbox
  for distance" upgrade in nearby_aggregator.py can swap geohash7
  for H3 res 9 without changing tier triggers.
"""
from __future__ import annotations

import logging
import math
import os
from typing import Iterable, Optional

log = logging.getLogger(__name__)


# Try to import h3 at module load. Failure → all helpers degrade to
# no-ops. We log once at import time so operators can tell H3 mode is
# unavailable from the deploy logs without surprise.
try:                                                  # pragma: no cover
    import h3 as _h3                                  # type: ignore
    _H3_AVAILABLE = True
except Exception:                                     # pragma: no cover
    _h3 = None
    _H3_AVAILABLE = False
    log.info(
        "[h3_helper] python h3 wheel not installed — H3 mode will be a "
        "no-op. Install h3>=4.0.0 to enable CRISP_NEARBY_H3_MODE."
    )


_DEFAULT_RESOLUTION = int(os.environ.get("CRISP_H3_RESOLUTION", "9"))

# H3 res-9 edge length is ~174 m; res-8 is ~461 m. Worst case 1-ring
# (k=1) covers the centre cell + 6 neighbours. For a 5 km query at
# res 9, ring size k ≈ ceil(5000 / 174) ≈ 29 — that's ~30² hexes = 900
# cells. We cap radius-derived k at 60 (≈ 10 km at res 9) so we never
# build an unbounded cell list. Queries larger than that should drop
# back to bbox.
_MAX_RING_K = 60


def is_available() -> bool:
    """True iff the h3 Python wheel was importable at module load."""
    return _H3_AVAILABLE


def compute_cell(lat: float, lng: float,
                 resolution: int = _DEFAULT_RESOLUTION) -> Optional[str]:
    """Return the H3 cell index for (lat, lng) at the given resolution.

    Returns None when:
      • h3 wheel unavailable
      • lat/lng are NaN, ±inf, or out of range
      • the h3 call raises for any reason
    """
    if not _H3_AVAILABLE:
        return None
    try:
        # Guard against the obvious invalid inputs that h3 would either
        # accept (returning a degenerate cell) or raise on.
        if (lat is None or lng is None
                or math.isnan(lat) or math.isnan(lng)
                or math.isinf(lat) or math.isinf(lng)
                or not (-90.0 <= float(lat) <= 90.0)
                or not (-180.0 <= float(lng) <= 180.0)):
            return None
        return _h3.latlng_to_cell(float(lat), float(lng), int(resolution))
    except Exception:                                 # pragma: no cover
        return None


def cells_within_radius(lat: float, lng: float, radius_km: float,
                        resolution: int = _DEFAULT_RESOLUTION) -> frozenset[str]:
    """Return the set of H3 cells covering a `radius_km`-circle around
    (lat, lng). Use as `WHERE h3_idx IN (cells)` in a /nearby query.

    Returns an empty frozenset when h3 unavailable; the caller should
    drop back to its bbox / ST_DWithin path on empty.
    """
    if not _H3_AVAILABLE:
        return frozenset()
    centre = compute_cell(lat, lng, resolution)
    if centre is None:
        return frozenset()
    try:
        # H3 res-9 edge length in metres. Source: h3geo.org / h3 docs.
        # We hardcode the table rather than calling h3.average_hex_area
        # so a future h3 minor-version bump can't move the lookup.
        edge_m_by_res = {
            7: 1220.0,
            8: 461.0,
            9: 174.0,
            10: 66.0,
            11: 25.0,
        }
        edge_m = edge_m_by_res.get(int(resolution), 174.0)
        # Ring count covering the radius. Add 1 for centre + edge
        # rounding safety.
        k = int(math.ceil((radius_km * 1000.0) / edge_m)) + 1
        k = max(1, min(k, _MAX_RING_K))
        return frozenset(_h3.grid_disk(centre, k))
    except Exception:                                 # pragma: no cover
        return frozenset()


def is_h3_mode_enabled() -> bool:
    """True iff the operator set CRISP_NEARBY_H3_MODE=1 AND the wheel
    is available. Used by /nearby to decide whether to take the H3
    query path."""
    if not _H3_AVAILABLE:
        return False
    return os.environ.get("CRISP_NEARBY_H3_MODE", "").strip() in ("1", "true", "yes")
