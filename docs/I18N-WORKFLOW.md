# CRISP i18n workflow - UNDP submission deliverable

This document describes how CRISP supports 22 locales today and how
UNDP / partner translators extend the language set going forward.
It is the canonical "how to add a new language" runbook referenced
by the InnoCentive submission.

## 1. Supported locales (22 total)

| Tier | Code | Name        | Native script        | Flag | IVR voice (Twilio Polly) | Notes |
|------|------|-------------|----------------------|------|--------------------------|-------|
| 1    | `en` | English     | English              | 🇬🇧 | Joanna (Neural)          | Canonical source of truth |
| 1    | `zh` | Mandarin    | 中文                  | 🇨🇳 | Zhiyu                    | UN official |
| 1    | `es` | Spanish     | Español              | 🇪🇸 | Lupe                     | UN official |
| 1    | `ar` | Arabic      | العربية              | 🇸🇦 | Zeina (`ar-XA`)          | UN official · RTL |
| 1    | `fr` | French      | Français             | 🇫🇷 | Lea                      | UN official |
| 1    | `ru` | Russian     | Русский              | 🇷🇺 | Tatyana                  | UN official |
| 2    | `hi` | Hindi       | हिन्दी               | 🇮🇳 | Aditi                    | UNDP set |
| 2    | `pt` | Portuguese  | Português            | 🇵🇹 | Camila / Cristiano        | UNDP set |
| 2    | `bn` | Bengali     | বাংলা                | 🇧🇩 | (none - falls to en)     | UNDP set |
| 2    | `ja` | Japanese    | 日本語                | 🇯🇵 | Takumi / Kazuha           | UNDP set |
| 2    | `tr` | Turkish     | Türkçe               | 🇹🇷 | Filiz                    | UNDP set |
| 2    | `vi` | Vietnamese  | Tiếng Việt           | 🇻🇳 | (none - falls to en)     | UNDP set |
| 2    | `ko` | Korean      | 한국어                | 🇰🇷 | Seoyeon                  | UNDP set |
| 2    | `id` | Indonesian  | Bahasa Indonesia     | 🇮🇩 | (none - falls to en)     | UNDP set |
| 2    | `ur` | Urdu        | اردو                 | 🇵🇰 | (none - falls to en)     | UNDP set · RTL |
| 3    | `kn` | Kannada     | ಕನ್ನಡ                | 🇮🇳 | (none - falls to en)     | India sub-national |
| 3    | `ta` | Tamil       | தமிழ்                | 🇮🇳 | Aditi (hi-IN proxy)      | India sub-national |
| 3    | `te` | Telugu      | తెలుగు               | 🇮🇳 | Aditi (hi-IN proxy)      | India sub-national |
| 3    | `ml` | Malayalam   | മലയാളം               | 🇮🇳 | Aditi (hi-IN proxy)      | India sub-national |
| 3    | `gu` | Gujarati    | ગુજરાતી              | 🇮🇳 | Aditi (hi-IN proxy)      | India sub-national |
| 3    | `mr` | Marathi     | मराठी                | 🇮🇳 | Aditi (hi-IN proxy)      | India sub-national |
| 3    | `pa` | Punjabi     | ਪੰਜਾਬੀ               | 🇮🇳 | Aditi (hi-IN proxy)      | India sub-national |

Coverage per locale is recorded in each JSON's `__meta__` block.
Run `node scripts/build-locale-skeletons.mjs --dry-run` for the live
report.

Tier-1 (UN) locales are first-class - they appear in the prominent
top row of the language picker. Tier-2 / 3 appear in the
horizontal-scroll carousel below.

## 2. Fallback chain (runtime guarantee)

For any visible string, the runtime resolution order is:

1. Active locale's value from `mobile-app/src/i18n/{lang}.json`
2. English value from `mobile-app/src/i18n/en.json` (always loaded
   before any non-English locale - see
   `mobile-app/src/app.js` → `activateLang` async block + the
   `I18N.__en_fully_loaded` flag)
3. The raw key as a last-resort placeholder (visually obvious - a
   broken translation, not a useful string)

The "missing native translation" → "English placeholder" hop is
**invisible to the user**: they see a real, professionally-edited
English string instead of `landing_title` or `v4_take_photo`.
Translators fill the gap over time; the runtime never breaks.

## 3. How to add a new language (7 steps)

Say you want to add Swahili (`sw`).

1. **Add to `LANG_FLAGS` in `mobile-app/src/app.js`.** Use the
   country flag of the dominant L1 country. Swahili → 🇹🇿 Tanzania
   (or 🇰🇪 Kenya - pick one).
   ```js
   const LANG_FLAGS = { …, sw: '🇹🇿' };
   ```
2. **Add to `SUPPORTED_LANGS` (same file).** The runtime gate that
   prevents non-shipped locales from being picked.
3. **Update `COUNTRY_LANG_DATA`** (also `app.js`) for any country
   where Swahili is primary (KE, TZ, UG already in the table - set
   `code: 'sw'`).
4. **Add a tile to the picker overlay** in
   `mobile-app/src/index.html`. Tier-2/3 tiles live inside
   `.lpf-tier-others-scroll`; tier-1 tiles live in `.lpf-tier-un`.
5. **Create `mobile-app/src/i18n/sw.json`** by running
   `node scripts/build-locale-skeletons.mjs`. This generates a
   skeleton with every key from `en.json` as a placeholder, plus a
   `__meta__` block listing all gap keys.
6. **Add a Twilio Polly voice** mapping in
   `messaging-bot/ivr/webhook.py` → `_IVR_VOICES`, if Twilio has a
   voice for the language (e.g. `'sw': ('en-US', 'Joanna')` would
   fall back to English; native Swahili voice is not yet offered
   by Polly as of 2026).
7. **Bump the service-worker cache version** in
   `mobile-app/src/sw.js` (`crisp-v113` → `crisp-v114`) so returning
   users get the new locale.

Run the verification matrix (`docs/I18N-WORKFLOW.md §5`) before
committing.

## 4. Translation workflow

Once `sw.json` is a skeleton, native review happens via CSV
worksheets that translators fill in offline.

```sh
# 1. Generate worksheets (one CSV per non-complete locale).
node scripts/generate-i18n-worksheets.mjs
# → writes mobile-app/i18n-worksheets/sw.csv with all 594 gap rows.

# 2. Translator opens sw.csv in any spreadsheet tool. They fill the
#    `suggested_translation` column with the Swahili rendering of
#    each English string, using `context_notes` to disambiguate
#    button-labels vs. ARIA hints vs. TTS prompts.
#    When a row is ready for import, they set `status` = "approved".

# 3. Import the approved rows back into the JSON.
node scripts/import-i18n-worksheet.mjs sw
# → patches mobile-app/src/i18n/sw.json with approved rows; skips
#   blank / "review" / "skip" rows.

# 4. Refresh the meta-block (coverage %, gap_keys array).
node scripts/build-locale-skeletons.mjs

# 5. Validate.
node scripts/validate-i18n.mjs
```

The two scripts are idempotent. A translator can iterate
(`generate → fill → import → review → fill more → import again`)
as many times as needed. CI gates on `validate-i18n.mjs`.

## 5. Quality gates

`scripts/validate-i18n.mjs` enforces:

- **Hard fail** - required tier-1 locales (`ar`, `zh`, `en`, `fr`,
  `ru`, `es`) must exist and parse as valid JSON.
- **Hard fail** - any locale missing a key that exists in `en.json`
  (we ship 100% key coverage; gaps are EN placeholders, not absent
  keys).
- **Warn** - tier-2 / 3 locales with `translation_status` of
  `partial` or `skeleton-only`. These are tracked in
  `__meta__.gap_keys` and resolved by the worksheet workflow.

CI runs `validate-i18n.mjs` on every PR.

## 6. Glossary discipline

To prevent translator drift, the following CRISP-specific terms
have agreed conventions. Translators consult this section before
rendering:

| Term      | Meaning                                                      | Convention |
|-----------|--------------------------------------------------------------|------------|
| Incident  | A crisis event (earthquake, flood, fire, conflict, etc.)     | Translate to the language's most direct word for "crisis event"; avoid "accident" / "issue" connotations |
| Reporter  | A citizen submitting a crisis report                         | Translate as the role, not as journalism term |
| Newcomer  | A reporter who has not yet submitted any report              | Often a short tag/chip; pick a friendly word |
| IVR       | Phone-call interface (`+1 662 676 8896`)                     | Acronym - leave as "IVR" or expand to "phone call" |
| OSM       | OpenStreetMap                                                | Acronym; leave as-is or render as "OpenStreetMap" if space allows |
| Verified  | A report that has been satellite-corroborated                | Adjective; UNDP rubric term |
| Submit / Send | Final tap to dispatch the report                         | Strong action verb; not "save" |
| Anonymous | The default no-login mode                                    | A guarantee - emphasise privacy in translation |
| CRISP     | The product name                                             | Brand name; never translate |

## 7. RTL support

Arabic (`ar`) and Urdu (`ur`) flip the document direction via
`<html dir="rtl">` (toggled by `_applyTextDirection` in `app.js`).
The CSS layer uses logical properties (`padding-inline-start`,
`margin-inline-end`, `text-align: start`) where practical; the
remaining physical-property layouts have explicit `[dir="rtl"]`
overrides at the bottom of `mobile-app/src/styles.css`.

When adding a new RTL language (e.g. Farsi `fa`, Hebrew `he`),
extend `RTL_LANGS` in `app.js`. No CSS changes are usually needed
because the `[dir="rtl"]` overrides match on direction, not language.

## 8. References

- Phase 25 plan: the design plan
- Validator: `scripts/validate-i18n.mjs`
- Builder: `scripts/build-locale-skeletons.mjs`
- Worksheet generator: `scripts/generate-i18n-worksheets.mjs`
- Worksheet importer: `scripts/import-i18n-worksheet.mjs`
- IVR voice map: `messaging-bot/ivr/webhook.py::_IVR_VOICES`
- UN must-have #2 (6 official languages): `the project invariants`
