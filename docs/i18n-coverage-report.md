# i18n Coverage Report

_Generated: 2026-05-24 · Source-of-truth: `mobile-app/src/i18n/en.json`_

## Summary

- **22 locales** shipped (6 UN-mandated + 16 regional)
- **921 total keys** in source-of-truth (`en.json`)
- **Inline pack:** 92 home-stage keys per locale (head-IIFE for frame-0 paint)
- **Lazy-loaded:** remaining ~829 keys (fetched on first navigation)

## UN-mandated languages (must-have 2)

| Code | Language | Keys | Parity | Inline pack |
| ---- | -------- | ---: | ------ | ----------- |
| `ar` | Arabic | 921/921 (100.0%) | ✓ Full | ✓ 92 |
| `en` | English | 921/921 (100.0%) | ✓ Full | ✓ 92 |
| `es` | Spanish | 921/921 (100.0%) | ✓ Full | ✓ 92 |
| `fr` | French | 921/921 (100.0%) | ✓ Full | ✓ 92 |
| `ru` | Russian | 921/921 (100.0%) | ✓ Full | ✓ 92 |
| `zh` | Chinese | 921/921 (100.0%) | ✓ Full | ✓ 92 |

## Regional locales (bonus coverage)

| Code | Language | Keys | Parity | Inline pack | Script |
| ---- | -------- | ---: | ------ | ----------- | ------ |
| `bn` | Bengali | 921/921 (100.0%) | ✓ Full | ✓ 92 | Bengali |
| `gu` | Gujarati | 921/921 (100.0%) | ✓ Full | ✓ 92 | Gujarati |
| `hi` | Hindi | 921/921 (100.0%) | ✓ Full | ✓ 92 | Devanagari |
| `id` | Indonesian | 921/921 (100.0%) | ✓ Full | ✓ 92 | Latin |
| `ja` | Japanese | 921/921 (100.0%) | ✓ Full | ✓ 92 | Han+Kana |
| `kn` | Kannada | 921/921 (100.0%) | ✓ Full | ✓ 92 | Kannada |
| `ko` | Korean | 921/921 (100.0%) | ✓ Full | ✓ 92 | Hangul |
| `ml` | Malayalam | 921/921 (100.0%) | ✓ Full | ✓ 92 | Malayalam |
| `mr` | Marathi | 921/921 (100.0%) | ✓ Full | ✓ 92 | Devanagari |
| `pa` | Punjabi | 921/921 (100.0%) | ✓ Full | ✓ 92 | Gurmukhi |
| `pt` | Portuguese | 921/921 (100.0%) | ✓ Full | ✓ 92 | Latin |
| `ta` | Tamil | 921/921 (100.0%) | ✓ Full | ✓ 92 | Tamil |
| `te` | Telugu | 921/921 (100.0%) | ✓ Full | ✓ 92 | Telugu |
| `tr` | Turkish | 921/921 (100.0%) | ✓ Full | ✓ 92 | Latin |
| `ur` | Urdu | 921/921 (100.0%) | ✓ Full | ✓ 92 | Arabic (RTL) |
| `vi` | Vietnamese | 921/921 (100.0%) | ✓ Full | ✓ 92 | Latin (diacritic) |

## Gate

Parity is enforced by `scripts/validate-i18n.mjs` (CI blocker).
Run locally: `node scripts/validate-i18n.mjs`

