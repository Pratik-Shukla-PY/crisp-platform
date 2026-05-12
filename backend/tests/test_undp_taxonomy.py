"""UNDP taxonomy compliance — write-time normalisation + rejection rules.

Covers the three guards introduced together:

  1. HURRICANE -> CYCLONE normalisation at every write site
     (application-layer helper + Pydantic validator)
  2. LANDSLIDE / PANDEMIC rejected for new submissions (not on UNDP spec)
  3. infrastructure_type=OTHER requires non-empty infrastructure_name
     (UNDP 'Other, please specify')

Companion to alembic migration 0016 which backfills existing HURRICANE
rows to CYCLONE.
"""
from app.api.endpoints.reports import _normalize_crisis_type


# ── Application-layer helper ────────────────────────────────────────

class TestNormaliseHelper:
    def test_hurricane_becomes_cyclone(self):
        assert _normalize_crisis_type("HURRICANE") == "CYCLONE"

    def test_cyclone_passes_through(self):
        assert _normalize_crisis_type("CYCLONE") == "CYCLONE"

    def test_other_values_pass_through(self):
        for value in ("EARTHQUAKE", "FLOOD", "WILDFIRE", "OTHER"):
            assert _normalize_crisis_type(value) == value

    def test_none_passes_through(self):
        assert _normalize_crisis_type(None) is None

    def test_enum_member_input_works(self):
        # Enum members carry .value; the helper should handle both.
        from app.models.report import CrisisTypeEnum
        assert _normalize_crisis_type(CrisisTypeEnum.HURRICANE) == "CYCLONE"
        assert _normalize_crisis_type(CrisisTypeEnum.EARTHQUAKE) == CrisisTypeEnum.EARTHQUAKE


# ── End-to-end via the meta POST endpoint ────────────────────────────

class TestMetaPostNormalisation:
    """POST /reports/meta exercises the Pydantic validator path."""

    def _base_payload(self, **overrides):
        payload = {
            "device_hash": "TAXONOMY-TEST",
            "client_report_id": "test-tax-001",
            "source": "APP",
            "severity": "MODERATE",
            "infrastructure_type": "RESIDENTIAL",
            "expected_media": 0,
            "location": {"latitude": 12.97, "longitude": 77.59},
        }
        payload.update(overrides)
        return payload

    def test_hurricane_normalised_to_cyclone_in_db(self, client):
        res = client.post("/api/v1/reports/meta", json=self._base_payload(
            client_report_id="hur-norm-001",
            crisis_type="HURRICANE",
        ))
        assert res.status_code == 201, res.text
        assert res.json()["crisis_type"] == "CYCLONE", (
            f"server should normalise HURRICANE -> CYCLONE, got {res.json()['crisis_type']!r}"
        )

    def test_cyclone_accepted_unchanged(self, client):
        res = client.post("/api/v1/reports/meta", json=self._base_payload(
            client_report_id="cyc-norm-001",
            crisis_type="CYCLONE",
        ))
        assert res.status_code == 201
        assert res.json()["crisis_type"] == "CYCLONE"

    def test_wildfire_accepted_as_first_class(self, client):
        # UNDP lists Wildfire as a natural-hazard category. The earlier
        # backend comment incorrectly claimed it was 'legacy'; this test
        # documents that new submissions are accepted unchanged.
        res = client.post("/api/v1/reports/meta", json=self._base_payload(
            client_report_id="wf-001",
            crisis_type="WILDFIRE",
        ))
        assert res.status_code == 201
        assert res.json()["crisis_type"] == "WILDFIRE"


class TestSpecExtrasRejected:
    """LANDSLIDE / PANDEMIC are not on the UNDP Problem Statement crisis
    list. Pydantic returns 422 with a clear error."""

    def _base_payload(self, **overrides):
        payload = {
            "device_hash": "EXTRAS-TEST",
            "client_report_id": "ext-001",
            "source": "APP",
            "severity": "MODERATE",
            "infrastructure_type": "RESIDENTIAL",
            "expected_media": 0,
            "location": {"latitude": 12.97, "longitude": 77.59},
        }
        payload.update(overrides)
        return payload

    def test_landslide_rejected(self, client):
        res = client.post("/api/v1/reports/meta", json=self._base_payload(
            client_report_id="ls-block-001",
            crisis_type="LANDSLIDE",
        ))
        assert res.status_code == 422
        body = res.json()
        # error message should mention LANDSLIDE so operators can debug
        assert "LANDSLIDE" in str(body) or "landslide" in str(body).lower()

    def test_pandemic_rejected(self, client):
        res = client.post("/api/v1/reports/meta", json=self._base_payload(
            client_report_id="pan-block-001",
            crisis_type="PANDEMIC",
        ))
        assert res.status_code == 422


class TestOtherRequiresName:
    """UNDP 'Other, please specify' — infrastructure_name must be
    non-empty when infrastructure_type=OTHER."""

    def _base_payload(self, **overrides):
        payload = {
            "device_hash": "OTHER-NAME-TEST",
            "client_report_id": "oth-001",
            "source": "APP",
            "severity": "MODERATE",
            "infrastructure_type": "OTHER",
            "expected_media": 0,
            "location": {"latitude": 12.97, "longitude": 77.59},
        }
        payload.update(overrides)
        return payload

    def test_other_without_name_rejected(self, client):
        res = client.post("/api/v1/reports/meta", json=self._base_payload(
            client_report_id="oth-noname-001",
        ))
        assert res.status_code == 422
        body = res.json()
        assert "infrastructure_name" in str(body)

    def test_other_with_whitespace_only_name_rejected(self, client):
        res = client.post("/api/v1/reports/meta", json=self._base_payload(
            client_report_id="oth-ws-001",
            infrastructure_name="   ",
        ))
        assert res.status_code == 422

    def test_other_with_name_accepted(self, client):
        res = client.post("/api/v1/reports/meta", json=self._base_payload(
            client_report_id="oth-named-001",
            infrastructure_name="cell tower at km 5",
        ))
        assert res.status_code == 201
        assert res.json()["infrastructure_type"] == "OTHER"
        assert res.json()["infrastructure_name"] == "cell tower at km 5"

    def test_non_other_without_name_accepted(self, client):
        # The 'must have name' rule applies ONLY when type=OTHER. Other
        # tiles can submit without a name (it's optional in UNDP spec
        # for everything except OTHER).
        res = client.post("/api/v1/reports/meta", json=self._base_payload(
            client_report_id="res-noname-001",
            infrastructure_type="RESIDENTIAL",
        ))
        assert res.status_code == 201
