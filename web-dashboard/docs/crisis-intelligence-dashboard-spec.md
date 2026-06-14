# CRISP — Crisis Intelligence Dashboard (Post-Login Landing)
## Production specification, grounded in codebase discovery

**Scope:** Replace the 4-tile navigation landing (`cc-home.js`) with a Humanitarian Crisis Intelligence Center that delivers situational awareness first, navigation second — **without redesigning the existing "Monitor & Respond to Incidents" module.**

**Guardrail honored:** every component below is mapped to a real API + DB table, or explicitly flagged as a GAP with the engineering needed. No dummy data, no placeholder cards, no fake AI.

> **Honest headline:** CRISP is a citizen-report → damage-classification → satellite-verification platform. ~10 of the requested metrics are fully backable today, ~6 are backable as proxies, and **5 are genuinely impossible without new external datasets** (population affected, households, displaced persons, vulnerable-population indicators, and — until a country column is added — "countries impacted"). Those are called out in §4 with effort, not faked.

---

## 1. Current-State Assessment

### UX critique
- The post-login root (`#/`) renders four equal tiles — *Monitor & Respond*, *Account Settings*, *Organisation Settings*, *Crisis Forms* (`cc-home.js:156-177`). It reads as an **admin launcher**, not an operations center. All four cards carry equal visual weight; the one operational destination (Monitor) competes with two settings screens and a form builder.
- The only live data on the landing is a thin stat strip + 5-row recent list (`loadStatusAndActivity()` `cc-home.js:244-268`), pulling `GET /reports/?limit=5` and reading `X-Total-Count`. There is **no severity, no map, no "what needs action now," no trend.**
- A leader cannot answer "what's happening / where / how bad / what's escalating / what needs approval" without first clicking into the Incident module — i.e. situational awareness is **one navigation hop too late.**

### Information-architecture review
- Navigation model is a hash router (`router.js`): `#/` (landing), `#/incidents`, `#/users`, `#/org`, `#/reporting`. Clean and reusable — the landing can deep-link into the Incident module with pre-applied chip filters (the router preserves extra `;chips=…` hash segments, `router.js:55-63`).
- The rich operational surface already exists but is **buried inside `#/incidents`**: Leaflet map + marker clustering + heat layer, a hand-rolled analytics panel (KPIs, severity distribution, 14-day score trend), command stats, and the building-intelligence console (`app.js`). The redesign's job is to **promote a read-only summary of these to the landing** and route INTO the module for action.

### Operational-workflow review
- Two parallel state systems: per-report `ReportStatusEnum` (PENDING / RESPONDING / RESOLVED / REJECTED / FALSE_ALARM; `VERIFIED` is vestigial/unused) and per-incident `BuildingStateEnum` (ACTIVE / MONITORED / RESPONDING / ESCALATED / RESOLVED / ARCHIVED / FALSE_ALARM).
- **"Incident" as a first-class, stateful object = `Building`** (`buildings.py`): a 7-state machine with severity/confidence/activity/escalation-risk/humanitarian-priority scores, responder assignments, notes, and an event timeline. The landing should treat Buildings as incidents.
- Workflow actions (dispatch, resolve, review verdict, escalate, assign responder) are single-actor `analyst+`. There is **no approval chain, no SLA timer, no triage state machine** (triage = implicit `status=PENDING && reviewer_verdict=NOT_REVIEWED`).

---

## 2. Backend Discovery Report

### 2.1 Roles (RBAC — `models/auth.py:19`, enforced by `core/deps.py:65`)
`SUPER_ADMIN > ADMIN > ANALYST > VIEWER` (+ `REPORTER` = citizen, not a dashboard role). Guards: `require_viewer` (read reports), `require_analyst` (all report/building actions), `require_admin` (users, audit-log, appeals, observability, crisis-forms, org config, hot-regions). Flat/cumulative; **no per-org or per-object scoping** on actions.

### 2.2 Endpoints the landing can consume (all real)
| Endpoint | Auth | Returns | Use on landing |
|---|---|---|---|
| `GET /api/v1/reports/?limit&skip&since&include_deleted` | viewer | report list; **`X-Total-Count`**, `ETag`/304, `X-Server-Time` | feed, deltas, cheap totals |
| `GET /api/v1/buildings?state&severity_score_gte&humanitarian_priority_gte&has_unresolved&has_responder_dispatched&bbox&since&order_by&order_dir&cursor&limit` | public | incident list + `total` + per-building rollups | incident table, "needs attention", map |
| `GET /api/v1/reports/nearby` | public | k-anon clusters w/ `tier` (weak/emerging/verified), `is_burst`, `is_acute`, `acute_grade`, centroid, severity_max, crisis_types | **hotspots / emerging-region briefing** |
| `GET /api/v1/admin/observability/nearby/acute` | admin | `{high_confidence[], low_confidence[], total}` acute clusters | acute-alert tray (caveat: in-process cache) |
| `GET /api/v1/admin/observability/nearby/events?group_id` | admin | cluster lifecycle timeline | hotspot drill-down |
| `GET /api/v1/analytics/crisis-top10?lookback_hours&cluster_degrees` | public | top-10 geo clusters: count, centroid, top_crisis_type, top_damage, label | map tiles / top-affected list |
| `GET /api/v1/analytics/damage-rate-24h` | public | 24 zero-filled hourly buckets | incident-rate sparkline |
| `GET /api/v1/auth/audit-log` (last 500) | admin | global activity (user_email, action, resource_type/id, created_at) | recent operational activity |
| `GET /api/v1/reports/{id}/audit` · `GET /buildings/{id}/timeline` | analyst / public | per-entity event ribbons | drill-down |
| `GET /api/v1/predictions/latest` · `/heatmap` · `/zones` | viewer | forward risk forecasts | (optional) risk overlay |
| `GET /api/v1/config/` · `/config/org` | public / admin | deployment + org config | header/branding, platform info |
| Workflow writes: `PATCH /reports/{id}/{dispatch,resolve,false-alarm,review,timestamps,impact}` (analyst); `POST /buildings/{id}/{state,escalate,responders}` (analyst) | analyst | state transitions | action buttons (route into module) |
| `GET /api/v1/exports/{csv,geojson,shapefile,pdf,kml}?status&crisis_type&since&until` | viewer | file exports | "Export" quick action |

### 2.3 The aggregate gap (critical)
There is **no global stats/summary endpoint** (counts by status / severity / crisis_type / country; avg verification & response time; W/W deltas). `analytics.py` only computes geo-top-10 + a 24h sparkline, and **the dashboard doesn't even call them today.** The current dashboard analytics (`_renderAnalytics` `app.js:2996`) are computed **client-side over the ≤500 loaded reports** — correct for a demo, **wrong at the 500k-report scale target** (must-have #12). → §9 proposes one new endpoint, `GET /api/v1/analytics/summary`, that unlocks Sections 1, 3, and 4.

### 2.4 Data model anchors (`models/report.py`)
- `Report`: `status`(329, idx), `severity`(331, idx), `crisis_type`(362, idx), `crisis_category`(367), `infrastructure_type`(335, idx), `damage_classification`(361, idx), `reviewer_verdict`(412, idx), `reviewed_at`(411), `help_dispatched_at`(414), `help_arrived_at`(415), `first_verified_at`(359, idx), `server_created_at`(349, idx), `updated_at`(350), `deletion_requested_at`(351, idx), `lives_impacted`(353), `service_status` JSON(382, incl. `telecom`), `building_id`(383).
- `Location`: `latitude`/`longitude`(474-475, idx), `user_location_name`(480), `geocoding_*`(488-489), `h3_idx`(499). **No `country`/ADM column.**
- `Building`: `state`(1137, idx), `severity_score`/`confidence_score`/`activity_score`/`escalation_risk`/`humanitarian_priority`(1142-1146), `report_count`/`verified_report_count`/`responding_report_count`/`resolved_report_count`(1149-1156), `severity_max`(1157), `crisis_types_top3`(1159), `estimated_people_affected`(1162, **nullable, never populated**), `first_report_at`/`latest_report_at`(1165-1166), `centroid_lat/lng`(1131-1132).
- `SatelliteVerification`: `total_score`, `verdict`, `scored_at` (one per report).
- `AuthAuditLog`: `user_email`, `action`, `resource_type/id`, `details`, `created_at`.
- Enums: severity = MINOR/MODERATE/SEVERE/CRITICAL/UNKNOWN; crisis_type = EARTHQUAKE/FLOOD/TSUNAMI/CYCLONE/WILDFIRE/EXPLOSION/CHEMICAL_INCIDENT/CONFLICT/CIVIL_UNREST/OTHER.

### 2.5 Real-time
No WebSocket/SSE for the feed (SSE exists only for batch-verify progress). The dashboard **polls** every 1.2–8 s with conditional GET (`?since=` + `If-None-Match` → 304). The landing should reuse this polling pattern + ETag, not invent a socket.

---

## 3. Data Traceability Matrix (UI → API → DB → role)

Status: ✅ real today · 🟡 proxy (real data, indirect) · 🔴 gap (needs build/§4)

| # | UI component | Data | API | DB source | Refresh | Min role | Status |
|---|---|---|---|---|---|---|---|
| 1 | Active incidents KPI | count active | `/analytics/summary` (new) ← derives | `buildings.state NOT IN (RESOLVED,ARCHIVED,FALSE_ALARM)` or `reports.status IN (PENDING,RESPONDING)` | 30 s | viewer | ✅ via new endpoint |
| 2 | Critical incidents KPI | count critical+active | `/analytics/summary` | `reports.severity='CRITICAL'` / `buildings.severity_max='CRITICAL'` | 30 s | viewer | ✅ |
| 3 | Pending verification KPI | count | `/analytics/summary` | `reports.reviewer_verdict='NOT_REVIEWED'` | 30 s | viewer | ✅ |
| 4 | Awaiting triage KPI | count | `/analytics/summary` | `reports.status='PENDING' AND reviewer_verdict='NOT_REVIEWED'` | 30 s | viewer | ✅ |
| 5 | Open dispatch KPI | count | `/analytics/summary` | `reports.help_dispatched_at NOT NULL AND help_arrived_at NULL` OR `status='RESPONDING'` | 30 s | viewer | 🟡 proxy |
| 6 | Countries impacted KPI | distinct countries | `/analytics/summary` (needs country) | **no country column** → reverse-geocode or `Location.country` (new) | 60 s | viewer | 🔴 §4-A |
| 7 | Active operations KPI | count | `/analytics/summary` | `buildings.state IN (RESPONDING,ESCALATED)` / active `building_responders` | 30 s | viewer | 🟡 proxy |
| 8 | Platform health / connectivity | up/poll state | `/config/` + client poll/ETag state | n/a (client) | live | viewer | ✅ |
| 9 | Trend chips (Δ since yesterday, WoW, escalations vs resolutions) | windowed counts | `/analytics/summary` (windowed) | `reports.server_created_at` windowed COUNT | 60 s | viewer | ✅ via new endpoint |
| 10 | Global crisis map | clusters + severity | `/reports/` (loaded) + `/reports/nearby` + `/analytics/crisis-top10` | reports + `Location` | 30 s | viewer | ✅ |
| 11 | Country choropleth | per-country status | client Turf point-in-polygon on `world.json` (`app.js:9644`) over loaded reports | reports + bundled GeoJSON | 60 s | viewer | 🟡 (loaded-window only) → ✅ if country column |
| 12 | Immediate-attention list | critical/escalated/stale | `/buildings?...&order_by=humanitarian_priority` + `/reports/?since` | buildings + reports timestamps | 20 s | viewer | ✅ (SLA flag 🟡) |
| 13 | SLA-breach badges | over-threshold age | client compute from timestamps + config | `server_created_at`, `reviewed_at` vs threshold | 20 s | viewer | 🟡 no stored policy → §4-C |
| 14 | Distribution by type/severity | grouped counts | `/analytics/summary` | `GROUP BY reports.crisis_type` / `.severity` | 60 s | viewer | ✅ |
| 15 | Verified vs unverified / open vs closed | grouped counts | `/analytics/summary` | `reviewer_verdict` / `status` | 60 s | viewer | ✅ |
| 16 | Avg verification / response time | computed | `/analytics/summary` | `AVG(first_verified_at−server_created_at)`; `AVG((help_arrived_at∥dispatched)−reviewed_at)` | 60 s | viewer | ✅ |
| 17 | Incident-rate sparkline | 24h buckets | `/analytics/damage-rate-24h` | reports by hour | 60 s | viewer | ✅ |
| 18 | Critical infrastructure impacted | grouped counts | `/analytics/summary` | `reports.infrastructure_type IN (UTILITY,GOVERNMENT,COMMUNITY,TRANSPORT_COMMUNICATION)` + `infrastructure_sub_type` | 60 s | viewer | ✅ |
| 19 | Service/connectivity disruptions | count | `/analytics/summary` | `reports.service_status->>'telecom' IN (DISRUPTED,DESTROYED,BLACKOUT)` (JSON, unindexed, App-only) | 60 s | viewer | 🟡 |
| 20 | Lives impacted (sum) | sum | `/analytics/summary` | `SUM(reports.lives_impacted)` | 60 s | viewer | ✅ |
| 21 | Population / households / displaced / vulnerable | — | — | **none** | — | — | 🔴 §4-B (external datasets) |
| 22 | AI situation briefing | rule-derived insights | `/reports/nearby` + `/buildings` + `/analytics/summary` (+ optional Claude) | nearby tiers, escalation_risk, pending-age | 5 min | viewer | ✅ rule-based / 🟡 LLM |
| 23 | Recent operational activity | event rows | `/auth/audit-log` (admin) ∥ `/reports/?since` (viewer fallback) | `AuthAuditLog` / reports | 20 s | viewer→admin | ✅ |
| 24 | Acute-alert tray | acute clusters | `/admin/observability/nearby/acute` | nearby cache | 30 s | admin | 🟡 cache-backed |
| 25 | Quick actions | nav | router (`#/incidents`,`#/users`,`#/org`,`#/reporting`) + `/exports/*` | n/a | static | role-gated | ✅ |

---

## 4. Gap Analysis

| ID | Gap | Why it matters | Fix | Effort |
|---|---|---|---|---|
| **§4-summary** | No aggregate/summary endpoint | Exec KPIs + distributions + avg-times can't be fetched at scale; client-deriving over ≤500 reports is wrong at 500k | **NEW** `GET /api/v1/analytics/summary?window=24h\|7d` → counts by status/severity/type, pending-verification, awaiting-triage, avg verification/response time, open-dispatch proxy, lives-impacted sum, critical-infra count, WoW/since-yesterday deltas. Single module of indexed `GROUP BY` queries; ETag + 30–60 s cache | **M (2–3 d)** |
| **§4-A** | No `country`/ADM region on records | "Countries impacted" KPI + country choropleth are not server-computable | Interim: client Turf point-in-polygon over loaded reports (exists). Proper: add `Location.country` (ISO-3166) + `admin1`, backfill via reverse-geocode (geocoder service exists), index, group-by in summary | interim **S**; proper **M (3–4 d incl. backfill)** |
| **§4-B** | No population / household / displacement / vulnerability data | Section 5 "Humanitarian Impact" (population, households, displaced, vulnerable) cannot be backed | Either (a) **cut** and replace with real "Operational Impact" (critical-infra, service disruptions, lives-impacted, responders) — *recommended for v1*; or (b) integrate external rasters: WorldPop/GHSL (population), IOM DTM/UNHCR (displacement) joined by geography. Needs §4-A first | (a) **0**; (b) **L (2–4 wk + data licensing)** |
| **§4-C** | No SLA policy / escalation timer / stale job | "SLA breaches", "escalating", "stale" need a definition | Interim: client compute from existing timestamps + a hardcoded per-severity threshold config; "escalating" = `Building.escalation_risk` ranking (already computed); "stale" = open + `age>threshold`. Proper: `SLAPolicy` config table + `is_breached` computed field + nightly scan | interim **S**; proper **M** |
| **§4-D** | No operator-facing notification/alert store | No "alerts" inbox; only outbound web-push to reporters | v1: derive an alert list from acute clusters + SLA-breach + new-escalation (client). Proper: `OperatorAlert` table + endpoint | interim **S**; proper **M** |
| **§4-E** | No per-crisis-event / per-type aggregation; `crisis-top10` gives one top type per cluster, not full distribution | Limits "distribution" richness | Covered by §4-summary `GROUP BY crisis_type` | included above |
| **§4-F** | Acute endpoint reads in-process cache | Empty after restart / if `/nearby` not hit recently | Warm cache on boot or persist last snapshot | **S** |
| **§4-G** | No charting library | Richer charts than CSS bars | Reuse the existing hand-rolled CSS bar pattern (`.ac-tbar`) — **no new dep**; or add a small lib (uPlot ~40 KB). *Recommend reuse for v1.* | **S / 0** |

---

## 5. New Information Architecture

Dark command-center layout, 12-col grid, above-the-fold = situational awareness. Sections map to the brief, **re-scoped to real data**:

```
┌─ HEADER ─ org logo · "Crisis Intelligence Center" · live clock(UTC+local) · connectivity dot · user/role · ⎋ to Operations
├─ §1 EXECUTIVE SITUATION OVERVIEW  (KPI strip, 8 backable tiles + Δ trend chips)
├─ §2 GLOBAL CRISIS SNAPSHOT (left 8 col: Leaflet map, clusters/heat/severity, country tint)  │  §3 IMMEDIATE ATTENTION (right 4 col: prioritized action queue)
├─ §4 OPERATIONAL INTELLIGENCE (type dist · severity dist · verified/unverified · avg times · 24h sparkline)
├─ §5 OPERATIONAL IMPACT (real proxies; census metrics flagged "data integration required")
├─ §6 SITUATION BRIEFING (rule-derived insight cards, sourced + timestamped)
├─ §7 RECENT OPERATIONAL ACTIVITY (table: type · place · severity · verify status · status · updated · →)
└─ §8 QUICK ACTIONS (compact utility row: Operations · Crisis Forms · Org · Account · Users · Exports — role-gated)
```

Navigation is demoted to §8. Every operational item deep-links into `#/incidents` (with chip filters) or the relevant module — the landing **shows**, the module **acts**.

---

## 6. Wireframe (textual, desktop ≥1280px)

```
CRISIS INTELLIGENCE CENTER            🟢 LIVE · 14:32 UTC · 20:02 IST     [JD ▾ Analyst]  [Operations →]
────────────────────────────────────────────────────────────────────────────────────────────────
[ Active 42 ▲3 ] [ Critical 7 ▲2 ] [ Pending Verify 18 ▼1 ] [ Awaiting Triage 23 ] 
[ Open Dispatch 9 ] [ Active Ops 5 ] [ Avg Verify 2.1h ] [ Resolved 24h 31 ]      ← §1 (deltas vs yesterday)
────────────────────────────────────────────────────────────────────────────────────────────────
┌─ GLOBAL CRISIS SNAPSHOT ─────────────────────────┐  ┌─ IMMEDIATE ATTENTION ──────────────┐
│  [Leaflet: severity-colored clusters + heat]      │  │ 🔴 Critical · unreviewed · 3       │
│  [layer toggles: Clusters | Heat | Hotspots]      │  │ ⏱ Stale >24h open · 6              │
│  [emerging hotspots ◉ from /reports/nearby]       │  │ ⬆ Escalating (risk≥70) · 4        │
│                                                   │  │ 🚑 Dispatched, no arrival · 5      │
│                                                   │  │ ⚠ SLA at-risk · 2   → each routes  │
└───────────────────────────────────────────────────┘  └────────────────────────────────────┘
┌─ OPERATIONAL INTELLIGENCE ───────────────────────────────────────────────────────────────┐
│ By type [bars] │ By severity [bars] │ Verified/unverified [donut] │ Avg verify/response │ 24h ▁▂▅▇▃ │
└────────────────────────────────────────────────────────────────────────────────────────────┘
┌─ OPERATIONAL IMPACT ──────────────────┐ ┌─ SITUATION BRIEFING ─────────────────┐
│ Critical infra hit: 12 (Hosp 3·Pwr 5) │ │ • Emerging hotspot: cluster @lat,lng │
│ Service disruptions (telecom): 8      │ │   12 reports/60min, 4 devices        │
│ Lives impacted (sum): 140             │ │ • Verification backlog: 18 pending,  │
│ Responders active: 11                 │ │   oldest 9h > 4h target              │
│ ▸ Population/displaced: needs data     │ │ • Concentration: 60% of criticals in │
│   integration (WorldPop/IOM)          │ │   top-2 clusters    [sourced·14:30]  │
└───────────────────────────────────────┘ └──────────────────────────────────────┘
┌─ RECENT OPERATIONAL ACTIVITY ────────────────────────────────────────────────────────────┐
│ Type      Place         Sev   Verify     Status      Updated   →                          │
│ Flood     Patna, IN     CRIT  unreviewed PENDING     2m   [open]                          │
└────────────────────────────────────────────────────────────────────────────────────────────┘
[ Operations Center ] [ Crisis Forms ]ᴬ [ Organisation ]ᴬ [ Account ] [ Users ]ᴬ [ Exports ]   ← §8
```
Responsive: ≥1280 = 2-col body; 768–1279 = map full-width then stacked; <768 = single column, KPI strip horizontally scrollable, map collapsible.

---

## 7. High-Fidelity UI Specification (design system)

- **Theme:** dark command-center. Background `#0B1220` (canvas), surface `#121A2A`, raised `#1A2740`, hairline `#243149`. Text `#E6EDF7` / muted `#8A99B5`.
- **Severity palette (single source, mirror `SEV_COLOR` `cc-home.js:152`):** CRITICAL `#FF3B47`, SEVERE `#FF8A3D`, MODERATE `#FFC53D`, MINOR `#3DA5FF`, UNKNOWN `#5C6B85`. Status: RESPONDING `#2DD4BF`, RESOLVED `#34D399`, FALSE_ALARM/REJECTED `#6B7280`.
- **Accent:** UN blue `#418FDE` (UNDP-aligned) for primary actions/links.
- **Typography:** Inter/system stack. Display 28/600, section 15/600 uppercase tracked, KPI number 32/700 tabular-nums, body 13–14/400, mono for coords/IDs. Tabular figures for all metrics.
- **Spacing:** 8px base; cards 16px pad, 16px gap; 12-col grid, 24px gutters; radius 12px; subtle elevation shadow, 1px hairline borders.
- **Motion:** ≤150ms; count-up on KPI change; pulse on new CRITICAL only. Respect `prefers-reduced-motion`.
- **A11y (must-have, Lighthouse ≥90):** never color-only — pair severity color with icon + text label; AA contrast on dark; full keyboard nav; `aria-live="polite"` on the KPI strip + briefing; focus rings; map has an accessible list fallback.
- **Density:** high info density, generous within-card whitespace; leadership can scan top row in <10s.

---

## 8. Component-Level Specifications

Template per component: **Purpose · Data source · API · DB · Refresh · Error · Empty · Permission.**

### C1 — Executive KPI Strip (§1)
- **Purpose:** answer "how bad, how much, what's the trend" in <10s.
- **Data/API/DB:** `GET /analytics/summary?window=24h` (NEW) → all counts + deltas; until built, fall back to `GET /reports/?limit=1` `X-Total-Count` (total only) + client tallies over loaded reports. DB per §3 rows 1–9.
- **Refresh:** 30 s poll, ETag/304; count-up animation on change.
- **Error:** keep last good values, show a small "stale Xs ago" pill; never blank.
- **Empty:** zero-state "No active incidents — all clear" (not an error).
- **Permission:** viewer+. Tiles needing admin data (none in v1) hidden otherwise.

### C2 — Global Crisis Snapshot map (§2)
- **Purpose:** where it's happening + severity geography + emerging hotspots.
- **Data/API:** loaded reports (`GET /reports/`) for markers; `GET /reports/nearby` for hotspot rings (tier/burst/acute); `GET /analytics/crisis-top10` for top-affected centroids; client `world.json`+Turf for country tint.
- **DB:** reports + `Location.lat/lng`.
- **Refresh:** 30 s; reuse `app.js` Leaflet/cluster/heat config (don't relocate its DOM — instantiate a second lightweight map on the landing).
- **Error:** map tiles fail → show last render + offline tile note. **Empty:** "No geolocated incidents in window." **Permission:** viewer+.

### C3 — Immediate Attention queue (§3)
- **Purpose:** the action center — what to do now, each row routes into the workflow.
- **Data/API:** `GET /buildings?has_unresolved=true&order_by=humanitarian_priority&order_dir=desc&limit=20` (escalating/critical), `GET /reports/?since=` (new criticals), client-derived buckets: critical-unreviewed, stale (age>threshold), escalating (`escalation_risk≥70`), dispatched-no-arrival, SLA-at-risk (§4-C config).
- **DB:** buildings scores/state + reports timestamps/verdict.
- **Refresh:** 20 s. **Error:** per-bucket independent; one failing bucket doesn't blank the panel. **Empty:** "Nothing requires immediate attention." **Permission:** viewer sees; action buttons require analyst (else routed to read-only detail). Each item → `#/incidents;chips=<filter>`.

### C4 — Operational Intelligence (§4)
- **Purpose:** distributions + efficiency.
- **Data/API:** `GET /analytics/summary` (type/severity/verified/open distributions, avg verify & response time) + `GET /analytics/damage-rate-24h` (sparkline). Render with existing CSS-bar pattern (`.ac-tbar`), no new dep.
- **DB:** §3 rows 14–17. **Refresh:** 60 s. **Error:** show "—" per missing metric. **Empty:** "No data in window." **Permission:** viewer+.

### C5 — Operational Impact (§5, re-scoped)
- **Purpose:** real operational consequences (NOT census).
- **Data/API:** `GET /analytics/summary` → critical-infra count (by `infrastructure_type`/`sub_type`), service/telecom disruptions (`service_status` JSON), `SUM(lives_impacted)`, active responders (`building_responders cleared_at IS NULL`).
- **DB:** §3 rows 18–20. **Refresh:** 60 s. **Gap row:** a clearly-labeled, **non-fake** "Population exposure & displacement — requires external data integration (WorldPop / IOM DTM)" placard with an "About this data" link — shows the roadmap without inventing numbers. **Permission:** viewer+.

### C6 — Situation Briefing (§6) — real intelligence, not generic text
- **Purpose:** turn aggregates into operator-ready insights.
- **Generation (rule-based v1, fully deterministic + sourced):**
  - *Emerging hotspot* ← `/reports/nearby` groups where `is_burst||is_acute` → "N reports / M devices near {label} in {window}."
  - *Verification bottleneck* ← `summary.pending_verification` + oldest-pending age vs target → "X reports pending; oldest {h}h."
  - *Escalating region* ← `/buildings` with `escalation_risk≥70` → ranked list.
  - *Response delay* ← `summary.avg_response_time` vs rolling baseline.
  - *Concentration risk* ← `/analytics/crisis-top10` → "% of criticals in top-K clusters."
  - Each card shows its **source endpoint + computed-at timestamp**.
- **Optional LLM layer (🟡, flag):** the stack already uses Claude (`truth_scorer.py`); a `POST /analytics/briefing` could pass the **real aggregates** (not raw PII) to Claude for a 3-sentence narrative. Must label "AI-summarized from live data" and never invent figures. Out of v1 unless approved.
- **Refresh:** 5 min. **Error:** drop the card whose source failed. **Empty:** "No notable patterns in window." **Permission:** viewer+ (LLM variant analyst+).

### C7 — Recent Operational Activity (§7)
- **Purpose:** live audit/operational stream.
- **Data/API:** admin → `GET /auth/audit-log` (last 500, real actor+action+resource+time). viewer/analyst → `GET /reports/?since=` recent rows (type, severity, status, reviewer_verdict, place via client geocode). Columns: Type · Place · Severity · Verify status · Status · Updated · → (open).
- **DB:** `AuthAuditLog` / reports. **Refresh:** 20 s. **Error:** last good + stale pill. **Empty:** "No recent activity." **Permission:** audit-log admin-only; reports-fallback viewer+.

### C8 — Quick Actions (§8)
- **Purpose:** demoted navigation.
- **Data/API:** none (router). Items: Operations `#/incidents`, Crisis Forms `#/reporting`ᴬ, Organisation `#/org`ᴬ, Account `#/users`, User Mgmt (admin view of `#/users`)ᴬ, Exports → `/exports/*`.
- **Permission:** admin-only items (ᴬ) hidden/disabled for non-admin (reuse `isAdmin()` `cc-home.js:29` + `ROUTE_ROLES` `router.js:33`). **Error/Empty:** n/a.

---

## 9. Engineering Implementation Plan

### Frontend (all in `web-dashboard/src/cc-home.js` + its injected styles; **`app.js` untouched**)
1. Replace `openLanding()`'s innerHTML (`cc-home.js:179-206`) with the §5 grid; keep the overlay/router wiring (`go()` `cc-home.js:211`, `ensureOverlay()` `:131`).
2. New render funcs: `renderKpiStrip`, `renderMiniMap` (own Leaflet instance on a landing container — libs already loaded in `index.html`), `renderAttentionQueue`, `renderOpsIntel` (reuse `.ac-tbar` CSS-bar pattern), `renderImpact`, `renderBriefing`, `renderActivity`, `renderQuickActions`.
3. Data layer: one `loadSummary()` (ETag-cached, 30 s) + reuse the existing conditional-GET helper; per-section pollers at the cadences in §8. Centralize severity colors (import the single palette).
4. Role gating: extend `isAdmin()`/`ROUTE_ROLES`; hide admin-only KPIs/sections + §8 items.
5. Deep links: build `#/incidents;chips=<status|severity>` strings (router preserves segments).

### Backend (one new module unlocks the dashboard)
1. **NEW** `backend/app/api/endpoints/analytics.py` → `GET /api/v1/analytics/summary` (`require_viewer`), `?window=24h|7d`. Returns: `{counts:{active,critical,pending_verification,awaiting_triage,open_dispatch,resolved_24h,active_ops}, distributions:{by_severity,by_crisis_type,by_status,verified_vs_unverified}, timings:{avg_verification_seconds,avg_response_seconds}, impact:{critical_infra,telecom_disruptions,lives_impacted_sum,responders_active}, deltas:{vs_yesterday,wow}}`. Implementation = a set of indexed `GROUP BY`/`COUNT`/`AVG` queries (all columns indexed per §2.4); exclude soft-deleted; 30–60 s in-process cache + `ETag`/`X-Total-Count`; designed for 500k rows (no N+1, `joinedload` not needed — pure aggregates).
2. **§4-A (recommended next):** `Location.country` (+`admin1`) column + alembic migration + reverse-geocode backfill (geocoder exists) + add `countries_impacted` + `by_country` to summary.
3. **§4-C (optional):** SLA threshold config (env or small table) + `is_breached`/`age_seconds` computed at read-time in summary (mirrors existing `response_time_seconds` pattern).
4. **§4-F:** warm the acute-cluster cache on boot.

### Caching / performance
- Summary endpoint cached 30–60 s (matches poll cadence) + ETag → 304s keep idle cost <1 KB (mirrors `/reports/` conditional-GET).
- Reuse existing `?since=` delta sync for feed/activity.
- All aggregates hit indexed columns (`status`, `severity`, `crisis_type`, `server_created_at`, `reviewer_verdict`, `buildings.state`). Verify `EXPLAIN` < 50 ms at 500k.
- No new client lib (reuse Leaflet + CSS bars).

### Rollout
- Phase 1 (v1, ~1 wk FE + 2–3 d BE): §1–4, §7, §8 on the summary endpoint + existing APIs.
- Phase 2 (~1 wk): §6 briefing (rule-based), §3 SLA/stale config, country column + choropleth.
- Phase 3 (gated on decisions): LLM briefing; external population/displacement integration (§4-B).

---

## 10. Deployment Readiness Review (acceptance gates)

- [ ] **No dummy/placeholder/hardcoded values** — every rendered number traces to an API response (grep the new `cc-home.js` for literals; CI check).
- [ ] **Every widget → real endpoint** — §3 matrix is the checklist; any 🔴/🟡 either shipped with its real backing or rendered as an explicit, non-fake "data integration required" state.
- [ ] **Permissions respected** — viewer sees read-only; analyst sees actions; admin-only sections/KPIs/§8 items hidden for lower roles; backend 403 is the real boundary (client gating is UX only).
- [ ] **Empty + error states** for all 8 components (no infinite spinners; last-good + stale pill).
- [ ] **A11y** — Lighthouse ≥90; severity never color-only; keyboard + `aria-live`; map list fallback.
- [ ] **Perf** — summary endpoint `EXPLAIN` <50 ms @ 500k; landing TTI <2 s; idle poll <1 KB via 304.
- [ ] **SW/release** — dashboard isn't PWA-precached, but bump any dashboard release tag; run `node scripts/sync-release-tags.mjs --check`.
- [ ] **No AI attribution** in code/commits (the project invariants).
- [ ] **Tests** — new e2e `dashboard/*-landing-intel.spec.ts` asserting each KPI renders from a mocked summary response + role gating; backend pytest for `/analytics/summary` aggregates.
- [ ] **Local-first** — verified against `localhost:8000/8080`; no PROD push without explicit approval.

---

### Open scope decisions (need operator sign-off before Phase 2/3)
1. **Humanitarian Impact (§5):** ship real "Operational Impact" only (recommended), or commit to WorldPop/IOM integration (§4-B, weeks + licensing)?
2. **Countries impacted:** interim client-side derive, or add `Location.country` + backfill now (§4-A)?
3. **SLA/stale:** hardcoded per-severity thresholds (interim) or a real SLA-policy table (§4-C)?
4. **AI briefing:** rule-based only (v1), or add the Claude-narrative layer over real aggregates?
5. **Charts:** reuse hand-rolled CSS bars (recommended, no dep) or add a chart lib?
