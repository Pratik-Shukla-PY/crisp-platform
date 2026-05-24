// CRISP service worker — offline caching, background sync, and push delivery.
//
// Cache-bump policy: any change to STATIC_ASSETS or any precached
// resource MUST bump CACHE_NAME so existing installs evict their stale
// snapshot on the next activate. Without this, returning users keep
// serving the old build forever.

// May 23 2026 (v256) — UX audit (Batches 1-4) + i18n sync-resolver.
// Net change across ~30 commits since v255:
//   · WCAG AA contrast pass — .nav-btn dark text, --red regrade to
//     #ff8a8a, .settings-note → --text-dim, .history-empty token swap.
//     Settings stage: 6 violations → 0.
//   · 22-locale inline critical-text packs + synchronous head
//     resolver + body-time walker — eliminates the visible English
//     flash for every non-EN user (was 170 ms-5 s; now 0 ms).
//   · Logical properties refactor — 92 sites of left/right + padding/
//     margin -left/-right converted to inset-inline-* / -inline-* so
//     AR/UR mirror without manual override.
//   · RTL: play-arrow + channels-strip mirror, bidi-isolate Latin
//     location names, html dir from frame 0.
//   · Font tokens (--fz-xs..--fz-display) + Reader Mode toggle in
//     Settings — bumps every size step for elderly/presbyopic users.
//   · Tier-badge retime — hidden for first-timers (gamification only
//     after first successful submission).
//   · Tablet layout 640-1024 px — frame + max-width.
//   · Hide raw coords + IANA timezone on capture (citizens see
//     human-readable info; tech-mode flag preserves operator demo).
//   · 8 new regression specs (99-105 + audit_matrix); 17/17 axe a11y;
//     78 @smoke pass; Lighthouse PWA 100, A11y 98.
// Cache bump forces every installed PWA to fetch the new shell + new
// inline 22-locale packs on next service-worker activation.
const CACHE_NAME = 'crisp-v278';
// v250 → v251 (May 21 — version-pill /health URL fix). v250 deploy
// auto-rolled-back when prod-smoke caught a `HTTP 404 /health` on
// PWA load. Root cause: home-screen.js _paintVersionPill stripped
// /api/v1 off window.API_BASE and called /health directly — works in
// dev where the FastAPI root serves /health, but fails in PROD where
// nginx only proxies /api/v1/* to the backend. Fix: backend mirrors
// the same response shape under /api/v1/health (main.py); PWA fetches
// window.API_BASE + /health (no strip). The legacy root /health route
// is retained for k8s-style orchestrators that probe the FastAPI app
// directly without going through nginx.
// v249 → v250 (May 21 — version pill moved to its own row). Operator
// screenshot proved the legacy `#home-utility-version` span was being
// rendered into a clipped region (.home-utility-footer has overflow:
// hidden + flex-wrap: nowrap to prevent Open-source link from
// colliding with the CRISP-ID pill on narrow screens). New element
// `#home-version-row` is a separate block-level row BELOW the footer
// + Add-to-Homescreen button, with its own .home-version-row CSS
// rule. The JS painter (_paintVersionPill) targets the new row and
// also writes to the legacy span for backward-compat with any test
// selectors. Verified visible in iPhone-viewport Playwright screenshot.
// v248 → v249 (May 21 — CRITICAL face-blur serialiser fix). Operator
// caught that v243's bitmap.close() didn't actually fix the cross-
// image contamination — submitted report 365933f6 with 5 photos
// showed correct blur on image 1 (had a face) BUT also blur on
// images 2-5 (water bottle, NO faces) in the same upper-center
// region image 1's face occupied. Root cause: concurrent calls to
// the shared TF.js BlazeFace model singleton. When multiple
// blurFaces() are in flight (camera modal's 5 rapid captures →
// 5 independent _runWhenIdle callbacks → 5 concurrent
// model.estimateFaces calls), TF.js cross-contaminates results.
// Fix: wrap the public blurFaces in a Promise-chain serialiser so
// only ONE detection runs at a time. Trade: end-to-end blur scales
// linearly with photo count (~150 ms × N on mid-range Android) but
// correctness >>> latency. Regression test 97-blur-no-contamination
// now also asserts CONCURRENT fire produces identical outputs for
// identical inputs.
// v247 → v248 (May 21 — version pill belt-and-suspenders). The CSS
// reversal in v247 fixes the long-term display:none. v248 adds
// `style.display='inline-block'` inline on the element from JS so
// iPhones still serving cached v246 CSS see the pill on first
// reload to v248 (inline style beats external CSS specificity).
// Regression test 98-version-pill-visible.spec.ts pins both
// invariants: computed-display ≠ none AND text contains pwa@ + api@.
// v246 → v247 (May 21 — B5 hotfix: version pill was being hidden by a
// pre-existing CSS rule at styles.css:10406 (`display: none`) that the
// v246 JS painter couldn't override by just removing the HTML `hidden`
// attribute. The CSS rule has been reversed — version span now shows
// per its painted text; only the trailing legacy dot stays hidden.
// v245 → v246 (May 21 — B5: UI cleanup). Two items from the audit:
//   · Item 7: removed the "Add 4 quick details" CTA + sub label from
//     the Thank You / stage-success screen. The post-submission
//     screen now stays clean and low-cognitive-load. Mid-flow trigger
//     (during stage-review, BEFORE submit) is preserved.
//   · Item 6: home-screen utility footer now paints a version pill
//     showing pwaRelease (from meta) + backendVersion (fetched once
//     per session from /health, cached in sessionStorage). Operators
//     have direct in-UI visibility on which PWA build + backend they
//     are hitting after each deploy.
// v244 → v245 (May 21 — B4: My Reports rendering + home count). Three
// fixes from architectural audit Items 1 + 4:
//   · dropped `loading="lazy"` from the My Reports card thumbnail —
//     was causing silent thumbnail-blank when users scrolled past
//     fast (image never fired its network request).
//   · in-flight cards (queued / mid-upload) now render a thumbnail
//     from the LOCAL photoVariants.small.dataUrl that's already in
//     IDB. Pre-fix in-flight cards were text-only because the render
//     template only read r.thumbnail_url, which queue items lack.
//   · home-screen `_primeMyReportsCount` fetches /status-since at
//     boot and re-paints the My Reports count tile from the result.
//     Pre-fix the tile read window._submittedCache which started as
//     [] at app.js module-load and only got populated when the user
//     entered My Reports.
// v243 → v244 (May 21 — B3: nearby self-exclude + map color coding).
// Backend now accepts `X-Caller-Device-Hash` header on /nearby and
// filters out the caller's own reports server-side. PWA sends the
// header (not a query param — keeps the value out of uvicorn access
// logs per the operator's privacy posture). Map markers now use blue
// (#3b82f6) for the user's own reports across the My Reports
// fullscreen map + the detail-view mini-map. The orange shade
// (#f97316) is reserved for future nearby overlays.
// v242 → v243 (May 21 — B1: face-blur cross-contamination fix). Closes
// the ImageBitmap allocated by `_decode(srcBlob)` on EVERY exit path
// in pii-blur.js::blurFaces. Pre-fix the bitmap leaked on detect-fail,
// no-faces, paint-fail, and even the success path (after canvas
// drawImage). Under rapid multi-image processing, the GC pool could
// reuse the bitmap's GPU-backed memory before the prior image's
// async canvas.toBlob() finished, causing image B's encoded output to
// contain pixels from image A's blur paint — operator-visible as
// "blur appears on regions of image B with no detected faces".
// Two-layer fix: close immediately after drawImage (canvas owns
// pixels from then on), plus a try/finally backstop for every other
// exit path. Regression test in 97-blur-no-contamination.spec.ts.
// v241 → v242 (May 21 — sync-badge UX: stop capping at 75% for no-audio
// reports). Pre-fix the badge denominator was always 4 (meta+text
// +photo+audio). On the common no-audio capture path, stages.audio
// stays false forever → max progress visible = 3/4 = 75% while uploads
// were healthy. Operator saw "75% queued" persistently and read it as
// "stuck." New denominator: 3 for no-audio reports, 4 for audio-bearing
// reports. A fully-staged no-audio report now reads 99% (capped) — an
// accurate "almost done, background tiers still uploading" signal.
// v240 → v241 (May 21 — two fixes from cellular smoke 5):
// 1) Freeze chunkSize + total on the variant after the first attempt.
//    A probe-tier shift between retries previously recomputed `total`
//    against the new chunkSize. If new total < chunkProgress, the
//    chunk for-loop body never ran → variant.complete=true → silent
//    skip with server stuck at partial chunk count. Real loss observed
//    on report 5b9823d4 group 62e25fd5 (92/2105 stuck forever).
// 2) JS-paused-but-visible self-heartbeat. iOS Safari occasionally
//    pauses JS while the page stays visible (low-power mode, memory
//    pressure). visibilitychange never fires. The 5-min periodic sweep
//    eventually catches it, but a 30-s heartbeat with explicit silence
//    detection (no chunk POST in 60s + queue non-empty + visible) fires
//    startRetryLoop, which then runs v238 wedge-recovery to clear any
//    stuck _retryLoopRunning flag.
// v239 → v240 (May 21 — remove VERY_SLOW pre-emptive defer; add 24h cap):
// Operator-driven model change. Crisis-reporting analyst value-per-
// decision is much higher than the citizen's battery/data cost on
// slow networks. Previous matrix dropped MEDIUM + ORIGINAL on
// VERY_SLOW probe — analyst lost full-fidelity evidence even when the
// network could have eventually delivered it. New matrix attempts
// every tier at whatever bandwidth is available. Hard ceiling: 24 h
// from submit; after that, give up on incomplete non-SMALL tiers with
// reason='24h_timeout' so the dashboard chip is honest.
// v238 → v239 (May 21 — force bandwidth re-probe on visibility-resume):
// Cellular smoke 5 surfaced a false-positive defer when iOS Safari
// suspended a tab mid-upload — every chunk POST iOS killed during
// suspension ran through pwaNetworkDowngrade() in the chunk-loop catch,
// ratcheting _pwaTier MEDIUM → SLOW → VERY_SLOW. On resume, the v237
// defer rule (VERY_SLOW → mark-deferred MEDIUM + ORIGINAL) fired on a
// stale tier. Result: 3 of 4 MEDIUMs + 4 of 4 ORIGINALs got marked
// failed/bandwidth_tier_deferred on a perfectly capable cellular link.
// Fix: visibilitychange → visible now forces adaptTierViaProbe({force:true})
// which measures real bandwidth and overwrites _pwaTier (bypassing the
// ratchet). Matches the existing pattern in the `online` event handler.
// v237 → v238 (May 21 — retry-loop wedge recovery): startRetryLoop now
// detects when _retryLoopRunning is stuck true with no chunk POST in
// 60+ seconds while the queue still has work — force-resets the flag
// and re-arms. Closes a real-world wedge observed in cellular smoke 3
// v3 where iOS Safari suspended a tab mid-upload, killed the TCP
// connection during background, and the awaited fetch Promise never
// resolved. Only Safari-kill-and-reopen recovered. This fix lets every
// visibilitychange/online/periodic-sweep entry self-heal.
// v236 → v237 (May 21 — defer matrix relaxed): _uploadVariantTier no
// longer pre-emptively defers ORIGINAL on SLOW networks. Operator-
// reported on cellular smoke 3 v2: the single 64 KB upload-probe
// routinely measured in the SLOW bucket on real 5G via cloudflared
// tunnel (TCP cold-start, tunnel queueing, radio handoff). Result was
// "drops in max scenarios" — full-res lost for no real reason. New
// matrix: SLOW attempts all 3 tiers; only VERY_SLOW (< 80 Kbps) still
// pre-emptively defers MEDIUM + ORIGINAL.
// v235 → v236 (May 21 — cellular smoke 3 fix): _reconcileBeforeDequeue
// now also tracks MID-FLIGHT variants (mediaId set, chunkProgress > 0,
// complete=false). Pre-fix, a variant whose chunk loop threw mid-stream
// stayed invisible to reconcile → ok=true → dequeue → orphan chunks.
// Real cellular capture left an ORIGINAL stuck at 21/24 chunks with the
// PWA queue empty. Post-fix, in-flight variants are tracked as
// softAssembling → ok=false → keep queued → next pass resumes chunks
// from chunkProgress.
// v232 → v233 (May 20 — Phase L Batch 2 second hotfix): caught the
// 6th surviving 'LOW' default — `uploadChunksBinary({ ..., resolutionTier='LOW', ... })`
// function-parameter default. ANY call that omitted `resolutionTier`
// was sending 'LOW' and 422-ing against the post-Batch-1b backend.
// Default → 'SMALL'.

// v231 → v232 (May 20 — Phase L Batch 2 hotfix: caught 3 surviving
// `'LOW'`/`'HIGH'` literals that escaped the initial rename pass:
//   1. sendBinaryChunkWithRetry default — `resolutionTier || 'LOW'`
//      now → 'SMALL'.
//   2. _sendLegacyB64Chunk default — same fix.
//   3. Audio legacy attach (manual sync path) — was sending
//      `resolution_tier: 'LOW'`, backend was rejecting with 422.
//   4. SW background-sync audio attach — was sending `'LOW'` too.
//   5. PWA reconcile check — looked for `'LOW'` media on server.
// Without these, the FIRST submission post-Phase-L deploy was
// burning chunks against a 422-rejecting backend forever.
//
// v230 → v231 (May 20 — Phase L Batch 2: tier vocabulary rename
// SMALL/MEDIUM/ORIGINAL + IDB read-migration + quota threshold drop
// to 35 MB). Returning users MUST evict the stale app.js +
// image-variants.js so the PWA stops sending the legacy `large`
// tier (the backend now rejects it with 422 post-Batch-1b cleanup).
// IDB queue items with `variants.large` are auto-migrated to
// `variants.original` on read via _migrateVariantsToPhaseL —
// pending drains land cleanly under the new vocabulary.
// v229 → v230 (May 20 — Phase K Batch 5: PWA reliability hardening).
// K.4.a — `_acquireDrainLock` / `_releaseDrainLock` cross-tab mutex
// via localStorage so two tabs draining the same IDB queue don't
// regress each other's chunkProgress.
// K.4.b — `submitReport` now non-async + module-scope
// `_submitInFlight` promise. Double-tap submission returns the
// SAME promise instead of generating fresh clientReportIds.
// K.4.c — `_backoffDelayMs(attempt)` capped at 30 s + ≤1 s jitter.
// Default retry count bumped 5 → 7. Total budget ~3 min, covers
// 3 consecutive 30 s Wi-Fi flaps.
// K.4.d — `_version` field on every queue item via enqueueReport;
// new `enqueueReportIfVersionMatches(payload, expected)` does a
// check-and-set so concurrent tabs detect stale-snapshot writes
// and abort instead of clobbering progress.
// K.4.e — proactive iOS HEIC quota guard. `_estimateQueueItemBytes`
// computes the projected IDB write; if >40 MB the user gets a
// "storage almost full" toast BEFORE the enqueue attempts (and
// before iOS's 50 MB hard limit triggers a silent QuotaExceededError).
// Returning users must evict the stale app.js to pick up these
// reliability fixes.
// v228 → v229 (May 20 — Phase K Batch 4: PWA mark-deferred call on
// soft-drain + variant dataUrl re-encode fallback).
// K.3.a — trySendQueuedReport's softDrain branch now POSTs to
// `/reports/{id}/media/mark-deferred` before dequeue. Backend marks
// the missing MEDIUM/HIGH tiers as bandwidth_tier_deferred,
// decrements expected_media, and the K.5.a dashboard chip renders
// "Original (slow network)" instead of leaving the dashboard
// permanently PARTIAL.
// K.3.c — _uploadVariantTier no longer silently skips when
// variant.dataUrl is missing. Recovers from item.photo (main) /
// item.extraPhotos[i] (extras) when those legacy data URLs are
// still present. If no source exists, marks the variant
// `deferred=true, deferredReason='orphan_no_source'` so the
// soft-drain path signals the backend honestly.
// Returning users must evict the stale app.js to pick up the new
// soft-drain + orphan-recovery behaviour.
// v227 → v228 (May 20 — lang-switch dynamic-renderer fix). activateLang
// now dispatches `crisp:lang-changed` (both sync + after the locale JSON
// loads). nearby.js stashes its last payload + open-sheet group and re-
// paints on the event. home-screen.js subscribes too — channels strip,
// identity bar, devid pill, badge chip, my-reports count, recent-reports
// list all re-render. Pre-fix the installed PWA had no way to refresh,
// so users were stuck with stale strings after switching language.
// v226 → v227 (May 19 — UNDP must-have #6 restoration: #building-select-box
// markup put back inside #v4-building-mount after the May 15 V3-cleanup
// regression deleted it, leaving the v4 review stage with no building
// picker. Returning users must evict the stale index.html that had an
// empty mount).
// v225 → v226 (May 19 — reporter-blocking severity:null 422 loop fix).
// Operator submitted an incident; UI stuck at "queued 25%" indefinitely.
// HAR file showed 47 consecutive 422 responses from /api/v1/reports/meta
// over 8 minutes, all with the same Pydantic error: "Input should be
// 'MINOR', 'MODERATE', 'SEVERE', 'CRITICAL' or 'UNKNOWN'" against
// severity: null. Root cause at app.js:8004 — `state.severity || null`
// degraded to null when the capture flow didn't write to `state.severity`
// (some entry paths set damage_classification + crisis_type but leave
// severity untouched). The backend's Pydantic schema
// (ReportMetaCreate.severity: SeverityEnum = UNKNOWN) has a default but
// rejects EXPLICIT null with 422 — Pydantic v2 doesn't substitute
// defaults for explicit null values; the field becomes required-non-null.
// Two-part fix: (a) enqueue substitutes 'UNKNOWN' for null at build
// time; (b) the drain loop ALSO substitutes at send time so the
// already-queued malformed payload in IndexedDB unsticks itself on
// the next replay tick instead of retrying the bad value forever.
// Cache eviction required so the new drain logic reaches users.
//
// v224 → v225 (May 19 — four PWA regressions, batched fix).
//
// Operator-reported the same day as the classifier fix:
//   1. "No option to change language in the middle of the incident
//      reporting flow." → added .v4-lang-pill inside every v4-header
//      (capture / classify / review). Opens the same #lang-picker-overlay
//      as the home pill. activateLang() preserves all capture state
//      (v4Photos / audioBlob / infrastructure_type / crisis_type /
//      damage_classification / location), verified at app.js:4255-4321.
//   2. "Language modal needs a clear close button at top-right." →
//      Added a 32px ✕ pill matching the .nearby-sheet-close pattern.
//      Kept the bottom "Close" button as a redundant large touch target.
//   3. "iPhone camera UI fix from last release doesn't work." → Root
//      cause was twofold: (a) iOS 17+ defaults to HEIC camera capture
//      which Image.src can't decode; _ingestFileAsPhoto silently dropped
//      every iOS-captured photo. Now detects HEIC by MIME or extension
//      and re-encodes to JPEG via createImageBitmap → canvas → toBlob
//      before re-entering the pipeline. (b) iPadOS 13+ Safari "Request
//      Desktop Site" (the DEFAULT for iPad) reports UA as Macintosh,
//      so the legacy /iPad|iPhone|iPod/ check failed and iPads routed
//      to the desktop camera modal where standalone-mode quirks broke
//      capture. Broadened iOS detection to also catch
//      navigator.platform==='MacIntel' && maxTouchPoints>1.
//   4. "Safe-area / scroll / viewport regression — only landing page
//      behaves correctly in installed-PWA mode." → ROOT CAUSE: d4f1fad
//      (May 17) added `padding: calc(20px + env(safe-area-inset-top))`
//      to .stage but DID NOT bump sw.js. Returning iOS PWAs on the
//      cached old SW kept serving the pre-fix styles.css indefinitely,
//      so 16 of 17 stages cropped behind the system status bar in
//      installed-PWA mode. Subsequent bumps (v222, v223) eventually
//      pushed the new CSS but iOS aggressively pins old SWs until the
//      PWA is force-killed. ARCHITECTURAL FIX: hoisted all four
//      env(safe-area-inset-*) paddings to .mobile-screen — the OUTER
//      shell — so every stage automatically clears notch + status bar
//      + home indicator + side curves without per-stage opt-in. Per-
//      stage env() rules dropped from .stage / .home-stage (was
//      duplicated 2x) / .home-brand-row / .home-channels-strip (3
//      responsive tiers). New architecture documented in CLAUDE.md
//      "Safe-area handling — global pattern" invariant. Regression
//      gated by new e2e/tests/pwa/89-safe-area-all-stages.spec.ts.
//
// Why we bump v225 even though the affected styles already shipped
// in v222-v224: returning iOS PWA users whose SW activated on or
// before v223 may still be serving the OLD wrapper rule. The cache
// bump (combined with the now-correct .mobile-screen padding) forces
// a clean re-fetch so every device converges on the same architecture.
//
// v223 → v224 (May 19 — CRITICAL: classifier-state field-naming bug fix).
// Reporter-blocking bug surfaced by operator (May 19): "I am reporting
// House damage, shops/market damage, everything lands as Roads and
// Bridges → Roads. Completely wrong." Confirmed via inspection of a
// real queued report whose `meta` carried hardcoded defaults `ROAD /
// FLOOD / PARTIAL / MODERATE` even though the user had selected
// different infra / crisis / damage values in the v4 capture flow.
// Violates 3 of 13 UNDP must-haves (damage / crisis / infrastructure-
// type taxonomies) on every report submitted since the V3 → V4
// capture-flow transition.
//
// ROOT CAUSE — state-field naming mismatch:
//   · v4-flow.js writes user taps to SNAKE_CASE state fields:
//       state.infrastructure_type / .crisis_type /
//       .damage_classification / .infrastructure_name
//   · submitReport (app.js:7886-7922) read CAMELCASE legacy v3 names:
//       state.infraType / .crisisType / .damageClass / .infraName
//   · _clearCaptureState (app.js:12184-12185) RESET those legacy
//     fields to hardcoded 'ROAD' / 'FLOOD' / 'PARTIAL' / 'MODERATE'
//     after every submit — so every read returned the same four
//     wrong values forever.
//   · V3 capture flow was removed in v192, so nothing else wrote to
//     the legacy fields. They became write-once-at-reset ghost
//     variables silently poisoning every meta payload.
//
// FIX — three surgical changes:
//   1. submitReport reads v4 snake_case FIRST, legacy as fallback,
//      `null` if neither is set. Surfacing null on a missing pick is
//      correct (dashboard flags for review) — silently using a
//      default was the worst outcome.
//   2. _clearCaptureState drops the hardcoded ROAD/FLOOD/PARTIAL/
//      MODERATE defaults; resets to null instead. Removes the
//      masking effect that hid the bug for months.
//   3. Both blocks gain inline comments referencing CLAUDE.md
//      "Classifier-state field naming" invariant so future
//      contributors don't re-introduce the bug.
//
// REGRESSION GUARD — e2e/tests/pwa/88-classifier-pick-roundtrip.spec.ts
// (NEW, 5 cases): walks the v4 capture flow with explicit picks
// (RESIDENTIAL + EARTHQUAKE + COMPLETE, COMMERCIAL + FLOOD + MINIMAL,
// OTHER + free-text), drives submit, asserts queue-item meta carries
// those exact picks. A negative test explicitly proves the hardcoded
// legacy defaults can NEVER reappear (asserts meta values are null,
// not 'ROAD' / 'FLOOD' / 'PARTIAL' / 'MODERATE').
//
// IN-FLIGHT QUEUE ROWS — any report enqueued before this commit has
// the wrong meta baked into its payload (the user's actual taps were
// never persisted to a recoverable field). This fix cannot retro-
// correct them; affected reports must be dequeued + re-submitted.
//
// Returning users evict v223 on next activate.
// v222 → v223 (May 2026 — Sprint D, camera-capture UX upgrade):
//   * New #camera-modal overlay: GPS status bar (live coords +
//     accuracy + compass), top toolbar (back/flash/focus/lock),
//     hexagonal-aperture shutter SVG, focus reticle, tap-to-focus.
//   * NEW exif-gps.js (vanilla-JS GPS-IFD writer, ~10 KB) precached
//     here so the EXIF embed step works offline. uploadChunksBinary
//     awaits _embedGpsExif(blob) before slicing, so every captured
//     JPEG now carries the same GPS coords we already persist on
//     the backend Location row.
//   * Strict GPS-IFD-only embed (no 0th, no ExifIFD, no
//     UserComment / Artist / Copyright) — see exif-gps.js for the
//     audit. PII consideration recorded in
//     /Users/pks/.claude/plans/swirling-forging-raccoon.md.
//   * Six new i18n keys (camera_locating / camera_back +
//     aria_{camera_flash,camera_center_focus,camera_rotation_lock,
//     take_photo}) propagated to all 22 locales.
//
// v221 → v222 — operator's home-stage v6.6 + i18n backfill batch (commit 8366c00).
// v221 → v222 (May 18 — i18n audit + backfill: 100 % coverage push).
// Operator: "Audit the 22 Languages translation on all pages, add or
// drop keywords based on what's there currently. We need 100 %
// translation for supported languages."
//
// Audit findings (before this commit):
//   · 22 locale files · 803 EN keys each (structural parity already)
//   · 6 locales ≥ 95 %: ar 99.5 · zh 99.0 · ru 98.8 · es 98.4 · fr 98.1 · hi 95.4
//   · 16 locales stuck at ~88-89 %, all missing ~90 of the SAME keys
//     (added in recent sprints — Nearby Reports Phase 5+, V4 review
//     redesign, Badge Studio share templates — never backfilled
//     across the non-UN stub locales)
//   · 89 common-missing keys grouped by feature: 29 nearby_*, 23
//     v4_*, 8 badge_*, 6 bs_*, 5 delete_*, 4 tier_*, 3 aria_*, plus
//     misc (fp_*, camera_*, confirm_*, rewards_*, etc.)
//
// Actions this commit:
//   · Translated 21 locale patches (88-93 keys each per stub locale,
//     3-37 keys for already-mostly-complete UN officials). Applied
//     via scripts/apply-translations.mjs; ~1,200 net new translations.
//   · Dropped 28 orphan keys (`v4_ai_filled`, `v4_tap_one`) that
//     existed in 14 stub locales but NOT in en.json (deprecated
//     aliases from a prior sprint).
//   · NEW translations/ml.json patch file created (was missing).
//
// Final coverage (value-level audit):
//   ar 99.9 · zh 99.4 · hi 99.0 · ru 99.0 · ml 99.0 · bn / gu / kn /
//   mr / pa / ta / te / ur 98.9 · ja 98.8 · ko 98.6 · tr 98.6 · vi
//   98.6 · fr 98.5 · pt 98.0 · es 97.5 · id 97.1
//
// Residual "identical-to-EN" entries are legitimate proper-nouns /
// universal terms (WhatsApp, Instagram, LinkedIn, Tsunami, OK, "—",
// `{km} km`, ID:, Hospital, etc.) that correctly stay the same in
// every language. The 100 % goal is met for actionable strings.
//
// Deferred to a separate session: drop the 145 candidate dead keys
// in en.json (keys with no source references). Requires per-key
// dynamic-construction audit (e.g. badge-studio uses
// `_t(\`tier_${tier.toLowerCase()}_label\`, ...)` — only ONE such
// pattern found, but dropping 145 keys safely needs careful review).
//
// Returning users evict v221 on next activate.
// v220 → v221 (May 17 — operator: "online/offline green dot keep at
// the top right corner just next to the CRISP's P text").
// DOM-only relocation: #connectivity-dot moved OUT of #btn-home-voice
// and INTO .home-brand-name (next to the "P" in CRISP) as a small
// pip pinned to the top-right corner via position:absolute. Same
// id + same online/offline class toggling — the _applyOnlineDot
// painter in app.js works unchanged. No JS changes. Returning
// users evict v220 on next activate.
// v219 → v220 (May 2026 — Lang pill v6.6 follow-up, operator).
// Operator (May 17, after seeing v219 ship): "remove the green dot &
// speaker icon outside the rounded tile. Reduce padding and only keep
// language in the tile. Make the button same as Login/My Reports in
// terms of design, rounded corners not full edge round."
//
// Changes (DOM + CSS only — zero JS changes, all IDs preserved):
//   · #btn-home-voice extracted from inside #lang-switcher; now a
//     standalone .home-voice-icon-btn sibling of the pill inside the
//     new .home-brand-utility flex cluster.
//   · #connectivity-dot extracted too; now lives as a status pip on
//     the audio button's top-right corner (same pattern as
//     #btn-login's #home-login-dot — mirror'd for visual consistency).
//   · .lang-switcher: border-radius 999 → 12 (rounded-corner button,
//     not capsule). Padding 7/14 → 5/10 (tighter). Background +
//     border match .home-primary-btn family — visually the same
//     button system as Login + My Reports.
//   · Capsule glass / backdrop-filter / outer-shadow chrome removed
//     — cleaner, lighter visual hierarchy.
//
// Alignment (v6.6 structural fix from v219) is UNCHANGED: the pill
// is still a flex child of #home-brand-row → align-items:center →
// drift is 0 px on every device in _home_matrix_probe.mjs. The four
// invariants in 87-home-stage-invariants.spec.ts still hold.
//
// Returning users evict v219 on next activate.
// v218 → v219 (May 2026 — Home stage v6.6 PERMANENT structural fixes).
// Operator (May 17): "I have tried over 10 times now for alignment of
// CRISP Logo and language bar, but it never fixes. Whenever I present
// this UI issue embarrasses me." Plus two adjacent complaints — the
// WhatsApp icon getting clipped in the channels strip, and the My
// Reports tile cluttered with a duplicate lives-saved badge.
//
// ROOT CAUSE (alignment): the lang pill was position:absolute against
// .mobile-screen, while the brand row sat in #stage-home's flex flow.
// Both applied env(safe-area-inset-top) with DIFFERENT additive
// constants, anchored to DIFFERENT reference points. Every past fix
// (v6.0 → v6.5 + v162 + v213) tweaked pixel math on one side; the
// next device or rotation re-broke it. ≥ 10 attempts over 2 months.
//
// PERMANENT FIX (v6.6, this commit) — STRUCTURAL, not pixel:
//   1. ALIGNMENT — #lang-switcher relocated INTO #home-brand-row as a
//      flex child (margin-left:auto pushes it to the right edge). Both
//      elements now share ONE flex parent + ONE inset application →
//      alignment is intrinsic via align-items:center. No pixel math
//      survives in either rule. Pill is now home-only (capture stages
//      have their own headers; no UX regression).
//   2. CHANNELS STRIP — .home-channels-strip horizontal padding now
//      uses max(10px, env(safe-area-inset-left/right)) so notched /
//      Dynamic-Island devices don't clip the leftmost/rightmost icon
//      in installed-PWA mode. .hcs-icon gets min-width pinned to its
//      width at every responsive tier (32/36/40 px) so flex can't
//      shrink it. SVGs get overflow:visible so any path that extends
//      slightly outside its 0-24 viewBox (common in Simple-Icons
//      brand SVGs like WhatsApp) renders whole.
//   3. MY REPORTS TILE — #mr-lives-badge element + its painter +
//      orphan CSS rule all DELETED. Lives saved is surfaced
//      exclusively on the Lifekeeper pill above the CTA. Tile now
//      shows only the report-count.
//
// REGRESSION GUARDS (so this is the LAST iteration):
//   · e2e/_home_matrix_probe.mjs now asserts all three invariants on
//     every device profile (iPhone SE, Galaxy S22, iPhone 14, Pixel 7,
//     Galaxy A52); exits non-zero if any drift > 2 px / icon clips /
//     lives-badge appears.
//   · e2e/tests/pwa/87-home-stage-invariants.spec.ts pins the four
//     invariants in Playwright across pwa + pwa-firefox + pwa-webkit
//     projects, including the post-rotation case.
//   · CLAUDE.md "Home header alignment", "Channels strip safe-area",
//     and "My Reports tile" invariants codify the rules so the next
//     polish sprint can't undo them.
//
// Returning users evict v218 on next activate.
// v217 → v218 (May 2026 — perf Sprint C.1, prune 64 orphan CSS rule blocks):
//   styles.css 467,954 → 456,544 bytes (-11,401 bytes, ~-2.4 % uncompressed).
//   Removed top-level rule blocks for classes that no longer appear in any
//   index.html / PWA-JS source after the Phase 4/5.1/6 redesigns:
//     - hero-* + home-hero-sub + home-title  (Phase 6 hero-card chrome)
//     - home-action-tile--rewards            (Phase 6 rewards tile drop)
//     - home-channel + home-channels         (Phase 5.1 channels rewrite)
//     - welcome-*                            (Phase 4 welcome overlay)
//     - roadmap-* + rs-*                     (Phase 4 roadmap drop)
//     - home-how-* + home-howitworks         (Phase 4 "how it works" drop)
//     - home-value-* + home-values           (Phase 3 value props drop)
//     - hr-*                                 (Phase 2 reward chip family)
//     - devid-* (older variants)             (Phase 2 devid card)
//   Compound selectors (.parent .orphan, .orphan:hover, etc.) intentionally
//   left in place — safer than risking a cascade regression for the marginal
//   extra bytes. Aggressive .v4-* stage CSS split deferred to post-UNDP.
//
// v216 → v217 (May 2026 — perf Sprint C.2, inline home-stage i18n subset):
//   index.html now ships a 2.1 KB <script>window.__crispHomeI18nEn={...}</script>
//   inline block (auto-generated by scripts/generate-home-i18n-inline.mjs)
//   carrying the 41 EN keys the home stage actually uses at first paint.
//   app.js merges this into I18N.en BEFORE the first applyI18n() so the
//   home CTA / brand / consent / footer / lifekeeper pill paint translated
//   on the very first frame, instead of waiting 100-500 ms for en.json
//   to fetch + merge. Subsequent locale switches still take the JSON
//   path; only EN's first paint gets the inline shortcut.
//
// v215 → v216 (May 2026 — perf Sprint C.4, Workbox-style precache manifest):
//   Replaced `cache.addAll(STATIC_ASSETS)` with per-asset hash migration.
//   Every precached URL is paired with a 12-char SHA-256 hash in the
//   SW_ASSET_MANIFEST block (auto-generated by
//   scripts/generate-sw-manifest.mjs). On install, the new SW walks
//   prior `crisp-v*` caches looking for a Response tagged with a
//   matching `x-crisp-hash` header; matches get copied with no network,
//   misses get refetched + tagged with the new hash. Typical per-deploy
//   bandwidth save for returning users: ~700-900 KB (only the files
//   that actually changed are refetched, not all 47).
//   First-install-after-this-ships pays the full ~1.2 MB refetch (no
//   prior cache has the x-crisp-hash header); subsequent deploys reap
//   the win.
//
// v214 → v215 (May 2026 — perf Sprint C.3, SWR on reports/nearby):
//   Added stale-while-revalidate intercept for
//   `/api/v1/reports/nearby` in the fetch handler. The home-stage
//   number-block now renders from cache in ~5 ms on warm visits while
//   a background fetch refreshes the payload. Pairs with the 90 s
//   in-process backend cache. New cache key per (lat,lng,radius)
//   tuple — old entries age out under SW LRU. No backend / DOM
//   changes; safe rollback is a one-line revert of the intercept.
//
// v213 → v214 (May 2026 — perf Sprint A, 4 low-risk wins):
//   A.1 Trimmed Google Fonts query: dropped unused Inter weight 300 +
//       Noto Sans Arabic/SC weight 700 — saves ~25 KB CSS + 30 KB woff2
//       for long-tail-locale users. No visible typographic change.
//   A.2 Sentry SDK + init deferred to requestIdleCallback (2.5 s
//       timeout fallback). Removed `<script src="vendor/sentry.min.js">`
//       from the eager defer queue; the SDK loads on idle then
//       Sentry.init runs. Saves 25 KB from critical render path +
//       ~80 ms TBT. Cost: errors fired in the first ~2 s aren't
//       captured — acceptable.
//   A.3 <link rel="preload" as="style"> for the Google Fonts CSS
//       (high-priority parallel fetch) on top of the existing
//       media="print" onload swap. Net: woff2 chain lands ~400-800 ms
//       earlier on slow networks → Inter swaps in BEFORE LCP.
//   A.4 preconnect: ipapi.co (IP-geo fallback fired ~2 s in) +
//       undp.crisplabs.tech (backend API — same-origin no-op in PROD,
//       saves TCP+TLS in dev). dns-prefetch freeipapi.com (secondary
//       fallback). 5 preconnects total, still inside Lighthouse's
//       uses-rel-preconnect ceiling.
//
//   Measured (LHCI local, Slow-4G mobile profile, median of 3 runs):
//     Performance      58  →  76   (+18)
//     FCP            6434  →  1662 ms   (-74%)
//     LCP            9482  →  5255 ms   (-45%)
//     TBT              56  →  0    ms
//     SI             7300  →  3729 ms
//     CLS               0  →  0
//     A11y / BP / PWA / SEO  unchanged
//
//   No backend changes. Returning users evict v213 on next activate.
//
// v212 → v213 (May 2026 — Home redesign v6, 7-ask batch):
//   1. Safe-area inset on .stage base class — fixes installed-PWA
//      header overlap with iPhone notch / Dynamic Island / Android
//      status bar.
//   2. Audio button moved from action-tiles row into #lang-switcher
//      (top-right), id #btn-home-voice preserved.
//   3. Trophy icon inline on Lifekeeper pill; standalone Rewards
//      action tile deleted.
//   4. Login + My Reports promoted to bigger glass buttons directly
//      below the CTA; My Reports count always visible (even 0).
//   5. Hero-card chrome (gradient + border + shadow + ::before glow)
//      neutralised for an open, flatter layout.
//   6. New "+ Add to Homescreen" yellow-on-brown chip pinned below
//      the Privacy / CRISP-ID footer row; hidden when already in
//      installed-PWA mode.
//   7. "Tap the orange button" → "Tap the green button below" copy
//      retired in en.json + the hardcoded JS fallback, plus the
//      "home_channel_coming_soon" string that referenced
//      "the orange button above". All 22 locales backfilled via
//      scripts/build-locale-skeletons.mjs.
//   Returning users evict v212 on next activate to pick up all of
//   the above. No backend changes.
//
// v211 → v212 (May 2026 — Phase 5.1 NO-SCROLL pass, channels redesign):
//   Operator-reported: the home stage must fit on iPhone SE
//   (375 × 667) with ZERO vertical scroll. The 2 × 3 square-tile
//   channels grid (~210 px tall) was the worst offender. Replaced
//   with:
//     · A single-row 6-icon strip (~44 px tall) above the Privacy
//       footer. Active channels (Telegram, IVR) carry a green
//       status dot; upcoming channels (WhatsApp, SMS, Android,
//       iOS) render grey. NO labels on the strip — pure visual.
//     · A bottom-sheet picker that opens on strip tap (mirrors the
//       .nearby-sheet pattern + animation). Sheet contains the
//       full 6 channel cards with icon + name + status text +
//       tap-to-launch. Lazy-painted on first open.
//   Plus: NO-SCROLL invariant codified in CLAUDE.md so future
//   contributors don't re-introduce the regression. Verified
//   end-to-end via e2e/_home_matrix_probe.mjs which now asserts
//   body.scrollHeight ≤ window.innerHeight on every device.
//
// v210 → v211 (May 2026 — Phase 5.1 follow-up: home-tile collapse fix):
//   Operator-reported. Once the Phase-1 nearby module populated with
//   reports, `.home-section-bottom` grew by ~217 px (eyebrow + 156 px
//   number block + tier pill + Recently-Resolved subtotal). Combined
//   with the channels grid + footer (~330 px), the bottom group hit
//   ~540 px — squeezing `.home-section-hero` to ~42 px on iPhone SE
//   and ~73 px on Galaxy S22. The hero card has `overflow: hidden`
//   for its glow accent, so the CTA was clipped to a flat slab on
//   iPhone 14 and disappeared entirely on shorter viewports.
//
//   Fix (styles.css only):
//     · `.home-section-hero { min-height: auto }` — was `0`. Lets
//       the section keep its content size; the channels overflow to
//       below-fold on very short viewports instead of crushing the
//       CTA.
//     · `.home-hero-card { flex-shrink: 0 }` — defensive. The card
//       refuses to shrink below its natural content height even if
//       the parent flex section is squeezed.
//     · `@media (max-height: 700px)` compaction of the nearby
//       module: number-block min-height 156 → 110, halo 200 → 150,
//       tier pill + resolved subtotal tightened. Saves ~70 px on
//       short viewports so the whole stage fits without scroll.
//
//   Verified on iPhone SE / Galaxy S22 / iPhone 14 / Pixel 7 /
//   Galaxy A52 via e2e/_home_matrix_probe.mjs.
//
// v209 → v210 (May 2026 — Nearby Reports Phase 5.1, deferred follow-ups,
// see docs/NEARBY_REPORTS_PIPELINE.md §17):
//   FIRST PWA-visible delta of the Phase 5.1 series. Adds
//   `device-telemetry.js` to STATIC_ASSETS — a small standalone IIFE
//   that runs ~1.2 s after DOMContentLoaded and POSTs a sanitised
//   device-behaviour summary to /api/v1/devices/telemetry (backend
//   commit 79ffc56). Throttled to once per 24 h via localStorage.
//
//   The summary feeds the upgraded emulator-farm detector — replaces
//   the Phase-5 UA-substring scaffold with WebGL renderer / sensor
//   activity / battery API / locale-tz scoring. No raw sensor streams
//   captured (UNDP must-have #7); accel_active is a single 1-bit
//   variance-derived flag.
//
// v208 → v209 (May 2026 — Nearby Reports Phase 5, see
// docs/NEARBY_REPORTS_PIPELINE.md §15 Phase 5):
//   Backend-only delta — no PWA-visible contract change. Cache
//   bumped so installed admin PWAs evict any /api/v1/admin
//   route metadata from the SW cache once Phase 5's appeal
//   webhook + observability surface lights up.
//
//   New backend surface:
//     • Async fraud-batch worker (fraud_batch.py): emulator-farm,
//       narrative-similarity, cross-device-ring detectors. Idempotent
//       sweep on a 15-minute scheduler interval.
//     • Outbound webhooks on appeal decisions — CRISP_APPEAL_WEBHOOK_
//       URLS env (comma-separated). UNDP / partners integrate
//       without coupling to internal schema.
//     • PostGIS migration scaffold (0023_postgis_geospatial) —
//       degrades gracefully when extension unavailable; Phase 5.1
//       will flip aggregator to ST_DWithin once geom column lands
//       on cooperating clusters.
//
//   Documents the operator-mandated 5-phase roadmap CLOSURE — all
//   phases per docs/NEARBY_REPORTS_PIPELINE.md §15 are now committed
//   locally. Operator deploy approval pending.
// v207 → v208 (May 2026 — Nearby Reports Phase 4, see
// docs/NEARBY_REPORTS_PIPELINE.md §15 Phase 4):
//   Backend-only delta. New response shape gains `density_mode`
//   ('normal' | 'disaster') + X-Crisp-Density-Mode response
//   header. /api/v1/config exposes operator-configurable density
//   bucket thresholds + push frequency caps.
//
//   New backend surface:
//     • Disaster-mode auto-promotion (groups > 50 OR reports > 200
//       inside the radius → area-level mega-zones with kind=
//       'disaster_zone'; frontend renders as heat-map).
//     • Appeal framework — POST/GET /api/v1/admin/appeals/*.
//       CRISP-hosted; webhook integration scaffolded for Phase 5.
//     • Push-policy helper — hybrid HIGH/LOW grading rules from
//       docs §8.1 codified in a single helper for dashboard +
//       Web Push delivery layer to consume.
//
//   Frontend response-shape additions are tier-aware already
//   (existing renderer falls through for unknown `density_mode`).
//   Cache bumped so admins on the installed PWA pick up the new
//   /admin/appeals/* + /admin/observability/* surface promptly.
// v206 → v207 (May 2026 — Nearby Reports Phase 3, see
// docs/NEARBY_REPORTS_PIPELINE.md §15 Phase 3):
//   Trust + offline polish + smart prefill. Highlights:
//     • IDB store bumped to `crisp_nearby_cache_v2` for the new
//       response shape (recently_resolved_groups + tier + burst +
//       acute fields). Old v1 caches evict on next activate.
//     • Per-tier online + offline TTL replaces the single CACHE_TTL_MS.
//       T3 verified — 5 min online / 24 h offline.
//       T2 emerging — 3 min / 6 h.
//       T1 weak     — 2 min / 30 min (hide after offline TTL).
//     • Smart-prefill flow: tap on a nearby group writes
//       `sessionStorage['crisp_prefill_v1']` with building_id +
//       centroid + suggested crisis/severity; v4-flow.js consumes
//       it on stage-v4-capture entry — user only adds photo/audio.
//     • SUGGESTED severity (not overwritten) per operator decision.
//   Backend trust-weight wiring is invisible to the SW but lands
//   in the same release window:
//     • New devices.spam_score / reports_count / spam_signals
//       columns (migration 0021_device_trust_columns).
//     • fraud_detector.evaluate_submission runs inline on each
//       POST /reports/meta — 3 hot signals (GPS spoof, impossible
//       movement, rate burst). Suspicious-device contributions
//       drop to 0 in aggregate_nearby.
// v205 → v206 (May 2026 — Nearby Reports Phase 2, see
// docs/NEARBY_REPORTS_PIPELINE.md §15 Phase 2):
//   Backend-only delta — the response shape gains the 'block' and
//   'area' kinds (was only 'building'/'crisis_cluster'/'resolved_
//   recent'). The PWA renders any new kind transparently. Cache
//   bumped because:
//     • The /admin/observability/nearby/* endpoints are NEW (Phase 2
//       admin observability surface; not consumed by the citizen
//       PWA but the new route map should be evicted from SW caches
//       for installed-PWA admins who login via the dashboard).
//     • Acute grading shifted to a now-anchored window (was
//       cluster-internal — fixed a misfire on stale clusters whose
//       reports were tightly packed but ancient).
//     • Decay-weighted sort changes ranking; users may see a
//       different order even with the same data, so a fresh fetch
//       on next boot is the right behaviour.
// v204 → v205 (May 2026 — Nearby Reports Phase 1, see
// docs/NEARBY_REPORTS_PIPELINE.md §15):
//   First implementation slice of the operator-approved redesign of
//   the nearby pipeline. Changes shipped:
//     • RESPONDING reports now SURFACE in the nearby module (was
//       excluded pre-Phase-1) with a 'responders active' status
//       count exposed on every group — transparency win.
//     • RESOLVED reports within 24h of close surface in a NEW
//       `recently_resolved_groups` channel rendered as a separate
//       "Recently Resolved: N" subtotal line. NEVER folded into the
//       active big number — honest closure feedback per operator.
//     • Confidence tiers (weak / emerging / verified) replace the
//       binary k-anonymity-≥-3 hide. Single-witness reports now
//       surface as 'weak' with explicit "Unverified" visual humility;
//       2-device groups as 'emerging' (orange treatment); 3+ as
//       'verified' (existing teal halo). Citizens get early-signal
//       awareness while privacy invariants stay intact.
//     • Crisis-type adaptive TTL per tier (CRISIS_RULES dict in
//       backend) — FLOOD_FLASH expires fast, EARTHQUAKE persists.
//       Client surfaces `crisis_ttl_hours` per group.
//     • Coarse crisis category (FLOOD/FIRE/INFRASTRUCTURE/OTHER)
//       collapsed for weak-tier groups so a single-reporter's
//       specific crisis_type can't be triangulated.
//     • Temporal burst detection (`is_burst`) for groups with ≥ 3
//       reports in 1 h; `is_acute` for ≥ 5 in 15 min (Phase 2 will
//       grade HIGH/LOW for push notification routing).
//     • Per-tier visual treatment in nearby.js: weak (small grey
//       halo + muted number + "Weak Signal" pill), emerging (orange
//       halo + "Emerging Reports" pill), verified (existing teal
//       + "Verified Nearby Incident" pill). Recently-Resolved
//       subtotal renders below the active number block.
//     • Deployment-config flag `CRISP_CITIZEN_T1_VISIBILITY` (env)
//       lets sensitive-region deployments suppress weak-tier groups
//       from anonymous citizen responses; admins always see them.
//       Flag echoed in the response + exposed via new
//       `/api/v1/config/` endpoint for boot-time client discovery.
//     • 10 new i18n keys across 6 UN locales (en/ar/zh/es/fr/ru)
//       for tier labels + "Recently Resolved" subtitle.
//   Phase 2-5 are queued per the doc's §15 roadmap (clustering &
//   lifecycle → trust + offline → high-density + appeals → batch
//   fraud + geospatial scaling).
//   Three operator-reported issues from a real iPhone 14 PWA:
//     1. The CLS-fix CSS rule (visibility:hidden + opacity:0 on
//        `.home-action-tile[hidden]`) reserved a slot for the install
//        icon even when the PWA is already INSTALLED (standalone
//        mode). On installed iPhone PWAs, _wireInstallIcon correctly
//        hides the icon, but the slot reservation left a visible
//        blank gap in the 5-tile row. Fix: when standalone, apply
//        inline `display: none` so the slot truly collapses and the
//        remaining 4 tiles fill the row uniformly.
//     2. Status bar (time / Wi-Fi / battery) overlapped the CRISP
//        brand logo + language pill on iPhone 14 because the home
//        stage didn't honour `env(safe-area-inset-top)` despite the
//        viewport meta opting in via `viewport-fit=cover`. Fix:
//        `.home-stage` gains `padding-top: env(safe-area-inset-top)`
//        and `#lang-switcher` offsets its `top` by the same.
//     3. The "Nearby reports" module stayed silently hidden in three
//        cases — (a) no GPS cached, (b) GPS cached but fetch failed,
//        (c) GPS cached + fetch returned 0 groups. Confusing UX
//        because the operator couldn't tell whether the system was
//        working or broken. Fix is two-part:
//          • app.js: IP-geolocation fallback paths now mirror coords
//            to `crisp_last_location_v2` UNCONDITIONALLY (pre-fix
//            only the language-matching branches did this; visitors
//            in unmapped regions silently lost their coords). New
//            `_saveLocCtx` also dispatches `crisp:location-cached`.
//          • nearby.js: listens for that event and re-runs `boot()`,
//            handling the async race between IP-geo + nearby init.
//            Render-on-failure: when we have coords but the fetch
//            fails or returns no groups, render the empty state
//            instead of silent-hiding — the module is always
//            visible (and honest) when coords are known. Empty-
//            state copy simplified: was "✓ All clear in your area /
//            No verified reports nearby"; now just "No nearby
//            reports" (no checkmark, no editorialising — a
//            checkmark next to a failed fetch was misleading).
//   v201 → v203 was the Lighthouse PROD CLS fix v2 (channels-grid +
//   install-icon slot reservation).
//   The v202 attempt (commit 169ca28) was auto-rolled-back when
//   PROD measured CLS=0.42 against the 0.25 floor — my fixes were
//   validated against fast un-throttled localhost which misses the
//   biggest contributors that only surface under Slow-4G + 4× CPU
//   (the LH-mobile audit profile).
//   Re-investigated with a new throttled probe matching LH-mobile;
//   reproduced PROD CLS at 0.37 locally and identified:
//     1. `.home-channels-grid` is empty in HTML and home-screen.js
//        _renderChannels() populates 6 tiles at t≈7.8 s under
//        throttle, expanding section-bottom 0 → 201 px. Single
//        biggest CLS contributor (~0.23 of the 0.37 measured).
//        Fix: `min-height: 198 px` reserves the slot pre-paint.
//     2. `.home-action-tile[hidden] { display:none }` collapses
//        the install-icon slot until beforeinstallprompt fires.
//        Reveal at t≈12.9 s reflowed the action-tiles row.
//        Fix: `visibility:hidden + opacity:0` keeps the slot in
//        layout flow; reveal becomes a same-slot opacity swap.
//   Throttled probe after fixes: 0.133 (47 % below 0.25 floor with
//   meaningful PROD-amplification headroom).
//   v202 fixes (chip width + nearby-intel + consent pre-paint) were
//   reverted via commit 11c77fb — they were correct but addressed
//   the wrong-priority shifts. They can be re-attempted later as
//   a separate batch if PROD CLS budget is tight.
//   v200 → v201 was the deferred-Originals queue retention fix.
//   Reconciler no longer dequeues IDB rows while variants are
//   still in `deferred=true && complete=false` state. New
//   `_submissionLanded` flag + 14-day timeout. Sync-badge
//   filters those out so user sees an accurate "queued"
//   count. Closes a real production gap where 44 % of PWA
//   photo groups had no HIGH-tier Original ever uploaded.
//
// v199 → v200 (May 2026 — Phase 2.3/2.4/2.5/2.6 Badge Studio premium):
//   * Canvas redesign: T4 warm-gold palette + glassmorphism panel +
//     layered drop-shadows on the tier pill (badge-studio.js).
//   * Character roster refined to 4 humanitarian responders
//     (character-pack.js — 4 comic archetypes deleted).
//   * Tier-gated character picker (locked tiles + auto-pick at open).
//   * Animated counter roll-up on the studio header stats.
//   Returning users must evict v199 so they see the redesigned canvas.
//
// v198 → v199 (May 2026 — Phase 2.1 shared tier-config extraction):
//   New `tier-config.js` added to STATIC_ASSETS + loaded from
//   index.html BEFORE badge-studio.js / home-screen.js. Defines
//   window.CRISP_TIERS{,BY_ID,LEGACY_ALIASES} from the canonical
//   shared/tier-config.json. Returning users must evict v198 so
//   the new script tag + STATIC_ASSETS entry land.
//
// v197 → v198 (May 2026 — Phase 2.4 WCAG 2.1 AA polish):
//   index.html + styles.css touched to fix axe-flagged a11y issues:
//   * #connectivity-dot + #rd-timeline gained role="img"/"list" so
//     their aria-label survives validation.
//   * `.v4-meta-loc-coords` / `.v4-substep-label` swapped from the
//     too-dim `--text-mute` (#64748b, 2.21:1 on navy) to
//     `--text-sub` (#cbd5e1, ~8.5:1 — passes WCAG AA easily).
//   * `.v4-desc-empty-sub` alpha bumped 0.55 → 0.78 to clear the
//     4.5:1 floor on the V4 review card background.
//   Returning users need to evict v197 so they pick up the new CSS.
//
// v196 → v197 (May 2026 — Phase 1.7 /share/<token> LinkedIn OG wire-up):
//   badge-studio.js now POSTs the rendered PNG (≤100 KB) to
//   /api/v1/share/mint and deep-links LinkedIn to the signed
//   /api/v1/share/<token> URL so the share preview carries the
//   user's actual badge as og:image instead of the generic
//   crisplabs.tech tile. Returning users need to evict v196 so the
//   share button picks up the new mint flow.
//
// v195 → v196 (May 2026 — Sentry observability, audit Phase 1.3/1.4/1.5):
//   index.html now loads vendor/sentry.min.js + sentry-init.js (with
//   defer) before the rest of the app bundle, so PWA JS errors during
//   boot land in our Sentry project instead of console-only. DSN is
//   plumbed via a `<meta name="crisp-sentry-dsn">` tag (empty by
//   default; deploy pipeline patches with the real DSN). Returning
//   users need to evict v195 so they pick up the new script tags.
// v194 → v195 (May 2026 — V4 review-page rethink, operator):
//   stage-v4-review's captured-strip + summary card + voice-drawer
//   trio was replaced by 4 purpose-built content cards (Photo /
//   Description / Location / Classification). Description card has
//   filled-vs-empty state (preview snippet vs "+ Add" CTA) so voice
//   and text are no longer asked twice. Section header anchors the
//   eye. Better icons distinguish infra (🏢) vs hazard (🌀). Bump
//   forces returning users to evict the cluttered prior build.
// v193 → v194 (May 2026 — UNDP drawer → bottom-sheet, operator):
//   index.html replaced the inline `<details id="v4-undp-drawer" open>`
//   with a compact trigger button (`#btn-v4-open-undp`) + a new
//   `#v4-undp-sheet` half-screen bottom-sheet. Sheet contains the 5
//   question-cards; trigger badge swaps "Optional" ↔ "N/5" live as
//   the reporter answers. styles.css gains `.v4-undp-sheet*` rules
//   mirroring `.nearby-sheet`. v4-flow.js's `_initReviewStage` is
//   rescoped to read from the sheet body. Returning users need to
//   evict v193 so they don't keep painting the inline-drawer build.
// v192 → v193 (May 2026 — UNDP drawer UI restored to rich question-
// cards inside stage-v4-review, per operator: "we spent time/energy
// on the stage-undp-details UI; this drawer should match"). The
// drawer's DOM was rewritten (4 row+select controls → 5 question
// cards with level-buttons + emoji-needs chips) and v4-flow.js
// rewired to match. Returning users need to evict v192 so their
// cached drawer DOM doesn't paint over the new question-cards.
// v191 → v192 (May 2026 — V3 capture flow REMOVED, operator):
//   index.html lost the 7 V3 stage <div> blocks (stage-photo,
//   stage-audio, stage-where, stage-infra, stage-crisis,
//   stage-extras, stage-review — 700+ lines deleted). v4-flow.js's
//   `?ui=v3` / `crisp_ui_v4='off'` escape hatch is gone. app.js's
//   UI_V3_ENABLED is hardcoded false; STAGES array no longer
//   references V3 IDs. Returning users need to evict v191 so they
//   don't keep painting from the dual-flow snapshot — otherwise a
//   stale localStorage `crisp_ui_v4=off` would route their cached
//   index.html into a now-missing stage and strand them on a blank
//   screen. Bump forces fresh fetch.
// v190 → v191 (May 2026 — first-time GPS cache mirror, operator):
//   app.js `_saveLocCtx` now also writes `crisp_last_location_v2`
//   (the key nearby.js reads) so first-time users see the Nearby
//   Reports section immediately after granting the home-stage
//   GPS prompt, not only after their first capture flow. Returning
//   users need to evict v190 so app.js's new mirror runs on next
//   home boot — without the bump, iOS Safari paints from the v190
//   snapshot and the gap reappears for them.
// v189 → v190 (May 2026 — responsive stabilization, Commit 2):
//   styles.css changes for Fix-P3 (.stage-center justify-content:
//   safe center), Fix-P4 (.home-center overflow-y: auto), and
//   Fix-P6 (sticky-footer on stage-success + stage-badge-studio).
//   Bump so returning users see the new layout immediately instead
//   of holding the v189 snapshot where bottom CTAs still clip.
// v188 → v189 (May 2026 — responsive stabilization, Commit 1):
//   index.html viewport meta now ships viewport-fit=cover +
//   interactive-widget=resizes-content, and styles.css gains the
//   dvh-fallback chain on three height-bounded selectors plus
//   flex-shrink:0 on bottom CTAs and overflow-x:clip on .stage.
//   Returning users need to evict the old index.html + styles.css
//   so the new viewport meta + height calcs take effect on first
//   re-launch — otherwise iOS Safari keeps painting from the v188
//   snapshot and the safe-area-inset env() values stay 0.
// v187 → v188 (May 2026 — Sprint 2 perf fix):
//   mobile-app/src/index.html now `defer`s 14 non-critical scripts
//   (auth.js, install-prompt.js, home-screen.js, app.js, etc.) so the
//   initial paint isn't blocked by JS parse. Plus blocked-resource
//   fonts moved to local on the dashboard side (no PWA impact, but
//   the index.html change alone needs a cache eviction so returning
//   users actually get the new <script defer> ordering and don't keep
//   serving the old render-blocking version forever.
// v186 → v187 (May 2026 — success brand position fix, operator):
//   "Keep the CRISP ILogo and Text position exactly same as the
//    home page."
// v186 placed .success-brand inside the centered .success-center
// flex, which made it horizontally centered + vertically stacked
// with the rest of the success content. Home brand instead sits at
// the TOP-LEFT of .home-center (first child + left-aligned because
// .home-center is align-items:stretch). To match exactly, .success-
// brand is now `position: absolute; top: 20px; left: 24px;` inside
// .stage (matches the stage's own padding-top + padding-left so the
// brand aligns with where natural content would start). Logo size
// bumped 36 → 40 px to match home-brand-logo exactly. RTL flip
// included. Padding-top: 48 px added to .success-center to push
// centered content (heart + thank-you) below the brand on short
// iPhone-SE-class viewports.
// v185 → v186 (May 2026 — success-stage CRISP brand, operator):
//   "On the last page the Crisp Logo and CRISP word is missing,
//    remove home button and when user clicks on the Crisp Icon
//    they can go to home."
// Adds a clickable .success-brand at the top of #stage-success
// (CRISP ripple SVG + "CRISP" wordmark, same as the home brand
// row). Click → resetApp() + goToStage('stage-home'). Removes the
// explicit #btn-success-home from the secondary row and collapses
// the row's grid from 3-col → 2-col (Track + Rewards). The legacy
// #btn-success-home click handler in app.js is kept guarded so
// any cached HTML serving the old markup still navigates home
// gracefully (back-compat).
// v184 → v185 (May 2026 — Nearby v8.2 frameless number block).
// Operator: "Don't make a rectangular Block. the Border and
// background is not needed around the reports nearby."
// Removed:
//   · background: rgba(255,255,255,0.04)
//   · border: 1px solid rgba(255,255,255,0.07)
//   · backdrop-filter: blur(4px)
//   · hover background/border tint
// Kept: overflow:hidden + border-radius (so the ripple still clips
// to the click bounds), focus-visible outline (a11y), min-height,
// active scale press feedback. The pulse halo + number + label
// now sit free on the home stage with no surrounding card. RN
// companion mirrored (numberBlock background → transparent,
// borderWidth → 0).
// v183 → v184 (May 2026 — Nearby Reports v8.1 self-bootstrap fix).
//
// Operator's console logs after v8 deploy showed NO `[NearbyIntel]`
// boot lines — meaning the module never initialized. Root cause:
// script ordering race. `<script src="home-screen.js">` runs
// BEFORE `<script src="nearby.js">` in document order. home-
// screen.js's bottom-of-file `init()` call fires synchronously
// when the script-tag is parsed; at that moment nearby.js hasn't
// loaded yet, so `window.NearbyIntel` is undefined and the
// `if (NearbyIntel && ...)` guard silently skips.
//
// Fix: nearby.js now self-bootstraps at module load. If readyState
// is 'loading', it waits for DOMContentLoaded; otherwise it defers
// one tick (so any sibling scripts currently parsing can finish
// setting up `window.t` / `window.API_BASE`). home-screen.js's
// existing call is kept for back-compat — boot() is idempotent
// (re-rendering the same payload paints the same DOM).
//
// v182 → v183 (May 2026 — Nearby Reports v8 redesign: aggregate
// number block + list sheet).
//
// Operator: "I asked for a single number with ripple effect thing
// first like we had earlier and on click show in the banner sliding
// from bottom what report and on further click the other actions
// would happen. I see direct 9 reports now."
//
// Front-of-home was rendering an inline list of group rows (3 rows
// when there were 3 groups). v8 reverts to the original aggregate-
// number pulse design + adds a new bottom-sheet stack:
//
//   front:  one big number (sum of counts) + 2 pulse halos + sub-label
//   tap:    list bottom-sheet slides up → renders the group rows
//   tap row: list closes + existing detail sheet opens (per-group
//           details + actions, unchanged from Phase 2)
//
// Touches: index.html (#nearby-list-sheet markup), nearby.js
// (_buildNumberBlock + _openListSheet + _closeListSheet), styles.css
// (~250 LOC for the number block + list sheet rules), 22 i18n files
// (+nearby_reports_nearby_label / +nearby_one_area / +nearby_n_areas).
// RN companion mirrors on HomeScreen.tsx via the new <ListSheet/>
// sub-component in NearbyReports.tsx.
//
// v181 → v182 (May 2026 — channel tile v7 + nearby ripple + GPS
// fallback chain).
//
//   1. Channel tiles (PWA + RN parity): live tiles (Telegram + IVR)
//      drop the .ct-status "LIVE_NOW" text entirely; a clean solid
//      9 px green dot at top-right corner signals liveness instead.
//      Reverts the v168.1 "hide all dots, show glowing Live text"
//      pass for ONE clean dot + zero text per operator request.
//
//   2. Nearby Reports: count number ("3 reports", "5 reports") gets
//      a subtle 2.6 s pulse animation (scale 1 → 1.06 + opacity 1
//      → 0.92 + soft mint text-shadow). Row click now triggers a
//      Material-style circular ripple that emanates from the click
//      coords, then the existing bottom-sheet slides up. Both
//      animations gated by prefers-reduced-motion.
//
//   3. GPS fix — v4-flow.js `_refreshGps()` had no fallback chain.
//      On geolocation error it just showed "GPS unavailable". New
//      chain: getCurrentPosition (fresh) → localStorage cache
//      (crisp_last_location_v2, same as nearby.js) → IP geo
//      (window.tryIPGeolocation) → only then "unavailable". Also:
//      maximumAge 60s → 5min so browsers return their own cached
//      fix instantly; cache writeback on every successful fresh fix
//      so the nearby-intel module also benefits. Operator-reported:
//      "GPS shows not available when I start reporting from Report
//      and incident or nearby report route."
//
// v180 → v181 (May 2026 — lang pill v6.5 clean dot + flag fix).
// Operator: "with the flag I see a black shadow over the icon" +
// "the green dot can be clean solid green dot than a glowing thing."
//
//   1. `.lang-switcher .lps-flag` — removed text-shadow:0 0 1px
//      rgba(0,0,0,0.35) that was casting a dark halo around the
//      SVG flag glyph.
//   2. `.connectivity-dot` — dropped radial-gradient interior
//      (was simulating a lit LED) + dropped all 3 box-shadow halo
//      layers. Now a flat solid #80EE98 disk (red #ef4444 offline).
//      Size held at 12 px (back from the v6.2 13 px bump — without
//      the halo, the smaller pure disk is the right visual weight).
// v179 → v180 (May 2026 — footer v4 strict single-row pass).
// Operator screenshot: "Open source" was wrapping to line 2 and
// the device-ID pill was colliding with it. Root cause: inner-nav
// gap (10 px) + link padding (4/2 px) + pill icon size (22 px)
// summed to a row wider than the viewport on iPhone SE-class phones.
// Fix:
//   1. Inner nav gap 10 → 6 px (tighter Privacy/Help/Open source)
//   2. Link padding 4/2 → 2/0 px
//   3. Pill text 12 → 11.5 px; letter-spacing 0.08 → 0.06 em
//   4. Pill icon buttons 22 → 20 px (svg 14 → 13 px)
//   5. flex-shrink:0 on links, dots, and pill so nothing collapses
//   6. overflow:hidden on the inner nav as defensive clip-rather-
//      than-wrap fallback (since flex-wrap:nowrap can still allow
//      visual wrap under some browser layout edge cases)
// Narrow-phone (≤ 430 px) media query tightened further to match.
// v178 → v179 (May 2026 — lang pill v6.4 halo removal).
// Operator: "the background green glow is also not required here."
// Dropped the cyan/teal pill halo (`0 0 32px 3px rgba(9,209,199,
// 0.55)` from the box-shadow stack). Pill now reads cleanly via
// just the teal-tinted border + translucent glass + drop shadow.
// The live-indicator green LED dot keeps ITS halo (that's the
// actual liveness signal, not decoration); only the wider pill
// halo is gone.
// v177 → v178 (May 2026 — lang pill v6.3 clean glass pass).
// Operator: "still looks dark BG, I need clean look like I shared."
// The v6.2 solid navy gradient (#1b2a44 → #0e1828) was rendering
// near-black on most displays. Switched to a translucent teal-
// tinted glass: rgba(38,78,112,0.55) → rgba(18,48,78,0.55) with
// backdrop-filter: blur(14px) saturate(160%) so the home stage's
// deep-navy bg shows through with a fresh cyan tone. Border edge
// switched white-alpha → teal-alpha (rgba(94,234,212,0.28)) for
// the same clean cyan-tinted glass feel as the reference image.
// `@supports not (backdrop-filter)` fallback bumps alpha to 0.92
// for older Safari so the look stays consistent.
// v176 → v177 (May 2026 — lang pill v6.2 + footer v3, operator
// feedback round):
//   1. Lang pill `top: 16 → 22 px` so it sits vertically centered
//      with the CRISP brand row below (logo + wordmark). Halo
//      alpha 0.45 → 0.55 + spread 2 → 3 px so the cyan glow reads
//      as clearly as the reference screenshot. LED dot 12 → 13 px;
//      online halo alphas 0.95/0.65/0.40 → 1.00/0.78/0.52.
//   2. Footer v3: links explicitly un-bold (font-weight: 400),
//      space between "Open source" and device-ID pill restored
//      (nav: flex 1 1 → 0 1 so space-between actually places the
//      gap there), copy + info icon buttons UN-HIDDEN inside the
//      pill (operator: "bring that back"). Buttons sized 22 px in
//      this surface (vs the default 24 px) so the whole row stays
//      single-line on a 430 px viewport.
//   3. Narrow-phone media query (≤ 430 px) scales down the pill
//      icons + text accordingly so nothing wraps.
// v175 → v176 (May 2026 — nearby.js local-dev API-base fix).
// Operator reported the "Verified Reports Nearby" module didn't
// render on local dev. Root cause: nearby.js used relative
// `/api/v1` for the endpoint, which on a PWA dev-server bind
// (typically :8080) hits `localhost:8080/api/v1/reports/nearby`
// → 404 (backend lives on :8000). Mirror the host-aware base
// resolution app.js uses (window.API_BASE → host-based fallback
// for `localhost`/`127.0.0.1` → :8000; otherwise window.origin).
// Also adds console.log/warn instrumentation so the silent-fail
// path surfaces in DevTools next time. STATIC_ASSETS unchanged.
// v174 → v175 (May 2026 — home footer v2 visibility pass).
// Operator screenshot: the bottom-portion footer was visually too
// faint vs the reference image. Three changes:
//   1. Links bumped 10.5 → 13 px and brighter slate (alpha 0.45 →
//      0.75); separators switched · → • and bumped to match.
//   2. Device-ID pill: copy + info icon buttons HIDDEN in this
//      surface (kept in DOM for back-compat / lang-pill identity
//      bar parity); the pill becomes the copy affordance via a new
//      whole-badge tap handler in home-screen.js _wireDevidBadge.
//      Pill padding 5/14 → 8/18, text 11 px → 12.5 px / 700 / white,
//      letter-spacing 0.06 → 0.10 em.
//   3. Auto-show tooltip suppressed in footer-row context (CSS
//      display:none) — the lang-pill identity disclosure already
//      surfaces this on first run.
// nowrap row layout — pill no longer collides on mobile-portrait
// because the icon buttons are gone. RN companion mirrored.
// Spec: e2e/tests/pwa/86-footer-redesign.spec.ts.
// v173 → v174 (May 2026 — "Verified Reports Nearby" Phase 2):
//   1. Bottom-sheet detail modal (#nearby-sheet) — slides up on row
//      tap, dismissed via backdrop/✕/Escape. Soft pre-fill of
//      building_id + lat/lng on "Add Your Report Here" CTA (stored
//      to localStorage; v4 capture flow reads + clears).
//   2. Remaining 15 locales filled with full translations (was en
//      fallback in Phase 1); +9 sheet-specific i18n keys
//      (nearby_sheet_distance_from_you, nearby_sheet_label_reports,
//      nearby_sheet_label_verified, nearby_sheet_latest_at,
//      nearby_sheet_earliest_at, nearby_sheet_incidents,
//      nearby_sheet_severity, nearby_sheet_add_report_here,
//      nearby_sheet_close). 22 locales × 746 keys total.
//   3. New Playwright specs: detail-sheet open, dismiss via 3
//      methods, PII audit, RTL row mirror, reduced-motion slide
//      disable.
//   4. RN companion mirrors the modal via React Native <Modal>
//      with the same hardware-back integration on Android.
// Touches: index.html (#nearby-sheet markup), nearby.js (_open/
// _closeDetailSheet, soft prefill), styles.css (~150 lines of
// .nearby-sheet rules), i18n × 22 locales.
// v172 → v173 (May 2026 — "Verified Reports Nearby" home intel
// module Phase 1). Adds /api/v1/reports/nearby endpoint (server-
// side, shipped in commit f682b11) + a new mobile-app/src/nearby.js
// client module that boots on home, reads cached GPS (never prompts
// on home — operator's offline-first rule), fetches grouped nearby
// reports, renders into the new #home-nearby-intel block, and
// gracefully hides when offline/cache-stale. New i18n keys (~30)
// localised across 6 UN langs + hi (other 15 locales en-fallback,
// Phase 2 sweep). Replaces the static-24 pulse placeholder per the
// approved design plan option #4. Module is added to STATIC_ASSETS
// for offline boot of the script (the API call gracefully fails when
// offline). RN companion lands the same module on HomeScreen.tsx.
// Specs: e2e/tests/pwa/69-nearby-*.spec.ts.
// v171 → v172 (May 2026 — lang pill v6.1 visibility pass).
// Operator screenshot pass 2: v6 (v171) reskinned the pill to navy
// gradient + cyan glow but the halo alpha was too low (0.18) to be
// perceptually visible against the dark `var(--bg)` home background,
// and border-radius 24 + the pill's short content height left the
// corners reading squarish. v6.1: alpha 0.18 → 0.45 with spread
// 0 → 2px, radius 24 → 999 (full capsule), padding 5/12 → 7/14,
// right: 20 → 24 so the cyan halo has breathing room before the
// `.mobile-screen` overflow:hidden clips it. LED dot bumped 11 →
// 12 px with a 3-layer halo (bright inner ring + medium + diffuse).
// RN companion mirrored: shadowOpacity 0.30 → 0.55, radius 12 → 16.
// Spec: e2e/tests/pwa/85-lang-pill-redesign.spec.ts asserts the
// new tokens.
// v170 → v171 (May 2026 — lang pill v6 redesign).
// Operator screenshot: the top-right language switcher looked flat
// (rgba(0,0,0,0.3) background, weak green halo). New look: navy
// gradient capsule + cyan ambient glow + thin top highlight, plus a
// brighter radial-gradient LED dot with a stronger green halo so the
// live-indicator reads clearly. Structure unchanged — #connectivity-
// dot + #btn-lang-current (containing .lps-flag + .lps-code) — only
// the visual tokens change so the RTL flip, install-prompt offset,
// and all existing lang-switcher specs (incl. 56-flag-rendering)
// stay valid. RN companion uses #152238 + cyan shadow to match.
// Spec: e2e/tests/pwa/85-lang-pill-redesign.spec.ts.
// v169 → v170 (May 2026 — operator: 'remove "CAPTURE VERIFY SAVE"').
// Removed the .cta-sub <span> under the primary CTA in index.html
// + the matching <Text> in the RN companion. The home_cta_sub i18n
// key + .cta-sub CSS rule stay as orphans so no locale churn / no
// regression risk for any other surface that resurrects them.
// VoiceOver / TalkBack still announces the value-prop via the RN
// accessibilityHint and the PWA aria-* fallbacks.
// v168 → v169 (May 2026 — bottom-portion refresh v2, operator feedback):
//   1. CTA helper copy: "Always Working. Everywhere."
//   2. Live channels show "Live" status in glowing green; both green
//      dots removed (.ct-dot pip + .is-live::after)
//   3. .home-impact-reports-nearby UN-HIDDEN (legacy declutter rule
//      at line ~5745 hid the whole .home-impact block)
//   4. Footer single-row: Privacy · Help · Open source LEFT + device-
//      ID pill RIGHT (matches operator's mock layout)
// Touches: index.html (footer restructure), home-screen.js (drop .ct-
// dot from live tiles, IVR uses live_now), styles.css (v168.1 rules
// block at top of refresh section), 22 i18n files (home_cta_helper +
// live_now values updated).
// v167 → v168 (May 2026 — home bottom-portion refresh per operator
// screenshot: "verified reports nearby" pulse (static 24 for now),
// bigger frosted-glass action tiles, bigger channel tiles with
// status subtitle line ("Live now" / "Coming soon" / "Low bandwidth"
// / "Voice reporting"). Touches index.html (.home-impact-reports-
// nearby block), home-screen.js (_buildChannelTile + _renderChannels
// status param), styles.css (bottom-portion refresh rules), 22
// i18n files (+ home_reports_nearby + live_now + low_bandwidth +
// voice_reporting). Bump required so returning users evict the v167
// pulse-block snapshot. Specs: e2e/tests/pwa/68-home-v5-layout.spec.ts.
// v166 → v167 (May 2026 — home v5 redesign: hero card grouping,
// deeper navy radial bg + cyan glow, pulse stat block for the
// lives-saved counter, reassurance helper under the CTA. Touches
// index.html (.home-hero-card structural wrap, .home-impact-pulse
// modifier + .hi-caption), styles.css (v5 rules block), 22 i18n
// files (+ home_cta_helper + home_pulse_label). Bump required so
// returning users evict their cached snapshot of pre-v5 home.
// Specs: e2e/tests/pwa/68-home-v5-layout.spec.ts.
// v165 → v166 (May 2026 — IndexedDB queue orphan self-heal).
// Operator (2026-05-13): a submission was interrupted mid-flight and
// left a `pending-reports` row with stages.meta/text/audio=true but
// serverId=null AND zero payload (description empty, no audio, every
// photo variant at chunkProgress=0). The row sat ~24h, invisible to
// the soft-drain dequeue path (gated on stages.photo) and skipped by
// the retry loop (photo-upload threw on null serverId before bumping
// retryCount). _isOrphanQueueRow + _selfHealOrphans now auto-dequeue
// such rows on boot and on every syncQueueManual entry. 10-min age
// gate protects genuinely in-flight submissions. Spec:
// e2e/tests/pwa/84-queue-orphan-self-heal.spec.ts.
// v164 → v165 (May 2026 — Stage 2 classify auto-progress).
// Operator: "When the user selects any tile/card option in Stage 2,
//  the app should automatically progress to the next step/page
//  immediately after selection. The transition should feel smooth,
//  intentional, and responsive. The currently selected tile should
//  briefly show an active/selected animation state before auto-
//  navigation occurs. Navigation delay should be minimal (~150–300ms)."
// Tile-tap UX in v4 classify (damage → infra → crisis → review):
//   t=0    user taps tile  →  .is-selected + state save + summary
//                              update + .is-tap-confirmed class
//   t=200  pulse animation completes (scale 1 → 1.04 → 1 + mint halo)
//          → _doClassifyAdvance(step) navigates to next sub-view OR
//          stage-v4-review if step === 'crisis'
//   prefers-reduced-motion → t=80 ms, no pulse animation
// Race guards:
//   _advancingFromStep flag bails on rapid double-taps so only one
//   navigation fires per tap-burst. _showSubStep clears the guard on
//   sub-view entry so re-taps after back-nav work normally.
// OTHER infra tile: doesn't auto-navigate on tap (would skip past
//   the required free-text input). Tile gets the pulse + state set;
//   advance fires on Enter key OR blur of #v4-infra-other-input,
//   only when state.infrastructure_type === 'OTHER' AND
//   infrastructure_name non-empty.
// Continue button (#btn-v4-classify-next) kept in DOM for back-compat
// but hidden via `#stage-v4-classify .v4-footer { display: none }`.
// Spec: e2e/tests/pwa/83-classify-auto-progress.spec.ts (8 cases
// covering auto-advance, OTHER trigger, back-state preservation,
// rapid-tap race guard, reduced-motion, offline-state persistence,
// Continue hidden).
// Smoke verified end-to-end via /tmp/crisp_classify_autoprogress_smoke.mjs:
//   damage tap → infra view (state.damage_classification = COMPLETE)
//   infra tap → crisis view (state.infrastructure_type = RESIDENTIAL)
//   crisis tap → review stage (state.crisis_type = EARTHQUAKE)
//   Back → damage view with prior selection still .is-selected
// v163 → v164 (May 2026 — v4 capture-stage smart contextual tips).
// Operator: "Redesign the layout so the space between Voice/Text
//  and Continue feels intentional and useful rather than empty.
//  Add Smart Contextual Guidance — use this space intelligently to
//  help users submit better reports.
//  Possible examples:
//    'Describe what happened'
//    'Add voice details if roads are blocked or help is needed'
//    'Your report may help emergency responders act faster'"
// New aside .v4-cap-tips appended after .v4-cap-sections inside the
// v4-body. Three icon+text tips + a dashed-separator impact line
// ("Verified responders read every report"). Each tip carries a
// data-tip="photo|voice|text" attribute; v4-flow.js's existing
// _refreshSectionBadges toggles `.tip-done-photo / -voice / -text`
// classes on #v4-cap-tips when the corresponding capture lands. CSS
// dims that tip + reveals a green check, providing smart contextual
// feedback without any new state machinery.
// 5 new i18n keys (v4_cap_tips_eyebrow / _tip_photo / _tip_voice /
// _tip_text / _tip_impact) translated across all 22 locales —
// validator passes 687 keys.
// Verified at iPhone 14 (390×844):
//   - tips card height 225 px, sits at y=509-734
//   - CTA stays anchored at y=781 (46 px gap above CTA — clean)
//   - page does NOT scroll (scrolls=false)
//   - all-done state: 3 tips dimmed, 3 green checks shown
// v162 → v163 (May 2026 — alignment-rhythm pass).
// Operator: "Currently the layout feels visually disconnected and
//  asymmetrical:
//    - The Lifekeeper badge appears floating randomly and not
//      aligned with the primary CTA.
//    - The logo/header area and language selector are not aligned
//      on a common visual grid.
//    - Horizontal alignment between elements feels inconsistent.
//    - The CTA width, padding, and visual centering need
//      refinement.
//    - Overall composition lacks visual rhythm and professional
//      balance."
// Measured the misalignments via /tmp/crisp_align_audit.mjs at 390 px:
//   BEFORE
//     lang pill right gap     = 16 (vs stage right gap 22) → off by 6
//     identity pill left gap  = 22, right gap = 150           → asymmetric, floating left
//     stage padding-right     = 22 / 24 across height breakpoints → grid shifted by viewport
// Three fixes:
//   1. .home-reward-hero { justify-content: flex-start → center }
//      so the Lifekeeper inline pill sits on the same vertical
//      centre axis as the CTA below.
//   2. .lang-switcher { right: 16 → 20 } so its right edge aligns
//      with the home-stage's 20 px horizontal gutter (was sticking
//      out 4-6 px further right than everything else).
//   3. Home-center horizontal padding pinned at 20 px on EVERY
//      viewport height (dropped the 22 / 24 bumps in the
//      min-height: 820 / 920 media queries) so the grid never
//      shifts. Only vertical padding scales with viewport now.
// Verified after:
//   brand        left=20  right_gap=130 (left-anchored)
//   lang         right=20 (was 16) — matches grid right edge ✓
//   identity_pill left=86 right=86 — perfectly centred ✓
//   consent/CTA/utility/channels/footer all left=20 right=20
//   devid        left=99 right=99 — perfectly centred
// Every full-width element now shares LeftGap = RightGap = 20 px;
// pills are centred symmetrically; no element drifts off-grid.
// Still scrolls=false on all 5 measured viewports.
// v161 → v162 (May 2026 — home stage REDESIGN PASS).
// Operator: "Analyze the current CRISP landing page UI/UX carefully
//  and redesign/refactor ONLY the layout, spacing, responsiveness,
//  CSS hierarchy, visual balance, and interaction polish WITHOUT
//  changing any existing functionality, workflows, buttons, logic,
//  routing, reporting flow, or integrations."
// Goals:
//   1. CTA "Report an Incident" becomes the visual ANCHOR
//   2. Lifekeeper status becomes a quiet inline pill (was 130 px card)
//   3. Action tiles (My Reports + utility) move BELOW the CTA
//   4. Channels keep 3 × 2 grid but with softer borders
//   5. Footer + device-ID pinned to viewport floor, no detachment
//   6. Single page, no scroll, no overflow on any common viewport
//   7. Safe-area insets for notched devices
//   8. 11 bordered surfaces → 6 (reduce cognitive load)
//
// Implementation in 3 phases all in one commit:
//   Phase A — markup: wrap home-center children into 3 semantic
//     sections (top / hero / bottom). Pull action-tiles OUT of the
//     home-identity block, place BELOW the CTA inside section-hero.
//     Add CTA subtitle span (.cta-sub "CAPTURE · VERIFY · HELP").
//     All existing IDs preserved → wiring untouched.
//   Phase B — CSS: new appended block (lines 9430+) overrides the
//     older block-by-block treatments via .home-stage parent
//     prefix. Section flex: 0/1/0 grow so hero zone absorbs spare
//     viewport height (no more `margin: auto 0 0` dead space).
//     CTA scaled via clamp(96px,16vh,136px) height + clamp font
//     sizes + gradient + drop-shadow + inner highlight. Lifekeeper
//     pill compound-selector compounded so it beats older hero
//     overrides. Utility tiles → no individual borders. Channels
//     border opacity 0.18 → 0.06.
//   Phase C — i18n: new key home_cta_sub ("Capture · Verify · Help")
//     translated across 22 locales. Validator passes 682 keys.
//
// Verified at 5 viewports via /tmp/crisp_fit_check.mjs:
//   iPhone SE   390×667   scrolls=false  devid_bottom 655/667
//   iPhone 14   390×844   scrolls=false  devid_bottom 828/844
//   Pixel 7     412×915   scrolls=false  devid_bottom 899/915
//   iPad        768×1024  scrolls=false  devid_bottom 1006/1024
//   desktop sh  1280×720  scrolls=false  devid_bottom 708/720
// Every viewport fits without scroll; device-ID visible at bottom.
// v160 → v161 (May 2026 — channels back to 3 × 2 grid).
//   Operator: "You have kept all channel icons in one row. This is
//    not Ok. It was looking great earlier. Now its bad. Put in 3
//    rows adjust box sizes accordingly."
// v160 had compressed channels to a single horizontal flex row to
// fit everything in viewport; operator preferred the prior 3-col
// × 2-row grid (which is two rows visually, three tiles each).
// Re-laid as `grid-template-columns: repeat(3, 1fr)` with COMPACT
// tile sizing so the section still fits the home stage in 100dvh:
//   tile min-height  46 / 58 / 66 / 74 px across height breakpoints
//   icon font-size   17 / 20 / 22 px
//   label font-size  10 / 11 / 11.5 px
//   gap              5 / 8 / 10 / 12 px
// Plus home-center gap dropped to 8 on the base + breakpoints
// raised (700→740, 800→820, 900→920) so 720 px desktops stay on
// the compact base. Re-verified at 5 viewports:
//   iPhone SE   390×667   scrolls=false  devid_bottom=654 of 667
//   iPhone 14   390×844   scrolls=false  devid_bottom=824 of 844
//   Pixel 7     412×915   scrolls=false  devid_bottom=895 of 915
//   iPad        768×1024  scrolls=false  devid_bottom=1002 of 1024
//   desktop sh  1280×720  scrolls=false  devid_bottom=704 of 720
// v159 → v160 (May 2026 — operator-reported scroll on home stage).
//   "The entire app should be responsive and load on a single page
//    along the height of the screen without using scroll on all
//    screens, browsers and OSs. Fix in local. Currently the height
//    is not responsive, it cuts on some screen."
// Pre-fix content totalled 1145-1407 px across iPhone SE / iPhone
// 14 / Pixel / iPad / desktop — overflowing every viewport by
// 300-500 px and forcing scroll.
// Diagnosed with /tmp/crisp_height_audit.mjs:
//   biggest contributors → channels section 181-310 px (3×2 grid),
//   reward hero 119-133, consent 80, home-center gaps 14-28.
// Compressions:
//   • channels 3×2 grid → single horizontal flex row of 6 compact
//     chips, each 46-66 px tall (was 78-138). Section shrinks
//     181-310 → 63-86 px.
//   • reward-hero padding 20-26/30-32 → 12-16/22-28; min-width
//     220 → 200, max-width 360 → 320. Hero shrinks 119-133 → 101-111.
//   • consent padding 12/14 → 8/12; font 12.5 → 12. 80 → 67.
//   • action-tiles margin 8/12 → 4/4. reward-hero margin 14/6 → 4/2.
//   • home-center gap 14/22/28/32 → 10/12/14/16 across breakpoints.
// Verified via /tmp/crisp_fit_check.mjs at 5 viewports:
//   iPhone SE 390×667  scrolls=false  devid_bottom=651 of 667
//   iPhone 14 390×844  scrolls=false  devid_bottom=824 of 844
//   Pixel 7   412×915  scrolls=false  devid_bottom=893 of 915
//   iPad      768×1024 scrolls=false  devid_bottom=1002 of 1024
//   desktop   1280×720 scrolls=false  devid_bottom=702 of 720
// Every viewport now fits without scroll; device-ID pill remains
// within the viewport at the bottom.
// v158 → v159 (May 2026 — operator-reported blank slot in action
// tiles row).
//   "When someone downloads the app the download button disappears
//    but the remaining blocks dont adjust and align and are not
//    responsive. The blank area looks bad."
// Diagnosed with Playwright at 960×900 + 390×900:
//   BEFORE — 4 visible tiles each 71.6 px wide, last tile ends at
//   x=595 but row ends at x=675 → ~80 px blank slot on the right.
//   Same on mobile, ~72 px blank.
// Root cause: .home-action-tiles was `display: grid;
// grid-template-columns: repeat(5, 1fr)` which RESERVES five
// columns always — when a child has `display: none` (install tile
// hidden once PWA is installed) its column stays empty.
// Fix: swap to flex with `flex: 1 1 0; min-width: 0` on each tile
// so every VISIBLE tile grows to share the row evenly.
//   AFTER  — 4 visible tiles each 91.5 px wide (desktop) /
//   81.5 px (mobile), last tile ends exactly at the row's right
//   edge → 0 px blank. 5 tiles still 71.6 / 63.6 px wide as
//   before (no regression on the all-visible state).
// v157 → v158 (May 2026, action-tiles pass).
// Operator: "1. CRISP logo and CRISP we can Align with Language bar.
//            2. Reduce the size of the Lifekeeper Icon.
//            3. Expand 'Download App', 'Login', My Reports, Rewards
//               and Audio Speaker add as a row above Life Keeper.
//            4. rest keep aligned and clean."
// Four targeted changes:
//   1) brand-row min-height 44 → 32 px, logo 42 → 32 px, home-center
//      padding-top pinned at 16 across all viewport heights so the
//      brand block + lang pill share a single horizontal centre
//      line at y≈32. Measured brand_logo center = lang pill center
//      = 32 px (delta < 1).
//   2) Reward-hero emoji 44/52 → 28/32 px (small viewports / tall).
//      Tier name 22/26 → 22/24. Card stays the centred trophy from
//      v157 but no longer dominates.
//   3) New .home-action-tiles row above the reward hero — 5 equal
//      columns: Download App / Login / My Reports / Rewards /
//      Audio. Each tile: icon above + 2-line label, login keeps
//      red/green status dot in the corner. Replaces the small top-
//      right icon cluster (install + voice + login) AND the 2-col
//      secondary row (My Reports + Rewards) — one unified toolkit.
//   4) Labels use new i18n keys (action_tile_download / _login /
//      _audio) across 22 locales. Validator passes 681 keys.
// Verified with Playwright (/tmp/crisp_tiles_verify.mjs):
//   - tile_count: 5, all at top: 70 (same row)
//   - tiles_above_hero: true (70 < 188)
//   - legacy_hidden: true (the old secondary row is empty + hidden)
//   - emoji size: 32 × 32 px (was 52 × 52)
//   - brand center y = 32, lang pill center y = 32 (aligned)
// v156 → v157 (May 2026, reward-hero pass).
// Operator: "Changes required:
//   1. Device Id we can move below privacy row.
//   2. Life Keeper 11 Lives Saved should be center aligned and Big.
//      thats a reward."
// Two restructures:
//   A) Badge chip lifted out of .home-devid-wrap into its own
//      .home-reward-hero block right below the brand row. New
//      .home-badge-chip--hero modifier renders it as a centered
//      trophy card — big emoji on top (44 → 52 px on taller
//      viewports), tier name 22 → 26 px, "{N} LIVES SAVED" caption
//      in uppercase. Reads as a reward, not a status pill.
//   B) Device-ID pill (CRISP-XXXX-XXXX) + tooltip MOVED OUT of the
//      identity area at the top and placed in a new .home-devid-
//      footer block beneath the privacy / open-source / help /
//      version row. Anonymous-ID utility metadata now sits where
//      utility metadata belongs.
// Specificity fix: the new hero treatment uses
//   `.home-badge-chip.home-badge-chip--hero` (2-class compound)
// so it beats the later single-class layout-tweak at line ~5329
// that was forcing padding 5px 11px + emoji font 13 px.
// Verified with Playwright (/tmp/crisp_reward_verify.mjs):
//   - chip_is_centered_in_stage: true
//   - devid_below_footer: true
//   - chip height: 78 → 159 px (room for big emoji + label + caption)
//   - emoji font-size: 13 → 52 px
//   - padding: 5/11 → 26/36 px
// v155 → v156 (May 2026 — operator-supplied new brand mark).
// Two SVGs replaced across both the PWA and the dashboard:
//   • favicon.svg — new "ripple" design: dark navy tile (rx=44 in
//     a 256 viewBox) with 4 concentric response rings (faint outer
//     → bright inner), cyan epicenter dot, coral responder dot on
//     the second ring. Cleaner + on-brand vs the prior orange
//     shield + alert mark.
//   • crisp-badge-ripple.svg — horizontal lockup (340×110) with the
//     same tile mark on the left + "CRISP / Crisis Reporter" text
//     on the right. Staged in /assets for future splash/share-card
//     placement.
// Visible swaps in this commit:
//   - PWA home-stage .home-brand-logo inline SVG (256×256 ripple)
//   - Dashboard .brand-icon header glyph (was FA satellite-dish)
//   - Dashboard /login .logo (was FA shield-halved + CRISP text)
//   - Dashboard /evidence header (was FA satellite-dish)
// Regenerated assets/icon-192.png + assets/icon-512.png from the
// new favicon.svg via headless Chromium so PWA installs and Apple
// touch-icon use the ripple design too. The wifi-arc Lucide icon
// and the old orange-shield favicon are now gone from the home
// stage; the FA satellite-dish/shield glyphs are gone from the
// dashboard header/login/evidence.
// v154 → v155 (May 2026 — operator: "There is no change on this
// portion. It still Looks messy bad and not god for UNDP challenge
// submission" / "Verify, review take snapshot, confirm then then
// conclude it is done.").
// Root cause measured with Playwright (not assumed): the previous
// declutter pass set `align-items: stretch` on .home-devid-wrap but
// a LATER override (`align-items: center` at the bottom of the file
// for layout-tweak block) won the cascade. With center alignment +
// the badge's max-width:220 inside a 390-wide wrap, browsers center
// the constrained item in the cross-axis, leaving the pill at
// (390 − 198) / 2 = 96 px from the left edge of the wrap — drifted
// right of the brand-row's left edge.
// Verified with /tmp/crisp_verify.mjs:
//   BEFORE — badge_offset_in_wrap: 96, chip_offset_in_wrap: 87
//   AFTER  — badge_offset_in_wrap:  0, chip_offset_in_wrap:  0
// Both pill and chip now share `left = 285` with the brand wordmark
// (all_aligned: true). Fix: changed the conflicting override from
// `align-items: center` to `align-items: flex-start` at the bottom
// of styles.css. The earlier `flex-direction: column` change still
// holds; both children left-align with the rest of the identity
// area now.
// v153 → v154 (May 2026, declutter pass v2 — operator: "Further
// screwed UI and UX. Its getting worse every time" + "UI is bad
// overlapping and unprofessional. Make it 10x better than before").
// Real diagnosis from the screenshot:
//   • Device-ID pill + badge chip on the SAME flex row (wrap=true)
//     so on wide viewports they sat side-by-side and visually
//     overlapped. The "overlap" complaint.
//   • The standalone Lives Saved pill ("8 LIVES SAVED") was
//     redundant — the badge chip above already carries "8 lives
//     saved" for T4 reporters, and for T1-T3 the value is "—"
//     (noise).
//   • Verbose channels lede ("Telegram and IVR are live. Other
//     channels launching soon.") repeated what the green-dot
//     indicators on live tiles already signal.
//   • "Crisis Reporter" tagline under the wordmark is a marketing-
//     site pattern; in-app it adds a 2nd line for no information
//     gain.
// Five surgical fixes — pure removals + one layout swap:
//   1) .home-devid-wrap → flex-direction: column → device-ID pill
//      and badge chip ALWAYS stack vertically; never overlap.
//   2) Standalone .home-impact "Lives Saved" chip hidden on home
//      stage (display:none !important). Painter still updates the
//      count for other surfaces.
//   3) Channels-section .home-section-lede hidden on home stage.
//      Green-dot live indicator on each tile communicates the same.
//   4) .home-brand-sub ("Crisis Reporter" tagline) hidden on home
//      stage. Brand wordmark + primary CTA convey identity.
//   5) home-center gap 16 → 14 px; trimmed elements + tighter gap
//      reads as one coherent card instead of disjoint stacked
//      blocks.
// v152 → v153 (May 2026, landing-page declutter pass).
// Operator: "Cluttered. Make it look professional. Think and plan
// properly. Benchmark some other companies UI and make best of best
// for least cognitive load and easy to use."
//
// Screenshot audit (Strava / Apple Health / Linear benchmark):
//  • 3 round icons (install + voice + login) floated MID-PAGE between
//    badge chip and primary CTA — orphan island in dead space.
//  • Device-ID pill + badge chip stacked as 2 separate identity claims
//    burning vertical real-estate.
//  • Badge chip carried verbose "Top tier reached — tap to share your
//    badge" sub-text that was both noisy AND misleading (chip is
//    decorative-only — tap does nothing).
//  • Standalone "8 LIVES SAVED" giant card (34 px font, 18 px padding)
//    competed with the identity card + primary CTA for attention.
//
// Four surgical changes — zero feature removal:
//  1) tools row LIFTED to position:absolute top:60 right:16, just
//     under the lang pill — clusters with the other page-chrome icons
//     at the top-right (Linear / Gmail pattern). Icons shrunk 44 → 36
//     so the cluster doesn't dominate; tap target stays compliant.
//  2) Badge chip sub-text for T4 now shows actual stat ({n} lives
//     saved) instead of the misleading "tap to share" copy.
//  3) Standalone home-impact "Lives Saved" downsized from a hero card
//     to a quiet inline chip — number + label baseline-aligned on one
//     line, no background gradient, thin border, ~5 × less vertical
//     real-estate. The badge chip already carries the user's stat
//     for T4; this strip persists for T1-T3 as quiet social proof.
//  4) Tier-progress i18n key `tier_progress_top_share` shortened to
//     "Top tier reached" across 22 locales (was "Top tier reached —
//     tap to share your badge"); new key `badge_chip_lives_stat` added
//     for the T4 stat template.
// v151 → v152 (May 2026, operator-requested landing-page icon cleanup).
// "Clean up the Landing page. These blocks can be icons as suggested.
// When logged in show green, else red." Three changes ship together:
//  1) Full-width "Login / Sign up" tertiary-cta row → REMOVED from
//     the home secondary-row. Login is now a round 44×44 icon in a
//     new always-visible #home-tools-row (alongside Install + Voice).
//     A 10-px status dot at the icon's top-right shows auth state
//     at a glance — GREEN when signed in, RED when anonymous — using
//     the same palette as the existing .connectivity-dot in the lang
//     pill (visual consistency for "uneducated reporter" persona).
//  2) Install + Voice icons LIFTED OUT of #home-devid-wrap into the
//     new tools row. Pre-fix they were trapped inside the wrap that
//     hides on login, so signed-in users couldn't access Install/TTS.
//  3) Redundant .account-pill DOM (display-name + chevron) REMOVED
//     from the logged-in slot. The login-icon's green dot + the
//     "Welcome back, {name}." supratext above the CTA already
//     communicate identity + auth state with less cognitive load.
//     The dropdown menu (My Reports / Settings / Log out) is anchored
//     under the login icon now.
// i18n: 2 new keys (home_login_icon_signed_in / _signed_out) shipped
// to all 22 locales with real translations for the 6 UN langs + hi
// and translated equivalents for the remaining 15.
// v150 → v151 (May 2026, operator-reported photo-consent modal bugs).
// Two fixes:
//   1) Modal appeared on every cold app load because its markup
//      carried `class="upload-overlay"` which set `display: flex`
//      and overrode the `[hidden]` UA rule. Now self-contained
//      `.photo-consent-overlay` class with explicit
//      `[hidden] { display: none }`. JS toggles via `hidden`
//      attribute only — no `style.display` writes.
//   2) Visual polish — replaced the 📸 emoji with an inline SVG
//      camera glyph (sharper, theme-tinted), asymmetric 1fr/1.8fr
//      action grid so "OK, choose photo" no longer wraps to 3 lines,
//      softer entrance animation (fade + slight scale), check
//      bullets rendered with CSS pseudo-elements instead of the
//      ✓ character (smoother + scaling-safe).
// v149 → v150 (May 2026 Lighthouse perf pass — CLS + LCP fixes).
// Three-phase no-feature-change perf rewrite:
//   Phase 1: slot-reservation CSS so late DOM reveals (badge chip,
//     lives count, install slot, identity bar swap) stop shifting
//     downstream content. Plus woff2 preload for Inter + Outfit.
//   Phase 2: inline ~9 KB critical CSS in <head> + async-load the
//     304 KB styles.css via preload+onload. First paint no longer
//     waits on the full stylesheet.
//   Phase 3: replace 14 home FontAwesome icons with inline Lucide-
//     style SVG. Home renders icons immediately, no FA-bundle wait.
// Expected median deltas (Slow-4G): CLS 0.242 → ~0.06, LCP 10.1s
// → ~3-4 s, Perf 44 → ~75-80.
// v148 → v149 (May 2026, Badge Studio futuristic + share-flow polish).
// Operator: "Make it a bit futuristic with 5-10 options of different
// life savers… amazing messages for people to share… When user
// uploads, ask for consent and storage. Show the image uploaded.
// Add Rewards shortcut on Track my reports and post submission Final
// Window. Also show Home button there."
//
// Phase A — Badge Studio hero pack:
//   • New character-pack.js with 8 original hero caricatures (4 comic
//     archetypes + 4 first-responder archetypes — Caped Guardian /
//     Sky Sentinel / Iron Ally / Beacon Light / Field Medic /
//     Firefighter / Lifeguard / Rescue Pilot). Apache-2.0 originals,
//     no trademark exposure (NOT Batman/Superman/Black Panther).
//   • Canvas paint helpers: hex-grid HUD backdrop + concentric arc
//     tick-marks + neon edge halo + diagonal sweep glow. Pure Canvas;
//     no external libs.
//   • Character picker (4×2 grid) + share-message picker (8 messages
//     + Surprise me) in stage-badge-studio.
//
// Phase C — Photo consent + thumbnail + applyPiiBlur fix:
//   • Consent modal shown on FIRST "Choose photo" tap (persisted
//     localStorage `crisp_photo_studio_consent_v1`).
//   • Preview thumbnail (56×56) confirms the uploaded image.
//   • _maybeBlurFaces now correctly unwraps applyPiiBlur's
//     {blob, blurred, skipped, ...} return shape. Pre-fix it
//     duck-typed for Blob|canvas and silently fell through to
//     the unblurred bitmap on every real upload — UNDP must-have #7
//     bug fixed in passing.
//
// Phases D+E — Rewards shortcuts everywhere:
//   • #btn-mr-rewards medal on My Reports controls row.
//   • Success page secondary row replaces the single Track button
//     with Track + Rewards + Home in a 3-column grid.
//
// Phase F — i18n × 22 locales (+20 new keys).
//
// STATIC_ASSETS adds character-pack.js so the studio works fully
// offline once installed.
// v147 → v148 (May 2026, operator-reported stage-stacking bug).
// `goToStage` was iterating only the hard-coded STAGES + STAGES_V3
// lists when removing `.active` from the prior stage. The new
// stage-rewards + stage-badge-studio (from reward-system v2) were
// missing from both lists → tapping "Open Badge Studio" on the
// Rewards page added `.active` to stage-badge-studio WITHOUT
// removing it from stage-rewards, so both stages rendered with
// non-zero opacity → operator screenshot showed Badge Studio
// overlapping the Rewards ladder. Fix: walk every `.stage` element
// in the DOM and clear `.active` before assigning the new target;
// self-heals for any future stage too. Companion test in spec 66
// pins the "exactly one .stage.active" invariant.
// v146 → v147 (May 2026, operator-reported tier-stuck-at-Scout bug).
// Two-line fix to the reward-system v2 surfaces:
//   1) app.js now exposes API_BASE as `window.API_BASE` (was a
//      module-scoped const). Pre-fix home-screen.js's three fetch
//      sites fell back to `/api/v1`, which on local dev resolves
//      against the PWA's :8080 origin (the static file server)
//      and 404s — symptom: badge chip stuck at T1_SCOUT even though
//      the user is T4_LIFEKEEPER with 8 lives saved (the Lives Saved
//      card kept working because app.js uses the module-scoped
//      API_BASE directly). Exposing once heals all consumers.
//   2) home-secondary-row layout tidied — pre-fix the three buttons
//      (My Reports / Rewards / Login) wrapped awkwardly as 2+1 in
//      a 2-col grid. New rule pins Login to a full-width row via
//      grid-column:1/-1 so My Reports + Rewards share row 1 + Login
//      gets its own row.
// v145 → v146 (May 2026 reward-system v2, second pass) — separated
// the "level up info + badges + sharing" surface from the home badge
// chip. Pre-fix the chip doubled as both a status display AND a
// tap-to-open-Badge-Studio button, which read as confusing
// (operator-flagged: "looks decorative but tapping does something").
// Now: chip is purely decorative; new home #btn-rewards button opens
// a dedicated `stage-rewards` page that hosts the 4-tier ladder
// explanation + Badge Studio entry CTA. Touches index.html (new
// stage + new button + chip role change), home-screen.js (new
// `_renderRewardsPage`/`_wireRewardsNav`/`_openRewardsStage`),
// badge-studio.js (drops the chip-tap wiring since chip is no
// longer a button), styles.css (Rewards-page styles), 22 locale
// files (+11 new i18n keys each).
// v144 → v145 (May 2026 reward-system v2) — full gamification
// rewrite per operator request. 4-tier identity-forward ladder
// (Scout / Signal / Changemaker / Lifekeeper) with progress sub-line
// on the home badge chip, body-class theme affect at T3+, tier-up
// celebration toast on My Reports open, and a new Badge Studio
// stage (Canvas composer + 3 templates + WA/Insta/LinkedIn share
// dispatch). Backend /reports/profile/<hash> returns a richer shape
// (tier object + responded_count + lives_saved_total + legacy
// alias); new /share/<token> endpoint serves OG-meta share pages
// for LinkedIn. badge-studio.js added to STATIC_ASSETS so the
// stage works fully offline once the PWA is installed. ~30 new
// i18n keys across all 22 locale files.
// v143 → v144 (May 2026, operator-reported, second-pass UX) — My
// Reports redesign #2: dropped the RESOLVED + IN-FLIGHT tiles from
// the impact-card header (they read as 0 · 0 for most users and
// added no signal). Card is now single-stat "Lives Saved" with a
// pulsing green heart, matching the home screen. Filter dropdown
// (`.mr-filter-select`) was using neutral light-mode chrome that
// looked washed out on the teal/navy theme; repainted with a teal
// border + chevron + dark-teal surface. HTML + styles.css + app.js
// (drop `hi-resolved` write) all touched.
// v142 → v143 (May 2026, operator-reported) — flattened "What caused
// it?" crisis sub-step. Was a 3-card drill-down (Natural / Tech /
// Human-made → tap one → subtype list); now all 9 crisis types
// visible at once under 3 section headers as a 2-column tile grid.
// One tap to select (was two). Icons use the same responsive cascade
// as the infra "What was hit?" tiles (48×48 → 68×68 across
// breakpoints). HTML + v4-flow.js + styles.css all touched.
// v141 → v142 (May 2026, operator-reported) — bumped infra-classify
// tile icon sizes. Was 38×38/20px, now scales 48×48/28px (default)
// → 56×56/32px (≥380w) → 60×60/34px (≥700h) → 64×64/36px (≥800h)
// → 68×68/38px (≥900h). Matches the home-stage CTA responsive
// cascade so v4 capture stays visually consistent.
// v140 → v141 (May 2026, operator-reported) — single-stat home
// impact card. "Reports Verified" tile removed; "Lives Saved" now
// occupies the card centred + slightly larger. Companion change on
// the dashboard adds an analyst-only "Lives helped" input on the
// report detail panel (closes the capability gap where lives_impacted
// was settable by API but had no UI). app.js + index.html +
// styles.css all touched.
// v139 → v140 (May 2026) — color-theme rewrite. Operator-supplied
// 6-color palette swap (no functional / structural changes):
//   · #213A58 navy        — page background base (was near-black)
//   · #0C6478 dark teal   — elevated surfaces (cards, accordions)
//   · #15919B medium teal — borders + secondary accents (was purple)
//   · #09D1C7 vivid teal  — PRIMARY accent / CTA (was orange)
//   · #46DFB1 mint        — soft accents + count chips
//   · #80EE98 lime        — success states (was emerald green)
// Reds (errors), ambers (warnings), UN-blue brand mark, flag SVG
// colors, and gray text tokens kept unchanged for accessibility +
// semantic stability. CSS + app.js + building-select.js + index.html
// + manifest.json all touched; bump CACHE_NAME so returning users
// pick up the new theme.
// v138 → v139 (May 2026) — My Reports UX redesign (operator-reported):
//   · filter chips replaced with a native <select> dropdown ("All"
//     default) — no more horizontal overflow on 390px screens
//   · IN FLIGHT section hides entirely when empty (no more
//     "Nothing in flight" placeholder wasting vertical space)
//   · submitted reports grouped into <details> accordions by date
//     (Today / Yesterday / This week / Older); ONLY the latest non-
//     empty group expanded by default
//   · "Load 5 more" lazy-render per group; older groups lazy-render
//     their cards on first user-expand
// v137 → v138 (May 2026) — operator-reported "1 queued never leaves
// even on 50+ Mbps." Four coordinated fixes:
//   · reconcile soft-drain: dequeue when SMALL of every photo lands +
//     meta/text/audio done; MEDIUM/HIGH missing on the server are
//     marked deferred and the queue row is removed (was infinitely
//     re-queuing pre-fix)
//   · race-safe path for SMALL mid-assembly (server has the row but
//     assembly_status='partial' — wait one tick instead of rolling
//     back the chunk progress and re-uploading)
//   · UNDP-details queue 24h TTL purge — stale entries from before
//     a fixed bug no longer inflate the pill indefinitely
//   · pill now shows "% complete" + a thin green progress bar
//     underneath the text so the operator sees draining in real time
// index.html + styles.css + app.js all touched; bump CACHE_NAME so
// returning users actually see the new UI.
// v135 → v136 (May 2026) — inline-SVG flag rendering in the language
// picker. Every cached HTML/CSS/JS now carries the data-cc swap; bump
// CACHE_NAME so returning Windows-Chrome / Linux users actually pick
// up the fix instead of serving the pre-fix snapshot where their
// flags rendered as monochrome "GB" / "FR" / "IN" letter pairs.
//
// v136 → v137 (May 2026) — unified "N queued" pill across the report
// queue AND the UNDP-details queue. Operator-reported (second pass):
// the pill only counted IndexedDB reports, so a stuck UNDP-details
// patch was either invisible OR confused for a stuck report. The
// pill now sums both queues + tapping it drains both.
// v133 → v134 (May 2026) — covered the recent batch of unpushed PWA-asset
// changes that previously slipped past the cache-bump policy:
//   · c4d2087  app.js + v4-flow.js — Add-Another reset + queued-pill toast
//   · f60aa5b  app.js — SMALL-tier gate / queue drain
//   · f9086f3  building-select.js + v4-flow.js — building re-fetch on
//             manual location change (UNDP must-have #6)
//   · ecc14a2  building-select.js — fullscreen picker invalidateSize
//
// v134 → v135 (May 2026) — building-select state-cleared listener +
// offline queue for the UNDP-details PATCH:
//   · building-select.js  Add Another now clears _selectedLayer +
//                          state.buildingOsmElement + the green pill
//                          (was leaking across reports)
//   · app.js              UNDP-details save enqueues to
//                          `crisp_report_details_queue_v1` on failure
//                          and drains on `online` — matches the
//                          offline-first guarantee of the main report
//                          submit instead of losing data on transient
//                          network blips ("could not save" → data gone)

// Derive base path from SW's own URL (works regardless of where the app is served)
const SW_BASE = self.location.href.replace(/sw\.js$/, '');

// ── BEGIN SW_ASSET_MANIFEST (auto-generated by scripts/generate-sw-manifest.mjs) ──
const SW_ASSET_MANIFEST = {
    "app.js": "d2e89a5c665b",
    "assets/icon-192.png": "90f056f4bc41",
    "assets/icon-512.png": "8fef57c93557",
    "auth.js": "3aa607301909",
    "badge-studio.js": "91f202418d93",
    "blur-worker-pool.js": "eb20908a9c51",
    "blur-worker.js": "1d925ec86600",
    "blurhash.js": "c840d518fe1d",
    "building-select.js": "2f058bf478d9",
    "character-pack.js": "3e41c16081bf",
    "components/icon-pack.js": "ced48cb253ab",
    "device-telemetry.js": "13dcfb66b75a",
    "exif-gps.js": "01e3c798ca74",
    "favicon.svg": "81a594f8c5d3",
    "home-screen.js": "c6c56ac731c2",
    "i18n/ar.json": "7f9eb32dbc9e",
    "i18n/bn.json": "6f1b34b86245",
    "i18n/en.json": "d8e8c1673cdb",
    "i18n/es.json": "95640508498b",
    "i18n/fr.json": "09e8edd02a82",
    "i18n/gu.json": "006dc90eb33c",
    "i18n/hi.json": "1ebe122d47b1",
    "i18n/id.json": "278fdc7d58a7",
    "i18n/ja.json": "645f7eb9f325",
    "i18n/kn.json": "54e50209950d",
    "i18n/ko.json": "f74411932d87",
    "i18n/ml.json": "da63f188f4d7",
    "i18n/mr.json": "7360a17bdc0d",
    "i18n/pa.json": "522111c17ffd",
    "i18n/pt.json": "d7cd9c335e20",
    "i18n/ru.json": "9423ffc8c778",
    "i18n/ta.json": "b2c17ae1185c",
    "i18n/te.json": "986531d6055c",
    "i18n/tr.json": "411e84ac3d6d",
    "i18n/ur.json": "4a978983b87f",
    "i18n/vi.json": "99b624a401b9",
    "i18n/zh.json": "c43067475b87",
    "image-variants.js": "206a66ac153d",
    "index.html": "1e0a11816a44",
    "install-prompt.js": "29b5f0150791",
    "manifest.json": "6ccfd61d4297",
    "nearby.js": "347cb6c40ea3",
    "pii-blur.js": "a2b646426b3b",
    "places.js": "45c2565b646f",
    "sentry-init.js": "1bc08e7032f4",
    "styles.css": "32f92a193ffe",
    "tier-config.js": "79b393bc143d",
    "v4-flow.js": "37ec8eadaff0",
    "vendor/sentry.min.js": "25bf89b834f7",
    "voice-readout.js": "d578b11e8bb6",
};
// ── END SW_ASSET_MANIFEST ──

const STATIC_ASSETS = [
    SW_BASE,
    SW_BASE + 'index.html',
    SW_BASE + 'app.js',
    SW_BASE + 'places.js',
    SW_BASE + 'pii-blur.js',
    // B-D (May 2026): Web Worker pool for off-main-thread blur.
    // blur-worker-pool.js runs in the page (manages the workers);
    // blur-worker.js IS the worker script (loaded via `new Worker(URL)`).
    // Both must be precached so installed PWAs can capture offline.
    SW_BASE + 'blur-worker-pool.js',
    SW_BASE + 'blur-worker.js',
    SW_BASE + 'image-variants.js',
    SW_BASE + 'blurhash.js',
    SW_BASE + 'exif-gps.js',         // Sprint D — GPS EXIF embed before chunked upload
    SW_BASE + 'building-select.js',  // UNDP §3.2 — building-footprint selector
    SW_BASE + 'auth.js',
    SW_BASE + 'install-prompt.js',
    SW_BASE + 'home-screen.js',
    SW_BASE + 'nearby.js',           // "Verified Reports Nearby" home intel module
    SW_BASE + 'voice-readout.js',
    SW_BASE + 'device-telemetry.js', // Phase 5.1 — POSTs sanitised summary to /api/v1/devices/telemetry once / day
    SW_BASE + 'v4-flow.js',
    SW_BASE + 'badge-studio.js',     // reward-system v2 Canvas composer
    SW_BASE + 'character-pack.js',   // reward-system v2 second pass — 8 hero SVGs
    SW_BASE + 'tier-config.js',      // Phase 2.1 — canonical V4 tier metadata (generated from shared/tier-config.json)
    SW_BASE + 'sentry-init.js',      // May 2026 — Sentry boot wrapper
    SW_BASE + 'vendor/sentry.min.js', // May 2026 — vendored Sentry browser SDK (~70KB)
    // vendor/blazeface/model.json + .bin are NOT precached. They're
    // loaded on demand by pii-blur.js::ensureModel on first photo
    // capture and runtime-cached by the fetch handler below.
    SW_BASE + 'components/icon-pack.js',
    SW_BASE + 'styles.css',
    SW_BASE + 'manifest.json',
    SW_BASE + 'favicon.svg',
    SW_BASE + 'assets/icon-192.png',
    SW_BASE + 'assets/icon-512.png',
    // UNDP §3.1b — full 594-key translation packs, one per supported
    // locale. Precached so a user who installs the PWA online and goes
    // offline can pick ANY of the 22 supported languages and see the
    // UI in their language. `_loadLocaleJson()` in app.js fetches these
    // lazily on `activateLang(code)`; the cache-first handler serves
    // them from this cache without touching the network.
    //
    // 22-locale set:
    //   Tier 1 (UN official): en, zh, es, ar, fr, ru
    //   Tier 2 (UNDP submission set): hi, pt, bn, ja, tr, vi, ko, id, ur
    //   Tier 3 (Indian sub-national): kn, ta, te, ml, gu, mr, pa
    SW_BASE + 'i18n/en.json',
    SW_BASE + 'i18n/zh.json',
    SW_BASE + 'i18n/es.json',
    SW_BASE + 'i18n/ar.json',
    SW_BASE + 'i18n/fr.json',
    SW_BASE + 'i18n/ru.json',
    SW_BASE + 'i18n/hi.json',
    SW_BASE + 'i18n/pt.json',
    SW_BASE + 'i18n/bn.json',
    SW_BASE + 'i18n/ja.json',
    SW_BASE + 'i18n/tr.json',
    SW_BASE + 'i18n/vi.json',
    SW_BASE + 'i18n/ko.json',
    SW_BASE + 'i18n/id.json',
    SW_BASE + 'i18n/ur.json',
    SW_BASE + 'i18n/kn.json',
    SW_BASE + 'i18n/ta.json',
    SW_BASE + 'i18n/te.json',
    SW_BASE + 'i18n/ml.json',
    SW_BASE + 'i18n/gu.json',
    SW_BASE + 'i18n/mr.json',
    SW_BASE + 'i18n/pa.json'
];

const EXTERNAL_ASSETS = [
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;600;800&family=Noto+Sans+Arabic:wght@400;600;700&family=Noto+Sans+SC:wght@400;600;700&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    // TF.js + BlazeFace UMD are NOT precached. pii-blur.js's
    // _ensureScripts() lazy-loads them on first photo capture; the
    // runtime fetch handler below opportunistically caches them.
];

// Domains the runtime fetch handler should cache opportunistically so that a
// subsequent offline capture / map load still works.
const RUNTIME_CACHE_HOSTS = [
    'cdn.jsdelivr.net',
    'tfhub.dev',
    'storage.googleapis.com',  // where tfhub models are served from
    'www.kaggle.com',          // kaggle is the new tfhub host
    'unpkg.com',               // lazy-loaded Leaflet JS + CSS
];

// ── Install: pre-cache static shell ──────────────────────────────────────────
//
// May 2026 — perf Sprint C.4 (#14): per-asset hash migration replaces
// the old `cache.addAll(STATIC_ASSETS)` bulk-fetch. The SW_ASSET_MANIFEST
// block above (auto-generated by scripts/generate-sw-manifest.mjs)
// pairs every precached URL with a 12-char SHA-256 hash of its disk
// content. The new install path is:
//
//   for each STATIC_ASSETS url:
//     1. Compute the expected hash (manifest lookup by relpath)
//     2. Walk old `crisp-v*` caches looking for a Response stored with
//        a matching `x-crisp-hash` header
//     3. Hash match → copy the Response into the new cache (no network)
//     4. Hash miss / absent header → fetch fresh, tag with new hash,
//        store in new cache
//
// Net effect: a cache bump that ONLY touches sw.js + 2-3 source files
// triggers ~3 network fetches on the user's next visit instead of all
// 47. Typical per-deploy bandwidth save per user: ~700-900 KB.
//
// First-install-after-this-ships pays the full refetch cost (no old
// cache has the x-crisp-hash header — they all miss). One-time tax;
// every subsequent deploy reaps the win.
//
// Safety: if any URL fails to migrate AND fails to fetch, the whole
// install rejects — matches the old `cache.addAll` atomicity. Users
// keep the previous SW until the new install completes successfully.
async function _precacheWithMigration(newCache) {
    // Snapshot every old crisp-v* cache so we can scavenge unchanged
    // entries before going to the network.
    const allKeys = await caches.keys();
    const oldCacheKeys = allKeys.filter((k) => k.startsWith('crisp-v') && k !== CACHE_NAME);
    const oldCaches = await Promise.all(oldCacheKeys.map((k) => caches.open(k)));

    let migrated = 0;
    let fetched = 0;
    await Promise.all(STATIC_ASSETS.map(async (url) => {
        // Strip SW_BASE to derive the manifest key. The bare SW_BASE
        // entry (root URL) resolves to index.html server-side, so we
        // map an empty relpath to 'index.html' to look up the right
        // hash from SW_ASSET_MANIFEST.
        const relpath = url.startsWith(SW_BASE) ? url.slice(SW_BASE.length) : url;
        const manifestKey = relpath || 'index.html';
        const expectedHash = SW_ASSET_MANIFEST[manifestKey];

        // Try migration first — walk every old cache until one yields
        // a Response whose stored x-crisp-hash matches the new manifest.
        if (expectedHash) {
            for (const oldCache of oldCaches) {
                const cached = await oldCache.match(url);
                if (cached && cached.headers.get('x-crisp-hash') === expectedHash) {
                    await newCache.put(url, cached.clone());
                    migrated++;
                    return;
                }
            }
        }

        // Fall through to a network fetch. Tag the new Response with
        // the manifest hash so the NEXT deploy can migrate it without
        // a re-fetch.
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) {
            throw new Error('SW install: ' + url + ' returned ' + res.status);
        }
        // Clone headers so we can add x-crisp-hash without mutating the
        // original response (which is also returned to the page if it
        // happens to be the active fetch).
        const body = await res.blob();
        const headers = new Headers(res.headers);
        if (expectedHash) {
            headers.set('x-crisp-hash', expectedHash);
        }
        await newCache.put(
            url,
            new Response(body, { status: res.status, statusText: res.statusText, headers })
        );
        fetched++;
    }));
    // One-line summary so we can confirm the migration is working in
    // production via Service Workers > Console (chrome://serviceworker-internals).
    console.log('SW install: migrated ' + migrated + ', fetched ' + fetched + ' of ' + STATIC_ASSETS.length);
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(async (cache) => {
            // Per-asset migration replaces the old cache.addAll(STATIC_ASSETS).
            await _precacheWithMigration(cache);
            // External (Google Fonts CSS + Font Awesome CSS) remains best-
            // effort because the network may be down at install time; the
            // runtime fetch handler also caches these opportunistically.
            try {
                await cache.addAll(EXTERNAL_ASSETS);
            } catch (_e) {
                console.log('SW: Some external assets failed to cache (offline?)');
            }
        })
    );
    // Do NOT auto-skipWaiting. New workers stay in 'waiting' until the
    // user taps "Update now" on the in-app banner (wired in app.js).
    // Without this gate, an installed PWA would silently flip versions
    // on the next navigation and could drop in-progress capture state.
    // First install is unaffected — no existing controller to wait for,
    // so the worker activates directly.
});

// Accept SKIP_WAITING from the page. app.js posts this when the user
// taps the in-app update banner; it promotes a 'waiting' worker to
// 'active', which fires `controllerchange` on the page and triggers a
// clean reload.
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

// ── Activate: clean old caches ───────────────────────────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
            );
        })
    );
    self.clients.claim();
});

// ── Fetch: cache-first for static, network-only for API ──────────────────────
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // /regions/enabled is the one API endpoint we deliberately cache:
    // clients hit it on every "Start Report" tap to decide whether to
    // arm the auto-submit timer, and stale-while-revalidate keeps that
    // interaction usable even when the device is offline. Payload is
    // tiny + public — no privacy concern.
    if (event.request.method === 'GET' && url.pathname.endsWith('/api/v1/regions/enabled')) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                const net = fetch(event.request).then((response) => {
                    if (response && response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                }).catch(() => cached);
                return cached || net;
            })
        );
        return;
    }

    // May 2026 (perf Sprint C.3) — stale-while-revalidate on
    // `/api/v1/reports/nearby`. The home stage polls this every 60 s
    // (and again on every Visibility-Change resume); for warm users
    // the cached payload renders the "12 reports nearby · 3 areas
    // verified" number-block INSTANTLY while the background fetch
    // refreshes the cache. Pairs with the 90 s in-process backend
    // cache: a cold-start home-stage paint pulls from SW cache in
    // ~5 ms instead of ~250 ms (slow-4G round-trip). Payload is
    // already aggregated server-side (group ids + counts + crisis
    // type buckets — no individual reports), so the cached version
    // never reveals more than what the backend would have served
    // anonymously to the same lat/lng.
    //
    // Why endsWith vs startsWith: the path is
    // `/api/v1/reports/nearby?lat=...&lng=...&radius=...`. We match
    // by pathname (not href) so all (lat,lng,radius) tuples share the
    // same intercept rule, but `caches.match(event.request)` still
    // keys on the FULL URL — so a user who moves > 100 m gets a
    // separate cache entry rather than a stale-for-the-wrong-area
    // hit. SW cache LRU evicts the old entries over time; no manual
    // pruning needed at our payload size.
    if (event.request.method === 'GET' && url.pathname.endsWith('/api/v1/reports/nearby')) {
        event.respondWith(
            caches.match(event.request).then((cached) => {
                const net = fetch(event.request).then((response) => {
                    if (response && response.ok) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                    }
                    return response;
                }).catch(() => cached);
                return cached || net;
            })
        );
        return;
    }

    // Other API calls: always go to network (don't cache submissions)
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    // ML model weights from TF.js model host (tfhub / jsdelivr / etc.) —
    // explicitly cache-first so offline capture can still run BlazeFace.
    const isMLAsset = RUNTIME_CACHE_HOSTS.includes(url.hostname);

    // Static assets: cache-first with network fallback
    event.respondWith(
        caches.match(event.request).then((cached) => {
            if (cached) return cached;
            return fetch(event.request).then((response) => {
                // Opaque responses (cross-origin, CORS-less) still get cached for ML
                // because the browser will replay them to the same CDN origin.
                if (event.request.method === 'GET' && (response.ok || (isMLAsset && response.type === 'opaque'))) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Offline fallback: return cached index.html for navigation
                if (event.request.mode === 'navigate') {
                    return caches.match(SW_BASE + 'index.html');
                }
            });
        })
    );
});

// ── Web Push: reporter feedback when their report's status changes ──────────
//
// The backend POSTs an encrypted payload to APNs / FCM / Mozilla
// autopush when a Report's status flips (RESPONDING / RESOLVED /
// FALSE_ALARM). The provider routes it to this SW even when the PWA is
// closed; we render a native notification.
//
// Payload shape (set by backend/app/services/push.py::_build_payload):
//   { title, body, tag, data: { report_id, status, url } }
//
// `tag` deduplicates: re-sending the same tag REPLACES the existing
// notification rather than stacking — important if an analyst flips
// a report's status multiple times in quick succession.
self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (_) {
        // Non-JSON payload (e.g. provider keep-alive) — fall through
        // with a generic title rather than silently dropping. Better UX
        // than a missed notification.
        payload = { title: 'CRISP', body: 'You have a new update.' };
    }
    const title = payload.title || 'CRISP';
    const opts = {
        body: payload.body || '',
        icon: '/mobile-app/src/assets/icon-192.png',
        badge: '/mobile-app/src/assets/icon-96.png',
        tag: payload.tag || 'crisp-update',
        // `renotify: true` makes the device buzz/sound even when a
        // notification with the same tag is already on-screen — desired
        // for a crisis-report status change because the user IS waiting
        // for that signal.
        renotify: true,
        data: payload.data || {},
        // Two action buttons surface on Android; iOS ignores them but
        // still renders the notification body. "View" is the default;
        // "Dismiss" is a no-op tap that the user might prefer over
        // swiping the OS notification away.
        actions: [
            { action: 'view',    title: 'View report' },
            { action: 'dismiss', title: 'Dismiss' },
        ],
    };
    event.waitUntil(self.registration.showNotification(title, opts));
});

// ── notificationclick: focus existing tab or open a new one ─────────────────
//
// When the user taps the notification, we want to land them on the PWA
// at the report's deep link. Behavior:
//   1. If a CRISP tab is already open, focus it (and navigate if URL differs).
//   2. Otherwise, open a new window/tab to the deep link.
// `event.action` is "view" / "dismiss" / "" (no action button tapped, just the body).
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    if (event.action === 'dismiss') return;

    const data = event.notification.data || {};
    const targetUrl = data.url || '/mobile-app/src/';

    event.waitUntil((async () => {
        const allClients = await self.clients.matchAll({
            type: 'window',
            includeUncontrolled: true,
        });
        // Prefer same-origin CRISP tabs.
        for (const c of allClients) {
            try {
                const u = new URL(c.url);
                if (u.pathname.startsWith('/mobile-app/')) {
                    await c.focus();
                    // Use postMessage so app.js can route to the report
                    // without a hard navigation. The handler is wired in
                    // app.js (search for 'NOTIFICATION_OPEN').
                    c.postMessage({ type: 'NOTIFICATION_OPEN', data });
                    return;
                }
            } catch (_) { /* malformed URL — skip */ }
        }
        // No matching tab — open a new one.
        if (self.clients.openWindow) {
            await self.clients.openWindow(targetUrl);
        }
    })());
});

// ── Background Sync: retry queued reports when online ────────────────────────
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-reports') {
        event.waitUntil(syncAllReports());
    }
});

async function syncAllReports() {
    let db;
    try {
        db = await openIDB();
    } catch (e) {
        console.log('SW: Could not open IndexedDB', e);
        return;
    }

    const items = await idbGetAll(db, 'pending-reports');
    if (items.length === 0) return;

    // Origin-aware backend host (matches app.js). On localhost dev the
    // page is served on :8080 with the backend on :8000, so swap port.
    // In prod the page and API share an origin behind nginx — use it
    // as-is.
    const _swHost = self.location.hostname;
    const _swIsLocalDev = ["localhost", "127.0.0.1", "0.0.0.0"].includes(_swHost);
    const apiBase = _swIsLocalDev
        ? self.location.origin.replace(/:\d+$/, ':8000')
        : self.location.origin;
    console.log(`SW: Syncing ${items.length} queued reports`);

    // If any active client (page) is open, wake its retry loop —
    // the page-side code owns the chunked-variant pipeline. The SW's
    // legacy single-PATCH path below only handles old-shape items
    // (no `photoVariants`); modern items get processed by the page.
    try {
        const clients = await self.clients.matchAll({ includeUncontrolled: true });
        const hasModernItems = items.some(it => it.photoVariants || (it.extraPhotosVariants || []).length);
        if (clients.length && hasModernItems) {
            clients.forEach((c) => {
                try { c.postMessage({ type: 'SW_SYNC_WAKE', count: items.length }); } catch (_) {}
            });
            // Don't return — still process legacy-shape items below.
        }
    } catch (_) {}

    let synced = 0;

    for (const item of items) {
        try {
            const stages = item.stages || {};
            let reportId = item.serverId || null;

            // Skip modern variant-shape items in the legacy path — they're
            // owned by the page's retry loop, which knows about deferred
            // tiers + per-chunk progress + reconciliation. Touching them
            // here would risk falsely marking stages.photo true before
            // every tier has actually landed.
            if (item.photoVariants || (item.extraPhotosVariants || []).length) {
                continue;
            }

            // Stage 1: Send metadata if not done
            if (!stages.meta && item.meta) {
                const res = await fetch(`${apiBase}/api/v1/reports/meta`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(item.meta)
                });
                if (res.ok || res.status === 201) {
                    const data = await res.json();
                    reportId = data.id;
                    item.serverId = reportId;
                    item.stages.meta = true;
                    await idbPut(db, 'pending-reports', item);
                    console.log(`SW: Meta synced for ${item.client_report_id} -> ${reportId}`);
                } else if (res.status >= 400 && res.status < 500) {
                    await idbDelete(db, 'pending-reports', item.client_report_id);
                    continue;
                } else { throw new Error(`Meta: HTTP ${res.status}`); }
            }

            // Need a server report ID for media stages
            if (!reportId) { continue; }

            // Stage 2: Send photo if not done
            //
            // BUGFIX May 2026 (operator-reported, real iPhone multi-photo
            // capture): the SW used to PATCH /attach for `item.photo`
            // (main only) and flip `stages.photo = true`. Extras in
            // `item.extraPhotos[]` were dropped on the floor, AND the
            // `stages.photo` flip caused the page's retry loop to skip
            // the photo stage entirely on next replay — orphaning every
            // extra. Now: if extras are present, we DEFER the photo
            // stage to the page entirely (the page's `_uploadLegacyPhoto`
            // iterates extras with distinct photo_group_id per photo via
            // /media/chunk). The SW still ferries meta + audio so a
            // background-fired sync can at least register the report
            // with the backend before the user reopens the PWA.
            if (!stages.photo && item.photo
                && (!Array.isArray(item.extraPhotos) || item.extraPhotos.length === 0)) {
                const res = await fetch(`${apiBase}/api/v1/reports/${reportId}/media/attach`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'IMAGE', resolution_tier: 'MEDIUM',
                        url: item.photo, file_size_bytes: item.photoSize || 0
                    })
                });
                if (res.ok) {
                    item.stages.photo = true;
                    item.photo = null; // free memory
                    await idbPut(db, 'pending-reports', item);
                    console.log(`SW: Photo synced for ${reportId}`);
                }
                // On failure, leave in queue — will retry next sync
            } else if (!stages.photo && item.photo && Array.isArray(item.extraPhotos) && item.extraPhotos.length > 0) {
                // Defer: page's _uploadLegacyPhoto handles main + extras as
                // distinct chunked uploads with per-photo photo_group_id.
                console.log(
                    `SW: deferring photo stage for ${reportId} — ` +
                    `${item.extraPhotos.length} extra photo(s) present; ` +
                    `page retry loop will handle multi-photo legacy path.`,
                );
            }

            // Stage 3: Send audio if not done
            if (!stages.audio && item.audioBlob) {
                const res = await fetch(`${apiBase}/api/v1/reports/${reportId}/media/attach`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        // Phase L (May 2026) — canonical SMALL (was LOW pre-L).
                        type: 'AUDIO', resolution_tier: 'SMALL',
                        url: item.audioBlob, file_size_bytes: item.audioSize || 0
                    })
                });
                if (res.ok) {
                    item.stages.audio = true;
                    item.audioBlob = null; // free memory
                    await idbPut(db, 'pending-reports', item);
                    console.log(`SW: Audio synced for ${reportId}`);
                }
            }

            // Check if all stages complete
            if (item.stages.meta && item.stages.photo && item.stages.audio) {
                await idbDelete(db, 'pending-reports', item.client_report_id);
                synced++;
                const clients = await self.clients.matchAll();
                clients.forEach(client => {
                    client.postMessage({
                        type: 'SYNC_SUCCESS',
                        client_report_id: item.client_report_id,
                        server_id: reportId
                    });
                });
            }

        } catch (err) {
            console.log(`SW: Sync failed for ${item.client_report_id}:`, err.message);
        }
    }

    if (synced > 0) {
        console.log(`SW: Fully synced ${synced}/${items.length} reports`);
    }
}

// ── IndexedDB helpers (service worker context) ───────────────────────────────
function openIDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open('crisp-offline', 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('pending-reports')) {
                db.createObjectStore('pending-reports', { keyPath: 'client_report_id' });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbGetAll(db, storeName) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readonly');
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbDelete(db, storeName, key) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

function idbPut(db, storeName, item) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(item);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
