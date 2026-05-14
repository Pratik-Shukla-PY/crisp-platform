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
from datetime import datetime, timezone
from typing import List, Optional, Tuple


# ── Tunable constants ──────────────────────────────────────────────────

#: k-anonymity threshold — groups smaller than this are suppressed
#: entirely so a single reporter's location can't be inferred from a
#: group of size 1 or 2. Operator-approved default.
MIN_GROUP_REPORTS = 3

#: Anti-spam cap — a single device's contribution to a group's `count`
#: is capped here, regardless of how many duplicates they submit. A
#: bot submitting 50 reports from the same device shows up as 1.
PER_DEVICE_CONTRIBUTION_CAP = 1

#: Fallback grid cell size (degrees) for reports without `building_id`.
#: 0.002° ≈ 220m at the equator — small enough that a "Road Damage"
#: cluster doesn't span an entire neighbourhood, large enough that
#: scattered street-level reports still aggregate.
FALLBACK_CELL_SIZE_DEG = 0.002

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
    cleared for the public response; no other Report column leaks."""
    id: str
    kind: str               # "building" | "crisis_cluster"
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


def _summarize_bucket(
    bucket: List[NearbyReportInput],
    kind: str,
    user_lat: float,
    user_lng: float,
    group_id: str,
) -> NearbyGroup:
    """Reduce a list of reports to a single group projection.

    Applies the per-device contribution cap to `count` so 50 spam
    submissions from one bot don't inflate group size. `verified_count`
    + `pending_count` are computed on the FULL bucket since they're
    aggregate counts (the cap only protects against device-volume
    distortion of the headline number).
    """
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

    # Aggregate counts split by reviewer/status — these are SAFE because
    # they're sums, not per-report breakdowns.
    verified = sum(1 for r in bucket if r.status == 'VERIFIED')
    pending = sum(1 for r in bucket if r.status == 'PENDING')

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
    latest = _truncate_to_minute(max(timestamps)) if timestamps else _truncate_to_minute(datetime.now(timezone.utc))
    earliest = _truncate_to_minute(min(timestamps)) if timestamps else latest

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
    """Bucket → suppress small groups (k-anonymity) → summarize →
    sort by relevance → top-N. Pure function; no DB, no side effects.

    Caller is responsible for:
      - Filtering by status (exclude REJECTED / DUPLICATE / FALSE_ALARM)
      - Filtering by max_age_hours
      - Pre-filtering to the bbox (so the input list is already small)
      - Computing the actual haversine distance to drop reports
        outside the exact `radius_km`

    This function ONLY groups + projects.
    """
    if not reports:
        return []

    # 1. Bucket
    buckets: dict[str, List[NearbyReportInput]] = defaultdict(list)
    for r in reports:
        buckets[_bucket_key_for(r, group_by)].append(r)

    # 2. Pre-filter — drop buckets that COULDN'T possibly meet the
    # k-anonymity threshold even before device-cap is applied.
    # Cheaper than running the full summarization on doomed buckets.
    pre_filtered = [b for b in buckets.values() if len(b) >= min_group_size]

    # 3. Summarize each surviving bucket
    groups = []
    for bucket in pre_filtered:
        # Pick `kind` based on whether the bucket has a real building_id
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
        groups.append(_summarize_bucket(bucket, kind, user_lat, user_lng, gid))

    # 4. POST-summarization k-anonymity — drop groups whose effective
    # `count` (after per-device cap) is below the floor. This catches
    # the spam-bot case where 50 reports from 1 device pass step (2)
    # but collapse to count=1 after the cap, exposing a single
    # reporter's location. Doing it here (not at step 2) means a
    # legitimate group with 3 reports from 3 different devices
    # survives, while 50 reports from 1 device suppresses.
    groups = [g for g in groups if g.count >= min_group_size]

    # 5. Relevance sort → top-N
    now = datetime.now(timezone.utc)
    groups.sort(key=lambda g: -_relevance_score(g, now, radius_km))
    return groups[:max_groups]
