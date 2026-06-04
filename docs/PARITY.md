# CRISP — PWA ↔ RN Parity Checklist

**Purpose** — this is the canonical field order, labels, icons, and enum values
for the Review & Submit flow. PWA (`mobile-app/src`) and RN (`crisp-mobile`)
MUST match this document exactly. Any future PR that changes a field must
update this file and the other client in the same commit.

Last reconciled: Voice-page cleanup (PR 4) + Landing polish (PR 3), Apr 2026.

---

## Audio capture screen (stage-audio / screen === 'audio')

Rewritten Apr 2026 for low-literacy / crisis users. Must stay byte-identical
across PWA and RN — the same title, bullets, example, mic hint, placeholder,
and button label in every locale.

| Element | i18n key | English source |
|---|---|---|
| Title | `s2_title` (PWA) / `audio_title` (RN) | "Tell us what happened" |
| Subtitle prompt | `s2_sub` / `audio_sub` | "Speak or type:" |
| Bullet 1 | `audio_bullet_1` | "What is damaged? (house, road, people…)" |
| Bullet 2 | `audio_bullet_2` | "How bad is it? (small / big / destroyed)" |
| Bullet 3 | `audio_bullet_3` | "Is anyone hurt or in danger?" |
| Example | `audio_example` | "Example: Road is broken and water is flooding houses. 2 people are injured." |
| Mic label | `tap_mic` | "Tap and speak clearly" |
| Mic language hint | `audio_mic_lang` | "You can speak in your language" |
| Textarea placeholder | `audio_placeholder` | "Example: House collapsed, one person trapped" |
| Advance button | `next` (shared across photo / audio / review next-buttons) | "Continue" |

**Dropped:** the `transcript-label-row` chip that used to render "TYPE_TEXT"
(the `type_text` key had no translation anywhere and leaked through the
fallback). The textarea placeholder carries the instruction now.

**Dropped (PR 4, Apr 2026):** the "Type instead" skip link
(`#audio-skip-link` / `skip_audio` i18n key). Mic and textarea coexist on
the same screen — the toggle only added cognitive load without hiding
anything. Users who prefer typing just tap the textarea and continue.
RN never had this element, so removing it restores PWA ↔ RN parity.

---

## Landing screen (stage-home / screen === 'home')

Rewritten Apr 2026 for low-literacy crisis users. The old mental model ("4
easy steps") was conveyed by a 2×2 roadmap grid that looked clickable but
wasn't — confusing to first-time users under stress. That grid is gone.

| Element | Required | Notes |
|---|---|---|
| CRISP × UNDP badge | yes | Unchanged |
| Hero title (`home_title`) | yes | "Report an Incident" — simpler than before |
| Subtitle (`home_sub`) | no | **Removed (PR 3, Apr 2026)** — the big CTA speaks for itself, no step-count promise needed |
| Language switcher | yes | Now hosts the 🟢/🔴 connectivity dot as its first child (inside the switcher, not overlapping the viewport right edge at 320 px) |
| Connectivity dot (`#connectivity-dot` / inline RN view) | yes | 🟢 online / 🔴 offline — listens to `online`/`offline` events on PWA, NetInfo on RN. Visible on every stage |
| Impact metrics card | conditional | Shows **Lives Saved** (❤️ green-glow, heart-pulse animation) + **Reports Submitted** when numbers > 0. Lives Saved is the first cell (more emotionally salient); `prefers-reduced-motion` disables the pulse |
| Primary CTA (`start_btn` / `welcome_start`) | yes | **"Start Reporting"** — one and only one primary action |
| Secondary entry (`my_reports`) | yes | "My Reports" — opens history screen. Includes delete-all at the footer (was a separate link on home before) |
| Offline hint (`.home-offline-hint` / `home_offline_hint`) | yes | Subtle small-text line at the bottom: "📡 Works offline and in low internet connectivity." Home-stage only (capture flow stays minimal) |
| Gamification badge | optional | Demoted below the primary actions (RN only; PWA shows badge on success screen) |

**Removed:** 4-card roadmap (`.roadmap`), separate `Delete My Data` link
on home (moved to history screen footer), `home_sub` paragraph
(PR 3, Apr 2026 — "Tap the button when you're ready" dropped).

---

## Unified flow-progress bar (capture stages)

Apr 2026: replaces the per-screen step-dots / "1/4 2/4 3/4 4/4" text labels
with ONE color-coded progress bar shown throughout the capture journey.

```
 [ Photo ] —— [ Details ] —— [ Review ] —— [ Send ]
```

### State grammar (identical PWA + RN)

| State | Color | Glyph | Meaning |
|---|---|---|---|
| `done` | green 🟢 | ✓ | Past step, required data captured |
| `active` | accent 🟠 | ● | Currently on this step |
| `missing` | red 🔴 | ! | Past step but required data missing |
| `upcoming` | grey ⚪ | — | Future step |

### Stage → step mapping

| Internal stage | Flow step |
|---|---|
| `stage-photo` / `screen === 'photo'` | 1 (Photo) |
| `stage-audio` / `screen === 'audio'` | 2 (Details) |
| `stage-review` / `screen === 'review_details'` | 3 (Review) |
| `stage-send` / `screen === 'review_confirm'` | 4 (Send) |

**Data predicates** (drive the done/missing split):
- Step 1 (Photo) done when `photoDataUrl` / `photoUri` is set.
- Step 2 (Details) done when `audioBlob` / `audioUri` is set OR
  `description.trim()` is non-empty.
- Step 3/4 always considered "done" once passed.

**i18n keys** (English authoritative, core locales translated):
`fp_photo`, `fp_details`, `fp_review`, `fp_send`.

---

## Multi-image capture (PR 5, Apr 2026)

A report can carry multiple photos. The **first** photo fills the primary
slot (`state.photoDataUrl` / `photoUri`) and becomes the review thumbnail;
all subsequent photos land in `state.extraPhotos` (PWA) / `extraPhotos`
(RN) and are shown in the horizontally-scrolling "extras" strip on
stage-photo and the review screen.

### PWA behaviour
| Entry point | Behaviour |
|---|---|
| **Browse** (`#btn-browse-photo` → `#file-browse`) | `<input type="file" multiple>` — user selects any number; first fills primary (if empty), rest go to extras. |
| **Camera modal** (`#btn-open-camera`) | Live `getUserMedia` viewfinder stays open across snaps. Each tap of the shutter captures a frame without tearing down the stream. Thumbnails appear in a mini-gallery inside the modal. A green ✓ "Done" button (enabled after first snap) confirms + returns to stage-photo with all snaps attached. X cancels the modal; photos already captured remain in state. |
| **iOS camera fallback** (`#file-camera`) | Single-shot per invocation (Safari's native camera picker doesn't support multi-capture). Tapping the camera chip again adds another. |
| **"Add more photos" (+)** (`#btn-add-more-photo` → `#file-extra`) | Single-file picker; entry appended to extras. Pre-dates PR 5 and kept as-is. |

### RN behaviour
| Entry point | Behaviour |
|---|---|
| **Camera** (`takePhoto`) | expo-image-picker's `launchCameraAsync` returns one asset per launch. After each successful capture we show `Alert "Photo added ✓ — Take another?" [Yes / Done]` and loop the picker until Done. First capture fills primary, rest become extras. |
| **Library** (`pickImage`) | `launchImageLibraryAsync({ allowsMultipleSelection: true, selectionLimit: 10 })`. First asset fills primary (if empty), rest become extras. |
| **"Add more photos" (+)** (`pickExtraImage`) | Same multi-select; every asset lands in extras. |

### Known asymmetry — camera multi-capture

PWA uses the browser's live `getUserMedia` viewfinder so the camera stream
can stay alive across snaps and multi-capture feels like a native burst.
expo-image-picker in RN does NOT expose this — each `launchCameraAsync`
call opens a new native picker, captures exactly one frame, and returns.
The "Alert → Yes → picker re-opens" loop is the closest approximation.

A proper fix would require migrating to `expo-camera` (custom in-app
viewfinder component) — **explicitly out of scope** per the PR 5 plan.

### Blur-pending pipeline (bug fixed in PR 5)

Both platforms track in-flight variant/blur generation in a structure that
`submitReport()` awaits before reading blob state. Before PR 5:
- PWA used `state.photoBlurPending` as a single-slot promise — later
  captures clobbered earlier ones, so rapid multi-capture could submit
  before some blur/variants completed.
- RN used `blurPromiseRef` similarly (single slot).

PR 5 converts the PWA slot to an array (`state.photoBlurPending = []`
with a `_trackBlur(p)` helper + `Promise.all(...)` await). RN keeps the
single ref for the primary photo but matches extras entries by **object
identity** instead of stale index, so concurrent ingests can't corrupt
each other during multi-select ingestion.

---

### PWA implementation
- DOM: `#flow-progress` at `mobile-app/src/index.html` (outside all stages).
- JS: `updateFlowProgress(currentStage)` in `app.js`, called on every
  `goToStage()`.
- CSS: `.fp-step`, `.fp-done/.fp-active/.fp-missing/.fp-upcoming` in
  `styles.css`.

### RN implementation
- `<FlowProgress step={n} have={{ photo, details }} />` component at
  `crisp-mobile/App.tsx` (inline, no external stylesheet).
- Rendered at the top of each capture screen.

---

## Review page (PR 6, Apr 2026)

The capture-flow review form was restructured to reduce cognitive load —
the old linear list ("What is damaged? → Type of Crisis → Damage Level →
Building name → Debris → Service status") became a tighter two-question
layout with inline sub-selection.

### Field order

| # | Block | Notes |
|---|---|---|
| 1 | Photo preview row | Unchanged |
| 2 | Description | Unchanged textarea |
| 3 | **What is damaged?** | 9-chip grid; tapping a chip now reveals the inline severity picker (4a) below the grid. Re-tapping the same chip collapses the picker. |
| 4a | *Inline severity* (merged from old "Damage Level") | 3 dots: 🟢 No Damage / 🟠 Partial / 🔴 Destroyed. Default silent PARTIAL. Label updates with the selected infra name ("How bad? [Road]:"). |
| 4 | **What caused damage?** | Renamed from "Type of Crisis". Same 9-chip grid. |
| 5 | Location | GPS-resolved, user-editable (unchanged) |
| 6 | **Optional: Service status** (collapsible `<details>`) | Electricity / Water / Health dropdowns + Pressing Needs chips (unchanged content; summary relabelled). |
| 7 | Severity | How serious? (Minor / Moderate / Severe) — unchanged. |

### Removed blocks

- **Damage Level** standalone block (merged into 4a).
- **Building / Road Name** text input (`#input-infra-name`). `state.infraName`
  keeps its `''` default so the backend payload
  `infrastructure_name: null` stays intact.
- **Needs debris clearing** toggle (`#toggle-debris`). `state.debrisClearing`
  keeps its `false` default so `debris_clearing_needed: false` stays intact.

### CSS stacking fix

- `.flow-progress { z-index: 101; }` stacks above `#lang-switcher { z-index: 100; }` so the 🟢/🔴 connectivity dot can't clip progress labels at 320 px viewports.

### Language picker (PWA only for this PR)

- `#btn-lang-change` ("🌐") replaces `#btn-lang-en` when the detected local
  is English. Clicking opens `#lang-picker-overlay` with 5 flags: en, hi,
  kn, es, ar. The `#btn-lang-en` element stays in the DOM hidden via
  `display:none` because Playwright specs click it with `{ force: true }`.
- Picking a non-English flag promotes `#btn-lang-local` so the user can
  toggle between their chosen locale and English without re-opening the
  picker.
- RN already renders the full flag row on the home screen via
  `getAvailableLanguages()`; no parity overlay needed.

---

## Success screen (PR 7, Apr 2026)

The post-submit close-out was rewritten from a bureaucratic "Report Sent!
UNDP rescue teams have been notified" to a warmer, gratitude-framed
message with explicit two-path exit (start another report OR track the
just-submitted one).

### Layout (PWA + RN mirror)

| Element | Notes |
|---|---|
| Heart emoji (`❤️`) | Animated: scale 1.0 → 1.09 → 1.0 over 2 s; red drop-shadow glow. `prefers-reduced-motion` / `AccessibilityInfo.isReduceMotionEnabled()` disables the animation. |
| Title (`sent_title`) | "Thank you." |
| Sub (`sent_sub`) | "Your report can help save lives. We will keep you posted." |
| Report ID pill (`#report-id-text`) | First 8 chars of the client UUID (still useful for support-ops lookups). |
| Gamification badge | Unchanged; rendered below the ID pill when earned. |
| Primary CTA — **[+ Add another report]** | `#btn-new-report` / `<TouchableOpacity>` with `+`. Calls `resetApp()` (PWA) / `resetReport(); setScreen('home')` (RN). |
| Secondary CTA — **[Track your report]** | `#btn-track-report` / `<TouchableOpacity>`. PWA calls `openReportDetail(_lastSubmittedClientId)`; RN calls `setSelectedReport(synth); setScreen('report_detail')`. |

### Just-submitted cache synthesis

The status-since poll that normally fills `_submittedCache` (PWA) /
`history` (RN) hasn't fired yet when the user reaches success. Both
platforms synthesise a minimal row from capture state so the Track
button has something to show:

- PWA: `_synthesizeSubmittedReport(clientReportId, {})` in
  `mobile-app/src/app.js`. Testability hook:
  `window.__crispSynthesizeSubmittedReport`.
- RN: inline synthesis in the Track `onPress` handler —
  `setSelectedReport({ client_report_id: reportId, infrastructure_type,
  crisis_type, severity, damage_classification, ... })`.

Both rows carry `__synthetic: true` for debugging. The next poll replaces
them with the server-authoritative view.

### Deprecated (PR 7)

- `sent_title`: "Report Sent!" → "Thank you."
- `sent_sub`: "Rescue teams will see this..." → "Your report can help save lives..."
- `new_report` key kept for back-compat (deep-link flows may still
  resolve it); the UI renders `add_another_report` / `track_report`
  going forward.

---

## My Reports — individual report management (Apr 2026)

Full redesign per the "My Reports & Individual Report Management" spec.
PWA `stage-history` + `stage-report-detail` mirror RN `screen === 'history'` +
`screen === 'report_detail'`. List and detail views are byte-identical in
information architecture, field order, and interaction model.

### 4-state status mapping (verdict-first, canonical)

Two backend fields collapse into one user-facing state per the table below.
Implementation: `_mapReportStatus(r)` in `mobile-app/src/app.js` and
`mapReportStatus(r)` in `crisp-mobile/App.tsx` — MUST stay in lockstep.

| state          | color  | icon | selector                                                                |
|----------------|--------|------|-------------------------------------------------------------------------|
| `SUBMITTED`    | grey   | ⚪   | verdict=NOT_REVIEWED AND status != RESPONDING                           |
| `UNDER_REVIEW` | yellow | 🟡   | verdict=NOT_REVIEWED AND status=RESPONDING                              |
| `ACCEPTED`     | green  | 🟢   | verdict=ACCEPTED                                                        |
| `REJECTED`     | red    | 🔴   | verdict=REJECTED OR status=FALSE_ALARM                                  |

### List card (both platforms)

| Slot | Contents |
|---|---|
| Left 64×64 | SMALL photo variant (lazy loaded) OR placeholder icon |
| Title | `{crisis_type} · {infrastructure_type}` all-caps |
| Meta row 1 | 📍 location · 🕒 relative time · 💚 N lives (when > 0) |
| Meta row 2 | "🕒 Will be deleted when connected" (only when offline-delete queued) |
| Right chip | 4-state status chip (icon + label, colored per table above) |

Cards are tappable buttons — full-width hit target. Tap opens the detail view.

### Detail view (both platforms)

| Section | Notes |
|---|---|
| Header | Title "Report" + back button + top-right status chip |
| Timeline | 4 stops: Submitted → Under Review → Accepted/Rejected → Help Sent. "Help Sent" hidden on rejection branch. Each stop colors green (done) / red (rejected) / grey (upcoming) per timestamps on the record |
| Photo | Primary photo tile; tap opens lightbox (PWA) / native zoom (RN) |
| Description | Typed text or server-side Whisper transcript |
| Metadata grid | Location, crisis type, infra type, damage classification, severity |
| Feedback block (green, accepted only) | Auto-derived sentence from `deriveActionTaken(r)` + lives-impacted summary |
| Rejection block (red, rejected only) | Shows `action_taken` text when present; falls back to generic message |
| Delete row | Single "Delete this report" button OR "Deletion in progress" note OR "Will be deleted when connected" note (see states below) |

### "Action taken" derivation (shared logic)

`_deriveActionTaken(r)` / `deriveActionTaken(r)`:

```
if r.help_arrived_at          → ["Help arrived on scene"]
elif r.help_dispatched_at     → ["Help dispatched"]
elif verdict === "ACCEPTED"   → ["Accepted — awaiting dispatch"]
else                          → []

if verdict === "ACCEPTED" and action_taken.trim()
    → append action_taken
```

### Delete flow — tri-state

| UI state | When | What user sees |
|---|---|---|
| Normal | `!deletion_requested_at` and not queued | "Delete this report" red button |
| Deletion in progress | `deletion_requested_at` set | Info note: "Deletion in progress. Removed within 24 hours." |
| Queued (offline) | id is in the local delete-queue | Amber note: "🕒 Will be deleted when connected." |

### Offline delete queue

- PWA key: `localStorage['crisp_report_delete_queue_v1']` — array of `{id, clientReportId, queuedAt}`
- RN key: `AsyncStorage['crisp_report_delete_queue_v1']` — array of IDs
- Flushed on every `online` event + on app boot (2-second delay so the rest of init completes first)
- Retry semantics: HTTP 200/204/404 all dequeue; any other response leaves the entry to retry
- Deduplicated on `id` — safe to enqueue the same ID twice

### Bulk delete — hidden by default

"Delete all my reports" + its 24-hour note live inside a collapsed
`<details class="history-advanced">` (PWA) / `TouchableOpacity`-toggled
block (RN) at the bottom of the list. The spec's stance: individual
delete is the primary path; bulk is an advanced escape hatch.

### Backend contract additions (Apr 2026)

`GET /api/v1/reports/device/{device_hash}/status-since` now returns
per-report: `description`, `location` (user_location_name /
device_location_name / lat / lng), `thumbnail_url` (SMALL photo
variant, falling back to MEDIUM/HIGH/partial), `server_created_at`,
`deletion_requested_at`, `damage_classification`. Same endpoint still
serves the dashboard's live poll.

---

## Flow — 2 steps, both platforms

1. **Step 1 — Details** (single scrollable screen)
2. **Step 2 — Confirm** (read-only summary + Submit)

Prior to Phase 3, PWA had 3 pages (Incident / Details / Confirm) and RN had
3 screens (`review_incident` / `review_details` / `review_confirm`). Both
collapsed to 2.

Target: ≤ 4 taps from "Start Report" to "Submitted" with photo + audio.

---

## Step 1 — Details (field order)

Field order on the Details screen is identical on both platforms. A single
vertical ScrollView (RN) / scrollable stage (PWA) contains, top-to-bottom:

| # | Block | Control | Required | Notes |
|---|---|---|---|---|
| 1 | Photo preview + extras strip | `<img>` + thumbnails | yes (from Step 0) | Read-only here; editing returns to capture |
| 2 | Audio row | Play / re-record button | no | Read-only here |
| 3 | Description | `<textarea>` | no | max 2000 chars |
| 4 | **Type of Crisis** | 9 chips | yes | See enum below |
| 5 | **What is damaged?** (infrastructure type) | 9 chips | yes | See enum below |
| 6 | **Damage Level** | 3 chips | yes | `NO_DAMAGE / PARTIAL / COMPLETE` |
| 7 | Building / Road Name | `<input>` | no | `max 255` |
| 8 | Debris clearing toggle | checkbox | no | |
| 9 | Service status | 3 rows (electricity / water / health) | no | See enum below |
| 10 | Pressing needs | 5 chips | no | See enum below |
| 11 | **Severity** | 3 chips | yes | `MINOR / MODERATE / SEVERE` |
| 12 | Location | search + pin | yes (from GPS) | Auto-filled; user-correctable |

---

## Step 2 — Confirm

Two summary cards:

1. **Incident** card — `🌪 crisis · 📸 N photos · 🎤 ✅/❌ · 📝 description · 📍 location`
2. **Details** card — `📋 infra · ⚠ severity · 🏗 damage · 🏛 name (if any) · 🚛 debris (if any) · ⚡ 💧 🏥 service status · 🆘 needs`

Both cards have an ✏️ Edit link that returns to **Step 1 (Details)**. There
is no second step to edit into — the two cards are mirrors of the one screen.

Submit button at the bottom.

---

## Crisis types (9 values — order locked)

| Icon | Enum | Label | PWA | RN |
|---|---|---|---|---|
| 🏚 | `EARTHQUAKE` | Earthquake | ✅ | ✅ |
| 🌊 | `FLOOD` | Flood | ✅ | ✅ |
| ⚔️ | `CONFLICT` | Conflict | ✅ | ✅ |
| 🌀 | `HURRICANE` | Hurricane | ✅ | ✅ |
| 🌪 | `CYCLONE` | Cyclone | ✅ | **ADD** |
| 🔥 | `WILDFIRE` | Wildfire | ✅ | ✅ |
| 🏔 | `LANDSLIDE` | Landslide | ✅ | ✅ |
| 🦠 | `PANDEMIC` | Pandemic | ✅ | ✅ |
| ❓ | `OTHER` | Other | ✅ | ✅ |

RN is missing CYCLONE; add in Phase 3.

---

## Infrastructure types (9 values — order locked)

| Icon | Enum | Label | PWA | RN |
|---|---|---|---|---|
| 🛣 | `ROAD` | Road | ✅ | ✅ |
| 🏥 | `HOSPITAL` | Hospital | ✅ | ✅ |
| 🏠 | `HOUSE` | Home | ✅ | ✅ |
| ⚡ | `POWER` | Power | ✅ | ✅ |
| 💧 | `WATER` | Water | ✅ | ✅ |
| 🏫 | `SCHOOL` | School | ✅ | ✅ |
| 📡 | `TELECOM` | Telecom | ✅ | ✅ |
| 🏛 | `GOVERNMENT` | Gov. Building | ✅ | ✅ (label "Gov." — update to "Gov. Building") |
| ❓ | `OTHER` | Other | ✅ | ✅ |

RN label for `GOVERNMENT` is currently `Gov.` — update to `Gov. Building` for
parity. The PWA uses full `Gov. Building` in the chip.

---

## Damage classification (3 values)

| Icon | Enum | Label |
|---|---|---|
| ✅ | `NO_DAMAGE` | No Damage |
| ⚠️ | `PARTIAL` | Partial |
| ❌ | `COMPLETE` | Destroyed |

Both platforms match.

---

## Severity (3 values)

| Icon | Enum | Label |
|---|---|---|
| 🟢 | `MINOR` | Minor |
| 🟠 | `MODERATE` | Moderate |
| 🔴 | `SEVERE` | Severe |

Both platforms match.

---

## Service status (per service — **parity bug fixed in Phase 3**)

Backend enum: `OPERATIONAL / DISRUPTED / DESTROYED / UNKNOWN`
(`backend/app/models/report.py:57–61`).

| Icon | Enum | PWA label | RN label |
|---|---|---|---|
| — | `UNKNOWN` | Unknown | Unknown |
| ✅ | `OPERATIONAL` | Working | Working |
| ⚠ | `DISRUPTED` | Disrupted | Disrupted |
| ❌ | `DESTROYED` | Destroyed | Destroyed |

**Parity bug:** RN currently writes `NORMAL / DEGRADED / DOWN` — those values
are NOT in the backend enum. This drops service-status data on every RN
submission. Phase 3 changes RN to use the canonical enum.

---

## Pressing needs (5 values — lowercase canonical)

Backend stores as JSON array of strings. Canonical form: **lowercase**.

| Icon | Value (canonical) | PWA label | RN label |
|---|---|---|---|
| 🍱 | `food` | Food | Food |
| 🚰 | `water` | Water | Water |
| 🏠 | `shelter` | Shelter | Shelter |
| ⚕️ | `medical` | Medical | Medical |
| 🛡 | `security` | Security | Security |

**Parity bug:** RN currently writes `FOOD / WATER / SHELTER / MEDICAL /
SECURITY` (uppercase). Phase 3 changes RN to lowercase to match PWA and
backend JSON convention.

---

## Button copy

| Role | Copy | Notes |
|---|---|---|
| Primary advance | `Next →` | Step 1 → Step 2 |
| Submit | `Submit` (PWA) / `Send` (RN today — unify to `Submit`) | Step 2 terminal |
| Back | `← Back` | Step 2 → Step 1 |
| Edit (summary card) | `✏️ Edit` | Both cards → Step 1 |

RN currently says `Sending…` / `Send` for the submit button; PWA says
`Submit`. Unify to `Submit` on both.

---

## Step label formatting

`Step N of M` where M = total user-visible steps from Start Report to Submit.

- Photo → 1 of 4
- Audio → 2 of 4
- Details → 3 of 4
- Confirm → 4 of 4

Before Phase 3 the PWA counted 5 steps (photo, audio, page-1, page-2, page-3);
after Phase 3 it counts 4.

---

## Auto-submit regions — v3-only on BOTH clients; dormant in v4

Auto-submit-regions (a geofenced countdown that auto-submits a report at T=0
for reporters inside an admin-enabled region) is a **v3-era CRISP value-add,
NOT a UNDP must-have**, and it was **never ported to the V4 stage sequence on
either client**. Parity here = "neither client auto-submits in v4," which both
satisfy:

- **PWA** — `index.html` still arms the timer banner on every non-home/success
  stage (incl. the v4 stages), but `handleAutoSubmit()` (`mobile-app/src/app.js`)
  only branches on the legacy `stage-photo / stage-audio / stage-review /
  stage-send`. It has no `stage-v4-*` branch, so on the v4 flow the countdown
  reaches 0 and **does nothing** (sets `state.isAutoSubmit=true`, never submits).
  ⚠ Pre-existing PWA UX bug: the banner is visible + counts down in v4 but never
  fires — a separate cleanup, tracked outside this RN parity work.
- **RN** — `crisp-mobile/App.tsx` renders its `AutoSubmitTimer` only for the
  v3/v2 screens (`photo/audio/review_*/where/infra/crisis/extras`), never the
  `v4_*` screens, so with `UI_V4_ENABLED=true` the banner simply doesn't appear.
  Cleaner than the PWA (no misleading countdown). The v3 wiring is kept so the
  `UI_V4_ENABLED=false` rollback restores working auto-submit unchanged.

A proper v4 wiring is deferred. The blocker to a naïve port: the timer fires on
a clock regardless of progress, but the v4 classifier state is null-first
(RNV4-P4) — an auto-fire before the user classifies would POST
`infrastructure_type: null` → Pydantic 422 → wedged offline queue. Any v4
wiring MUST gate the fire on a completed classify (damage+infra+crisis set).

---

## How to enforce parity going forward

1. If a new field is added, add it to the table above.
2. Update both `mobile-app/src/index.html` (DOM) + `mobile-app/src/app.js`
   (submit payload) and `crisp-mobile/App.tsx` (screen + state) in the
   **same commit**.
3. Run `grep`-based sanity check: every enum value in this file must appear
   in `backend/app/models/report.py`.
