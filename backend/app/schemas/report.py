from datetime import datetime, timezone as _dt_timezone
from typing import List, Optional, Any
from pydantic import BaseModel, ConfigDict, Field, SerializationInfo, field_serializer, model_validator
from app.models.report import (
    SourceEnum, SeverityEnum, InfraTypeEnum, MediaTypeEnum,
    ResolutionEnum, SyncStatusEnum, ReportStatusEnum, ClusterStatusEnum,
    DamageClassEnum, CrisisTypeEnum, ServiceStatusEnum
)


# P2.9 — All backend datetimes are UTC (see models: DateTime(timezone=True) on
# every column). SQLite, however, round-trips them as naive. Pydantic's
# default ISO serialization then emits "2026-04-18T10:00:00" without a Z,
# and browsers parse that as LOCAL time — dashboards see reports off by
# hours. This helper stamps naive datetimes as UTC before they leave the
# backend, guaranteeing every wire value ends in Z. tz-aware values pass
# through unchanged (covering Postgres + future migrations).
def _utc_iso(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=_dt_timezone.utc)
    # isoformat always includes the offset when tz-aware; normalize to `Z`.
    s = dt.astimezone(_dt_timezone.utc).isoformat()
    return s.replace("+00:00", "Z")

# Shared Properties
class LocationBase(BaseModel):
    latitude: float
    longitude: float
    device_latitude: Optional[float] = None
    device_longitude: Optional[float] = None
    accuracy_meters: Optional[float] = None
    is_user_corrected: Optional[bool] = False
    user_location_name: Optional[str] = None
    device_location_name: Optional[str] = None
    # geocoder confidence + source. Populated when the
    # location came from text-only channels (IVR / SMS / WhatsApp);
    # left None for GPS-captured locations.
    geocoding_confidence: Optional[float] = None
    geocoding_source: Optional[str] = None

class MediaBase(BaseModel):
    type: MediaTypeEnum
    resolution_tier: ResolutionEnum = ResolutionEnum.LOW
    url: str
    file_size_bytes: Optional[int] = None

# Chunked upload: tiny thumbnail sent before chunks (PRD §3.4)
class ThumbnailPayload(BaseModel):
    media_id: str
    thumbnail_data: str  # full data:image/jpeg;base64,... URL (≤20KB)

# Chunked upload: adaptive packets 1KB-512KB (network-aware)
class MediaChunkPayload(BaseModel):
    media_id: str
    type: MediaTypeEnum
    seq_num: int = Field(..., ge=0, le=10_000)
    # P1.7 — cap total_chunks at 10,000. At 512 KB max per chunk that allows
    # a ~5 GB upload; well beyond any legitimate mobile capture. Previously
    # an attacker could submit total_chunks=999_999_999 to force premature
    # assembly after one chunk or exhaust DB storage with empty MediaChunk
    # rows.
    total_chunks: int = Field(..., ge=1, le=10_000)
    data: str = Field(..., max_length=1048576)  # max 1MB chars (512KB base64 + overhead)
    checksum: Optional[str] = None  # djb2 hex for integrity (PRD §3.7)
    # Guaranteed-delivery pipeline. The client tags each chunk with which
    # variant it's building (SMALL=LOW, MEDIUM=MEDIUM, LARGE=HIGH) and a
    # shared photo_group_id linking the three variants of one captured photo.
    # Both default such that legacy single-variant clients keep working
    # (the chunk handler used to hard-code `MEDIUM` on new media rows — we
    # drop that hard-coding and trust this field instead).
    resolution_tier: ResolutionEnum = ResolutionEnum.LOW
    photo_group_id: Optional[str] = Field(None, max_length=36)
    # : when `true`, the client has already run its PII blur (face
    # redaction via BlazeFace on PWA / similar on RN) against the original
    # image before chunking. The server-side blur_pii() pass is then skipped
    # on assembly — avoiding a second lossy pass over already-redacted bytes.
    # Default false so legacy clients continue to get server-side blur.
    client_blur_applied: bool = False

# API Request Payloads
class ReportCreate(BaseModel):
    device_hash: str = Field(..., max_length=255)
    client_report_id: Optional[str] = Field(None, max_length=64)
    source: SourceEnum = SourceEnum.APP
    severity: SeverityEnum = SeverityEnum.UNKNOWN
    infrastructure_type: InfraTypeEnum = InfraTypeEnum.OTHER
    description: Optional[str] = Field(None, max_length=5000)
    is_auto_submitted: bool = False
    client_created_at: Optional[datetime] = None
    location: LocationBase
    media: Optional[List[MediaBase]] = []
    expected_media: Optional[int] = 0
    # UNDP required fields
    damage_classification: Optional[str] = None
    crisis_type: Optional[str] = None
    infrastructure_name: Optional[str] = Field(None, max_length=255)
    debris_clearing_needed: Optional[bool] = None
    service_status: Optional[Any] = None

# Lightweight metadata-only payload (Stage 1 — tiny, instant)
class ReportMetaCreate(BaseModel):
    device_hash: str = Field(..., max_length=255)
    client_report_id: str = Field(..., max_length=64)
    source: SourceEnum = SourceEnum.APP
    severity: SeverityEnum = SeverityEnum.UNKNOWN
    infrastructure_type: InfraTypeEnum = InfraTypeEnum.OTHER
    description: Optional[str] = Field(None, max_length=5000)
    caller_info: Optional[Any] = None
    is_auto_submitted: bool = False
    client_created_at: Optional[datetime] = None
    location: Optional[LocationBase] = None
    expected_media: int = Field(0, ge=0, le=50)
    # UNDP required fields — P2.10 validation: accept only canonical enum
    # values. Clients that still send stringly-typed legacy values get a clear
    # 422 now instead of silently writing garbage to the DB.
    damage_classification: Optional[DamageClassEnum] = None
    crisis_type: Optional[CrisisTypeEnum] = None
    infrastructure_name: Optional[str] = Field(None, max_length=255)
    # distinguisher between OSM-auto-filled and
    # user-typed building names. True = the PWA / RN client auto-filled
    # `infrastructure_name` from the OSM building the reporter tapped. False
    # = the reporter typed the name as free text in their native language
    # (because the map was unavailable). The dashboard uses this in combination
    # with `building_id IS NULL` to flag rows that need manual mapping —
    # see `needs_manual_mapping` in the ReportResponse. Defaults to False so
    # pre-v3 clients (which never set the field) behave like explicit
    # free-text — the safe "needs mapping" bucket.
    infrastructure_name_from_osm: Optional[bool] = False
    debris_clearing_needed: Optional[bool] = None
    service_status: Optional[Any] = None
    # Building-footprint selection (UNDP Appendix). Client submits the
    # composite OSM identifier it rendered from (e.g. ``osm:way:123456``)
    # — the auto-assign logic in `_auto_assign_building_id` runs first
    # but an explicit pick overrides the coarse match.
    building_id: Optional[str] = Field(None, max_length=64)
    # Phase 1 progressive-upload stack. Blurhash encodes a
    # ~4x3 DCT of the main photo into a short string (~25-35 chars); the
    # dashboard decodes it into a blurred colour impression and renders
    # it as a placeholder the instant the meta POST lands, BEFORE any
    # media chunk arrives. Closes the "time-to-first-visual" gap from
    # ~2 s (first SMALL chunk) down to ~200 ms (meta RTT). The string is
    # tiny enough to fit comfortably in the meta body even on a 2 Kbps
    # link (25 bytes ≈ 100 ms at 2 Kbps).
    # Length cap is generous — blurhash can go up to ~9x9 DCT (≈ 83
    # chars) but our encoder uses 4x3, which yields ~30 chars.
    blurhash: Optional[str] = Field(None, max_length=96)

# Single media attachment (Stage 2/3 — one file at a time)
class MediaAttach(BaseModel):
    type: MediaTypeEnum
    resolution_tier: ResolutionEnum = ResolutionEnum.LOW
    url: str  # base64 data URL
    file_size_bytes: Optional[int] = None

class MediaUpload(BaseModel):
    report_id: str
    media_data: MediaBase  # For progressive upload sync

# Single text update (Stage 2 — description/transcript)
class ReportDescriptionUpdate(BaseModel):
    description: str

# API Response Payloads
class LocationResponse(LocationBase):
    id: str
    model_config = ConfigDict(from_attributes=True)

class MediaResponse(MediaBase):
    id: str
    is_synced: bool
    thumbnail_url: Optional[str] = None
    completion_pct: float = 0.0
    assembly_status: str = 'pending'
    # Guaranteed-delivery: dashboard groups media by this id and picks the
    # best-available complete variant (LARGE > MEDIUM > SMALL > partial).
    photo_group_id: Optional[str] = None
    # server-side PII-blur outcome. Dashboard MUST warn/flag
    # any row where this is 'skipped' or 'failed' — the file is on disk
    # and may contain unredacted PII. 'not_needed' = client handled it,
    # 'complete' = server-side pass succeeded, 'pending' = blur
    # in flight, NULL = legacy row (pre-tracking).
    pii_blur_status: Optional[str] = None
    # UI v2.1 — perceptual-hash fingerprint of the assembled
    # photo for redundancy detection (UNDP nice-to-have #3). 16-char
    # hex string; NULL for audio / legacy / not-yet-scanned rows. The
    # dashboard groups media with near-identical hashes (Hamming
    # distance ≤ 10) within the same building_id + 24h window.
    photo_phash: Optional[str] = None
    model_config = ConfigDict(from_attributes=True)

    # UNDP scaling. The DB stores `s3://<key>` for media
    # written through the S3 backend; the dashboard can't fetch that
    # URL directly. Pass-through for `/static/...` (legacy local-disk
    # paths) and plain http(s) URLs.
    #
    # `thumbnail_url` MUST be resolved too. The dashboard's
    # audio player falls back to `audio.thumbnail_url` while a chunked
    # upload is still in flight (it stores the partial-assembled WebM/
    # M4A under that field, see _try_partial_audio_bg in
    # app/api/endpoints/reports.py). Without including the field here,
    # the dashboard receives a raw `s3://...` string, prepends
    # BACKEND_HOST, and ends up GETting `https://undp/.../s3://abc.m4a`
    # → 404. Same shape applies to image fast-preview thumbnails set
    # by /reports/{id}/media/thumbnail. Pydantic v2's field_serializer
    # accepts a tuple of field names — one decorator covers both.
    #
    # (HAR-driven rewrite) — previously this returned a freshly
    # generated S3 presigned URL on EVERY serialization. The dashboard
    # polls /api/v1/reports/ every 1.2-4s; each poll generated a new
    # X-Amz-Signature on the same media bytes; the browser saw a new
    # `<img src>` URL each time and refetched the bytes. HAR analysis
    # of a 6-minute window showed the same image fetched 98× (49 unique
    # signatures, ~2.5 MB wasted bandwidth per dashboard tab).
    #
    # Fix: emit a STABLE `/api/v1/reports/media/<id>/<file|thumb>` URL.
    # That endpoint 302-redirects to a fresh presigned URL on demand,
    # and tags the redirect with `Cache-Control: public, max-age=3600`
    # so the browser keeps a stable cache key. Cross-poll bytes are
    # reused; backend hits drop from per-poll to ~once-per-image-per-hour.
    #
    # Field-name disambiguation via `SerializationInfo.field_name`
    # (Pydantic v2's per-call context) lets one decorator handle both
    # `url` (→ /file) and `thumbnail_url` (→ /thumb) without a second
    # method.
    @field_serializer("url", "thumbnail_url", when_used="json")
    def _resolve_url(self, v: Optional[str], info: SerializationInfo) -> Optional[str]:
        if not v:
            return v
        # `s3://...` rows: rewrite to stable backend-routed URL. The
        # endpoint resolves to a fresh presigned URL on demand.
        # `self.id` should always be present (typed as required), but
        # the guard avoids a dangling `/media//file` if some test path
        # constructs a MediaResponse without id.
        if v.startswith("s3://") and self.id:
            suffix = "thumb" if info.field_name == "thumbnail_url" else "file"
            return f"/api/v1/reports/media/{self.id}/{suffix}"
        # Pass-through for `/static/...` (local backend), `data:...`
        # (rare inline thumbs), and plain http(s):// (legacy / external).
        return v

class AIAnalysisResponse(BaseModel):
    id: str
    damage_score: Optional[float] = None
    ai_severity: Optional[SeverityEnum] = None
    transcription: Optional[str] = None
    ai_summary: Optional[str] = None
    detected_labels: Optional[List[Any]] = []
    model_config = ConfigDict(from_attributes=True)

    @classmethod
    def model_validate(cls, obj, *args, **kwargs):
        # Coerce None detected_labels (stored as NULL in older DB rows) to []
        if hasattr(obj, 'detected_labels') and obj.detected_labels is None:
            obj.detected_labels = []
        return super().model_validate(obj, *args, **kwargs)


class VerificationResponse(BaseModel):
    """Response schema for a satellite truth-verification result."""
    id: str
    report_id: str
    total_score: int = 0
    verdict: Optional[str] = None
    scores: Optional[Any] = None                      # {location_authenticity, …}
    reasoning: Optional[str] = None
    key_findings: Optional[List[str]] = []
    caveats: Optional[List[str]] = []
    satellite_scene_description: Optional[str] = None
    photo_analysis: Optional[str] = None
    satellite_source: Optional[str] = None
    satellite_acquisition_date: Optional[str] = None
    satellite_cloud_cover_pct: Optional[float] = None
    satellite_resolution_m: Optional[float] = None
    satellite_days_gap: Optional[int] = None
    satellite_image_url: Optional[str] = None
    satellite_image_url_alt: Optional[str] = None
    satellite_source_alt: Optional[str] = None
    satellite_acquisition_date_alt: Optional[str] = None
    satellite_resolution_m_alt: Optional[float] = None
    # multi-provider fan-out. List of every satellite source
    # that returned successfully (AWS Sentinel-2, Microsoft Planetary
    # Computer, ESA Copernicus, Mapbox). Dashboard renders 2×2 grid.
    # Empty list when verification ran with the legacy single-source
    # path or when no providers responded. Each entry:
    #   { url, source, acquisition_date, cloud_cover_pct, resolution_m }
    satellite_images: Optional[List[Any]] = []
    error: Optional[str] = None
    scored_at: Optional[datetime] = None
    model_config = ConfigDict(from_attributes=True)

    # .2 — emit Z-suffixed UTC for `scored_at` so the dashboard's
    # `timeAgo()` parses it correctly. Same pattern as ReportResponse.
    @field_serializer("scored_at", when_used="json")
    def _serialize_scored_at(self, v: Optional[datetime]) -> Optional[str]:
        return _utc_iso(v)

    @model_validator(mode="before")
    @classmethod
    def _decode_satellite_images_json(cls, data: Any) -> Any:
        """Decode the satellite_images_json text column into the
        satellite_images list field. Runs both for ORM-attribute reads
        (POST /verify response, where the endpoint also sets
        satellite_images directly on the instance) and for fresh DB reads
        (GET /verification, which only has the JSON column).

        Idempotent — if `satellite_images` is already populated, leave
        it alone. Decoder is forgiving: malformed JSON yields an empty
        list rather than blowing up the whole response.
        """
        if not hasattr(data, "__dict__") and not isinstance(data, dict):
            return data
        # ORM instance attribute access vs dict access
        get = (lambda k: getattr(data, k, None)) if not isinstance(data, dict) else (lambda k: data.get(k))
        already = get("satellite_images")
        if already:
            return data
        raw = get("satellite_images_json")
        if not raw:
            return data
        try:
            import json as _json
            parsed = _json.loads(raw)
            if isinstance(parsed, list):
                if isinstance(data, dict):
                    data["satellite_images"] = parsed
                else:
                    data.satellite_images = parsed  # type: ignore[attr-defined]
        except Exception:
            pass
        return data

    # pass-through for `/static/...` (legacy local-disk paths)
    # and plain http(s) URLs.
    #
    # (HAR-driven rewrite, mirrors MediaResponse Phase 1) —
    # previously this generated a fresh S3 presigned URL on every
    # serialization. The dashboard polls /api/v1/reports/ every 1.2-4s,
    # which means each of the 4 satellite cells in the multi-provider
    # grid got a new X-Amz-Signature on every poll → browser cache miss
    # every time → ~100× refetch of identical satellite bytes per
    # analyst-shift.
    #
    # Worse, the dashboard hard-coded `${BACKEND_HOST}${v.satellite_image_url}`
    # at 11 render sites — when the serializer returned a signed
    # `https://s3.../...` URL, the dashboard prepended BACKEND_HOST and
    # produced `https://undp/.../https://s3.../...` → 404 / 403
    # SignatureDoesNotMatch on every PROD load.
    #
    # Fix — emit a STABLE `/api/v1/reports/{report_id}/satellite/<slot>`
    # URL. The endpoint resolves to a fresh presigned URL on demand via
    # a 302 redirect (cached for 1 h via Cache-Control). The dashboard
    # `getMediaUrl()` helper handles relative URLs correctly already.
    #
    # Field-name disambiguation via `SerializationInfo.field_name`
    # — same trick as MediaResponse — distinguishes `satellite_image_url`
    # (→ /satellite/primary) from `satellite_image_url_alt`
    # (→ /satellite/alt) without a second decorator method.
    @field_serializer("satellite_image_url", "satellite_image_url_alt", when_used="json")
    def _resolve_sat_url(self, v: Optional[str], info: SerializationInfo) -> Optional[str]:
        if not v:
            return v
        # `s3://...` rows: rewrite to stable backend-routed URL.
        # `self.report_id` is a required field (line 258), but the guard
        # avoids a dangling `/api/v1/reports//satellite/...` path if some
        # test bypasses validation.
        if v.startswith("s3://") and self.report_id:
            slot = "alt" if info.field_name == "satellite_image_url_alt" else "primary"
            return f"/api/v1/reports/{self.report_id}/satellite/{slot}"
        # Pass-through for `/static/...` (local backend) and plain http(s)://.
        return v

    @field_serializer("satellite_images", when_used="json")
    def _resolve_sat_images(self, v: Optional[List[Any]]) -> Optional[List[Any]]:
        if not v:
            return v
        out: List[Any] = []
        for idx, entry in enumerate(v):
            if isinstance(entry, dict) and entry.get("url"):
                e2 = dict(entry)
                u = entry["url"]
                # `s3://...` → stable grid URL; pass-through everything else.
                if isinstance(u, str) and u.startswith("s3://") and self.report_id:
                    e2["url"] = f"/api/v1/reports/{self.report_id}/satellite/grid/{idx}"
                out.append(e2)
            else:
                out.append(entry)
        return out

class ReportResponse(BaseModel):
    id: str
    client_report_id: Optional[str] = None
    device_id: str
    source: SourceEnum
    status: ReportStatusEnum
    sync_status: SyncStatusEnum
    severity: SeverityEnum
    infrastructure_type: InfraTypeEnum
    description: Optional[str] = None
    detected_language: Optional[str] = None
    caller_info: Optional[Any] = None
    ai_assessment: Optional[Any] = None
    is_auto_submitted: bool = False
    expected_media: int = 0
    received_media: int = 0
    server_created_at: datetime
    deletion_requested_at: Optional[datetime] = None
    lives_impacted: Optional[int] = None

    @field_serializer("server_created_at", "deletion_requested_at", when_used="json")
    def _serialize_dt(self, v: Optional[datetime]) -> Optional[str]:
        # P2.9 — emit UTC-with-Z so dashboard JS `new Date(...)` parses it correctly.
        return _utc_iso(v)

    # UNDP required fields
    damage_classification: Optional[str] = None     # MINIMAL / PARTIAL / COMPLETE (UNDP-aligned)
    crisis_type: Optional[str] = None               # see CrisisTypeEnum for the full UNDP list
    crisis_category: Optional[str] = None           # NATURAL / TECHNOLOGICAL / HUMAN_MADE / OTHER
    infrastructure_sub_type: Optional[str] = None   # original UI chip (ROAD, HOSPITAL, ...) for drill-down
    # `user_id` stays
    # NULL on anonymous submissions. Dashboard treats NULL == anonymous.
    # PII fields (email/phone) are never embedded in this response; the
    # dashboard calls `/auth/users/{user_id}` separately when an operator
    # with ADMIN role needs to see them (user answer 5 — ANALYST sees a
    # masked "User abc1234" badge via the derived field below; ADMIN can
    # open the detail).
    user_id: Optional[str] = None
    is_anonymous: Optional[bool] = None
    # Derived at read time (ReportResponse._compute_identity_badge) —
    # masked for the default feed; operators with ADMIN role can call
    # /auth/users/{user_id} to see PII.
    reporter_badge: Optional[str] = None
    infrastructure_name: Optional[str] = None
    # see ReportMetaCreate.infrastructure_name_from_osm.
    # Exposed on the response so the dashboard can render a "needs mapping"
    # badge when the reporter typed a free-text building name. Three-state
    # column:
    #   None  → pre-v3 row, dashboard shows no badge (we can't infer).
    #   True  → OSM-picked, dashboard shows nothing (already mapped).
    #   False → user-typed free text, dashboard shows the red "needs mapping"
    #           badge IF `building_id IS None`.
    infrastructure_name_from_osm: Optional[bool] = None
    # Dashboard-friendly derived flag: True iff the reporter left a building
    # name but no OSM match, so an operator needs to resolve it manually.
    # Computed at read time; not a column — keeps the responsibility on the
    # backend rather than asking every dashboard client to re-implement the
    # rule. See ReportsResponseBuilder._needs_manual_mapping.
    needs_manual_mapping: Optional[bool] = None
    debris_clearing_needed: Optional[bool] = None
    service_status: Optional[Any] = None
    building_id: Optional[str] = None
    # Blurhash placeholder — see ReportMetaCreate.blurhash for design. The
    # dashboard renders this via the blurhash-decode path while waiting for
    # the first SMALL variant to arrive. Nullable because legacy reports
    # submitted before Phase-1 won't have one.
    blurhash: Optional[str] = None

    # reviewer workflow surface.
    # `response_time_seconds` is COMPUTED at read time from
    # help_arrived_at (or help_dispatched_at) minus reviewed_at. Not stored
    # to avoid two-source-of-truth drift.
    reviewed_at: Optional[datetime] = None
    reviewer_verdict: str = "NOT_REVIEWED"
    action_taken: Optional[str] = None
    help_dispatched_at: Optional[datetime] = None
    help_arrived_at: Optional[datetime] = None
    response_time_seconds: Optional[int] = None

    @field_serializer("reviewed_at", "help_dispatched_at", "help_arrived_at", when_used="json")
    def _serialize_reviewer_dt(self, v: Optional[datetime]) -> Optional[str]:
        return _utc_iso(v)

    location: Optional[LocationResponse] = None
    media: List[MediaResponse] = []
    ai_analysis: Optional[AIAnalysisResponse] = None
    verification: Optional[VerificationResponse] = None

    model_config = ConfigDict(from_attributes=True)

    # : use model_validator(mode='after') — the previous
    # `model_validate` classmethod override fired on direct calls but was
    # skipped by FastAPI's list-response serialisation path (which uses a
    # TypeAdapter under the hood). `model_validator(after)` runs on EVERY
    # validated instance regardless of entry point. Caught by e2e test
    # tests/dashboard/03-reviewer-workflow.spec.ts.
    @model_validator(mode='after')
    def _compute_response_time(self):
        """Compute `response_time_seconds` from the reviewer + responder
        timestamps. Derived, not stored — avoids two-source-of-truth drift."""
        if self.reviewed_at and (self.help_arrived_at or self.help_dispatched_at):
            end = self.help_arrived_at or self.help_dispatched_at
            try:
                from datetime import timezone as _tz
                a = self.reviewed_at if self.reviewed_at.tzinfo else self.reviewed_at.replace(tzinfo=_tz.utc)
                b = end if end.tzinfo else end.replace(tzinfo=_tz.utc)
                delta = int((b - a).total_seconds())
                if delta >= 0:
                    self.response_time_seconds = delta
            except Exception:
                pass
        return self

    # derive the masked
    # reporter badge. `reporter_badge` is ALWAYS safe for the default
    # ANALYST view: 8-char truncation of the user_id ("User abc12345").
    # Operators with ADMIN role who need PII hit /auth/users/{user_id}
    # separately. NULL user_id → `None` (anonymous; dashboard renders
    # the standard "Anonymous" chip).
    @model_validator(mode='after')
    def _compute_identity_badge(self):
        if self.user_id:
            short = str(self.user_id).replace("-", "")[:8]
            self.reporter_badge = f"User {short}"
            self.is_anonymous = False
        else:
            self.reporter_badge = None
            self.is_anonymous = True
        return self

    # derive the dashboard-friendly
    # `needs_manual_mapping` flag from the three source columns
    # (`infrastructure_name`, `building_id`, `infrastructure_name_from_osm`).
    # Computed here — not stored — so the rule stays in one place and every
    # response path (list, single, dashboard bulk) sees the same value.
    @model_validator(mode='after')
    def _compute_needs_manual_mapping(self):
        has_name = bool((self.infrastructure_name or "").strip())
        has_osm = bool((self.building_id or "").strip())
        if not has_name or has_osm:
            # No name, or already resolved to an OSM footprint. No mapping action.
            self.needs_manual_mapping = False
            return self
        if self.infrastructure_name_from_osm is None:
            # Pre-v3 row — we can't infer. Leave None so the dashboard shows
            # no badge (neither green ✓ nor red "needs mapping").
            self.needs_manual_mapping = None
            return self
        # Explicit False from a v3+ client → user typed it; operator should resolve.
        self.needs_manual_mapping = not self.infrastructure_name_from_osm
        return self


class ClusterResponse(BaseModel):
    id: str
    center_lat: float
    center_lng: float
    radius_meters: float
    confidence_score: float
    status: ClusterStatusEnum
    primary_infrastructure_type: Optional[InfraTypeEnum] = None
    
    model_config = ConfigDict(from_attributes=True)
