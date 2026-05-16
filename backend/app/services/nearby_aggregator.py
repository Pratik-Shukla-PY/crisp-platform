"""
nearby_aggregator — Privacy-projecting grouping service for the
"Verified Reports Nearby" home-stage feature (May 2026).

WHY THIS LIVES IN A SERVICE LAYER (not inline in the endpoint):
The aggregation logic — bbox pre-filter, haversine, building / crisis-
cluster bucketing, relevance sort, k-anonymity suppression, anti-spam
device-cap — is the part most likely to be reused (RN companion's
offline-cache parser does the same shape) AND the part where bugs
become privacy regressions. Keeping it in a dedicated, easy-to-test
module + a strict typed projection means a single audit pass on this
file proves the whole endpoint never leaks PII.

INVARIANTS the projection enforces (audited by tests):

  ✓ NO `device_id`, `user_id`, `reporter_badge` in output
  ✓ NO individual report `id`s
  ✓ NO free-text `description`
  ✓ NO precise per-report coords (only group centroid + caller's distance)
  ✓ NO sub-minute timestamps
  ✓ NO reviewer notes / action_taken
  ✓ k-anonymity: groups with < MIN_GROUP_REPORTS suppressed
  ✓ anti-spam: same device contributes count=1 not N to a group
  ✓ status filter: REJECTED / DUPLICATE / FALSE_ALARM never returned

Caller (endpoint) supplies the prefiltered Report list with locations
joined; this module owns ONLY the projection + grouping.

UNDP alignment:
  • must-have #4 — DamageClassEnum (MINIMAL/PARTIAL/COMPLETE) only
  • must-have #5 — CrisisTypeEnum only
  • must-have #6 — building_id as primary group key (OSM-tagged
                    structure aggregation)
  • must-have #7 — strict PII projection above
  • must-have #9 — zero reporter identification surfaced
  • must-have #12 — scale-ready via bbox pre-filter + relevance top-N
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import List, Optional, Tuple


# ── Tunable constants ──────────────────────────────────────────────────

#: T3 (Verified) tier floor — groups need ≥ this many UNIQUE devices to
#: render as a "Verified Nearby Incident". Was MIN_GROUP_REPORTS pre-Phase-1
#: (May 2026) — the old single-floor model dropped all single-witness
#: signals. New tiered model (see docs/NEARBY_REPORTS_PIPELINE.md §3.2):
#: T1 = 1 device, T2 = 2 devices OR ≥ 30 min stale, T3 = ≥ 3 devices.
T3_VERIFIED_FLOOR = 3
T2_EMERGING_FLOOR = 2
T1_WEAK_STALE_MIN = 30                # T2 promotion: T1 + ≥ this many minutes old

#: Legacy alias — some external callers still pass `min_group_size`.
#: Now defaults to T1_WEAK (= 1) so the aggregator surfaces every tier
#: by default; the endpoint slices by tier afterwards based on caller
#: identity (citizen vs admin vs deployment T1-visibility flag).
MIN_GROUP_REPORTS = 1

#: Anti-spam cap — a single device's contribution to a group's `count`
#: is capped here, regardless of how many duplicates they submit. A
#: bot submitting 50 reports from the same device shows up as 1.
#: Phase 3 will replace this with trust-weighted contribution.
PER_DEVICE_CONTRIBUTION_CAP = 1

#: Fallback grid cell size (degrees) for reports without `building_id`.
#: 0.002° ≈ 220m at the equator — small enough that a "Road Damage"
#: cluster doesn't span an entire neighbourhood, large enough that
#: scattered street-level reports still aggregate.
FALLBACK_CELL_SIZE_DEG = 0.002

#: Temporal burst window — ≥ T3_VERIFIED_FLOOR reports inside this many
#: minutes flips `is_burst=true`. Phase 2 introduces full HIGH/LOW
#: grading; Phase 1 uses a simple count-in-window check.
BURST_WINDOW_MIN = 60

#: Acute spike window — ≥ ACUTE_REPORTS_THRESHOLD inside this many
#: minutes flips `is_acute=true`. Drives the §8 notification policy.
ACUTE_WINDOW_MIN = 15
ACUTE_REPORTS_THRESHOLD = 5

#: RESOLVED-recent retention — a group whose `latest_at` is within this
#: many hours AND whose top status is RESOLVED stays in the response
#: but with `kind="resolved_recent"` so the client renders it in the
#: separate "Recently Resolved" subtotal line, NOT folded into the
#: active count.
RESOLVED_RECENT_RETENTION_HOURS = 24


# ── Crisis-type adaptive rules (docs §3.3) ────────────────────────────
#
# Single source of truth for TTL (per tier) + preferred clustering
# bucket per crisis_type. Used by the aggregator AND by the endpoint
# (the endpoint's `max_age_hours` query param overrides as a ceiling
# for backward compat; otherwise the rule's T3 max age caps recency).
#
# Tier TTLs: a report older than `T{n}_max_hours` cannot count toward
# tier n. So a 25-h-old FLOOD-flash report can still keep a group at
# T2 (T2 cap 24 h means it falls out — bumped to expire) but a 6 h
# WILDFIRE report counts for T1 only (T1 cap 6h).

@dataclass
class CrisisRule:
    t1_max_hours: int        # max age for a report to count toward T1
    t2_max_hours: int        # max age for T2
    t3_max_hours: int        # max age for T3 (and overall ceiling)
    preferred_bucket: str    # 'building' | 'block' | 'area' — Phase 2 honours this


CRISIS_RULES: dict[str, CrisisRule] = {
    'FLOOD':              CrisisRule(t1_max_hours=24, t2_max_hours=72,   t3_max_hours=24 * 7,    preferred_bucket='area'),
    'FLOOD_FLASH':        CrisisRule(t1_max_hours=6,  t2_max_hours=24,   t3_max_hours=72,        preferred_bucket='area'),
    'FLOOD_RIVER':        CrisisRule(t1_max_hours=24, t2_max_hours=72,   t3_max_hours=24 * 7,    preferred_bucket='area'),
    'EARTHQUAKE':         CrisisRule(t1_max_hours=24, t2_max_hours=24 * 7, t3_max_hours=24 * 14,  preferred_bucket='building'),
    'WILDFIRE':           CrisisRule(t1_max_hours=6,  t2_max_hours=48,   t3_max_hours=24 * 7,    preferred_bucket='area'),
    'LANDSLIDE':          CrisisRule(t1_max_hours=24, t2_max_hours=24 * 7, t3_max_hours=24 * 30,  preferred_bucket='area'),
    'BUILDING_COLLAPSE':  CrisisRule(t1_max_hours=24, t2_max_hours=24 * 7, t3_max_hours=24 * 30,  preferred_bucket='building'),
    'CIVIL_UNREST':       CrisisRule(t1_max_hours=2,  t2_max_hours=12,   t3_max_hours=48,        preferred_bucket='block'),
    'CHEMICAL_INCIDENT':  CrisisRule(t1_max_hours=6,  t2_max_hours=48,   t3_max_hours=24 * 7,    preferred_bucket='area'),
    'EXPLOSION':          CrisisRule(t1_max_hours=6,  t2_max_hours=48,   t3_max_hours=24 * 14,   preferred_bucket='block'),
    'CONFLICT':           CrisisRule(t1_max_hours=6,  t2_max_hours=48,   t3_max_hours=24 * 30,   preferred_bucket='block'),
}

DEFAULT_CRISIS_RULE = CrisisRule(
    t1_max_hours=24, t2_max_hours=72, t3_max_hours=24 * 14, preferred_bucket='building',
)


def crisis_rule_for(crisis_type: Optional[str]) -> CrisisRule:
    """Return the CrisisRule for the given crisis_type, falling back to
    DEFAULT_CRISIS_RULE for unknown / None inputs."""
    if not crisis_type:
        return DEFAULT_CRISIS_RULE
    return CRISIS_RULES.get(str(crisis_type).upper(), DEFAULT_CRISIS_RULE)


# ── Coarse crisis category — T1 privacy (docs §3.2 + §10) ──────────────
#
# T1 (Weak Signal) groups expose ONLY a coarse 4-bucket category, NOT
# the full crisis_type enum. This prevents triangulation of a single
# reporter via their specific crisis_type. T2 and T3 surface the full
# enum.

_COARSE_CRISIS_MAP: dict[str, str] = {
    'FLOOD':              'FLOOD',
    'FLOOD_FLASH':        'FLOOD',
    'FLOOD_RIVER':        'FLOOD',
    'WILDFIRE':           'FIRE',
    'EXPLOSION':          'FIRE',
    'CHEMICAL_INCIDENT':  'FIRE',
    'EARTHQUAKE':         'INFRASTRUCTURE',
    'BUILDING_COLLAPSE':  'INFRASTRUCTURE',
    'LANDSLIDE':          'INFRASTRUCTURE',
}


def coarse_category_for(crisis_type: Optional[str]) -> str:
    """Collapse a crisis_type to one of FLOOD / FIRE / INFRASTRUCTURE /
    OTHER. Used for T1 privacy projection."""
    if not crisis_type:
        return 'OTHER'
    return _COARSE_CRISIS_MAP.get(str(crisis_type).upper(), 'OTHER')

#: Default sort weights — relevance = w_count*log(count) + w_recency + w_proximity
RELEVANCE_W_COUNT = 0.4
RELEVANCE_W_RECENCY = 0.4
RELEVANCE_W_PROXIMITY = 0.2

#: How many of the most common crisis_types / damage_classes to
#: surface per group (the long tail truncates).
TOP_N_TYPES = 3


# ── Summary text matrix (i18n keys — labels resolved client-side) ──────
#
# Maps (crisis_type, damage_class) → short i18n key. Client looks up
# the key and gets a localized 1-3 word label like "Flooded" /
# "Bridge Collapsed" / "Submerged".
#
# Server returns BOTH the i18n key (for re-translation) AND the en
# fallback so the client always has something to render even if a
# locale is missing a key.
#
# The matrix is intentionally SPARSE — combos like
# (CHEMICAL_INCIDENT, MINIMAL) map to a generic key. Keeps the i18n
# surface manageable (~20 distinct keys instead of 30+).

_SUMMARY_MATRIX: dict[Tuple[str, str], Tuple[str, str]] = {
    # FLOOD
    ('FLOOD',           'MINIMAL'):  ('nearby_summary_flood_minimal',  'Light Flood'),
    ('FLOOD',           'PARTIAL'):  ('nearby_summary_flood_partial',  'Flooded'),
    ('FLOOD',           'COMPLETE'): ('nearby_summary_flood_complete', 'Submerged'),
    # EARTHQUAKE
    ('EARTHQUAKE',      'MINIMAL'):  ('nearby_summary_quake_minimal',  'Minor Tremor'),
    ('EARTHQUAKE',      'PARTIAL'):  ('nearby_summary_quake_partial',  'Damaged'),
    ('EARTHQUAKE',      'COMPLETE'): ('nearby_summary_quake_complete', 'Collapsed'),
    # WILDFIRE
    ('WILDFIRE',        'MINIMAL'):  ('nearby_summary_fire_minimal',   'Small Fire'),
    ('WILDFIRE',        'PARTIAL'):  ('nearby_summary_fire_partial',   'Fire Spreading'),
    ('WILDFIRE',        'COMPLETE'): ('nearby_summary_fire_complete',  'Burning'),
    # EXPLOSION
    ('EXPLOSION',       'MINIMAL'):  ('nearby_summary_blast_minimal',  'Loud Bang'),
    ('EXPLOSION',       'PARTIAL'):  ('nearby_summary_blast_partial',  'Blast Damage'),
    ('EXPLOSION',       'COMPLETE'): ('nearby_summary_blast_complete', 'Major Blast'),
    # CONFLICT / CIVIL_UNREST (treat similarly)
    ('CONFLICT',        'MINIMAL'):  ('nearby_summary_unrest_minimal', 'Unrest Reported'),
    ('CONFLICT',        'PARTIAL'):  ('nearby_summary_unrest_partial', 'Active Conflict'),
    ('CONFLICT',        'COMPLETE'): ('nearby_summary_unrest_severe',  'Severe Conflict'),
    ('CIVIL_UNREST',    'MINIMAL'):  ('nearby_summary_unrest_minimal', 'Unrest Reported'),
    ('CIVIL_UNREST',    'PARTIAL'):  ('nearby_summary_unrest_partial', 'Active Conflict'),
    ('CIVIL_UNREST',    'COMPLETE'): ('nearby_summary_unrest_severe',  'Severe Conflict'),
}

#: Generic fallback for unmapped (crisis, damage) combos.
_SUMMARY_GENERIC = {
    'MINIMAL':  ('nearby_summary_generic_minimal',  'Issue Reported'),
    'PARTIAL':  ('nearby_summary_generic_partial',  'Damage Reported'),
    'COMPLETE': ('nearby_summary_generic_complete', 'Major Damage'),
}

#: Empty / unknown damage_class fallback.
_SUMMARY_UNKNOWN = ('nearby_summary_unknown', 'Report Filed')


# ── Severity ordering (high → low) for "severity_max" picking ─────────
_SEVERITY_RANK = {
    'CRITICAL':   5,
    'HIGH':       4,
    'MODERATE':   3,
    'MEDIUM':     3,    # legacy alias
    'LOW':        2,
    'MINOR':      2,    # legacy alias
    'UNKNOWN':    1,
    None:         0,
}


# ── Lightweight DTOs ──────────────────────────────────────────────────

@dataclass
class NearbyReportInput:
    """Input shape from the endpoint — flat tuple of columns we need.
    Keeping it as a dataclass (not a SQLAlchemy row) keeps the
    aggregator decoupled from the ORM and trivially testable."""
    report_id: str
    device_id: Optional[str]
    status: str
    severity: Optional[str]
    crisis_type: Optional[str]
    damage_class: Optional[str]
    building_id: Optional[str]
    infrastructure_name: Optional[str]
    infrastructure_name_from_osm: Optional[bool]
    latitude: float
    longitude: float
    server_created_at: datetime


@dataclass
class NearbyGroup:
    """Output shape — strict projection. EVERY field listed here is
    cleared for the public response; no other Report column leaks.

    Phase 1 (May 2026) added: `tier`, `is_burst`, `is_acute`,
    `acute_grade`, `crisis_ttl_hours`, `coarse_crisis_category`,
    `responding_count`, `resolved_count`. The `kind` field gained
    `"resolved_recent"` as a valid value for groups whose top status is
    RESOLVED and last activity is within RESOLVED_RECENT_RETENTION_HOURS.
    See docs/NEARBY_REPORTS_PIPELINE.md §3.2 + §3.6.
    """
    id: str
    kind: str                                 # "building" | "crisis_cluster" | "resolved_recent"
    label: str
    summary: str
    summary_key: str
    count: int
    verified_count: int
    pending_count: int
    approx_distance_km: float
    centroid_lat: float
    centroid_lng: float
    latest_at: datetime
    earliest_at: datetime
    crisis_types: List[str]
    damage_classes: List[str]
    severity_max: str
    # Phase 1 additions (defaults so existing tests/call sites stay green)
    tier: str = 'verified'                    # 'weak' | 'emerging' | 'verified'
    is_burst: bool = False                    # ≥ T3_VERIFIED_FLOOR reports in BURST_WINDOW_MIN
    is_acute: bool = False                    # ≥ ACUTE_REPORTS_THRESHOLD in ACUTE_WINDOW_MIN
    acute_grade: Optional[str] = None         # 'high' | 'low' | None (Phase 2 grades trust-weighted)
    crisis_ttl_hours: int = 24                # rule-driven; mirrors CRISIS_RULES[crisis].t3_max_hours
    coarse_crisis_category: str = 'OTHER'     # 'FLOOD'|'FIRE'|'INFRASTRUCTURE'|'OTHER' — for T1 privacy
    responding_count: int = 0                 # status RESPONDING surfaced (Phase 1)
    resolved_count: int = 0                   # status RESOLVED in the RESOLVED-24h retention window


# ── Public helpers ────────────────────────────────────────────────────

def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Distance in kilometres between two lat/lng pairs.

    Mirrors app/services/geo_clustering.py:calculate_distance() but
    returns kilometres (that helper returns metres). We could call
    `calculate_distance(...) / 1000` but a local implementation keeps
    this module independent of the clustering service's import graph.
    """
    R = 6371.0   # km
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lng2 - lng1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def bbox_for_radius(lat: float, lng: float, radius_km: float) -> Tuple[float, float, float, float]:
    """Pre-filter bounding box for a given radius. Returns
    (lat_min, lat_max, lng_min, lng_max). Used to push the radius
    filter down to the indexed (latitude, longitude) columns BEFORE
    the haversine pass (which can't use an index).

    cos(lat) handles the meridian convergence near the poles; at
    extreme latitudes the bbox widens. At lat=89° the lng bbox is
    ~57× wider than the lat bbox; the haversine post-filter still
    nails the actual radius."""
    lat_delta = radius_km / 111.32                    # km per degree of latitude
    cos_lat = max(0.05, math.cos(math.radians(lat)))  # avoid /0 at poles
    lng_delta = radius_km / (111.32 * cos_lat)
    return (lat - lat_delta, lat + lat_delta,
            lng - lng_delta, lng + lng_delta)


# ── Aggregation ───────────────────────────────────────────────────────

def _summary_for(crisis_type: Optional[str], damage_class: Optional[str]) -> Tuple[str, str]:
    """Pick the (i18n_key, en_fallback) tuple for a given crisis+damage
    combo. Falls back through the matrix → generic → unknown."""
    if not damage_class:
        return _SUMMARY_UNKNOWN
    crisis_key = (crisis_type or '').upper()
    damage_key = damage_class.upper()
    if (crisis_key, damage_key) in _SUMMARY_MATRIX:
        return _SUMMARY_MATRIX[(crisis_key, damage_key)]
    return _SUMMARY_GENERIC.get(damage_key, _SUMMARY_UNKNOWN)


def _label_for(reports: List[NearbyReportInput], kind: str, fallback_lat: float, fallback_lng: float) -> str:
    """Pick a user-facing label for the group.

    Priority order:
      1. Most common OSM-verified infrastructure_name (i.e. one where
         infrastructure_name_from_osm == True). High confidence.
      2. Most common user-typed infrastructure_name. Medium confidence.
      3. For crisis-clusters with no building data: "Near {lat},{lng}"
         rounded to 3 decimals so we don't leak the centroid below
         the privacy-rounding floor.
    """
    osm_verified = defaultdict(int)
    user_typed = defaultdict(int)
    for r in reports:
        name = (r.infrastructure_name or '').strip()
        if not name:
            continue
        if r.infrastructure_name_from_osm:
            osm_verified[name] += 1
        else:
            user_typed[name] += 1
    if osm_verified:
        return max(osm_verified.items(), key=lambda kv: kv[1])[0]
    if user_typed:
        return max(user_typed.items(), key=lambda kv: kv[1])[0]
    # Crisis cluster fallback — geocoded street name would be nicer but
    # we don't want to fire a reverse-geocode call per group here. Round
    # to 3dp so the centroid is no more precise than the client-side
    # rounding policy (~110m).
    return f"Near {round(fallback_lat, 3)}, {round(fallback_lng, 3)}"


def _most_common_n(items: List[str], n: int) -> List[str]:
    """Top-N by frequency, descending. Stable across duplicates."""
    counts: dict[str, int] = defaultdict(int)
    for item in items:
        if item:
            counts[item] += 1
    if not counts:
        return []
    return [v for v, _ in sorted(counts.items(), key=lambda kv: -kv[1])[:n]]


def _max_severity(items: List[Optional[str]]) -> str:
    """Highest-rank severity in the bucket. Defaults to 'UNKNOWN'."""
    if not items:
        return 'UNKNOWN'
    return max(items, key=lambda s: _SEVERITY_RANK.get(s, 0)) or 'UNKNOWN'


def _truncate_to_minute(dt: datetime) -> datetime:
    """Strip sub-minute precision — privacy invariant for output
    timestamps. Sub-minute could leak per-report ordering."""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.replace(second=0, microsecond=0)


def _classify_tier(
    *,
    n_devices: int,
    minutes_since_earliest: float,
    has_verified_responder: bool = False,
) -> str:
    """Return the tier label ('weak' | 'emerging' | 'verified') for a
    bucket given its unique-device count, age, and whether any of its
    reports came from a verified-responder device.

    Phase 1 rules (docs §3.2):
      • T1 (weak)     — 1 unique device, < T1_WEAK_STALE_MIN minutes old
      • T2 (emerging) — 2 unique devices, OR 1 device + ≥ T1_WEAK_STALE_MIN
                         min stale, OR ≥ 1 verified responder
      • T3 (verified) — ≥ T3_VERIFIED_FLOOR (= 3) unique devices

    `has_verified_responder` is the Phase-3 hook — for now it's always
    False (no trust scoring yet), but the signature accepts it so the
    Phase-3 schema migration doesn't reshape this function.
    """
    if n_devices >= T3_VERIFIED_FLOOR:
        return 'verified'
    if n_devices >= T2_EMERGING_FLOOR or has_verified_responder:
        return 'emerging'
    if n_devices == 1 and minutes_since_earliest >= T1_WEAK_STALE_MIN:
        return 'emerging'
    return 'weak'


def _is_burst(timestamps: List[datetime], window_min: int = BURST_WINDOW_MIN,
              threshold: int = T3_VERIFIED_FLOOR) -> bool:
    """≥ `threshold` reports within `window_min` minutes → burst.
    Simple sliding-window check; O(n log n) on small bucket sizes."""
    if len(timestamps) < threshold:
        return False
    sorted_ts = sorted(timestamps)
    window_delta = timedelta(minutes=window_min)
    for i in range(len(sorted_ts) - threshold + 1):
        if sorted_ts[i + threshold - 1] - sorted_ts[i] <= window_delta:
            return True
    return False


def _is_acute(timestamps: List[datetime]) -> bool:
    """≥ ACUTE_REPORTS_THRESHOLD reports within ACUTE_WINDOW_MIN
    minutes. Phase 2 introduces HIGH/LOW grading from trust signals."""
    return _is_burst(
        timestamps,
        window_min=ACUTE_WINDOW_MIN,
        threshold=ACUTE_REPORTS_THRESHOLD,
    )


def _summarize_bucket(
    bucket: List[NearbyReportInput],
    kind: str,
    user_lat: float,
    user_lng: float,
    group_id: str,
    *,
    now: Optional[datetime] = None,
) -> NearbyGroup:
    """Reduce a list of reports to a single group projection.

    Applies the per-device contribution cap to `count` so 50 spam
    submissions from one bot don't inflate group size. `verified_count`
    + `pending_count` + `responding_count` + `resolved_count` are
    computed on the FULL bucket since they're aggregate counts (the cap
    only protects against device-volume distortion of the headline
    number).

    Phase 1 (May 2026) additions:
      • tier classification via `_classify_tier` (docs §3.2)
      • is_burst / is_acute temporal flags (docs §3.5)
      • crisis_ttl_hours from CRISIS_RULES (docs §3.3)
      • coarse_crisis_category for T1 privacy (docs §3.2 + §10)
      • responding_count, resolved_count (docs §3.6)
      • `kind` may upgrade to 'resolved_recent' if the bucket's top
        status is RESOLVED and latest activity is within retention
    """
    now = now or datetime.now(timezone.utc)

    # Per-device cap: bucket reports by device, take min(actual, cap)
    by_device: dict[Optional[str], int] = defaultdict(int)
    for r in bucket:
        by_device[r.device_id] += 1
    capped_count = sum(
        min(actual, PER_DEVICE_CONTRIBUTION_CAP) if d else actual
        for d, actual in by_device.items()
    )
    # Use the larger of (capped_count, len(unique devices)) — a 3-device
    # group of 3 reports should still surface as count=3, not count=1.
    n_devices = len([d for d in by_device if d])
    count = max(capped_count, n_devices, 1)

    # Aggregate counts split by status — sums, not per-report breakdowns.
    verified = sum(1 for r in bucket if r.status == 'VERIFIED')
    pending = sum(1 for r in bucket if r.status == 'PENDING')
    responding = sum(1 for r in bucket if r.status == 'RESPONDING')
    resolved = sum(1 for r in bucket if r.status == 'RESOLVED')

    # Centroid = arithmetic mean of (lat, lng) — privacy-safe because
    # the mean of N reports doesn't reveal any individual location.
    centroid_lat = sum(r.latitude for r in bucket) / len(bucket)
    centroid_lng = sum(r.longitude for r in bucket) / len(bucket)
    distance_km = round(haversine_km(user_lat, user_lng, centroid_lat, centroid_lng), 2)

    # Summary text — use the most common crisis × most common damage
    # combo as the representative summary.
    crisis_types = _most_common_n([r.crisis_type for r in bucket], TOP_N_TYPES)
    damage_classes = _most_common_n([r.damage_class for r in bucket], TOP_N_TYPES)
    top_crisis = crisis_types[0] if crisis_types else None
    top_damage = damage_classes[0] if damage_classes else None
    summary_key, summary_fallback = _summary_for(top_crisis, top_damage)

    label = _label_for(bucket, kind, centroid_lat, centroid_lng)

    timestamps = [r.server_created_at for r in bucket if r.server_created_at]
    latest = _truncate_to_minute(max(timestamps)) if timestamps else _truncate_to_minute(now)
    earliest = _truncate_to_minute(min(timestamps)) if timestamps else latest

    # Tier classification — minutes since earliest report drives the
    # "1-device + stale → T2" rule.
    earliest_for_tier = min(timestamps) if timestamps else now
    minutes_since_earliest = max(0.0, (now - earliest_for_tier).total_seconds() / 60.0)
    tier = _classify_tier(
        n_devices=n_devices,
        minutes_since_earliest=minutes_since_earliest,
        has_verified_responder=False,        # Phase 3 wires this up
    )

    # Temporal-cluster flags.
    burst = _is_burst(timestamps) if timestamps else False
    acute = _is_acute(timestamps) if timestamps else False
    # Phase 2 will set acute_grade based on trust-weighted device mix;
    # Phase 1 leaves it at None to signal "ungraded yet".
    acute_grade: Optional[str] = None
    if acute:
        acute_grade = 'low'   # Phase-1 default; Phase 2 grades HIGH/LOW

    # Crisis-rule lookup for TTL hint to the client.
    rule = crisis_rule_for(top_crisis)
    ttl_hours = rule.t3_max_hours

    # Coarse crisis category — used by the endpoint to redact crisis_types
    # for T1 groups before serialization (docs §10).
    coarse = coarse_category_for(top_crisis)

    # RESOLVED-recent re-tagging — if the bucket's dominant status is
    # RESOLVED and the latest activity is within retention, flip `kind`
    # so the client renders it in the separate "Recently Resolved"
    # subtotal line (docs §3.6 + §4.1) instead of contributing to
    # active counts.
    if resolved > (verified + pending + responding):
        age_hours = (now - latest).total_seconds() / 3600.0
        if age_hours <= RESOLVED_RECENT_RETENTION_HOURS:
            kind = 'resolved_recent'

    return NearbyGroup(
        id=group_id,
        kind=kind,
        label=label,
        summary=summary_fallback,
        summary_key=summary_key,
        count=count,
        verified_count=verified,
        pending_count=pending,
        approx_distance_km=distance_km,
        centroid_lat=round(centroid_lat, 4),
        centroid_lng=round(centroid_lng, 4),
        latest_at=latest,
        earliest_at=earliest,
        crisis_types=crisis_types,
        damage_classes=damage_classes,
        severity_max=_max_severity([r.severity for r in bucket]),
        tier=tier,
        is_burst=burst,
        is_acute=acute,
        acute_grade=acute_grade,
        crisis_ttl_hours=ttl_hours,
        coarse_crisis_category=coarse,
        responding_count=responding,
        resolved_count=resolved,
    )


def _bucket_key_for(report: NearbyReportInput, group_by: str) -> str:
    """Compute the bucket key for a report under the chosen group_by
    strategy.

    'building' (default):
      - building_id when present → most precise grouping (OSM-tagged)
      - else 0.002° grid cell × crisis_type → "near same street, same
        type" fallback

    'crisis_type':
      - crisis_type only — coarser, broader buckets
    """
    if group_by == 'crisis_type':
        return f"crisis_{report.crisis_type or 'OTHER'}"

    # default: 'building'
    if report.building_id:
        return f"building_{report.building_id}"
    # Fallback: grid cell × crisis_type
    lat_cell = math.floor(report.latitude / FALLBACK_CELL_SIZE_DEG) * FALLBACK_CELL_SIZE_DEG
    lng_cell = math.floor(report.longitude / FALLBACK_CELL_SIZE_DEG) * FALLBACK_CELL_SIZE_DEG
    return f"cell_{lat_cell:.4f}_{lng_cell:.4f}_{report.crisis_type or 'OTHER'}"


def _relevance_score(group: NearbyGroup, now: datetime, max_radius_km: float) -> float:
    """Higher = more relevant. Combines:
      - count (log-scaled so 100 reports doesn't 100× outrank 10)
      - recency (decay over hours since latest_at)
      - proximity (closer = better, normalised to caller's radius)
    """
    count_score = math.log(group.count + 1)
    hours_ago = max(0.01, (now - group.latest_at).total_seconds() / 3600)
    recency_score = 1.0 / hours_ago   # 1.0 at 1h, 0.1 at 10h, ...
    proximity_score = max(0.0, 1.0 - (group.approx_distance_km / max(0.1, max_radius_km)))
    return (
        RELEVANCE_W_COUNT * count_score
        + RELEVANCE_W_RECENCY * recency_score
        + RELEVANCE_W_PROXIMITY * proximity_score
    )


def aggregate_nearby(
    reports: List[NearbyReportInput],
    user_lat: float,
    user_lng: float,
    radius_km: float,
    group_by: str = 'building',
    max_groups: int = 20,
    *,
    min_group_size: int = MIN_GROUP_REPORTS,
) -> List[NearbyGroup]:
    """Bucket → classify tier → summarize → sort by relevance → top-N.

    Phase 1 (May 2026) — was "suppress small groups (k-anonymity)";
    now surfaces every bucket and tags each with a tier so the
    endpoint can slice by caller identity (citizen vs admin vs
    deployment-T1-visibility flag). The privacy floor still holds:
    T1 groups expose ONLY coarse crisis category (no full enum), no
    PII, only group centroids. See docs §3.2 + §10.

    Caller is responsible for:
      - Filtering by status (caller-driven; aggregator now accepts
        VERIFIED / PENDING / RESPONDING / RESOLVED-within-retention)
      - Filtering by max_age_hours (overall ceiling)
      - Pre-filtering to the bbox (so the input list is already small)
      - Computing the actual haversine distance to drop reports
        outside the exact `radius_km`
      - Slicing the returned list by tier per caller's visibility
        (e.g., citizen + CRISP_CITIZEN_T1_VISIBILITY=false → drop
        tier='weak')

    This function ONLY groups + projects + classifies tier.
    """
    if not reports:
        return []

    # 1. Bucket
    buckets: dict[str, List[NearbyReportInput]] = defaultdict(list)
    for r in reports:
        buckets[_bucket_key_for(r, group_by)].append(r)

    # 2. Pre-filter — drop buckets that fall below the (now lowered)
    # min_group_size. Default is 1 (T1 floor), so this is a no-op
    # for the default call. Callers can pass min_group_size=3 to
    # restore the legacy "verified-only" behaviour.
    pre_filtered = [b for b in buckets.values() if len(b) >= min_group_size]

    # 3. Summarize each surviving bucket — tier classification happens
    # inside `_summarize_bucket`.
    now = datetime.now(timezone.utc)
    groups = []
    for bucket in pre_filtered:
        # Pick `kind` based on whether the bucket has a real building_id.
        # `_summarize_bucket` may upgrade `kind` to 'resolved_recent' if
        # the bucket's dominant status is RESOLVED within retention.
        first = bucket[0]
        if group_by == 'crisis_type':
            kind = 'crisis_cluster'
            gid = f"g_crisis_{first.crisis_type or 'OTHER'}"
        elif first.building_id:
            kind = 'building'
            gid = f"g_building_{first.building_id}"
        else:
            kind = 'crisis_cluster'
            gid = f"g_cluster_{_bucket_key_for(first, group_by)}"
        groups.append(_summarize_bucket(bucket, kind, user_lat, user_lng, gid, now=now))

    # 4. Per-tier privacy projection — T1 (weak) groups have their
    # `crisis_types` collapsed to `[coarse_crisis_category]` so the
    # full enum can't leak from a single-reporter group (docs §10).
    # T2/T3 surface the full enum.
    for g in groups:
        if g.tier == 'weak':
            g.crisis_types = [g.coarse_crisis_category]

    # 5. Relevance sort → top-N. Burst + acute groups bubble up.
    def _sort_key(g: NearbyGroup) -> float:
        score = _relevance_score(g, now, radius_km)
        if g.is_acute:
            score += 10.0       # always above non-acute
        if g.is_burst:
            score += 1.0
        return -score
    groups.sort(key=_sort_key)
    return groups[:max_groups]
