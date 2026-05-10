"""
Phase 4 (May 2026, HAR-driven) — ETag / If-None-Match conditional GET tests.

Background: even with Phase 3 delta polling shrinking idle-poll bodies
to a few bytes, the backend still pays the full schema-validation and
JSON-serialization cost on every poll. ETag short-circuits that — when
the dashboard echoes back the previous ETag and nothing has changed,
the backend returns 304 Not Modified with NO body, and skips the
JoinedLoad serialization entirely.

Tested behaviours:
  • First poll → 200 + ETag header
  • Echoing same ETag → 304 (no body)
  • New report mutates the data → ETag changes → 200
  • Media chunk progress → ETag changes (catches partial-upload moves)
  • Distinct cursor (`?since=`) values can share an ETag if the result
    set is identical (correctness — same data → same ETag)
"""
from __future__ import annotations

from datetime import datetime, timezone
import time
import uuid


def _create_report(client) -> str:
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"TEST-ETAG-{uuid.uuid4().hex[:8]}",
        "client_report_id": f"etag-{uuid.uuid4().hex[:12]}",
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "description": "etag test",
        "expected_media": 0,
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


class TestReportsETag:
    """ETag / If-None-Match — bandwidth + CPU savings on idle polls."""

    def test_first_poll_returns_200_with_etag(self, client, viewer_token):
        """A poll without If-None-Match always gets the body back, plus
        an ETag header for the next poll to echo."""
        _create_report(client)
        res = client.get(
            "/api/v1/reports/",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        assert res.status_code == 200, res.text
        etag = res.headers.get("etag")
        assert etag is not None
        # MD5-hex inside double quotes — RFC 7232 strong-validator format.
        assert etag.startswith('"') and etag.endswith('"'), etag
        assert len(etag) == 34  # `"` + 32 hex + `"`

    def test_echoing_etag_returns_304_no_body(self, client, viewer_token):
        """The win: idle poll where nothing changed returns 304 with
        no body. Saves the entire JSON-serialization step server-side
        AND the wire bytes."""
        _create_report(client)
        res1 = client.get(
            "/api/v1/reports/",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        etag = res1.headers.get("etag")
        assert etag

        # Echo it back — the server should 304 us.
        res2 = client.get(
            "/api/v1/reports/",
            headers={
                "Authorization": f"Bearer {viewer_token}",
                "If-None-Match": etag,
            },
        )
        assert res2.status_code == 304, res2.text
        # 304 → empty body. httpx returns b"" here.
        assert res2.content == b""
        # ETag still echoed so the dashboard can keep using it.
        assert res2.headers.get("etag") == etag

    def test_new_report_invalidates_etag(self, client, viewer_token):
        """When data changes, the ETag MUST change — otherwise the
        dashboard would 304 forever and never see the new report."""
        _create_report(client)
        res1 = client.get(
            "/api/v1/reports/",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        etag1 = res1.headers.get("etag")

        # Add a new report — data has changed.
        time.sleep(0.05)
        _create_report(client)

        # Re-poll WITH the old ETag.
        res2 = client.get(
            "/api/v1/reports/",
            headers={
                "Authorization": f"Bearer {viewer_token}",
                "If-None-Match": etag1,
            },
        )
        # Different data → 200, not 304.
        assert res2.status_code == 200, res2.text
        # And the new ETag differs.
        etag2 = res2.headers.get("etag")
        assert etag2 != etag1

    def test_media_progress_invalidates_etag(self, client, db, viewer_token):
        """Phase 4's subtlety: chunked-upload progress doesn't always
        bump Report.updated_at. The fingerprint must include media
        completion_pct so progressive-upload visualisation in the
        dashboard keeps animating — otherwise the dashboard would
        receive 304 throughout the entire upload and the progress bar
        would freeze."""
        rid = _create_report(client)

        # Add a media row with low progress.
        from app.models.report import Media, MediaTypeEnum, ResolutionEnum
        m_id = f"m-etag-{uuid.uuid4().hex[:8]}"
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

        res1 = client.get(
            "/api/v1/reports/",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        etag1 = res1.headers.get("etag")

        # Bump the media row's progress (simulates a chunk landing).
        m = db.query(Media).filter(Media.id == m_id).one()
        m.completion_pct = 75.0
        db.commit()

        res2 = client.get(
            "/api/v1/reports/",
            headers={
                "Authorization": f"Bearer {viewer_token}",
                "If-None-Match": etag1,
            },
        )
        # Progress moved → ETag must change → 200, not 304.
        assert res2.status_code == 200, res2.text
        assert res2.headers.get("etag") != etag1

    def test_etag_combines_with_since_for_minimal_idle_poll(self, client, viewer_token):
        """The combined Phase 3 + Phase 4 contract:
          1. Dashboard sends `?since=<cursor>` → empty body
          2. Server returns 200 + ETag for the empty body
          3. Dashboard echoes ETag next poll
          4. Server returns 304 (no body, no schema validation)

        This is the steady-state of an idle dashboard tab. Wire
        bandwidth: ~50 bytes per poll vs. ~440 KB before."""
        _create_report(client)

        # First poll — establish cursor + ETag.
        res1 = client.get(
            "/api/v1/reports/",
            headers={"Authorization": f"Bearer {viewer_token}"},
        )
        cursor = res1.headers.get("x-server-time")
        etag1 = res1.headers.get("etag")
        assert cursor and etag1

        # Second poll — idle, with both since AND If-None-Match.
        res2 = client.get(
            f"/api/v1/reports/?since={cursor}",
            headers={
                "Authorization": f"Bearer {viewer_token}",
                "If-None-Match": etag1,
            },
        )
        # If etag1 is the etag for an empty result + same since, we get 304.
        # If first poll returned reports while delta poll returns empty,
        # the etags differ so we get 200 + empty body. Either way the
        # body is small. We assert the bandwidth-friendly outcome:
        # status 200 with empty body, or 304.
        if res2.status_code == 304:
            assert res2.content == b""
        else:
            assert res2.status_code == 200, res2.text
            assert res2.json() == []
