"""Standalone Building Assessment Report (PDF) - Building as a first-class
operational entity.

Distinct from the data dossier (building_dossier.py): this renders the consolidated
AI-assessment of a building - the building confidence roll-up + the per-incident
confidence breakdown + an AI recommendation + the satellite verification columns
(UNDP must-have #11) for the assessed representative reports.

build_assessment_pdf(db, building, assessment) -> bytes  (application/pdf)
"""
from __future__ import annotations

import io
from datetime import datetime, timezone
from typing import List

from sqlalchemy.orm import Session

from app.models.report import Building, BuildingAssessment, SatelliteVerification


def build_assessment_pdf(db: Session, b: Building, a: BuildingAssessment) -> bytes:
    """Render the Building Assessment Report. Lazy-imports reportlab so a missing
    wheel never crashes boot."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    )
    from reportlab.lib import colors

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=2 * cm, rightMargin=2 * cm, topMargin=2 * cm, bottomMargin=2 * cm,
        title=f"CRISP Building Assessment - {b.id}", author="CRISP Platform",
    )
    styles = getSampleStyleSheet()
    h1, h2, body = styles["Heading1"], styles["Heading2"], styles["BodyText"]
    small = ParagraphStyle("small", parent=body, fontSize=8, textColor=colors.grey)

    name = (
        b.osm_name or (b.osm_addr_full or "").strip()
        or (f"OSM way {b.osm_way_id}" if b.osm_way_id else None)
        or (f"Proximity cluster {b.id[:8]}" if b.id_source == "PROXIMITY" else b.id)
    )
    per_incident: List[dict] = list(a.per_incident or [])
    dist = a.distribution or {}

    story: List = []
    story.append(Paragraph(f"Building Assessment Report - {name}", h1))
    story.append(Paragraph(
        f"Assessed at {a.created_at.isoformat() if a.created_at else datetime.now(timezone.utc).isoformat()} "
        f"- Building id <b>{b.id}</b> ({b.id_source})", small,
    ))
    story.append(Spacer(1, 0.3 * cm))

    # ── Building confidence roll-up ──────────────────────────────────
    story.append(Paragraph("Building confidence", h2))
    score_txt = "Not assessed" if a.building_confidence_score is None \
        else f"{int(a.building_confidence_score)}/100  ({a.building_confidence_band})"
    roll_rows = [
        ["Building confidence", score_txt],
        ["Incidents", str(a.incident_count)],
        ["Assessed", str(a.assessed_count)],
        ["Cached / skipped", str(a.skipped_count)],
        ["Deferred (over cap)", str(a.queued_count)],
        ["Recommendation", a.recommendation or "-"],
    ]
    if dist:
        roll_rows.append(["Distribution", "  ".join(f"{k}:{v}" for k, v in dist.items() if v)])
    t = Table(roll_rows, colWidths=[5 * cm, 11 * cm])
    t.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.lightgrey),
    ]))
    story.append(t)
    story.append(Spacer(1, 0.4 * cm))

    # ── Per-incident assessment ──────────────────────────────────────
    story.append(Paragraph("Per-incident assessment", h2))
    inc_rows = [["Incident", "Severity", "Confidence", "Status"]]
    for p in per_incident:
        score = p.get("score")
        conf = "Unrated" if score is None else f"{int(score)} ({p.get('band')})"
        title = (p.get("title") or (p.get("incident_id") or p.get("report_id") or "")[:10])
        inc_rows.append([
            str(title)[:46], str(p.get("severity") or ""), conf,
            "cached" if p.get("cached") else "assessed",
        ])
    if len(inc_rows) == 1:
        inc_rows.append(["(no non-duplicate incidents to assess)", "", "", ""])
    it = Table(inc_rows, colWidths=[7.5 * cm, 2.5 * cm, 3.5 * cm, 2.5 * cm], repeatRows=1)
    it.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2c44")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f3f5f9")]),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.lightgrey),
    ]))
    story.append(it)
    story.append(Spacer(1, 0.4 * cm))

    # ── Satellite verification (UNDP must-have #11) ──────────────────
    story.append(Paragraph("Satellite verification", h2))
    rep_ids = [p.get("report_id") for p in per_incident if p.get("report_id")]
    sat_by_report = {}
    if rep_ids:
        for s in db.query(SatelliteVerification).filter(
                SatelliteVerification.report_id.in_(rep_ids)).all():
            sat_by_report[s.report_id] = s
    sat_rows = [["Incident", "Verdict", "Score", "Acq date", "Gap(d)", "Cloud%", "Source"]]
    for p in per_incident:
        s = sat_by_report.get(p.get("report_id"))
        title = str(p.get("title") or "")[:30]
        if s:
            sat_rows.append([
                title, (s.verdict or ""),
                ("" if s.total_score is None else str(s.total_score)),
                (s.satellite_acquisition_date or ""),
                ("" if s.satellite_days_gap is None else str(s.satellite_days_gap)),
                ("" if s.satellite_cloud_cover_pct is None else f"{s.satellite_cloud_cover_pct:.1f}"),
                (s.satellite_source or ""),
            ])
        else:
            sat_rows.append([title, "(not run)", "", "", "", "", ""])
    if len(sat_rows) == 1:
        sat_rows.append(["(none)", "", "", "", "", "", ""])
    st = Table(sat_rows, colWidths=[4.2 * cm, 2.6 * cm, 1.6 * cm, 2.4 * cm, 1.4 * cm, 1.6 * cm, 2.2 * cm], repeatRows=1)
    st.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2c44")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 7),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.25, colors.lightgrey),
    ]))
    story.append(st)

    doc.build(story)
    return buf.getvalue()
