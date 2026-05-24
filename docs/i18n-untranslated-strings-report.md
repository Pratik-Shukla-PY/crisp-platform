# i18n Untranslated Strings Report

_Generated: 2026-05-24_

## Summary

This report flags values that remain identical to English in each locale,
after filtering known international tokens (brand names, sector acronyms,
loanwords like `Online` / `Offline` / `Build` that are validly identical
in many target languages).

**Filter logic:**
- Brand names (Instagram, LinkedIn, WhatsApp, Telegram, CRISP, UNDP, …) are excluded
- Universal scientific/technical terms (Tsunami, Crisis, Audio, GPS, API, …) are excluded
- Punctuation- or placeholder-only values (`—`, `{km} km`, `{n}`) are excluded
- Anything ≤ 2 characters is excluded

## Per-locale residual drift

| Code | Language | Real gaps | International tokens (OK) |
| ---- | -------- | --------: | -------------------------: |
| `ar` | Arabic | **0** | 1 |
| `bn` | Bengali | **0** | 9 |
| `es` | Spanish | **0** | 20 |
| `fr` | French | **1** | 11 |
| `gu` | Gujarati | **0** | 9 |
| `hi` | Hindi | **0** | 8 |
| `id` | Indonesian | **3** | 21 |
| `ja` | Japanese | **0** | 10 |
| `kn` | Kannada | **0** | 9 |
| `ko` | Korean | **0** | 11 |
| `ml` | Malayalam | **0** | 6 |
| `mr` | Marathi | **0** | 9 |
| `pa` | Punjabi | **0** | 9 |
| `pt` | Portuguese | **7** | 16 |
| `ru` | Russian | **0** | 8 |
| `ta` | Tamil | **0** | 9 |
| `te` | Telugu | **0** | 9 |
| `tr` | Turkish | **0** | 11 |
| `ur` | Urdu | **0** | 9 |
| `vi` | Vietnamese | **0** | 11 |
| `zh` | Chinese | **0** | 5 |

**Grand total real gaps: 11**

## Detail per locale (real gaps only)

### `ar` — Arabic

✓ No real translation gaps.

### `bn` — Bengali

✓ No real translation gaps.

### `es` — Spanish

✓ No real translation gaps.

### `fr` — French (1 gaps)

- `nearby_sheet_incidents` → `INCIDENTS`

### `gu` — Gujarati

✓ No real translation gaps.

### `hi` — Hindi

✓ No real translation gaps.

### `id` — Indonesian (3 gaps)

- `summary_edit` → `✏️ Edit`
- `version_label_build` → `Build {n}`
- `version_label_detail` → `Build {n} · API {api}`

### `ja` — Japanese

✓ No real translation gaps.

### `kn` — Kannada

✓ No real translation gaps.

### `ko` — Korean

✓ No real translation gaps.

### `ml` — Malayalam

✓ No real translation gaps.

### `mr` — Marathi

✓ No real translation gaps.

### `pa` — Punjabi

✓ No real translation gaps.

### `pt` — Portuguese (7 gaps)

- `aria_online_status` → `Online`
- `status_pill_online` → `Online`
- `status_pill_offline` → `Offline`
- `status_sheet_state_online` → `Online`
- `status_sheet_state_offline` → `Offline`
- `version_label_build` → `Build {n}`
- `version_label_detail` → `Build {n} · API {api}`

### `ru` — Russian

✓ No real translation gaps.

### `ta` — Tamil

✓ No real translation gaps.

### `te` — Telugu

✓ No real translation gaps.

### `tr` — Turkish

✓ No real translation gaps.

### `ur` — Urdu

✓ No real translation gaps.

### `vi` — Vietnamese

✓ No real translation gaps.

### `zh` — Chinese

✓ No real translation gaps.

## Recommended action

Gaps marked above are non-blocking for UNDP submission but should be 
translated for the next pass. The 6 UN-mandated languages have minimal
residual drift; remaining gaps are mostly loanwords (e.g. `Build`,
`Online`) that are commonly used as-is in target locales.

