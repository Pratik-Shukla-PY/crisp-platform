"""Building-name provenance — the "Unnamed Building" regression guard.

An explicit OSM footprint tap (infrastructure_name_from_osm=true) must persist that
flag faithfully through intake, and a transient buildings-row upsert failure must NOT
demote the OSM provenance (which is what made an explicit "University" tag render as
"Unnamed Building"). Plus the 0063 data-heal flips historical mis-flagged rows.
"""
import csv
import io
import uuid

from sqlalchemy import text

from app.models.report import Report, Building
from tests.conftest import auth_header


def _meta(**over):
    body = {
        "device_hash": f"DEV-BLD-{uuid.uuid4().hex[:8]}",
        "client_report_id": str(uuid.uuid4()),
        "source": "APP",
        "severity": "SEVERE",
        "infrastructure_type": "OTHER",
        "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "description": "building-name provenance test",
        "expected_media": 0,
        # Frankfurt-ish so proximity assignment never collides with other fixtures.
        "location": {"latitude": 50.20 + 0.01, "longitude": 8.70 + 0.01},
    }
    body.update(over)
    return body


def test_osm_tag_provenance_persists_through_intake(client, db):
    """A report whose reporter tapped an OSM footprint keeps building name + from_osm=true
    end-to-end — the backend never demotes an explicit pick to 'needs mapping'."""
    bid = f"osm:way:{uuid.uuid4().int % 10_000_000}"
    res = client.post("/api/v1/reports/meta", json=_meta(
        building_id=bid, infrastructure_name="University",
        infrastructure_name_from_osm=True,
    ))
    assert res.status_code == 201, res.text
    r = db.query(Report).filter(Report.id == res.json()["id"]).first()
    assert r is not None
    assert r.infrastructure_name == "University"
    assert r.infrastructure_name_from_osm is True, "explicit OSM tag must stay from_osm=true"
    assert r.building_id == bid, "the OSM footprint link must persist"


def test_fk_upsert_failure_keeps_osm_provenance(client, db, monkeypatch):
    """If the parent buildings-row upsert fails, the FK forces dropping building_id — but
    infrastructure_name_from_osm must STAY true (so a later proximity link can still show
    the name). Previously it was reset to false → permanent 'Unnamed Building'."""
    monkeypatch.setattr(
        "app.api.endpoints.reports._ensure_building_for_pwa_pick",
        lambda *a, **k: None,
    )
    res = client.post("/api/v1/reports/meta", json=_meta(
        building_id=f"osm:way:{uuid.uuid4().int % 10_000_000}",
        infrastructure_name="University", infrastructure_name_from_osm=True,
        location={"latitude": 51.5074, "longitude": -0.1278},  # London, isolated
    ))
    assert res.status_code == 201, res.text
    r = db.query(Report).filter(Report.id == res.json()["id"]).first()
    assert r.infrastructure_name == "University", "name string is always kept"
    assert r.infrastructure_name_from_osm is True, "from_osm must NOT be demoted on FK-upsert failure"


def test_free_text_stays_needs_mapping(client, db):
    """A genuine free-text 'what was hit' answer (no OSM tap) stays from_osm=false so the
    dashboard correctly surfaces it as needs-mapping (must-have #6 — not a regression)."""
    res = client.post("/api/v1/reports/meta", json=_meta(
        infrastructure_name="the blue shop near the river",
        infrastructure_name_from_osm=False,
        location={"latitude": 48.8566, "longitude": 2.3522},  # Paris, isolated
    ))
    assert res.status_code == 201, res.text
    r = db.query(Report).filter(Report.id == res.json()["id"]).first()
    assert r.infrastructure_name_from_osm is False


def test_display_building_name_property_is_the_gate():
    """The Report.display_building_name SSOT property returns the name ONLY for an
    OSM-tagged pick — the single rule every human/AI surface now shares."""
    osm = Report(infrastructure_name="University", building_id="osm:way:9",
                 infrastructure_name_from_osm=True)
    assert osm.display_building_name == "University"
    # legacy row with the flag unset (None) but an OSM building_id → still shown.
    legacy = Report(infrastructure_name="Town Hall", building_id="osm:way:9",
                    infrastructure_name_from_osm=None)
    assert legacy.display_building_name == "Town Hall"
    # free-text "what was hit" (from_osm False) → suppressed.
    free = Report(infrastructure_name="the blue shop", building_id="osm:way:9",
                  infrastructure_name_from_osm=False)
    assert free.display_building_name is None
    # no building link, or no name → None.
    assert Report(infrastructure_name="X", building_id=None,
                  infrastructure_name_from_osm=True).display_building_name is None
    assert Report(infrastructure_name="", building_id="osm:way:9",
                  infrastructure_name_from_osm=True).display_building_name is None


def test_export_building_name_column_is_gated(client, db, viewer_token):
    """The CSV export's canonical building_name column carries the OSM name only; a
    free-text report leaves it blank (while raw infrastructure_name keeps the verbatim
    answer) — so an export never presents a descriptor AS the building name."""
    osm_desc = f"osm-export-{uuid.uuid4().hex[:8]}"
    free_desc = f"free-export-{uuid.uuid4().hex[:8]}"
    client.post("/api/v1/reports/meta", json=_meta(
        description=osm_desc, building_id=f"osm:way:{uuid.uuid4().int % 9_000_000}",
        infrastructure_name="Central Library", infrastructure_name_from_osm=True,
        location={"latitude": 35.6762, "longitude": 139.6503}))  # Tokyo
    client.post("/api/v1/reports/meta", json=_meta(
        description=free_desc, infrastructure_name="old shed by the canal",
        infrastructure_name_from_osm=False,
        location={"latitude": -33.8688, "longitude": 151.2093}))  # Sydney
    db.commit()

    res = client.get("/api/v1/exports/csv", headers=auth_header(viewer_token))
    assert res.status_code == 200, res.text
    rows = {r["description"]: r for r in csv.DictReader(io.StringIO(res.text)) if r.get("description") in (osm_desc, free_desc)}
    assert "building_name" in (res.text.splitlines()[0])
    # OSM report: canonical building_name = the name; raw also present.
    assert rows[osm_desc]["building_name"] == "Central Library"
    assert rows[osm_desc]["infrastructure_name"] == "Central Library"
    # Free-text report: building_name BLANK (not presented as a building), raw kept.
    assert rows[free_desc]["building_name"] == ""
    assert rows[free_desc]["infrastructure_name"] == "old shed by the canal"


def test_0063_heal_flips_mis_flagged_osm_rows(client, db):
    """The 0063 data-heal: an osm:* building_id with a name but from_osm=false can only be
    the pre-v135 bug → flip it true and backfill Building.osm_name."""
    bid = f"osm:way:{uuid.uuid4().int % 10_000_000}"
    # Reproduce the bug shape via the real intake (from_osm=false on an OSM footprint).
    res = client.post("/api/v1/reports/meta", json=_meta(
        building_id=bid, infrastructure_name="Town Hall",
        infrastructure_name_from_osm=False,
        location={"latitude": 40.7128, "longitude": -74.0060},  # NYC, isolated
    ))
    assert res.status_code == 201, res.text
    rid = res.json()["id"]
    db.commit()
    # The buildings row exists but has no name (osm_name not threaded when from_osm=false).
    b = db.query(Building).filter(Building.id == bid).first()
    assert b is not None and not b.osm_name

    # Run the heal exactly as migration 0063 does.
    db.execute(text(
        "UPDATE reports SET infrastructure_name_from_osm = true "
        "WHERE building_id LIKE 'osm:%' AND infrastructure_name IS NOT NULL "
        "AND btrim(infrastructure_name) <> '' AND infrastructure_name_from_osm = false "
        "AND deletion_requested_at IS NULL"
    ))
    db.execute(text(
        "UPDATE buildings b SET osm_name = sub.nm FROM ("
        "  SELECT DISTINCT ON (building_id) building_id, btrim(infrastructure_name) AS nm "
        "  FROM reports WHERE building_id LIKE 'osm:%' AND infrastructure_name IS NOT NULL "
        "  AND btrim(infrastructure_name) <> '' AND deletion_requested_at IS NULL "
        "  ORDER BY building_id, server_created_at ASC) AS sub "
        "WHERE b.id = sub.building_id AND (b.osm_name IS NULL OR btrim(b.osm_name) = '')"
    ))
    db.commit()

    db.expire_all()
    r = db.query(Report).filter(Report.id == rid).first()
    assert r.infrastructure_name_from_osm is True, "heal must flip the mis-flagged OSM row"
    b = db.query(Building).filter(Building.id == bid).first()
    assert b.osm_name == "Town Hall", "heal must backfill the building's canonical name"
