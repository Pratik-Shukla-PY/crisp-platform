"""
Data Export Endpoints — CSV (HXL-tagged), GeoJSON, Shapefile, KML, PDF,
analytics summary/sitrep, per-report evidence bundles, plus count /
data-dictionary / recent-exports support endpoints.
For UNDP judges, GIS tool integration, and humanitarian data sharing.
"""
import csv
import io
import json
import logging
import re
import zipfile
from datetime import datetime, timezone
from typing import Optional
from xml.sax.saxutils import escape as _xml_escape

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session, joinedload, selectinload

from app.core.deps import require_viewer
from app.db.session import get_db
from app.models.report import Report, Location

logger = logging.getLogger(__name__)
router = APIRouter()


def _utc_date_stamp() -> str:
    """Filename date stamp — UTC, not server-local (a 2am IST export was
    getting the previous day's date)."""
    return datetime.now(timezone.utc).strftime("%Y%m%d")


def _parse_iso(value: str, param: str) -> datetime:
    """ISO-8601 parse that FAILS LOUDLY. The old behaviour swallowed
    ValueError and silently dropped the filter — an analyst typing a typo'd
    date got the FULL dataset labelled as a filtered one."""
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail=f"Invalid ISO-8601 datetime for '{param}': {value!r}",
        )


def _query_reports(db: Session, status: Optional[str], crisis_type: Optional[str],
                   since: Optional[str], until: Optional[str],
                   severity: Optional[str] = None, bbox: Optional[str] = None,
                   crisis_event_id: Optional[str] = None):
    """Shared query builder for all export endpoints. Returns the QUERY so
    callers can count() or iterate. Eager-loads the per-report relations
    every format consumes (location, verification, media) — the old lazy
    loading was an N+1 per row."""
    q = (
        db.query(Report)
        .options(
            joinedload(Report.location),
            joinedload(Report.verification),
            selectinload(Report.media),
        )
        .filter(Report.deletion_requested_at.is_(None))
    )
    if status:
        # Comma-separated list supported so the dashboard's composite
        # "Active" view (PENDING+VERIFIED) exports exactly what it shows.
        statuses = [s.strip() for s in status.split(",") if s.strip()]
        q = q.filter(Report.status.in_(statuses)) if len(statuses) > 1 \
            else q.filter(Report.status == statuses[0])
    if crisis_type:
        q = q.filter(Report.crisis_type == crisis_type)
    if crisis_event_id:
        # Operation-scoped export — the operation IS a CrisisEvent. Lets the
        # dashboard export exactly the reports of one operation (was missing, so
        # exporting from inside an operation silently downloaded every report).
        q = q.filter(Report.crisis_event_id == crisis_event_id)
    if severity:
        q = q.filter(Report.severity == severity)
    if since:
        q = q.filter(Report.server_created_at >= _parse_iso(since, "since"))
    if until:
        q = q.filter(Report.server_created_at <= _parse_iso(until, "until"))
    if bbox:
        # bbox=minLng,minLat,maxLng,maxLat (GeoJSON axis order).
        try:
            min_lng, min_lat, max_lng, max_lat = [float(x) for x in bbox.split(",")]
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=422,
                detail=f"Invalid bbox (want 'minLng,minLat,maxLng,maxLat'): {bbox!r}",
            )
        q = q.join(Location, Location.report_id == Report.id).filter(
            Location.longitude >= min_lng, Location.longitude <= max_lng,
            Location.latitude >= min_lat, Location.latitude <= max_lat,
        )
    return q.order_by(Report.server_created_at.desc())


def _build_tier_map(db: Session, reports) -> dict:
    """Bulk device_id → reporter-tier map. Replaces the old per-row double
    query (2 × N) with two set-based queries total."""
    from app.models.report import Device, ReporterProfile
    device_ids = {r.device_id for r in reports if r.device_id}
    if not device_ids:
        return {}
    devices = db.query(Device.id, Device.device_hash).filter(Device.id.in_(device_ids)).all()
    hash_by_dev = {d.id: d.device_hash for d in devices if d.device_hash}
    if not hash_by_dev:
        return {}
    profiles = (
        db.query(ReporterProfile.device_hash, ReporterProfile.badge_level)
        .filter(ReporterProfile.device_hash.in_(set(hash_by_dev.values())))
        .all()
    )
    valid = {"T1_SCOUT", "T2_SIGNAL", "T3_CHANGEMAKER", "T4_LIFEKEEPER"}
    tier_by_hash = {p.device_hash: p.badge_level for p in profiles if p.badge_level in valid}
    return {dev_id: tier_by_hash.get(h, "") for dev_id, h in hash_by_dev.items()}


def _fetch_export_rows(db: Session, status, crisis_type, since, until,
                       severity=None, bbox=None, limit: Optional[int] = None,
                       crisis_event_id=None):
    """Run the export query and flatten to plain row dicts (no ORM refs held).
    Returns (rows, total) where total is the pre-limit match count so
    truncation is never silent."""
    q = _query_reports(db, status, crisis_type, since, until, severity, bbox,
                       crisis_event_id=crisis_event_id)
    reports = q.limit(limit).all() if limit else q.all()
    total = q.order_by(None).count() if limit else len(reports)
    tier_map = _build_tier_map(db, reports)
    rows = [_report_to_row(r, tier_map) for r in reports]
    return rows, total, reports


def _audit_export(db: Session, user, request: Optional[Request], fmt: str,
                  filters: dict, row_count: int) -> None:
    """Provenance record: who exported what dataset, when (humanitarian-data
    accountability; the building dossier already logs DOSSIER_EXPORTED —
    this extends the same discipline to bulk exports). Never lets audit
    failure break an export."""
    try:
        from app.api.endpoints.auth import _audit
        _audit(
            db, getattr(user, "id", None), getattr(user, "email", ""),
            "EXPORT", request,
            resource_type="export",
            details={"format": fmt, "row_count": row_count,
                     "filters": {k: v for k, v in (filters or {}).items() if v}},
        )
        db.commit()
    except Exception:
        logger.exception("export audit log failed (format=%s)", fmt)


def _report_to_row(r, tier_map: Optional[dict] = None):
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
    # Bulk-prefetched device_id → tier map (see _build_tier_map). The old
    # per-row implementation issued TWO queries per report (N+1 audit
    # finding, Jun 2026); a 10k-row export ran 20k extra queries.
    reporter_tier = (tier_map or {}).get(r.device_id, "") if r.device_id else ""

    # ── Jun 2026 metadata additions (export audit) ────────────────────
    # Appended columns — the schema is append-only so existing consumers
    # keep working by name. These were all DERIVABLE-BUT-OMITTED: the
    # values existed on the models but never reached any export.
    def _iso(dt):
        return dt.isoformat() if dt else ""
    media_list = []
    try:
        media_list = list(r.media or [])
    except Exception:
        media_list = []
    media_count = len(media_list)
    first_photo_url = ""
    for m in media_list:
        mtype = (m.type.value if getattr(m, "type", None) else "")
        if mtype == "IMAGE" and getattr(m, "assembly_status", "") == "complete":
            first_photo_url = f"/api/v1/reports/media/{m.id}/thumb"
            break
    location_source = ""
    if loc:
        location_source = "user_corrected" if getattr(loc, "is_user_corrected", False) else "device_gps"

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
        # Newlines flattened for spreadsheet sanity; commas PRESERVED — the
        # csv module quotes properly now (the old hand-rolled writer forced
        # `,`→`;` mangling, silently rewriting user testimony).
        "description": (r.description or "").replace("\n", " "),
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
        # ── Jun 2026 appended metadata (export audit) ──────────────────
        # Offline chronology: client capture time alongside server receipt.
        "client_created_at": _iso(r.client_created_at),
        # GPS quality + provenance — humanitarian IM officers weight point
        # reliability by horizontal accuracy and whether a human corrected
        # the pin.
        "accuracy_m": (str(loc.accuracy_meters) if loc and loc.accuracy_meters is not None else ""),
        "location_source": location_source,
        "infra_name_from_osm": (
            str(r.infrastructure_name_from_osm)
            if getattr(r, "infrastructure_name_from_osm", None) is not None else ""
        ),
        # Review / response audit trail.
        "reviewer_verdict": getattr(r, "reviewer_verdict", "") or "",
        "reviewed_at": _iso(getattr(r, "reviewed_at", None)),
        "help_dispatched_at": _iso(getattr(r, "help_dispatched_at", None)),
        "help_arrived_at": _iso(getattr(r, "help_arrived_at", None)),
        # Crisis-event linkage + comms planning.
        "crisis_event_id": getattr(r, "crisis_event_id", "") or "",
        "detected_language": getattr(r, "detected_language", "") or "",
        # Media presence (no bytes — stable thumb URL for the first photo).
        "media_count": str(media_count),
        "first_photo_url": first_photo_url,
    }


# ── CSV Export ────────────────────────────────────────────────────────────────

# Canonical export column order, shared by CSV (and mirrored in GeoJSON
# properties). APPEND-ONLY: downstream consumers key on names.
EXPORT_HEADERS = [
    "id", "client_report_id", "source", "status", "severity",
    "infrastructure_type", "infrastructure_sub_type", "infrastructure_name",
    "damage_classification", "crisis_type", "crisis_category",
    "description", "debris_clearing_needed", "service_status",
    # Phase 2.1 (May 2026) — UNDP analyst-friendly flat V4 columns.
    "electricity_status", "water_status", "health_status",
    "pressing_needs", "reporter_tier",
    "building_id", "latitude", "longitude", "location_name",
    "lives_impacted", "timestamp",
    # Satellite verification columns (UNDP must-have #11).
    "satellite_verdict", "satellite_total_score",
    "satellite_acquisition_date", "satellite_days_gap",
    "satellite_cloud_cover_pct", "satellite_source",
    # Jun 2026 appended metadata (export audit).
    "client_created_at", "accuracy_m", "location_source",
    "infra_name_from_osm", "reviewer_verdict", "reviewed_at",
    "help_dispatched_at", "help_arrived_at", "crisis_event_id",
    "detected_language", "media_count", "first_photo_url",
]

# HXL hashtag row (https://hxlstandard.org) — the HDX convention puts the
# tags on row 2, under the human-readable headers. HXL-aware tools (HDX,
# Quick Charts, hxl-proxy) auto-detect them; everything else treats the row
# as one extra data row. Blank where no standard tag fits.
HXL_TAGS = {
    "id": "#meta+id", "source": "#meta+channel", "status": "#status",
    "severity": "#severity", "infrastructure_type": "#infrastructure+type",
    "infrastructure_name": "#infrastructure+name",
    "damage_classification": "#impact+type", "crisis_type": "#event+type",
    "crisis_category": "#event+category", "description": "#description",
    "building_id": "#infrastructure+building+id",
    "latitude": "#geo+lat", "longitude": "#geo+lon",
    "location_name": "#loc+name", "lives_impacted": "#affected",
    "timestamp": "#date+reported", "client_created_at": "#date+occurred",
    "detected_language": "#meta+lang", "crisis_event_id": "#event+id",
}

_NUMERIC_RE = re.compile(r"-?\d+(\.\d+)?")


def _csv_cell(value) -> str:
    """Spreadsheet formula-injection guard: a leading = + - @ makes Excel /
    Sheets execute the cell. Prefix a quote — except for plain numbers
    (negative latitudes/longitudes must stay numeric)."""
    s = "" if value is None else str(value)
    if s[:1] in ("=", "+", "-", "@") and not _NUMERIC_RE.fullmatch(s):
        return "'" + s
    return s


@router.get("/csv")
def export_csv(
    request: Request,
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    crisis_type: Optional[str] = Query(None),
    crisis_event_id: Optional[str] = Query(None, description="Scope to one operation (CrisisEvent id)"),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    bbox: Optional[str] = Query(None, description="minLng,minLat,maxLng,maxLat"),
    hxl: bool = Query(True, description="Include the HXL hashtag row (row 2)"),
):
    """Export reports as CSV (proper RFC-4180 quoting via the csv module —
    the old hand-rolled f'\"{v}\"' writer corrupted any field containing a
    double quote), with an HXL hashtag row for HDX interoperability and a
    formula-injection guard."""
    rows, total, _ = _fetch_export_rows(db, status, crisis_type, since, until, severity, bbox, crisis_event_id=crisis_event_id)
    _audit_export(db, user, request, "csv",
                  {"status": status, "crisis_type": crisis_type, "since": since,
                   "until": until, "severity": severity, "bbox": bbox},
                  len(rows))

    def generate():
        buf = io.StringIO()
        w = csv.writer(buf, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
        w.writerow(EXPORT_HEADERS)
        if hxl:
            w.writerow([HXL_TAGS.get(h, "") for h in EXPORT_HEADERS])
        yield buf.getvalue()
        buf.seek(0); buf.truncate(0)
        for row in rows:
            w.writerow([_csv_cell(row.get(h, "")) for h in EXPORT_HEADERS])
            yield buf.getvalue()
            buf.seek(0); buf.truncate(0)

    return StreamingResponse(
        generate(),
        media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=crisp_reports_{_utc_date_stamp()}.csv"}
    )


# ── GeoJSON Export ────────────────────────────────────────────────────────────

@router.get("/geojson")
def export_geojson(
    request: Request,
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    crisis_type: Optional[str] = Query(None),
    crisis_event_id: Optional[str] = Query(None, description="Scope to one operation (CrisisEvent id)"),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    bbox: Optional[str] = Query(None, description="minLng,minLat,maxLng,maxLat"),
):
    """Export reports as a GeoJSON FeatureCollection. Reports without a
    Location row can't be point features — they are counted in the foreign
    `metadata` member instead of silently vanishing."""
    rows, total, reports = _fetch_export_rows(db, status, crisis_type, since, until, severity, bbox, crisis_event_id=crisis_event_id)
    features = []
    dropped_no_location = 0
    for r, row in zip(reports, rows):
        loc = r.location
        if not loc:
            dropped_no_location += 1
            continue
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [loc.longitude, loc.latitude]},
            "properties": {k: v for k, v in row.items() if k not in ("latitude", "longitude")},
        })

    geojson = {
        "type": "FeatureCollection",
        # Foreign member (RFC 7946 §6.1 allows them): self-describing
        # provenance so a file found on disk a month later still says what
        # it contains and what was omitted.
        "metadata": {
            "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "feature_count": len(features),
            "dropped_no_location": dropped_no_location,
            "filters": {k: v for k, v in {
                "status": status, "crisis_type": crisis_type, "since": since,
                "until": until, "severity": severity, "bbox": bbox,
            }.items() if v},
        },
        "features": features,
    }
    _audit_export(db, user, request, "geojson",
                  {"status": status, "crisis_type": crisis_type, "since": since,
                   "until": until, "severity": severity, "bbox": bbox},
                  len(features))
    content = json.dumps(geojson, indent=2)
    return StreamingResponse(
        io.BytesIO(content.encode()),
        media_type="application/geo+json",
        headers={"Content-Disposition": f"attachment; filename=crisp_reports_{_utc_date_stamp()}.geojson"}
    )


# ── Shapefile Export ──────────────────────────────────────────────────────────

@router.get("/shapefile")
def export_shapefile(
    request: Request,
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    crisis_type: Optional[str] = Query(None),
    crisis_event_id: Optional[str] = Query(None, description="Scope to one operation (CrisisEvent id)"),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    bbox: Optional[str] = Query(None, description="minLng,minLat,maxLng,maxLat"),
):
    """Export all reports as Shapefile (.shp/.shx/.dbf/.prj) in a ZIP."""
    import shapefile

    rows_all, total, reports = _fetch_export_rows(db, status, crisis_type, since, until, severity, bbox, crisis_event_id=crisis_event_id)
    row_by_id = {row["id"]: row for row in rows_all}

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
    # Jun 2026 (export audit) — satellite verification columns. Their
    # absence violated UNDP must-have #11 ("CSV/GeoJSON/Shapefile/KML
    # always include the 6 satellite verification columns"); the Shapefile
    # was the only bulk format missing them. DBF caps names at 10 chars.
    w.field("SAT_VERD", "C", 30)
    w.field("SAT_SCORE", "C", 10)
    w.field("SAT_ACQ", "C", 30)
    w.field("SAT_GAP", "C", 10)
    w.field("SAT_CLOUD", "C", 10)
    w.field("SAT_SRC", "C", 40)

    for r in reports:
        loc = r.location
        if not loc:
            continue
        row = row_by_id[r.id]
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
            # Satellite verification (must-have #11).
            row["satellite_verdict"][:30], row["satellite_total_score"][:10],
            row["satellite_acquisition_date"][:30], row["satellite_days_gap"][:10],
            row["satellite_cloud_cover_pct"][:10], row["satellite_source"][:40],
        )

    w.close()
    _audit_export(db, user, request, "shapefile",
                  {"status": status, "crisis_type": crisis_type, "since": since,
                   "until": until, "severity": severity, "bbox": bbox},
                  len(reports))

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
        headers={"Content-Disposition": f"attachment; filename=crisp_reports_{_utc_date_stamp()}.zip"}
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
    request: Request,
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    crisis_type: Optional[str] = Query(None),
    crisis_event_id: Optional[str] = Query(None, description="Scope to one operation (CrisisEvent id)"),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    bbox: Optional[str] = Query(None, description="minLng,minLat,maxLng,maxLat"),
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

    rows_all, total, reports = _fetch_export_rows(
        db, status, crisis_type, since, until, severity, bbox, limit=limit,
        crisis_event_id=crisis_event_id)
    row_by_id = {row["id"]: row for row in rows_all}
    truncated = total > len(reports)
    if truncated:
        logger.warning(
            f"[exports/pdf] hit limit={limit} (total={total}) — export truncated."
        )
    _audit_export(db, user, request, "pdf",
                  {"status": status, "crisis_type": crisis_type, "since": since,
                   "until": until, "severity": severity, "bbox": bbox, "limit": limit},
                  len(reports))

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
        f"Generated at {datetime.now(timezone.utc).isoformat().replace('+00:00', '')}Z "
        f"— {len(reports)} of {total} matching report(s) included.",
        small,
    ))
    if truncated:
        # Jun 2026 (export audit) — truncation must be VISIBLE in the
        # artifact, not just a server log line the operator never sees.
        warn_style = ParagraphStyle(
            "warn", parent=small, textColor=colors.HexColor("#b45309"),
            fontName="Helvetica-Bold",
        )
        story.append(Paragraph(
            f"NOTE: result truncated at limit={limit} — {total - len(reports)} matching "
            f"report(s) are NOT in this document. Narrow the filters or raise ?limit (max 1000).",
            warn_style,
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
        row = row_by_id[r.id]
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
            ["Captured at (client)",   row.get("client_created_at", "")],
            ["Submitted at",           row["timestamp"]],
            # Jun 2026 — review/response audit trail on the dossier.
            ["Reviewer Verdict",       row.get("reviewer_verdict", "")],
            ["Reviewed at",            row.get("reviewed_at", "")],
            ["Help Dispatched at",     row.get("help_dispatched_at", "")],
            ["Help Arrived at",        row.get("help_arrived_at", "")],
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
            # _xml_escape: ReportLab Paragraph parses XML-ish markup; raw
            # '&' / '<' in citizen text broke rendering (Jun 2026 audit).
            story.append(Paragraph(_xml_escape(r.description), body))

        if r.service_status:
            story.append(Spacer(1, 0.3 * cm))
            story.append(Paragraph("Service status", label))
            for k, v in (r.service_status or {}).items():
                story.append(Paragraph(_xml_escape(f"{k}: {v}"), body))

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
                f"attachment; filename=crisp_reports_{_utc_date_stamp()}.pdf"
        },
    )


# ── KML Export ────────────────────────────────────────────────────────────────

@router.get("/kml")
def export_kml(
    request: Request,
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    crisis_type: Optional[str] = Query(None),
    crisis_event_id: Optional[str] = Query(None, description="Scope to one operation (CrisisEvent id)"),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    bbox: Optional[str] = Query(None, description="minLng,minLat,maxLng,maxLat"),
):
    """Export all reports as KML for Google Earth."""
    import simplekml

    rows_all, total, reports = _fetch_export_rows(db, status, crisis_type, since, until, severity, bbox, crisis_event_id=crisis_event_id)
    row_by_id = {row["id"]: row for row in rows_all}
    _audit_export(db, user, request, "kml",
                  {"status": status, "crisis_type": crisis_type, "since": since,
                   "until": until, "severity": severity, "bbox": bbox},
                  len(reports))
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
        row = row_by_id[r.id]
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
            # Jun 2026 (export audit) — satellite verification columns
            # (must-have #11): KML ExtendedData previously omitted them.
            "satellite_verdict", "satellite_total_score",
            "satellite_acquisition_date", "satellite_days_gap",
            "satellite_cloud_cover_pct", "satellite_source",
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
        headers={"Content-Disposition": f"attachment; filename=crisp_reports_{_utc_date_stamp()}.kml"}
    )


# ── Support endpoints (Jun 2026, export audit) ────────────────────────────────

@router.get("/count")
def export_count(
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    status: Optional[str] = Query(None),
    crisis_type: Optional[str] = Query(None),
    crisis_event_id: Optional[str] = Query(None, description="Scope to one operation (CrisisEvent id)"),
    since: Optional[str] = Query(None),
    until: Optional[str] = Query(None),
    severity: Optional[str] = Query(None),
    bbox: Optional[str] = Query(None, description="minLng,minLat,maxLng,maxLat"),
):
    """Row count for a prospective export — lets the Export Center show
    'N reports match this scope' BEFORE the user downloads anything."""
    q = _query_reports(db, status, crisis_type, since, until, severity, bbox,
                       crisis_event_id=crisis_event_id)
    return {
        "count": q.order_by(None).count(),
        "filters": {k: v for k, v in {
            "status": status, "crisis_type": crisis_type, "since": since,
            "until": until, "severity": severity, "bbox": bbox,
        }.items() if v},
    }


@router.get("/recent")
def recent_exports(
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    limit: int = Query(10, ge=1, le=50),
):
    """Last N export provenance records (who pulled what dataset, when) —
    the Export Center's audit-trail panel. Org-wide visibility by design:
    operational transparency in a shared crisis room."""
    from app.models.auth import AuthAuditLog
    rows = (
        db.query(AuthAuditLog)
        .filter(AuthAuditLog.action == "EXPORT")
        .order_by(AuthAuditLog.created_at.desc())
        .limit(limit)
        .all()
    )
    def _z(dt):
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if dt else None
    return [{
        "user_email": r.user_email,
        "format": (r.details or {}).get("format"),
        "row_count": (r.details or {}).get("row_count"),
        "filters": (r.details or {}).get("filters") or {},
        "created_at": _z(r.created_at),
    } for r in rows]


# Column descriptions for the data dictionary — kept beside EXPORT_HEADERS so
# a new column without a description is caught in review.
_COLUMN_DESCRIPTIONS = {
    "id": "Report UUID (server-assigned)",
    "client_report_id": "Client-generated idempotency id",
    "source": "Intake channel: APP / ANDROID / WHATSAPP / TELEGRAM / SMS / IVR",
    "status": "Operational status (PENDING / VERIFIED / RESPONDING / RESOLVED / ...)",
    "severity": "Operator severity (CRITICAL / SEVERE / MODERATE / MINOR)",
    "infrastructure_type": "UNDP infrastructure super-type (+ OTHER)",
    "infrastructure_sub_type": "Granular sub-type where the reporter chose one",
    "infrastructure_name": "Building / structure name (reporter-supplied or OSM)",
    "damage_classification": "UNDP 3-tier: MINIMAL / PARTIAL / COMPLETE",
    "crisis_type": "UNDP crisis taxonomy value",
    "crisis_category": "Natural / technological / human-made (derived)",
    "description": "Reporter free text (newlines flattened)",
    "debris_clearing_needed": "UNDP core question — True/False/blank(unanswered)",
    "service_status": "Legacy JSON blob of the V4 service answers",
    "electricity_status": "V4 flat: power status at the site",
    "water_status": "V4 flat: water status at the site",
    "health_status": "V4 flat: health-service status at the site",
    "pressing_needs": "V4 flat: semicolon-joined needs list",
    "reporter_tier": "Reporter credibility tier (gamification)",
    "building_id": "Stable building identifier (OSM-derived where available)",
    "latitude": "WGS84 decimal degrees",
    "longitude": "WGS84 decimal degrees",
    "location_name": "Human place name (user-selected, else reverse-geocoded)",
    "lives_impacted": "Reporter-estimated people affected",
    "timestamp": "Server receipt time, ISO-8601 UTC",
    "satellite_verdict": "Satellite truth-score verdict",
    "satellite_total_score": "Satellite truth score (0-100)",
    "satellite_acquisition_date": "Satellite image acquisition date",
    "satellite_days_gap": "Days between report and satellite image",
    "satellite_cloud_cover_pct": "Cloud cover of the satellite scene (%)",
    "satellite_source": "Satellite imagery provider",
    "client_created_at": "Device capture time, ISO-8601 (offline chronology)",
    "accuracy_m": "GPS horizontal accuracy in meters",
    "location_source": "device_gps or user_corrected pin",
    "infra_name_from_osm": "True when the name came from an OSM footprint",
    "reviewer_verdict": "Human review verdict (NOT_REVIEWED / ACCEPTED / REJECTED)",
    "reviewed_at": "Human review time, ISO-8601",
    "help_dispatched_at": "Response dispatch time, ISO-8601",
    "help_arrived_at": "Response arrival time, ISO-8601",
    "crisis_event_id": "Linked crisis activation id (if any)",
    "detected_language": "Reporter language (ISO code)",
    "media_count": "Number of media items attached",
    "first_photo_url": "Stable thumbnail URL of the first completed photo",
}


@router.get("/data-dictionary")
def export_data_dictionary(user=Depends(require_viewer)):
    """Machine+human readable data dictionary for the export schema
    (column, HXL hashtag, description) — downloadable CSV so every shared
    dataset can travel with its own documentation."""
    def generate():
        buf = io.StringIO()
        w = csv.writer(buf, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
        w.writerow(["column", "hxl_tag", "description"])
        for h in EXPORT_HEADERS:
            w.writerow([h, HXL_TAGS.get(h, ""), _COLUMN_DESCRIPTIONS.get(h, "")])
        yield buf.getvalue()
    return StreamingResponse(
        generate(), media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=crisp_export_data_dictionary.csv"},
    )


# ── Analytics exports (Jun 2026 — the analytics surface had NO export) ───────

def _summary_payload(db: Session, user, window_hours: int = 24):
    """Reuse the dashboard's cached operational summary computation."""
    from app.api.endpoints.analytics import operational_summary
    return operational_summary(window_hours=window_hours, stale_hours=24, db=db, _user=user)


@router.get("/analytics-summary")
def export_analytics_summary(
    request: Request,
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    window_hours: int = Query(24, ge=1, le=720),
):
    """Flatten /analytics/summary into a section,metric,value CSV."""
    s = _summary_payload(db, user, window_hours)
    d = s.model_dump() if hasattr(s, "model_dump") else dict(s)

    def generate():
        buf = io.StringIO()
        w = csv.writer(buf, quoting=csv.QUOTE_MINIMAL, lineterminator="\n")
        w.writerow(["section", "metric", "value"])
        w.writerow(["meta", "generated_at", d.get("generated_at", "")])
        w.writerow(["meta", "window_hours", d.get("window_hours", "")])
        w.writerow(["meta", "total_reports", d.get("total_reports", "")])
        for section in ("counts", "timings", "impact", "deltas"):
            for k, v in (d.get(section) or {}).items():
                w.writerow([section, k, "" if v is None else v])
        for dist_name, dist in (d.get("distributions") or {}).items():
            if isinstance(dist, dict):
                for k, v in dist.items():
                    w.writerow([f"distribution:{dist_name}", k, v])
            else:
                w.writerow(["distributions", dist_name, dist])
        yield buf.getvalue()

    _audit_export(db, user, request, "analytics-summary",
                  {"window_hours": window_hours}, 1)
    return StreamingResponse(
        generate(), media_type="text/csv",
        headers={"Content-Disposition": f"attachment; filename=crisp_analytics_summary_{_utc_date_stamp()}.csv"},
    )


@router.get("/sitrep")
def export_sitrep(
    request: Request,
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
    window_hours: int = Query(24, ge=1, le=720),
):
    """One-page situation-report PDF: the operational summary (counts,
    attention queue, distributions, timings, intake deltas) in a shareable
    briefing artifact — the 'sitrep' humanitarian coordination expects."""
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import cm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
    from reportlab.lib import colors

    s = _summary_payload(db, user, window_hours)
    d = s.model_dump() if hasattr(s, "model_dump") else dict(s)
    c = d.get("counts") or {}
    t = d.get("timings") or {}
    im = d.get("impact") or {}
    dl = d.get("deltas") or {}
    dist = d.get("distributions") or {}

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=2 * cm, rightMargin=2 * cm,
                            topMargin=2 * cm, bottomMargin=2 * cm,
                            title="CRISP Situation Report", author="CRISP Platform")
    styles = getSampleStyleSheet()
    small = ParagraphStyle("small", parent=styles["BodyText"], fontSize=8,
                           textColor=colors.grey)
    story = [
        Paragraph("CRISP Situation Report", styles["Heading1"]),
        Paragraph(
            f"Generated at {datetime.now(timezone.utc).isoformat().replace('+00:00', '')}Z "
            f"· window: last {window_hours}h · total reports on platform: {d.get('total_reports', '—')}",
            small,
        ),
        Spacer(1, 0.4 * cm),
    ]

    def _table(title, pairs):
        story.append(Paragraph(title, styles["Heading2"]))
        tbl = Table([[k, str(v if v is not None else "—")] for k, v in pairs],
                    colWidths=[8 * cm, None], hAlign="LEFT")
        tbl.setStyle(TableStyle([
            ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("TEXTCOLOR", (0, 0), (0, -1), colors.HexColor("#475569")),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
            ("TOPPADDING", (0, 0), (-1, -1), 3),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#e2e8f0")),
        ]))
        story.append(tbl)
        story.append(Spacer(1, 0.3 * cm))

    _table("Situation overview", [
        ("Active incidents", c.get("active")),
        ("Critical", c.get("critical")),
        ("Pending verification", c.get("pending_verification")),
        ("Awaiting triage", c.get("awaiting_triage")),
        ("Open dispatch (no arrival)", c.get("open_dispatch")),
        ("Active operations", c.get("active_ops")),
        ("SLA at-risk", c.get("sla_at_risk")),
        ("Escalating (risk ≥ 70)", c.get("escalating")),
        ("Stale (open & unreviewed)", c.get("stale")),
        (f"Resolved (last {window_hours}h)", c.get("resolved_in_window")),
    ])
    _table("Intake", [
        ("New reports (24h)", dl.get("reports_24h")),
        ("Previous 24h", dl.get("reports_prev_24h")),
        ("New reports (7d)", dl.get("reports_7d")),
        ("Previous 7d", dl.get("reports_prev_7d")),
    ])
    _table("Response performance", [
        ("Avg verification time (s)", t.get("avg_verification_seconds")),
        ("Avg response time (s)", t.get("avg_response_seconds")),
        ("Verified reports", (dist or {}).get("verified")),
        ("Unverified / rejected", (dist or {}).get("unverified")),
    ])
    _table("Operational impact", [
        ("Critical infrastructure hit", im.get("critical_infrastructure")),
        ("Service disruptions", im.get("service_disruptions")),
        ("Lives impacted (reported)", im.get("lives_impacted_sum")),
        ("Responders active", im.get("responders_active")),
    ])
    sev = (dist or {}).get("by_severity") or {}
    if sev:
        _table("By severity", sorted(sev.items(), key=lambda kv: -int(kv[1] or 0)))
    ct = (dist or {}).get("by_crisis_type") or {}
    if ct:
        _table("By crisis type", sorted(ct.items(), key=lambda kv: -int(kv[1] or 0))[:8])
    story.append(Paragraph(
        "Population exposure & displacement are intentionally not shown: CRISP records "
        "citizen damage reports, not census/displacement data.", small))

    doc.build(story)
    buf.seek(0)
    _audit_export(db, user, request, "sitrep", {"window_hours": window_hours}, 1)
    return StreamingResponse(
        buf, media_type="application/pdf",
        headers={"Content-Disposition": f"attachment; filename=crisp_sitrep_{_utc_date_stamp()}.pdf"},
    )


# ── Evidence bundle (Jun 2026 — judge-friendly single-report package) ─────────

@router.get("/evidence-bundle/{report_id}")
def export_evidence_bundle(
    report_id: str,
    request: Request,
    user=Depends(require_viewer),
    db: Session = Depends(get_db),
):
    """ZIP package for one report: evidence JSON (same payload as the public
    share page), every completed media file, satellite snapshots when stored,
    and a README — so a verifier can review a report fully OFFLINE instead of
    fetching media one stable URL at a time."""
    report = (
        db.query(Report)
        .options(joinedload(Report.location), joinedload(Report.verification),
                 selectinload(Report.media))
        .filter(Report.id == report_id, Report.deletion_requested_at.is_(None))
        .first()
    )
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")

    from app.api.endpoints.reports import get_public_evidence
    evidence = get_public_evidence(report_id, db)

    from app.services.storage import get_storage
    storage = None
    try:
        storage = get_storage()
    except Exception as se:
        logger.warning(f"[evidence-bundle] storage unavailable; media omitted: {se}")

    zip_buf = io.BytesIO()
    skipped = []
    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("evidence.json", json.dumps(evidence, indent=2, default=str))
        media_added = 0
        for m in list(report.media or []):
            if getattr(m, "assembly_status", "") != "complete" or not m.url:
                continue
            mtype = (m.type.value if getattr(m, "type", None) else "MEDIA")
            tier = (m.resolution_tier.value if getattr(m, "resolution_tier", None) else "")
            ext = "webm" if mtype == "AUDIO" else "jpg"
            fname = f"media/{mtype.lower()}_{media_added + 1}_{tier or 'file'}_{m.id[:8]}.{ext}"
            if storage:
                try:
                    zf.writestr(fname, storage.read(m.url))
                    media_added += 1
                    continue
                except Exception as me:
                    logger.warning(f"[evidence-bundle] media read failed {m.id[:8]}: {me}")
            skipped.append(f"{fname} -> /api/v1/reports/media/{m.id}/file")
        v = getattr(report, "verification", None)
        for label, attr in (("satellite_primary", "satellite_image_url"),
                            ("satellite_alt", "satellite_image_url_alt")):
            url = getattr(v, attr, None) if v else None
            if url and storage:
                try:
                    zf.writestr(f"satellite/{label}.png", storage.read(url))
                except Exception as se2:
                    logger.warning(f"[evidence-bundle] satellite read failed ({label}): {se2}")
                    skipped.append(f"satellite/{label}.png -> stored at {url}")
        readme = [
            f"CRISP evidence bundle — report {report_id}",
            f"Generated at {datetime.now(timezone.utc).isoformat().replace('+00:00', '')}Z",
            "",
            "Contents:",
            "  evidence.json — verification evidence (same payload as the public share page)",
            "  media/        — completed photo/audio files attached to the report",
            "  satellite/    — stored satellite snapshots used for verification",
            "",
            "Timestamps are ISO-8601 UTC. Coordinates are WGS84 decimal degrees.",
        ]
        if skipped:
            readme += ["", "Items unavailable at bundle time (fetch via stable URL):"]
            readme += [f"  {s}" for s in skipped]
        zf.writestr("README.txt", "\n".join(readme))
    zip_buf.seek(0)
    _audit_export(db, user, request, "evidence-bundle", {"report_id": report_id}, 1)
    return StreamingResponse(
        zip_buf, media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename=crisp_evidence_{report_id[:8]}.zip"},
    )
