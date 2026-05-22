"""Regression for the client_report_id schema-vs-DB length mismatch.

Operator-reported May 2026: posting a `client_report_id` longer than
36 characters returned an opaque HTTP 500 with body
`{"detail":"Internal server error"}`. Root cause: Pydantic
`max_length=64` allowed the value through, then the Postgres
VARCHAR(36) column rejected the INSERT, and the FastAPI handler
surfaced the IntegrityError as a generic 500.

The fix tightens Pydantic to `max_length=36` so over-length values
land in the 422 bucket BEFORE any DB I/O — preserving the API
contract (operator sees a clean validation error, not a server
fault), and matching what every shipping client actually emits
(PWA + RN use bare UUID-4 = 36 chars; bots use uuid.uuid4()).
"""
from __future__ import annotations

import time
import uuid


def _meta_payload(**overrides) -> dict:
    base = {
        "device_hash": f"LEN-TEST-{uuid.uuid4()}",
        "client_report_id": str(uuid.uuid4()),    # 36 chars, valid
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "location": {"latitude": 12.97, "longitude": 77.59},
        "expected_media": 0,
    }
    base.update(overrides)
    return base


class TestClientReportIdLengthValidation:
    def test_36_char_uuid_accepted(self, client):
        """A bare UUID-4 is exactly 36 chars — the shape every shipping
        client emits — and must continue to be accepted."""
        res = client.post("/api/v1/reports/meta", json=_meta_payload())
        assert res.status_code == 201, res.text

    def test_50_char_value_rejected_as_422_not_500(self, client):
        """Over-length values land in the validation bucket, not the
        opaque-500 bucket. This is the regression guard for the
        operator-reported bug.
        """
        overlong = "stress-" + str(uuid.uuid4())   # 43 chars
        assert len(overlong) > 36
        res = client.post(
            "/api/v1/reports/meta",
            json=_meta_payload(client_report_id=overlong),
        )
        assert res.status_code == 422, (
            f"Expected 422 for over-length client_report_id, got "
            f"{res.status_code}. Body: {res.text}. The schema-vs-DB "
            f"length mismatch is back."
        )
        body = res.json()
        # Pydantic's validation envelope mentions the offending field.
        assert "client_report_id" in res.text or "string_too_long" in res.text, (
            f"422 body should name the field that failed: {body}"
        )

    def test_64_char_value_rejected_as_422(self, client):
        """Exactly at the previous (incorrect) Pydantic ceiling — must
        still 422 under the new schema."""
        sixty_four = "x" * 64
        res = client.post(
            "/api/v1/reports/meta",
            json=_meta_payload(client_report_id=sixty_four),
        )
        assert res.status_code == 422, res.text

    def test_37_char_value_rejected_just_over_boundary(self, client):
        """One character over the boundary is still a 422 (no silent
        truncation, no opaque 500)."""
        thirty_seven = "x" * 37
        res = client.post(
            "/api/v1/reports/meta",
            json=_meta_payload(client_report_id=thirty_seven),
        )
        assert res.status_code == 422, res.text

    def test_short_alphanumeric_id_still_accepted(self, client):
        """Some non-UUID clients send shorter ids (e.g. legacy bots).
        These must remain accepted — the cap is an upper bound, not a
        minimum.
        """
        short = f"short-{int(time.time_ns())}"[:36]
        res = client.post(
            "/api/v1/reports/meta",
            json=_meta_payload(client_report_id=short),
        )
        assert res.status_code == 201, res.text
