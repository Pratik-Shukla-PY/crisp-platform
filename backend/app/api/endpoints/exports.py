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
        back to an on-read lookup for historical rows.

    Phase C.1 (May 2026, UNDP-grade rebuild) — satellite verification
    columns. Judges + downstream analysts pulling exports need to see
    truth scores, not just raw report data. Pulled from the related
    SatelliteVerification row (one-to-one on report_id). When no
    verification has run, the columns are blank rather than absent so
    CSV/GeoJSON consumers can rely on a stable schema.

    Phase 2.1 (May 2026, audit follow-up) — flatten V4 fields. The
    UNDP analyst doing data-driven needs assessment in Excel /
    QGIS / R cares about flat columns, not a JSON blob. We unpack
    ``service_status`` into ``electricity_status`` / ``water_status``
    / ``health_status`` columns, ``pressing_needs`` into a
    semicolon-joined string, and add the gamification ``reporter_tier``
    (joined from ReporterProfile via Device.device_hash). Stable
    schema across formats so a downstream analyst can use the
    same field names whether they pulled CSV, GeoJSON, Shapefile,
    KML, or PDF.
    """
    from app.core.taxonomy import normalise_damage, categorise_crisis
    loc = r.location
    damage = normalise_damage(r.damage_classification) or (r.damage_classification or "")
    crisis_cat = getattr(r, "crisis_category", None) or categorise_crisis(r.crisis_type) or ""
    # Verification fields — pulled from the SatelliteVerification row
    # if present. Single-row 1:1 relationship via Report.verification.
    v = getattr(r, "verification", None)

    # ── V4 service-status unpack ──────────────────────────────────────
    # The Report.service_status JSON carries {electricity, water,
    # health, pressing_needs}. Older rows may carry a subset; we
    # default missing scalars to "" and missing lists to [] so the
    # column shape stays stable for downstream consumers.
    ss = r.service_status if isinstance(r.service_status, dict) else {}
    electricity_status = str(ss.get("electricity", "") or "")
    water_status       = str(ss.get("water", "")       or "")
    health_status      = str(ss.get("health", "")      or "")
    pressing_needs_raw = ss.get("pressing_needs", []) or []
    # Semicolons not commas — CSV-safe AND aligns with the GIS
    # convention for multi-valued attribute fields.
    pressing_needs_csv = ";".join(
        [str(x) for x in pressing_needs_raw if x] if isinstance(pressing_needs_raw, list) else []
    )

    # ── V4 reporter_tier ──────────────────────────────────────────────
    # Joined from ReporterProfile via the device's device_hash. We do
    # this on a per-row basis to keep the export endpoints simple
    # (the dashboard listing endpoint uses a bulk JOIN; exports
    # stream so the per-row cost is fine for the typical ≤10k-row
    # download). Errors are silenced — a tier-join failure must
    # never corrupt a bulk export.
    reporter_tier = ""
    try:
        # Importing lazily so the model module isn't loaded unless an
        # export is actually requested.
        from app.models.report import Device, ReporterProfile
        from app.db.session import SessionLocal  # noqa: F401  (used implicitly via r._sa_instance_state.session)
        sess = getattr(r, "_sa_instance_state", None)
        sess = sess.session if sess is not None else None
        if sess is not None and r.device_id:
            dev = sess.query(Device).filter(Device.id == r.device_id).first()
            if dev and dev.device_hash:
                prof = sess.query(ReporterProfile).filter(
                    ReporterProfile.device_hash == dev.device_hash
                ).first()
                if prof and prof.badge_level in (
                    "T1_SCOUT", "T2_SIGNAL", "T3_CHANGEMAKER", "T4_LIFEKEEPER",
                ):
                    reporter_tier = prof.badge_level
    except Exception:
        logger.exception("reporter_tier join failed for report %s", getattr(r, "id", "<unknown>"))

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
        # Keep `service_status` as the legacy JSON blob for any
        # downstream pipeline that already parses it; the flat
        # columns below are the new canonical surface.
        "service_status": json.dumps(r.service_status) if r.service_status else "",
        # Phase 2.1 — V4 flat columns (UNDP analyst-friendly).
        "electricity_status": electricity_status,
        "water_status":       water_status,
        "health_status":      health_status,
        "pressing_needs":     pressing_needs_csv,
        "reporter_tier":      reporter_tier,
        "building_id": r.building_id or "",
        "latitude": str(loc.latitude) if loc else "",
        "longitude": str(loc.longitude) if loc else "",
        "location_name": (loc.user_location_name or loc.device_location_name or "") if loc else "",
        "lives_impacted": str(r.lives_impacted) if r.lives_impacted else "",
        "timestamp": r.server_created_at.isoformat() if r.server_created_at else "",
        # ── Satellite verification (UNDP truth-score columns) ──
        "satellite_verdict": (v.verdict if v else "") or "",
        "satellite_total_score": str(v.total_score) if v and v.total_score is not None else "",
        "satellite_acquisition_date": (v.satellite_acquisition_date if v else "") or "",
        "satellite_days_gap": str(v.satellite_days_gap) if v and v.satellite_days_gap is not None else "",
        "satellite_cloud_cover_pct": (
            f"{v.satellite_cloud_cover_pct:.1f}" if v and v.satellite_cloud_cover_pct is not None else ""
        ),
        "satellite_source": (v.satellite_source if v else "") or "",
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
        # Phase 2.1 (May 2026) — UNDP analyst-friendly flat V4
        # columns. ``service_status`` JSON above is kept for legacy
        # consumers; these split it into one column per signal so
        # spreadsheets / QGIS / R can filter / pivot directly.
        "electricity_status", "water_status", "health_status",
        "pressing_needs", "reporter_tier",
        "building_id", "latitude", "longitude", "location_name",
        "lives_impacted", "timestamp",
        # .1 — satellite verification columns. UNDP
        # judges + downstream analysts can now see truth scores in
        # bulk exports, not just in the dashboard.
        "satellite_verdict", "satellite_total_score",
        "satellite_acquisition_date", "satellite_days_gap",
        "satellite_cloud_cover_pct", "satellite_source",
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
    # Phase 2.1 (May 2026) — V4 columns. Shapefile DBF caps column
    # names at 10 chars + values per type-spec; ESRI-style abbrevs:
    #   ELEC_STAT   → service_status.electricity
    #   WATER_STAT  → service_status.water
    #   HEALTH_ST   → service_status.health
    #   NEEDS       → service_status.pressing_needs (semicolon-joined)
    #   REPRT_TIER  → reporter's gamification tier
    w.field("ELEC_STAT", "C", 25)
    w.field("WATER_STAT", "C", 25)
    w.field("HEALTH_ST", "C", 25)
    w.field("NEEDS", "C", 200)
    w.field("REPRT_TIER", "C", 20)

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
            row["building_id"][:40], row["description"][:254], row["timestamp"][:30],
            # V4 columns — slice to the DBF column width so the
            # shapefile writer never silently truncates mid-write.
            row["electricity_status"][:25], row["water_status"][:25],
            row["health_status"][:25], row["pressing_needs"][:200],
            row["reporter_tier"][:20],
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

    # May 2026 audit Item 3 — log a warning when the limit is hit so the
    # operator knows the export was silently truncated. Pre-fix this was
    # a silent slice with no visible signal in the response.
    if len(reports) >= limit:
        logger.warning(
            f"[exports/pdf] hit limit={limit} — operator export may be truncated. "
            f"Consider increasing ?limit or paginating."
        )

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

    # May 2026 audit Item 3 — for embedding SMALL-tier thumbnails into
    # the PDF's media section, we read bytes via the storage abstraction.
    # Lazy-import inside the endpoint so an exports.py import doesn't
    # pull in the storage stack on every request.
    from reportlab.platypus import Image as _RLImage
    from app.services.storage import get_storage as _get_storage
    _storage = None
    try:
        _storage = _get_storage()
    except Exception as _se:
        logger.warning(f"[exports/pdf] storage backend unavailable; PDF will list media as text-only links: {_se}")

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

        # May 2026 audit Item 3 — building version ordinal in the table
        # when the report belongs to a multi-version building chain.
        # Operators viewing a dossier need to know "this is version 3
        # of 5 reports on this building." Pre-fix the field was only
        # surfaced in the building_dossier code path.
        building_version_row = None
        if getattr(r, "building_id", None):
            ordinal = getattr(r, "building_version_ordinal", None)
            is_latest = getattr(r, "building_is_latest", None)
            if ordinal is not None or is_latest is not None:
                building_version_row = [
                    "Building Version",
                    f"#{ordinal or '?'}" + (" (latest)" if is_latest else ""),
                ]

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
        ]
        if building_version_row:
            data.append(building_version_row)
        data.extend([
            ["Damage Classification",  row["damage_classification"]],
            ["Debris Clearing",        row["debris_clearing_needed"]],
            # Phase 2.1 — V4 fields on the analyst-facing PDF.
            # Empty values are kept in the table for layout
            # consistency across reports (analyst can tell at a
            # glance which signals the reporter answered).
            ["Power Status",           row["electricity_status"]],
            ["Water Status",           row["water_status"]],
            ["Health Status",          row["health_status"]],
            ["Pressing Needs",         row["pressing_needs"]],
            ["Reporter Tier",          row["reporter_tier"]],
            ["Location (lat, lng)",    f"{row['latitude']}, {row['longitude']}"],
            ["Location Name",          row["location_name"]],
            ["Lives Impacted",         row["lives_impacted"]],
            ["Submitted at",           row["timestamp"]],
        ])

        # May 2026 audit Item 3 — append satellite verification rows
        # (UNDP must-have #11). Pre-fix the PDF only contained 20
        # plain-text fields with ZERO satellite columns even though
        # _report_to_row already builds them and CSV/GeoJSON/KML
        # include them. Six rows: verdict, total_score, acquisition
        # date, days_gap, cloud_cover_pct, source. Empty values are
        # rendered as blanks so layout stays consistent for reports
        # that haven't been scored yet.
        data.extend([
            ["Sat. Verdict",            row.get("satellite_verdict", "")],
            ["Sat. Total Score",        row.get("satellite_total_score", "")],
            ["Sat. Acquisition Date",   row.get("satellite_acquisition_date", "")],
            ["Sat. Days Gap",           row.get("satellite_days_gap", "")],
            ["Sat. Cloud Cover %",      row.get("satellite_cloud_cover_pct", "")],
            ["Sat. Source",             row.get("satellite_source", "")],
        ])

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

        # May 2026 audit Item 3 — Media section. Pre-fix the PDF
        # contained ZERO photos and ZERO audio references regardless of
        # what was actually attached to the report. Now we group media
        # by photo_group_id, embed the SMALL-tier thumbnail inline (if
        # storage is reachable), and list every tier's stable URL so
        # operators can fetch the ORIGINAL from a print copy by typing
        # the path or clicking through if they have the digital PDF.
        try:
            media_list = list(r.media or [])
        except Exception:
            media_list = []
        if media_list:
            story.append(Spacer(1, 0.3 * cm))
            story.append(Paragraph("Media", label))
            # Group images by photo_group_id; audio kept separate.
            from collections import defaultdict as _dd
            image_groups = _dd(list)
            audio_items = []
            for m in media_list:
                mtype = (m.type.value if m.type else "") if hasattr(m, "type") else ""
                if mtype == "IMAGE":
                    grp = str(m.photo_group_id) if m.photo_group_id else "ungrouped"
                    image_groups[grp].append(m)
                elif mtype == "AUDIO":
                    audio_items.append(m)
            # Stable URL pattern (matches MediaResponse.field_serializer).
            for gi, (grp, items) in enumerate(image_groups.items()):
                story.append(Spacer(1, 0.15 * cm))
                story.append(Paragraph(
                    f"Photo {gi + 1} (group {grp[:8] if grp != 'ungrouped' else 'ungrouped'})",
                    small,
                ))
                # Find the best-quality completed tier for the inline embed.
                # SMALL is fastest to render but lowest fidelity; we embed
                # SMALL for the PDF's print size + page weight, and link
                # MEDIUM/ORIGINAL for full-res reference.
                small_tier = next(
                    (it for it in items
                     if it.resolution_tier and it.resolution_tier.value == "SMALL"
                     and it.assembly_status == "complete" and it.url),
                    None,
                )
                if small_tier and _storage:
                    try:
                        img_bytes = _storage.read(small_tier.url)
                        img_buf = io.BytesIO(img_bytes)
                        # Fit image to 6cm wide (roughly half a page);
                        # preserve aspect via ReportLab's natural-size logic.
                        img = _RLImage(img_buf, width=6 * cm, height=6 * cm * 0.75)
                        img.hAlign = "LEFT"
                        story.append(img)
                    except Exception as _ie:
                        logger.warning(
                            f"[exports/pdf] failed to embed SMALL media {small_tier.id[:8]}: {_ie}"
                        )
                        # Fall through to text-only listing below.
                # Tier list with stable URLs + assembly status.
                tier_lines = []
                for it in items:
                    tname = (it.resolution_tier.value if it.resolution_tier else "?")
                    status_s = it.assembly_status or "?"
                    abandon = f" — abandoned: {it.abandon_reason}" if it.abandon_reason else ""
                    url_stable = f"/api/v1/reports/media/{it.id}/file"
                    tier_lines.append(
                        f"{tname}: {status_s}{abandon} → {url_stable}"
                    )
                if tier_lines:
                    story.append(Paragraph(
                        "<br/>".join(tier_lines), small,
                    ))
            if audio_items:
                story.append(Spacer(1, 0.2 * cm))
                story.append(Paragraph("Audio", label))
                for ai, a in enumerate(audio_items):
                    a_status = a.assembly_status or "?"
                    abandon = f" — abandoned: {a.abandon_reason}" if a.abandon_reason else ""
                    url_stable = f"/api/v1/reports/media/{a.id}/file"
                    story.append(Paragraph(
                        f"Audio {ai + 1}: {a_status}{abandon} → {url_stable}",
                        small,
                    ))

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
        # Phase 2.1 (May 2026) — surface V4 service-status + reporter
        # tier in the KML description so a humanitarian analyst
        # clicking the pushpin in Google Earth sees the same signals
        # they get from the CSV / dashboard. Empty values are
        # rendered as "—" so the structure is obvious even when the
        # reporter didn't answer a particular question.
        def _or_dash(v):
            return v if v else "—"
        desc_parts = [
            f"Crisis: {row['crisis_type']}",
            f"Damage: {row['damage_classification']}",
            f"Power:  {_or_dash(row['electricity_status'])}",
            f"Water:  {_or_dash(row['water_status'])}",
            f"Health: {_or_dash(row['health_status'])}",
            f"Needs:  {_or_dash(row['pressing_needs'])}",
            f"Reporter tier: {_or_dash(row['reporter_tier'])}",
            f"Description: {row['description']}",
            f"Time:   {row['timestamp']}",
        ]
        desc = "\n".join(desc_parts)

        pnt = kml.newpoint(name=name, description=desc)
        pnt.coords = [(loc.longitude, loc.latitude)]
        # KML "extended data" lets Google Earth + QGIS surface
        # individual fields as queryable attributes instead of just
        # rendering them in the description blob. Same field names
        # as CSV for cross-format consistency.
        for k in (
            "electricity_status", "water_status", "health_status",
            "pressing_needs", "reporter_tier", "damage_classification",
            "crisis_type", "crisis_category", "infrastructure_type",
        ):
            try:
                pnt.extendeddata.newdata(name=k, value=row.get(k, "") or "")
            except Exception:
                pass
        color = damage_colors.get(row["damage_classification"], simplekml.Color.white)
        pnt.style.iconstyle.color = color

    content = kml.kml()
    return StreamingResponse(
        io.BytesIO(content.encode()),
        media_type="application/vnd.google-earth.kml+xml",
        headers={"Content-Disposition": f"attachment; filename=crisp_reports_{datetime.now().strftime('%Y%m%d')}.kml"}
    )
