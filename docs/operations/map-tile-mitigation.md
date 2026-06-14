# Map tile rate-limit mitigation

The CRISP dashboard map (`web-dashboard/src/app.js:8469-8477`) and the
PWA building-picker map (`mobile-app/src/app.js:12337,13010`,
`building-select.js:465`) both use **free public tile servers**.
That's fine for a single-location pilot, but every tier has a quota
and the May 2026 operator HAR captured 41 × 400-class responses from
Carto - proof the dashboard is one busy demo away from a visibly
broken map.

This doc is the operator runbook for picking + wiring a mitigation
when pilot traffic justifies it.

## Current state (Sprint 2C-3, May 2026)

| Surface | Provider | URL pattern | Free quota |
|---|---|---|---|
| Dashboard | Carto basemaps CDN | `https://{s}.basemaps.cartocdn.com/dark_{nolabels,only_labels}/{z}/{x}/{y}{r}.png` | ~75,000 tiles/day/IP |
| PWA capture map | OpenStreetMap public tiles | `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` | ~2 req/s/IP (no daily total - short-burst rate limit) |

The PWA's OSM hit is normally bounded (one user, one capture session,
a few dozen tiles). The risk is the dashboard side: every reviewer
panning + zooming during triage burns tiles, and a single power-user
afternoon can blow through 75k tiles.

## Symptoms

- **Dashboard map shows grey squares** mid-pan: Carto returned 4xx
  for some tile range; Leaflet kept the cached layer state but no
  more tiles. Hits the SLO error budget defined in
  `docs/operations/SLOs.md` § 5.
- **PWA capture map shows nothing**: usually a CSP / network issue,
  not rate-limit (PWA traffic per-user is too low to trip OSM's
  2 req/s window).
- **Console logs**: `Failed to load resource: 400` from `*.cartocdn.com`.

## Mitigation options - ranked low → high effort

### Option 1 - Switch dashboard to Stadia Maps free tier

**Effort:** ~15 minutes. **Cost:** $0. **Risk:** very low.

Stadia Maps offers a free tier with 50k tile loads/day at the same
visual style ("Alidade Smooth Dark"). Edit
`web-dashboard/src/app.js:8469-8477`:

```js
// Before:
const baseLayer = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
    { ... }
);

// After:
const baseLayer = L.tileLayer(
    'https://tiles.stadiamaps.com/tiles/alidade_smooth_dark/{z}/{x}/{y}{r}.png',
    {
        attribution: '&copy; <a href="https://stadiamaps.com/">Stadia Maps</a>, ' +
                     '&copy; <a href="https://openmaptiles.org/">OpenMapTiles</a>, ' +
                     '&copy; <a href="https://www.openstreetmap.org/about/">OpenStreetMap</a>',
        maxZoom: 20,
    }
);
```

Caveats:
- Stadia requires `Origin` header verification - won't work from
  `null` origin (file:// or some headless test harnesses).
- Daily 50k is *lower* than Carto's 75k. Switching only helps if the
  problem is Carto specifically, not raw volume.

### Option 2 - Get a paid Carto API key

**Effort:** ~30 minutes. **Cost:** Carto Lite plan starts at ~$20/month.
**Risk:** low (vendor lock-in to Carto).

Sign up at https://carto.com/, get an API key, then:

```sh
# On EC2:
echo "CARTO_API_KEY=eyJ..." >> .env.production

# In GH Actions Secrets:
#   CARTO_API_KEY = eyJ...
```

Inject the key into the tile URL via a deploy-time patch script
(mirror `scripts/patch-sentry-dsn.mjs`):

```js
const baseLayer = L.tileLayer(
    'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png?api_key=' + CARTO_KEY,
    { ... }
);
```

Quota at the Lite tier is ~250k tiles/day - comfortable for a single
busy region.

### Option 3 - Server-side tile proxy with LRU cache

**Effort:** ~1-2 days. **Cost:** $0 (backend runs on existing EC2).
**Risk:** medium (new code path, new cache management surface).

Add a FastAPI route on the existing backend that proxies tile
requests + caches them in-memory or on disk:

```python
# backend/app/api/endpoints/tiles.py (new)
from cachetools import TTLCache
from fastapi import APIRouter, Response
import httpx

router = APIRouter()
_tile_cache = TTLCache(maxsize=10_000, ttl=86_400)  # 1-day TTL

@router.get("/tiles/{provider}/{style}/{z}/{x}/{y}.png")
async def get_tile(provider: str, style: str, z: int, x: int, y: int):
    cache_key = f"{provider}:{style}:{z}/{x}/{y}"
    if cache_key in _tile_cache:
        return Response(_tile_cache[cache_key], media_type="image/png",
                        headers={"X-Tile-Cache": "HIT", "Cache-Control": "public, max-age=86400"})
    # Provider-specific URL build (extend as new providers added)
    url = f"https://a.basemaps.cartocdn.com/{style}/{z}/{x}/{y}.png"
    async with httpx.AsyncClient(timeout=10) as cli:
        r = await cli.get(url)
        r.raise_for_status()
        _tile_cache[cache_key] = r.content
    return Response(r.content, media_type="image/png",
                    headers={"X-Tile-Cache": "MISS", "Cache-Control": "public, max-age=86400"})
```

Then point Leaflet at our own endpoint instead of Carto/OSM directly.

Pros:
- Quota becomes per-server (one CRISP IP hitting Carto), not per-user.
  100 dashboard users × Carto = 100 quotas; 100 dashboard users × proxy
  = 1 quota.
- Tiles are cached for 24h - second pan over the same area is free.
- We control the network - can fail over between providers.

Cons:
- Adds latency (one extra hop per tile).
- Memory: 10k tiles × ~20 KB = ~200 MB RAM. Bound the cache size to
  what the EC2 instance can spare.
- Defeats the CDN's geo-distribution; tiles are now served from a
  single AWS region.

### Option 4 - Self-host the OSM tile pyramid for the pilot region

**Effort:** ~1 week. **Cost:** ~50 GB disk for a country-scale pyramid;
~1 week of operator time to set up.
**Risk:** high (operational complexity).

Run TileServer-GL / tegola against an OSM `.pbf` export for the pilot
region. Pre-render the tile pyramid offline, serve from S3 + CloudFront.
Use this when:
- Pilot expects > 100k tiles/day per IP.
- Operator wants zero third-party tile dependency (sovereignty, audit
  isolation, OFFLINE pilot scenarios).

Out of scope for the initial pilot. Document for the post-pilot
expansion phase.

## Recommendation by pilot size

| Pilot scale | Recommended option |
|---|---|
| Single location, < 1k reports/day, < 5 dashboard reviewers | None - free tier holds |
| Single location, > 1k reports/day OR > 10 reviewers | Option 1 (Stadia) - 15 min |
| 2-3 locations, regional UN deployment | Option 2 (paid Carto) - $20/month |
| Full-scale regional ops, > 50k reports/day | Option 3 (server proxy) → Option 4 (self-host) |

For the FIRST pilot deployment: **do nothing**, monitor the Carto error
rate against SLO § 5. If the budget is breached, jump to Option 1.

## Decision log

When you pick a mitigation, append here with the date + rationale.
Keep the chronology - future operators can read the trade-offs the
project has already worked through.

- 2026-05-28 - Sprint 2C-3 - No mitigation implemented yet. Pilot is
  single-location, traffic projected < 1k reports/day; free tier should
  hold. Re-evaluate after 7-day soak with real telemetry.
