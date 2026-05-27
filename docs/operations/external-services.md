# External Service Dependencies — fallback runbook

CRISP integrates seven external services. Each has a documented
**failure mode**, **fallback path**, and **operator action**. Use
this when an integration starts misbehaving or you're scaling
beyond a quota tier.

Updated post-Sprint 3C (May 2026). Re-validate quotas annually —
vendors change pricing without notice.

---

## 1. Anthropic API — Claude vision + AI summary

**Used for:**
- `backend/app/services/truth_scorer.py` — satellite truth scoring
  (matches reported damage against satellite imagery).
- `backend/app/services/building_ai_summary.py` — short building
  context summary for the dashboard.
- `backend/app/services/prediction_engine.py` — disaster-zone
  prediction.

**Quota tier:** developer rate-limit, monthly token spend cap.
Check current limits at https://console.anthropic.com/billing.

**Failure modes + observed:**
- **5xx from `api.anthropic.com`** — Anthropic outage. Service returns
  `SummaryUnavailable` / `TruthScoreUnavailable` exceptions.
- **401/403** — API key revoked or rotated. Same exception class.
- **Rate-limit (429)** — pre-pilot we'd be under the rate window; at
  scale, ~50 satellite verifies/minute starts hitting limits.

**Fallback path:** every consumer is wrapped in try/except. On failure,
the operation completes WITHOUT the AI augmentation:
- Truth-score: report ships as `satellite_verdict='unverified'`,
  not blocked from submission.
- AI summary: building card shows "No summary available."
- Prediction: skips, no zone created.

**Operator action:**
- Quota exceeded → bump the plan tier or shed load by skipping
  truth-scoring for low-confidence reports.
- Key revoked → rotate via `.env.production` + restart backend.
- Verify via `curl https://undp.crisplabs.tech/api/v1/ivr/status` —
  if Twilio is configured the system runs without Anthropic.

---

## 2. Mapbox — satellite imagery + reverse geocoding

**Used for:**
- 1 of 4 satellite imagery providers
  (`backend/app/services/satellite_fetcher.py:_mapbox_satellite`).
- Backup reverse-geocoding endpoint
  (`backend/app/api/endpoints/reports.py` proxy added in HC55).

**Quota tier:** free tier = 50,000 map loads/month + 100,000 geocoding
requests/month.

**Failure modes:**
- **Token-quota exceeded** — Mapbox returns 401/429 for the rest of
  the billing month.
- **Style 404** — `satellite-v9` deprecated by Mapbox (unlikely in
  the pilot window; happened in 2023 when v8 was sunset).

**Fallback path:** 4-provider chain in `satellite_fetcher.py`:
1. Copernicus Sentinel-2 (primary, free)
2. Microsoft Planetary Computer (free)
3. ESA Copernicus Browser
4. Mapbox

If Mapbox fails the chain continues — no user-visible regression.

For reverse-geocoding, the primary path is Nominatim; Mapbox is the
backup. If both fail, the proxy returns the raw lat/lng pair.

**Operator action:**
- Quota exceeded → either accept the loss of one provider or buy
  Mapbox Pay-As-You-Go credits ($0.0005/request).
- Token expired → rotate `MAPBOX_TOKEN` in `.env.production`.

---

## 3. Copernicus Sentinel Hub — primary satellite

**Used for:** `satellite_fetcher.py:_cdse_search` — primary satellite
imagery fetcher.

**Quota tier:** free for low-volume users; the CDSE STAC API allows
~600 requests/minute under fair-use.

**Failure modes:**
- **502/503 from `catalogue.dataspace.copernicus.eu`** — periodic
  scheduled maintenance, often announced in the CDSE forum.
- **No results for the requested area** — cloud cover too high, or
  the area is at the edge of Sentinel-2's revisit window.

**Fallback path:** chain to Microsoft Planetary Computer → ESA →
Mapbox, as above.

**Operator action:**
- Monitor https://dataspace.copernicus.eu/news for maintenance.
- Rotate `CDSE_USERNAME`/`CDSE_PASSWORD` if the account locks (rare).

---

## 4. Nominatim — reverse geocoding

**Used for:** primary reverse-geocoding endpoint
(`/api/v1/geocode/reverse`, proxy added in HC55).

**Quota:** ~1 request/second per IP, no API key. Heavy traffic
triggers IP rate-limit + permanent ban in repeat-offender cases.

**Failure modes:**
- **Rate limit (429)** — bursting > 1 req/s. Per IP — at scale this
  is a shared problem across all our users hitting via the proxy.
- **5xx** — Nominatim is community-run; outages happen.

**Fallback path:** HC55 added an in-memory LRU cache in the backend
proxy + falls back to Mapbox geocoding if Nominatim returns 4xx.

**Operator action (at scale):**
- Mirror Nominatim with our own server (Docker:
  `mediagis/nominatim`) — gives us our own quota.
- Subscribe to a paid alternative (LocationIQ, MapTiler Geocoding).

For the pilot — fine as-is.

---

## 5. Twilio — SMS + IVR

**Used for:**
- Inbound + outbound SMS (`backend/app/services/sms.py`)
- Inbound IVR webhook (`messaging-bot/ivr/webhook.py`)

**Quota tier:** per-message billing. Plan-dependent rate limits.

**Failure modes:**
- **Account suspension** (most painful — Twilio is strict about
  perceived spam). Mitigated by clear opt-in language and per-region
  approved sender IDs.
- **Send failure** → returned via `TwilioRestException`.

**Fallback path:** if Twilio is not configured (`.env.production`
keys empty), the SMS + IVR channels return 503 to inbound webhooks
and `/api/v1/ivr/status` reports `twilio_configured: false`. The
PWA + dashboard work unaffected — only the SMS / IVR multi-channel
parity surface degrades.

**Operator action:**
- Suspension → escalate through Twilio support; usually resolved
  in 24h after the operator confirms the use-case is humanitarian.
- Pre-pilot: ensure `messaging-bot/ivr/webhook.py`'s `to_e164`
  validation is enforced (no PII leaks via wrong-number SMS).

---

## 6. VAPID Web Push — browser notifications

**Used for:** PWA push notifications when report status changes
(`backend/app/services/push.py`).

**Quota:** none — VAPID is RFC 8292, runs against the user's browser
push endpoint (FCM / APNs / Mozilla autopush). No central quota.

**Failure modes:**
- **VAPID keys not configured** — `_vapid_configured()` returns False;
  push is silently disabled. Documented behaviour, no error surfaced.
- **Subscription expired** — push endpoint returns 410 Gone. Backend
  catches this + removes the subscription from the DB.

**Fallback path:** in-app polling via `/reports/?since=<iso>` (PWA
checks for status changes when the user opens the My Reports screen).
Always works, just less timely than push.

**Operator action:**
- Generate VAPID keys: `python3 -c "from py_vapid import Vapid01;
  v = Vapid01(); v.generate_keys(); print(v.private_pem(),
  v.public_pem())"`. Persist both halves to `.env.production`.
- Set `VAPID_CONTACT_EMAIL` to a real address — push providers
  occasionally email operators about delivery issues.

---

## 7. jsDelivr CDN — vendored frontend libraries (HISTORICAL)

**Used for (pre-HC89):** TF.js + BlazeFace + Sentry SDK runtime fetch.

**Current state:** all three libs are **vendored** under
`mobile-app/src/vendor/` and `web-dashboard/src/vendor/`. No runtime
CDN dependency.

**Why kept in this doc:** the May 2026 operator HAR captured 404s
from jsDelivr that broke the client-side PII blur — HC89 closed
that path. Documented here as a "do NOT add new CDN runtime
dependencies" reminder.

**Rule:** any new third-party JS dependency MUST be vendored under
`vendor/` and added to `STATIC_ASSETS` so the SW pre-caches it.
Update `scripts/generate-sw-manifest.mjs` if a new vendor path is
added (`mobile-app/src/vendor/` is already glob-tracked).

---

## Decision matrix — pilot vs scale

| Service | Pilot OK? | Scale trigger | Migrate to |
|---|---|---|---|
| Anthropic | yes (low volume) | > 50k tokens/min sustained | Pay-As-You-Go, bigger context window |
| Mapbox | yes | > 50k loads/month | Pay-As-You-Go (~$0.0005/req) or drop the layer |
| Copernicus | yes | n/a (free at any scale) | n/a |
| Nominatim | yes | 1+ req/s sustained | Self-host `mediagis/nominatim` |
| Twilio | yes (only if needed) | reliant on SMS-only channel + > 100 msgs/day | check Plivo / MessageBird quotes |
| VAPID push | yes | n/a (no central quota) | n/a |
| jsDelivr | NEVER (vendored) | n/a | already vendored |

---

## Monitoring

The SLO doc (`docs/operations/SLOs.md`) references this file under
each external-service-dependent target. If you're paged for:

- Submit success rate dip → check Twilio + Sentry first.
- p95 latency → check Anthropic (truth scorer in the critical path).
- Map tile error budget → see `docs/operations/map-tile-mitigation.md`.
- Assembly recovery spikes → see
  `docs/operations/assembly-recovery-runbook.md`.

Every external call site logs to the standard backend logger with a
service-name tag (`[Anthropic]`, `[Twilio]`, `[Mapbox]`, etc.) so
`docker logs --since 1h crisp-backend-1 | grep -E "(Anthropic|Twilio|Mapbox|CDSE)"`
gives a quick triage cut.
