"""W4 — Building-history versioning + latest-first contract.

UNDP brief (Apr 2026): reports about the same building should version,
and the dashboard should bias to the latest complete submission. Tests
pin the endpoint's new response shape (dict with `reports`, `total`,
`latest_id`) + the per-row `building_version_ordinal` / `building_is_latest`
augmentation + latest-first ordering.

Keeps the old "list" shape runnable via `isinstance` fallback in the
dashboard (for rolling backend deploys); that fallback is covered by
the Playwright dashboard suite, not here.
"""
import uuid
from datetime import datetime, timezone, timedelta


def _submit(client, device_hash, building_id, client_report_id=None):
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": device_hash,
        "client_report_id": client_report_id or str(uuid.uuid4()),
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "description": "w4 versioning test",
        "expected_media": 0,
        "location": {"latitude": 12.97, "longitude": 77.59},
        "building_id": building_id,
    })
    assert res.status_code == 201, f"{res.status_code}: {res.text}"
    return res.json()


def _backdate_server_created_at(db, report_id, hours_ago):
    """Rewind server_created_at for deterministic ordering."""
    from sqlalchemy import text
    db.execute(
        text("UPDATE reports SET server_created_at = :ts WHERE id = :id"),
        {"ts": datetime.now(timezone.utc) - timedelta(hours=hours_ago), "id": report_id},
    )
    db.commit()


class TestBuildingHistoryVersioning:

    def test_single_report_has_ordinal_1_and_is_latest(self, client):
        bid = f"osm:way:{uuid.uuid4().hex[:12]}"
        r = _submit(client, "DEV-W4-SINGLE", bid)
        res = client.get(f"/api/v1/reports/building/{bid}")
        assert res.status_code == 200
        body = res.json()
        assert body["building_id"] == bid
        assert body["total"] == 1
        assert body["latest_id"] == r["id"]
        assert len(body["reports"]) == 1
        assert body["reports"][0]["building_version_ordinal"] == 1
        assert body["reports"][0]["building_is_latest"] is True

    def test_multiple_reports_latest_first(self, client, db):
        """Three reports → latest-first ordering, only the LATEST row is
        is_latest=true. Back-dated via raw SQL so the order is
        deterministic in CI even when all three land in the same second.

        Per F.5.c (May 2026) the ordinal convention is "1 = OLDEST" — the
        max ordinal is the latest report. The endpoint sorts the response
        newest-first so the ordinals appear in DESCENDING order in the
        body. is_latest = true exactly on the row with the max ordinal.
        See backend/app/api/endpoints/reports.py:4882 for the canonical
        comment block."""
        bid = f"osm:way:{uuid.uuid4().hex[:12]}"
        old   = _submit(client, "DEV-W4-OLD",   bid)
        mid   = _submit(client, "DEV-W4-MID",   bid)
        new   = _submit(client, "DEV-W4-NEW",   bid)
        _backdate_server_created_at(db, old["id"], 72)
        _backdate_server_created_at(db, mid["id"], 24)
        # new keeps "now"

        body = client.get(f"/api/v1/reports/building/{bid}").json()
        assert body["total"] == 3
        assert body["latest_id"] == new["id"]
        ordered_ids = [row["id"] for row in body["reports"]]
        assert ordered_ids == [new["id"], mid["id"], old["id"]]
        # Ordinals are stamped at insert time by _apply_building_versioning
        # (OLD inserted first → 1, MID → 2, NEW → 3). Response is sorted
        # newest-first, so ordinals appear DESC.
        assert [row["building_version_ordinal"] for row in body["reports"]] == [3, 2, 1]
        # The newest (highest-ordinal) row is the only is_latest=true; the
        # hook flipped the older rows to false on each subsequent insert.
        assert [row["building_is_latest"] for row in body["reports"]] == [True, False, False]

    def test_soft_deleted_rows_are_excluded(self, client, admin_token, db):
        """A soft-deleted report must NOT appear in the history — even if
        it was the latest. The next-newest undeleted row becomes the new
        latest (ordinal 1)."""
        bid = f"osm:way:{uuid.uuid4().hex[:12]}"
        keep = _submit(client, "DEV-W4-KEEP", bid)
        trash = _submit(client, "DEV-W4-TRASH", bid)
        _backdate_server_created_at(db, keep["id"], 24)
        # Mark trash as soft-deleted.
        res = client.delete(
            f"/api/v1/reports/{trash['id']}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert res.status_code == 200

        body = client.get(f"/api/v1/reports/building/{bid}").json()
        assert body["total"] == 1
        assert body["latest_id"] == keep["id"]
        assert body["reports"][0]["building_is_latest"] is True

    def test_unknown_building_returns_empty_history(self, client):
        bid = "osm:way:does-not-exist"
        body = client.get(f"/api/v1/reports/building/{bid}").json()
        assert body["total"] == 0
        assert body["latest_id"] is None
        assert body["reports"] == []

    def test_response_includes_original_report_fields(self, client):
        """Ordinal augmentation must not clobber ReportResponse fields —
        the dashboard detail panel still needs severity, status, etc."""
        bid = f"osm:way:{uuid.uuid4().hex[:12]}"
        r = _submit(client, "DEV-W4-FIELDS", bid)
        row = client.get(f"/api/v1/reports/building/{bid}").json()["reports"][0]
        assert row["id"] == r["id"]
        assert row["severity"] == "MODERATE"
        assert row["crisis_type"] == "FLOOD"
        assert row["damage_classification"] == "PARTIAL"
        # Ordinal fields are additive.
        assert "building_version_ordinal" in row
        assert "building_is_latest" in row
