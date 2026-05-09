# UI v4 Redesign — Complete Implementation Record

**Sprint:** May 2026
**Scope:** PWA frontend redesign + RN parity scaffold + supporting backend
**Outcome:** Click count 13–15 → 3–4 (happy path); 7+ stages → 3 stages; first-visit landing card with multi-channel discovery; native camera (Path B); AI pre-fill on fast networks.

---

## 1. Goals (from the user briefing)

The user's complaint with the v3 PWA:

| Concern | v3 reality | v4 target |
|---|---|---|
| Submit a report | 25+ clicks (with optional fields), 13–15 minimum | ≤ 10 clicks always |
| Stage count | 7+ capture stages (where → infra → crisis → extras → photo → audio → review → send) | 3 stages |
| Channel discovery | None — IVR / SMS / Telegram / WhatsApp / app-store options invisible | First-visit landing card surfaces all 6+ channels |
| "Add to Home Screen" prompt | Missing | Present (Chrome `beforeinstallprompt` + iOS slide-up sheet) |
| Viewport overflow | `.stage { position: absolute; inset: 0 }`, no max-height; text + boxes bled off-screen on small phones | Each v4 stage caps at `max-height: 100dvh`, fits 320×568 in all 6 UN locales |
| Existing features | All current behaviours must remain (Lives Saved, My Reports, login, language, building footprint, voice, multi-photo, offline, PII blur, GPS auto-detect, …) | Preserved verbatim — v4 reads the same `window.state` and delegates Send to the existing `submitReport()` |

User-locked decisions (recorded for future reference):

1. **Channel handles** — Show the buttons regardless. Real `tel:` / `sms:` / `t.me/` / `wa.me/` URLs when configured (`window.CRISP_CHANNELS` override or hard-coded defaults), "Coming soon" badge otherwise.
2. **iOS / Android apps** — Not yet published. iOS / Android tiles render "Coming soon." Expo Go tile is enabled for testers (`exp://` URL).
3. **AI pre-fill** — Bandwidth-gated. FAST tier or above → POST photo to `/api/v1/reports/classify-suggest` (Claude Haiku vision). SLOW / VERY_SLOW / offline → user fills chips manually with sensible defaults. Never block the user.
4. **"More details" accordion** — `<details open>` by default per UNDP-judge requirement. Compact layout enforced so the page still fits without scroll.
5. **Worktree** — Not used. Worked directly on `main` with feature flags (`localStorage['crisp_ui_v4']` + `?ui=v3` URL escape hatch) for safe rollback.

---

## 2. The four commits, in order

Every commit shipped green to production. Each is independently
rollback-safe via the `crisp_ui_v4` flag.

### Commit A — `3a322d9` — Landing card + install prompt + viewport fix

The first-visit experience. Pure additive — does not touch the v3
capture flow.

**Files added:**
- `mobile-app/src/install-prompt.js` (171 LoC) — wraps platform install paths in one helper. Fields:
  - Chrome / Edge / Android-Chrome → captures `beforeinstallprompt`, exposes `.show()` to the landing card.
  - iOS Safari → renders a 3-step "Share → Add to Home Screen → Add" slide-up sheet.
  - Already installed (`display-mode: standalone`) → hides the install card entirely.
- `mobile-app/src/landing.js` (379 LoC) — first-visit card. Channel deep-links + install prompt + inline consent + Lives Saved / Reports Verified mirror.

**Files modified:**
- `mobile-app/src/index.html` — added `<div id="landing-root">` mount and the two new `<script>` tags (loaded BEFORE app.js so InstallPrompt is on window when landing wires its install button).
- `mobile-app/src/styles.css` — landing card styles (350+ lines) + `.stage { max-height: 100dvh }` viewport-fit fix.
- `mobile-app/src/app.js` — `_initConsentGate` now early-returns when the landing overlay is present (prevents two consecutive consent modals); `updateHomeImpactMetrics` mirrors counts to landing card cells.
- `mobile-app/src/sw.js` — cache `crisp-v65 → crisp-v66`; `install-prompt.js` + `landing.js` added to `STATIC_ASSETS`.

**Tests added:** `e2e/tests/pwa/26-landing-v4.spec.ts` — 12 cases, all green:
- First-visit shows the landing card, returning visitors skip it.
- Legacy `#consent-overlay` is suppressed while landing is up.
- All 4 channel buttons + 3 app buttons render.
- Empty channel handles render as `<button>` with `.lc-soon` "Coming soon" badge.
- Configured handles render as `<a href>` with valid URLs.
- "Open the reporter" CTA is disabled until consent is checked.
- Tap dismisses landing + persists `localStorage['crisp_landing_seen']` + `crisp_privacy_consent`.
- `window.InstallPrompt` API surface (`canInstall`, `platform`, `show`, `onChange`).
- iOS install sheet renders 3 steps when triggered with iPhone UA.
- Viewport-fit at 360×640 (no horizontal scroll).
- `.stage` computed `max-height` is set (100dvh).

**Migration of 25 existing PWA specs** — every `beforeEach` that pre-set `crisp_privacy_consent` now also sets `crisp_landing_seen` so the v4 landing doesn't intercept tests written for the home stage. One-line `sed` change per file.

### Commit B — `557df24` — V4 capture flow + native camera + AI pre-fill

The biggest piece. Adds three new capture stages.

**Files added:**
- `backend/app/services/classify_suggest.py` (249 LoC) — wraps Claude Haiku for the 3-chip prediction. Strict UNDP enum sets (`infra` × 8, `crisis` × 9, `damage` × 3). Hard 3-second deadline. On every degraded path returns 200 with `source: "fallback"` so the client can use heuristics. `_fallback()` returns `{infra: RESIDENTIAL, crisis: EARTHQUAKE, damage: PARTIAL}`.
- `mobile-app/src/v4-flow.js` (737 LoC) — the 3-page state machine.
  - `_initCarousel(container)` — horizontal scroll-snap chip group, swipeable, with prev/next arrows + dots + IntersectionObserver for free-scroll. Public `._setValue(v)` + `._getValue()` API.
  - `_initCaptureStage` — wires the native `<input type=file capture=environment>` chain. Photo goes through `pii-blur.js::blurFaces` → `image-variants.js` → state. Auto-advance to Page 2 ~1 s after first photo lands.
  - `_initClassifyStage` — damage chips + 2 carousels (infra 8 / crisis 9). Listens to `v4:select` events from each carousel.
  - `_initReviewStage` — summary card with tap-edit pencils; voice/text drawer; UNDP details accordion (open by default).
  - `_maybeFireAiPrefill(blob)` — bandwidth-gated. Reads `window._pwaTier`. Skips if VERY_SLOW or SLOW. Resizes the blob to 640 px long-side. Posts to `/api/v1/reports/classify-suggest` with 1.5-second AbortController timeout. Updates chips on `source: "ai"` response.
  - `_onSend()` — delegates to `window.__crispSubmitReport()` (the same path v3 `#btn-send` uses). Identical `/reports/meta` payload.
  - `_hookBtnStart()` — capture-phase event listener intercepts `#btn-start` → `goToStage('stage-v4-capture')` when v4 enabled.
- `e2e/tests/pwa/27-v4-flow.spec.ts` (329 LoC) — 19 cases.

**Files modified:**
- `backend/app/api/endpoints/reports.py` — `POST /api/v1/reports/classify-suggest` route added. Validation: missing `image_b64` → 422; non-numeric lat/lng coerced to None; rate limit 60 req/min/IP. Always returns 200 (with fallback source) on success, never 5xx.
- `backend/tests/test_classify_suggest.py` (301 LoC, 16 cases) — service-level + endpoint-level coverage:
  - Service: missing key, empty image, oversize image, happy path with mocked Anthropic, markdown-fenced response, unparseable response, out-of-enum response, timeout, exception.
  - Endpoint: 422 on missing image, 422 on type-wrong image, 200 fallback when no key, media_type coercion, lat/lng coercion, rate limit, response shape.
- `mobile-app/src/index.html` — 3 new stage divs (`#stage-v4-capture` / `#stage-v4-classify` / `#stage-v4-review`) + `<script src="v4-flow.js?v=1">` + `app.js?v=1010`.
- `mobile-app/src/styles.css` — 585 lines of v4 stage CSS: grid layout (header/body/footer pinned), camera hero CTA, carousel scroll-snap, summary card, drawer accordions, pressing-needs chips.
- `mobile-app/src/app.js` — `window.__crispSubmitReport = () => submitReport()` exposure for v4-flow.
- `mobile-app/src/sw.js` — cache `crisp-v66 → crisp-v67`; `v4-flow.js` added to `STATIC_ASSETS`.

**Test results:**
- Backend: 428 / 0 fail (was 412 baseline + 16 new = 428).
- PWA (Commit A's 12 + Commit B's 19): 31 / 0 fail.

### Commit C — `4370ca8` — i18n for 6 locales

354 new translation pairs (59 EN keys × 6 UN locales).

**Keys added:**
- v4 capture flow strings (33): step indicators, hero CTA, classify titles, drawer headers, UNDP details (debris/electricity/health/needs), Send button.
- Landing card strings (8): title, subtitle, primary CTA, section headers, install prompt, consent line, footer.
- "Coming soon" badge (1).
- Infrastructure carousel labels (8 UNDP super-types).
- Crisis carousel labels (9 UNDP types).

**Files modified:**
- `mobile-app/src/i18n/{en,fr,es,ar,ru,zh}.json` — 59 keys each.
- `mobile-app/src/sw.js` — cache `crisp-v67 → crisp-v68`.

**Validation:** `scripts/validate-i18n.mjs` — PASS across all 6 locales.

**String-length budget:** chip labels ≤ 30 chars; prompts ≤ 70 chars. Spanish (1.4× EN) and Russian (1.6× EN) checked specifically — every label fits in the carousel slide width on a 320 px viewport.

### Commit D — `83c7908` — RN parity scaffold (deferred)

The RN companion's `App.tsx` is a 3,900-line monolith and the apps are
not published. Full v4 port is a 3-day refactor. This commit ships:

- `crisp-mobile/V4_PARITY_DEFERRED.md` — operator runbook for the eventual port: what needs to change in `App.tsx`, estimated effort, safe rollout pattern (worktree + `UI_V4_ENABLED` flag), how to flip the landing card's "Coming soon" buttons to real store URLs the day publish ships.
- `crisp-mobile/App.tsx` — `Screen` type extended with the 4 v4 values (`v4_landing | v4_capture | v4_classify | v4_review`); `UI_V4_ENABLED = false` flag added (default off on RN until the screens land).
- `crisp-mobile/services/i18n/{en,fr,es,ar,ru,zh}.json` — 59 v4 keys synced from the PWA, so when the RN port lands there's zero translation work.

TypeScript clean.

---

## 3. Architecture overview

### Page flow

```
                 ┌──────────────────────────────────┐
                 │   Page 0 — Landing (first-visit) │
                 │   • Open the reporter (primary)  │
                 │   • IVR / SMS / TG / WA          │
                 │   • iOS / Android / Expo Go      │
                 │   • Install prompt               │
                 │   • Consent checkbox             │
                 └──────────────┬───────────────────┘
                                │ (1 tap)
                                ▼
                 ┌──────────────────────────────────┐
                 │   Page 1 — Capture (Step 1/3)    │
                 │   • Auto location pill           │
                 │   • Auto time pill               │
                 │   • [📷 Take photo] hero         │   tap → OS native camera
                 │   • [📁 Browse]  [🎙 Voice only]  │   ← + thumbnail strip
                 └──────────────┬───────────────────┘
                                │ (1 tap + native shutter, auto-advance ~1s)
                                ▼
                 ┌──────────────────────────────────┐
                 │   Page 2 — Classify (Step 2/3)   │
                 │   • Damage chips (3, default Partial)│
                 │   • Infra carousel (8 UNDP types)│
                 │   • Crisis carousel (9 UNDP types)│
                 │   • [Continue]                   │   AI pre-fills on FAST
                 └──────────────┬───────────────────┘
                                │ (1 tap if defaults OK; +1-3 chip taps otherwise)
                                ▼
                 ┌──────────────────────────────────┐
                 │   Page 3 — Review (Step 3/3)     │
                 │   • Photo thumb + 4 tap-edit rows│
                 │   • Voice/text drawer (collapsed)│
                 │   • UNDP details (open by default)│
                 │     - Debris yes/no              │
                 │     - Electricity / health select│
                 │     - 10 pressing-needs chips    │
                 │   • [✓ Send to UNDP]             │
                 └──────────────────────────────────┘
                                │ (1 tap → submitReport → /reports/meta)
                                ▼
                          stage-success (existing)
```

### State sharing with v3

v4 reads/writes the SAME `window.state` object that v3 uses:
- Photo blob → `state.photoBlob` (pickled by v3 submit logic)
- GPS → `state.location.{lat,lng,acc}`
- Damage / infra / crisis → `state.{damage_classification, infrastructure_type, crisis_type}`
- Description → `state.description`
- Service status / debris / pressing needs → `state.{electricity_status, health_status, debris_present, pressing_needs}`

**Send delegates to `submitReport()`** — guarantees the v4 path produces an identical `/reports/meta` payload to v3. No backend changes needed for the submission contract.

### Feature preservation matrix

| Feature | Status | Where in v4 |
|---|---|---|
| Lives Saved metric | ✅ kept | Landing card top + persistent home screen |
| My Reports | ✅ kept | Landing chip + home button (`btn-my-reports` unchanged) |
| Optional login | ✅ kept | Landing chip + home account pill |
| Language change | ✅ kept | Top-right pill (unchanged) |
| Auto-detect language | ✅ kept | Background detection (unchanged) |
| Privacy consent | ✅ kept (merged) | Inline checkbox on landing card |
| Offline + SW + IndexedDB queue | ✅ kept | Backend untouched; SW cache `v68` |
| Building footprint | ✅ kept | `_refreshGps()` on Page 1 retries; Page 3 location row tap reopens picker |
| Voice + transcription | ✅ kept | Page 3 "Add voice" drawer routes to v3 mic chain |
| Multi-photo | ✅ kept | Page 1 "+ Add another" chip |
| Client + server PII blur | ✅ kept | Same `pii-blur.js` + `pii_blur.py` paths |
| Connectivity dot | ✅ kept | Top-right cluster |
| Service status / pressing needs / W6 | ✅ kept | Page 3 UNDP details accordion (open by default) |
| Adaptive bandwidth probe | ✅ kept | Backend untouched (`_pwaTier` reused for AI gate) |
| Binary chunk transport | ✅ kept | Backend untouched |
| Web Push | ✅ kept | Backend untouched |
| BlurHash + image variants + phash dedup | ✅ kept | Sync engine untouched |

### AI pre-fill flow

```
User takes photo  (Page 1)
        │
        ▼
pii-blur.js::blurFaces(blob) ──→ blurredBlob
        │
        ▼
_maybeFireAiPrefill(blurredBlob)
        │
        ├── tier === VERY_SLOW or SLOW? → return (skip)
        ├── offline? → return (skip)
        │
        ▼
resize to 640px long-side (canvas) ──→ smallBlob
        │
        ▼
fetch('/api/v1/reports/classify-suggest', {
  signal: AbortController(1500ms)
})
        │
        ├── 200 with source="ai"      → animate 3 chip rows to suggested values
        ├── 200 with source="fallback" → leave defaults in place
        ├── timeout / abort           → leave defaults
        ├── network error             → leave defaults
        │
        ▼
User taps Continue (one tap if defaults OK)
```

Server:
- 3-second `asyncio.wait_for` deadline on the Anthropic call.
- Strict UNDP enum validation — out-of-set responses fall back.
- Markdown fence parsing tolerates `\`\`\`json ... \`\`\`` even though the prompt forbids it.
- 60 req/min/IP rate limit.

### Click count budget verification

| Path | Clicks |
|---|---|
| First-visit user, defaults | **5** (landing-start → camera → shutter → continue → send) |
| Returning user, defaults | **3** (camera → shutter → send) |
| User changes 1 chip on Page 2 | +1 |
| User adds voice description | +2 (open drawer → record → close) |
| User opens "More details" (already open) | 0 |
| User selects 3 pressing needs | +3 |
| **Power user, full Appendix-1** | **~10** ✓ |

Asserted in `27-v4-flow.spec.ts` (`UI v4 — Click count budget`).

---

## 4. Technical safety nets

### Feature flags

- **`localStorage['crisp_ui_v4'] = 'on' | 'off'`** — default `'on'`.
- **`?ui=v3` URL parameter** — overrides localStorage, instant fallback.
- **`?ui=v4` URL parameter** — explicit opt-in.

If v4 has any issue in production, flipping the flag is one-tap rollback. The v3 stages and code paths remain in place; v4 lives alongside as new components.

### Test coverage at ship

| Surface | Count | Status |
|---|---|---|
| Backend pytest | **428** (412 baseline + 16 new) | 0 fail |
| PWA Playwright (v4 specs) | **31** (12 landing + 19 v4 flow) | 0 fail |
| RN TypeScript | clean | `npx tsc --noEmit` |
| `validate-i18n.mjs` | 6 locales × 360 keys | PASS |
| Prod-smoke (CI on every deploy) | 19 specs | green on every deploy |

### Production verification

After each commit:

| Commit | Verified live URL/endpoint |
|---|---|
| A | `https://undp.crisplabs.tech/mobile-app/src/landing.js?v=1` → 200; HTML contains `<div id="landing-root">` + `<script src="install-prompt.js">` |
| B | `https://undp.crisplabs.tech/mobile-app/src/v4-flow.js?v=1` → 200; HTML contains 3 new `<div class="stage v4-stage">`; `POST /api/v1/reports/classify-suggest` returns 200 with `source: "fallback"` on degraded path |
| C | `https://undp.crisplabs.tech/mobile-app/src/i18n/fr.json` → 360 keys; `v4_take_photo` = `"Prendre une photo"` |
| D | RN-side, no production-facing change (apps not published) |

### Rollback plan

If v4 breaks for users:

1. **Soft rollback** (no deploy needed) — broadcast to users to set `localStorage['crisp_ui_v4'] = 'off'` or use `?ui=v3` URL param. Can be done via a 1-line update to a pinned tweet / status page.
2. **Mid rollback** — flip `UI_V4_ENABLED` default to `false` in `v4-flow.js` (single character change). One-commit deploy.
3. **Hard rollback** — `git revert` Commits A-D in reverse order. Each is independently reversible.

---

## 5. UNDP brief alignment

Per the UNDP InnoCentive brief (`Problem Statement.pdf`):

| Brief requirement | v4 implementation |
|---|---|
| "Capture photos" | Page 1 native camera + multi-photo strip. PII blur runs on capture. |
| "Short descriptions" | Page 3 voice/text drawer. Whisper transcription via existing pipeline. |
| "Damage classification (Minimal/Partial/Complete)" | Page 2 damage chip row, default Partial. |
| "Type of infrastructure" | Page 2 infra carousel — 8 UNDP super-types (RESIDENTIAL, COMMERCIAL, GOVERNMENT, UTILITY, TRANSPORT_COMMUNICATION, COMMUNITY, PUBLIC_SPACES, OTHER). |
| "Nature of the crisis" | Page 2 crisis carousel — 9 UNDP types covering Natural / Technological / Human-made groups. |
| "GPS coordinates of the damaged infrastructure, OR building-level insights" | Auto-detected GPS pill on Page 1 + Page 3 location row tap → existing building-footprint picker (Leaflet + Overpass). |
| "Multi-language support — 6 UN languages" | EN/FR/ES/AR/RU/ZH at 360 keys each (354 new pairs in Commit C). RTL flip handled in CSS. |
| "Offline functionality" | Service worker + IndexedDB queue retained. v4 stages cached in `crisp-v68`. |
| "Modular form fields (Appendix 1)" | Page 3 UNDP details accordion — open by default per judge requirement. Debris yes/no + electricity (5 levels) + health-services (4 levels) + 10 pressing-needs chips. |
| "Building-footprint overlay" | Existing PWA module preserved; tap location row to reopen. |
| "Anonymisation / data security" | EXIF stripped via canvas re-encode (same as v3); presigned-URL S3 fetch (CSP whitelisted). |
| "Export structured data" | Backend `/exports/{csv,geojson,kml,pdf}` unchanged — same `/reports/meta` shape. |
| "Anti-volume incentives" | Lives Saved + Reports Verified metrics retained on landing + home. Volume counter not surfaced. |

---

## 6. What's deliberately NOT in v4

| Item | Reason |
|---|---|
| In-app `<video>` camera modal removal | The legacy modal stays in the codebase but is no longer reached by any v4 path. Removing the ~600 LoC is a follow-up cleanup commit; keeping it now means zero risk to the v3 fallback. |
| Native-speaker QA on the 354 new translation pairs | Same as v2 dense pass — flagged for the GAP-ANALYSIS §3.1g native-speaker review. |
| RN companion full v4 port | `crisp-mobile/V4_PARITY_DEFERRED.md` documents the eventual ~3-day refactor. RN apps are not published; PWA install prompt is the recommended path until then. |
| Server-side classify-suggest cost cap | Each call is a Haiku image+text round-trip. Rate-limited to 60/min/IP; server timeout is 3 s. No daily-spend ceiling yet — add via the existing observability layer if usage grows. |
| AI pre-fill mid-upload reclassification | If the user adds more photos after Page 2, AI doesn't re-run. Acceptable: the user can already tap any chip to override. |

---

## 7. Operator runbook

### Confirming v4 is live

```bash
# 1. landing card asset
curl -sI "https://undp.crisplabs.tech/mobile-app/src/landing.js?v=1"

# 2. v4 flow asset
curl -sI "https://undp.crisplabs.tech/mobile-app/src/v4-flow.js?v=1"

# 3. v4 stages in HTML
curl -s "https://undp.crisplabs.tech/mobile-app/src/index.html" | grep "stage-v4-"

# 4. classify-suggest endpoint (defaults to fallback when no real image)
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"image_b64":"test"}' \
  "https://undp.crisplabs.tech/api/v1/reports/classify-suggest" | jq

# 5. i18n file size
curl -s "https://undp.crisplabs.tech/mobile-app/src/i18n/fr.json" | jq 'keys | length'
```

### Wiring real channel handles

Edit `mobile-app/src/landing.js`:

```js
const DEFAULT_CHANNELS = {
    ivr_phone: '+14155551234',                    // ← real Twilio number
    sms_phone: '+14155551234',                    // ← real Twilio number
    telegram_bot: 'crisp_undp_bot',               // already set
    whatsapp_phone: '+14155551234',               // ← real WhatsApp number
    ios_app_url: 'https://apps.apple.com/...',    // ← when iOS app ships
    android_app_url: 'https://play.google.com/...',// ← when Android app ships
    expo_go_url: 'exp://exp.host/@crispundp/crisp-mobile',
};
```

Or override at runtime via a `<script>` block before `landing.js` loads:

```html
<script>window.CRISP_CHANNELS = { ivr_phone: '+91...', ... };</script>
```

### Disabling v4 in an emergency

Edit `mobile-app/src/v4-flow.js`:

```js
function _v4Enabled() {
    return false;   // hard-off
}
```

Bump SW cache (`mobile-app/src/sw.js`: `v68 → v69`), commit, push, deploy.

### Re-running translation QA

```bash
node scripts/validate-i18n.mjs
```

Should print `PASS — all locale files valid.`

---

## 8. Test invocation cheatsheet

Backend:
```bash
cd backend && source venv/bin/activate
PYTEST_DATABASE_URL='postgresql+psycopg2://crisp:crisp@localhost:5432/crisp_test' \
  python -m pytest tests/ -q --ignore=tests/test_load.py
```
Expected: **428 passed** (412 baseline + 16 new in `test_classify_suggest.py`).

PWA:
```bash
# Static server
cd "$(git rev-parse --show-toplevel)" && python3 -m http.server 8080 &

# Playwright
cd e2e && CRISP_BASE_URL_PWA=http://localhost:8080/mobile-app/src/ \
  ./node_modules/.bin/playwright test \
    tests/pwa/26-landing-v4.spec.ts \
    tests/pwa/27-v4-flow.spec.ts \
    --project=pwa --reporter=line --workers=1 --timeout=20000
```
Expected: **31 passed** (12 landing + 19 v4 flow).

i18n:
```bash
node scripts/validate-i18n.mjs
```
Expected: `PASS — all locale files valid.`

RN:
```bash
cd crisp-mobile && npx tsc --noEmit
```
Expected: clean (no output).

---

## 9. Commit reference

| Commit | SHA | Lines added | Files | Status |
|---|---|---|---|---|
| A | `3a322d9` | +1,225 / -7 | 29 | shipped + verified |
| B | `557df24` | +2,601 / -2 | 9 | shipped + verified |
| C | `4370ca8` | +361 / -7 | 7 | shipped + verified |
| D | `83c7908` | +493 / -13 | 8 | shipped (RN deferred) |
| **Total** | | **+4,680** / -29 | **53** | |

---

## 10. Pending follow-ups (not blocking submission)

1. **Native-speaker translation QA** on the 354 new pairs in 5 non-English locales. Same pattern as the v2 LLM-translated dense pass (GAP-ANALYSIS §3.1g).
2. **RN companion v4 port** — see `crisp-mobile/V4_PARITY_DEFERRED.md`. Estimated 3 working days. Triggered when iOS / Android apps are scheduled for App Store / Play Store publish.
3. **Real channel handles** for `ivr_phone`, `sms_phone`, `whatsapp_phone` (Telegram is already set). Operator-side config; no code change.
4. **Delete the legacy in-app `<video>` camera modal** — ~680 LoC of `app.js` + 80 LoC of CSS + 15 LoC of HTML. Behavioural no-op since v4 routes around it. Cosmetic LoC-reduction commit.
5. **`/reports/classify-suggest` daily-spend cap** — add a Prometheus metric + alert if daily Haiku spend trends past $10 / day (current rate-limit gives a hard ceiling around $30 / day per IP).
