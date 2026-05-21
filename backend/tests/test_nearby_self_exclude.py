"""May 21, 2026 — architectural-audit Item 2.

The /api/v1/reports/nearby endpoint was returning the caller's own
reports back to them, breaking the "community awareness" intent.
Pre-fix the endpoint accepted no caller identifier; per-device anti-
spam capping prevented a single device from inflating a group's count
but did NOT filter the device's submissions out entirely.

Fix: new optional `caller_device_hash` query param. Backend resolves
to device_id and filters `Report.device_id != caller_device.id` before
aggregation. Cache key includes the hash so different callers don't
share filtered cache rows. The hash is never logged (verified by a
log-capture assertion below).

Privacy posture (Option A): the caller-hash → location association
is in cache + the indexed Device lookup, but never in logs. An
operator reading backend logs sees rounded coords only — same posture
as before the filter existed.
"""
from __future__ import annotations

import uuid
import logging
import pytest

from app.models.report import (
    Device, Report, Location, SourceEnum, SeverityEnum,
    InfraTypeEnum, DamageClassEnum, ReportStatusEnum, SyncStatusEnum,
)


def _seed_report_at(db, *, device_hash: str, lat: float, lng: float,
                    status=ReportStatusEnum.VERIFIED) -> tuple[str, str]:
    """Create Device + Report + Location. Returns (report_id, device_id)."""
    d = db.query(Device).filter(Device.device_hash == device_hash).first()
    if d is None:
        d = Device(device_hash=device_hash)
        db.add(d)
        db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"nearby-{uuid.uuid4().hex[:12]}",
        sync_status=SyncStatusEnum.SYNCED,
        severity=SeverityEnum.MODERATE,
        infrastructure_type=InfraTypeEnum.ROAD,
        damage_classification=DamageClassEnum.PARTIAL,
        status=status,
        description=f"nearby test seed {device_hash}",
        expected_media=0,
        received_media=0,
    )
    db.add(r)
    db.flush()
    loc = Location(report_id=r.id, latitude=lat, longitude=lng)
    db.add(loc)
    db.commit()
    return r.id, d.id


def test_nearby_excludes_caller_own_reports_when_hash_provided(client, db):
    """Caller Device A submits a report at (12.97, 77.59). Caller B
    submits one too. Calling /nearby with A's hash returns B's report
    only — A's is filtered out by the new server-side rule.
    """
    a_hash = f"NEARBY-A-{uuid.uuid4().hex[:8]}"
    b_hash = f"NEARBY-B-{uuid.uuid4().hex[:8]}"
    c_hash = f"NEARBY-C-{uuid.uuid4().hex[:8]}"
    # Three reports at the same coord. Aggregator suppresses groups of
    # <3, so we need 3 distinct devices to clear k-anonymity.
    a_report, a_device = _seed_report_at(db, device_hash=a_hash, lat=12.97, lng=77.59)
    b_report, b_device = _seed_report_at(db, device_hash=b_hash, lat=12.97, lng=77.59)
    c_report, c_device = _seed_report_at(db, device_hash=c_hash, lat=12.97, lng=77.59)

    # Without filter: aggregator sees all 3 devices.
    no_filter = client.get(
        "/api/v1/reports/nearby",
        params={"lat": 12.97, "lng": 77.59, "radius_km": 1.0},
    )
    assert no_filter.status_code == 200, no_filter.text
    payload_unfiltered = no_filter.json()

    # With filter (Device A is the caller): A's report excluded ⇒
    # only 2 devices remain ⇒ aggregator's k-anonymity-of-3 hides the
    # group entirely OR reports a 2-device cluster depending on the
    # bucketing path. Either way, A's count must drop. We assert on
    # the aggregator's reported `n_devices` going down.
    # NOTE: hash is sent as a HEADER, not a query param, to keep it
    # out of uvicorn access logs (privacy posture Option A).
    with_filter = client.get(
        "/api/v1/reports/nearby",
        params={"lat": 12.97, "lng": 77.59, "radius_km": 1.0},
        headers={"X-Caller-Device-Hash": a_hash},
    )
    assert with_filter.status_code == 200, with_filter.text
    payload_filtered = with_filter.json()

    # The set of devices contributing to ANY group must include A
    # without the filter and EXCLUDE A with the filter.
    # The endpoint doesn't expose device_ids directly (privacy
    # invariant), so we use total report counts as the proxy: filter
    # must reduce the total by at least one bucket of A's reports.
    def _total_reports(p):
        groups = (p.get("groups") or []) + (p.get("recently_resolved_groups") or [])
        return sum(g.get("count", 0) for g in groups)

    unfiltered_total = _total_reports(payload_unfiltered)
    filtered_total = _total_reports(payload_filtered)

    assert filtered_total < unfiltered_total or filtered_total == 0, (
        f"caller_device_hash filter had no effect: "
        f"unfiltered_total={unfiltered_total}, filtered_total={filtered_total}. "
        f"Expected filtered_total to be strictly less, or 0 if k-anonymity "
        f"now suppresses the group."
    )


def test_nearby_without_hash_returns_all_devices_reports(client, db):
    """Sanity check: when no caller_device_hash is provided, the
    endpoint behaves as before (no exclusion). Ensures the fix doesn't
    regress pre-existing public-endpoint behaviour.
    """
    hash_x = f"NEARBY-X-{uuid.uuid4().hex[:8]}"
    hash_y = f"NEARBY-Y-{uuid.uuid4().hex[:8]}"
    hash_z = f"NEARBY-Z-{uuid.uuid4().hex[:8]}"
    _seed_report_at(db, device_hash=hash_x, lat=13.00, lng=77.60)
    _seed_report_at(db, device_hash=hash_y, lat=13.00, lng=77.60)
    _seed_report_at(db, device_hash=hash_z, lat=13.00, lng=77.60)

    res = client.get(
        "/api/v1/reports/nearby",
        params={"lat": 13.00, "lng": 77.60, "radius_km": 1.0},
    )
    assert res.status_code == 200, res.text
    payload = res.json()

    groups = (payload.get("groups") or []) + (payload.get("recently_resolved_groups") or [])
    total = sum(g.get("count", 0) for g in groups)
    assert total >= 3, (
        f"Without caller_device_hash filter, all 3 seeded reports should "
        f"appear in the aggregated total. Got {total}."
    )


def test_nearby_unknown_caller_hash_silently_no_ops(client, db):
    """A typoed / non-existent caller hash must NOT error or leak
    information about whether the hash exists. It should silently
    behave as if no filter were applied.
    """
    res = client.get(
        "/api/v1/reports/nearby",
        params={"lat": 14.00, "lng": 77.50, "radius_km": 1.0},
        headers={"X-Caller-Device-Hash": "PWA-NEVER-EXISTED-ON-THIS-SERVER-2026"},
    )
    assert res.status_code == 200, res.text


def test_nearby_caller_hash_not_logged(client, db, caplog):
    """Privacy invariant: the X-Caller-Device-Hash value must NEVER
    appear in APPLICATION log output. The endpoint logs only rounded
    coords + filter params (the pre-existing behaviour). The hash is
    sent as a header (not a query param) so it also doesn't enter
    uvicorn's request-line access log.

    Scope note: we filter to application-namespace records
    (`app.*`) and skip the test-client's own httpx INFO line. httpx
    isn't the production server — uvicorn is, and uvicorn does NOT
    log custom headers by default. So this assertion proves the
    application code path itself never logs the hash.
    """
    secret_hash = f"PWA-SECRET-{uuid.uuid4().hex[:12]}"
    with caplog.at_level(logging.DEBUG):
        res = client.get(
            "/api/v1/reports/nearby",
            params={"lat": 14.50, "lng": 77.40, "radius_km": 1.0},
            headers={"X-Caller-Device-Hash": secret_hash},
        )
    assert res.status_code == 200, res.text

    # Strict assertion against APPLICATION-scoped log records only.
    # `app.*` is the FastAPI application namespace; messaging_bot is
    # a sibling. httpx is the test-client transport, not production.
    app_records = [
        r for r in caplog.records
        if r.name.startswith("app.") or r.name.startswith("messaging_bot.")
    ]
    for record in app_records:
        msg = record.getMessage() if hasattr(record, "getMessage") else str(record)
        assert secret_hash not in msg, (
            f"X-Caller-Device-Hash leaked into application log: {record.name} → "
            f"{msg[:200]}. Audit Item 2 privacy posture violated."
        )
