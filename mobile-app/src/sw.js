// CRISP service worker — offline caching, background sync, and push delivery.
//
// Cache-bump policy: any change to STATIC_ASSETS or any precached
// resource MUST bump CACHE_NAME so existing installs evict their stale
// snapshot on the next activate. Without this, returning users keep
// serving the old build forever.

const CACHE_NAME = 'crisp-v159';
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

const STATIC_ASSETS = [
    SW_BASE,
    SW_BASE + 'index.html',
    SW_BASE + 'app.js',
    SW_BASE + 'places.js',
    SW_BASE + 'pii-blur.js',
    SW_BASE + 'image-variants.js',
    SW_BASE + 'blurhash.js',
    SW_BASE + 'building-select.js',  // UNDP §3.2 — building-footprint selector
    SW_BASE + 'auth.js',
    SW_BASE + 'install-prompt.js',
    SW_BASE + 'home-screen.js',
    SW_BASE + 'voice-readout.js',
    SW_BASE + 'v4-flow.js',
    SW_BASE + 'badge-studio.js',     // reward-system v2 Canvas composer
    SW_BASE + 'character-pack.js',   // reward-system v2 second pass — 8 hero SVGs
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
