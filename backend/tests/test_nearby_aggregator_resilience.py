"""Regression: one malformed report must never crash the /nearby aggregate.

Reproduces the PROD 500 class — a single report whose data the spatial
aggregator can't process (coordinate-less, or a naive/aware-mixed
timestamp) took down the entire nearby feature for every caller, because
the aggregator runs over the whole batch (geohash, centroid, max/min over
a bucket). The aggregators now sanitize their inputs (drop unusable-coord
rows, normalize naive timestamps to tz-aware UTC), so a bad row is
silently excluded from the PUBLIC aggregate rather than fatal.

Both crash shapes were reproduced live before the fix:
  • aggregate_nearby(null-coord)          → TypeError ('>' NoneType vs float)
  • aggregate_nearby(mixed naive/aware)   → TypeError (can't compare ...)
"""
from dataclasses import fields, MISSING
from datetime import datetime, timezone

from app.services.nearby_aggregator import (
    aggregate_nearby,
    aggregate_disaster_zones,
    NearbyReportInput,
)

BLR = (12.97, 77.59)


def _mk(**over) -> NearbyReportInput:
    """Build a NearbyReportInput, filling any required field not overridden."""
    base = dict(
        report_id="r", device_id="d", status="PENDING", severity="MODERATE",
        crisis_type="FLOOD", damage_class="PARTIAL", building_id="b1",
        infrastructure_name=None, infrastructure_name_from_osm=None,
        latitude=BLR[0], longitude=BLR[1],
        server_created_at=datetime.now(timezone.utc), trust_weight=1.0,
    )
    base.update(over)
    kw = {}
    for f in fields(NearbyReportInput):
        if f.name in base:
            kw[f.name] = base[f.name]
        elif f.default is MISSING and f.default_factory is MISSING:
            kw[f.name] = None
    return NearbyReportInput(**kw)


def test_mixed_naive_aware_timestamps_do_not_crash():
    """A report with a tz-naive client_created_at mixed with tz-aware
    reports in the same bucket must not raise."""
    reports = [
        _mk(device_id="d1", client_created_at=datetime.now(timezone.utc)),
        _mk(device_id="d2", client_created_at=datetime.now()),  # naive
    ]
    groups = aggregate_nearby(
        reports=reports, user_lat=BLR[0], user_lng=BLR[1],
        radius_km=25, group_by="building", max_groups=50,
    )
    assert isinstance(groups, list)
    # both reports share a bucket and still aggregate
    assert sum(g.count for g in groups) >= 1


def test_null_coordinate_report_is_dropped_not_fatal():
    """A coordinate-less report is excluded from the aggregate; the
    well-formed reports still surface."""
    good = _mk(device_id="d1")
    bad = _mk(device_id="d2", latitude=None, longitude=None)
    groups = aggregate_nearby(
        reports=[good, bad], user_lat=BLR[0], user_lng=BLR[1],
        radius_km=25, group_by="building", max_groups=50,
    )
    assert isinstance(groups, list)
    assert sum(g.count for g in groups) >= 1


def test_disaster_zones_resilient_to_bad_report():
    """The disaster-density path geohashes every report — it must also
    survive a coordinate-less row in the batch."""
    reports = [_mk(device_id=f"d{i}", client_created_at=datetime.now()) for i in range(3)]
    reports.append(_mk(device_id="dx", latitude=None, longitude=None))
    groups = aggregate_disaster_zones(
        reports=reports, user_lat=BLR[0], user_lng=BLR[1], radius_km=25,
    )
    assert isinstance(groups, list)


def test_all_bad_reports_yield_empty_not_crash():
    """If every candidate is unusable, return [] rather than raising."""
    reports = [_mk(device_id="dx", latitude=None, longitude=None)]
    assert aggregate_nearby(
        reports=reports, user_lat=BLR[0], user_lng=BLR[1],
        radius_km=25, group_by="building", max_groups=50,
    ) == []


def test_healthy_reports_unaffected():
    """The common path (all-valid, tz-aware) still produces a group."""
    reports = [
        _mk(device_id="d1"), _mk(device_id="d2"), _mk(device_id="d3"),
    ]
    groups = aggregate_nearby(
        reports=reports, user_lat=BLR[0], user_lng=BLR[1],
        radius_km=25, group_by="building", max_groups=50,
    )
    assert isinstance(groups, list)
    assert len(groups) >= 1
    assert sum(g.count for g in groups) >= 1
