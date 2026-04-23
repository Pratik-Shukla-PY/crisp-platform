"""W7 — RAPIDA integration ingestion + schema contract.

UNDP's brief names RAPIDA (Rapid Post-Crisis Integrated Digital
Assessment) as the canonical downstream consumer of crowdsourced damage
data. CRISP ships two integration endpoints:

    POST /api/v1/integrations/rapida/events   (ingest; ADMIN only)
    GET  /api/v1/integrations/rapida/schema    (JSON-Schema + mapping;
                                                 ADMIN read-only, public-
                                                 readable at the schema
                                                 level since it's a
                                                 contract not a secret)

Tests pin:
  - Happy-path ingestion → 202 + report id returned
  - Location row created when lat/lng provided
  - Idempotency on event_id (second POST returns was_duplicate=true)
  - Validation rejects out-of-range lat/lng
  - Schema endpoint returns event_schema + mapping table
  - Auth gate: POST without ADMIN token → 401/403
"""
import uuid


class TestRAPIDAIngestion:
    def _event(self, **over):
        payload = {
            "event_id": str(uuid.uuid4()),
            "crisis_type": "FLOOD",
            "infrastructure_type": "ROAD",
            "damage_classification": "PARTIAL",
            "severity": "MODERATE",
            "description": "Road bridge cracked after flash flood",
            "latitude": 12.9716,
            "longitude": 77.5946,
            "location_name": "Bengaluru, India",
            "reporter": "RAPIDA-Bot",
        }
        payload.update(over)
        return payload

    def test_happy_path_creates_report(self, client, admin_token):
        payload = self._event()
        res = client.post(
            "/api/v1/integrations/rapida/events",
            json=payload,
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert res.status_code == 202, f"{res.status_code}: {res.text}"
        body = res.json()
        assert body["event_id"] == payload["event_id"]
        assert body["was_duplicate"] is False
        assert body["report_id"]

        # Report should be findable via the standard list endpoint.
        reports_res = client.get(
            "/api/v1/reports/",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        ids = {r["id"] for r in reports_res.json()}
        assert body["report_id"] in ids

    def test_ingestion_attaches_location(self, client, admin_token):
        payload = self._event(latitude=48.8566, longitude=2.3522,
                              location_name="Paris, FR")
        res = client.post(
            "/api/v1/integrations/rapida/events",
            json=payload,
            headers={"Authorization": f"Bearer {admin_token}"},
        ).json()
        reports = client.get(
            "/api/v1/reports/",
            headers={"Authorization": f"Bearer {admin_token}"},
        ).json()
        report = [r for r in reports if r["id"] == res["report_id"]][0]
        assert report["location"] is not None
        assert abs(report["location"]["latitude"] - 48.8566) < 0.001
        assert abs(report["location"]["longitude"] - 2.3522) < 0.001
        assert report["location"]["user_location_name"] == "Paris, FR"

    def test_idempotent_on_event_id(self, client, admin_token):
        """Second POST with the same event_id returns was_duplicate=true
        and the same report_id — no second row created."""
        payload = self._event()
        r1 = client.post(
            "/api/v1/integrations/rapida/events",
            json=payload,
            headers={"Authorization": f"Bearer {admin_token}"},
        ).json()
        r2 = client.post(
            "/api/v1/integrations/rapida/events",
            json=payload,
            headers={"Authorization": f"Bearer {admin_token}"},
        ).json()
        assert r1["report_id"] == r2["report_id"]
        assert r1["was_duplicate"] is False
        assert r2["was_duplicate"] is True

    def test_invalid_latitude_rejected(self, client, admin_token):
        payload = self._event(latitude=91.0)   # > 90
        res = client.post(
            "/api/v1/integrations/rapida/events",
            json=payload,
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert res.status_code == 422

    def test_extra_keys_rejected_strict(self, client, admin_token):
        """`extra='forbid'` — unknown keys mean the partner misread the
        contract. Better a 422 at the edge than silently-dropped data."""
        payload = self._event()
        payload["mystery_field"] = "hidden"
        res = client.post(
            "/api/v1/integrations/rapida/events",
            json=payload,
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert res.status_code == 422

    def test_anonymous_post_rejected(self, client):
        payload = self._event()
        res = client.post("/api/v1/integrations/rapida/events", json=payload)
        assert res.status_code in (401, 403)


class TestRAPIDASchema:
    def test_schema_endpoint_returns_event_schema_and_mapping(self, client, admin_token):
        res = client.get(
            "/api/v1/integrations/rapida/schema",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert res.status_code == 200
        body = res.json()
        assert "event_schema" in body
        assert "mapping" in body
        # Documented keys must each appear in the mapping block.
        for key in ("event_id", "crisis_type", "latitude", "longitude", "building_id"):
            assert key in body["mapping"], f"missing mapping key: {key}"
        assert body["auth"].startswith("Bearer")
        assert body["rate_limit"]["per_token_per_minute"] == 300
        assert body["endpoint_url"].endswith("/integrations/rapida/events")

    def test_event_schema_exposes_required_id(self, client, admin_token):
        """JSON-Schema must flag `event_id` as required so adapter
        generators produce the right typed model."""
        body = client.get(
            "/api/v1/integrations/rapida/schema",
            headers={"Authorization": f"Bearer {admin_token}"},
        ).json()
        js = body["event_schema"]
        assert "event_id" in js.get("required", [])
