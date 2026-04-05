# CRISP - Crisis Response Intelligence & Situation Platform

**Multi-channel, AI-powered damage reporting for the first 48 hours of a crisis.**

CRISP is an open-source, offline-first platform that enables communities to report infrastructure damage via **6 channels** (Mobile App, Web Dashboard, Telegram, WhatsApp, SMS, IVR Voice Calls) with AI-powered satellite verification, progressive media streaming, and multilingual support. Built for the [UNDP InnoCentive Challenge](https://www.innocentive.com/) on rapid post-disaster damage assessment.

---

## What It Does

| Role | Tool | Purpose |
|------|------|---------|
| **Field Reporter** | Mobile PWA, Telegram, WhatsApp, SMS, IVR Call | Report damage from any device — smartphone, feature phone, or landline |
| **Control Center** | Web Dashboard | Triage incidents, AI assessment, satellite verification, dispatch rescue teams |
| **Data Analyst** | Export API / PDF | Download CSV/GeoJSON or generate single-page PDF reports for rescue teams |

### Key Capabilities

- **6-Channel Intake**: Mobile PWA, Telegram Bot, WhatsApp Bot, SMS Gateway, IVR Voice Calls
- **Offline-first**: Reports queue in IndexedDB, sync progressively even at 2Kbps
- **Voice-first multilingual**: Auto-detects language from GPS, supports 190+ countries, 7 languages
- **AI Assessment**: Claude Sonnet cross-verifies text, photos, satellite imagery, nearby reports, caller identity — produces confidence score (0-100) with recommended action
- **Satellite Verification**: Sentinel-2 + Mapbox/Maxar imagery compared against ground photos
- **Progressive media streaming**: Photos and audio arrive chunk-by-chunk in real-time
- **Real-time transcription**: Audio translated to English via Whisper (any language in, English out)
- **AI Geocoding**: Claude fixes mangled voice transcriptions of place names + Mapbox geocoding
- **PDF Export**: Single-page incident reports with photos + satellite images for rescue teams
- **Prompt Caching**: Claude API calls use ephemeral caching for 90% token cost reduction
- **Source-aware scoring**: IVR/SMS reports scored fairly (no photo penalty for callers without smartphones)

---

## Architecture

```
           REPORTING CHANNELS                    BACKEND                        CONTROL CENTER
  ================================    ==========================    ================================
  Mobile PWA (offline-first)  ─────>
  Telegram Bot (guided flow)  ─────>   FastAPI + SQLAlchemy        Web Dashboard
  WhatsApp Bot (media+text)   ─────>   Whisper Transcription  ──>  Leaflet Map + Clusters
  SMS Gateway (text parsing)  ─────>   Claude AI Geocoding         Decision-first Detail Panel
  IVR Voice Call (auto-stop)  ─────>   Sentinel Hub Satellite      AI Assessment (on-demand)
                                       Mapbox Geocoding             Satellite Verification
                                       Prompt Caching               PDF Export
                                       Progressive Chunked Upload   Send Help / False / Delete
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Mobile App | Vanilla JS PWA, Service Worker, IndexedDB, Web Speech API |
| Backend API | Python 3.11, FastAPI, SQLAlchemy, Uvicorn |
| AI/ML | faster-whisper (local), Anthropic Claude Sonnet + Haiku (cloud) |
| Satellite | ESA Sentinel-2 L2A (10m), Mapbox/Maxar (0.5m fallback) |
| Geocoding | Mapbox Geocoding API + Claude AI place name correction |
| Dashboard | Vanilla JS, Leaflet.js, Turf.js, leaflet.heat, MarkerCluster |
| Messaging | Telegram Bot API (long-polling), WhatsApp Cloud API, Twilio (SMS+IVR) |
| Database | SQLite (dev) / PostgreSQL (prod) |

---

## Reporting Channels

### 1. Mobile PWA (Primary)
Full-featured offline-first app with photo capture, audio recording, GPS location, and progressive sync.

### 2. Telegram Bot
Step-by-step guided flow accepting photos, audio, video, text, and shared location. Auto-detects language from location. Video splits into audio (transcribed) + thumbnail.

### 3. WhatsApp Bot
Receives text, photos, audio, and location via WhatsApp Cloud API. Media downloaded from Meta Graph API and chunked-uploaded to backend.

### 4. SMS Gateway
Keyword-based text parsing extracts incident type, severity, and location. Auto-replies with confirmation. Works via Twilio.

### 5. IVR Voice Calls
Simplified 2-step voice flow:
1. "Say your location" (auto-stops after 10s silence or `*`)
2. "Describe your problem" (auto-stops after 20s silence or `*`)

Audio transcribed by Whisper, translated to English, geocoded by Claude AI + Mapbox. Both recordings uploaded to dashboard. Caller phone number and telecom circle captured. Uses Twilio Voice API with TwiML.

---

## AI Assessment System

### On-Demand Assessment (Admin-Triggered)
When the control center admin clicks **"Run AI Assessment"**, Claude Sonnet analyzes the complete incident using 4 weighted signals:

**For App/Telegram/WhatsApp (photo possible):**
| Signal | Weight | What It Checks |
|--------|--------|----------------|
| Photo Evidence | 25% | Does photo match text? Real damage or stock photo? |
| Text & Voice | 25% | Specific details, emotional distress, local knowledge |
| Satellite Verification | 25% | Satellite imagery matches reported location/damage |
| Corroboration | 25% | Nearby reports from different users, media count |

**For IVR/SMS (no photo possible):**
| Signal | Weight | What It Checks |
|--------|--------|----------------|
| Text & Voice | 40% | Urgency, specificity, distress (PRIMARY signal) |
| Satellite Verification | 25% | Satellite matches location |
| Corroboration | 25% | Nearby reports, media evidence |
| Caller Identity | 10% | Traceable phone = credibility |

**Key Principles:**
- IVR/SMS callers are NOT penalized for missing photos (they have no smartphone)
- A traceable phone number is evidence of sincerity
- Nearby corroborating reports are the strongest signal
- False negatives (dismissing real incidents) cost lives
- Assessment stored in DB permanently (one-time cost per incident)

### AI also infers:
- `infrastructure_type` (WATER/ROAD/HOSPITAL/HOUSE/POWER/OTHER)
- `severity` (CRITICAL/SEVERE/MODERATE/MINOR)
- These update the report classification automatically

### Prompt Caching
All Claude API calls use `cache_control: {"type": "ephemeral"}` on static system prompts:
- **Geocoder**: Place name correction examples cached (~90% savings)
- **Satellite Scorer**: Scoring rubric cached (~90% savings)
- **AI Assessment**: Scoring rules + format cached (~90% savings)

---

## Quick Start

### Prerequisites
- Python 3.10+
- A modern browser (Chrome, Safari, Firefox)

### 1. Clone & Configure
```bash
git clone https://github.com/your-org/crisp-platform.git
cd crisp-platform
cp .env.example .env
# Edit .env with your API keys (see API Keys section)
```

### 2. Run Locally
```bash
bash start.sh
```

### 3. Access

| App | URL |
|-----|-----|
| Mobile App | http://localhost:8080/mobile-app/src/index.html |
| Web Dashboard | http://localhost:8080/web-dashboard/src/index.html |
| API Docs (Swagger) | http://localhost:8000/docs |

### 4. Docker Deployment
```bash
docker compose up --build
```

---

## API Keys Required

| Service | Purpose | Get From |
|---------|---------|----------|
| **Anthropic** | AI Assessment + Geocoding + Satellite Scoring | [console.anthropic.com](https://console.anthropic.com/) |
| **Sentinel Hub** | Satellite imagery (Sentinel-2) | [apps.sentinel-hub.com](https://apps.sentinel-hub.com/) |
| **Mapbox** | Geocoding + fallback satellite (Maxar) | [account.mapbox.com](https://account.mapbox.com/) |
| **Telegram** | Telegram Bot token | [@BotFather](https://t.me/BotFather) |
| **WhatsApp** | WhatsApp Cloud API | [Meta for Developers](https://developers.facebook.com/) |
| **Twilio** | SMS + IVR Voice Calls | [twilio.com](https://www.twilio.com/) |

---

## Data Model

```
Report
  +-- Location (GPS coords, device vs. geocoded, place names)
  +-- Media[] (IMAGE, AUDIO — chunked upload with DJB2 checksum)
  |     +-- MediaChunk[] (1KB base64 packets)
  +-- AIAnalysis (Whisper transcription, AI summary, damage labels)
  +-- SatelliteVerification (truth score, component breakdown, satellite metadata)
  +-- ai_assessment (JSON — AI confidence score, action, detailed analysis)
  +-- caller_info (JSON — phone number, network city/state for IVR/SMS)
```

---

## Web Dashboard Features

### Detail Panel (Decision-First Interface)
1. **Top Bar**: AI Assessment score + action OR "Run AI Assessment" button + PDF export
2. **Action Buttons**: Send Help / Mark False / Delete (always visible)
3. **Evidence**: User photo + satellite toggle (Photo/Satellite/Compare)
4. **Satellite Verification**: Score + 1-paragraph report (below image)
5. **Audio Players**: Labeled (Location/Description for IVR)
6. **User Transcription**: Expandable with keyword highlighting
7. **Location & Contact**: Merged card with coordinates + caller phone + telecom circle
8. **Source Details**: Collapsible metadata (channel, report ID, media count)

### PDF Export
Single-page structured report with:
- Incident overview (type, severity, status, source, timestamp)
- Location (name, coordinates, telecom circle)
- Description / transcription
- Visual evidence (user photo + both satellite images side-by-side with timestamps)
- AI analysis and satellite verification scores
- Print / Save as PDF buttons

---

## Offline Behavior

1. **No internet**: Report saved to IndexedDB with photo thumbnail + full audio
2. **2Kbps**: Metadata syncs first, then media in 1KB chunks with DJB2 checksum + resume
3. **Full connectivity**: High-res photo + original audio uploaded, AI pipeline triggered
4. **Background sync**: Service Worker retries every 30 seconds

---

## Security & Privacy

- **No PII collected**: Device identified by anonymous hash only
- **No user accounts**: Zero registration barrier for crisis reporters
- **Caller phone stored**: Only for IVR/SMS (needed for rescue callback)
- **API keys**: Stored in `.env`, excluded from git via `.gitignore`

---

## Project Structure

```
crisp-platform/
  backend/
    app/
      api/endpoints/         # FastAPI route handlers (reports, verify, ai-assess)
      models/                # SQLAlchemy ORM (Report, Location, Media, AIAnalysis)
      schemas/               # Pydantic request/response schemas
      services/              # AI service, satellite fetcher, truth scorer
      db/                    # Database session, engine
    requirements.txt
  mobile-app/src/            # Offline-first PWA (Vanilla JS)
  web-dashboard/src/         # Control center dashboard (Vanilla JS + Leaflet)
  messaging-bot/
    telegram/                # Telegram bot (long-polling, guided flow)
    whatsapp/                # WhatsApp Cloud API webhook
    sms/                     # SMS gateway + AI geocoder
    ivr/                     # IVR voice call webhook (TwiML)
    ai_extractor.py          # Claude AI text extraction (deprecated — replaced by AI Assessment)
    chunked_uploader.py      # Shared chunked media upload
  ai-services/               # NLP, speech, vision pipelines
  infra/                     # Docker, Nginx, Terraform configs
  start.sh / stop.sh         # Local development scripts
  docker-compose.yml         # Production deployment
  .env.example               # API key template
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.

Built for the UNDP InnoCentive Challenge on Rapid Community Damage Assessment.
