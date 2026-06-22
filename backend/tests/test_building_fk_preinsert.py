"""P0 reliability — buildings FK pre-insert on PWA-supplied building_id.

Background: production added `fk_reports_building_id` from
`reports.building_id` → `buildings.id` (migration 0028). The
`_apply_building_link` after_insert hook in `app/models/report.py`
maintains the buildings cache, but it fires AFTER the report INSERT —
too late for the FK check. `_auto_assign_building_id` handles the
proximity-cluster path but early-returns when the PWA has already
supplied a `building_id`. Result on a fresh DB (or any client whose
tapped OSM footprint hasn't been mirrored into `buildings` yet): the
report INSERT raises `ForeignKeyViolation` and the entire submission
500s — UNDP must-have #6 regression.

These tests pin the pre-INSERT upsert behavior in
`_ensure_building_for_pwa_pick`:
  · happy path — osm:way:N pre-creates the buildings row + report lands
  · osm_name carry-through — Building.osm_name populated on first insert
  · osm:node:N is recognised as OSM
  · idempotent — second submit reuses the existing buildings row
  · fallback — upsert failure does NOT 500 the submission; report lands
    with building_id=NULL + infrastructure_name_from_osm=False so the
    dashboard surfaces it under "needs mapping" (the project invariants UNDP #6).

Note: the FK is not declared on the SQLAlchemy model (it's added only
by alembic 0028), so `Base.metadata.create_all` in the test DB does
NOT recreate the constraint. We can't trigger the FK violation
directly in pytest — instead we assert the buildings row exists
before the report INSERT, which is the invariant that makes the FK
satisfied in prod.
"""
import uuid

from sqlalchemy import text


def _meta_payload(device_hash: str, building_id, **overrides):
    payload = {
        "device_hash": device_hash,
        "client_report_id": str(uuid.uuid4()),
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "RESIDENTIAL",
        "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "description": "fk preinsert test",
        "expected_media": 0,
        "location": {"latitude": 12.97, "longitude": 77.59},
        "building_id": building_id,
    }
    payload.update(overrides)
    return payload


class TestPwaOsmPickPreInsert:
    def test_osm_way_pick_creates_minimal_buildings_row(self, client, db):
        bid = "osm:way:1307630881"
        # Make sure buildings is clean for this id.
        db.execute(text("DELETE FROM buildings WHERE id = :bid"), {"bid": bid})
        db.commit()

        res = client.post("/api/v1/reports/meta", json=_meta_payload(
            "DEV-FK-1", bid,
        ))
        assert res.status_code == 201, f"{res.status_code}: {res.text}"
        assert res.json()["building_id"] == bid

        row = db.execute(
            text("SELECT id, id_source, osm_way_id FROM buildings WHERE id = :bid"),
            {"bid": bid},
        ).first()
        assert row is not None, "buildings row was not pre-created"
        assert row[0] == bid
        assert row[1] == "OSM"
        assert row[2] == 1307630881

    def test_osm_name_populated_when_infrastructure_name_from_osm(self, client, db):
        bid = "osm:way:42424242"
        db.execute(text("DELETE FROM buildings WHERE id = :bid"), {"bid": bid})
        db.commit()

        res = client.post("/api/v1/reports/meta", json=_meta_payload(
            "DEV-FK-2", bid,
            infrastructure_name="City Hospital",
            infrastructure_name_from_osm=True,
        ))
        assert res.status_code == 201, f"{res.status_code}: {res.text}"

        row = db.execute(
            text("SELECT osm_name FROM buildings WHERE id = :bid"),
            {"bid": bid},
        ).first()
        assert row is not None
        assert row[0] == "City Hospital"

    def test_osm_name_not_overwritten_for_free_text_name(self, client, db):
        bid = "osm:way:55555"
        db.execute(text("DELETE FROM buildings WHERE id = :bid"), {"bid": bid})
        db.commit()

        # Free-text path: name typed by user, NOT from OSM. We must NOT
        # write it into buildings.osm_name — that column is reserved for
        # the canonical OSM tag-derived name.
        res = client.post("/api/v1/reports/meta", json=_meta_payload(
            "DEV-FK-3", bid,
            infrastructure_name="user-typed local landmark",
            infrastructure_name_from_osm=False,
        ))
        assert res.status_code == 201, f"{res.status_code}: {res.text}"

        row = db.execute(
            text("SELECT osm_name FROM buildings WHERE id = :bid"),
            {"bid": bid},
        ).first()
        assert row is not None
        assert row[0] is None

    def test_osm_node_id_recognised_as_osm(self, client, db):
        bid = "osm:node:99999"
        db.execute(text("DELETE FROM buildings WHERE id = :bid"), {"bid": bid})
        db.commit()

        res = client.post("/api/v1/reports/meta", json=_meta_payload(
            "DEV-FK-4", bid,
        ))
        assert res.status_code == 201, f"{res.status_code}: {res.text}"

        row = db.execute(
            text("SELECT id_source, osm_way_id FROM buildings WHERE id = :bid"),
            {"bid": bid},
        ).first()
        assert row is not None
        assert row[0] == "OSM"
        # node ids do NOT populate osm_way_id; they'd land in osm_node_id
        # (not asserted here — out of scope for this fix).
        assert row[1] is None

    def test_second_submission_reuses_existing_buildings_row(self, client, db):
        bid = "osm:way:1010101"
        db.execute(text("DELETE FROM buildings WHERE id = :bid"), {"bid": bid})
        db.commit()

        r1 = client.post("/api/v1/reports/meta", json=_meta_payload(
            "DEV-FK-5", bid,
        ))
        assert r1.status_code == 201
        r2 = client.post("/api/v1/reports/meta", json=_meta_payload(
            "DEV-FK-5", bid,
        ))
        assert r2.status_code == 201

        count = db.execute(
            text("SELECT COUNT(*) FROM buildings WHERE id = :bid"),
            {"bid": bid},
        ).scalar()
        assert count == 1, "ON CONFLICT DO NOTHING should keep a single row"

    def test_no_building_id_leaves_buildings_table_alone(self, client, db):
        before = db.execute(text("SELECT COUNT(*) FROM buildings")).scalar() or 0

        # Use coords far from the Bangalore (12.97, 77.59) cluster the
        # other tests in this module write to so the existing
        # `_auto_assign_building_id` proximity-cluster path can't latch
        # onto a sibling report's building_id. The 30 m radius is
        # measured against the report's own Location.
        res = client.post("/api/v1/reports/meta", json=_meta_payload(
            "DEV-FK-6", None,
            infrastructure_name="some place",
            infrastructure_name_from_osm=False,
            location={"latitude": 35.68, "longitude": 139.69},  # Tokyo
        ))
        assert res.status_code == 201, f"{res.status_code}: {res.text}"
        assert res.json()["building_id"] is None

        # No row should be created when the reporter doesn't tap a footprint
        # and there are no nearby reports for proximity-clustering to latch
        # onto.
        after = db.execute(text("SELECT COUNT(*) FROM buildings")).scalar() or 0
        assert after == before


class TestHelperUnit:
    def test_helper_returns_building_id_on_success(self, db):
        from app.api.endpoints.reports import _ensure_building_for_pwa_pick

        bid = f"osm:way:{uuid.uuid4().int % 10**10}"
        db.execute(text("DELETE FROM buildings WHERE id = :bid"), {"bid": bid})
        db.commit()

        result = _ensure_building_for_pwa_pick(db, bid, osm_name="Sample Tower")
        assert result == bid

        row = db.execute(
            text("SELECT id_source, osm_name FROM buildings WHERE id = :bid"),
            {"bid": bid},
        ).first()
        assert row is not None
        assert row[0] == "OSM"
        assert row[1] == "Sample Tower"

    def test_helper_short_circuits_on_empty_input(self, db):
        from app.api.endpoints.reports import _ensure_building_for_pwa_pick
        assert _ensure_building_for_pwa_pick(db, None) is None
        assert _ensure_building_for_pwa_pick(db, "") == ""

    def test_helper_returns_none_when_upsert_raises(self, db, monkeypatch):
        from app.api.endpoints.reports import _ensure_building_for_pwa_pick
        from app.models import report as report_mod

        def _boom(*_args, **_kwargs):
            raise RuntimeError("simulated DB outage")

        monkeypatch.setattr(report_mod, "_ensure_building_exists", _boom)
        result = _ensure_building_for_pwa_pick(db, "osm:way:7777", osm_name="X")
        assert result is None, "helper must absorb the error and signal fallback"

    def test_endpoint_falls_through_to_null_when_upsert_raises(
        self, client, db, monkeypatch,
    ):
        # Force the underlying upsert to fail. The endpoint MUST still
        # return 201 — UNDP must-have #6 fallback. The report lands with
        # building_id=NULL + infrastructure_name_from_osm=False so the
        # dashboard surfaces it under "needs mapping".
        from app.models import report as report_mod

        def _boom(*_args, **_kwargs):
            raise RuntimeError("simulated DB outage")

        monkeypatch.setattr(report_mod, "_ensure_building_exists", _boom)
        # Submit at a far-away coord so the `_auto_assign_building_id`
        # proximity-cluster path (which still runs after our fallback)
        # can't pick up a sibling report's building_id and mask the
        # NULL signal we're asserting on.
        res = client.post("/api/v1/reports/meta", json=_meta_payload(
            "DEV-FK-FALLBACK",
            "osm:way:222222",
            infrastructure_name="Some Bldg from OSM",
            infrastructure_name_from_osm=True,
            location={"latitude": -33.87, "longitude": 151.21},  # Sydney
        ))
        assert res.status_code == 201, f"{res.status_code}: {res.text}"
        body = res.json()
        assert body["building_id"] is None
        # Building-tag consistency fix (Jun 2026): the FK pre-insert failing is a
        # TRANSIENT DB issue, not a reason to demote the OSM provenance — the reporter
        # DID tap an OSM footprint. We KEEP infrastructure_name_from_osm=True so the
        # dashboard shows the real OSM name (e.g. "University") instead of "Unnamed
        # Building"; migration 0063 + the proximity re-assign heal the building_id later.
        assert body.get("infrastructure_name_from_osm") is True
        # infrastructure_name is preserved — the operator still has the
        # OSM-derived name to triage from on the dashboard.
        assert body["infrastructure_name"] == "Some Bldg from OSM"
