#!/usr/bin/env python3
"""Local load-test seeder for the CRISP dashboard.

Posts N reports (default 1000) to the local intake API over a DURATION (default
3600 s = 1 hour) so the dashboard can be exercised under realistic, live-arriving
load. Reports are spread:

  * ~40% into OPERATIONS  - coordinates jittered inside a live operation's circle,
    with that operation's id sent as the crisis_event_id opt-in hint (the server
    re-derives + verifies the zone, exactly like the Telegram/WhatsApp path).
  * ~60% GLOBAL           - random major-city coordinates worldwide (no operation).
  * ~25 DUPLICATE CLUSTERS - groups of 3-6 reports at the SAME coordinates with the
    same crisis type / infrastructure / description, so proximity assigns them one
    building and the duplicate engine scores them HIGH (exercises merge/collapse).

Operations: the 2 existing live ops are reused, and 3 more (Manila / Istanbul /
Miami) are created so the spread is genuinely global. Created ops reuse an existing
published form pack (required for zone matching).

LOCAL ONLY. Run from the backend dir with the venv + APP_ENV=dev:

    APP_ENV=dev LOADTEST_N=1000 LOADTEST_DURATION=3600 \
        python3 scripts/load_test_seed.py

Env knobs: LOADTEST_N, LOADTEST_DURATION (s), LOADTEST_API (default
http://localhost:8000/api/v1). For a quick smoke: LOADTEST_N=12 LOADTEST_DURATION=24.
"""
import json
import math
import os
import random
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

API = os.environ.get("LOADTEST_API", "http://localhost:8000/api/v1").rstrip("/")
N = int(os.environ.get("LOADTEST_N", "1000"))
DURATION = float(os.environ.get("LOADTEST_DURATION", "3600"))
OP_SHARE = float(os.environ.get("LOADTEST_OP_SHARE", "0.40"))
NUM_CLUSTERS = int(os.environ.get("LOADTEST_CLUSTERS", "25"))

SEVERITY = ["MINOR", "MODERATE", "SEVERE", "CRITICAL"]
# severity weights: a realistic feed skews to MODERATE/SEVERE, fewer CRITICAL.
SEV_WEIGHTS = [0.20, 0.38, 0.30, 0.12]
# Only the UNDP-accepted submission values (schemas/report._enforce_undp_taxonomy):
# LANDSLIDE / PANDEMIC are rejected; HURRICANE is accepted (normalised to CYCLONE).
CRISIS = ["EARTHQUAKE", "FLOOD", "TSUNAMI", "CYCLONE", "WILDFIRE", "EXPLOSION",
          "CHEMICAL_INCIDENT", "CONFLICT", "CIVIL_UNREST", "HURRICANE"]
INFRA = ["RESIDENTIAL", "COMMERCIAL", "GOVERNMENT", "UTILITY", "TRANSPORT_COMMUNICATION",
         "COMMUNITY", "PUBLIC_SPACES", "ROAD", "HOSPITAL", "HOUSE", "POWER", "WATER", "SCHOOL"]
SOURCES = ["APP", "ANDROID", "WHATSAPP", "TELEGRAM", "SMS", "IVR"]

# Major-city coordinates (land) for the GLOBAL spread - every continent. Named so
# reports carry a real place label instead of "Unknown location".
WORLD = [
    (40.71, -74.01, "New York, USA"), (51.51, -0.13, "London, UK"),
    (35.68, 139.69, "Tokyo, Japan"), (48.86, 2.35, "Paris, France"),
    (-33.87, 151.21, "Sydney, Australia"), (-23.55, -46.63, "Sao Paulo, Brazil"),
    (19.43, -99.13, "Mexico City, Mexico"), (30.04, 31.24, "Cairo, Egypt"),
    (-1.29, 36.82, "Nairobi, Kenya"), (28.61, 77.21, "New Delhi, India"),
    (39.90, 116.40, "Beijing, China"), (55.76, 37.62, "Moscow, Russia"),
    (-34.60, -58.38, "Buenos Aires, Argentina"), (1.35, 103.82, "Singapore"),
    (6.52, 3.38, "Lagos, Nigeria"), (-26.20, 28.04, "Johannesburg, South Africa"),
    (31.23, 121.47, "Shanghai, China"), (13.75, 100.50, "Bangkok, Thailand"),
    (33.69, 73.06, "Islamabad, Pakistan"), (41.90, 12.50, "Rome, Italy"),
    (52.52, 13.40, "Berlin, Germany"), (37.57, 126.98, "Seoul, South Korea"),
    (25.20, 55.27, "Dubai, UAE"), (-6.21, 106.85, "Jakarta, Indonesia"),
    (23.81, 90.41, "Dhaka, Bangladesh"), (21.03, 105.85, "Hanoi, Vietnam"),
    (-12.05, -77.04, "Lima, Peru"), (45.42, -75.70, "Ottawa, Canada"),
    (59.33, 18.07, "Stockholm, Sweden"), (50.45, 30.52, "Kyiv, Ukraine"),
    (4.71, -74.07, "Bogota, Colombia"), (-22.91, -43.17, "Rio de Janeiro, Brazil"),
    (34.05, -118.24, "Los Angeles, USA"), (43.65, -79.38, "Toronto, Canada"),
    (-37.81, 144.96, "Melbourne, Australia"),
]
# Neighbourhood / landmark prefixes so locations read naturally, e.g. "Riverside, Cairo".
AREAS = ["Downtown", "North", "South", "East", "West", "Old Town", "Riverside",
         "Harbour", "Central", "Market District", "Industrial Zone", "Uptown",
         "Sector 4", "Station Road", "Hillside", "Lakeside", "Airport Road"]


def mk_place(city):
    return f"{random.choice(AREAS)}, {city}"

# Cluster description bases (members of a cluster share one -> HIGH duplicate score).
CLUSTER_DESC = [
    "Building collapsed, several people are trapped under the rubble.",
    "Major fire spreading fast, thick smoke, residents evacuating now.",
    "Bridge is flooded and impassable, vehicles stranded in the water.",
    "Gas explosion reported, injuries on the street, area unsafe.",
    "Hospital wing damaged, patients being moved, power is out.",
    "Landslide blocked the main road, homes buried on the slope.",
    "School building cracked after the quake, children evacuated.",
    "Power station down, whole neighbourhood without electricity.",
    "Water main burst, street flooding into ground-floor shops.",
    "Market structure partially collapsed, people calling for help.",
]
SINGLE_DESC = [
    "Reporting damage to a residential building in my area.",
    "Road is cracked and partly blocked after the event.",
    "Smoke seen rising from a nearby commercial block.",
    "Flooding on the lower street, water rising slowly.",
    "Power has been out for a while in this neighbourhood.",
    "A wall has collapsed near the community centre.",
    "Telecom tower looks damaged, no signal in the area.",
    "Minor injuries reported, situation seems contained.",
    "Debris on the road needs clearing before traffic can pass.",
    "Government office windows shattered, no entry allowed.",
    "Water supply disrupted across several houses here.",
    "Small fire was put out but the building is unsafe.",
    "Tree fell on a parked car, no one hurt.",
    "Shop fronts damaged along the main avenue.",
    "Bus stop shelter destroyed, people waiting in the open.",
]


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


def jitter(lat, lng, max_km):
    """Random point within max_km of (lat,lng)."""
    d = random.uniform(0, max_km)
    brng = random.uniform(0, 2 * math.pi)
    dlat = (d / 111.0) * math.cos(brng)
    coslat = max(0.2, math.cos(math.radians(lat)))
    dlng = (d / (111.0 * coslat)) * math.sin(brng)
    return round(lat + dlat, 6), round(lng + dlng, 6)


def ensure_operations():
    """Reuse the live operations + create 3 more on other continents. Returns a
    list of (op_id, center_lat, center_lng, radius_km, crisis_type)."""
    os.environ.setdefault("APP_ENV", "dev")
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # backend/
    # Load the FULL model registry so cross-table FKs (e.g. crisis_events.created_by
    # -> users) resolve when the ORM flushes the new CrisisEvent rows.
    import importlib
    import pkgutil
    import app.models
    for _m in pkgutil.iter_modules(app.models.__path__):
        importlib.import_module(f"app.models.{_m.name}")
    from app.db.session import SessionLocal
    from app.models.report import CrisisEvent

    db = SessionLocal()
    live = [o for o in db.query(CrisisEvent).filter(CrisisEvent.is_active == True).all() if o.form_pack_id]  # noqa: E712
    if not live:
        db.close()
        raise SystemExit("No live operation with a form pack exists - cannot seed operation reports.")
    pack_id = live[0].form_pack_id   # packs are reusable across events
    now = datetime.now(timezone.utc)
    WANT = [
        ("Manila Flood Response", "FLOOD", 14.599, 120.984, 25.0, "Manila, Philippines"),
        ("Istanbul Earthquake", "EARTHQUAKE", 41.008, 28.978, 30.0, "Istanbul, Turkiye"),
        ("Miami Hurricane", "HURRICANE", 25.762, -80.192, 35.0, "Miami, USA"),
    ]
    for name, ctype, lat, lng, r, place in WANT:
        if db.query(CrisisEvent).filter(CrisisEvent.name == name).first():
            continue
        db.add(CrisisEvent(
            id=str(uuid.uuid4()), name=name, crisis_type=ctype, status="LIVE",
            is_active=True, center_lat=lat, center_lng=lng, radius_km=r, place_name=place,
            started_at=now - timedelta(hours=2), ended_at=None, form_pack_id=pack_id))
    db.commit()
    ops = [o for o in db.query(CrisisEvent).filter(CrisisEvent.is_active == True).all() if o.form_pack_id]  # noqa: E712
    out = [(o.id, o.center_lat, o.center_lng, float(o.radius_km or 25.0),
            (o.crisis_type or "FLOOD"), o.name, (o.place_name or o.name)) for o in ops]
    db.close()
    return out


def backfill_places():
    """Enrich existing reports that have NO location name (the 'Unknown location' rows)
    with the nearest known city / operation place. Enrichment only - never overwrites an
    existing name. Bumps updated_at so the dashboard's delta poll picks it up."""
    os.environ.setdefault("APP_ENV", "dev")
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    import importlib
    import pkgutil
    import app.models
    for _m in pkgutil.iter_modules(app.models.__path__):
        importlib.import_module(f"app.models.{_m.name}")
    from app.db.session import SessionLocal
    from app.models.report import Report, Location, CrisisEvent

    db = SessionLocal()
    anchors = [(lat, lng, city) for lat, lng, city in WORLD]
    for o in db.query(CrisisEvent).all():
        anchors.append((o.center_lat, o.center_lng, o.place_name or o.name))
    now = datetime.now(timezone.utc)
    rows = (db.query(Report, Location)
            .join(Location, Location.report_id == Report.id)
            .filter(Location.latitude.isnot(None),
                    (Location.user_location_name.is_(None)) | (Location.user_location_name == ""),
                    (Location.device_location_name.is_(None)) | (Location.device_location_name == ""))
            .all())
    n = 0
    for rep, loc in rows:
        best, bd = None, 1e18
        for alat, alng, city in anchors:
            d = (loc.latitude - alat) ** 2 + (loc.longitude - alng) ** 2
            if d < bd:
                bd, best = d, city
        if best:
            loc.user_location_name = mk_place(best)
            rep.updated_at = now
            n += 1
    db.commit()
    db.close()
    log(f"Backfilled place names on {n} reports (nearest city / operation).")


def post(payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(API + "/reports/meta", data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        log(f"  ! HTTP {e.code} {e.reason} - {e.read()[:160]!r}")
        return None
    except Exception as e:  # noqa: BLE001
        log(f"  ! post failed: {e}")
        return None


def build_specs(ops):
    specs = []
    # Duplicate clusters: half in operations, half global. All members share one
    # location AND one place label (same building → reads consistently).
    for ci in range(NUM_CLUSTERS):
        if ops and random.random() < 0.5:
            op_id, oc_lat, oc_lng, orad, octype, _, oplace = random.choice(ops)
            clat, clng = jitter(oc_lat, oc_lng, orad * 0.6)
            cev, ctype, cplace = op_id, octype, mk_place(oplace)
        else:
            wlat, wlng, wcity = random.choice(WORLD)
            clat, clng = jitter(wlat, wlng, 10)
            cev, ctype, cplace = None, random.choice(CRISIS), mk_place(wcity)
        cinfra = random.choice(INFRA)
        cdesc = random.choice(CLUSTER_DESC)
        for _ in range(random.randint(3, 6)):
            specs.append(dict(lat=clat, lng=clng, crisis_event_id=cev, crisis_type=ctype,
                              infrastructure_type=cinfra, description=cdesc, place=cplace,
                              severity=random.choices(SEVERITY, SEV_WEIGHTS)[0]))
    # Singletons fill the rest.
    while len(specs) < N:
        if ops and random.random() < OP_SHARE:
            op_id, oc_lat, oc_lng, orad, octype, _, oplace = random.choice(ops)
            lat, lng = jitter(oc_lat, oc_lng, orad * 0.9)
            cev, place = op_id, mk_place(oplace)
            ctype = octype if random.random() < 0.8 else random.choice(CRISIS)
        else:
            wlat, wlng, wcity = random.choice(WORLD)
            lat, lng = jitter(wlat, wlng, 18)
            cev, ctype, place = None, random.choice(CRISIS), mk_place(wcity)
        specs.append(dict(lat=lat, lng=lng, crisis_event_id=cev, crisis_type=ctype,
                          infrastructure_type=random.choice(INFRA),
                          description=random.choice(SINGLE_DESC), place=place,
                          severity=random.choices(SEVERITY, SEV_WEIGHTS)[0]))
    specs = specs[:N]
    random.shuffle(specs)   # mixed arrival order
    return specs


def main():
    if os.environ.get("LOADTEST_BACKFILL") == "1":
        backfill_places()
        return
    ops = ensure_operations()
    log(f"Operations in play ({len(ops)}): " + ", ".join(f"{o[5]}" for o in ops))
    specs = build_specs(ops)
    planned_ops = sum(1 for s in specs if s["crisis_event_id"])
    interval = DURATION / max(1, N)
    log(f"Seeding {len(specs)} reports over {DURATION:.0f}s (~{interval:.2f}s apart) "
        f"- planned {planned_ops} operation / {len(specs) - planned_ops} global, "
        f"{NUM_CLUSTERS} duplicate clusters.")

    posted = matched_ops = failed = 0
    for i, s in enumerate(specs):
        payload = {
            "device_hash": "loadtest-" + uuid.uuid4().hex[:16],   # distinct reporters
            "client_report_id": f"lt-{int(time.time() * 1000)}-{i}",
            "source": random.choice(SOURCES),
            "severity": s["severity"],
            "infrastructure_type": s["infrastructure_type"],
            "crisis_type": s["crisis_type"],
            "description": s["description"],
            "expected_media": 0,
            "location": {"latitude": s["lat"], "longitude": s["lng"],
                         "user_location_name": s["place"]},
        }
        if s["crisis_event_id"]:
            payload["crisis_event_id"] = s["crisis_event_id"]
        res = post(payload)
        if res:
            posted += 1
            if res.get("crisis_event_id"):
                matched_ops += 1
        else:
            failed += 1
        if (i + 1) % 25 == 0 or (i + 1) == len(specs):
            log(f"{i + 1}/{len(specs)} posted - {matched_ops} landed in operations, "
                f"{failed} failed")
        if i + 1 < len(specs):
            time.sleep(interval)
    log(f"DONE. posted={posted} in_operations={matched_ops} global={posted - matched_ops} failed={failed}")


if __name__ == "__main__":
    main()
