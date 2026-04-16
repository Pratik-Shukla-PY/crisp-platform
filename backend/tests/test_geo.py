"""Unit tests for geospatial functions — distance, clustering, risk zones."""
import pytest
from app.services.prediction_engine import _haversine_km, gather_geospatial


class TestHaversine:
    def test_same_point_is_zero(self):
        assert _haversine_km(12.97, 77.59, 12.97, 77.59) == 0

    def test_known_distance_nyc_la(self):
        # NYC (40.71, -74.01) to LA (34.05, -118.24) ≈ 3944 km
        d = _haversine_km(40.71, -74.01, 34.05, -118.24)
        assert 3900 < d < 4000

    def test_short_distance_1km(self):
        # ~1km offset in latitude ≈ 0.009 degrees
        d = _haversine_km(12.970, 77.590, 12.979, 77.590)
        assert 0.9 < d < 1.1

    def test_symmetric(self):
        d1 = _haversine_km(10, 20, 30, 40)
        d2 = _haversine_km(30, 40, 10, 20)
        assert abs(d1 - d2) < 0.01

    def test_equator_to_pole(self):
        d = _haversine_km(0, 0, 90, 0)
        assert 9900 < d < 10100  # ~10000 km


class TestGeospatialRisk:
    def test_dhaka_is_flood_zone(self):
        result = gather_geospatial(23.8, 90.4)
        assert result["flood_zone"] is True

    def test_mumbai_is_flood_zone(self):
        result = gather_geospatial(19.1, 72.9)
        assert result["flood_zone"] is True

    def test_inland_desert_not_flood_zone(self):
        # Sahara Desert
        result = gather_geospatial(25.0, 10.0)
        assert result["flood_zone"] is False

    def test_himalaya_is_landslide_risk(self):
        result = gather_geospatial(28.0, 84.0)
        assert result["landslide_risk"] == "HIGH"

    def test_plains_no_landslide(self):
        result = gather_geospatial(12.97, 77.59)
        assert result["landslide_risk"] == "LOW"

    def test_returns_all_fields(self):
        result = gather_geospatial(0, 0)
        assert "elevation_risk" in result
        assert "coastal_proximity_km" in result
        assert "flood_zone" in result
        assert "landslide_risk" in result
