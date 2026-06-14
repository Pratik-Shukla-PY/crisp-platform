# RN companion - UI v4 parity, deferred

**Status:** the React-Native companion is one major version behind the
PWA. PWA is on **UI v4** (3-page flow, Path B native camera, AI
pre-fill, landing card, install prompt). RN is on **legacy 4-stage**
(home → photo → audio → review → send → success).

**Why this is OK for now:** the RN apps are **not published** to the
App Store / Play Store. The PWA's landing card surfaces them as
"Coming soon." We have until the v4 RN ships before users can
discover the divergence.

## What needs to happen before publish

The RN companion's `App.tsx` is a 3,900-line monolith. A safe v4 port
needs to land these in order:

1. **Add `UI_V4_ENABLED` flag** alongside the existing `UI_V3_ENABLED`
   (currently only commented, not implemented in code) - pattern
   identical to PWA's `localStorage['crisp_ui_v4']`.

2. **Extend the `Screen` type** (line 117 of `App.tsx`):
   ```ts
   type Screen =
     | 'home'
     | 'where' | 'infra' | 'crisis' | 'extras'
     | 'photo' | 'audio' | 'review_details' | 'review_confirm'
     | 'success' | 'history' | 'report_detail'
     | 'login' | 'settings'
     // v4 additions
     | 'v4_landing'    // first-visit channel + install card
     | 'v4_capture'    // native camera (expo-image-picker) + auto-meta
     | 'v4_classify'   // 3 carousels on one screen
     | 'v4_review';    // summary + UNDP details (expanded)
   ```

3. **Add three new screen components** (each ~150 LoC):
   - `V4LandingScreen` - uses `Linking.openURL()` for `tel:`/`sms:`/
     `https://t.me/`/`https://wa.me/` deep links. App Store / Play
     Store buttons. AsyncStorage flag for "seen."
   - `V4CaptureScreen` - `ImagePicker.launchCameraAsync({ allowsEditing: false })`
     replaces the in-app `Camera` component. The PII-blur pipeline
     already runs on the captured URI via the existing `piiBlur.ts`
     service.
   - `V4ClassifyScreen` - three sections, three `FlatList`-based
     horizontal carousels with snap-to-interval and 9 / 8 / 3 slides.
     Bandwidth-gated `fetch` to `/api/v1/reports/classify-suggest`
     for AI pre-fill (same endpoint the PWA uses).
   - `V4ReviewScreen` - summary card with 4 tap-edit rows; voice
     drawer collapsed by default; UNDP details expanded by default;
     `Send to UNDP` button delegates to existing `submitReport()`.

4. **Wire `setScreen('v4_capture')` from the home `btn-start`
   equivalent** when `UI_V4_ENABLED` is true, falling back to `where`
   / `photo` for v3 / legacy.

5. **Mirror the i18n keys** committed in PWA Commit C (59 keys × 6
   locales = 354 pairs). RN's `services/i18n.ts` already imports the
   same JSON files at build time, so step 5 is "no-op" once the
   `mobile-app/src/i18n/` files are copied to `crisp-mobile/services/i18n/`
   (the existing build script does this).

6. **Update the `__tests__/` Detox suite** to assert the same
   click-count + viewport-fit invariants the PWA's
   `27-v4-flow.spec.ts` covers.

## Estimated effort

~3 working days for a careful refactor. The risky bit is integrating
v4 alongside v3 alongside legacy - three concurrent flows in one file.
A worktree is recommended for the RN port specifically.

## Why we're not doing it now

- The RN apps are not on stores yet. There is no production user
  facing the legacy 4-stage flow.
- The PWA can be loaded from the same iOS / Android browsers and
  installed to home screen via the new install prompt. Users get
  v4 today on every device.
- The `landing-page` "Get the app" buttons are wired to "Coming soon"
  by default in `landing.js`, which can be flipped to real App Store /
  Play Store URLs the same day the RN port ships.

## What ships in v4 RN preview commit

This commit (Commit D of the v4 series):

- Adds the `UI_V4_ENABLED` AsyncStorage flag check (no behavior
  change yet - flag reads true but no v4 screens exist).
- Adds the `v4_landing | v4_capture | v4_classify | v4_review`
  values to the `Screen` type.
- Documents the parity gap here in `V4_PARITY_DEFERRED.md`.

The actual screen implementations are the follow-up - tracked as
work-in-progress in this file.

## Operator runbook for the eventual port

Spin up a worktree:
```bash
git worktree add ../crisp-rn-v4 -b feature/rn-v4
cd ../crisp-rn-v4
cd crisp-mobile && npx expo start
```

Work the screens one at a time, in the order listed in §3 above.
Each screen is independently shippable behind the `UI_V4_ENABLED`
flag - the v3 + legacy flow remains the default until every screen
exists.

When ready to publish, flip the landing card's `CHANNELS.ios_app_url`
and `CHANNELS.android_app_url` defaults to the real store URLs in
`mobile-app/src/landing.js`.
