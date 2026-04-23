"""Per-device status-polling contract tests.

The PWA + RN apps poll three endpoints to render the "My Reports"
screen without signing in:

  GET /api/v1/reports/device/{device_hash}
      Full ReportResponse for every report the caller ever submitted.
      Used once on first-paint of the My Reports drawer.

  GET /api/v1/reports/device/{device_hash}/status-since?since=<iso>
      Flat compact dict (id, status, severity, infra, location,
      thumbnail, response_time_seconds, …) for polling after the
      first paint — cheap enough to hit every 15 s while the drawer
      is open.

  DELETE /api/v1/reports/device/{device_hash}
      "Delete my data" privacy action. Wipes reports + media files
      for this device and ONLY this device.

These tests pin the contract — not the business logic — so if the
endpoint ever starts returning 404 for an unknown device, or leaking
another device's rows, the test goes red before an app-store release
ships with the regression.

Apr 2026 additions (see reports.py:952 docstring): the status-since
response is now expected to carry `location`, `thumbnail_url`, and
`description` so the list card can render without a per-row detail
fetch. Those keys are asserted explicitly below.
"""
import uuid
from datetime import datetime, timedelta, timezone


def _create_report(client, device_hash: str, description: str = "polling test"):
    """Post a minimal meta-only report and return the parsed JSON.

    Kept local so tests don't depend on the session-wide `sample_report`
    fixture — every test here needs fine control over which device_hash
    owns which rows.

    Implementation note: `reports.client_report_id` is a character
    varying(36) column (UUID-sized); tests previously synthesised
    `poll-{device_hash}-{timestamp}` which exceeds 36 chars for
    device_hashes of length ≥ 15. Using a raw UUID is both
    boundary-safe and realistic — the mobile app posts UUIDs too.
    """
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": device_hash,
        "client_report_id": str(uuid.uuid4()),
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "description": description,
        "expected_media": 0,
        "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201, f"meta create failed: {res.status_code} {res.text}"
    return res.json()


class TestDeviceReportsListing:
    """GET /reports/device/{device_hash} — full list contract."""

    def test_returns_empty_list_for_unknown_device_not_404(self, client):
        """Unknown device_hash → 200 + `[]`, NOT a 404.

        The mobile app treats this as "you haven't submitted anything
        yet"; a 404 would confuse the UI into an error banner. Guard
        against future code that routes through FastAPI's default
        "not found" handling.
        """
        res = client.get("/api/v1/reports/device/DEV-DOES-NOT-EXIST")
        assert res.status_code == 200
        assert res.json() == []

    def test_returns_only_this_devices_reports_descending(self, client):
        """Device A's listing never leaks device B's rows, and rows
        come back newest-first so the My Reports drawer shows the
        most recent capture at the top without client-side sort."""
        # Device A submits two, device B submits one interleaved.
        a1 = _create_report(client, "DEV-AAA-1111", "A first report")
        _create_report(client, "DEV-BBB-2222", "B report")
        a2 = _create_report(client, "DEV-AAA-1111", "A second report")

        res = client.get("/api/v1/reports/device/DEV-AAA-1111")
        assert res.status_code == 200
        rows = res.json()
        assert len(rows) == 2, f"expected 2 A-rows, got {len(rows)}: {rows}"
        ids = {r["id"] for r in rows}
        assert ids == {a1["id"], a2["id"]}

        # DESC by server_created_at — a2 was inserted after a1.
        assert rows[0]["id"] == a2["id"], \
            f"expected newest ({a2['id']}) first, got {rows[0]['id']}"


class TestStatusSincePolling:
    """GET /reports/device/{device_hash}/status-since — compact polling."""

    REQUIRED_KEYS = {
        # My Reports card essentials (Apr 2026 expansion).
        "id", "client_report_id", "status", "severity",
        "infrastructure_type", "crisis_type", "damage_classification",
        "description", "lives_impacted",
        "server_created_at", "updated_at",
        # Reviewer-workflow surfaces for detail view.
        "reviewer_verdict", "action_taken", "help_dispatched_at",
        "help_arrived_at", "reviewed_at", "response_time_seconds",
        # Newer Apr-2026 additions.
        "location", "thumbnail_url", "deletion_requested_at",
    }

    def test_returns_flat_dict_with_all_required_keys(self, client):
        """Every row must carry the full key set the mobile cards
        and detail view read. Adding a key is fine (clients ignore
        unknowns); removing one breaks production apps already in
        the wild, so we pin the contract exactly."""
        r = _create_report(client, "DEV-SHAPE-CHECK", "shape test")
        res = client.get("/api/v1/reports/device/DEV-SHAPE-CHECK/status-since")
        assert res.status_code == 200
        rows = res.json()
        assert len(rows) == 1
        row = rows[0]
        missing = self.REQUIRED_KEYS - set(row.keys())
        assert not missing, f"status-since row missing keys: {missing!r}"

        # Spot-check the ones most likely to regress — reviewer_verdict
        # must fall back to "NOT_REVIEWED" even when no reviewer has
        # touched the row yet (that default is set inline in the
        # endpoint, not in the model default).
        assert row["id"] == r["id"]
        assert row["reviewer_verdict"] == "NOT_REVIEWED"
        assert row["response_time_seconds"] is None  # no dispatch yet
        assert row["location"] is not None
        assert row["location"]["latitude"] == 12.97

    def test_since_parameter_filters_by_updated_at(self, client):
        """`since=<iso>` must only return rows with `updated_at > since`.

        Polling is expensive; the whole point of the `since` param is
        to trim the wire payload on every 15-second tick. If the
        filter silently no-ops the client pays the full-list cost on
        every poll — which is a silent perf regression that only
        surfaces as a battery complaint in the wild.
        """
        r1 = _create_report(client, "DEV-SINCE-FILTER", "first")

        # Take a cutoff timestamp AFTER r1 was created. Anything with
        # updated_at <= cutoff must be filtered out.
        cutoff = datetime.now(timezone.utc) + timedelta(seconds=1)
        cutoff_iso = cutoff.isoformat()

        # Full list (no since) must include r1.
        all_rows = client.get(
            "/api/v1/reports/device/DEV-SINCE-FILTER/status-since"
        ).json()
        assert any(x["id"] == r1["id"] for x in all_rows)

        # With cutoff, r1 must be absent (it was created before cutoff).
        filtered = client.get(
            "/api/v1/reports/device/DEV-SINCE-FILTER/status-since",
            params={"since": cutoff_iso},
        ).json()
        assert all(x["id"] != r1["id"] for x in filtered), \
            f"since filter leaked pre-cutoff row: {filtered}"

    def test_since_parameter_malformed_falls_back_to_full_list(self, client):
        """Per the endpoint's `except Exception: pass`, a malformed
        `since=` value MUST NOT 500 — the mobile apps ship with clock
        skew and the occasional bad cached timestamp; graceful
        fallback is the contract."""
        _create_report(client, "DEV-BAD-SINCE", "malformed test")

        res = client.get(
            "/api/v1/reports/device/DEV-BAD-SINCE/status-since",
            params={"since": "not-a-real-iso-string"},
        )
        assert res.status_code == 200
        rows = res.json()
        # Full list is returned — malformed filter ignored.
        assert any(r["description"] == "malformed test" for r in rows)


class TestDeviceDeletion:
    """DELETE /reports/device/{device_hash} — privacy deletion."""

    def test_delete_removes_only_this_devices_reports_and_returns_count(self, client):
        """Delete-my-data for device A must wipe A's rows, leave
        device B's rows untouched, and return {"deleted": N}. This
        is the one endpoint where a leak is a GDPR incident, so we
        pin isolation explicitly."""
        # Seed two devices with reports.
        a1 = _create_report(client, "DEV-DEL-AAA", "A-1")
        a2 = _create_report(client, "DEV-DEL-AAA", "A-2")
        b1 = _create_report(client, "DEV-DEL-BBB", "B-1")

        # Sanity: both devices visible before delete.
        assert len(client.get("/api/v1/reports/device/DEV-DEL-AAA").json()) == 2
        assert len(client.get("/api/v1/reports/device/DEV-DEL-BBB").json()) == 1

        res = client.delete("/api/v1/reports/device/DEV-DEL-AAA")
        assert res.status_code == 200
        body = res.json()
        assert body == {"deleted": 2}, \
            f"expected {{'deleted': 2}}, got {body!r}"

        # Post-delete: A gone, B still there.
        a_after = client.get("/api/v1/reports/device/DEV-DEL-AAA").json()
        b_after = client.get("/api/v1/reports/device/DEV-DEL-BBB").json()
        assert a_after == []
        assert len(b_after) == 1
        assert b_after[0]["id"] == b1["id"]

        # Unknown-device delete is a no-op with deleted=0, not a 404.
        res_noop = client.delete("/api/v1/reports/device/DEV-DEL-NEVER-EXISTED")
        assert res_noop.status_code == 200
        assert res_noop.json() == {"deleted": 0}

        # Silence unused-variable warnings; a1/a2 only seed the DB.
        del a1, a2
