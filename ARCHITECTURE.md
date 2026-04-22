# CRISP Architecture

## System Overview

CRISP is a multi-channel crisis reporting platform with 3 layers:

```
                    INTAKE LAYER                    PROCESSING LAYER              DECISION LAYER
           ┌─────────────────────────┐     ┌──────────────────────────┐    ┌─────────────────────┐
           │  Mobile PWA             │     │  FastAPI Backend         │    │  Web Dashboard       │
           │  Telegram Bot           │────>│  Whisper Transcription   │───>│  Map + Clusters      │
           │  WhatsApp Bot           │     │  Claude AI Geocoding     │    │  AI Assessment       │
           │  SMS Gateway            │     │  Chunked Media Assembly  │    │  Satellite Verify    │
           │  IVR Voice Call         │     │  PostgreSQL 15           │    │  PDF Export          │
           └─────────────────────────┘     └──────────────────────────┘    └─────────────────────┘
```

## Data Flow

### 1. Report Ingestion (per channel)

**Mobile PWA:**
```
User captures photo/audio/text/GPS
  -> IndexedDB (offline queue)
  -> POST /api/v1/reports/meta (metadata first, <1KB)
  -> PATCH /api/v1/reports/{id}/chunk (1KB base64 chunks with DJB2 checksum)
  -> Backend assembles chunks -> triggers Whisper transcription
```

**Telegram Bot:**
```
User sends photo/audio/video/text/location to @CRISPBot
  -> Long-polling receives update
  -> Media downloaded from Telegram API
  -> POST /api/v1/reports/meta
  -> Chunked upload via chunked_uploader.py
  -> Video split: ffmpeg extracts audio + thumbnail
```

**WhatsApp Bot:**
```
User sends message to WhatsApp Business number
  -> Webhook receives notification
  -> Media downloaded from Meta Graph API (with Bearer token)
  -> POST /api/v1/reports/meta
  -> Chunked upload
```

**SMS Gateway (Twilio):**
```
User sends SMS: "Flood near Koramangala bridge, urgent"
  -> Twilio webhook POST
  -> Keyword parser extracts type/severity/location
  -> Nominatim + Claude AI geocoding
  -> POST /api/v1/reports/meta
```

**IVR Voice Call (Twilio):**
```
Twilio calls user (or user calls Twilio number)
  -> TwiML: "Say your location" (Record, auto-stop 10s silence)
  -> TwiML: "Describe your problem" (Record, auto-stop 20s silence)
  -> TwiML: "Thank you, goodbye" (Hangup)
  -> Background: Download WAV -> Whisper transcribe (translate to English)
  -> Claude AI fixes place names -> Mapbox geocodes
  -> POST /api/v1/reports/meta (with caller_info: phone, network location)
  -> Chunked upload both audio recordings
```

### 2. AI Processing Pipeline

```
Report Created
  |
  ├── Whisper: Audio -> English text (task="translate")
  |
  ├── Claude Haiku (geocoder): Fix mangled place names
  |     "bath deep balia" -> "Bansdih, Ballia, UP"
  |     Uses prompt caching (system prompt cached)
  |
  ├── Mapbox: Geocode corrected name -> lat/lng
  |
  └── [ADMIN TRIGGERED]:
        |
        ├── "Verify via Satellite":
        |     Sentinel Hub STAC API -> fetch satellite image
        |     Mapbox -> fetch alt satellite image
        |     Claude Haiku (vision): Compare satellite + ground photo
        |     Returns: 0-100 score, 4 sub-scores, verdict
        |     Uses prompt caching (scoring rubric cached)
        |
        └── "AI Assessment":
              Claude Sonnet: Multi-signal cross-verification
              Inputs: text, photo analysis, satellite, nearby reports, caller ID
              Source-aware weights (IVR/SMS not penalized for no photo)
              Returns: confidence_score, suggested_action, inferred_type/severity
              Stored in DB permanently (one-time per incident)
              Uses prompt caching (system rules cached)
```

### 3. Dashboard Rendering

```
Poll /api/v1/reports/ every 10s
  -> Merge into allReports[]
  -> Update Leaflet map markers
  -> Render tree view (Region -> Type -> Incidents)
  -> On incident click: render detail panel
       -> Top bar: AI Assessment result OR "Run AI Assessment" button
       -> Evidence: Photo + satellite toggle
       -> Audio players + transcription
       -> Location + caller info
       -> Source details
```

## Database Schema

```sql
devices          -- Anonymous device hashes
reports          -- Core incident data + ai_assessment JSON + caller_info JSON
locations        -- GPS coordinates + place names
media            -- IMAGE/AUDIO with assembly status
media_chunks     -- 1KB base64 packets with seq_num + checksum
ai_analysis      -- Whisper transcription + AI summary
satellite_verifications  -- Truth scores + satellite metadata
```

## API Cost Optimization

| Call | Model | When | Caching |
|------|-------|------|---------|
| Geocoder | Haiku | Auto on IVR/SMS | System prompt cached |
| Satellite Scorer | Haiku | Admin click | Scoring rubric cached |
| AI Assessment | Sonnet | Admin click (once) | System rules cached |

**Removed:** AI Extractor (was auto-running on every IVR/SMS report). Now the AI Assessment handles classification when admin triggers it.

**Per-incident API calls:** 1 automatic (geocoder) + 2 on-demand (satellite + assessment)

## Security Model

- No user accounts or PII collection
- Devices identified by anonymous SHA-256 hash
- Caller phone stored only for IVR/SMS (needed for rescue callback)
- API keys in `.env`, never in code
- CORS configured for specific origins in production
