# Multilingual & Localization System — Status Report

## Current State vs Requirements

### Coverage Matrix

| Requirement | Mobile PWA | Telegram | WhatsApp | SMS | IVR | Backend |
|-------------|-----------|----------|----------|-----|-----|---------|
| **6 UN Languages (en,fr,es,ar,zh,ru)** | 6/6 | 4/6 (no zh,ru) | 0/6 (en only) | 0/6 (en only) | 0/6 (hi only) | N/A |
| **Local languages** | 80+ mapped | 7 (en,hi,es,fr,ar,pt,sw) | None | None | None | Whisper handles all |
| **Auto-detect from location** | GPS + IP geo + country map | Telegram locale | None | None | None | — |
| **Manual language override** | Button switcher | Flag buttons | None | None | None | — |
| **LANG command** | No (buttons) | No (buttons) | None | None | None | — |
| **Offline translation cache** | IndexedDB + localStorage | No | No | N/A | N/A | — |
| **Store original language** | No | No | No | No | No | No field |
| **Store original + translated text** | No | No | No | No | No | Partial (transcription vs ai_summary) |
| **Auto-translation API** | No | No | No | No | No | Whisper translate only |

---

## Gap Summary

### CRITICAL GAPS (must fix for submission)

| # | Gap | Channel | Effort | Impact |
|---|-----|---------|--------|--------|
| G1 | Chinese + Russian missing in Telegram | Telegram | 2h | UN language requirement |
| G2 | WhatsApp is English-only | WhatsApp | 3h | Multi-channel localization |
| G3 | SMS is English-only | SMS | 2h | Multi-channel localization |
| G4 | IVR is Hindi-only, no language selection | IVR | 2h | Accessibility |
| G5 | No `detected_language` field in Report model | Backend | 1h | Data governance |

### MEDIUM GAPS (should fix)

| # | Gap | Effort | Impact |
|---|-----|--------|--------|
| G6 | No LANG text command (Telegram/SMS) | 1h | Manual override |
| G7 | No auto-translation API for dynamic content | 2h | User input translation |
| G8 | IVR TTS only in Hindi, no multi-language TTS | 2h | Global accessibility |

### ALREADY COVERED

| Requirement | Status | Evidence |
|-------------|--------|----------|
| 6 UN languages in PWA | DONE | 80+ language mappings, native zh/ru strings |
| Location-based auto-detect (PWA) | DONE | GPS → country → language mapping |
| IP geolocation fallback (PWA) | DONE | 3-tier IP geo with country detection |
| Regional sub-detection (India) | DONE | 11 REGION_LANG_MAP entries |
| Manual override (PWA) | DONE | Button-based language switcher |
| Manual override (Telegram) | DONE | Flag buttons on welcome |
| Offline translation cache (PWA) | DONE | IndexedDB + localStorage |
| Whisper any-language → English | DONE | task="translate" in ai_service.py |
| Consent gate multilingual | DONE | 20+ languages in consent text |

---

## Implementation Plan

### G1: Add Chinese + Russian to Telegram Bot (2 hours)

**File:** `messaging-bot/telegram/bot_replies.py`

Add complete `"zh"` and `"ru"` entries to `_STRINGS` dict (~30 keys each).
Add 🇨🇳 and 🇷🇺 flag buttons to welcome message.
Remove `"zh": "en"` and `"ru": "en"` from `_LANG_FALLBACK`.

### G2: Add Multilingual to WhatsApp Bot (3 hours)

**Files:** `messaging-bot/whatsapp/bot_replies.py`, `handlers.py`

1. Add `_STRINGS` dict (same structure as Telegram) with 6 UN languages
2. Add `detect_lang(phone)` using phone country code prefix (+91=hi, +33=fr, etc.)
3. Add `session.lang` field to WhatsApp session
4. Send responses using `t(session.lang, key)` instead of hardcoded English
5. Add "Reply LANG to change language" in welcome message

### G3: Add Multilingual to SMS (2 hours)

**Files:** `messaging-bot/sms/parser.py`, `webhook.py`

1. Detect language from phone number country prefix
2. Add multilingual reply templates (6 UN languages — short, SMS-optimized)
3. Support "LANG EN" / "LANG HI" keyword to switch
4. Keep keyword parsing in English (backend normalizes) but replies in user language

### G4: IVR Language Selection (2 hours)

**File:** `messaging-bot/ivr/webhook.py`

Add language menu at call start BEFORE location:
```xml
<Gather numDigits="1" timeout="5">
  <Say>Press 1 for English. Press 2 for Hindi. Press 3 for Spanish.
       Press 4 for French. Press 5 for Arabic.</Say>
</Gather>
```
Then use appropriate Polly voice for selected language throughout the call.
Available Polly voices: Joanna (en), Aditi (hi), Lupe (es), Lea (fr), Zeina (ar).

### G5: Add `detected_language` to Report Model (1 hour)

**File:** `backend/app/models/report.py`, `schemas/report.py`

Add `detected_language = Column(String(10), nullable=True)` to Report.
Each channel sets it: PWA → `state.lang`, Telegram → `session.lang`, etc.
Dashboard can filter/sort by language.

### G6: LANG Text Command (1 hour)

**Telegram:** Add handler for `/lang` text command → show language buttons
**SMS:** Parse "LANG XX" prefix in incoming SMS → switch reply language

### G7: Auto-Translation (2 hours, optional)

For dynamic user content that isn't audio (text messages from SMS/WhatsApp):
- Whisper already handles audio → English translation
- For text: Use Claude Haiku (already available) as lightweight translator
- Prompt: "Translate to English: {text}" — cacheable, cheap
- Store both `original_text` and `translated_text` in description

### G8: IVR Multi-Language TTS (2 hours)

Map language selection to AWS Polly voices:
| Language | Voice | Code |
|----------|-------|------|
| English | Joanna | en-US |
| Hindi | Aditi | hi-IN |
| Spanish | Lupe | es-US |
| French | Lea | fr-FR |
| Arabic | Zeina | ar-XA |
| Russian | Tatyana | ru-RU |
| Chinese | Zhiyu | cmn-CN |

---

## Total Effort: ~15 hours for all gaps

**Critical path (G1-G5): ~10 hours**
**Nice-to-have (G6-G8): ~5 hours**
