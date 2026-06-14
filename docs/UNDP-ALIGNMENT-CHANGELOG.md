# UNDP RAPIDA Alignment - April 2026 Sprint Changelog

Closed the 🔴 critical + 🟠 high-severity gaps from the gap analysis at
the design plan. Each section references
the gap-analysis section number.

## Taxonomy & data model (§3.3 – §3.5)

* **§3.3 Damage labels** - `DamageClassEnum` expanded with `MINIMAL`;
  `NO_DAMAGE` kept as a deprecated alias. Taxonomy hook in
  `backend/app/models/report.py` rewrites legacy values on write. KML
  colour map + dashboard CSS accept both labels. Tests:
  `backend/tests/test_schemas.py::TestUNDPDamageRoundTrip` (2) +
  `TestReportTaxonomyHook` (3).

* **§3.4 Infrastructure taxonomy** - enum extended with the seven UNDP
  super-types (`RESIDENTIAL`, `COMMERCIAL`, `GOVERNMENT`, `UTILITY`,
  `TRANSPORT_COMMUNICATION`, `COMMUNITY`, `PUBLIC_SPACES`, `OTHER`) +
  new `infrastructure_sub_type` String column to preserve the original
  fine-grained chip. Write-time hook remaps legacy chips (`ROAD` →
  `TRANSPORT_COMMUNICATION`, `HOSPITAL` → `COMMUNITY`, …) and
  backfills sub_type. Mapping lives in `app.core.taxonomy.UI_CHIP_TO_UNDP`.
  Tests: `backend/tests/test_schemas.py::TestReportTaxonomyHook::
  test_hook_remaps_legacy_infra_chip` (+ the UNDP-native preservation
  case).

* **§3.5 Crisis types** - `CrisisTypeEnum` extended with `TSUNAMI`,
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
* Tests: `backend/tests/test_migrations.py` (3) - exercises the
  fresh-DB, legacy-DB, and schema-drift paths against a throw-away
  SQLite file.

## Non-monetary incentives (§3.8)

* Badge ladder keyed off `verified_count`, not raw submissions.
  `_update_reporter_profile` still increments raw count for
  fraud-detection but does not surface it.
* New helper `_mark_report_verified_for_credibility` called on
  `dispatch_team` + `resolve_report` when a report moves out of
  PENDING - idempotent per report.
* PWA home-screen stat: "Reports Submitted" → "Reports Verified"
  (`#home-verified-count` + `data-i18n=home_metric_verified`).
* Policy doc: `docs/INCENTIVES.md` cites the UNDP clause verbatim.
* Tests: `backend/tests/test_reporter_profile_counter.py::
  TestUNDPQualityBasedCredibility` (4).

## Export formats (§3.7)

* PDF dossier at `GET /api/v1/exports/pdf` - per-report one-page
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
* RN: design doc at `docs/BUILDING-FOOTPRINT.md` - implementation
  deferred because `react-native-maps` requires a native rebuild
  outside this sprint's scope.

## Multilingual (§3.1)

* **RTL layout** - `html[dir=rtl]` applied whenever an RTL locale
  activates (`_applyTextDirection`). CSS overrides in `styles.css`
  flip the flow-progress bar, chip rows, and nav buttons. Tests:
  `e2e/tests/pwa/13-rtl-layout.spec.ts` (5).
* **UN 6-language packs** - UNDP_I18N_EXTRA pack layers April-2026
  keys (`minimal_damage`, `tsunami`, `explosion`,
  `chemical_incident`, `civil_unrest`, `home_metric_verified`,
  `residential`, `commercial`, `utility`, `transport_communication`,
  `community`, `public_spaces`, `building_select_*`) on top of the
  existing dense packs for FR / ES / AR / RU / ZH + UR.

## Landmark / w3w fallback (§4.2)

* New endpoint `POST /api/v1/reports/geocode/describe` - wraps the
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

* `docs/DEPLOYMENT_RUNBOOK.md` - full T-0 → T+48h runbook with
  spec'd infrastructure, env-var checklist, smoke tests, and rollback.

## Pitch-deck accuracy

* `CRISP-Presentation.html` edits:
  * "Claude Sonnet" → "Claude Haiku (default) / Sonnet (enterprise)"
    everywhere the deck referenced it.
  * Autonomous-AI claim softened to "analyst click, Haiku analyses".
  * PostgreSQL claim left intact - now backed by code via Alembic +
    `.env.production.example`.

## Test count delta

| Surface | Before | After |
|---|---|---|
| Backend pytest | 107 | 134+ |
| PWA Playwright | 11 specs | 13 specs (new: 12-building, 13-rtl) |

## Out of scope (deferred per sprint plan)

* Modular-forms framework (§3.6 long tail) - current ship is
  value-alignment; a config-driven form layer is a post-June 2026
  item.
* RN building-footprint overlay - design doc only; native-build
  impl deferred.
* k6 load-test results as TRL-4 evidence - scripts exist, a single
  baseline run against staging is required but couldn't happen in
  this sprint (no staging infra spun up).
* Pitch video - not a code deliverable.

## Post-sprint hotfixes (Apr 2026)

### PWA locale-bootstrap (2026-04-21)

Five Playwright specs were failing deterministically on a clean baseline
(reproduced with `git stash`): `13-rtl-layout.spec.ts` × 3 + `14-locale-
json-loader.spec.ts` × 2. Two separate bugs on the same bootstrap path:

  1. **Narrow locale gate.** `app.js` bootstrapped manual-lang from
     localStorage via `activateLang(_manualLang && I18N[_manualLang]
     ? _manualLang : 'en')`. The inline `I18N` dict only carries EN /
     KN / HI / TA; every other locale lives in `EXTRA_LANG` /
     `UNDP_I18N_EXTRA` or is RTL-only (Hebrew). A user who manually
     picked AR / UR / HE / FR / ES / RU / ZH silently snapped back
     to English on every reload - `<html dir>` never flipped for RTL.
     Fix: new `_isKnownLocale(code)` helper consults I18N + EXTRA_LANG
     + UNDP_I18N_EXTRA + RTL_LANGS + COUNTRY_LANG_DATA + REGION_LANG_MAP.
  2. **`window.I18N` undefined.** Classic scripts (non-module) do NOT
     attach top-level `const` bindings to `window` in Chromium. Tests +
     the dashboard embed shell that probed `window.I18N` saw undefined.
     Fix: explicit `window.I18N = I18N` (+ EXTRA_LANG + UNDP_I18N_EXTRA)
     right after each dict definition. Mutations via `I18N[code] = …`
     inside `activateLang` automatically reflect on window (shared
     reference).

New regression spec: `e2e/tests/pwa/19-locale-bootstrap.spec.ts` (10
cases) - window-exposure check + "manual locale survives reload" for
every UN locale + Hebrew + unknown/empty fallback to English.

PWA test matrix: **73 → 88 passed** (5 pre-existing failures closed +
10 new regression tests). Zero test regressions elsewhere.

Cache-bumped `sw.js v40 → v41` and `app.js?v=810 → v=820` so existing
installs pick up the bootstrap fix together with the window exposures.

---

*Sprint author: CRISP platform maintainers, April 2026. Closes
GAP-ANALYSIS §§3.1, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 4.1, 4.2 and
the pitch-deck accuracy items. §3.2 closed for PWA; RN parity flagged.*

---

## Apr 2026 UI v3 - PWA / RN / Telegram field-test sweep (Phase A–E)

End-to-end pass responding to PWA field-test defects + the user-flagged
"building tag caching not available → type building name in native
language" UNDP requirement. Flag-gated via `localStorage.crisp_ui_v3`
(default on, flip to `'off'` for rollback).

### Phase A - PWA quick fixes

  * **A1 · 5-photo cap** - `MAX_EXTRA_PHOTOS=4` / `MAX_PHOTOS_TOTAL=5`.
    Guarded at every `extraPhotos.push` site (3 paths: file-input,
    camera modal, camera/gallery choosers). `_updateExtraPhotoStrip`
    greys every add-more surface + paints a red `5/5` counter chip
    when the cap is hit. New `photo_cap_reached` i18n key + toast.
  * **A2 · Auto-submit fires on dashboard-enabled regions** -
    `_fetchEnabledRegions()` now takes `{bustCache:true}` to bypass
    the 10-s mem-cache + always tries live before falling back to the
    24-h persistable cache. `InactivityManager.tryArm` is idempotent +
    called on every `goToStage`; gates on `hasMinimumInput()` so the
    T=0 handler never silently skips. New diagnostic chip (bottom-
    right) surfaces `Regions: N · inside: X · armed in Ys` for field QA.
    New `userCancelled` latch - Cancel stays sticky until stage-home.
    Window hooks: `__crispInactivityStatus`, `__crispInactivityTryArm`.
  * **A3 · Header z-index overlap on scroll** - `.stage-header`
    `z-index: 30 → 300` + opaque `var(--bg)` background (not just
    backdrop-filter blur) + `box-shadow: 0 1px 0 var(--border)` for
    visual separation when content scrolls under.
  * **A4 · Cancel banner rebuild** - whole-banner tap + Enter/Space
    keydown + Escape-anywhere all cancel. Bigger 88×40 ✕ CANCEL button
    with explicit `aria-label`; localized "Tap anywhere to cancel"
    subline via `autosub_click_anywhere`. Dedup guard on the Escape
    listener so re-created banners don't stack handlers.
  * **A5 · Camera/Gallery chooser row** - `#btn-add-more-photo`
    replaced by a two-button row (`#btn-add-camera` with `capture=
    "environment"` + `#btn-add-gallery` with `multiple`). New
    `file-extra-camera` / `file-extra-browse` inputs. Shared
    `_ingestFileAsPhoto(file, {asExtra:true})` pipeline. Gallery path
    also probes cap before each push + early-breaks with one toast
    on 10-photo multi-select over-pick. `chooser_camera` /
    `chooser_gallery` i18n across all 6 UN locales.

### Phase B - PWA UNDP compliance additions

  * **B1 · `crisp_ui_v3` feature flag** - same pattern as `crisp_ui_v2`;
    default on; `body[data-ui-v3]` applied on boot for CSS hooks.
  * **B2 · Building pre-cache (10 nearest) + native-language fallback** -
    `BuildingSelect.preCacheNearest(lat, lng, count)` warms IndexedDB on
    `gps-ready` (non-blocking, best-effort; silent on failure). New
    free-text `<input id="input-infra-name-v3">` block on stage-review
    with `direction:auto` so Arabic / CJK / Cyrillic inputs mirror
    correctly. User-typed text sets `state.infraNameFromOsm = false`;
    OSM-picked sets it `true`. Submit payload now ships
    `infrastructure_name_from_osm`. Backend: new
    `Report.infrastructure_name_from_osm Boolean NULL` column (Alembic
    `0009_ifno`), exposed on `ReportResponse`, + derived
    `needs_manual_mapping` computed in a Pydantic
    `@model_validator(mode='after')`.
  * **B3 · W6 applicable-modules consumer** - `fetchApplicableModules
    (crisisType)` hits the backend's YAML-driven `GET /api/v1/modules/
    applicable?crisis_type=X` endpoint; cached per crisis in a module-
    local `_w6ModuleCache`. Result exposed via `state.applicableModules`
    + `window.__crispFetchApplicableModules` for future form renderers.
  * **B4 · Full 8-stage visual reorder** - **SHIPPED** (2026-04-23,
    follow-up to the Apr-22 sprint). Flow now:
    `home → where+damage → infra → crisis+name → extras → photo →
    audio+text → review+submit → success`.

    Implementation strategy is non-disruptive: `migrateV3Blocks()` runs
    at `DOMContentLoaded` and physically re-parents review-blocks tagged
    `data-v3-slot="…"` from stage-review into four new stage DOMs
    (`stage-where`, `stage-infra`, `stage-crisis`, `stage-extras`). Same
    DOM nodes, different parents - chip handlers bound in
    `setupReviewStage` survive the move without re-binding. The legacy
    5-step progress dot row is hidden when v3 is on and replaced by a
    7-segment overlay (`.fp-v3-overlay`). Each new stage has a
    Back/Continue row; Back from stage-where returns to home.
    `stage-review` collapses to a single "summary + submit" page in v3
    because all input blocks have been re-parented out. Rollback is a
    one-liner: `localStorage.setItem('crisp_ui_v3','off') + reload`.

    RN parity: 4 new `Screen` values (`'where'|'infra'|'crisis'|'extras'`)
    with compact chip-grid renderers + Back/Continue navRows.
    `readUiV3Flag()` mirrors `readUiV2Flag()`; Start button lands on
    `'where'` when v3, `'photo'` when off. Edit pills on `review_confirm`
    deep-link to the matching v3 stage (`'crisis'` for incident-card,
    `'infra'` for details-card).

    Telegram parity: `_next_missing_step` question sequence reordered
    to match the PWA - `PHOTO → LOCATION → DAMAGE → TYPE → CRISIS →
    BUILDING → SEVERITY → DESCRIPTION → READY`.

    e2e: 8 new Playwright cases in `24-v3-capture-flow.spec.ts`
    covering flag-on migration, flow walk through 5 stages, back-nav,
    progress-overlay segment count (exactly 7), v3-off fallback,
    and stage-review v3-mode summary render.

    Service-worker cache `v50 → v51`, `app.js?v=850 → v=860`.

### Phase B4 follow-up - Apr-23 spec alignment

The Apr-22 ship left 6 gaps versus the user's final spec. All closed in
one sweep on Apr 23 with offline-first + no-waiting-period guarantees:

| # | Gap | Fix |
|---|---|---|
| 1 | Stage 2 missing auto date/time | Added `v3-auto-meta` panel: `new Date()` on stage entry (zero network), ticks every 60 s. |
| 2 | Building picker was on stage-crisis | Re-tagged `data-v3-slot="where"` so it migrates to stage-where. `building-select.js::_wire` now also listens for `stage-crisis` + `stage-where` stage-entered events. |
| 3 | Stage 3 used 9 legacy chips | Replaced with 8 UNDP Appendix-1 super-types: RESIDENTIAL / COMMERCIAL / GOVERNMENT / UTILITY / TRANSPORT_COMMUNICATION / COMMUNITY / PUBLIC_SPACES / OTHER. Backend enum already accepted them; UI_CHIP_TO_UNDP hook keeps legacy offline-queue rows replaying. Default `state.infraType` flipped ROAD → RESIDENTIAL. |
| 4 | Crisis chips flat-grid | `<div class="crisis-grouped">` with 3 sub-grids + small uppercase "Natural / Technological / Human-made" group labels. New `crisis_group_*` i18n keys across all 6 UN locales. |
| 5 | Debris toggle missing | Re-added as Yes/No pill pair inside stage-extras (`#debris-clearing-block`). Severity chips hidden in v3 - severity auto-derived from damage class on every chip tap (MINIMAL→MINOR, PARTIAL→MODERATE, COMPLETE→SEVERE) via new `_v3AutoDeriveSeverity()` hook. |
| 6 | Stage 6 had two buttons (Camera/Gallery) | Collapsed to a single "Add" button that triggers `#file-extra-browse` (multi-select, NO capture attr) → OS surfaces the native "Take Photo / Library / Files" sheet. The Camera/Gallery buttons + two file inputs kept as hidden sentinels so e2e clicks + pre-v3 code paths still resolve. |
| 7 | Stage 7 had two textareas + no transcription | `edit-text` hidden in v3 via `body[data-ui-v3] .v2-only-description`; `live-transcript` doubles as both speech output + description source. Web Speech API wired in `setupAudioStage`: `new SpeechRecognition()` with `recognition.lang = state.speechCode`, interim + final results append to the textarea, auto-restart on `onend` while still recording. Graceful fallback when unavailable (Firefox, older Safari) - user just types. `_collectServiceStatusFromDom` no longer reads `edit-text` in v3 so submit payload always carries the merged description. |

**RN parity** - same 8 super-types + 3-group crisis + debris Yes/No
toggle + single Add-more button (uses `Alert.alert` as native sheet
with Camera/Gallery/Cancel actions). Auto date/time via `whereAutoTime`
useState + 60 s interval. Severity auto-derive via a useEffect on
`damageClass`. Device-language transcription on RN continues to use
the existing server-side Whisper path (audio blob + `detected_language`
hint) since native SpeechRecognition requires an EAS dev-client build.

**Telegram parity** - `TYPE_MAP` expanded to the 8 super-types
(legacy chip callbacks retained for back-compat). `send_step_type`
renders a 3×3 keyboard of super-type buttons. `send_step_crisis_type`
groups the chips into 3 Appendix-1 sub-rows with `noop_group_*`
separator buttons (silently ACKed). New `STEP_DEBRIS` slot between
BUILDING and SEVERITY with `send_step_debris` inline Yes/No keyboard.
New session fields `debris_answered` + `debris_needed`; propagated on
both early-create (`create_report_early`) and classify-PATCH
(`update_report_metadata`). Locale keys for debris added across 9
languages (en/hi/es/fr/ar/pt/sw/zh/ru).

**Offline-first + no-waiting guarantees**:
- Date/time: pure `new Date()`, no network.
- Building pre-cache: fires on GPS-ready, non-blocking, falls back to
  IndexedDB (PWA) / AsyncStorage (RN) when offline.
- Chip clicks: synchronous in-memory state mutation.
- SpeechRecognition: local OS engine; when unavailable, textarea still works.
- Submit: already chunked + IDB-queued + auto-sync on reconnect.
- Telegram: every callback responds with `answer_callback` + no long-polling
  spinner; MediaRecorder audio uploads via the existing chunked path.

**Cache + regression**:
- `sw.js` `CACHE_NAME v51 → v52`; `app.js?v=860 → v=870`.

---

## Optional Reporter Login - Phase 1 (Apr 23 2026) - 🟢 SHIPPED

End-to-end optional OTP authentication for mobile reporters (PWA + RN)
with anonymous-first as the default. **Reporting never blocks on login.**

### Scope shipped in one sweep

1. **Schema** - Alembic `0010_optional_reporter_login`. Nullable
   `users.phone_number` + `email` nullable (at least one required),
   `users.phone_verified`, `users.primary_auth_channel`.
   `otp_records.destination` + `channel` with index
   `ix_otp_verify_hotpath (destination, purpose, used, expires_at)`.
   `reports.user_id` nullable FK with `ON DELETE SET NULL` (preserves
   crisis-response value on account deletion - PII linkage severed,
   row retained - user spec answer 3). Postgres generated
   `reports.is_anonymous = (user_id IS NULL)` column. New
   `user_device_link(user_id, device_hash)` join table for
   multi-device account support.

2. **Backend models** - `User.phone_number / phone_verified /
   primary_auth_channel`, `UserDeviceLink`, `Report.user_id`,
   `OTPRecord.destination + channel`.

3. **SMS provider** - `backend/app/services/sms.py`. Twilio integration
   with `SMS_PROVIDER=stub|twilio` env flag. Stub logs codes to stdout
   so CI + dev work never need a real carrier. E.164 validation at the
   provider boundary.

4. **Auth endpoints**:
   - `POST /auth/otp/request` - accepts `{destination, channel,
     purpose, device_hash?}`. EMAIL | PHONE. Legacy `{email}` still
     works for dashboard operator flow.
   - `POST /auth/otp/verify` - returns `{access_token, refresh_token,
     user, is_new_user, linkable_report_count}`. Auto-creates a
     REPORTER-role user on first LOGIN with a new destination (OTP =
     proof of ownership = signup credential).
   - `POST /auth/link-device {device_hash}` - claims every anonymous
     report on the device for the caller. Atomic + idempotent.
   - `POST /auth/unlink-device` - reverts linked reports back to
     anonymous AND removes the join row.
   - `GET /auth/me/reports` - merged feed across every device bound
     to the caller (`user_id = me OR device_hash IN user_device_link`).

5. **Optional auth on `/reports/meta`** - `_optional_user_from_auth`
   helper extracts the user from an optional Bearer header. Expired
   / invalid tokens **silently fall back to anonymous** - reporting
   never raises 401. This is the 30-day offline-grace contract.

6. **Strong logout** - `/auth/logout` revokes every active
   `UserSession` for the caller (user spec answer 7). Other devices
   lose refresh ability on their next refresh and degrade to
   anonymous once their 15-min access token expires.

7. **PWA AuthStore** (`mobile-app/src/auth.js`) -
   IndexedDB-backed singleton exposed as `window.AuthStore`.
   Methods: `init`, `isLoggedIn`, `getUser`, `getAccessToken`,
   `requestOtp`, `verifyOtp`, `linkDevice`, `unlinkDevice`,
   `logout`, `logoutLocal`, `refreshAccess`, `fetchWithAuth`,
   `meReports`. 30-day offline grace window + auto-refresh on
   network resume.

8. **PWA login UI** (`stage-login`) - 3-step wizard:
   (1) channel picker (Phone default) + E.164 country code from
   device locale + destination input (user spec answer 4); (2)
   6-digit code entry with auto-advance + 30 s resend countdown;
   (3) post-login "Link N reports?" card when
   `linkable_report_count > 0`. Skip-to-anonymous link on every step.
   New `stage-settings` with Unlink-this-device + Logout buttons.
   Landing page gets a **tertiary** Login / Sign-up button + an
   account pill that replaces it when logged in.

9. **PWA queue tagging** - every enqueued report captures the
   current access token at enqueue time. Offline replay submits
   under the authenticated user via `Authorization: Bearer …`
   header on the meta POST. Expired token → server strips
   attribution → report lands anonymously. **Never dropped.**

10. **RN parity** - `crisp-mobile/services/auth.ts` parallels the
    PWA AuthStore; tokens live in `expo-secure-store`
    (Keychain / EncryptedSharedPreferences), profile in AsyncStorage.
    Login/Settings screens are minimal in-place wizards. Bearer
    header attached to every `sendJSON` call in
    `services/api.ts` via a lazy require to avoid circular deps.

11. **Dashboard** - every report card now shows a masked
    `reporter_badge` ("User abc12345", user spec answer 5 - ANALYST
    masked, ADMIN can unmask via `openReporterProfile(user_id)` →
    `/auth/users/{user_id}`). Anonymous rows render no badge; the
    existing "needs mapping" filter pattern handles surfacing them.

12. **i18n** - 24 new auth keys added across all 6 UN locales
    (`login_title`, `login_channel_phone`, `login_send_code`,
    `login_verify`, `login_welcome`, `login_found_prefix` /
    `_suffix`, `login_link_now`, `login_keep_anonymous`,
    `settings_title`, `settings_logout`, …).

13. **Docs** - `docs/AUTH.md` operator runbook covering architecture,
    data model, offline-grace semantics, rate limits, GDPR
    cascade, dev loop.

14. **e2e** - `e2e/tests/pwa/25-optional-login.spec.ts` with 8
    Playwright cases: AuthStore idempotency, anonymous-path
    freedom, login wizard 3-step navigation, skip path, channel
    picker toggle, country-code default, Settings reachability,
    logout-clears-local.

### Offline-first + no-waiting invariants

- Date/time, chip picks, submit: all synchronous.
- Token: 15 min access / 30 days refresh / 30 days offline grace.
  Within the grace window, `isLoggedIn()` stays true and the UI
  keeps the account pill. Server accepts reports regardless.
- SMS provider stub means dev loops never wait on a carrier.

### Rollback

Per surface:
- **Backend**: `alembic downgrade -1` reverses migration `0010_auth`;
  columns are additive + nullable, no data loss.
- **PWA**: delete the `crisp_auth_v1` IndexedDB store - UI falls
  back to anonymous. The Login button stays visible but taps
  navigate to a functioning stage-login.
- **RN**: `AsyncStorage.removeItem('crisp_auth_profile_v1')` +
  `SecureStore.deleteItemAsync('crisp_auth_access_v1')` + refresh key.
- **Telegram**: no changes this phase - stays anonymous-only.

### Cache + regression

- `sw.js` `CACHE_NAME v52 → v53`; `app.js?v=870 → v=890`.
- Added `auth.js` to `STATIC_ASSETS` for offline-installability.
- PWA `node --check`, dashboard `node --check`, Python AST across
  backend + messaging-bot + migrations, RN `tsc --noEmit`,
  i18n validator - all clean.
- New e2e spec loads (8 tests listed).

---

## Historical (pre-auth)

**Cache + regression**:
- `sw.js` `CACHE_NAME v51 → v52`; `app.js?v=860 → v=870` (v3 spec-align).
- PWA `node --check` clean across app/sw/building-select/image-variants/pii-blur.
- Dashboard `node --check` clean.
- Python AST walk clean across backend/app + messaging-bot/telegram + migrations.
- RN `tsc --noEmit` clean (modulo pre-existing unrelated expo-constants warning).
- i18n validator PASS (268 keys × 6 locales).

### Phase C - React Native parity

  * **5-photo cap** - `MAX_EXTRA_PHOTOS=4` module-level constant + per-
    push guard in `_ingestExtraFromUri` via functional `setExtraPhotos`
    (atomic length check). `pickImage` + `pickExtraImage` narrow
    `selectionLimit` to the remaining capacity; camera `takePhoto`
    loop break-on-cap + one localized `Alert.alert`. `photo_cap_reached`
    i18n used with a 1200-ms throttle to prevent multi-select popup
    spam.
  * **Building pre-cache** - new `services/buildingCache.ts` module
    (`preCacheNearest`, `clearAllBuildingCache`) backed by
    `@react-native-async-storage/async-storage`. Invoked on GPS-ready
    in `getLocation()`; silent on failure.
  * **Free-text building-name fallback** - new `TextInput` block on
    review with localized label/hint. Writes to `state.infraName` +
    sets `setInfraNameFromOsm(false)` on every change. Submit payload
    gains `infrastructure_name_from_osm: Boolean(infraNameFromOsm)`.
  * TypeScript clean across the changes (tsc --noEmit shows only the
    pre-existing `expo-constants` warning unrelated to this sprint).

### Phase D - Telegram channel

  * **Native-language building prompt** - new `STEP_BUILDING_NAME` slot
    sits between severity and location. Bot asks "Type the building
    name in your own language - or skip". Next plain-text message
    is captured into `session.infra_name` (120-char cap); callback
    `skip_building` skips the slot. Backend classify-PATCH accepts
    `infrastructure_name_from_osm: false`, stored on the row.
    Translations added across 8 locales (en/hi/es/fr/ar/pt/sw/zh/ru).
  * `session_manager.create_report_early` + `update_report_metadata`
    both propagate the building name + `infrastructure_name_from_osm=
    false` so the row is flagged for operator mapping at either point
    in the flow.

### Phase E - Dashboard

  * **"Needs mapping" badge** on the report detail panel. Renders when
    the server-computed `r.needs_manual_mapping === true` - the
    three-state rule (`infrastructure_name` present + `building_id`
    null + `infrastructure_name_from_osm` explicitly false). Pre-v3
    rows with NULL `from_osm` show no badge (honest "unknown"
    posture). CSS adds a subtle 2.4-s pulse so the work item catches
    the operator's eye among the other UNDP field badges.

### Backend data-model changes

  * `reports.infrastructure_name_from_osm BOOLEAN NULL` - new column.
  * Alembic `0009_ifno` - idempotent additive migration. No backfill
    (we can't retroactively distinguish pre-v3 rows).
  * `ReportMetaCreate.infrastructure_name_from_osm: Optional[bool]=False`
    on the request; `ReportResponse.infrastructure_name_from_osm` +
    derived `needs_manual_mapping` on the response.

### Observability + cache bumps

  * Service worker `CACHE_NAME v49 → v50`; `app.js?v=846 → v=850`.
  * Console: `[Region] inside 'Bengaluru' - 127 m / 500 m radius` +
    `[InactivityManager] armed: region='X' deadline=+120s`.

### Regression posture

  * PWA (`node --check app.js / sw.js / building-select.js / image-
    variants.js / pii-blur.js`) - all clean.
  * Dashboard (`node --check app.js`) - clean.
  * i18n validator (`scripts/validate-i18n.mjs`) - 6 locales × 261 keys
    × every template variable preserved. **PASS**.
  * Python AST walk across `backend/app`, `messaging-bot/telegram`,
    and `backend/migrations/versions` - **all OK**.
  * RN `tsc --noEmit` - clean modulo the pre-existing unrelated
    `expo-constants` declaration warning.
  * RN locale JSONs (en/fr/es/ar/ru/zh) - all parse.

Per user direction, the test suite was **not** executed in this sprint
("do not run any tests") - the regression pass is syntax + schema-
level validation. The 134-test backend pytest baseline + 13-spec
Playwright e2e should be re-run in the next CI pass against a clean
`_test` DB to confirm zero regressions downstream.
