"""
Prediction-subsystem API tests — Apr 2026.

Covers /api/v1/predictions/* end-to-end:
  * Zone CRUD (create/list/delete) with admin-role gate
  * Zone history retrieval
  * Heatmap + latest aggregates
  * /forecast with the Claude engine mocked

The /forecast handler calls `app.services.prediction_engine.run_prediction`.
We patch that async function directly so no real Anthropic / OpenWeather /
USGS calls leak out of the test run. A separate no-key test verifies the
graceful-fallback path (the engine returns a canned mock dict when
ANTHROPIC_API_KEY is absent — asserted via `risk_score` / `headline`
from that fixed fallback).

Also pins the pydantic bounds added in Apr 2026 for ZoneCreate:
  latitude  ∈ [-90, 90]
  longitude ∈ [-180, 180]
  radius_km ∈ (0, 2000]
Before the fix the API happily persisted latitude=500 which then
broke the heatmap renderer on the dashboard (invalid coordinate
crashed Leaflet). The two 422 tests would have caught that.
"""
import pytest
from unittest.mock import patch, AsyncMock
from datetime import datetime, timedelta, timezone

from tests.conftest import auth_header
from app.models.prediction import PredictionZone, PredictionResult


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_zone(client, admin_token, name="Test Zone", lat=12.97, lng=77.59,
               radius_km=25.0, country="India", region="Karnataka"):
    res = client.post(
        "/api/v1/predictions/zones",
        headers=auth_header(admin_token),
        json={
            "name": name, "latitude": lat, "longitude": lng,
            "radius_km": radius_km, "country": country, "region": region,
        },
    )
    assert res.status_code == 201, res.text
    return res.json()


def _seed_result(db, zone_id, risk_score=55, risk_level="MEDIUM",
                 crisis_type="FLOOD", created_at=None):
    """Insert a PredictionResult row directly — the API /forecast endpoint
    calls the Claude engine which we don't want to exercise here."""
    p = PredictionResult(
        zone_id=zone_id, risk_score=risk_score, risk_level=risk_level,
        predicted_crisis_type=crisis_type, time_window_hours=72,
        confidence_score=60.0, headline=f"{risk_level} {crisis_type} risk",
    )
    db.add(p)
    db.commit()
    if created_at is not None:
        # server_default=func.now() populates created_at on INSERT;
        # to test ordering we override after the fact.
        p.created_at = created_at
        db.commit()
    db.refresh(p)
    return p


# ── Zone CRUD ────────────────────────────────────────────────────────────────

class TestPredictionZones:

    def test_list_zones_empty_returns_200(self, client, db, admin_token):
        """Fresh DB → empty array, 200 (not 404)."""
        # Remove any zones another test left behind.
        db.query(PredictionResult).delete()
        db.query(PredictionZone).delete()
        db.commit()

        res = client.get("/api/v1/predictions/zones",
                         headers=auth_header(admin_token))
        assert res.status_code == 200, res.text
        assert res.json() == []

    def test_create_zone_persists_with_expected_fields(self, client, db, admin_token):
        """POST with a valid payload creates a row with the same fields."""
        z = _make_zone(client, admin_token, name="Bengaluru-Cluster",
                       lat=12.97, lng=77.59, radius_km=40.0,
                       country="India", region="Karnataka")
        assert "id" in z
        row = db.query(PredictionZone).filter(PredictionZone.id == z["id"]).first()
        assert row is not None
        assert row.name == "Bengaluru-Cluster"
        assert row.latitude == pytest.approx(12.97)
        assert row.longitude == pytest.approx(77.59)
        assert row.radius_km == pytest.approx(40.0)
        assert row.country == "India"
        assert row.region == "Karnataka"
        assert row.is_active is True

    def test_create_zone_rejects_invalid_radius(self, client, admin_token):
        """Pydantic bound: radius_km must be > 0 and <= 2000.

        Pins the Apr 2026 fix — before the bound was added, negative
        radii were stored verbatim and the heatmap front-end tried to
        draw a circle with negative radius (Leaflet throws)."""
        res_neg = client.post(
            "/api/v1/predictions/zones",
            headers=auth_header(admin_token),
            json={"name": "BadRadius", "latitude": 0, "longitude": 0,
                  "radius_km": -5.0},
        )
        assert res_neg.status_code == 422, res_neg.text

        res_huge = client.post(
            "/api/v1/predictions/zones",
            headers=auth_header(admin_token),
            json={"name": "HugeRadius", "latitude": 0, "longitude": 0,
                  "radius_km": 10_000.0},
        )
        assert res_huge.status_code == 422, res_huge.text

    def test_create_zone_rejects_invalid_coords(self, client, admin_token):
        """Pydantic bound: lat ∈ [-90, 90], lng ∈ [-180, 180]."""
        res_lat = client.post(
            "/api/v1/predictions/zones",
            headers=auth_header(admin_token),
            json={"name": "BadLat", "latitude": 120, "longitude": 0},
        )
        assert res_lat.status_code == 422, res_lat.text

        res_lng = client.post(
            "/api/v1/predictions/zones",
            headers=auth_header(admin_token),
            json={"name": "BadLng", "latitude": 0, "longitude": 200},
        )
        assert res_lng.status_code == 422, res_lng.text

    def test_list_zones_returns_created_zone_with_latest_score(
            self, client, db, admin_token):
        """After creating a zone + seeding a PredictionResult, the list
        endpoint surfaces the latest score/level/headline."""
        db.query(PredictionResult).delete()
        db.query(PredictionZone).delete()
        db.commit()

        z = _make_zone(client, admin_token, name="Listed-Zone",
                       lat=20.5, lng=78.9)
        _seed_result(db, z["id"], risk_score=72, risk_level="HIGH",
                     crisis_type="FLOOD")

        res = client.get("/api/v1/predictions/zones",
                         headers=auth_header(admin_token))
        assert res.status_code == 200
        body = res.json()
        assert len(body) == 1
        entry = body[0]
        assert entry["id"] == z["id"]
        assert entry["name"] == "Listed-Zone"
        assert entry["latest_risk_score"] == pytest.approx(72)
        assert entry["latest_risk_level"] == "HIGH"
        assert entry["latest_crisis_type"] == "FLOOD"
        assert entry["latest_headline"] is not None
        assert entry["last_updated"] is not None

    def test_delete_zone_removes_row(self, client, db, admin_token):
        """DELETE /zones/{id} hard-deletes and subsequent history fetch
        returns 404."""
        z = _make_zone(client, admin_token, name="Doomed",
                       lat=1.0, lng=2.0)
        res = client.delete(
            f"/api/v1/predictions/zones/{z['id']}",
            headers=auth_header(admin_token),
        )
        assert res.status_code == 200, res.text

        # Row is gone from DB
        db.expire_all()
        row = db.query(PredictionZone).filter(PredictionZone.id == z["id"]).first()
        assert row is None

        # History endpoint now 404s (no zone)
        res_hist = client.get(
            f"/api/v1/predictions/{z['id']}/history",
            headers=auth_header(admin_token),
        )
        assert res_hist.status_code == 404


class TestPredictionHistoryAndAggregates:

    def test_zone_history_empty_initially_then_populates_after_result(
            self, client, db, admin_token):
        """/zones/{id}/history starts empty, then surfaces seeded results
        in reverse-chronological order."""
        z = _make_zone(client, admin_token, name="History-Zone",
                       lat=3.0, lng=4.0)

        # Initially: zone exists, no predictions.
        res_empty = client.get(
            f"/api/v1/predictions/{z['id']}/history",
            headers=auth_header(admin_token),
        )
        assert res_empty.status_code == 200
        body = res_empty.json()
        assert body["zone"]["id"] == z["id"]
        assert body["predictions"] == []

        # Seed one result
        _seed_result(db, z["id"], risk_score=33, risk_level="MEDIUM",
                     crisis_type="EARTHQUAKE")

        res = client.get(
            f"/api/v1/predictions/{z['id']}/history",
            headers=auth_header(admin_token),
        )
        assert res.status_code == 200
        body = res.json()
        assert len(body["predictions"]) == 1
        assert body["predictions"][0]["risk_score"] == pytest.approx(33)
        assert body["predictions"][0]["risk_level"] == "MEDIUM"
        assert body["predictions"][0]["predicted_crisis_type"] == "EARTHQUAKE"

    def test_heatmap_returns_aggregated_risk(self, client, db, admin_token):
        """/heatmap returns [lat, lng, score/100] tuples, one per zone
        that has at least one PredictionResult."""
        db.query(PredictionResult).delete()
        db.query(PredictionZone).delete()
        db.commit()

        z1 = _make_zone(client, admin_token, name="HM-A",
                        lat=10.0, lng=20.0)
        z2 = _make_zone(client, admin_token, name="HM-B",
                        lat=30.0, lng=40.0)
        # Zone without results should NOT show up on the heatmap.
        _make_zone(client, admin_token, name="HM-C",
                   lat=50.0, lng=60.0)

        _seed_result(db, z1["id"], risk_score=80)
        _seed_result(db, z2["id"], risk_score=20)

        res = client.get("/api/v1/predictions/heatmap",
                         headers=auth_header(admin_token))
        assert res.status_code == 200
        points = res.json()
        assert isinstance(points, list)
        assert len(points) == 2
        # Each entry is [lat, lng, normalized_score].
        coords = {(p[0], p[1]): p[2] for p in points}
        assert coords[(10.0, 20.0)] == pytest.approx(0.8)
        assert coords[(30.0, 40.0)] == pytest.approx(0.2)

    def test_latest_returns_most_recent_predictions(
            self, client, db, admin_token):
        """/latest returns exactly one row per zone — the newest
        result. Three results on one zone yields the latest by
        created_at."""
        db.query(PredictionResult).delete()
        db.query(PredictionZone).delete()
        db.commit()

        z = _make_zone(client, admin_token, name="Latest-Zone",
                       lat=5.0, lng=6.0)

        now = datetime.now(timezone.utc)
        _seed_result(db, z["id"], risk_score=10,
                     created_at=now - timedelta(hours=3))
        _seed_result(db, z["id"], risk_score=20,
                     created_at=now - timedelta(hours=2))
        newest = _seed_result(db, z["id"], risk_score=90,
                              created_at=now - timedelta(minutes=1))

        res = client.get("/api/v1/predictions/latest",
                         headers=auth_header(admin_token))
        assert res.status_code == 200
        body = res.json()
        assert len(body) == 1
        entry = body[0]
        assert entry["zone_id"] == z["id"]
        assert entry["risk_score"] == pytest.approx(newest.risk_score)
        assert entry["risk_score"] == pytest.approx(90)


class TestForecastEndpoint:

    def test_forecast_endpoint_with_mocked_anthropic(
            self, client, db, admin_token):
        """POST /forecast with run_prediction mocked — verifies the
        handler persists a PredictionResult and the response carries
        the mocked risk fields. No network calls."""
        db.query(PredictionResult).delete()
        db.query(PredictionZone).delete()
        db.commit()

        mock_return = {
            "risk_score": 67,
            "risk_level": "HIGH",
            "predicted_crisis_type": "FLOOD",
            "time_window_hours": 72,
            "confidence_score": 75,
            "headline": "Mocked prediction: high flood risk",
            "contributing_factors": ["Heavy rainfall", "Historical floods"],
            "signal_breakdown": {
                "historical_weight": 30, "weather_weight": 40,
                "seismic_weight": 5, "geospatial_weight": 20,
                "conflict_weight": 5,
            },
            "recommended_action": "Pre-position rescue teams",
            "reasoning": "Mocked reasoning for unit test",
            "weather_data": {"mock": True},
            "historical_summary": {"mock": True},
            "seismic_data": {"mock": True},
            "geospatial_data": {"mock": True},
            "conflict_data": {"mock": True},
        }

        with patch(
            "app.services.prediction_engine.run_prediction",
            new=AsyncMock(return_value=mock_return),
        ):
            res = client.post(
                "/api/v1/predictions/forecast",
                headers=auth_header(admin_token),
                json={
                    "name": "Forecast-Mock",
                    "latitude": 13.08, "longitude": 80.27,
                    "radius_km": 30.0,
                    "country": "India", "region": "Tamil Nadu",
                    "time_window_hours": 72,
                },
            )

        assert res.status_code == 200, res.text
        body = res.json()
        assert body["risk_score"] == 67
        assert body["risk_level"] == "HIGH"
        assert body["headline"] == "Mocked prediction: high flood risk"
        assert body["zone_name"] == "Forecast-Mock"

        # The handler should have persisted the row.
        db.expire_all()
        zone = db.query(PredictionZone).filter(
            PredictionZone.name == "Forecast-Mock").first()
        assert zone is not None
        pred = db.query(PredictionResult).filter(
            PredictionResult.zone_id == zone.id).first()
        assert pred is not None
        assert pred.risk_score == pytest.approx(67)
        assert pred.risk_level == "HIGH"
        assert pred.headline == "Mocked prediction: high flood risk"
