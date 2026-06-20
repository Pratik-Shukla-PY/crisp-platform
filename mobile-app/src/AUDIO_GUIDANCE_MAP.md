# Audio / onboarding guidance — UI ↔ instruction mapping

**Why this file exists:** spoken audio guidance is produced by reading the *live
i18n string* aloud (`voice-readout.js` → `SpeechSynthesis`). There are **no
recorded audio files** — the audio is exactly the translated text. So any
instruction that names a **colour, shape, or position** of a UI element silently
goes wrong the moment that element is re-themed or moved. In Jun 2026 the home
CTA changed orange → teal, the English hint was updated to "green", and **all 21
non-English translations kept saying "tap the orange button"** for weeks. This
map + the CI guards exist so that cannot recur.

## How audio guidance is produced
- **Home onboarding voice** — `#btn-home-voice` (home-screen.js `_wireHomeVoice`)
  speaks: `"CRISP" · t('home_cta_primary') · t('home_voice_hint')`.
- **Capture-question voice** — any `data-voice="<key>"` element gets a speaker
  button (`voice-readout.js`) that speaks `t('<key>')`.
- **TTS voice** — `SPEECH_MAP[lang]` (voice-readout.js) picks the BCP-47 voice.
  A locale missing here is **silent**. Every shipped locale MUST have an entry.

## The mapping (keep in sync with the CI guard's `VOICE_GUIDANCE_KEYS`)

| i18n key | Spoken/used where | Describes which UI element | Rule |
|---|---|---|---|
| `home_voice_hint` | home voice button (audio) | the primary CTA button | **action/label only — never a colour/shape/position** |
| `home_channel_coming_soon` | "coming soon" message (text) | the primary CTA button | same |
| `home_cta_primary` | home voice button (audio) + the CTA label itself | the CTA button label | mirrors the visible label |
| `v4_q_crisis` / `v4_q_damage` / `v4_q_infra` | `data-voice` on the v4 capture questions | the question being asked | describe the question, not the UI |
| `undp_debris_label` / `undp_water_label` / `undp_power_label` / `undp_health_label` / `undp_needs_label` | `data-voice` on the UNDP service-status labels | the field being asked | describe the field, not the UI |

## Rules (enforced by `scripts/validate-i18n.mjs`)
1. **No appearance words** (orange/green/blue/red/yellow/teal + their translations)
   in any `VOICE_GUIDANCE_KEYS` value, in **any** locale. CI fails otherwise.
2. **SPEECH_MAP must cover every shipped locale.** CI fails otherwise.
3. e2e `131-audio-guidance.spec.ts` taps the home voice button per language and
   asserts the spoken text carries no colour word and matches the live i18n.

## When you change the UI
- Re-theme / move / rename the **primary CTA** → review `home_voice_hint`,
  `home_channel_coming_soon`, `home_cta_primary`. (They must stay appearance-free,
  so a colour/position change needs no edit — that is the point.)
- Add a new spoken element → add its key to the table above **and** to
  `VOICE_GUIDANCE_KEYS` in `validate-i18n.mjs`.
- Add a new shipped locale → add its `SPEECH_MAP` entry in `voice-readout.js`.
- Change an English instructional string → **every locale must be re-translated**;
  the validator's appearance guard + the worksheet flow
  (`scripts/generate-i18n-worksheets.mjs`) backstop the backfill. Never assert
  "all locales backfilled" in a comment without machine verification.
