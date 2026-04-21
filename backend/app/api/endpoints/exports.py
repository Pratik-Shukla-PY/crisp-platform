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
    """Extract flat dict from a Report for export.

    UNDP-aligned values:
      * damage_classification → normalised to MINIMAL / PARTIAL / COMPLETE
        (legacy 'NO_DAMAGE' persisted pre-migration is mapped on read)
      * crisis_category → derived from crisis_type at write time; falls
        back to an on-read lookup for historical rows."""
    from app.core.taxonomy import normalise_damage, categorise_crisis
    loc = r.location
    damage = normalise_damage(r.damage_classification) or (r.damage_classification or "")
    crisis_cat = getattr(r, "crisis_category", None) or categorise_crisis(r.crisis_type) or ""
    return {
        "id": r.id,
        "client_report_id": r.client_report_id or "",
        "source": r.source.value if r.source else "",
        "status": r.status.value if r.status else "",
        "severity": r.severity.value if r.severity else "",
        "infrastructure_type": r.infrastructure_type.value if r.infrastructure_type else "",
        "infrastructure_sub_type": getattr(r, "infrastructure_sub_type", "") or "",
        "infrastructure_name": r.infrastructure_name or "",
        "damage_classification": damage,
        "crisis_type": r.crisis_type or "",
        "crisis_category": crisis_cat,
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
        "infrastructure_type", "infrastructure_sub_type", "infrastructure_name",
        "damage_classification", "crisis_type", "crisis_category",
        "description", "debris_clearing_needed", "service_status",
        "building_id", "latitude", "longitude", "location_name",
        "lives_impacted", "timestamp"
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


# ── PDF Export ────────────────────────────────────────────────────────────────
#
# April 2026: judges + humanitarian-response teams consistently ask for a
# human-readable one-page summary alongside the GIS formats. ReportLab is
# Python-native, no headless-browser dependency, and outputs accessible
# tagged PDFs (PDF/UA-adjacent). The CSV + GeoJSON + Shapefile + KML + PDF
# stack is what the pitch deck claims — this endpoint makes that true.

@router.get("/pdf")
def export_pdf(
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    crisis_type: Optional[str] = Query(None),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    limit: int = Query(200, ge=1, le=1000),
):
    """Export up to `limit` reports as a single PDF dossier.

    One page per report. Header carries the filter criteria + generated-at
    timestamp + UNDP Appendix-1 taxonomy attribution so the document is
    self-describing for humanitarian audit trails."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    )
    from reportlab.lib import colors

    reports = _query_reports(db, status, crisis_type, since, until)[:limit]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm,
        topMargin=2 * cm, bottomMargin=2 * cm,
        title="CRISP Report Dossier",
        author="CRISP Platform",
    )
    styles = getSampleStyleSheet()
    h1 = styles["Heading1"]
    h2 = styles["Heading2"]
    body = styles["BodyText"]
    small = ParagraphStyle(
        "small", parent=body, fontSize=8, textColor=colors.grey
    )
    label = ParagraphStyle(
        "label", parent=body, fontName="Helvetica-Bold", fontSize=9,
    )

    story = []
    # Cover block
    story.append(Paragraph("CRISP Crisis-Report Dossier", h1))
    story.append(Paragraph(
        "UNDP RAPIDA Appendix-1 aligned export — damage classification uses "
        "MINIMAL / PARTIAL / COMPLETE; infrastructure uses the seven UNDP "
        "super-types + OTHER.",
        small,
    ))
    story.append(Paragraph(
        f"Generated at {datetime.utcnow().isoformat()}Z — {len(reports)} report(s) included.",
        small,
    ))
    filt_bits = []
    if status: filt_bits.append(f"status={status}")
    if crisis_type: filt_bits.append(f"crisis_type={crisis_type}")
    if since: filt_bits.append(f"since={since}")
    if until: filt_bits.append(f"until={until}")
    if filt_bits:
        story.append(Paragraph("Filters: " + ", ".join(filt_bits), small))
    story.append(Spacer(1, 0.4 * cm))

    for i, r in enumerate(reports):
        if i > 0:
            story.append(PageBreak())
        row = _report_to_row(r)
        story.append(Paragraph(
            f"Report {row['id'][:8]} — {row['infrastructure_type'] or 'UNKNOWN'} / {row['damage_classification'] or 'UNKNOWN'}",
            h2,
        ))
        story.append(Spacer(1, 0.2 * cm))

        data = [
            ["Client Ref",             row["client_report_id"]],
            ["Source",                 row["source"]],
            ["Status",                 row["status"]],
            ["Severity",               row["severity"]],
            ["Crisis Type",            row["crisis_type"]],
            ["Crisis Category (UNDP)", row["crisis_category"]],
            ["Infrastructure (UNDP)",  row["infrastructure_type"]],
            ["Sub-type",               row.get("infrastructure_sub_type", "")],
            ["Building / Structure",   row["infrastructure_name"]],
            ["Damage Classification",  row["damage_classification"]],
            ["Debris Clearing",        row["debris_clearing_needed"]],
            ["Location (lat, lng)",    f"{row['latitude']}, {row['longitude']}"],
            ["Location Name",          row["location_name"]],
            ["Lives Impacted",         row["lives_impacted"]],
            ["Submitted at",           row["timestamp"]],
        ]
        table = Table(data, colWidths=[5 * cm, None], hAlign="LEFT")
        table.setStyle(TableStyle([
            ("FONTNAME",   (0, 0), (0, -1), "Helvetica-Bold"),
            ("FONTSIZE",   (0, 0), (-1, -1), 9),
            ("TEXTCOLOR",  (0, 0), (0, -1), colors.HexColor("#475569")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("TOPPADDING",    (0, 0), (-1, -1), 4),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ]))
        story.append(table)

        if r.description:
            story.append(Spacer(1, 0.3 * cm))
            story.append(Paragraph("Description", label))
            story.append(Paragraph(r.description, body))

        if r.service_status:
            story.append(Spacer(1, 0.3 * cm))
            story.append(Paragraph("Service status", label))
            for k, v in (r.service_status or {}).items():
                story.append(Paragraph(f"{k}: {v}", body))

    # Handle empty result gracefully — don't ship an empty PDF.
    if not reports:
        story.append(Paragraph("No reports matched the supplied filters.", body))

    doc.build(story)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/pdf",
        headers={
            "Content-Disposition":
                f"attachment; filename=crisp_reports_{datetime.now().strftime('%Y%m%d')}.pdf"
        },
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

    # Colour by UNDP damage label. "NO_DAMAGE" kept as an alias for legacy
    # rows until the next purge pass rewrites them to MINIMAL.
    damage_colors = {
        "COMPLETE": simplekml.Color.red,
        "PARTIAL": simplekml.Color.orange,
        "MINIMAL": simplekml.Color.green,
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
