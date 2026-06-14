"""Building dossier generators - Phase H.5.

Produces three operator-facing artefacts from a Building's joined view
of reports + intelligence scores + responders + notes + event timeline:

  build_dossier_pdf(...)     bytes  application/pdf
  build_dossier_geojson(...) dict   GeoJSON FeatureCollection
  build_dossier_csv(...)     str    text/csv - one row per Report,
                                    flat columns suitable for Excel /
                                    Sheets / pandas direct import

The PDF is intended for printing / hand-off to field teams - single-
page header followed by the report stack (one table per report). The
GeoJSON is intended for re-import into other GIS surfaces (ArcGIS,
QGIS) - each constituent report becomes a Feature with the building's
intelligence scores baked into properties.

Both surfaces RESPECT the same visibility gate that drives the
per-resource API endpoints - see callers in `app.api.endpoints.buildings`.
"""
from __future__ import annotations

import io
import json
from datetime import datetime, timezone
from typing import List, Optional, Tuple

from sqlalchemy import desc
from sqlalchemy.orm import Session

from app.models.report import (
    Building,
    BuildingEvent,
    BuildingMonitor,
    BuildingNote,
    BuildingResponder,
    Report,
    SatelliteVerification,
)


# ─── PDF generator ────────────────────────────────────────────────────
def build_dossier_pdf(db: Session, b: Building) -> bytes:
    """Render a single-building PDF dossier.

    Sections (in order):
      1. Cover - title + identity + state + intelligence scores grid
      2. Crisis-type + damage-class distribution
      3. Satellite verification roll-up
      4. Responder roster (assigned + lifecycle timestamps)
      5. Operator notes thread (newest-first)
      6. Per-report stack (one table per Report, severity-coded)
      7. Building event timeline (last 30 events)
    """
    # Lazy-imported so a missing reportlab wheel doesn't crash boot.
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import (
        SimpleDocTemplate,
        Paragraph,
        Spacer,
        PageBreak,
        Table,
        TableStyle,
    )
    from reportlab.lib import colors

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        leftMargin=2 * cm,
        rightMargin=2 * cm,
        topMargin=2 * cm,
        bottomMargin=2 * cm,
        title=f"CRISP Building Dossier - {b.id}",
        author="CRISP Platform",
    )
    styles = getSampleStyleSheet()
    h1 = styles["Heading1"]
    h2 = styles["Heading2"]
    h3 = styles["Heading3"]
    body = styles["BodyText"]
    small = ParagraphStyle("small", parent=body, fontSize=8, textColor=colors.grey)
    label = ParagraphStyle("label", parent=body, fontName="Helvetica-Bold", fontSize=9)

    # Pre-fetch the supporting relations.
    responders = (
        db.query(BuildingResponder)
        .filter(BuildingResponder.building_id == b.id)
        .order_by(desc(BuildingResponder.assigned_at))
        .all()
    )
    monitors = (
        db.query(BuildingMonitor)
        .filter(
            BuildingMonitor.building_id == b.id,
            BuildingMonitor.cleared_at.is_(None),
        )
        .all()
    )
    notes = (
        db.query(BuildingNote)
        .filter(
            BuildingNote.building_id == b.id,
            BuildingNote.deleted_at.is_(None),
        )
        .order_by(desc(BuildingNote.pinned), desc(BuildingNote.created_at))
        .all()
    )
    reports = (
        db.query(Report)
        .filter(
            Report.building_id == b.id,
            Report.deletion_requested_at.is_(None),
        )
        .order_by(desc(Report.server_created_at))
        .all()
    )
    sat_rows = (
        db.query(SatelliteVerification)
        .filter(SatelliteVerification.report_id.in_([r.id for r in reports]))
        .all()
    )
    events = (
        db.query(BuildingEvent)
        .filter(BuildingEvent.building_id == b.id)
        .order_by(desc(BuildingEvent.occurred_at))
        .limit(30)
        .all()
    )

    story: List = []

    # ── Cover block ──────────────────────────────────────────────────
    name = (
        b.osm_name
        or (b.osm_addr_full or "").strip()
        or (f"OSM way {b.osm_way_id}" if b.osm_way_id else None)
        or (f"Proximity cluster {b.id[:8]}" if b.id_source == "PROXIMITY" else b.id)
    )
    story.append(Paragraph(f"Building Dossier - {name}", h1))
    story.append(Paragraph(
        f"Generated at {datetime.now(timezone.utc).isoformat()} - "
        f"Building id <b>{b.id}</b> ({b.id_source})",
        small,
    ))
    story.append(Spacer(1, 0.3 * cm))

    # State + roll-up summary table.
    cover_rows = [
        ["State",                 b.state or ""],
        ["First report",          str(b.first_report_at or "")],
        ["Latest report",         str(b.latest_report_at or "")],
        ["State changed at",      str(b.state_changed_at or "-")],
        ["Reports (total)",       str(b.report_count or 0)],
        ["Reports - verified",    str(b.verified_report_count or 0)],
        ["Reports - responding",  str(b.responding_report_count or 0)],
        ["Reports - resolved",    str(b.resolved_report_count or 0)],
        ["Debris-clearing flags", str(b.debris_clearing_needed_count or 0)],
        ["Severity (max)",        b.severity_max or "-"],
        ["Damage class (max)",    b.damage_class_max or "-"],
        ["Crisis types (top 3)",  ", ".join(b.crisis_types_top3 or [])],
        ["Centroid (lat, lng)",   f"{b.centroid_lat}, {b.centroid_lng}"],
    ]
    cover_table = Table(cover_rows, colWidths=[5.5 * cm, None], hAlign="LEFT")
    cover_table.setStyle(TableStyle([
        ("FONTNAME",      (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE",      (0, 0), (-1, -1), 9),
        ("TEXTCOLOR",     (0, 0), (0, -1), colors.HexColor("#475569")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING",    (0, 0), (-1, -1), 4),
        ("LINEBELOW",     (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
    ]))
    story.append(cover_table)
    story.append(Spacer(1, 0.4 * cm))

    # ── Intelligence scores grid ─────────────────────────────────────
    story.append(Paragraph("Intelligence scores", h2))
    score_rows = [
        ["Severity score",        f"{b.severity_score:.1f}" if b.severity_score is not None else "-"],
        ["Confidence score",      f"{b.confidence_score:.1f}" if b.confidence_score is not None else "-"],
        ["Activity score",        f"{b.activity_score:.1f}" if b.activity_score is not None else "-"],
        ["Escalation risk",       f"{b.escalation_risk:.1f}" if b.escalation_risk is not None else "-"],
        ["Humanitarian priority", f"{b.humanitarian_priority:.1f}" if b.humanitarian_priority is not None else "-"],
    ]
    score_table = Table(score_rows, colWidths=[5.5 * cm, None], hAlign="LEFT")
    score_table.setStyle(TableStyle([
        ("FONTNAME",      (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE",      (0, 0), (-1, -1), 9),
        ("TEXTCOLOR",     (0, 0), (0, -1), colors.HexColor("#475569")),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING",    (0, 0), (-1, -1), 4),
        ("LINEBELOW",     (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
    ]))
    story.append(score_table)
    story.append(Spacer(1, 0.4 * cm))

    # ── Satellite verification roll-up ───────────────────────────────
    story.append(Paragraph("Satellite verification (across reports)", h3))
    total_scores = [s.total_score for s in sat_rows if s.total_score is not None]
    if sat_rows:
        mean = (sum(total_scores) / len(total_scores)) if total_scores else None
        latest = max(sat_rows, key=lambda s: s.scored_at or datetime.min)
        story.append(Paragraph(
            f"<b>{(mean or 0):.1f}/100</b> mean across {len(sat_rows)} verified report(s) - "
            f"latest verdict <b>{latest.verdict or '-'}</b>",
            body,
        ))
    else:
        story.append(Paragraph("No satellite verdicts on this building yet.", small))
    story.append(Spacer(1, 0.4 * cm))

    # ── Responder roster ─────────────────────────────────────────────
    story.append(Paragraph("Responder roster", h2))
    if responders:
        for r in responders:
            phase = (
                "CLEARED" if r.cleared_at
                else "ON-SITE" if r.arrived_at
                else "DISPATCHED" if r.dispatched_at
                else "ASSIGNED"
            )
            story.append(Paragraph(
                f"<b>{r.responder_name}</b> · {phase}"
                + (f" · {r.responder_org}" if r.responder_org else "")
                + (f" · {r.responder_contact}" if r.responder_contact else ""),
                body,
            ))
            details = []
            details.append(f"Assigned {r.assigned_at}")
            if r.dispatched_at: details.append(f"Dispatched {r.dispatched_at}")
            if r.arrived_at:    details.append(f"On-site {r.arrived_at}")
            if r.cleared_at:    details.append(f"Cleared {r.cleared_at}")
            if r.eta_minutes:   details.append(f"ETA {r.eta_minutes}m")
            story.append(Paragraph(" · ".join(details), small))
            if r.notes:
                story.append(Paragraph(r.notes, small))
            story.append(Spacer(1, 0.2 * cm))
    else:
        story.append(Paragraph("No responders assigned.", small))
    story.append(Spacer(1, 0.3 * cm))

    if monitors:
        story.append(Paragraph("Currently being monitored by:", h3))
        for m in monitors:
            story.append(Paragraph(
                f"User {m.user_id[:8]} - since {m.started_at}",
                small,
            ))
        story.append(Spacer(1, 0.3 * cm))

    # ── Operator notes ───────────────────────────────────────────────
    story.append(Paragraph("Operator notes", h2))
    if notes:
        for n in notes:
            head = (
                f"<b>{'★ PINNED · ' if n.pinned else ''}"
                f"{'(ADMIN-ONLY) ' if n.visibility == 'ADMIN_ONLY' else ''}"
                f"{n.created_at}</b>"
                + (f" · edited {n.edited_at}" if n.edited_at else "")
            )
            story.append(Paragraph(head, small))
            story.append(Paragraph(_escape_xml(n.body), body))
            story.append(Spacer(1, 0.2 * cm))
    else:
        story.append(Paragraph("No operator notes captured.", small))
    story.append(PageBreak())

    # ── Constituent reports ──────────────────────────────────────────
    story.append(Paragraph(f"Constituent reports ({len(reports)})", h2))
    story.append(Paragraph(
        "Newest-first. UNDP RAPIDA Appendix-1 aligned damage taxonomy "
        "(MINIMAL / PARTIAL / COMPLETE).",
        small,
    ))
    story.append(Spacer(1, 0.2 * cm))

    for i, r in enumerate(reports):
        if i > 0:
            story.append(Spacer(1, 0.4 * cm))
        story.append(Paragraph(
            f"Report {r.id[:8]} - {r.infrastructure_type or 'UNKNOWN'} / "
            f"{r.damage_classification or 'UNKNOWN'}",
            h3,
        ))
        data = [
            ["Source",           str(r.source or "")],
            ["Status",           str(r.status or "")],
            ["Severity",         str(r.severity or "")],
            ["Crisis Type",      str(r.crisis_type or "")],
            ["Damage",           str(r.damage_classification or "")],
            ["Server-received",  str(r.server_created_at or "")],
            ["Client-captured",  str(r.client_created_at or "")],
            ["Reviewer verdict", str(r.reviewer_verdict or "")],
            ["Dispatched at",    str(r.help_dispatched_at or "")],
            ["Arrived at",       str(r.help_arrived_at or "")],
            ["Version ordinal",  str(r.building_version_ordinal or "")],
            ["Latest version?",  "yes" if r.building_is_latest else "no"],
        ]
        table = Table(data, colWidths=[5 * cm, None], hAlign="LEFT")
        table.setStyle(TableStyle([
            ("FONTNAME",      (0, 0), (0, -1), "Helvetica-Bold"),
            ("FONTSIZE",      (0, 0), (-1, -1), 8.5),
            ("TEXTCOLOR",     (0, 0), (0, -1), colors.HexColor("#475569")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING",    (0, 0), (-1, -1), 3),
            ("LINEBELOW",     (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ]))
        story.append(table)
        if r.description:
            story.append(Spacer(1, 0.2 * cm))
            story.append(Paragraph("Description", label))
            story.append(Paragraph(_escape_xml(r.description), body))

    # ── Building event timeline ──────────────────────────────────────
    story.append(PageBreak())
    story.append(Paragraph("Building event timeline (last 30)", h2))
    if events:
        for e in events:
            payload_brief = ""
            if e.payload:
                payload_brief = " - " + ", ".join(
                    f"{k}={str(v)[:40]}" for k, v in (e.payload or {}).items()
                )
            story.append(Paragraph(
                f"<b>{e.occurred_at}</b> · {e.event_kind} ({e.actor_kind})"
                + payload_brief,
                body,
            ))
    else:
        story.append(Paragraph("No events recorded.", small))

    doc.build(story)
    return buf.getvalue()


# ─── GeoJSON generator ────────────────────────────────────────────────
def build_dossier_geojson(db: Session, b: Building) -> dict:
    """Render a single-building GeoJSON FeatureCollection.

    Each constituent Report becomes a Feature with its lat/lng + the
    building's intelligence scores + roll-ups baked into properties.
    If a cached footprint exists it appears as a separate Feature
    (geometry: Polygon).

    Designed to round-trip into QGIS / ArcGIS without information loss
    for downstream humanitarian-ops reporting.
    """
    from app.models.report import Location

    reports = (
        db.query(Report, Location)
        .outerjoin(Location, Location.report_id == Report.id)
        .filter(
            Report.building_id == b.id,
            Report.deletion_requested_at.is_(None),
        )
        .order_by(desc(Report.server_created_at))
        .all()
    )

    features: List[dict] = []

    # Cached footprint polygon, when present.
    if b.footprint_geojson:
        fg = b.footprint_geojson
        # Ensure it's a Feature; if it came in as a bare geometry promote it.
        if isinstance(fg, dict) and fg.get("type") == "Feature":
            feat = dict(fg)
            props = dict(feat.get("properties") or {})
            props.update({
                "kind": "building_footprint",
                "building_id": b.id,
                "building_name": b.osm_name,
                "building_state": b.state,
                "humanitarian_priority": b.humanitarian_priority,
                "severity_score": b.severity_score,
            })
            feat["properties"] = props
            features.append(feat)

    # One feature per report.
    for r, loc in reports:
        lat = (loc.latitude if loc else None) or b.centroid_lat
        lng = (loc.longitude if loc else None) or b.centroid_lng
        if lat is None or lng is None:
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [float(lng), float(lat)]},
            "properties": {
                "kind": "report",
                "report_id": r.id,
                "building_id": b.id,
                "building_state": b.state,
                "humanitarian_priority": b.humanitarian_priority,
                "severity_score_building": b.severity_score,
                "confidence_score_building": b.confidence_score,
                "activity_score_building": b.activity_score,
                "escalation_risk_building": b.escalation_risk,
                "source": str(r.source) if r.source else None,
                "status": str(r.status) if r.status else None,
                "severity": str(r.severity) if r.severity else None,
                "crisis_type": str(r.crisis_type) if r.crisis_type else None,
                "damage_classification": str(r.damage_classification) if r.damage_classification else None,
                "infrastructure_type": str(r.infrastructure_type) if r.infrastructure_type else None,
                "infrastructure_sub_type": str(r.infrastructure_sub_type) if r.infrastructure_sub_type else None,
                "debris_clearing_needed": r.debris_clearing_needed,
                "reviewer_verdict": str(r.reviewer_verdict) if r.reviewer_verdict else None,
                "server_created_at": r.server_created_at.isoformat() if r.server_created_at else None,
                "client_created_at": r.client_created_at.isoformat() if r.client_created_at else None,
                "help_dispatched_at": r.help_dispatched_at.isoformat() if r.help_dispatched_at else None,
                "help_arrived_at": r.help_arrived_at.isoformat() if r.help_arrived_at else None,
                "building_version_ordinal": r.building_version_ordinal,
                "building_is_latest": bool(r.building_is_latest),
            },
        })

    return {
        "type": "FeatureCollection",
        "metadata": {
            "generator": "CRISP Building Dossier H.5",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "building_id": b.id,
            "building_name": b.osm_name,
            "id_source": b.id_source,
            "state": b.state,
            "report_count": b.report_count,
            "humanitarian_priority": b.humanitarian_priority,
            "feature_count": len(features),
        },
        "features": features,
    }


# ─── CSV generator ────────────────────────────────────────────────────
def build_dossier_csv(db: Session, b: Building) -> str:
    """Render a building's constituent reports as a flat CSV.

    First row = a "building" meta line with the roll-up scores +
    intelligence so the document is self-describing. Subsequent
    rows = one per constituent Report with the full taxonomy +
    timestamps + reviewer state.

    Headers match the existing CSV exports' style (UNDP Appendix-1
    column names) so downstream pipelines that already consume
    `/exports/csv` can read building CSV with no schema delta.
    """
    import csv
    from io import StringIO
    from app.models.report import Location

    buf = StringIO()
    w = csv.writer(buf)

    # Building-level meta row (one row, prefixed BUILDING).
    w.writerow([
        "kind", "building_id", "id_source", "osm_name", "osm_addr_full",
        "state", "report_count", "verified_report_count",
        "responding_report_count", "resolved_report_count",
        "debris_clearing_needed_count",
        "severity_max", "damage_class_max",
        "severity_score", "confidence_score", "activity_score",
        "escalation_risk", "humanitarian_priority",
        "first_report_at", "latest_report_at",
        "centroid_lat", "centroid_lng",
        "crisis_types_top3", "exported_at",
    ])
    w.writerow([
        "BUILDING", b.id, b.id_source or "", b.osm_name or "",
        b.osm_addr_full or "", b.state or "",
        b.report_count or 0, b.verified_report_count or 0,
        b.responding_report_count or 0, b.resolved_report_count or 0,
        b.debris_clearing_needed_count or 0,
        b.severity_max or "", b.damage_class_max or "",
        f"{b.severity_score:.1f}" if b.severity_score is not None else "",
        f"{b.confidence_score:.1f}" if b.confidence_score is not None else "",
        f"{b.activity_score:.1f}" if b.activity_score is not None else "",
        f"{b.escalation_risk:.1f}" if b.escalation_risk is not None else "",
        f"{b.humanitarian_priority:.1f}" if b.humanitarian_priority is not None else "",
        b.first_report_at.isoformat() if b.first_report_at else "",
        b.latest_report_at.isoformat() if b.latest_report_at else "",
        b.centroid_lat or "", b.centroid_lng or "",
        "|".join(b.crisis_types_top3 or []),
        datetime.now(timezone.utc).isoformat(),
    ])

    # Blank separator row.
    w.writerow([])

    # Report-level header.
    w.writerow([
        "kind", "report_id", "source", "status", "severity",
        "crisis_type", "damage_classification",
        "infrastructure_type", "infrastructure_sub_type",
        "infrastructure_name", "debris_clearing_needed",
        "reviewer_verdict", "action_taken",
        "server_created_at", "client_created_at",
        "help_dispatched_at", "help_arrived_at",
        "building_version_ordinal", "building_is_latest",
        "lives_impacted", "latitude", "longitude",
        "location_name", "description",
    ])

    # Fetch constituent reports + locations in one go.
    rows = (
        db.query(Report, Location)
        .outerjoin(Location, Location.report_id == Report.id)
        .filter(
            Report.building_id == b.id,
            Report.deletion_requested_at.is_(None),
        )
        .order_by(desc(Report.server_created_at))
        .all()
    )

    # Strip the "EnumName." prefix off str(EnumValue) so the CSV reads
    # "APP" rather than "SourceEnum.APP" - friendlier for analysts
    # opening the file in Excel / pandas.
    def _enum_str(v):
        if v is None:
            return ""
        # SQLAlchemy Enum returns a Python enum instance; .value or
        # .name both give clean strings. Fall back to str() with a
        # final cleanup pass for any direct String(...) columns.
        if hasattr(v, "value"):
            return str(v.value)
        s = str(v)
        if "." in s and s.split(".")[0].endswith("Enum"):
            return s.split(".", 1)[1]
        return s

    for r, loc in rows:
        lat = (loc.latitude if loc else None) or b.centroid_lat or ""
        lng = (loc.longitude if loc else None) or b.centroid_lng or ""
        loc_name = (
            (loc.user_location_name if loc else None)
            or (loc.device_location_name if loc else None)
            or ""
        )
        # Squash newlines in description so the CSV stays single-row.
        # NOTE: variable name MUST NOT be `desc` - that shadows
        # `sqlalchemy.desc` for the entire function scope and makes
        # the earlier `.order_by(desc(...))` UnboundLocalError.
        descr = (r.description or "").replace("\n", " ").replace("\r", " ")[:1000]
        w.writerow([
            "REPORT", r.id,
            _enum_str(r.source),
            _enum_str(r.status),
            _enum_str(r.severity),
            _enum_str(r.crisis_type),
            _enum_str(r.damage_classification),
            _enum_str(r.infrastructure_type),
            _enum_str(r.infrastructure_sub_type),
            r.infrastructure_name or "",
            "yes" if r.debris_clearing_needed else
            ("no" if r.debris_clearing_needed is False else ""),
            _enum_str(r.reviewer_verdict),
            (r.action_taken or "")[:200],
            r.server_created_at.isoformat() if r.server_created_at else "",
            r.client_created_at.isoformat() if r.client_created_at else "",
            r.help_dispatched_at.isoformat() if r.help_dispatched_at else "",
            r.help_arrived_at.isoformat() if r.help_arrived_at else "",
            r.building_version_ordinal or "",
            "yes" if r.building_is_latest else "no",
            r.lives_impacted or "",
            lat, lng, loc_name, descr,
        ])

    return buf.getvalue()


# ─── Helpers ──────────────────────────────────────────────────────────
def _escape_xml(text: Optional[str]) -> str:
    """Escape ReportLab's mini-XML so user-supplied text doesn't break
    paragraph rendering. ReportLab paragraphs accept a small XML subset
    (b, i, font, …) - bare `<` / `>` / `&` confuse the parser."""
    if not text:
        return ""
    return (
        text
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )
