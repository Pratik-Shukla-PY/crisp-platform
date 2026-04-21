# UNDP RAPIDA Alignment — April 2026 Sprint Changelog

Closed the 🔴 critical + 🟠 high-severity gaps from the gap analysis at
`.claude/plans/swirling-forging-raccoon.md`. Each section references
the gap-analysis section number.

## Taxonomy & data model (§3.3 – §3.5)

* **§3.3 Damage labels** — `DamageClassEnum` expanded with `MINIMAL`;
  `NO_DAMAGE` kept as a deprecated alias. Taxonomy hook in
  `backend/app/models/report.py` rewrites legacy values on write. KML
  colour map + dashboard CSS accept both labels. Tests:
  `backend/tests/test_schemas.py::TestUNDPDamageRoundTrip` (2) +
  `TestReportTaxonomyHook` (3).

* **§3.4 Infrastructure taxonomy** — enum extended with the seven UNDP
  super-types (`RESIDENTIAL`, `COMMERCIAL`, `GOVERNMENT`, `UTILITY`,
  `TRANSPORT_COMMUNICATION`, `COMMUNITY`, `PUBLIC_SPACES`, `OTHER`) +
  new `infrastructure_sub_type` String column to preserve the original
  fine-grained chip. Write-time hook remaps legacy chips (`ROAD` →
  `TRANSPORT_COMMUNICATION`, `HOSPITAL` → `COMMUNITY`, …) and
  backfills sub_type. Mapping lives in `app.core.taxonomy.UI_CHIP_TO_UNDP`.
  Tests: `backend/tests/test_schemas.py::TestReportTaxonomyHook::
  test_hook_remaps_legacy_infra_chip` (+ the UNDP-native preservation
  case).

* **§3.5 Crisis types** — `CrisisTypeEnum` extended with `TSUNAMI`,
  `EXPLOSION`, `CHEMICAL_INCIDENT`, `CIVIL_UNREST`. New
  `crisis_category` column (NATURAL / TECHNOLOGICAL / HUMAN_MADE /
  OTHER) derived at write time via
  `app.core.taxonomy.categorise_crisis`. Tests:
  `backend/tests/test_schemas.py::TestUNDPTaxonomy` (6).

## Migrations + DB posture (§3.9)

* Alembic wired (`backend/alembic.ini`, `backend/migrations/env.py`).
* Baseline migration `7964f14c120d` captures the current schema.
* Follow-on `0002_bf_cat` adds `crisis_category` if missing + backfills
  the UNDP category + rewrites legacy `NO_DAMAGE` → `MINIMAL`.
* `0003_infra` adds `infrastructure_sub_type` + remaps legacy chips.
* `.env.production.example` documents the Postgres DSN + required
  secrets; `config.py` docstring explains the dev-vs-prod split.
* `docs/MIGRATIONS.md` walks operators through stamp + upgrade.
* Tests: `backend/tests/test_migrations.py` (3) — exercises the
  fresh-DB, legacy-DB, and schema-drift paths against a throw-away
  SQLite file.

## Non-monetary incentives (§3.8)

* Badge ladder keyed off `verified_count`, not raw submissions.
  `_update_reporter_profile` still increments raw count for
  fraud-detection but does not surface it.
* New helper `_mark_report_verified_for_credibility` called on
  `dispatch_team` + `resolve_report` when a report moves out of
  PENDING — idempotent per report.
* PWA home-screen stat: "Reports Submitted" → "Reports Verified"
  (`#home-verified-count` + `data-i18n=home_metric_verified`).
* Policy doc: `docs/INCENTIVES.md` cites the UNDP clause verbatim.
* Tests: `backend/tests/test_reporter_profile_counter.py::
  TestUNDPQualityBasedCredibility` (4).

## Export formats (§3.7)

* PDF dossier at `GET /api/v1/exports/pdf` — per-report one-page
  spread with UNDP-aligned labels. Built with ReportLab. Filter query
  params mirror the CSV/GeoJSON endpoints.
* Tests: `backend/tests/test_api_exports.py::
  test_pdf_export` (+ empty + auth variants).

## Building-footprint selector (§3.2)

* PWA: new `building-select.js` module; `<details>` on stage-review;
  Leaflet + Overpass fetch with IndexedDB cache for offline reuse.
* `ReportMetaCreate.building_id` accepts the user's explicit pick; the
  existing `_auto_assign_building_id` only fires when absent.
* Tests: `e2e/tests/pwa/12-building-footprint.spec.ts` (3).
* RN: design doc at `docs/BUILDING-FOOTPRINT.md` — implementation
  deferred because `react-native-maps` requires a native rebuild
  outside this sprint's scope.

## Multilingual (§3.1)

* **RTL layout** — `html[dir=rtl]` applied whenever an RTL locale
  activates (`_applyTextDirection`). CSS overrides in `styles.css`
  flip the flow-progress bar, chip rows, and nav buttons. Tests:
  `e2e/tests/pwa/13-rtl-layout.spec.ts` (5).
* **UN 6-language packs** — UNDP_I18N_EXTRA pack layers April-2026
  keys (`minimal_damage`, `tsunami`, `explosion`,
  `chemical_incident`, `civil_unrest`, `home_metric_verified`,
  `residential`, `commercial`, `utility`, `transport_communication`,
  `community`, `public_spaces`, `building_select_*`) on top of the
  existing dense packs for FR / ES / AR / RU / ZH + UR.

## Landmark / w3w fallback (§4.2)

* New endpoint `POST /api/v1/reports/geocode/describe` — wraps the
  existing multi-layer geocoder (Claude Haiku → Mapbox → Nominatim)
  and optionally enriches with what3words when `W3W_API_KEY` is
  configured.
* Tests: `backend/tests/test_geocode_describe.py` (5).

## Appendix-1 module levels (§3.6)

* `ServiceStatusEnum` extended with `INTERMITTENT`, `LOAD_SHEDDING`,
  `BLACKOUT` (5-level electricity) and `FULLY_OPERATIONAL`,
  `PARTIALLY_OPERATIONAL`, `NOT_OPERATIONAL` (4-level health).
* Mapping doc: `docs/UNDP-MODULES.md`.

## 48-hour deployment (§4.1)

* `docs/DEPLOYMENT_RUNBOOK.md` — full T-0 → T+48h runbook with
  spec'd infrastructure, env-var checklist, smoke tests, and rollback.

## Pitch-deck accuracy

* `CRISP-Presentation.html` edits:
  * "Claude Sonnet" → "Claude Haiku (default) / Sonnet (enterprise)"
    everywhere the deck referenced it.
  * Autonomous-AI claim softened to "analyst click, Haiku analyses".
  * PostgreSQL claim left intact — now backed by code via Alembic +
    `.env.production.example`.

## Test count delta

| Surface | Before | After |
|---|---|---|
| Backend pytest | 107 | 134+ |
| PWA Playwright | 11 specs | 13 specs (new: 12-building, 13-rtl) |

## Out of scope (deferred per sprint plan)

* Modular-forms framework (§3.6 long tail) — current ship is
  value-alignment; a config-driven form layer is a post-June 2026
  item.
* RN building-footprint overlay — design doc only; native-build
  impl deferred.
* k6 load-test results as TRL-4 evidence — scripts exist, a single
  baseline run against staging is required but couldn't happen in
  this sprint (no staging infra spun up).
* Pitch video — not a code deliverable.

---

*Sprint author: CRISP platform maintainers, April 2026. Closes
GAP-ANALYSIS §§3.1, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.1, 4.2 and
the pitch-deck accuracy items. §3.2 closed for PWA; RN parity flagged.*
