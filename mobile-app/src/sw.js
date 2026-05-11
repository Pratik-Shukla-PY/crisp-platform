// ── CRISP Service Worker ──────────────────────────────────────────────────────
// Handles: offline caching, background sync, push notifications (future)

// Phase 4 (Apr 2026) bump: added image-variants.js to STATIC_ASSETS (was
// silently missing last cycle; first-load users got a stale app until the
// opportunistic fetch-handler cached it). Bump v5 → v6 so ALL existing
// SW installs evict the old snapshot on next activate.
//
// Apr 2026 audio-UX rewrite: v6 → v7. New stage-audio copy + bullet helper
// + example + mic-lang-hint + placeholder i18n changes in app.js + new CSS
// classes in styles.css. Existing installs must pick up all three together
// or the "TYPE_TEXT" fix will appear without the new bullets / example.
// Apr 2026 landing-screen rewrite: v7 → v8. Home screen now has impact
// metrics + single CTA + merged My Reports/Delete, plus new unified
// flow-progress bar on capture stages (replaces step-dots). Multi-file
// change (index.html + app.js + styles.css) so cache-bump is mandatory.
const CACHE_NAME = 'crisp-v114';  // v114 (May 2026): Phase 25 — bundled with Phase 24. Full 22-locale support (UN-6 + 9 UNDP tier-2 + 7 Indian sub-national); every locale JSON has 100% key coverage from en.json via scripts/build-locale-skeletons.mjs. New scripts: build-locale-skeletons, generate-i18n-worksheets, import-i18n-worksheet. UNDP submission workflow doc at docs/I18N-WORKFLOW.md. Picker overlay restructured into UN-6 prominent grid + 16-tile horizontal scroll carousel (unsupported tiles removed: German/Italian/Polish/Swahili/etc.). SUPPORTED_LANGS gate added so PH→tl no longer surfaces non-functional pill. RTL critical patches: .v4-header padding flip, 13 text-align left/right → start/end, chevron + back-arrow mirroring. v4-flow.js final i18n (Sending… / Stop recording / Record voice). Phase 24 wins retained: flag pill, LANG_FAMILY_FALLBACK, home Option-1 layout, env-validation guards, verify-env.sh.
// v113 (May 2026): Phase 24 — batched home redesign + safety guards. (1) Flag emoji in language pill: new LANG_FLAGS dict mirrors the picker overlay's per-locale flags (🇬🇧 EN, 🇮🇳 HI, 🇨🇳 ZH, 🇸🇦 AR, 🇫🇷 FR, 🇪🇸 ES, 🇷🇺 RU), pill now renders `<flag> CODE` instead of generic `🌐 EN`. (2) Auto-detect language refinement: persists detected ISO country to `crisp_lang_auto_country`; picker's suggested-row chip shows the detected flag; new LANG_FAMILY_FALLBACK table covers ~40 unmapped countries (East Africa → English, West Africa → French, Central Asia → Russian, SE Asia → English) via a regional-proximity hop BEFORE the final English default. (3) Home layout redesign (Option 1): install + voice icons relocated OUT of the brand row INTO the identity strip alongside device-ID + Newcomer chip (single horizontal grouping); brand row is now just logo + wordmark; impact card is always-rendered (no `hidden`) with `—` placeholders pre-load, fills the ~130 px dead zone that existed between the secondary row and the bottom-anchored channels grid. (4) Operator safety guards: backend refuses to start if MEDIA_BACKEND=s3 without AWS_S3_BUCKET/AWS_REGION (Phase 23 outage repro fix); scripts/verify-env.sh diffs .env.production against the required-vars manifest before `docker compose up`; TWILIO_PHONE_NUMBER ↔ TWILIO_FROM alias accepted in sms webhook; CLAUDE.md "Env-file safety" section documents the post-deploy operator checklist. New backend test_env_validation.py (6 tests). Phase 23.x wins (IVR multilingual menu, audio fallback, layered-proxy https fix) retained.
// v112 (May 2026): Phase 23.3.1 — Arabic language code arb→ar-XA hotfix. The Phase 23.3 welcome menu used `<Say voice="Polly.Zeina" language="arb">` (AWS Polly's MSA code), which Twilio's TwiML validator rejects. Twilio's behaviour on invalid TwiML: drop the entire response (caller hears NO audio at all, not even the English greeting that comes earlier in the same Gather). Changed to `language="ar-XA"` which matches the rest of the codebase's `_IVR_VOICES` map and is the value Twilio accepts for Zeina. Phase 23.3 wins (multilingual menu, audio-upload fallback) retained.
// v111 (May 2026): Phase 23.3 — multilingual welcome menu + audio-upload fallback. (1) Multilingual welcome menu: each "press N for X" line is now spoken in language X's own Polly voice (Joanna en-US for English, Aditi hi-IN for Hindi, Lupe es-US for Spanish, Lea fr-FR for French, Zeina arb for Arabic). A Hindi-speaking caller hears their option said in Hindi instead of every option in English. Gather timeout 5s → 6s to accommodate the longer multilingual prompt. (2) IVR audio upload hardening: the chunked uploader was silently returning False (no Media row created → no Play button on dashboard). Now captures the return value, logs success/failure with byte counts, and on failure falls back to the single-shot POST /reports/{id}/media endpoint with a `data:audio/wav;base64,...` URL — slower but robust for Twilio's ≤2 MB WAV recordings. The fallback uses the same magic-byte sniffer (_detect_audio_format) that single-shot images use, so the file lands as `<id>.wav` with audio/wav MIME and is playable in the dashboard's HTML5 audio element. Operators can grep "IVR location" / "IVR description" in backend logs to see upload status per call. Phase 23.2 _get_base_url fix retained.
// v110 (May 2026): Phase 23.2 — _get_base_url forces https for crisplabs.tech etc. Root cause: production has Twilio→ALB(https)→nginx(http)→backend; nginx's `proxy_set_header X-Forwarded-Proto $scheme` clobbered the ALB's X-Forwarded-Proto:https with its own nginx→backend scheme (http), so the backend emitted http://undp.crisplabs.tech/... in the Gather action + Redirect URLs. Twilio then refused to follow those mid-call → "An application error has occurred. Goodbye." after the welcome message. Fix: _get_base_url now pins HTTPS for `*.crisplabs.tech`, ngrok/cloudflare dev tunnels, regardless of the value that survived the proxy chain — still honours X-Forwarded-Proto for unrecognised hosts and stays HTTP for localhost. New unit test covers the multi-hop case (X-Forwarded-Proto: "https, http"), x-forwarded-host precedence, ngrok dev path, and the no-header fallback. Phase 23.1 wins (Redirect URL & vs ?, IVR secret persistence, Telegram universal-link) retained.
// v109 (May 2026): Phase 23.1 — IVR URL fix + Telegram universal-link. (1) IVR "An application error has occurred" on real-call: the welcome <Redirect> URL combined `?lang=` after a query string that already had `?sid=` (two `?` chars → RFC 3986 invalid → Twilio dropped the call). Switched to `&amp;lang=` so the Redirect actually fires. Also persisted IVR_WEBHOOK_SECRET to `/data/.ivr_webhook_secret` via a new `_resolve_ivr_secret()` helper so secret-rotation no longer happens on every backend rebuild — operators don't have to re-sync the Twilio admin URL after every deploy. New startup log line emits the secret's last 6 chars so the operator can confirm stability. (2) Telegram deep-link redirecting iPhone users with Telegram installed straight to the App Store: the iOS "Open in Telegram?" system sheet does NOT fire visibilitychange while it's pending, so our 1.2 s fallback timer tripped before the user could tap "Open". Switched _openTelegram from the iframe + scheme + timer chain to a single universal-link navigation (`window.location.href = https://t.me/<bot>?start=<token>`); iOS/Android handle the app-or-web routing natively, no false-positive store redirects. Phase 23 wins (device-hash token, IVR voice-to-map confidence chip, AI auto-extraction) retained.
// v108 (May 2026): Phase 23 — Telegram deep-link + IVR voice-to-map confidence. Tap-Telegram now attempts `tg://resolve?domain=crisp_crisis_bot&start=<32-hex-device-hash>` (native scheme); if Telegram isn't installed (no visibility flip after 1.2 s) we fall back to App Store / Play Store. The bot decodes the 32-hex `start` payload to a `PWA-<hex>` hash and stamps it on the Telegram session so the resulting Report's `device_hash` matches the PWA's anonymous device-hash → both channels' reports cluster under one identity without any login. IVR: caller country (Twilio FromCountry) auto-picks default language so silent callers in India hear Hindi prompts instead of always defaulting to English (10+ Spanish, French, Arabic countries also mapped). Geocoder confidence + source now flow through `_process_ivr_report` to the meta POST, persist on the new `locations.geocoding_confidence` (float 0-1) + `locations.geocoding_source` columns (Alembic 0015_geo_conf), and render as a green/amber/red `.dp-geoconf` chip in the dashboard detail panel. AI extraction (Claude → infrastructure_type/severity/crisis_type/damage_class) restored for IVR reports as a background task so admin no longer has to click "AI Assessment" manually. New backend tests: country→lang + confidence normalisation + full _process_ivr_report pipeline + Telegram /start token round-trip (4 tests). +1 i18n key (home_channel_telegram_aria) × 6 locales. Phase 22.2 wins retained.
// v107 (May 2026): Phase 22.2 — IVR re-enabled with operator-confirmed +16626768896. Operator confirmed the number is +1 662 676 8896 (US, Mississippi area code, same number that was previously committed but had been pulled in Phase 22 when the webhook 404'd from PROD). Wiring it back as LIVE — the tile renders as <a href="tel:+16626768896"> with the green border + brand-blue icon + live pip. i18n lede updated in all 6 locales: "Telegram and IVR are live. Other channels launching soon." Toast text: "{ch} coming soon — try Telegram, IVR, or the orange button above." Operator owns the call-routing on the Twilio side; the tile just dials the number cleanly. Phase 22.1 Telegram fix retained (@crisp_crisis_bot verified live).
// v106 (May 2026): Phase 22.1 — Telegram bot username corrected to crisp_crisis_bot. Verified via curl: t.me/crisp_crisis_bot resolves with a "Launch" button + custom OG title "CRISP Crisis Report" — confirmed real published bot (the old `crisp_undp_bot` was just a reserved username with the generic Send-Message button, which is why tapping it ended in Telegram's "this is not valid" mid-flow error). Channels lede + coming-soon toast text updated in 6 locales: "Telegram is live. Other channels launching soon." / "{ch} coming soon — try Telegram, or use the orange button above." IVR remains coming-soon — no working Twilio number is configured anywhere in the repo (.env.production.example has `TWILIO_PHONE_NUMBER=` blank, docs use the obvious placeholder `+14155551234`). Operators can wire IVR by setting `window.CRISP_CHANNELS = { ivr_phone: '+...' }` once a real number is provisioned. Phase 22 wins (every other channel coming-soon, audit 15/15 green) retained.
// v105 (May 2026): Phase 22 — functional audit fix. User flagged that tapping Telegram on the home "breaks in between, says this is not valid". Audit found that BOTH the Telegram bot webhook (/api/v1/telegram/webhook) AND the IVR webhook (/api/v1/ivr/webhook) return 404 on PROD — they're not deployed. The previous DEFAULT_CHANNELS marked telegram_bot:'crisp_undp_bot' and ivr_phone:'+16626768896' as LIVE, sending users to a Telegram contact page whose "Send Message" button hits an unreachable bot (Telegram then shows the "not valid" error mid-flow). Phase 22 marks every channel as empty-string → "Coming soon" toast until operators wire real backends via window.CRISP_CHANNELS override. The orange in-app CTA (#btn-start → stage-v4-capture) remains the single guaranteed path. Channels lede + toast text updated in all 6 locales to set honest expectations. Comprehensive Playwright audit verified 15/15 home interactions work (CTA → capture, My Reports → history, Login → login, Privacy + Help → privacy, lang switcher → picker → switch to Arabic RTL, all 6 channel tiles → coming-soon toast, badge chip click safe, install icon click safe). Phase 21 wins (responsive sizing, no-scroll on all device profiles) retained.
// v104 (May 2026): Phase 21 — responsive home / fit-without-scroll. Per user: "Currently on my iPhone 14 I need to scroll for options. Should not require scroll. Make it responsive." Removed: hero subtitle "30-second anonymous report. Works offline, in 6 languages." Compact mobile-first baseline sized to fit iPhone 14 in Safari (≈660 px usable height with toolbars): CTA 56 px (was 64), secondary-cta 44 px (was 50), channel tile 78 px (was 104), section gap 16 px (was 28), .home-center padding 16 px (was 24). Height-based media queries scale up smoothly: ≥760 px → comfortable middle ground (CTA 60, tile 92, gap 22), ≥880 px → fully comfortable (CTA 64, tile 104, gap 26). Width media: ≤380 px tightens the gutter to 16 px for iPhone SE. Phase 20 wins (filled page, footer pinned via margin-top:auto) retained.
// v103 (May 2026): Phase 20 — declutter pass. Per user direction "We can get rid of these 2 and make the UI further clean. Add padding between all elements and fill the page": removed the amber safety hint and the "How CRISP works" 3-step strip from the home. Increased vertical rhythm gap from 16 → 24 px between sections, bumped CTA height 56 → 64 px (font 1.25 → 1.35 rem), secondary-cta min-height 44 → 50 px, channel-tile min-height 76 → 92 px with bigger 26 px icons. Footer now uses `margin-top: auto` to absorb leftover vertical space so the page never has a dead gap in the middle. Phase 19 typography/spacing discipline retained.
// v102 (May 2026): Phase 19 — professional CSS pass on the home stage. Per user feedback "Current UI is not good to submit" and "the CSS is super messy". New: hero subtitle below the CTA carries the value-prop ("30-second anonymous report. Works offline, in 6 languages."), 3-step "How CRISP works" strip (📷 Snap → 🏷 Classify → ✉ Send) fills what was empty whitespace in Phase 18, restyled live-impact strip (compact, restrained, sits between how-it-works and channels). Layout cleanup: uniform 20 px horizontal edge padding everywhere, strict 8 px spacing scale (4/8/12/16/20/24), removed `margin-top: auto` on the channels section (was creating a 300 px empty gap mid-page), tighter visual rhythm. Top-bar action icons (install + voice) now anchor at right:168 (was right:158) for a guaranteed 12 px gap from the lang pill; visible icon disc is 38 px with a 44 px hit area (WCAG 2.5.5 still satisfied). Channel tiles drop the 1:1 aspect-ratio constraint for a friendlier 76 px min-height. Logged-in users get personalised greeting + recent-reports (how-it-works + hero subtitle hidden because they already have context). +5 i18n keys × 6 locales. Phase 18 wins still in.
// v101 (May 2026): Phase 18.1 — a11y hotfix. Bumped the new top-bar install/voice icons from 32×32 → 44×44 and the My Reports / Login secondary-cta from ~37 → ≥44 px height to satisfy WCAG 2.5.5 / Apple HIG tap-target gate (40-axe-a11y.spec.ts:154 was failing with 7 offenders; threshold is ≤5). No layout drift on the lang-switcher cluster — still fits left of the lang pill.
// v100 (May 2026): Phase 18 — home polish + Privacy/Features page. Removed: "Why CRISP" trust card (moved to new stage-privacy), "Works offline" footer (redundant), standalone hero title (merged into the CTA which now reads "Report an Incident"). Added: persistent PWA-install icon + voice-readout button in the top bar (UNDP rubric Q3 voice-first for low-literacy), gamification badge chip (Newcomer/Helper/Guardian/Champion/Hero from `/reports/profile/<hash>`) beside the device-ID, "My Reports (X)" inline count, safety disambiguation hint ("Life-threatening emergency? Call local emergency number first…"), utility footer (Privacy · Open source · Help · version). Channel grid reverted to 3×2 for label readability. Greyer disabled-channel tiles. New stage-privacy with 7 sections: Why CRISP / What we collect / What we never collect / Your rights / Open source / How it works / Multi-channel parity — reachable from utility footer + Settings + dropdown. +50+ i18n keys × 6 locales. Phases 1-17 wins still in.
// v99 (May 2026): Phase 17 — landing page professional polish. Bigger brand block (logo glyph in coloured tile + wordmark + tagline) replaces the small chip. Hero title 26→30 px centred so it anchors better against the giant orange CTA. Channels section moved to BOTTOM of the home via margin-top:auto, single 6-tile row: Telegram / WhatsApp / SMS / IVR / Android / iOS. Working channels = green border + brand-coloured icon + green live-pip; non-working = grey border + grey icon + tap shows "{ch} coming soon — try Telegram or IVR for now" toast. Q1 hide-when-empty contract REVERTED per product direction: every channel always renders. Get-the-app section removed (Expo Go dropped). +2 i18n keys × 6 locales. Phases 1-16 wins still in.
// v98 (May 2026): Phase 16 — My Reports audit fixes. (S1) Backend `_thumb_url` now rewrites `s3://...` to the stable `/api/v1/reports/media/<id>/thumb` route — fixes 100% of PROD users seeing the camera-placeholder instead of their photos. (S2) PWA `window._resolveMediaUrl` helper at all 3 thumbnail call-sites surfaces a placeholder cleanly on any future regression. (S2) Phase-9 mini-map + Phase-10 M6 map-view both fixed — read `latitude`/`longitude` from backend, not `lat`/`lng`. Eager-load Leaflet via newly-public `BuildingSelect.ensureLeaflet`. (S2) rd-photo now has an `onerror` placeholder swap (was surfacing the literal "Report photo" alt-text on broken URLs). (S2) Filter chip auto-scrolls into view on selection so users actually see which filter is active on 390 px screens. (S3) Legacy `<details class="history-advanced">` removed from stage-history; "Delete all my reports" relocated into stage-settings. (S3) Card title now 2-line clamp instead of nowrap+ellipsis. (S3) stage-history header padding. New backend pytest pin: status-since never returns `thumbnail_url.startswith('s3://')`. Phases 1-15 wins still in.
// v97 (May 2026): UI v3 redesign Phase 15 — unified landing + branded channel tiles. (1) Welcome overlay + device-ID disclosure overlay both deleted from index.html; their content folded into a single always-on stage-home with a state-adaptive identity bar (anonymous → CRISP-XXXX-XXXX badge with copy/info + one-time tooltip; logged-in → account pill + dropdown menu with My Reports / Settings / Logout). (2) `_generateDeviceIdIfMissing()` runs unconditionally at boot, fixing users who bypassed the home (Telegram deep-link). (3) Logged-in users now see a personalised greeting + recent-reports block (top 3 cards from AuthStore.meReports() with device-hash fallback, sessionStorage cached). (4) Bottom reporting channels are now branded `.home-channel-tile` elements: WhatsApp green, Telegram blue, IVR info-blue, SMS neutral, Expo Go CRISP-orange — 5 brand tokens × (fg / soft / edge) wired via per-tile `--c` custom property; FontAwesome 6 brand glyphs (OFL-licensed) preserved. Hero copy expanded for consent. ~17 new i18n keys × 6 locales. SW cache bumped to evict v96 clients with stale identity-bar markup. Phases 1-14 wins still in.
// v96 (May 2026): UI v3 redesign Phase 14 — proposal-vs-actual delta closeout. (B) Dark theme by default — `:root` tokens swapped to proposal §7 (#07090e bg, #f97316 accent, #f1f5f9 text, etc.); body uses the proposal's aurora gradient; light-mode override removed. (C) Capture page rebuilt: "Show what you see." hero + lede, 3-equal-mode grid (📷 Photo · 🎙 Voice · ✏️ Type) with sub-text on each tile, captured-strip moves to capture (was on review by mistake), Voice/Text drawers slide in beneath grid. Continue enabled when ANY modality has content. (D + E) Classify split into 3 sub-views — `_classifyStep` drives sub-view visibility: damage = 3 vertical option cards w/ shape badge + sub-text, infra = 2-col 8-tile grid w/ plain-language labels + sub-text + auto-advance, crisis = 3 progressive cause cards (Natural / Technological / Human-made) → drill-down sub-types list. Sub-step label updates dynamically; new `crisp-i18n-applied` event lets dynamic labels re-render after async JSON load. v4-stage gets `grid-template-columns: minmax(0, 1fr)` to stop the 3rd capture-grid tile clipping. ~30 new i18n keys × 6 locales (parity OK). Phases 1-13 wins still in.
// v95 (May 2026): Delta-A i18n fix — _loadLocaleJson no longer short-circuits English. Every key added since Phase 2 (welcome overlay, device-id, M3 UNDP details, M9 landmark fallback, M4 success impact, M5 ETA, M6 filters, Q10 captured strip, M2 fullscreen picker — ~88 keys) lives only in en.json; the inline I18N.en pack drifted out of parity. Removing the early-return lets en.json merge into I18N.en on activateLang('en'), same path as every other locale. Existing key-resolution policy unchanged for non-English locales. Phases 1-13 wins still in.
// v94 (May 2026): UI v3 redesign Phase 13 — M2 polish: fullscreen building-picker + sliding bottom sheet. UNDP must-have #6: the inline #building-map (260 px) is cramped in dense urban areas where 30+ polygons overlap. New CTA pill ("Open fullscreen picker") inside #building-select-box lifts the existing #building-map into a viewport-filling overlay. Leaflet instance follows via appendChild + invalidateSize; no double-init. Bottom sheet slides up on polygon tap with name + Confirm/Cancel actions. Listens for new crisp:building-selected / crisp:building-cleared CustomEvents emitted by building-select.js's _commitSelection / _clearSelection. Cancel reverts any in-overlay selection back to the snapshot taken at open; Confirm just closes (selection already committed to state by the polygon click). Esc-key closes too. Inline picker still works as fallback. +5 i18n keys × 6 locales. Phases 1-12 wins still in.
// v93 (May 2026): UI v3 redesign Phase 12 — Q10 multi-modal "captured" strip on stage-v4-review. Three chips above the summary card show photo / voice / text status — green when captured, grey when not. UNDP rubric Q3 wants additive capture; this makes the additive nature visible. Photo-chip tap → back to stage-v4-capture. Voice/Text taps → open the v4-voice-drawer + scroll-into-view + focus the relevant control. State refreshes on stage-entry, after recording stops, and on every textarea keystroke. +5 i18n keys × 6 locales. Phases 1-11 wins still in.
// v92 (May 2026): UI v3 redesign Phase 11 — M10 custom Lucide-style SVGs for the four crisis types FontAwesome handled awkwardly. Tsunami (was generic up-arrow water) → wave with crest over ripples. Wildfire (was a single flame visually identical to explosion) → flame above ground line. Conflict (was a half-shield) → crossed swords. Chemical (was a flask) → hazard triangle with center dot. SVG-render path added to v4-flow's _initChipGrid so any option whose value matches the override map renders inline SVG instead of <i>. 22 px box, 2 px stroke + round caps to match the existing Lucide pack. Other 5 crisis types still use FontAwesome (no behaviour change). No i18n changes. Phases 1-10 wins still in.
// v91 (May 2026): UI v3 redesign Phase 10 — M6 My Reports overhaul. (a) Filter chip row above the list: All / In review / Accepted / Help sent / Rejected. State derived from reviewer_verdict + status + help_dispatched_at. Chips scroll horizontally on narrow screens. (b) View toggle on the right: list ↔ map. Map view renders all (filtered) reports as Leaflet markers with auto-fitBounds; tap marker → openReportDetail. Empty-state when no coords. (c) Group-by-date sub-headers within the list: Today / Yesterday / This week / Older — counted ("Today · 3"). Filter + view reset to defaults on every fresh entry. +10 i18n keys × 6 locales. Phases 1-9 wins still in.
// v90 (May 2026): UI v3 redesign Phase 9 — M5 tracking enhancements on stage-report-detail. (a) Active-pulse on the most-recently-completed timeline step (purple ring, 2s loop, reduce-motion opt-out). (b) ETA badge to the right of the status chip — heuristic-based ("Awaiting review · ~30 min" / "Under review · ~1 h" / "Help being arranged · ~1-3 h" / "Help on the way · soon"); hidden when terminal (resolved/rejected). (c) 130 px Leaflet mini-map under the photo with marker, lat/lng caption — auto-hides when no coords or Leaflet unavailable. +4 i18n keys × 6 locales. Phases 1-8 wins still in.
// v89 (May 2026): UI v3 redesign Phase 8 — M4 submission success motion + community-impact strip. On stage-success: (a) ripple ring expands once from the heart (1.5s), (b) 6 confetti dots float up with staggered delays + per-dot colours (red, green, amber, purple, cyan, pink) — 1.4s, (c) green pill below the headline reads "Your 4th report — thank you!" sourced from the auth-free /reports/profile/<device_hash> endpoint with English-style ordinal helper. First-time reporters see "Your first report — thank you for stepping up." Reduce-motion users get heart-pulse only (CSS opt-out). +2 i18n keys × 6 locales. Phases 1-7 wins still in.
// v88 (May 2026): UI v3 redesign Phase 7 — M9 landmark fallback when GPS fails. UNDP nice-to-have #4: on stage-where, when state.gpsErrorCode is set AND we have no usable coordinate AND no manual location name, a yellow warning banner appears between auto-meta and the v3-slot. 6 quick chips (🏥 Hospital · 🏫 School · 🏪 Market · 🛣 Main road · 🕌 Religious site · 📍 Other) pre-fill the existing #input-loc-search with "Near <X>" and focus the input. PositionError codes mapped to semantic strings (denied/unavailable/timeout/no-support/insecure-context). Telemetry beacon on chip-tap (best-effort, never blocks). +9 i18n keys × 6 locales. Existing GPS resolution path unchanged; banner self-hides when coordinates resolve mid-stage. Phases 1-6 wins still in.
// v87 (May 2026): UI v3 redesign Phase 6 — M3 dedicated UNDP-details Step 4 page (post-submission soft prompt). On stage-success after every successful submit, a discreet "Add 4 quick details · 30 sec" CTA appears (hidden if user already filled debris/services during v3 or v4 capture flow — Q14 dual-shape detection). Tap routes to new stage-undp-details with 5 modular Appendix-1 questions: Power supply (5-level status row), Water (4-level), Health services (4-pill row), Debris Y/N, Pressing needs (multi-select chips). Each card has a 44px coloured circle icon header (orange/cyan/pink/amber/green). On Save, PATCHes /reports/{id}/classify with debris_clearing_needed + service_status (reuses existing endpoint, no backend churn). +35 i18n keys × 6 locales (parity check passes). Phases 1-5 wins still in.
// v86 (May 2026): UI v3 redesign Phase 5 — M7 voice readout (Flag-4 approved). New voice-readout.js module: 🔊 button auto-attached to every [data-voice="<i18n-key>"] element. Tap reads question aloud in user's language via Web Speech API + device-local TTS voices (works offline). Wired to v4 capture-flow question titles (How bad / What was hit / What caused it). Pulses while speaking. Hidden when SpeechSynthesis unavailable. Pre-cached in STATIC_ASSETS for offline use. Phases 1-3 wins still in.
// v63 (Apr 2026): fix stage-where location-display mismatch (top "LOCATION (AUTO)" vs lower "Locating..." showed different cached vs fresh values). Centralised paint helper _paintLocationDisplays() called from every state.locationName mutator.
// v62 (Apr 2026): Web Push for reporter feedback — adds push + notificationclick handlers in this SW. Bump forces stale clients to pick up the new SW so push delivery works on first install.
// v61 (Apr 2026): UNDP §3.1e — extract 7 hardcoded English toast strings to t() keys + translate to all 6 locales.
// v60 (Apr 2026): Noto Sans Arabic + Noto Sans SC added to Google Fonts URL — proper CJK + Arabic glyph rendering for UNDP locales (was falling through to inconsistent device system fonts).
// v59 (Apr 2026): Safari blank-tiles fix — back out parent transform, add canvas renderer + 500ms re-invalidate
// v54 (Apr 2026 — login UI polish). Fixes raw i18n keys showing on
// stage-login when the JSON pack hadn't re-fetched yet (all login_*
// keys now live in the inline I18N.en dict so they render immediately
// even during a service-worker cache transition). Also tightens the
// form layout — centered card, compact country-code dropdown, proper
// box-sizing so the phone field never spills past the right edge.
// v53 (Apr 2026 — Optional reporter login, Phase 1).
//   - New auth.js module (AuthStore singleton + IDB storage).
//   - New stage-login (3-step OTP wizard) + stage-settings (Logout).
//   - Landing page: Login / Sign up tertiary button + account pill
//     when logged in + ⚙ Settings entry.
//   - Queue tagging: every queued report now captures `auth_token` at
//     enqueue time so offline replay submits under the logged-in user.
//   - Strong logout revokes all server-side refresh tokens.
//   - 30-day offline grace — UI stays "logged-in" when GPS/network drop,
//     submit still works, server silently strips expired auth to anon.
// v52 (Apr 2026 UI v3 / Phase B4 — Apr-23 spec align).
//   - Stage 2: auto date/time panel + building picker MOVED here from crisis.
//   - Stage 3: 8 UNDP super-types replace 9 legacy chips.
//   - Stage 4: crisis chips grouped into 3 UNDP categories.
//   - Stage 5: debris Yes/No toggle (re-added); severity chips dropped
//     — severity auto-derived from damage class.
//   - Stage 6: single Add-more button opens OS native sheet
//     (Camera + Library + Files).
//   - Stage 7: live-transcript + description textareas merged; Web Speech
//     API wired with state.speechCode (device-language transcription;
//     graceful plain-textarea fallback when API unavailable).
// v51 (Apr 2026 UI v3 / Phase B4) — full 8-stage capture flow reorder.
//   - 4 new stages: where (location+damage) / infra / crisis / extras.
//   - migrateV3Blocks reparents input blocks out of stage-review.
//   - stage-review collapses to a single "summary + submit" page.
//   - 7-segment progress overlay replaces the 5-dot bar when v3 is on.
//   - btn-start lands on stage-where; legacy flow untouched via flag.
// v50 (Apr 2026 UI v3 / Phase A2) — auto-submit firing fix.
//   - Region cache: 24 h → 10 s mem TTL (still 24 h persisted for offline).
//     Dashboard-flipped regions now propagate on next stage transition.
//   - InactivityManager.tryArm() gated on hasMinimumInput() so the T=0
//     handler never hits the silent "no input → toast → skip" path.
//   - Diagnostic chip (bottom-right) surfaces region/arm state for field QA.
// v49 (Apr 2026 UI v2.1) — UNDP Appendix-1 pressing-needs expanded
// from 5 → 10 chips. New i18n keys: need_cash, need_livelihoods,
// need_wash, need_basic_services, need_protection, need_local_support,
// need_other (244 keys × 6 locales). Legacy `security` value retained
// as a client alias for backward compat with pre-v2.1 offline queues.
// v48 (Apr 2026 UI v2.1) — i18n leak sweep on stage-review confirm
// card + stage-history impact card. Raw enum values (FLOOD / ROAD /
// MODERATE / DISRUPTED / etc.) were bleeding English through a
// translated chrome; now routed via a local `tEnum(raw, kind)` helper
// into the same inline I18N dict already keyed by `flood`, `road`,
// `moderate`, `partial_damage`, `working`, `disrupted`, etc. Two new
// keys `mr_resolved` + `mr_lives_impacted` added across every locale
// (inline + JSON). My-Reports stat tiles now carry `data-i18n` so
// applyI18n() picks them up on language change.
// v47 (Apr 2026 UI v2.1) — Building selector now posts the OSM name
// tag ("City Hospital", "Aishwarya Apartment") to the backend, not
// just the numeric way ID. Auto-fills `infrastructure_name` so the
// web-dashboard admin sees a human-readable label beside the building-
// history pill. building-select.js commit/clear logic updated; the
// selected-pill renders the name inline for reporter confirmation.
// v46 (Apr 2026 UI v2.1) — UNDP building-footprint selector flattened
// from <details>/<summary> to <section>. building-select.js rewired to
// listen for `review-page-changed` + `gps-ready` + stage-entered
// custom events instead of the now-absent `toggle` event. New waiting-
// for-GPS placeholder + matching i18n key `building_waiting_gps` in
// all 6 locale packs. Bump so clients evict the old building-select.js.
// v45 (Apr 2026 UI v2.1) — Service-status section flattened from a
// collapsible <details>/<summary> to an always-visible <section>. Pure
// HTML + CSS change in index.html + styles.css; no new assets to add
// to STATIC_ASSETS, just a bump so clients evict the stale bundle.
// v44 (Apr 2026) UI v2 rewrite. Adds components/icon-pack.js to
// STATIC_ASSETS (shared Lucide-derived SVG pack for the stage-review
// chips). index.html gains an ES-module script tag that loads it
// before app.js; app.js carries the new 3-page stage-review split +
// feature-flag gate; styles.css adds chip icon colour vars + the
// sticky header + language-picker ISO fallback. Multi-file change,
// so existing v43 clients must evict-and-refetch together.
// v43 (Apr 2026) Phase-1 progressive-upload stack. New vendored blurhash.js
// (compact DCT encoder/decoder) is pre-cached + loaded before image-
// variants.js. image-variants.js bumped to v3 — now returns a blurhash
// string alongside the SMALL/MEDIUM/LARGE variants. app.js bumped to
// v=840 — threads blurhash into the meta POST payload, mid-upload
// re-probe with hysteresis, per-device bandwidth cache in localStorage.
// v42 (Apr 2026) Capture-flow responsiveness fix — the Next button + shutter
// felt "sticky" for 300–800 ms after each photo because the BlazeFace +
// variant pipeline ran synchronously on the main thread, starving touch
// events. Now the 5 `_trackBlur(...)` call-sites defer via a new
// `_runWhenIdle(...)` helper (requestIdleCallback + setTimeout fallback)
// so the browser paints the enabled button + handles taps BEFORE the TF
// work starts. Pipeline unchanged; only WHEN it starts moved from
// "immediately" to "after the next idle tick".
// v41 (Apr 2026) Locale-bootstrap hotfix — fixes two pre-existing bugs
// that made manual Arabic/Urdu/Hebrew/French/Spanish/Russian/Chinese
// selections silently revert to English on every reload:
//   (1) narrow locale gate (`I18N[code]` check rejected UN + RTL-only
//       locales because I18N only carries en/kn/hi/ta)
//   (2) window.I18N undefined (classic-script const doesn't attach to
//       window in Chromium; tests + dashboard embed couldn't read it)
// New regression spec: e2e/tests/pwa/19-locale-bootstrap.spec.ts (10
// cases). PWA matrix: 73 → 88 passed.
// v40 (Apr 2026) Post-submit state-clear fix — previously `resetApp()`
// only ran from the "Add another report" button, so users who navigated
// back to home by any other route saw the previous report's photo + text
// bleed into the new capture. Now state is cleared at submit-success, so
// every downstream route to a new capture starts from a clean slate.
// v39 (Apr 2026) PII-blur hardening (Fixes A+B+C+D).
// Field test revealed the client hardcoded `client_blur_applied: true`
// even when BlazeFace failed silently — PII could reach the dashboard
// unblurred on both client AND server. Fix A threads the truthful
// blur result through pii-blur.js → image-variants.js → app.js so
// every chunk reports the actual outcome. Backend fixes (B/C/D) live
// server-side: /api/v1/health/pii probe, Media.pii_blur_status
// column, `pii_blur_runs_total{outcome}` Prometheus counter, loud
// error logs on missing MediaPipe/easyocr. Cache bump so v38 clients
// pick up the new pii-blur.js return shape + truthful upload flag.
// v38 (Apr 2026) Probe moved earlier + dynamic meta/text timeouts +
// in-flight de-dup guard. Field test at 2 Kbps hit a second bug: the
// v37 probe only ran before the chunk loop, but the meta+text stages
// used hardcoded 15 s / 20 s timeouts that blow up on dial-up. Moved
// `adaptTierViaProbe()` to the top of `trySendQueuedReport` so every
// stage sees the measured bandwidth. Replaced the fixed timeouts with
// `computeChunkTimeout(payloadSize, measuredBps)`. Also added an
// `_inFlightReports` Set guard to stop `startRetryLoop` from double-
// processing an item already mid-send (observed producing duplicate
// meta POSTs in the field test).
// v37 (Apr 2026) Adaptive bandwidth probe + dynamic chunk timeout.
// Fixes the "stuck at 0 chunks on a 2 Kbps throttle" bug: the tier
// detector trusted `navigator.connection.effectiveType` which Chrome
// DevTools throttling doesn't update. New `measureUploadBandwidth()`
// POSTs an 8 KB probe to `/reports/upload-probe` and picks tier from
// actual measured throughput. `computeChunkTimeout()` scales the XHR
// timeout per chunk so we never false-time-out a healthy upload on a
// genuinely slow link. `detectPWANetworkTier()` also falls to SLOW
// (not MEDIUM) when `downlink=0` is the only signal — Chrome's way of
// saying "I don't know the bandwidth". Cache bump so v36 installs
// evict and adopt the new probe path + dynamic timeout together.
// v36 (Apr 2026) UNDP §5 — binary-chunk transport (Option A).
// New upload path via `sendBinaryChunkWithRetry()` + `uploadChunksBinary()`
// in app.js. Multipart/form-data bypasses base64 encoding entirely —
// ~25 % wire savings, ~33 % less client RAM during capture, cleaner
// DB footprint (LargeBinary vs TEXT). Backend keeps the legacy
// `/media/chunk` endpoint for clients still on cached app.js; the new
// client auto-falls-back to base64 on HTTP 404 so a client-ahead-of-
// backend deployment degrades gracefully. Cache bump evicts v35 clients
// so everyone gets the new code path together with the new service
// worker — otherwise a v35 SW could intercept multipart requests and
// try to cache them, which is not behaviour we test for.
// v35 (Apr 2026) UNDP §3.1 picker UX — language picker split into two
// sections: 6 UN Official Languages with enlarged 3-column tiles at top,
// other locales in a compact 2-column list below. Parity change across
// index.html + styles.css + app.js (2 new i18n keys) + 6 JSON packs +
// crisp-mobile App.tsx. Cache bump needed because old SW clients would
// still render the single flat grid.
// v34 (Apr 2026) UNDP §3.1b — async locale-JSON loader.
//   • 6 new i18n/*.json files (en, fr, es, ar, ru, zh) precached on install
//     so offline captures in any UN language paint the full 232-key pack
//     from cache rather than falling through to the inline ~60-key EXTRA_LANG
//     baseline.
//   • app.js `activateLang()` now fires an async `_loadLocaleJson(code)`
//     after the sync first-paint; when the JSON resolves, merged on top of
//     the inline pack and `applyI18n()` re-renders with the richer strings.
//   • Bumping CACHE_NAME evicts v33 clients so the new async loader isn't
//     competing with a cached SW that lacks the JSON precache entries.
// v33 (Apr 2026): client-side PII blur perf + visual tuning.
//   • Radius: divisor 6 → 10, cap 120 → 60, min 12 → 6 px. Faces were
//     being over-smeared into unrecognisable blobs; lighter radius still
//     obscures identity but preserves context (silhouette, posture).
//   • Speed: blur layer now computed on a DOWNSCALED working canvas
//     (long side ≤ 800 px, scaling factor ~5× on 4K phone shots). Blur
//     is O(r²·area); 25× area reduction × lower radius = ~30× faster.
//     On a mid-range phone the post-snap freeze dropped from 3–8 s to
//     ~200 ms. Result is visually identical — blur is itself a low-pass
//     filter so downscale-blur-upscale is equivalent to full-res blur.
//   • Main-thread yield: blurFaces() now awaits a 0-ms setTimeout after
//     face detection but BEFORE the heavy paint pass. Any queued UI
//     events (e.g. user tapping Next on the already-visible preview)
//     dispatch immediately instead of waiting for the paint to finish.
// pii-blur.js-only change.
// v32 (Apr 2026): My Reports screen was rendering English on non-core
// locales (user reported Urdu UR still showing SUBMITTED / UNDER REVIEW
// / ACCEPTED / REJECTED / "WILDFIRE · HOUSE" / "20h ago"). Fixes:
//   (1) Card title enums (crisis_type · infrastructure_type) were
//       rendered as raw uppercase strings — replace_(/_/g, ' ') only.
//       Now passes through _translateEnum which looks up the lowercase
//       i18n key (e.g. WILDFIRE → t('wildfire')) and falls back to
//       titlecased raw value if the key is missing.
//   (2) "N lives" hardcoded in the card meta → now t('rd_people_helped_*')
//       with pluralisation.
//   (3) "Will be deleted when connected" hardcoded → t('rd_delete_queued').
//   (4) Full translation pack (in_flight, submitted, empty states,
//       rd_status_*, rd_tl_*, rd_meta_*, rd_people_helped_*, time_*_ago,
//       back) added to 11 locales: ur, es, fr, ar, zh, pt, ru, de, bn,
//       ja, ko. Previously these keys only existed in EN + KN + HI + TA.
// app.js-only change.
// v31 (Apr 2026): two fixes for the Confirm / review page in non-core
// locales.
//   (1) showReviewPage() was setting the title via a hardcoded English
//       array — `const titles = ['Details', 'Confirm']`. Non-English
//       users saw "Confirm" in English regardless of their locale.
//       Now resolved via t() against `review_details_title` (page 1)
//       and `confirm_title` (page 2). Both keys added to EN + KN + HI +
//       TA core dicts.
//   (2) Extended 10 major non-core locales (ur, es, fr, ar, zh, pt, de,
//       ru, bn, ja, ko) with the full Confirm-page key pack: section
//       titles (Incident/Details), Edit button, Needs/Debris labels,
//       Back button, enum values (wildfire/house/severe/complete/
//       unknown/etc.). Previously all these fell through to English via
//       the per-key t() chain because EXTRA_LANG entries were sparse.
// app.js-only change.
// v30 (Apr 2026): two image-pipeline changes user-requested.
//   (1) LARGE variant is now PASSTHROUGH — no canvas resize, no JPEG
//       re-encode. The raw captured bytes (post-PII-blur) ship directly
//       as the archival copy so responders can zoom in on fine detail
//       (license plates, structural damage) without resolution loss.
//       SMALL + MEDIUM still downscale for fast progressive delivery.
//   (2) When the client has already PII-blurred locally (BlazeFace on
//       PWA / piiBlur on RN), every chunk now carries
//       client_blur_applied=true. The backend persists the flag on the
//       media row and the assembler skips _run_server_pii_blur when set,
//       avoiding a second lossy re-encode over already-redacted pixels.
//       Legacy clients (no flag) still get the server-side pass as a
//       safety net.
// Multi-platform change: image-variants.js + app.js (PWA),
// imageVariants.ts + syncEngine.ts (RN), schemas/report.py +
// models/report.py + main.py (migration) + api/endpoints/reports.py.
// v29 (Apr 2026 hotfix): back button overlapping title icon on
// #stage-report-detail and #stage-history. .history-back was
// `position: absolute; top: 16px; left: 16px` — it stacked directly on
// top of the <h2>'s clipboard icon + "Report" title which occupied the
// same top-left position via the flex stage-header layout. Fix: remove
// absolute positioning, make the back button a real flex child with
// `order: -1` so it sits naturally on the LEFT of the title with an
// 8 px gap. Applied to both stages. styles.css-only change.
// v28 (Apr 2026 hotfix): "Add another report" button on the success
// screen did nothing — resetApp() was throwing on a stale DOM lookup
// (document.getElementById('photo-skip-link').style — but that element
// was removed in Phase 2 when photo became mandatory). The uncaught
// TypeError short-circuited resetApp before goToStage('stage-home')
// fired, so the user was stranded on the success screen. Fix: every DOM
// lookup in resetApp is now guarded (`if (el)`); stale IDs are no-ops
// instead of crashes. Also clears the multi-photo extras strip on reset
// and re-enables the helper text that gates Next on stage-photo.
// app.js-only change.
// v27 (Apr 2026): report-detail view was rendering English text even
// when Hindi/Kannada/etc was selected (user-reported). Every
// dynamically-rendered string inside renderReportDetail() (timeline
// labels, status chip, meta-grid labels, ACCEPTED feedback block,
// rejection default, delete-in-progress/queued notes, time-ago text)
// now goes through t(). Enum values (crisis type, infra type, damage,
// severity) also translate when a matching i18n key exists, with a
// titlecased fallback. applyI18n() re-invokes renderReportDetail on
// language change if the detail stage is active, so switching
// language while viewing a report updates instantly. ~35 new i18n
// keys across en/kn/hi/ta. app.js-only change.
// v26 (Apr 2026): image view + delete.
//   • ❌ badge moved from top-right → bottom-LEFT on every photo thumb
//     (per UX spec) and added to the primary photo thumb too.
//   • Tapping any thumbnail (primary or extra) opens a full-screen image
//     viewer with a Delete button → confirmation dialog.
//   • Quick-delete ❌ still works without confirmation (instant removal);
//     the viewer's Delete asks first to prevent accidental loss on the
//     larger touch target.
//   • Deleting the primary photo promotes the first extra (if any) so
//     the capture flow still has a mandatory photo; otherwise returns
//     to empty-state.
//   • Multi-file change (index.html + app.js + styles.css + RN App.tsx +
//     RN i18n.ts). 6 new i18n keys each on PWA + RN with kn/hi/ta
//     translations authored natively.
// v25 (Apr 2026): extended i18n coverage to the home-screen chrome
// strings that previously fell through to English on every non-EN
// locale — specifically `home_offline_hint` ("Works offline and in low
// internet connectivity"), `home_metric_reports`, `home_metric_lives`,
// `fp_photo`/`fp_details`/`fp_review`/`fp_send`, `my_reports`, and
// `home_title`. Native translations added across all 29 EXTRA_LANG
// locales (sw, fr, es, ar, ru, zh, pt, de, it, tr, uk, ja, ko, am, ur,
// ne, th, vi, id, ms, km, fa, my, pl, ro, so, si, he, el, bn, pa, ml,
// te, mr, gu) plus ta in the core I18N dict. Multi-file change
// (app.js + crisp-mobile/services/i18n.ts).
// v24 (Apr 2026): full-app i18n coverage sweep. Every user-visible
// string on both PWA and RN is now resolved through t() — previously
// ~30 hardcoded English strings (Recording status, Location detection
// messages, Summary card headers "Incident/Details", "✏️ Edit",
// "Debris clearing needed", service-status options, place-autocomplete
// empty state, delete confirmations, sync-badge labels, history empty
// states, "Report not found" toast, etc) stayed English regardless of
// the selected locale. Added ~40 new keys each to I18N.en + kn + hi +
// ta dicts; non-core locales fall through cleanly via per-key t() chain.
// applyI18n() now also re-triggers the JS-rendered chrome (sync-badge,
// history list, review-summary page) so dynamically-built HTML updates
// on language change. Multi-file change
// (index.html + app.js + crisp-mobile/App.tsx + i18n.ts).
// v23 (Apr 2026): language policy reverted. Detected local (GPS/IP)
// is once again the default active locale on first visit, unless the
// user has an explicit manual pick in localStorage['crisp_lang_manual'].
// Picker expanded from 14 → 29 languages. English remains first in the
// list. Rationale: UNDP crisis users are more likely native speakers of
// their region's language; defaulting to English added friction for
// low-literacy / distressed users. Multi-file change
// (index.html + app.js).
// v22 (Apr 2026 hotfix): connectivity probe was firing every 15 s
// unconditionally — 240 requests/hr per idle user. Reworked: probe only
// runs while the dot is red (navigator.onLine === false). On offline,
// a 30-s recovery loop detects reconnection and self-stops on the first
// successful response. On the happy path (browser reports online) we
// trust navigator fully and do ZERO idle polling. User-tap on the dot
// and tab-visibility-change still fire one-shot probes for the "Chrome
// lied" cases. app.js-only change.
// v21 (Apr 2026 hotfix): two orthogonal fixes shipped together because
// the same SW update eviction covers both.
//   (a) Device-hash mismatch: submit wrote the device id to
//       localStorage['crisp_device_id_v2'] but My Reports read from
//       'crisp_device_hash' / 'crisp_device_id'. Consequence: successfully
//       submitted reports never appeared in the user's "My Reports" list
//       because status-since was looking up the wrong hash. Fix: the
//       history lookup falls through to 'crisp_device_id_v2' first.
//   (b) Language UX rewrite: app now defaults to English on every load
//       regardless of detected region. GPS / IP detection still runs in
//       the background but only to surface a "📍 Your region: ಕನ್ನಡ"
//       suggestion inside the new full-language picker overlay (14
//       locales). One visible pill shows the active locale; click opens
//       the picker. User's manual choice is remembered in
//       localStorage['crisp_lang_manual'] so subsequent loads skip
//       English default if a choice was made. Multi-file change
//       (index.html + app.js + styles.css).
// v20 (Apr 2026 hotfix): full-app CSS overflow sweep. Language pill now
// shows 2-letter ISO codes ("🌐 EN" / "🌐 KN") instead of native-script
// names that wrapped to 2 lines and covered the progress bar. All flex:1
// containers with potentially-long i18n children got explicit
// `min-width: 0` so they can shrink without forcing their parent wider
// than the viewport. Category chips + severity chips + choice buttons
// + CTAs now ellipsize long labels. Flow-progress right-gutter enlarged
// to 150 px (140 px under 360 px viewports) so the Send step is always
// clear of the pill. Multi-file change (app.js + styles.css).
// v19 (Apr 2026 hotfix): "In Flight" list in My Reports was showing
// reports the server had already received. Root cause: one of four
// client-side stage flags (meta/text/photo/audio) never flipped true
// even though the upload succeeded — the IDB queue entry then stayed
// forever at N%. Fix: new _reconcileQueueAgainstServer() function
// dequeues any IDB row whose client_report_id appears in the server's
// status-since response (with expected_media vs received-media safety
// check to avoid dequeuing genuinely mid-upload items). Called from
// openMyReports() and from the 15s retry loop so stuck entries clean
// up without user intervention. app.js-only change.
// v18 (Apr 2026 hotfix): Confirm page layout was clipping content on
// narrow viewports / long i18n labels. Root causes: (1) .stage had no
// overflow-x:hidden so wide children bled sideways, (2) .review-nav-row
// children had no min-width:0 so the Submit button couldn't shrink,
// (3) .lang-switcher had no width cap and sprawled over the 4th step
// of the flow-progress bar. styles.css-only change.
// v17 (Apr 2026 hotfix): camera modal controls (X / 📸 / ✓) were being
// pushed off-screen on desktop Edge/Chrome because the flex layout gave
// the <video> element `flex:1` and the intrinsic video aspect ratio beat
// the flex-basis. Fix: video now fills the modal via `position:absolute;
// inset:0; object-fit:cover`, and the gallery + shutter row are absolute
// overlays pinned to the bottom with z-index:10. Multi-file change
// (index.html + styles.css).
// v16 (Apr 2026 hotfix): connectivity dot stuck red even when online.
// `navigator.onLine` lies in a handful of scenarios (captive portal,
// post-sleep resume, missed `online` event) so the dot now runs an
// active probe against /regions/enabled every 15 s and flips green on
// any successful response. Users can also tap the dot to force a
// re-check. app.js-only change so SW bump triggers the JS reload.
// v15 (Apr 2026 PR 7): success screen warmed — glowing heart + "Thank
// you. Your report can help save lives." + [+ Add another report] /
// [Track your report] buttons. Multi-file change (index.html + app.js +
// styles.css) so the new DOM, handlers, and CSS ship atomically.
// v14 (Apr 2026 PR 6): review-page redesign — damage level merged into
// the infra-chip row (inline severity picker), dropped building-name +
// debris toggle, crisis label reframed as "What caused damage?".
// Plus: z-index stacking fix for .flow-progress vs lang-switcher +
// new flag-picker overlay for English-region users. Multi-file change
// (index.html + app.js + styles.css) so SW update is mandatory.
// v13 (Apr 2026 PR 5): camera modal now multi-snap (mini-gallery + Done
// button); browse input is multi-select; blur-pending tracked as an
// array so parallel captures don't clobber each other. Multi-file
// change (index.html + app.js + styles.css) — DOM, JS, and CSS must
// ship atomically or snapshot thumbnails render unstyled.
// v12 (Apr 2026 PR 4): removed the "Type instead" skip link from
// stage-audio. Multi-file change (index.html + app.js) — the DOM node
// and the click handler must go together or users see a dangling
// `getElementById(...).addEventListener is not a function` crash.
// v11 (Apr 2026 PR 3): Lives Saved heart-pulse + 🟢/🔴 connectivity dot +
// "Works offline" hint on the home stage. Removed "Tap the button"
// sub-copy. Multi-file change (index.html + app.js + styles.css) so
// users must get the whole bundle atomically.
// v10 (Apr 2026 PR 1): fixes PWA `t()` fallback so missing locale keys
// fall through to English instead of rendering as raw UPPERCASE_KEY
// names. Adds 37 English values that were missing from I18N.en.
// v9 (Apr 2026): "My Reports" spec adds stage-report-detail + redesigned
// cards + individual delete with offline queue. DOM + CSS + app.js all
// change together; users need the full bundle to render the detail view
// so we force an SW update.

// Derive base path from SW's own URL (works regardless of where the app is served)
const SW_BASE = self.location.href.replace(/sw\.js$/, '');

const STATIC_ASSETS = [
    SW_BASE,
    SW_BASE + 'index.html',
    SW_BASE + 'app.js',
    SW_BASE + 'places.js',
    SW_BASE + 'pii-blur.js',
    SW_BASE + 'image-variants.js',   // Phase 4 — now pre-cached
    SW_BASE + 'blurhash.js',         // Phase-1 progressive: compact DCT
    SW_BASE + 'building-select.js',  // UNDP §3.2 — building-footprint selector
    SW_BASE + 'auth.js',             // Phase 1 (Apr 2026) optional reporter login
    SW_BASE + 'install-prompt.js',   // UI v4 (May 2026) — beforeinstallprompt + iOS sheet
    SW_BASE + 'home-screen.js',      // May 2026 — merged always-on home (replaces landing.js)
    SW_BASE + 'voice-readout.js',    // UI v3 (May 2026 Phase 5 / M7) — 🔊 button per question
    SW_BASE + 'v4-flow.js',          // UI v4 (May 2026) — 3-page capture flow + carousels + AI pre-fill
    // May 2026 — vendor/blazeface/model.json + .bin REMOVED from
    // pre-cache. They're loaded on demand by pii-blur.js::ensureModel
    // on first photo capture and runtime-cached by the fetch handler
    // below at that point. Pre-caching cost ~466 KB on every fresh SW
    // install for users who never reach the capture stage.
    SW_BASE + 'components/icon-pack.js',  // UI v2 — shared Lucide SVG pack
    SW_BASE + 'styles.css',
    SW_BASE + 'manifest.json',
    SW_BASE + 'favicon.svg',         // May 2026 — tab icon (also served at apex /favicon.ico via nginx alias)
    SW_BASE + 'assets/icon-192.png',
    SW_BASE + 'assets/icon-512.png',
    // UNDP §3.1b — dense 232-key translation packs, one per UN language.
    // Precached so offline captures render in any UN language even on a
    // cold install. `_loadLocaleJson()` in app.js fetches these lazily
    // on `activateLang(code)`; the SW cache-first handler serves them
    // from this cache without touching the network.
    SW_BASE + 'i18n/en.json',
    SW_BASE + 'i18n/fr.json',
    SW_BASE + 'i18n/es.json',
    SW_BASE + 'i18n/ar.json',
    SW_BASE + 'i18n/ru.json',
    SW_BASE + 'i18n/zh.json'
];

const EXTERNAL_ASSETS = [
    'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;600;800&family=Noto+Sans+Arabic:wght@400;600;700&family=Noto+Sans+SC:wght@400;600;700&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
    // May 2026 — TF.js + BlazeFace UMD REMOVED from pre-cache.
    // pii-blur.js::_ensureScripts() lazy-loads them on first photo
    // capture; the runtime fetch handler below caches them then. Saves
    // ~356 KB on every fresh SW install for users who never capture.
];

// Domains the runtime fetch handler should cache opportunistically so that a
// subsequent offline capture / map load still works.
const RUNTIME_CACHE_HOSTS = [
    'cdn.jsdelivr.net',
    'tfhub.dev',
    'storage.googleapis.com',  // where tfhub models are served from
    'www.kaggle.com',          // kaggle is the new tfhub host
    'unpkg.com',               // May 2026 Phase B — lazy-loaded Leaflet JS + CSS
];

// ── Install: pre-cache static shell ──────────────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            // Cache static assets first (critical), then external (best-effort)
            return cache.addAll(STATIC_ASSETS)
                .then(() => cache.addAll(EXTERNAL_ASSETS).catch(() => {
                    console.log('SW: Some external assets failed to cache (offline?)');
                }));
        })
    );
    self.skipWaiting();
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

    // Phase 4 (Apr 2026) — /regions/enabled is the ONE API endpoint we
    // deliberately cache. Clients call it on every "Start Report" tap to
    // decide whether to arm the 2-minute auto-submit timer; caching with a
    // stale-while-revalidate pattern keeps that interaction usable even when
    // the device is offline at the moment of capture. The response payload
    // is tiny + public so there's no privacy concern.
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
// Apr 2026 — UNDP scalability story. The backend POSTs an encrypted
// payload to APNs / FCM / Mozilla autopush when a Report's status flips
// (RESPONDING / RESOLVED / FALSE_ALARM). The provider routes it to this
// SW even when the PWA is closed; we render a native notification.
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

    // Apr 2026 — origin-aware backend host (matches app.js logic). On
    // localhost dev the page is served on :8080 with backend on :8000, so
    // we swap the port. In prod (https://undp.crisplabs.tech) the page
    // and the API share an origin behind nginx, so we use it as-is.
    const _swHost = self.location.hostname;
    const _swIsLocalDev = ["localhost", "127.0.0.1", "0.0.0.0"].includes(_swHost);
    const apiBase = _swIsLocalDev
        ? self.location.origin.replace(/:\d+$/, ':8000')
        : self.location.origin;
    console.log(`SW: Syncing ${items.length} queued reports`);
    let synced = 0;

    for (const item of items) {
        try {
            const stages = item.stages || {};
            let reportId = item.serverId || null;

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
            if (!stages.photo && item.photo) {
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
            }

            // Stage 3: Send audio if not done
            if (!stages.audio && item.audioBlob) {
                const res = await fetch(`${apiBase}/api/v1/reports/${reportId}/media/attach`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'AUDIO', resolution_tier: 'LOW',
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
