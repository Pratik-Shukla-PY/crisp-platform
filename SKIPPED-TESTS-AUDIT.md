# Skipped PWA e2e tests — audit

_Audit generated post-Phase-F triage. Total spec files with skipped tests: 71_

## Summary by file

| File | Skipped | Status | Feature area |
|---|---|---|---|
| `01-landing` | 2 tests | ACTIVE | Landing page consent + start CTA — UNDP must-have |
| `02-capture-flow` | 3 tests | ACTIVE | Capture flow (start → photo → review) — core reporter path |
| `03-my-reports` | describe.skip (0 test.skip) | ACTIVE | My Reports list + delete — operator feature |
| `04-i18n-leaks` | 3 tests | ACTIVE | i18n parity — UNDP must-have #2 |
| `06-multi-photo` | 5 tests | ACTIVE | Multi-photo capture (main + 4 extras) |
| `07-review-redesign` | 6 tests | ACTIVE | v4 review page redesign — Batch B v6.8 |
| `08-success-track` | 3 tests | ACTIVE | Success/track page after submit |
| `09-inflight-reconcile` | 2 tests | ACTIVE | In-flight upload reconciliation |
| `10-language-default` | 4 tests | ACTIVE | Default language detection — UNDP must-have #2 |
| `11-image-viewer` | 4 tests | ACTIVE | Full-screen image viewer |
| `12-building-footprint` | 3 tests | ACTIVE | Building footprint selector — UNDP must-have #6 |
| `13-rtl-layout` | 5 tests | ACTIVE | RTL (Arabic) layout — UNDP must-have #2 |
| `14-locale-json-loader` | 1 tests | ACTIVE | Locale JSON loader |
| `15-binary-chunk-upload` | 4 tests | ACTIVE | Binary chunk upload — UNDP must-have #3 (offline) |
| `16-adaptive-tier` | 5 tests | ACTIVE | Adaptive tier (SMALL/MEDIUM/LARGE) — Phase F image-reliability |
| `17-blur-flag-truthful` | 4 tests | ACTIVE | Truthful client_blur_applied — UNDP must-have #7 (PII) |
| `18-no-state-bleed` | 6 tests | ACTIVE | State isolation between captures |
| `19-locale-bootstrap` | 3 tests | ACTIVE | Locale bootstrap on first load |
| `20-capture-responsiveness` | 3 tests | ACTIVE | Capture flow on small viewports |
| `21-blurhash-and-adaptive` | 5 tests | ACTIVE | Blurhash placeholder + adaptive tier |
| `22-detail-hotswap` | 3 tests | ACTIVE | Detail panel image hotswap as tiers complete |
| `23-staged-review` | 6 tests | ACTIVE | UI v2 staged review (3-page) — UI_V2_ENABLED still true |
| `24-rtl-phase25-regression` | 3 tests | ACTIVE | RTL regression guards — UNDP must-have #2 |
| `25-i18n-22-screenshots` | 1 tests | ACTIVE | i18n visual regression across 22 locales |
| `25-optional-login` | 8 tests | ACTIVE | Optional reporter login — UNDP must-have #9 (anonymity) |
| `26-landing-v4` | 15 tests | ACTIVE | v4 landing + home stage v6.6+ — Batch B |
| `28-v4-no-raw-keys` | 7 tests | ACTIVE | v4 i18n: no raw data-i18n keys leak — UNDP must-have #2 |
| `29-undp-requirements` | 8 tests | ACTIVE | UNDP rubric must-haves end-to-end |
| `30-v4-bug-fixes` | 22 tests | ACTIVE | v4 bug-fix regression guards |
| `40-axe-a11y` | 3 tests | ACTIVE | Accessibility (axe-core + touch targets) — UNDP a11y ≥ 90 |
| `41-offline-strict` | 5 tests | ACTIVE | Offline-strict — UNDP must-have #3 (blocking) |
| `42-visual-regression` | 2 tests | ACTIVE | Visual regression screenshots |
| `43-large-deferred-resume` | 4 tests | ACTIVE | LARGE-tier deferred upload resume — Phase F |
| `44-v4-multi-photo` | 2 tests | ACTIVE | v4 multi-photo capture |
| `45-v4-location-and-timestamp` | 5 tests | ACTIVE | v4 GPS + timestamp auto-fill |
| `46-network-tier-coverage` | 7 tests | ACTIVE | Network tier (FAST/MEDIUM/SLOW) coverage |
| `47-queued-click-and-add-another` | 4 tests | ACTIVE | Add Another report after submit |
| `48-har-network-hygiene` | 6 tests | ACTIVE | HAR-driven dedupe + network-call hygiene |
| `49-add-another-classify-reset` | 4 tests | ACTIVE | Add Another resets classify state |
| `50-queue-drain-small-tier-gate` | 4 tests | ACTIVE | Offline queue drain — SMALL tier first |
| `51-building-refetch-on-location-change` | 3 tests | ACTIVE | Building footprint refetch on GPS change — UNDP must-have #6 |
| `53-fullscreen-picker-invalidate-size` | 2 tests | ACTIVE | Building picker full-screen — invalidate Leaflet size |
| `54-classify-crisis-full-interaction` | 2 tests | ACTIVE | Classify crisis full interaction |
| `55-add-another-building-clear-and-undp-details-queue` | 7 tests | ACTIVE | Add Another building-clear + UNDP-details queue |
| `56-flag-rendering-cross-browser` | 4 tests | ACTIVE | Language flag rendering across browsers |
| `57-unified-sync-badge-details-queue` | 4 tests | ACTIVE | Unified sync badge + details queue |
| `58-queue-stuck-drain-and-progress` | 6 tests | ACTIVE | Stuck queue auto-drain + progress UI — Phase F |
| `59-my-reports-dropdown-accordion-lazyload` | 6 tests | ACTIVE | My Reports v6.8 dropdown + accordion |
| `60-theme-screenshot` | 4 tests | ACTIVE | Theme visual regression |
| `61-home-single-stat-lives-only` | 5 tests | ACTIVE | Home stage single Lives Saved stat — v6.8 redesign |
| `62-classify-infra-icon-sizes` | 4 tests | ACTIVE | Classify infra-tile icon sizes — v6.8 |
| `63-tier-rendering` | 8 tests | ACTIVE | Reporter tier badge rendering (T1-T4) |
| `64-tier-promotion-celebration` | 8 tests | ACTIVE | Tier promotion celebratory toast |
| `66-rewards-page` | 7 tests | ACTIVE | Rewards page (4-tier ladder) — Batch B v6.8 redesign |
| `68-home-v5-layout` | 6 tests | ACTIVE | Home v5/v6 layout invariants |
| `69-nearby-intel` | describe.skip (0 test.skip) | ACTIVE | Verified Reports Nearby intel module |
| `83-classify-auto-progress` | 9 tests | ACTIVE | Classify auto-progress after tap |
| `84-queue-orphan-self-heal` | 13 tests | ACTIVE | IndexedDB queue orphan self-heal |
| `85-lang-pill-redesign` | 4 tests | ACTIVE | v6.1 lang pill redesign |
| `86-footer-redesign` | 9 tests | ACTIVE | Home footer v2 redesign |
| `87-home-stage-invariants` | 8 tests | ACTIVE | Home stage no-scroll + brand-row alignment |
| `87-responsive-clipping` | 4 tests | ACTIVE | Responsive clipping (small viewports) |
| `88-classifier-pick-roundtrip` | 5 tests | ACTIVE | Classifier-state field-naming roundtrip (UNDP must-haves #4 #5) |
| `88-single-flow` | 1 tests | ACTIVE | V3 navigation gone — regression guard |
| `89-safe-area-all-stages` | 4 tests | ACTIVE | Safe-area wrapper invariant — v6.8 |
| `89-undp-sheet` | 11 tests | ACTIVE | UNDP details bottom sheet |
| `90-v4-review-cards` | 10 tests | ACTIVE | v4 review-page summary cards |
| `91-deferred-originals-queue` | 4 tests | ACTIVE | Deferred originals upload queue — Phase F |
| `_cls-throttled-probe` | 1 tests | PROBE | CLS throttled probe (perf diagnostic) |
| `_nearby-content-probe` | 1 tests | PROBE | Nearby content probe (perf diagnostic) |
| `_nearby-e2e-probe` | 3 tests | PROBE | Nearby e2e probe (perf diagnostic) |

**Total individually-skipped tests: ~355**

## Per-test breakdown


### `01-landing` — **ACTIVE**: Landing page consent + start CTA — UNDP must-have
- L42: `@smoke old 4-card roadmap is NOT rendered (Apr 2026 rewrite guard)`
- L50: `standalone `

### `02-capture-flow` — **ACTIVE**: Capture flow (start → photo → review) — core reporter path
- L65: `@smoke photo is mandatory — flow advances only once provided`
- L101: `@smoke flow-progress bar advances correctly across all 4 stages`
- L140: `audio stage shows new Apr 2026 low-literacy copy`

### `03-my-reports` — **ACTIVE**: My Reports list + delete — operator feature

_Note: file uses `test.describe.skip(...)` — the entire describe block is skipped wholesale._


### `04-i18n-leaks` — **ACTIVE**: i18n parity — UNDP must-have #2
- L104: `English: no raw keys on any capture stage`
- L133: `Detected local locale: falls through to English cleanly`
- L149: `every DOM data-i18n key has an English value`

### `06-multi-photo` — **ACTIVE**: Multi-photo capture (main + 4 extras)
- L57: `@smoke #file-browse has multiple attribute`
- L67: `@smoke camera modal exposes mini-gallery + Done button`
- L81: `@smoke modal controls stay in viewport when modal is open (hotfix)`
- L102: `browse multi-select: first asset → primary, rest → extras`
- L129: `photoBlurPending is an array (not a single promise)`

### `07-review-redesign` — **ACTIVE**: v4 review page redesign — Batch B v6.8
- L35: `@smoke dropped DOM IDs no longer exist on review page`
- L46: `@smoke crisis label reframed to `
- L52: `@smoke tapping an infra chip reveals inline severity picker`
- L81: `@smoke language picker overlay + change button present in DOM`
- L100: `service status summary reads `
- L106: `flow-progress z-index stacks above lang-switcher`

### `08-success-track` — **ACTIVE**: Success/track page after submit
- L44: `Track button with no submitted report is a no-op (toast only)`
- L52: `@smoke Add another report resets state and returns to home`
- L92: `Track button navigates to report-detail when a report was just submitted`

### `09-inflight-reconcile` — **ACTIVE**: In-flight upload reconciliation
- L91: `@smoke reconcile dequeues a stuck in-flight entry when server has the report`
- L150: `reconcile KEEPS queued entries with incomplete media (no premature dequeue)`

### `10-language-default` — **ACTIVE**: Default language detection — UNDP must-have #2
- L35: `@smoke default active language auto-activates the detected local`
- L52: `@smoke tapping the pill opens the picker overlay`
- L65: `picking a language activates it AND persists the choice`
- L82: `manual choice persists across reloads (no English reset)`

### `11-image-viewer` — **ACTIVE**: Full-screen image viewer
- L37: `@smoke viewer overlay + confirm-dialog are in the DOM (hidden by default)`
- L50: `@smoke primary photo thumb renders with ❌ on bottom-left`
- L72: `viewer opens via programmatic trigger + close dismisses`
- L87: `delete-inside-viewer opens confirm + cancel dismisses without delete`

### `12-building-footprint` — **ACTIVE**: Building footprint selector — UNDP must-have #6
- L35: `Leaflet + BuildingSelect globals are loaded`
- L49: `#building-select-box exists on stage-review DOM (collapsed)`
- L58: `getSelection returns null when nothing picked, populated after tap`

### `13-rtl-layout` — **ACTIVE**: RTL (Arabic) layout — UNDP must-have #2
- L41: `Arabic flips html dir=rtl`
- L46: `Urdu flips html dir=rtl`
- L56: `Hebrew is unsupported in Phase 25 — falls back to ltr`
- L61: `English stays dir=ltr`
- L66: `French stays dir=ltr`

### `14-locale-json-loader` — **ACTIVE**: Locale JSON loader
- L41: `${locale}.json responds with a valid 232-key pack`

### `15-binary-chunk-upload` — **ACTIVE**: Binary chunk upload — UNDP must-have #3 (offline)
- L42: `globals + feature flag are exposed by app.js`
- L60: `localStorage override disables binary transport`
- L74: `djb2Bytes matches simpleChecksum on ASCII input`
- L92: `binary chunk endpoint path is selected when flag is on`

### `16-adaptive-tier` — **ACTIVE**: Adaptive tier (SMALL/MEDIUM/LARGE) — Phase F image-reliability
- L44: `helpers are exposed on window`
- L62: `pickTierFromBandwidth covers every boundary correctly`
- L91: `detectPWANetworkTier with downlink=0 falls to SLOW (not MEDIUM)`
- L111: `computeChunkTimeout scales with measured bandwidth`
- L133: `adaptTierViaProbe picks VERY_SLOW when probe round-trip is slow`

### `17-blur-flag-truthful` — **ACTIVE**: Truthful client_blur_applied — UNDP must-have #7 (PII)
- L66: `PIIBlur.blurFaces returns the new {blob, blurred, facesDetected, skipped} shape`
- L104: `_blurIfPossible returns skipped:true when window.PIIBlur is not loaded`
- L134: `ImageVariants.generate propagates clientBlurApplied onto the output`
- L175: `_blurIfPossible error-path returns skipped when blurFaces throws`

### `18-no-state-bleed` — **ACTIVE**: State isolation between captures
- L81: `_clearCaptureState is exposed on window`
- L97: `_clearCaptureState wipes every capture-state field`
- L216: `_clearCaptureState wipes every preview <img>.src (core bleed fix)`
- L291: `_clearCaptureState resets DOM UI affordances (buttons, transcript, hints)`
- L357: `resetApp clears state AND navigates to stage-home`
- L414: `stale photo-preview.src does not survive a clear + btn-start cycle`

### `19-locale-bootstrap` — **ACTIVE**: Locale bootstrap on first load
- L50: `window.I18N / EXTRA_LANG / UNDP_I18N_EXTRA are reachable from window`
- L92: `manual locale `
- L140: `empty / missing manual locale falls back to English`

### `20-capture-responsiveness` — **ACTIVE**: Capture flow on small viewports
- L64: `_runWhenIdle helper exists on window scope for module-level reuse`
- L82: `Next button is enabled AND clickable immediately after a photo attach`
- L117: `blur pipeline does eventually run (state.photoBlurPending populates then drains)`

### `21-blurhash-and-adaptive` — **ACTIVE**: Blurhash placeholder + adaptive tier
- L63: `window.BlurHash encoder + decoder are exposed and round-trip`
- L106: `ImageVariants.generate returns a truthy blurhash alongside the three tiers`
- L138: `window._crispAdaptive exposes hooks + stable constants`
- L162: `per-device bandwidth cache round-trips through localStorage`
- L180: `packet-loss counters shrink the tier after ≥2 lossy events`

### `22-detail-hotswap` — **ACTIVE**: Detail panel image hotswap as tiers complete
- L52: `cache-hit path: openReportDetail renders stashed thumbnail_url`
- L124: `cache-miss → status-since refresh populates cache and renders`
- L170: `hot-swap: second open after thumbnail_url changes picks up new URL`

### `23-staged-review` — **ACTIVE**: UI v2 staged review (3-page) — UI_V2_ENABLED still true
- L52: `@smoke feature flag defaults to ON + test hooks exposed`
- L65: `v2 review stage shows 3 distinct pages, one at a time`
- L101: `v2 chips render colour SVG icons (no FontAwesome fallback)`
- L128: `flag glyph fallback: every language tile carries an ISO code`
- L147: `sticky header: review-page-header stays pinned + z-index ≥ 10`
- L163: `v1 rollback: setting crisp_ui_v2=off restores legacy 2-page flow`

### `24-rtl-phase25-regression` — **ACTIVE**: RTL regression guards — UNDP must-have #2
- L41: `Arabic flips .v4-header padding from right to left`
- L79: `English keeps .v4-header padding on the right side`
- L105: `Phase 25 — language pill shows flag emoji + ISO code`

### `25-i18n-22-screenshots` — **ACTIVE**: i18n visual regression across 22 locales
- L81: `i18n screenshot grid — ${lang}`

### `25-optional-login` — **ACTIVE**: Optional reporter login — UNDP must-have #9 (anonymity)
- L36: `@smoke AuthStore exists and init is idempotent`
- L56: `Start Reporting works without any login (anonymous path)`
- L68: `Login button navigates to stage-login with 3-step wizard`
- L86: `Skip link on stage-login returns to stage-home`
- L94: `Channel picker toggles between phone and email inputs`
- L108: `Country-code dropdown is populated with a device-default pre-selected`
- L118: `Settings stage exists and is reachable programmatically`
- L127: `Logout clears AuthStore local state even without network`

### `26-landing-v4` — **ACTIVE**: v4 landing + home stage v6.6+ — Batch B
- L37: `home page is visible on every load (no first-visit gating)`
- L46: `all 4 channel buttons + 3 app buttons render`
- L58: `IVR is LIVE — anchor with tel:+16626768896`
- L69: `Telegram is LIVE — anchor with t.me/crisp_undp_bot`
- L80: `SMS + WhatsApp render as disabled `
- L93: `iOS + Android render as disabled `
- L104: `Expo Go is LIVE — anchor with exp:// scheme`
- L115: `consent checkbox gates btn-start until checked`
- L125: `checking consent persists + hides the row`
- L141: `returning visitors with consent see no checkbox + Start enabled`
- L153: `window.InstallPrompt API surface is exposed`
- L175: `iOS install sheet renders when triggered`
- L192: `viewport fits 360x640 without horizontal scroll`
- L204: `CrispHome public surface is exposed for tests + late init`
- L229: `#stage-home has min-height 100dvh`

### `28-v4-no-raw-keys` — **ACTIVE**: v4 i18n: no raw data-i18n keys leak — UNDP must-have #2
- L63: `home page has zero raw key leaks`
- L84: `all 3 v4 stages have zero raw key leaks`
- L108: `only one .stage.active exists at any moment during navigation`
- L130: `Page 1 camera hero is bounded ≤ 240px tall`
- L140: `Page 2 chip grids show ≥ 6 tiles visible at once`
- L170: `Page 3 pressing-needs renders all 10 chips full-width`
- L194: `viewport-fit on iPhone SE (320×568) for all 3 v4 stages`

### `29-undp-requirements` — **ACTIVE**: UNDP rubric must-haves end-to-end
- L65: `app loads + service worker activates`
- L82: `home stage shows Start CTA + My Reports + offline reassurance`
- L102: `${locale}.json serves AND populates I18N`
- L190: `BuildingSelect global + Leaflet are loaded`
- L208: `#building-select-box exists in the v3 stage-review DOM`
- L326: `all 8 UNDP infrastructure super-types present (chip-btn[data-type])`
- L345: `all UNDP crisis types present (Natural / Tech / Human-made)`
- L368: `UNDP damage classification levels (Minimal / Partial / Complete)`

### `30-v4-bug-fixes` — **ACTIVE**: v4 bug-fix regression guards
- L80: `after v4 photo capture, state.photoDataUrl is populated`
- L113: `after v4 capture, state.photoVariants populates with 3 tiers`
- L141: `v4 capture produces hasPhoto=true in submitReport gate`
- L179: `v4 review stage exposes a mount point for the building picker`
- L198: `entering v4 review moves #building-select-box into the v4 mount`
- L217: `tapping v4 edit-location explicitly invokes BuildingSelect.ensureMap`
- L241: `BuildingSelect.getSelection() round-trips through state.buildingId`
- L266: `CrispV4.goToCapture() after a submitted report wipes state.photoDataUrl`
- L315: `v4 thumbnail strip is empty after re-entering capture`
- L354: `v4 mic button has its own click handler that toggles recording`
- L373: `v4 textarea writes through to state.description`
- L391: `CrispV4.startRecording mocked: state.isRecording flips and audioChunks accumulate`
- L450: `window.resolveLocationName is exposed for v4 to call`
- L463: `v4 location pill renders state.locationName when set`
- L479: `v4 capture stage location pill prefers locationName over coords`
- L518: `first visit: only #stage-home is active, no landing-overlay or consent-overlay`
- L534: `returning visitor (consent set) sees home with consent row hidden`
- L568: `camera-modal exists and openCameraModal is reachable via window`
- L582: `on desktop (getUserMedia available, not iOS) v4 camera opens the modal`
- L640: `CrispV4 stage transitions extend history depth`
- L655: `browser back from v4-review lands on a known stage (not exit)`
- L690: `CrispV4._onSend path persists into IndexedDB on offline submit`

### `40-axe-a11y` — **ACTIVE**: Accessibility (axe-core + touch targets) — UNDP a11y ≥ 90
- L39: `${url.name} has no WCAG 2.1 A/AA violations`
- L111: `${url.name} contrast meets 4.5:1 (text) / 3:1 (large text)`
- L155: `every interactive element on PWA home is ≥ 44×44 px (Apple HIG / WCAG 2.5.5)`

### `41-offline-strict` — **ACTIVE**: Offline-strict — UNDP must-have #3 (blocking)
- L38: `SW activates within 5s of first load`
- L65: `cache populated with critical assets on first activate`
- L98: `enqueue then go online → queue still has the report`
- L133: `navigating offline serves cached app shell (no white screen)`
- L155: `resolveLocationName does not throw when offline`

### `42-visual-regression` — **ACTIVE**: Visual regression screenshots
- L79: `${stage} layout matches baseline`
- L116: `stage-home renders correctly in ${lang}`

### `43-large-deferred-resume` — **ACTIVE**: LARGE-tier deferred upload resume — Phase F
- L44: `PWA helpers needed for defer + resume are exposed`
- L56: `defer matrix: VERY_SLOW defers MEDIUM + LARGE, SLOW defers only LARGE`
- L90: `_reconcileBeforeDequeue returns per-tier breakdown for verification log`
- L127: `djb2Bytes is available for whole-asset checksum on chunk 0`

### `44-v4-multi-photo` — **ACTIVE**: v4 multi-photo capture
- L73: `browse multi-select: 3 files → 1 primary + 2 extras (with variants)`
- L144: `modal close handler does NOT clear state.extraPhotos`

### `45-v4-location-and-timestamp` — **ACTIVE**: v4 GPS + timestamp auto-fill
- L62: `typing a non-bundled query shows Nominatim results via searchRemote`
- L92: `clicking a remote suggestion stages lat/lng on save`
- L124: `offline mode shows the offline hint and skips Nominatim`
- L151: `bundled-city query still works instantly without network`
- L175: `renders IANA + human label + 12-hour clock (not GMT±NN)`

### `46-network-tier-coverage` — **ACTIVE**: Network tier (FAST/MEDIUM/SLOW) coverage
- L83: `@smoke all tier-picker helpers are reachable from page context`
- L108: `chunk-size contract — FAST=512K / MEDIUM=128K / SLOW=32K / VERY_SLOW=1K`
- L140: `offline → tier=VERY_SLOW (navigator.onLine guard)`
- L155: `@2g CDP throttle to 2G EDGE → bandwidth probe picks VERY_SLOW`
- L182: `@3g CDP throttle to Regular 3G → bandwidth probe picks SLOW`
- L203: `@4g CDP throttle to Fast 4G → bandwidth probe picks MEDIUM or FAST`
- L224: `offline → enqueue capture → online → queue drains (UNDP must-have #3)`

### `47-queued-click-and-add-another` — **ACTIVE**: Add Another report after submit
- L67: `clicking a queued report opens stage-report-detail (Bug 1)`
- L139: `keyboard Enter on a queued report card opens detail (a11y)`
- L173: `Add Another Report clears v4 Send button state (Bug 2)`
- L249: `Add Another Report clears v4Photos + state.extraPhotos (state-side)`

### `48-har-network-hygiene` — **ACTIVE**: HAR-driven dedupe + network-call hygiene
- L54: `@smoke single-flight helper is exposed on window`
- L64: `single-flight: 5 concurrent GETs for the same URL fire ONE network call`
- L99: `single-flight: cached response served within TTL without re-hitting network`
- L124: `single-flight: POST always passes through (no dedupe)`
- L147: `HAR Fix 1: delete-queue replay sends Authorization header when token captured`
- L193: `HAR Fix 1: 401 response does NOT drain the queue (retry safety)`

### `49-add-another-classify-reset` — **ACTIVE**: Add Another resets classify state
- L57: `crisp-capture-state-cleared event fires from _clearCaptureState`
- L78: `after Add Another, re-entering classify lands on damage sub-step (not stale crisis)`
- L128: `after Add Another, no crisis tile is selected (stale highlight is cleared)`
- L170: `Bug 1: tapping the queued pill shows a toast (no silent no-op)`

### `50-queue-drain-small-tier-gate` — **ACTIVE**: Offline queue drain — SMALL tier first
- L71: `@smoke stuck-reason hint surfaces missing stages on queue card`
- L104: `in-flight cards render with matching count (no parallel-render race)`
- L150: `reconcile dequeues entry where server has SMALL of every photo (even with MEDIUM/LARGE pending)`
- L211: `reconcile keeps queued when server has 0 SMALL (still genuinely in flight)`

### `51-building-refetch-on-location-change` — **ACTIVE**: Building footprint refetch on GPS change — UNDP must-have #6
- L48: `@smoke crisp-location-changed event triggers a building fetch for the new bbox`
- L85: `ensureMap called >50m from last fetch re-fetches buildings (no early-return regression)`
- L137: `ensureMap within ~50m jitter does NOT re-fetch (cache-friendly)`

### `53-fullscreen-picker-invalidate-size` — **ACTIVE**: Building picker full-screen — invalidate Leaflet size
- L54: `@smoke ensureMap on an already-mounted map calls invalidateSize`
- L114: `after re-parent + location change, Leaflet canvas resizes to match new container`

### `54-classify-crisis-full-interaction` — **ACTIVE**: Classify crisis full interaction
- L49: `@smoke after Add Another, full damage → infra → crisis flow with group + subtype taps enables Continue`
- L112: `tapping a crisis tile after Add Another sets state + enables Continue (handlers not stale)`

### `55-add-another-building-clear-and-undp-details-queue` — **ACTIVE**: Add Another building-clear + UNDP-details queue
- L51: `@smoke Add Another clears building-footprint selection (state + DOM)`
- L111: `Add Another preserves user-typed infraName (only OSM-sourced is cleared)`
- L138: `@smoke UNDP-details queue: failed save persists to localStorage`
- L177: `UNDP-details queue: dedupes by reportId (latest save wins)`
- L198: `UNDP-details queue: drains on successful PATCH`
- L227: `UNDP-details queue: 401 keeps entry queued (re-login retry)`
- L252: `UNDP-details queue: 4xx other than 401 drops the entry (unredeemable)`

### `56-flag-rendering-cross-browser` — **ACTIVE**: Language flag rendering across browsers
- L73: `@smoke every language tile renders an SVG flag, not the native emoji`
- L120: `top-right pill flag uses SVG-via-data-cc on every locale switch`
- L155: `native emoji text content is preserved for accessibility`
- L185: `SVG flag data URIs are unique per country (15 unique flags across 22 locales)`

### `57-unified-sync-badge-details-queue` — **ACTIVE**: Unified sync badge + details queue
- L52: `@smoke pill shows N=1 when ONLY a UNDP-details entry is queued (was invisible pre-fix)`
- L80: `pill drops to hidden when the details queue drains (200 OK)`
- L99: `tapping the pill drains the UNDP-details queue (was a silent no-op pre-fix)`
- L132: `badge counts report-queue + details-queue together when both have entries`

### `58-queue-stuck-drain-and-progress` — **ACTIVE**: Stuck queue auto-drain + progress UI — Phase F
- L69: `@smoke pill shows a percentage when items are queued`
- L96: `pill progress bar width tracks completion across report queue stages`
- L129: `@smoke details queue entries older than 24 h are purged on drain`
- L150: `details queue entries WITHOUT queuedAt timestamp are kept (treated as just-enqueued)`
- L168: `updateSyncBadge hides the pill within a frame when the only queued item drains`
- L196: `reconcile no-photos case returns ok=true softDrain=false`

### `59-my-reports-dropdown-accordion-lazyload` — **ACTIVE**: My Reports v6.8 dropdown + accordion
- L116: `@smoke filter chips replaced with native <select>; default value is `
- L128: `changing the dropdown re-filters and resets pagination`
- L143: `@smoke empty IN FLIGHT section is fully hidden (no header, no placeholder)`
- L154: `@smoke date-grouped <details> accordions render with only `
- L170: ``
- L185: ``

### `60-theme-screenshot` — **ACTIVE**: Theme visual regression
- L32: `home page`
- L52: `language picker`
- L64: `classify crisis step (flat grid)`
- L83: `My Reports (empty)`

### `61-home-single-stat-lives-only` — **ACTIVE**: Home stage single Lives Saved stat — v6.8 redesign
- L41: `@smoke home-impact has the Lives tile but NOT the Reports-Verified tile`
- L49: `home-impact card carries the single-stat layout class`
- L58: `Lives Saved label is still present and i18n-bound`
- L69: `empty-state — when lives_impacted is 0 across all reports, tile shows `
- L99: `populated state — when reports carry lives_impacted, tile sums them`

### `62-classify-infra-icon-sizes` — **ACTIVE**: Classify infra-tile icon sizes — v6.8
- L45: `@smoke default (≤380w) icons are 48×48 with 28px glyph`
- L64: `≥380w breakpoint — icons grow to 56×56 with 32px glyph`
- L78: `≥800h breakpoint — icons grow to 64×64 with 36px glyph`
- L92: `@theme-visual screenshot at default Pixel-7 viewport`

### `63-tier-rendering` — **ACTIVE**: Reporter tier badge rendering (T1-T4)
- L74: `@smoke T1_SCOUT renders 🌱 Scout with first-report progress`
- L96: `@smoke T2_SIGNAL renders 📣 Signal with verified-1 progress`
- L115: `@smoke T3_CHANGEMAKER unlocks the chip + applies body tier-t3 + logo ring`
- L136: `@smoke T4_LIFEKEEPER applies body tier-t4 (top-tier theme tint)`
- L156: `LEGACY: stale backend emitting CONTRIBUTOR falls back to T3_CHANGEMAKER render`
- L172: `LEGACY: stale backend emitting TRUSTED falls back to T4_LIFEKEEPER render`
- L180: `LEGACY: stale backend emitting NEWCOMER maps to T2_SIGNAL (most reporters)`
- L193: `chip stays visible (never hidden) even on /profile fetch failure`

### `64-tier-promotion-celebration` — **ACTIVE**: Tier promotion celebratory toast
- L110: `@smoke T1_SCOUT → T2_SIGNAL fires the Signal tier-up toast`
- L124: `@smoke T2_SIGNAL → T3_CHANGEMAKER fires the Changemaker tier-up toast`
- L138: `@smoke T3_CHANGEMAKER → T4_LIFEKEEPER fires the Lifekeeper tier-up toast`
- L152: `same tier between opens — NO toast`
- L165: `first My-Reports visit (no prior snapshot) — NO toast`
- L177: `acceptance toast still fires alongside tier-up (regression)`
- L196: `lives-delta toast still fires alongside tier-up (regression)`
- L215: `legacy v1 snapshot present — silently migrates to v2 without false toast`

### `66-rewards-page` — **ACTIVE**: Rewards page (4-tier ladder) — Batch B v6.8 redesign
- L89: `@smoke home chip is decorative — has role=status, no tabindex, no click handler`
- L117: `@smoke ladder reflects T1 — first card is current, rest locked`
- L136: `@smoke ladder reflects T3 — T1+T2 done, T3 current, T4 locked`
- L150: `@smoke ladder reflects T4 — all done except T4 which is current`
- L164: `Badge Studio CTA is DISABLED at T1 + carries locked hint`
- L179: `Badge Studio CTA is DISABLED at T2 too (still pre-Changemaker)`
- L190: `@smoke Badge Studio CTA is ENABLED at T3 + opens stage-badge-studio`

### `68-home-v5-layout` — **ACTIVE**: Home v5/v6 layout invariants
- L47: `@smoke .home-hero-card is visible and groups consent + CTA + helper`
- L63: `CTA helper text resolves the home_cta_helper i18n key`
- L76: `CTA bigger than v4: clamp-up of cta-label fontSize`
- L92: `.home-stage carries the radial-gradient background`
- L101: `.home-hero-card pseudo-element ::before paints a cyan glow`
- L117: `exactly one .stage.active at the home v5 boot — no stacking`

### `69-nearby-intel` — **ACTIVE**: Verified Reports Nearby intel module

_Note: file uses `test.describe.skip(...)` — the entire describe block is skipped wholesale._


### `83-classify-auto-progress` — **ACTIVE**: Classify auto-progress after tap
- L76: `Continue button is hidden on the classify stage`
- L90: `damage tile tap auto-advances to infra sub-view`
- L103: `non-OTHER infra tile tap auto-advances to crisis sub-view`
- L114: `OTHER infra tile reveals input + waits for Enter to advance`
- L134: `crisis tile tap auto-advances to review stage`
- L149: `back navigation preserves prior selection`
- L166: `rapid double-tap fires only ONE navigation`
- L186: `reduced-motion users advance faster, no pulse animation`
- L209: `state persists across stage reload (offline-first)`

### `84-queue-orphan-self-heal` — **ACTIVE**: IndexedDB queue orphan self-heal
- L98: `@smoke predicate flags zero-payload row with stage claims as orphan when old`
- L106: `predicate does NOT flag the same shape when younger than 10 min`
- L114: `predicate does NOT flag a row with serverId set (genuine in-flight)`
- L124: `predicate does NOT flag a row with matching text payload`
- L134: `predicate does NOT flag a row with audio payload`
- L144: `predicate does NOT flag a row with photo bytes in progress`
- L154: `predicate does NOT flag a row whose stages are all false (never started)`
- L166: `@smoke selfHealOrphans dequeues old orphan, leaves young orphan + valid row alone`
- L196: `selfHealOrphans returns 0 when queue is empty`
- L202: `selfHealOrphans returns 0 when no rows match orphan shape`
- L219: `syncQueueManual drains an old orphan on entry`
- L236: `orphan seeded into IDB is drained on next page load`
- L262: `young orphan seeded into IDB is PRESERVED across page load`

### `85-lang-pill-redesign` — **ACTIVE**: v6.1 lang pill redesign
- L51: `@smoke pill renders with dot + flag + code in the expected order`
- L63: `pill is a full capsule (999px radius) with v6.1 roomier padding`
- L81: `pill stays compact (max-width 140px) and single-line`
- L103: `flag is 1rem and code is 0.78rem / 700 weight / white`

### `86-footer-redesign` — **ACTIVE**: Home footer v2 redesign
- L60: `@smoke footer row renders with links left, pill right (space-between)`
- L80: `row has a visible top divider + roomier padding`
- L102: `@smoke each link uses the v2 mid-gray (phone breakpoint: 12 px, desktop: 13 px)`
- L122: `bullet separators are visible (• glyph, mid-slate)`
- L152: `@smoke pill is a clean capsule with no visible icon buttons`
- L187: `pill text reads as the reference: bold white monospace, wide tracking`
- L214: `tapping the pill copies the device ID + applies is-copied state`
- L234: `pill is keyboard-focusable + Enter copies the ID`
- L257: `device-ID tooltip is suppressed in the footer-row surface`

### `87-home-stage-invariants` — **ACTIVE**: Home stage no-scroll + brand-row alignment
- L74: `@smoke brand row + lang pill share a single flex parent`
- L87: `@smoke brand row + lang pill vertical centres align (≤ 2 px drift)`
- L100: `lang-switcher does not use position:absolute on the home stage`
- L112: `@smoke all six channel icons render fully inside the strip`
- L137: `channels strip svgs use overflow:visible (defensive against viewBox quirks)`
- L151: `@smoke My Reports tile does NOT surface the lives-saved badge`
- L169: `My Reports tile count + label do not overlap`
- L191: `every invariant survives portrait → landscape → portrait rotation`

### `87-responsive-clipping` — **ACTIVE**: Responsive clipping (small viewports)
- L163: `stage-success — primary + secondary CTAs reachable`
- L175: `stage-home — primary report CTA reachable`
- L186: `stage-badge-studio — actions row reachable`
- L203: `lang-picker sheet height fits viewport`

### `88-classifier-pick-roundtrip` — **ACTIVE**: Classifier-state field-naming roundtrip (UNDP must-haves #4 #5)
- L165: `@smoke RESIDENTIAL + EARTHQUAKE + COMPLETE round-trips into queue meta`
- L185: `@smoke COMMERCIAL + FLOOD + MINIMAL round-trips (FLOOD ≠ default-leak)`
- L203: `OTHER + free-text infra_name round-trips both fields`
- L219: `@smoke empty classifier state submits as null (NOT legacy ROAD/FLOOD/PARTIAL/MODERATE)`
- L251: `_clearCaptureState wipes both v4 snake_case AND legacy camelCase fields to null`

### `88-single-flow` — **ACTIVE**: V3 navigation gone — regression guard
- L34: `stage-review DOM is removed (V3 paginated review)`

### `89-safe-area-all-stages` — **ACTIVE**: Safe-area wrapper invariant — v6.8
- L118: `@smoke .stage carries env(safe-area-inset-*) on positioning offsets`
- L142: `@smoke every stage clears the simulated 47px notch band`
- L174: `stage padding does NOT include env(safe-area-inset-top) (would double-pad)`
- L195: `.home-stage rule does not duplicate safe-area inset on its own`

### `89-undp-sheet` — **ACTIVE**: UNDP details bottom sheet
- L51: `sheet is hidden by default on stage-v4-review entry`
- L59: `trigger button is visible by default`
- L65: `tapping the trigger opens the sheet (slides up + .is-open class)`
- L74: `tapping the backdrop closes the sheet`
- L90: `tapping the ✕ close button closes the sheet`
- L99: `pressing Escape closes the sheet`
- L108: `tapping a power-supply level sets state + highlights the tile`
- L120: `filling all 5 questions does NOT auto-close the sheet`
- L171: `trigger badge updates: Optional → 1/5 → 2/5 as selections are made`
- L188: `selections persist across close + re-open`
- L206: `Send to UNDP button is visible whether sheet is open or closed`

### `90-v4-review-cards` — **ACTIVE**: v4 review-page summary cards
- L44: `section title is shown`
- L52: `all 4 content cards render on stage-v4-review boot`
- L61: `legacy v4-captured-strip + v4-summary are gone`
- L68: `description card shows EMPTY state when no voice + no text`
- L86: `description card shows FILLED state when text is present`
- L102: `NO duplicate `
- L120: `classification chips show 3 separate values + distinct icons`
- L146: `classification chip taps route to stage-v4-classify`
- L153: `photo card tap routes to stage-v4-capture`
- L160: `Send + UNDP trigger remain visible alongside the new cards`

### `91-deferred-originals-queue` — **ACTIVE**: Deferred originals upload queue — Phase F
- L70: `reconciler KEEPS item when SMALL landed but deferred variant remains`
- L110: `reconciler DEQUEUES item when all variants are complete`
- L144: `reconciler DEQUEUES item when 14-day deferral timeout expires`
- L181: `sync-badge filters out _submissionLanded items (no `

### `_cls-throttled-probe` — **PROBE**: CLS throttled probe (perf diagnostic)
- L22: `throttled layout-shift probe — Lighthouse-mobile preset`

### `_nearby-content-probe` — **PROBE**: Nearby content probe (perf diagnostic)
- L3: `empty state renders eyebrow + plain empty message (no ✓ `

### `_nearby-e2e-probe` — **PROBE**: Nearby e2e probe (perf diagnostic)
- L92: `SCENARIO 1: GPS denied + NO backend — module should show empty state, not silent-hide`
- L131: `SCENARIO 2: GPS granted with seeded coords (Bangalore test point)`
- L157: `SCENARIO 3: returning visitor with pre-cached coords`
