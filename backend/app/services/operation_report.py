"""Multi-section Operation Summary PDF (one operation = one CrisisEvent).

Mirrors the building dossier (`building_dossier.build_dossier_pdf`) + the bulk
report PDF (`exports.py`) so the Global / Operation / Building / Incident reporting
stack is visually consistent. Sections:

  1. Cover - operation identity, health, zone, window, form pack
  2. Report roll-up (totals by lifecycle)
  3. Severity distribution
  4. Status distribution
  5. Top buildings (worst-first by humanitarian priority)
  6. Top incidents (by report count)
  7. Satellite verification summary
  8. Form configuration (the active crisis-pack schema)
  9. Recent activity (latest reports)

Scale-safe (must-have #12): aggregates use grouped COUNT/AVG queries; the lists are
bounded top-N - never loads every report of a 500k-report operation into memory.
"""
from __future__ import annotations

import io
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models.report import (
    Report, Building, Incident, CrisisFormPack, CrisisFormPackVersion,
    SatelliteVerification,
)


def _fmt(v) -> str:
    return "-" if v is None or v == "" else str(v)


def build_operation_report_pdf(db: Session, op) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    )
    from reportlab.lib import colors

    NOT_DELETED = Report.deletion_requested_at.is_(None)
    OP = Report.crisis_event_id == op.id

    # ── Scale-safe aggregates ─────────────────────────────────────────────
    status_counts = {
        (k.value if hasattr(k, "value") else str(k)): n
        for k, n in db.query(Report.status, func.count()).filter(OP, NOT_DELETED).group_by(Report.status).all()
    }
    sev_counts = {
        (k.value if hasattr(k, "value") else str(k)): n
        for k, n in db.query(Report.severity, func.count()).filter(OP, NOT_DELETED).group_by(Report.severity).all()
    }
    total = sum(status_counts.values())
    verified = db.query(func.count()).filter(OP, NOT_DELETED, Report.reviewer_verdict == "ACCEPTED").scalar() or 0
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    new_24h = db.query(func.count()).filter(OP, NOT_DELETED, Report.server_created_at >= cutoff).scalar() or 0
    incident_count = db.query(func.count()).filter(Incident.crisis_event_id == op.id).scalar() or 0

    # Top buildings (worst-first by humanitarian priority), bounded.
    bld_ids = [row[0] for row in db.query(Report.building_id)
               .filter(OP, NOT_DELETED, Report.building_id.isnot(None)).distinct().limit(2000).all()]
    top_buildings = (db.query(Building).filter(Building.id.in_(bld_ids))
                     .order_by(Building.humanitarian_priority.desc().nullslast()).limit(10).all()
                     ) if bld_ids else []

    top_incidents = (db.query(Incident).filter(Incident.crisis_event_id == op.id)
                     .order_by(Incident.report_count.desc().nullslast()).limit(10).all())

    sat_join = db.query(SatelliteVerification).join(Report, SatelliteVerification.report_id == Report.id).filter(OP)
    sat_count = sat_join.count()
    sat_mean = (db.query(func.avg(SatelliteVerification.total_score))
                .join(Report, SatelliteVerification.report_id == Report.id)
                .filter(OP, SatelliteVerification.total_score.isnot(None)).scalar())
    latest_sat = sat_join.order_by(SatelliteVerification.scored_at.desc().nullslast()).first()

    recent = (db.query(Report).filter(OP, NOT_DELETED)
              .order_by(Report.server_created_at.desc()).limit(10).all())

    # Form pack (active version schema).
    schema = None
    pack_title = None
    pack_version = None
    if getattr(op, "form_pack_id", None):
        pack = db.query(CrisisFormPack).filter(CrisisFormPack.id == op.form_pack_id).first()
        if pack:
            pack_title = pack.title
            if pack.active_version:
                pv = (db.query(CrisisFormPackVersion)
                      .filter(CrisisFormPackVersion.pack_id == pack.id,
                              CrisisFormPackVersion.version == pack.active_version).first())
                if pv:
                    schema = pv.schema_json
                    pack_version = pv.version

    # ── Document ──────────────────────────────────────────────────────────
    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=2 * cm, rightMargin=2 * cm,
                            topMargin=2 * cm, bottomMargin=2 * cm,
                            title=f"CRISP Operation Report - {op.id}", author="CRISP Platform")
    styles = getSampleStyleSheet()
    h1, h2, h3, body = styles["Heading1"], styles["Heading2"], styles["Heading3"], styles["BodyText"]
    small = ParagraphStyle("small", parent=body, fontSize=8, textColor=colors.grey)

    def _kv_table(rows):
        t = Table(rows, colWidths=[5.5 * cm, None], hAlign="LEFT")
        t.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#475569")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ]))
        return t

    def _grid(header, rows):
        t = Table([header] + rows, hAlign="LEFT")
        t.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ]))
        return t

    story: List = []

    # 1. Cover
    story.append(Paragraph(f"Operation Report - {_fmt(op.name)}", h1))
    story.append(Paragraph(
        f"Generated at {datetime.now(timezone.utc).isoformat()} - Operation id <b>{op.id}</b>", small))
    story.append(Spacer(1, 0.3 * cm))
    started = getattr(op, "started_at", None)
    ended = getattr(op, "ended_at", None)
    story.append(_kv_table([
        ["Status", _fmt(getattr(op, "status", None) or ("LIVE" if getattr(op, "is_active", False) else "ENDED"))],
        ["Crisis type", _fmt(getattr(op, "crisis_type", None))],
        ["Health", _fmt(getattr(op, "health", None)) + (f" - {op.health_reason}" if getattr(op, "health_reason", None) else "")],
        ["Place", _fmt(getattr(op, "place_name", None))],
        ["Zone (center)", f"{getattr(op, 'center_lat', '-')}, {getattr(op, 'center_lng', '-')}  (r={getattr(op, 'radius_km', '-')} km)"],
        ["Window", f"{_fmt(started)}  ->  {_fmt(ended) if ended else 'open'}"],
        ["Form pack", f"{_fmt(pack_title)}" + (f" (v{pack_version})" if pack_version else "")],
        ["Responders active", _fmt(getattr(op, "responders_active", None))],
    ]))
    story.append(Spacer(1, 0.4 * cm))

    # 2. Report roll-up
    story.append(Paragraph("Report roll-up", h2))
    story.append(_kv_table([
        ["Total reports", str(total)],
        ["Verified (analyst-accepted)", str(verified)],
        ["Pending", str(status_counts.get("PENDING", 0) + status_counts.get("VERIFIED", 0))],
        ["In response", str(status_counts.get("RESPONDING", 0))],
        ["Resolved / false-alarm", str(status_counts.get("RESOLVED", 0) + status_counts.get("FALSE_ALARM", 0))],
        ["New (last 24h)", str(new_24h)],
        ["Incidents", str(incident_count)],
    ]))
    story.append(Spacer(1, 0.4 * cm))

    # 3. Severity distribution
    story.append(Paragraph("Severity distribution", h3))
    story.append(_grid(["Severity", "Reports"],
                       [[s, str(sev_counts.get(s, 0))] for s in ("CRITICAL", "SEVERE", "MODERATE", "MINOR", "UNKNOWN")]))
    story.append(Spacer(1, 0.35 * cm))

    # 4. Status distribution
    story.append(Paragraph("Status distribution", h3))
    story.append(_grid(["Status", "Reports"],
                       [[k, str(v)] for k, v in sorted(status_counts.items())] or [["-", "0"]]))
    story.append(Spacer(1, 0.4 * cm))

    # 5. Top buildings
    story.append(Paragraph("Top buildings (worst-first)", h2))
    if top_buildings:
        rows = [[(_fmt(b.osm_name or b.osm_addr_full or b.id[:8])),
                 _fmt(b.severity_max), str(b.report_count or 0),
                 (f"{b.humanitarian_priority:.0f}" if b.humanitarian_priority is not None else "-")]
                for b in top_buildings]
        story.append(_grid(["Building", "Severity", "Reports", "Priority"], rows))
    else:
        story.append(Paragraph("No buildings linked to this operation yet.", small))
    story.append(Spacer(1, 0.4 * cm))

    # 6. Top incidents
    story.append(Paragraph("Top incidents (by report count)", h2))
    if top_incidents:
        rows = [[_fmt(i.title or i.id[:8]), _fmt(i.incident_type), _fmt(i.status),
                 _fmt(i.severity), str(i.report_count or 0)] for i in top_incidents]
        story.append(_grid(["Incident", "Type", "Status", "Severity", "Reports"], rows))
    else:
        story.append(Paragraph("No incidents in this operation yet.", small))
    story.append(Spacer(1, 0.4 * cm))

    # 7. Satellite verification summary
    story.append(Paragraph("Satellite verification", h3))
    if sat_count:
        story.append(Paragraph(
            f"<b>{(sat_mean or 0):.1f}/100</b> mean across {sat_count} verified report(s)"
            + (f" - latest verdict <b>{latest_sat.verdict or '-'}</b>" if latest_sat else ""), body))
    else:
        story.append(Paragraph("No satellite verdicts in this operation yet.", small))
    story.append(Spacer(1, 0.4 * cm))

    # 8. Form configuration
    story.append(Paragraph("Form configuration", h2))
    if isinstance(schema, dict) and schema.get("sections"):
        for sec in schema.get("sections", []):
            fields = sec.get("fields", []) or []
            story.append(Paragraph(
                f"<b>{_fmt(sec.get('title') or sec.get('id'))}</b> (stage {sec.get('stage', '-')}) - {len(fields)} field(s)", body))
            rows = [[_fmt(f.get("label") or f.get("key")), _fmt(f.get("type")),
                     "yes" if f.get("required") else "no",
                     ", ".join((f.get("channels") or [])) or "all"] for f in fields]
            if rows:
                story.append(_grid(["Field", "Type", "Required", "Channels"], rows))
            story.append(Spacer(1, 0.2 * cm))
    else:
        story.append(Paragraph("No crisis-form pack is bound to this operation.", small))
    story.append(Spacer(1, 0.4 * cm))

    # 9. Recent activity
    story.append(Paragraph("Recent activity (latest reports)", h3))
    if recent:
        rows = [[r.id[:8], _fmt(getattr(r.severity, "value", r.severity)),
                 _fmt(getattr(r.status, "value", r.status)),
                 _fmt(r.server_created_at.isoformat() if r.server_created_at else "")] for r in recent]
        story.append(_grid(["Report", "Severity", "Status", "Submitted"], rows))
    else:
        story.append(Paragraph("No reports yet.", small))

    doc.build(story)
    return buf.getvalue()
