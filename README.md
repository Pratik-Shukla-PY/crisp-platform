# CRISP - Crisis Response Intelligence & Situation Platform

**Multi-channel, AI-powered damage reporting for the first 48 hours of a crisis.**

CRISP is an open-source, offline-first platform that enables communities to report infrastructure damage via **6 channels** (Mobile App, Web Dashboard, Telegram, WhatsApp, SMS, IVR Voice Calls) with AI-powered satellite verification, progressive media streaming, and multilingual support. Built for the [UNDP InnoCentive Challenge](https://www.innocentive.com/) on rapid post-disaster damage assessment.

---

## What It Does

| Role | Tool | Purpose |
|------|------|---------|
| **Field Reporter** | Mobile PWA, Telegram, WhatsApp, SMS, IVR Call | Report damage from any device - smartphone, feature phone, or landline |
| **Control Center** | Web Dashboard | Triage incidents, AI assessment, satellite verification, dispatch rescue teams |
| **Data Analyst** | Export API / PDF | Download CSV/GeoJSON/Shapefile/KML or generate PDF reports for rescue teams |
| **Prediction Analyst** | Predictive Intelligence | Multi-signal risk forecasting with weather, seismic, and historical data |

### Key Capabilities

- **6-Channel Intake**: Mobile PWA, Telegram Bot, WhatsApp Bot, SMS Gateway, IVR Voice Calls
- **Offline-first**: Reports queue in IndexedDB, sync progressively even at 2Kbps
- **Voice-first multilingual**: Auto-detects language from GPS, supports 190+ countries, 7 languages
- **AI Assessment**: the AI cross-verifies text, photos, satellite imagery, nearby reports, caller identity - produces confidence score (0-100) with recommended action
- **Satellite Verification**: Sentinel-2 + Mapbox/Maxar imagery compared against ground photos
- **Progressive media streaming**: Photos and audio arrive chunk-by-chunk in real-time
- **Real-time transcription**: Audio translated to English via Whisper (any language in, English out)
- **AI Geocoding**: AI fixes mangled voice transcriptions of place names + Mapbox geocoding
- **PDF Export**: Single-page incident reports with photos + satellite images for rescue teams
- **Prompt Caching**: the LLM API calls use ephemeral caching for 90% token cost reduction
- **Source-aware scoring**: IVR/SMS reports scored fairly (no photo penalty for callers without smartphones)
- **Enterprise Auth**: Email + OTP signup, JWT sessions, RBAC (Super Admin/Admin/Analyst/Viewer), SSO ready (Okta/Auth0/Azure AD/Keycloak)
- **GDPR Compliance**: Data export, account deletion, consent management, audit logging
- **Predictive Intelligence**: Multi-signal risk forecasting (weather + seismic + historical + geospatial + conflict) with AI
- **Gamification**: Reporter badges (Newcomer→Helper→Guardian→Hero) based on verified report count
- **UNDP Damage Classification**: 3-tier (No Damage/Partial/Complete), 9 crisis types, 9 infrastructure types, debris clearing, service status
- **Data Export**: CSV, GeoJSON, Shapefile (.shp), KML for GIS tools
- **Building Versioning**: Auto-links multiple reports about the same structure (30m proximity)

---

## Architecture

```
           REPORTING CHANNELS                    BACKEND                        CONTROL CENTER
  ================================    ==========================    ================================
  Mobile PWA (offline-first)  ─────>
  Telegram Bot (guided flow)  ─────>   FastAPI + SQLAlchemy        Web Dashboard
  WhatsApp Bot (media+text)   ─────>   Whisper Transcription  ──>  Leaflet Map + Clusters
  SMS Gateway (text parsing)  ─────>   AI Geocoding         Decision-first Detail Panel
  IVR Voice Call (auto-stop)  ─────>   Sentinel Hub Satellite      AI Assessment (on-demand)
                                       Mapbox Geocoding             Satellite Verification
                                       Prompt Caching               PDF Export
                                       Progressive Chunked Upload   Send Help / False / Delete
                                       Enterprise Auth (JWT+OTP)    Predictive Intelligence
                                       Building Versioning          Data Export (CSV/GeoJSON/SHP/KML)
```

### Channel capability matrix

Every channel produces the same `Report` row shape, but channels differ in how
the UNDP core questions are answered. Rich clients ask the reporter directly;
lean channels capture what they can and the rest is classified downstream (by
AI from the transcript, or by a UNDP analyst from the evidence - both
explicitly anticipated in the challenge Q&A, which notes that "technical
validation and deeper analysis remain essential functions of UNDP teams").

Legend: ✅ asked & enforced · 🟢 asked (optional) · 🤖 AI-extracted · 👤 analyst-classified · - n/a

| Core question | PWA | Android (RN) | Telegram | WhatsApp | SMS | IVR |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Damage classification | ✅ | ✅ | ✅ | 👤 | 🤖 | 🤖 |
| Infrastructure type | ✅ | ✅ | ✅ | ✅ | 🤖 | 🤖 |
| Crisis type | ✅ | ✅ | ✅ | 👤 | 🤖 | 🤖 |
| Debris clearing | ✅ | ✅ | ✅ | 👤 | 🤖 | 🤖 |
| Location (GPS / textual) | ✅ | ✅ | ✅ | ✅ | 🤖 | 🤖 |
| Photo / evidence | 🟢 | 🟢 | 🟢 | ✅ | - | - |

**WhatsApp** is intentionally a rapid-intake channel: it collects severity,
infrastructure type, location, and media/text evidence with minimal back-and-
forth, and the crisis type, damage class, and debris question are classified by
an analyst (or the AI extractor) from that evidence. Reporters who want to
self-classify every field use the PWA, the Android app, or Telegram. The
backend schema accepts a partial row from any channel; the dashboard renders
only the fields a given report actually carries.

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Mobile App (PWA) | Vanilla JS PWA, Service Worker, IndexedDB, Web Speech API |
| Mobile App (Native) | React Native (Expo), TypeScript, expo-audio, expo-camera |
| Backend API | Python 3.11, FastAPI, SQLAlchemy, Uvicorn |
| AI/ML | faster-whisper (local), Cloud LLM (Haiku/Sonnet) |
| Satellite | ESA Sentinel-2 L2A (10m), Mapbox/Maxar (0.5m fallback) |
| Geocoding | Mapbox Geocoding API + AI place name correction |
| Dashboard | Vanilla JS, Leaflet.js, Turf.js, leaflet.heat, MarkerCluster |
| Messaging | Telegram Bot API (long-polling), WhatsApp Cloud API, Twilio (SMS+IVR) |
| Auth | JWT (python-jose), bcrypt (passlib), OTP email, RBAC, SSO stubs |
| Prediction | the AI + OpenWeatherMap + USGS Earthquake + geospatial heuristics |
| Database | PostgreSQL 15 (dev + prod; SQLite retired Apr 2026) |

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

Audio transcribed by Whisper, translated to English, geocoded by AI + Mapbox. Both recordings uploaded to dashboard. Caller phone number and telecom circle captured. Uses Twilio Voice API with TwiML.

---

## Credibility Check System (AI-Powered)

### On-Demand Assessment (Analyst-Triggered)
When an analyst clicks **"Credibility Check"**, the AI builds a 360° intelligence dossier from 8 data sections and produces a scored assessment:

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

### Intelligence Dossier (8 Sections Fed to the AI):
1. **Report Data** - infrastructure type, crisis type, damage classification, location
2. **Evidence** - photo, audio, description, data completeness %
3. **Reporter Profile** - badge level, report count, verified count, false alarm rate
4. **Satellite Verification** - truth score, scene description, key findings
5. **Corroboration** - nearby reports (quality-weighted), source diversity, temporal clustering
6. **Historical Context** - 30d/90d report count, false alarm rate, recurring location
7. **Service Status** - electricity, water, health services, pressing needs
8. **Urgency Signals** - response wait time, night report, batch submission detection

### Output:
- **Priority Level**: P1 (Immediate) → P5 (Likely False)
- **Confidence Score**: 0-100 with itemized breakdown (text + visual + satellite + corroboration + bonuses - penalties)
- **Lives at Risk Estimate**: Based on infrastructure type and damage level
- **Key Factors + Risk Flags**: Explainable reasoning
- **ℹ️ Logic Transparency**: Click to see full score breakdown math

### AI also infers:
- `infrastructure_type` (9 categories including SCHOOL/TELECOM/GOVERNMENT)
- `severity` (CRITICAL/SEVERE/MODERATE/MINOR)
- `crisis_type` (EARTHQUAKE/FLOOD/CONFLICT/HURRICANE/etc.)
- `damage_classification` (NO_DAMAGE/PARTIAL/COMPLETE)
- These update the report classification automatically

---

## Predictive Intelligence Dashboard

AI-powered multi-signal risk forecasting that predicts future crises before they happen.

### Data Sources (5 Signals):
| Signal | Source | What It Provides |
|--------|--------|-----------------|
| Historical | CRISP database | Past reports (90d), crisis types, severity trends, false alarm rates |
| Weather | OpenWeatherMap API | 5-day rainfall, wind, temperature, alerts, anomalies |
| Seismic | USGS Earthquake API | Recent quakes (7d/30d), magnitude, depth within 200km |
| Geospatial | Computed heuristics | Flood zone detection, coastal proximity, elevation, landslide risk |
| Conflict | CRISP conflict reports | Conflict intensity and trends from CRISP data |

### Output per Zone:
- **Risk Score**: 0-100 with level (LOW/MEDIUM/HIGH/CRITICAL)
- **Predicted Crisis Type**: FLOOD, EARTHQUAKE, CONFLICT, etc.
- **Time Window**: 24h / 72h / 7 days
- **Contributing Factors**: Top 5 with specific data points
- **Signal Breakdown**: Weighted scores per signal source
- **Recommended Action**: "Pre-position flood rescue boats" etc.
- **Full Reasoning**: the AI's multi-paragraph analysis

### Dashboard Features:
- Prediction heatmap overlay on map (blue→cyan→yellow→orange→purple)
- Zone cards with score rings, signal bars, factor lists
- Detail modal with full breakdown + prediction history
- Time window selector (24h / 3d / 7d)

### Prompt Caching
All the LLM API calls use `cache_control: {"type": "ephemeral"}` on static system prompts:
- **Geocoder**: Place name correction examples cached (~90% savings)
- **Satellite Scorer**: Scoring rubric cached (~90% savings)
- **AI Assessment**: Scoring rules + format cached (~90% savings)

---

## Quick Start

### Prerequisites
- Python 3.10+
- A modern browser (Chrome, Safari, Firefox)
- **PostgreSQL 15** - via Docker Compose (zero host install) or Homebrew.
  SQLite was retired Apr 2026; see `docs/MIGRATIONS.md` for why.

### 1. Clone & Configure
```bash
git clone https://github.com/your-org/crisp-platform.git
cd crisp-platform
cp .env.example .env
# Edit .env with your API keys (see API Keys section)
```

### 2. Provision Postgres (one-time)
```bash
bash scripts/dev-setup.sh
```
This installs/starts Postgres 15 (Docker Compose preferred, Homebrew
fallback on macOS), creates the `crisp` role + database, and runs
`alembic upgrade head`. Sets the correct `DATABASE_URL` for you.

### 3. Run Locally
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
| **OpenWeatherMap** | Weather forecasts for predictions | [openweathermap.org](https://openweathermap.org/api) |
| **USGS** | Seismic data (free, no key) | [earthquake.usgs.gov](https://earthquake.usgs.gov/) |

---

## Data Model

```
Report
  +-- Location (GPS coords, device vs. geocoded, place names)
  +-- Media[] (IMAGE, AUDIO - adaptive chunked upload 1KB-512KB)
  |     +-- MediaChunk[] (base64 packets with DJB2 checksum)
  +-- AIAnalysis (Whisper transcription, AI summary, damage labels)
  +-- SatelliteVerification (truth score, component breakdown, satellite metadata)
  +-- ai_assessment (JSON - priority, confidence, score breakdown, key factors, reasoning)
  +-- caller_info (JSON - phone number, network city/state for IVR/SMS)
  +-- UNDP fields: crisis_type, damage_classification, infrastructure_name, debris_clearing, service_status, building_id
  +-- ReporterProfile (gamification: badge_level, report_count, verified_count)

User (Enterprise Auth)
  +-- Organization (multi-tenant, SSO config)
  +-- UserSession[] (device tracking, refresh tokens)
  +-- AuthAuditLog[] (all actions logged)

PredictionZone
  +-- PredictionResult[] (risk score, signal breakdown, contributing factors, reasoning)
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

- **No PII collected from reporters**: Device identified by anonymous hash only
- **Zero registration for reporting**: Anyone can report via any channel - no login required
- **Enterprise auth for dashboard**: Email + OTP login, JWT sessions, RBAC (Super Admin/Admin/Analyst/Viewer)
- **SSO ready**: Architecture supports Okta, Auth0, Azure AD, Keycloak (SAML/OIDC)
- **GDPR compliant**: Data export, account deletion, consent management, 30-day deletion grace
- **Brute force protection**: Account lockout after 5 failed attempts (15 min cooldown)
- **OTP security**: 6-digit, 10 min expiry, max 5 attempts, 3 requests/10 min rate limit
- **Audit trail**: Every login, logout, role change, dispatch, and deletion logged with IP + user agent
- **PII blur**: MediaPipe BlazeFace (faces) + easyocr (text) - 100% local, zero API cost
- **API keys**: Stored in `.env`, excluded from git via `.gitignore`

---

## Project Structure

```
crisp-platform/
  backend/
    app/
      api/endpoints/
        reports.py           # Report CRUD, credibility check, building versioning
        auth.py              # Registration, login, OTP, JWT, GDPR, admin, SSO
        exports.py           # CSV, GeoJSON, Shapefile, KML export
        predictions.py       # Predictive intelligence zones + forecasting
      models/
        report.py            # Report, Location, Media, AIAnalysis, ReporterProfile
        auth.py              # User, Organization, OTP, Session, AuditLog
        prediction.py        # PredictionZone, PredictionResult
      core/
        security.py          # JWT, bcrypt, OTP generation, SMTP email
        deps.py              # Auth dependencies (require_viewer, require_analyst, etc.)
      services/
        prediction_engine.py # Multi-signal prediction (weather, seismic, historical, geospatial)
        truth_scorer.py      # the AI satellite truth verification
        satellite_fetcher.py # Sentinel-2 + Mapbox imagery
        pii_blur.py          # Face + text blur (MediaPipe + easyocr)
      schemas/               # Pydantic request/response validation
      db/                    # SQLAlchemy session + engine
    requirements.txt
  crisp-mobile/              # React Native (Expo) iOS/Android app
  mobile-app/src/            # Offline-first PWA (Vanilla JS)
  web-dashboard/src/
    index.html               # Dashboard layout
    login.html               # Auth login/register page
    app.js                   # Main dashboard logic
    predictions.js           # Predictive intelligence UI
    styles.css               # All styles
  messaging-bot/
    telegram/                # Telegram bot (9 languages, guided flow)
    whatsapp/                # WhatsApp Cloud API webhook
    sms/                     # SMS gateway + AI geocoder
    ivr/                     # IVR voice call webhook (TwiML)
    ai_extractor.py          # AI text extraction
    chunked_uploader.py      # Adaptive chunked media upload (1KB-512KB)
  docker-compose.yml         # Production deployment
  .env.example               # API key template
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## License

Apache License 2.0 - see [LICENSE](LICENSE) for details.

Built for the UNDP InnoCentive Challenge on Rapid Community Damage Assessment.
