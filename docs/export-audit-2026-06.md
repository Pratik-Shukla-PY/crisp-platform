# CRISP Export & Output Formats Audit - June 2026

First-principles audit of every report output, export, downloadable artifact and
data-sharing capability, mapped against UNDP requirements (Problem Statement
must-have 1b "collect, validate, store and **export**"; Webinar Q&A #14 export
schema; must-have #11 satellite columns; Q&A #18 privacy-aware sharing).
Method: four parallel code audits (backend formats, dashboard UX journeys,
citizen-facing artifacts, metadata/packaging completeness) - every claim carries
file:line evidence.

---

## 1. Export Capability Audit - what exists today

### 1a. Backend bulk exports (`/api/v1/exports/*`, auth: viewer+)

| Format | Endpoint | Fields | Filters | Verdict |
|---|---|---|---|---|
| **CSV** | `GET /exports/csv` (exports.py:168-210) | 31 columns: full UNDP set (id, source, status, severity, infra type/sub/name, damage 3-tier, crisis type+category, description, debris, service status ×4, pressing needs, reporter tier, building_id, lat/lng decimal degrees, location name, lives impacted, ISO timestamp) **+ 6 satellite columns** | status, crisis_type, since, until | ✅ strongest format |
| **GeoJSON** | `GET /exports/geojson` (:215-244) | Point features, same 31-property set | same | ✅ |
| **Shapefile** (zip) | `GET /exports/shapefile` (:249-330) | 17 DBF fields, WGS84 .prj | same | ⚠️ **missing all 6 satellite columns - violates must-have #11**; DBF truncation |
| **KML** | `GET /exports/kml` (:624-698) | placemarks, damage-colored, ExtendedData | same | ✅ (satellite columns present) |
| **PDF dossier** | `GET /exports/pdf` (:341-619) | one page/report: full field table incl. building-version row, satellite block, **embedded photo thumbnails** + stable media/audio URLs | same + `limit` (≤1000) | ⚠️ silent truncation; description not XML-escaped |

Plus: per-building dossier **PDF/GeoJSON/CSV** (building_dossier.py, served via
buildings.py:876-998, audit-logged as `DOSSIER_EXPORTED`); public **evidence
JSON** (`/reports/{id}/evidence`, no auth, PII-safe); **GDPR export**
(`/auth/me/data-export`); **PWA my-data JSON** (`/reports/device/{hash}`);
stable media/satellite redirects; analytics JSON (no file export); OpenAPI
`/docs`.

### 1b. Dashboard export surfaces (9 distinct, inconsistent)

| Surface | Clicks | Problem |
|---|---|---|
| Tools → Export… → CSV/GeoJSON | 4 | **client-side** assembly - omits the 6 satellite columns (must-have #11 violated on the PRIMARY path); respects only status+time filters, not search/chips/drill |
| Tools → Export… → Shapefile/KML | 4 | **BROKEN for every role**: `window.open` (app.js:9543-9546) bypasses the fetch auth interceptor → 401 in a new tab, while the UI toasts "Downloading … export" success |
| Landing command-bar "Exports" pill | 2 | fastest path, but a forced context switch: teleports the user from the Control Center into `/incidents` with a dropdown hanging open; **no route back to the Control Center exists in the ops view** |
| Feed tree-node "Export Data" (hover icon) | 2 | exports from **unfiltered** `allReports` while the visible tree is filtered - a node badge showing 3 can export 10 rows; invisible on touch; CSV-only |
| Hotspot card "Export" | 2 | faithful id-list, but stale snapshot + fixed filename `crisp_hotspot.csv` |
| Building console CSV/GeoJSON/"PDF Report" | 3-4 | fine (entity-scoped, audited) |
| Detail panel "Export PDF" | 3+OS dialog | print-window flow, separate codepath from /exports/pdf |
| Evidence share-link | 2 | fine |
| Analytics panel | - | **no export at all** (dead end) |

**Terminology: one concept, nine labels** ("Export…", "Exports", "Export Data",
"Export", "Export dossier", "PDF dossier", "PDF Report", "Export PDF", "Save as
PDF"). The landing pill is also hard-coded English (not i18n'd).

### 1c. Citizen / channel artifacts

PWA: Settings → "Export my data" JSON (Annex 2(f) access right, shipped Jun 2026);
Badge Studio PNG + OS share. RN: badge share only. Telegram/WhatsApp/SMS send a
report-ID receipt (SMS includes DELETE instructions); **IVR speaks a confirmation
but gives no report ID**. `/auth/me/data-export` has **no UI consumer** anywhere.
No citizen-obtainable report PDF/receipt artifact.

---

## 2. UNDP Requirements Mapping

| Requirement | Source | Support | Gap |
|---|---|---|---|
| Export formats "such as GeoJSON, GPKG, or CSV" | Q&A #14 | **Full** (CSV+GeoJSON+SHP+KML+PDF; GPKG absent but list is illustrative) | GPKG optional |
| Decimal-degree coords, timestamp, 3-tier damage, infra type | Q&A #14 | **Full** in CSV/GeoJSON/KML/PDF | Shapefile lacks nothing here, but truncates |
| Satellite verification columns in every export | must-have #11 | **Partial** | Shapefile (backend) + CSV/GeoJSON (dashboard client path) omit them |
| Backend "collect, validate, store and export" | must-have 1b | **Full** | - |
| Building-level insight in exports | must-have 6/8 | **Partial** | building_id ✅; version ordinal/is_latest only in PDF |
| Privacy-aware sharing | Q&A #18 + §2.9 | **Full** | exports carry no PII (no device hash/phone/email; caller_info correctly excluded) |
| Media evidence | PS core indicator | **Partial** | PDF embeds thumbnails; CSV/GeoJSON/SHP/KML have **zero** media columns; **no evidence bundle ZIP** |
| Situational awareness (maps, density, geo summaries) | PS 1c | **Partial** | live dashboard ✅; no exportable map/sitrep artifact |
| Coordination / multi-agency formats | Q&A | **Partial** | REST+OpenAPI ✅; **no HXL/HDX tagging**, no scheduled distribution |
| Analytics outputs | PS 1b | **Partial** | dashboards ✅; no analytics export of any kind |
| Time chronology for offline reports | offline-first mandate | **Gap** | only server receipt time exported; `client_created_at` omitted |

---

## 3. Gap Analysis

**Broken / compliance (P0)**
1. Shapefile/KML download = guaranteed 401 with a false success toast (every role).
2. Shapefile missing the 6 satellite columns (must-have #11).
3. Dashboard's primary CSV/GeoJSON path (client-side) missing satellite columns (must-have #11).
4. CSV writer is hand-rolled `f'"{v}"'` - embedded quotes corrupt rows; no
   formula-injection (`=+-@`) guard; no row cap (full-table in RAM at 500k scale).
5. PDF: description not XML-escaped (`&`/`<` breaks ReportLab); silent `limit` truncation.
6. Invalid `since/until` silently ignored (exports.py:32-41) - wrong data, no error.

**Missing metadata (derivable today, one line each)**
`accuracy_meters`, `client_created_at` (offline chronology), location provenance
(`is_user_corrected`, `infrastructure_name_from_osm`, OSM id), `detected_language`,
`media_count` + first-photo stable URL, reviewer fields (`reviewer_verdict`,
`reviewed_at`, dispatch/arrival), `crisis_event_id`. Absent from the model:
per-report status-transition history.

**Missing packaging**
No HXL hashtag row (cheapest credible humanitarian-interop win); no evidence
bundle ZIP (judges fetch media one URL at a time); no sitrep/aggregate PDF; no
scheduled/email export; no GPKG; no data-dictionary in any download.

**Missing accountability**
No export audit logging on `/exports/*` (who pulled what dataset when) - the
building dossier already sets the precedent (`DOSSIER_EXPORTED`).

---

## 4. Export UX Review

Current journey (intern's eyes): "Exports" on the home page **navigates away**
into a dense operations view, opens a hover-styled dropdown, offers four
unexplained format names, two of which silently fail, and leaves you stranded
with no way home. Filters apply to some exports, not others, with no indication
which. Verdict: exports behave like a hidden operational function, exactly what
the brief says they shouldn't be.

Pain points: context switch + no return path; broken formats with success
toasts; filter-respect lottery; 9-label terminology; invisible hover/touch
affordances; no scope transparency ("what am I about to download?"); no
record counts; no format guidance for non-GIS users.

---

## 5. Information Architecture Recommendation

**Option C + B hybrid - a route-level Export Center (`#/exports`) opened as an
overlay module (same pattern as cc-settings/cc-crisis), reachable without
leaving context:**

- Landing command-bar "Exports" → opens the Export Center **over the landing**
  (no teleport; closing returns exactly where you were).
- Ops view gets one "Export" button → opens the SAME center **pre-scoped to the
  current on-screen filters** (contextual entry, Option B).
- Center contents: scope panel (all data / current filters / date range /
  crisis - with live record count), format cards with plain-language
  descriptions (CSV "for Excel/analysis", GeoJSON "for QGIS/ArcGIS",
  Shapefile, KML "for Google Earth", PDF dossier "for briefings"), building
  dossier shortcut, and a "recent exports" list once audit logging lands.
- All downloads go through the **backend** endpoints (auth-correct, satellite
  columns, server-side filters) via authenticated fetch→blob - the client-side
  CSV/GeoJSON assemblers retire to offline-fallback only.
- One label everywhere: **"Export"** / **"Export Center"**; i18n'd.

Rationale: a single discoverable home (evaluator-friendly), zero context loss,
one consistent data path (fixes #11 and the filter lottery structurally, not
piecemeal), additive - every existing endpoint and surface keeps working.

## 6. Wireframes

See HTML mockup delivered alongside this audit (Export Center overlay: scope
panel + format cards + record count + recent exports).

## 7. Implementation Roadmap

> **Status (2026-06-12): P0, P1 and P2 are IMPLEMENTED** (commits 0ec6480,
> 4dcfe78, 473da85, f911735 + the settings GDPR consumer). All five P0 fixes,
> the Export Center (`#/exports`, cc-exports.js) with scope preview + live
> count + recent-exports audit panel, filter parity, export audit logging,
> HXL row + data dictionary, appended metadata columns, analytics CSV +
> sitrep PDF, and per-report evidence bundles are live. A sixth P0-class fix
> emerged during verification: `Content-Disposition` was not CORS-exposed,
> so cross-origin dev silently lost server filenames on fetch→blob downloads.
> Remaining (P3, deliberately deferred): GPKG (operator decision, Jun 2026 -
> Shapefile+GeoJSON cover GIS interop), scheduled/email exports (needs infra),
> citizen receipt PDF, IVR report-ID readback (architecturally blocked: the
> report row is created asynchronously AFTER the call ends).

| # | Item | Effort | Risk | Depends on |
|---|---|---|---|---|
| **P0-1** | Fix Shapefile/KML auth (fetch→blob), kill false toast | S | low | - |
| **P0-2** | Add 6 satellite columns to Shapefile DBF | S | low | - |
| **P0-3** | Point dashboard CSV/GeoJSON at backend endpoints (filters passed through) | S | low | P0-1 pattern |
| **P0-4** | CSV: stdlib `csv` writer + formula-injection guard; 4xx on bad since/until; streaming/row cap | M | low | - |
| **P0-5** | PDF `_escape_xml` on description + visible truncation notice | S | low | - |
| **P1-1** | Export Center module (`#/exports`, cc-exports.js) + landing/ops entry points; retire 9-label drift | M | med (router/e2e) | P0-3 |
| **P1-2** | Filter parity: one `getFilteredReports`, tree-node export uses it; backend gains severity/bbox params | M | med | P1-1 |
| **P1-3** | Export audit logging (`EXPORT` event: user, format, filters, row count) + "recent exports" panel | M | low | P1-1 |
| **P2-1** | HXL hashtag row in CSV (+ data-dictionary sheet in downloads) | S | low | P0-4 |
| **P2-2** | Evidence bundle ZIP per report/crisis (photos+audio+evidence JSON+PDF) | M | med (size/timeouts) | - |
| **P2-3** | Metadata columns: accuracy, client_created_at, provenance, media_count+URL, reviewer fields, crisis_event_id | S | low (schema additive) | P0-4 |
| **P2-4** | Analytics export (summary CSV/PDF sitrep from /analytics/summary) | M | low | P1-1 |
| **P3** | GPKG; scheduled/email exports; citizen receipt PDF; GDPR-export UI; IVR report-ID readback | L | med | - |

Regression guards: existing pytest export suite + dashboard e2e (12/13/30);
new e2e for the center (auth'd blob downloads, filter scoping, satellite-column
presence asserted by parsing the downloaded CSV).
