# i18n RTL Validation Report

_Generated: 2026-05-24 · RTL locales: Arabic (`ar`), Urdu (`ur`)_

## Summary

CRISP supports two right-to-left (RTL) locales:
- **Arabic (`ar`)** — UN-mandated language, primary RTL target
- **Urdu (`ur`)** — regional locale, secondary RTL target

Both ship with the full key inventory and the `dir="rtl"` document direction
is applied at frame 0 via the `__crispBootLang` head-IIFE in `index.html`.

## Key counts

- `ar` (Arabic): **921/921 keys** (100.0%)
- `ur` (Urdu): **921/921 keys** (100.0%)

## RTL CSS contract

The following invariants are enforced (see `mobile-app/src/styles.css`):

- **Logical properties used throughout** — `inset-inline-start/end`, `padding-inline-start/end`, `margin-inline-start/end` instead of the physical `left/right` equivalents (~110 sites total across PWA CSS).
- **Brand-mark connectivity dot** — anchored with `margin-inline-start` so it mirrors correctly under RTL.
- **Channels-strip ordering** — explicitly mirrored under `[dir=rtl]` so the first channel renders on the right (visual reading order).
- **Primary CTA play-arrow** — `transform: scaleX(-1)` under RTL to mirror the chevron.
- **Latin location names** — wrapped with `<bdi dir="ltr">` to prevent neighborhood/city names breaking visual flow.

## Frame-0 contract

The head-IIFE applies all of these synchronously before any deferred script runs:

```js
if (lang === 'ar' || lang === 'ur') {
    document.documentElement.dir = 'rtl';
} else {
    document.documentElement.dir = 'ltr';
}
document.documentElement.lang = lang;
```

This means `dir="rtl"` is set **before** the first paint — no `dir="ltr"` flash visible to the user.

## Gated tests

The following Playwright specs enforce the RTL contract:

- `e2e/tests/pwa/102-rtl-frame-zero.spec.ts` — asserts `<html dir="rtl">` at `domcontentloaded` for `?lang=ar`
- `e2e/tests/pwa/103-rtl-mirror.spec.ts` — visual mirror check of the channels-strip ordering
- `e2e/tests/pwa/104-rtl-bdi.spec.ts` — Latin names properly isolated with `<bdi>`
- `e2e/tests/pwa/99-locale-no-flicker.spec.ts` — no visible locale flicker under any of the 22 locales

## Manual RTL audit (May 2026)

All RTL-impacting strings re-verified in this i18n pass:
- Privacy + Help sheets (`privacy_sheet_*`, `help_sheet_*`) — Arabic + Urdu translations applied, no LTR drift
- Status sheet (`status_sheet_*`) — both directions tested
- Install steps (`install_step_*`) — both directions tested
- All 16 newly-wired ARIA labels — Arabic + Urdu translations present

