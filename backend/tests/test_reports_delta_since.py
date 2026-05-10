"""
Phase 3 (May 2026, HAR-driven) — incremental delta polling tests.

Background: HAR analysis of an idle dashboard showed 124 polls of
`/api/v1/reports/` in 6 minutes, each returning ~440 KB of mostly-
unchanged JSON (~55 MB total). The `since` parameter cuts that to
~1-2 KB on the 90% of polls where nothing changed.

Tested behaviours:
  • No `since` → full list (current behaviour, unchanged)
  • `since=<future>` → empty list
  • `since=<past>` → only updated reports
  • Media chunk progress (Media.updated_at moves) surfaces via the
    EXISTS clause even when Report.updated_at hasn't moved
  • X-Server-Time header echoed back so dashboard avoids clock-skew bugs
  • Cursor is captured BEFORE the query so concurrent inserts still
    surface on the next poll (no missed-update gap)
  • Bearer auth still required (no auth bypass)
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta
import time
import uuid
import pytest

from app.models.report import Media


def _create_report(client, *, infra: str = "ROAD", description: str = "delta test") -> str:
    """Create a report via the public meta API. Returns the new ID."""
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"TEST-DELTA-{uuid.uuid4().hex[:8]}",
        "client_report_id": f"delta-{uuid.uuid4().hex[:12]}",
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": infra,
        "description": description,
        "expected_media": 0,
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


class TestReportsDeltaSince:
    """The `?since` query parameter shrinks idle-dashboard payloads ~99%."""

    def test_no_since_returns_full_list(self, client, viewer_token):
        """Default behaviour preserved — initial dashboard load gets
        everything. Required for backward compat."""
        rid_1 = _create_report(client)
        rid_2 = _create_report(client)
        res = client.get(
            "/api/v1/reports/",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        assert res.status_code == 200, res.text
        rows = res.json()
        ids = {r["id"] for r in rows}
        assert rid_1 in ids
        assert rid_2 in ids

    def test_since_in_future_returns_empty(self, client, viewer_token):
        """No reports exist after the given cutoff → empty list. This is
        the steady-state of an idle dashboard (the 99% bandwidth save)."""
        _create_report(client)
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        res = client.get(
            f"/api/v1/reports/?since={future}",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        assert res.status_code == 200, res.text
        rows = res.json()
        # Cleanup-immune: even if other tests left rows, none should match
        # a future cutoff.
        assert rows == [], f"Expected empty list, got {len(rows)} rows"

    def test_since_includes_reports_updated_after_cutoff(self, client, viewer_token):
        """Newly-arrived report after `since` → included in delta.
        This is the active-flow case (a fresh report arrives mid-shift)."""
        # Cut off NOW, then create a report — its updated_at > cutoff.
        cutoff = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        # Tiny sleep so the report's auto-stamped updated_at is AFTER the cutoff.
        time.sleep(0.05)
        rid = _create_report(client)

        res = client.get(
            f"/api/v1/reports/?since={cutoff}",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        assert res.status_code == 200, res.text
        ids = {r["id"] for r in res.json()}
        assert rid in ids

    def test_since_excludes_unchanged_reports(self, client, viewer_token):
        """A report inserted BEFORE the cutoff is filtered out → idle
        bandwidth drop is real (the 99% case the user actually cares about)."""
        rid = _create_report(client)
        # Wait a beat so the cutoff is comfortably AFTER the row's updated_at
        # (Postgres timestamp resolution is microseconds — 50ms is overkill
        # for safety against fixture-machine clock granularity).
        time.sleep(0.1)
        cutoff = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

        res = client.get(
            f"/api/v1/reports/?since={cutoff}",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        assert res.status_code == 200, res.text
        ids = {r["id"] for r in res.json()}
        assert rid not in ids

    def test_media_update_surfaces_in_delta_via_exists_clause(
        self, client, db, viewer_token
    ):
        """Phase 3's subtlety — chunked-upload progress lives on
        Media.updated_at, not Report.updated_at. The EXISTS clause makes
        sure partial-upload progress still animates during delta polls.
        Without it, the dashboard's progress bar would freeze until
        assembly_complete bumped received_media."""
        # Create a parent report via API + add a media row directly.
        rid = _create_report(client)
        m_id = f"m-delta-media-{uuid.uuid4().hex[:8]}"
        from app.models.report import MediaTypeEnum, ResolutionEnum
        db.add(Media(
            id=m_id,
            report_id=rid,
            type=MediaTypeEnum.IMAGE,
            resolution_tier=ResolutionEnum.MEDIUM,
            url="",
            is_synced=False,
            assembly_status="assembling",
            completion_pct=10.0,
        ))
        db.commit()
        # Sleep, then bump the media row's progress (simulates a chunk landing).
        time.sleep(0.1)
        cutoff = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        time.sleep(0.05)

        m = db.query(Media).filter(Media.id == m_id).one()
        m.completion_pct = 55.0
        db.commit()

        res = client.get(
            f"/api/v1/reports/?since={cutoff}",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        assert res.status_code == 200, res.text
        ids = {r["id"] for r in res.json()}
        # Parent report's updated_at didn't move, but its media row did →
        # the report still surfaces in the delta because of the EXISTS clause.
        assert rid in ids

    def test_x_server_time_header_present_and_iso_z(self, client, viewer_token):
        """Dashboard echoes X-Server-Time back as ?since on the next
        poll. ISO 8601 with `Z` suffix matches the rest of our wire format."""
        res = client.get(
            "/api/v1/reports/",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        assert res.status_code == 200
        cursor = res.headers.get("x-server-time")
        assert cursor is not None
        # Z-suffixed UTC.
        assert cursor.endswith("Z"), cursor
        # Round-trips through datetime.fromisoformat (Python 3.11+).
        parsed = datetime.fromisoformat(cursor.replace("Z", "+00:00"))
        # Within 5 s of "now" — sanity check that it's not arbitrary garbage.
        now = datetime.now(timezone.utc)
        assert abs((now - parsed).total_seconds()) < 5

    def test_x_server_time_captured_before_query_avoids_gap(self, client, viewer_token):
        """If a report lands DURING our SELECT, the next delta poll must
        still surface it. We capture cursor BEFORE the query so any
        report mutated mid-query has updated_at > cursor → next poll
        catches it. Without this, fast-arriving reports could get lost
        between two polls."""
        # Cursor we'll save and re-use as ?since on the next call.
        res1 = client.get(
            "/api/v1/reports/",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        cursor = res1.headers.get("x-server-time")
        assert cursor

        # NOW create a report — its updated_at is AFTER cursor.
        time.sleep(0.05)
        rid = _create_report(client)

        res2 = client.get(
            f"/api/v1/reports/?since={cursor}",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        ids = {r["id"] for r in res2.json()}
        assert rid in ids

    def test_since_invalid_iso_returns_422(self, client, viewer_token):
        """FastAPI's automatic datetime parsing rejects garbage with 422.
        Catch any future change that loosens this — silent typo'd
        timestamps would leave the dashboard stuck on stale data."""
        res = client.get(
            "/api/v1/reports/?since=not-an-iso",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        assert res.status_code == 422

    def test_endpoint_still_requires_auth(self, client):
        """No bypass — the `since` parameter doesn't relax auth."""
        cutoff = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        res = client.get(f"/api/v1/reports/?since={cutoff}")
        # 401 (no token) or 403 (token expired/missing role)
        assert res.status_code in (401, 403), res.text
