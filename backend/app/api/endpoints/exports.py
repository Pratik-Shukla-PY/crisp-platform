"""
Data Export Endpoints — CSV, GeoJSON, Shapefile, KML
For UNDP judges and GIS tool integration.
"""
import io
import json
import logging
import zipfile
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from app.core.deps import require_viewer

from app.db.session import get_db
from app.models.report import Report, Location

logger = logging.getLogger(__name__)
router = APIRouter()


def _query_reports(db: Session, status: Optional[str], crisis_type: Optional[str],
                   since: Optional[str], until: Optional[str]):
    """Shared query builder for all export endpoints."""
    q = db.query(Report).filter(Report.deletion_requested_at.is_(None))
    if status:
        q = q.filter(Report.status == status)
    if crisis_type:
        q = q.filter(Report.crisis_type == crisis_type)
    if since:
        try:
            q = q.filter(Report.server_created_at >= datetime.fromisoformat(since))
        except ValueError:
            pass
    if until:
        try:
            q = q.filter(Report.server_created_at <= datetime.fromisoformat(until))
        except ValueError:
            pass
    return q.order_by(Report.server_created_at.desc()).all()


def _report_to_row(r):
    """Extract flat dict from a Report for export."""
    loc = r.location
    return {
        "id": r.id,
        "client_report_id": r.client_report_id or "",
        "source": r.source.value if r.source else "",
        "status": r.status.value if r.status else "",
        "severity": r.severity.value if r.severity else "",
        "infrastructure_type": r.infrastructure_type.value if r.infrastructure_type else "",
        "infrastructure_name": r.infrastructure_name or "",
        "damage_classification": r.damage_classification or "",
        "crisis_type": r.crisis_type or "",
        "description": (r.description or "").replace("\n", " ").replace(",", ";"),
        "debris_clearing_needed": str(r.debris_clearing_needed) if r.debris_clearing_needed is not None else "",
        "service_status": json.dumps(r.service_status) if r.service_status else "",
        "building_id": r.building_id or "",
        "latitude": str(loc.latitude) if loc else "",
        "longitude": str(loc.longitude) if loc else "",
        "location_name": (loc.user_location_name or loc.device_location_name or "") if loc else "",
        "lives_impacted": str(r.lives_impacted) if r.lives_impacted else "",
        "timestamp": r.server_created_at.isoformat() if r.server_created_at else "",
    }


# ── CSV Export ────────────────────────────────────────────────────────────────

@router.get("/csv")
def export_csv(
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    crisis_type: Optional[str] = Query(None),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
):
    """Export all reports as CSV file."""
    reports = _query_reports(db, status, crisis_type, since, until)
    headers = [
        "id", "client_report_id", "source", "status", "severity",
        "infrastructure_type", "infrastructure_name", "damage_classification",
        "crisis_type", "description", "debris_clearing_needed", "service_status",
        "building_id", "latitude", "longitude", "location_name", "lives_impacted", "timestamp"
    ]

    def generate():
        yield ",".join(headers) + "\n"
        for r in reports:
            row = _report_to_row(r)
            yield ",".join(f'"{row.get(h, "")}"' for h in headers) + "\n"

    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=crisp_reports_{datetime.now().strftime('%Y%m%d')}.csv"}
    )


# ── GeoJSON Export ────────────────────────────────────────────────────────────

@router.get("/geojson")
def export_geojson(
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    crisis_type: Optional[str] = Query(None),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
):
    """Export all reports as GeoJSON FeatureCollection."""
    reports = _query_reports(db, status, crisis_type, since, until)
    features = []
    for r in reports:
        row = _report_to_row(r)
        loc = r.location
        if not loc:
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [loc.longitude, loc.latitude]},
            "properties": {k: v for k, v in row.items() if k not in ("latitude", "longitude")},
        })

    geojson = {"type": "FeatureCollection", "features": features}
    content = json.dumps(geojson, indent=2)
    return StreamingResponse(
        io.BytesIO(content.encode()),
        media_type="application/geo+json",
        headers={"Content-Disposition": f"attachment; filename=crisp_reports_{datetime.now().strftime('%Y%m%d')}.geojson"}
    )


# ── Shapefile Export ──────────────────────────────────────────────────────────

@router.get("/shapefile")
def export_shapefile(
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    crisis_type: Optional[str] = Query(None),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
):
    """Export all reports as Shapefile (.shp/.shx/.dbf/.prj) in a ZIP."""
    import shapefile

    reports = _query_reports(db, status, crisis_type, since, until)

    shp_buf = io.BytesIO()
    shx_buf = io.BytesIO()
    dbf_buf = io.BytesIO()

    w = shapefile.Writer(shp=shp_buf, shx=shx_buf, dbf=dbf_buf)
    w.field("ID", "C", 40)
    w.field("SOURCE", "C", 20)
    w.field("STATUS", "C", 20)
    w.field("SEVERITY", "C", 20)
    w.field("INFRA_TYPE", "C", 20)
    w.field("INFRA_NAME", "C", 255)
    w.field("DAMAGE_CLS", "C", 20)
    w.field("CRISIS", "C", 20)
    w.field("DEBRIS", "C", 10)
    w.field("BUILDING", "C", 40)
    w.field("DESCRIPT", "C", 254)
    w.field("TIMESTAMP", "C", 30)

    for r in reports:
        loc = r.location
        if not loc:
            continue
        row = _report_to_row(r)
        w.point(loc.longitude, loc.latitude)
        w.record(
            row["id"][:40], row["source"][:20], row["status"][:20],
            row["severity"][:20], row["infrastructure_type"][:20],
            row["infrastructure_name"][:255], row["damage_classification"][:20],
            row["crisis_type"][:20], row["debris_clearing_needed"][:10],
            row["building_id"][:40], row["description"][:254], row["timestamp"][:30]
        )

    w.close()

    # WGS84 projection file
    prj_content = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]'

    # Package into ZIP
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("crisp_reports.shp", shp_buf.getvalue())
        zf.writestr("crisp_reports.shx", shx_buf.getvalue())
        zf.writestr("crisp_reports.dbf", dbf_buf.getvalue())
        zf.writestr("crisp_reports.prj", prj_content)
    zip_buf.seek(0)

    return StreamingResponse(
        zip_buf,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=crisp_reports_{datetime.now().strftime('%Y%m%d')}.zip"}
    )


# ── KML Export ────────────────────────────────────────────────────────────────

@router.get("/kml")
def export_kml(
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    crisis_type: Optional[str] = Query(None),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
):
    """Export all reports as KML for Google Earth."""
    import simplekml

    reports = _query_reports(db, status, crisis_type, since, until)
    kml = simplekml.Kml(name="CRISP Crisis Reports")

    damage_colors = {
        "COMPLETE": simplekml.Color.red,
        "PARTIAL": simplekml.Color.orange,
        "NO_DAMAGE": simplekml.Color.green,
    }

    for r in reports:
        loc = r.location
        if not loc:
            continue
        row = _report_to_row(r)
        name = f"{row['infrastructure_type']} — {row['severity']}"
        desc = f"Crisis: {row['crisis_type']}\nDamage: {row['damage_classification']}\nDescription: {row['description']}\nTime: {row['timestamp']}"

        pnt = kml.newpoint(name=name, description=desc)
        pnt.coords = [(loc.longitude, loc.latitude)]
        color = damage_colors.get(row["damage_classification"], simplekml.Color.white)
        pnt.style.iconstyle.color = color

    content = kml.kml()
    return StreamingResponse(
        io.BytesIO(content.encode()),
        media_type="application/vnd.google-earth.kml+xml",
        headers={"Content-Disposition": f"attachment; filename=crisp_reports_{datetime.now().strftime('%Y%m%d')}.kml"}
    )
