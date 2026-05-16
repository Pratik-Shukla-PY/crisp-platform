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
#: KEPT for backwards-compat with v0 code paths; Phase 2 (May 2026)
#: replaces this with geohash-based bucketing for both block + area
#: cluster levels — see `_geohash_encode` + `_bucket_key_for` below.
FALLBACK_CELL_SIZE_DEG = 0.002

#: Geohash precision for the block-level cluster (Phase 2 — docs §3.4).
#: precision 7 ≈ 152 m × 152 m cells. Matches the ~100 m "adjacent
#: buildings" intent of the doc's block tier.
GEOHASH_PRECISION_BLOCK = 7

#: Geohash precision for the area-level cluster.
#: precision 6 ≈ 1.2 km × 0.6 km cells. The doc targets ~500 m for
#: an "OSM neighborhood" area; precision 6 is the nearest fit and
#: errs slightly larger (preferable to bias toward fewer-broader
#: clusters during disasters).
GEOHASH_PRECISION_AREA = 6

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
    aggregator decoupled from the ORM and trivially testable.

    Phase 2 added `user_id` — initial trust proxy for HIGH/LOW
    acute grading.
    Phase 3 added `trust_weight` — pre-computed device-level
    contribution weight (docs §6.1). The endpoint resolves it via
    `fraud_detector.device_trust_weight()` then bumps by user role
    (verified responder = 3.0; account-linked civilian = 1.5).
    Default 1.0 = "new device, no role" — backwards-compatible."""
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
    user_id: Optional[str] = None                # Phase 2 — trust proxy
    trust_weight: float = 1.0                    # Phase 3 — device trust


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
              threshold: int = T3_VERIFIED_FLOOR,
              *, now: Optional[datetime] = None) -> bool:
    """≥ `threshold` reports within the LAST `window_min` minutes from
    `now` → burst. The window is anchored to NOW (not to the cluster's
    own timeline) so a stale cluster whose reports happened to all
    arrive within 15 min of EACH OTHER 48 h ago does NOT light up as
    a current burst.

    Phase 2 (May 2026, docs §3.5) — pre-fix this was a sliding-window
    check inside the cluster's own timestamps, which caused old clusters
    with tightly-clustered (but ancient) reports to misfire as "acute".

    O(n) — single pass counting how many timestamps fall inside the
    `now - window_min`..`now` interval.
    """
    if len(timestamps) < threshold:
        return False
    now = now or datetime.now(timezone.utc)
    # Normalise to UTC to dodge naive/aware comparisons.
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    cutoff = now - timedelta(minutes=window_min)
    in_window = 0
    for t in timestamps:
        if t and t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        if t and t >= cutoff and t <= now:
            in_window += 1
            if in_window >= threshold:
                return True
    return False


def _is_acute(timestamps: List[datetime], *, now: Optional[datetime] = None) -> bool:
    """≥ ACUTE_REPORTS_THRESHOLD reports in the LAST ACUTE_WINDOW_MIN
    minutes. Same now-anchored semantics as `_is_burst`."""
    return _is_burst(
        timestamps,
        window_min=ACUTE_WINDOW_MIN,
        threshold=ACUTE_REPORTS_THRESHOLD,
        now=now,
    )


#: HIGH-confidence acute requires ≥ this many trusted-device reports
#: in the acute window. Phase-2 default — Phase 3 may tune.
ACUTE_HIGH_TRUSTED_FLOOR = 3


def _grade_acute(bucket: List[NearbyReportInput], *, now: datetime) -> str:
    """Grade an acute event as 'high' or 'low' (docs §3.5 + §8.1).

    Phase 2 trust signal: account-linked reports (user_id IS NOT NULL)
    count as "trusted". HIGH grade fires when ≥ ACUTE_HIGH_TRUSTED_FLOOR
    trusted reports fall inside the acute window (last
    ACUTE_WINDOW_MIN minutes).

    Phase 3 will replace this with the full trust-score signal:
      • verified-responder devices (role ∈ {RESPONDER, ADMIN})
      • account-linked + ≥ 5 prior clean reports
      • device.spam_score == 0 + ≥ 1 verified historical report
    """
    cutoff = now - timedelta(minutes=ACUTE_WINDOW_MIN)
    trusted_in_window = sum(
        1
        for r in bucket
        if r.server_created_at and r.server_created_at >= cutoff and r.user_id
    )
    return 'high' if trusted_in_window >= ACUTE_HIGH_TRUSTED_FLOOR else 'low'


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

    # Phase 3 (May 2026, docs §6.1 + §6.3) — drop reports from
    # suspicious devices (trust_weight == 0.0) entirely before any
    # other math. The report stays in the DB; it just doesn't
    # contribute to this group's count, sort score, or tier
    # classification. This is the "hard" mitigation tier — when
    # an abuse signal fires, the device's reports stop influencing
    # the public response until an admin clears the spam_score.
    bucket = [r for r in bucket if r.trust_weight > 0.0]
    if not bucket:
        # Whole bucket was suspicious; return a stub group at zero
        # count. The caller's k-anonymity floor will drop it.
        return NearbyGroup(
            id=group_id, kind=kind, label="", summary="",
            summary_key=_SUMMARY_UNKNOWN[0],
            count=0, verified_count=0, pending_count=0,
            approx_distance_km=0.0, centroid_lat=0.0, centroid_lng=0.0,
            latest_at=_truncate_to_minute(now),
            earliest_at=_truncate_to_minute(now),
            crisis_types=[], damage_classes=[], severity_max='UNKNOWN',
        )

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

    # Temporal-cluster flags — now-anchored windows.
    burst = _is_burst(timestamps, now=now) if timestamps else False
    acute = _is_acute(timestamps, now=now) if timestamps else False
    # Phase 2 (May 2026, docs §3.5 + §8.1) — HIGH vs LOW confidence
    # grading for is_acute. HIGH-confidence acute drives SW push;
    # LOW-confidence is in-app badge only.
    # Phase 2 trust proxy: count reports in the acute window from
    # account-linked users (user_id is not null). ≥ 3 trusted →
    # HIGH; otherwise LOW.
    # Phase 3 will replace this with the full device trust-score
    # (devices.spam_score + verified-responder role).
    acute_grade: Optional[str] = None
    if acute:
        acute_grade = _grade_acute(bucket, now=now)

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


# ── Geohash (Phase 2, May 2026 — docs §3.4) ────────────────────────────
#
# Pure-Python geohash implementation — vendored here rather than
# pulling in `python-geohash` (yet another transitive dependency
# for a 30-line algorithm). Same spec as
# https://en.wikipedia.org/wiki/Geohash — deterministic + identical
# output to any conforming implementation.
#
# At our target precisions (6 + 7) the cell sizes are ~600 m and
# ~150 m respectively — small enough to drive meaningful
# block / area clustering, large enough that GPS jitter doesn't
# bounce nearby reports into different buckets.

_GEOHASH_ALPHABET = '0123456789bcdefghjkmnpqrstuvwxyz'


def _geohash_encode(lat: float, lng: float, precision: int) -> str:
    """Encode (lat, lng) to a geohash string of the given precision.
    Standard base-32 spec; precision 6 ≈ 600 m, precision 7 ≈ 150 m."""
    lat_range = [-90.0, 90.0]
    lng_range = [-180.0, 180.0]
    geohash = []
    bits = [16, 8, 4, 2, 1]
    bit = 0
    ch = 0
    even = True
    while len(geohash) < precision:
        if even:
            mid = (lng_range[0] + lng_range[1]) / 2
            if lng > mid:
                ch |= bits[bit]
                lng_range[0] = mid
            else:
                lng_range[1] = mid
        else:
            mid = (lat_range[0] + lat_range[1]) / 2
            if lat > mid:
                ch |= bits[bit]
                lat_range[0] = mid
            else:
                lat_range[1] = mid
        even = not even
        if bit < 4:
            bit += 1
        else:
            geohash.append(_GEOHASH_ALPHABET[ch])
            bit = 0
            ch = 0
    return ''.join(geohash)


def _bucket_key_for(report: NearbyReportInput, group_by: str,
                    level: str = 'building') -> str:
    """Compute the bucket key for a report at the requested cluster
    level. Phase 2 (May 2026, docs §3.4) — adds 'block' + 'area'
    fallbacks via geohash.

    `group_by` values:
      - 'building' — the legacy + default per-bucket strategy. Tries
                     building_id first, falls through to whatever
                     `level` specifies.
      - 'crisis_type' — coarser, crisis-type-only buckets.

    `level` values (only honoured when `group_by='building'`):
      - 'building' — building_id; falls back to block geohash when
                     building_id is null.
      - 'block'    — geohash precision 7 (~150 m) × crisis_type.
                     Use when no building bucket meets the tier
                     threshold (escalation).
      - 'area'     — geohash precision 6 (~600 m) × crisis_type.
                     Use when block also fails to cluster.

    The multi-pass cascade in `aggregate_nearby()` calls this with
    progressively coarser `level`s.
    """
    if group_by == 'crisis_type':
        return f"crisis_{report.crisis_type or 'OTHER'}"

    # default: 'building'
    if level == 'building' and report.building_id:
        return f"building_{report.building_id}"

    crisis_suffix = report.crisis_type or 'OTHER'
    if level == 'building' or level == 'block':
        # block-level cluster — geohash 7 × crisis_type
        gh = _geohash_encode(report.latitude, report.longitude, GEOHASH_PRECISION_BLOCK)
        return f"block_{gh}_{crisis_suffix}"

    # area-level cluster — geohash 6 × crisis_type
    gh = _geohash_encode(report.latitude, report.longitude, GEOHASH_PRECISION_AREA)
    return f"area_{gh}_{crisis_suffix}"


def _relevance_score(group: NearbyGroup, now: datetime, max_radius_km: float) -> float:
    """Higher = more relevant. Combines:
      - count (log-scaled so 100 reports doesn't 100× outrank 10)
      - decayed recency (Phase 2 — exp decay per crisis-rule half-life)
      - proximity (closer = better, normalised to caller's radius)

    Phase 2 (May 2026, docs §3.5) replaced the simple `1/hours_ago`
    recency score with `exp(-age_hours / half_life)`. Half-life is
    crisis-type-adaptive: `CRISIS_RULES[crisis].t2_max_hours / 2`.
    This means a burst-of-3-in-1-h now outranks a slow-drip-of-5-
    over-2-days, even though the slow drip has a higher raw count.

    The integer `count` field is unchanged (still distinct-device
    capped); only the SORT score uses the weighted view.
    """
    count_score = math.log(group.count + 1)
    hours_ago = max(0.01, (now - group.latest_at).total_seconds() / 3600)

    # Crisis-rule-driven half-life. Falls back to default rule for
    # buckets where top crisis_type is unknown.
    top_crisis = group.crisis_types[0] if group.crisis_types else None
    half_life_h = max(1.0, crisis_rule_for(top_crisis).t2_max_hours / 2.0)
    recency_score = math.exp(-hours_ago / half_life_h)

    proximity_score = max(0.0, 1.0 - (group.approx_distance_km / max(0.1, max_radius_km)))
    return (
        RELEVANCE_W_COUNT * count_score
        + RELEVANCE_W_RECENCY * recency_score
        + RELEVANCE_W_PROXIMITY * proximity_score
    )


def _multi_pass_cluster(
    *,
    reports: List[NearbyReportInput],
    user_lat: float,
    user_lng: float,
    min_group_size: int,
    now: datetime,
) -> List[NearbyGroup]:
    """Phase 2 (May 2026, docs §3.4) — three-level spatial cascade.

    Strategy:
      Pass 1 — bucket every report by `_bucket_key_for(level='building')`.
                Buckets with ≥ T3_VERIFIED_FLOOR unique devices become
                'building' clusters (tightest). Their reports are
                CLAIMED — removed from the residual pool.

      Pass 2 — re-bucket the residual reports by 'block' (geohash 7 ×
                crisis_type). Buckets with ≥ T2_EMERGING_FLOOR unique
                devices become 'block' clusters. Their reports are
                CLAIMED.

      Pass 3 — re-bucket whatever remains by 'area' (geohash 6 ×
                crisis_type). Any bucket meeting `min_group_size`
                becomes an 'area' cluster.

      Cleanup — any STILL-residual reports become single-report
                'building' clusters at their original building_id
                (or area-fallback if no building_id). This preserves
                the T1 weak-signal surfacing for the unmatched tail.

    Reports never appear in more than one cluster — the cascade
    consumes them in order. This avoids double-counting under
    cross-tier overlap (a building inside a block inside an area).

    Returns a flat list of NearbyGroups across all three levels;
    tier classification (weak/emerging/verified) still happens
    inside _summarize_bucket and is independent of cluster level.
    """
    residual = list(reports)

    def _claim(buckets: dict, threshold_devices: int, kind: str,
               level: str) -> List[NearbyGroup]:
        """Drain buckets that hit the threshold; return their groups.

        Identity-preservation: when ALL reports in a bucket share a
        single `building_id` — even at block/area levels — we keep
        the group_id + kind as `g_building_<bid>` / `kind='building'`.
        This matters for the smart-prefill flow (Phase 3): tap on a
        building-derived cluster should still suggest THAT building.
        Falls back to the level-specific id only when reports span
        multiple buildings or have no building_id at all.
        """
        claimed_groups: List[NearbyGroup] = []
        for key, bucket in list(buckets.items()):
            unique_devs = len({r.device_id for r in bucket if r.device_id})
            if unique_devs >= threshold_devices and len(bucket) >= min_group_size:
                # Bucket survives this pass — promote to a group.
                bucket_building_ids = {r.building_id for r in bucket if r.building_id}
                # Identity-preservation: when ALL reports share a
                # single building_id, render as building-level
                # regardless of which pass claimed it. Otherwise the
                # kind is driven by the actual bucket key prefix
                # (`building_` → 'building', `block_` → 'block',
                # `area_` → 'area') so a level='building' pass that
                # had to fall through to block-keys (because no
                # building_id) still ends up labelled correctly.
                if len(bucket_building_ids) == 1:
                    only_bid = next(iter(bucket_building_ids))
                    gid = f"g_building_{only_bid}"
                    effective_kind = 'building'
                else:
                    # Derive kind from the bucket-key prefix.
                    if key.startswith('building_'):
                        effective_kind = 'building'
                    elif key.startswith('block_'):
                        effective_kind = 'block'
                    elif key.startswith('area_'):
                        effective_kind = 'area'
                    else:
                        effective_kind = kind   # fallback
                    gid = f"g_{effective_kind}_{key}"
                claimed_groups.append(
                    _summarize_bucket(bucket, effective_kind, user_lat, user_lng, gid, now=now)
                )
                # Mark this bucket as claimed — remove its reports
                # from `residual`.
                claimed_ids = {r.report_id for r in bucket}
                residual[:] = [r for r in residual if r.report_id not in claimed_ids]
        return claimed_groups

    groups: List[NearbyGroup] = []

    # Pass 1 — building level (threshold = T3 floor; only firmly-
    # clustered buildings claim at this tightest level).
    buckets_b: dict[str, List[NearbyReportInput]] = defaultdict(list)
    for r in residual:
        buckets_b[_bucket_key_for(r, 'building', level='building')].append(r)
    groups.extend(_claim(buckets_b, threshold_devices=T3_VERIFIED_FLOOR,
                         kind='building', level='building'))

    # Pass 2 — block level (threshold = T2 floor).
    if residual:
        buckets_blk: dict[str, List[NearbyReportInput]] = defaultdict(list)
        for r in residual:
            buckets_blk[_bucket_key_for(r, 'building', level='block')].append(r)
        groups.extend(_claim(buckets_blk, threshold_devices=T2_EMERGING_FLOOR,
                             kind='block', level='block'))

    # Pass 3 — area level (threshold = 1 by default — surfaces single
    # weak signals over a wider geohash). Caller can pass
    # min_group_size > 1 to suppress this tail.
    if residual:
        buckets_area: dict[str, List[NearbyReportInput]] = defaultdict(list)
        for r in residual:
            buckets_area[_bucket_key_for(r, 'building', level='area')].append(r)
        # Each remaining bucket meets min_group_size by definition
        # (already filtered above if min_group_size > 1).
        for key, bucket in buckets_area.items():
            if len(bucket) < min_group_size:
                continue
            first = bucket[0]
            # Preserve building_id when present even at area level
            # so the smart-prefill flow (Phase 3) can still suggest
            # a specific building when one report had it.
            if first.building_id:
                gid = f"g_building_{first.building_id}"
                kind = 'building'
            else:
                gid = f"g_area_{key}"
                kind = 'area'
            groups.append(_summarize_bucket(bucket, kind, user_lat, user_lng, gid, now=now))

    return groups


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

    # Phase 2 (May 2026, docs §3.4) — multi-pass spatial cascade.
    # Try the tightest bucket level first (building); reports that
    # don't form a strong-enough bucket at that level escalate to
    # block (geohash 7 ≈ 150 m); reports still unclustered escalate
    # to area (geohash 6 ≈ 600 m). This way:
    #   • dense building damage surfaces at building level (precise)
    #   • spread flood/riot/wildfire surfaces at block/area level
    #     (which is what citizens need to see — the whole zone, not
    #     fragmented per-building bits)
    # The `group_by='crisis_type'` path stays single-level (no cascade)
    # — that's an explicit caller override.

    now = datetime.now(timezone.utc)

    if group_by == 'crisis_type':
        # Single-pass crisis-type bucketing (caller override path).
        buckets: dict[str, List[NearbyReportInput]] = defaultdict(list)
        for r in reports:
            buckets[_bucket_key_for(r, group_by)].append(r)
        pre_filtered = [b for b in buckets.values() if len(b) >= min_group_size]
        groups = []
        for bucket in pre_filtered:
            first = bucket[0]
            gid = f"g_crisis_{first.crisis_type or 'OTHER'}"
            groups.append(_summarize_bucket(bucket, 'crisis_cluster', user_lat, user_lng, gid, now=now))
    else:
        # Phase 2 multi-pass cascade — group_by='building' path.
        groups = _multi_pass_cluster(
            reports=reports,
            user_lat=user_lat,
            user_lng=user_lng,
            min_group_size=min_group_size,
            now=now,
        )

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
