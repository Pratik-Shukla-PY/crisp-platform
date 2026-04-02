# CRISP - Crisis Response Intelligence & Situation Platform

**Community-driven damage reporting for the first 48 hours of a crisis.**

CRISP is an open-source, offline-first platform that enables communities to capture, submit, and verify infrastructure damage data in real-time following sudden-onset crises. Built for the [UNDP InnoCentive Challenge](https://www.innocentive.com/) on rapid post-disaster damage assessment.

---

## What It Does

| Role | Tool | Purpose |
|------|------|---------|
| **Field Reporter** | Mobile PWA | Capture photos, record audio, classify damage, geolocate — works offline at 2Kbps |
| **QRT Operator** | Web Dashboard | Triage incidents, verify with satellite imagery, dispatch response teams |
| **Data Analyst** | Export API | Download CSV/GeoJSON for OCHA, ReliefWeb, or custom GIS pipelines |

### Key Capabilities

- **Offline-first**: Reports queue in IndexedDB, sync progressively when connectivity returns (even at 2Kbps)
- **Voice-first multilingual input**: Auto-detects local language from GPS, supports 47+ countries
- **AI-powered verification**: Satellite imagery (Sentinel-2/Maxar) cross-referenced with ground photos via Claude AI — produces a 0-100 truth score
- **Progressive media streaming**: QRT sees photos and audio arriving chunk-by-chunk in real-time
- **Real-time transcription**: Partial audio translated to English as chunks arrive (Whisper)
- **Crisis-grade UX**: Zero-scroll decision panel, one-tap dispatch, auto-submission on inactivity

---

## Architecture

```
Mobile PWA (Field)          FastAPI Backend              Web Dashboard (QRT)
-----------------          ----------------             -------------------
Photo capture      --->    Chunk assembly       --->    Live progressive view
Audio recording    --->    Whisper transcription --->    Real-time transcript
GPS + reverse geo  --->    SQLite/PostgreSQL     --->    Leaflet map + clusters
Offline queue      --->    Background sync       --->    Heatmap + satellite
                           Sentinel Hub API              CSV/GeoJSON export
                           Claude AI scoring
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Mobile App | Vanilla JS PWA, Service Worker, IndexedDB, Web Speech API |
| Backend API | Python 3.11, FastAPI, SQLAlchemy, Uvicorn |
| AI/ML | faster-whisper (local), Anthropic Claude (cloud), Sentinel Hub |
| Dashboard | Vanilla JS, Leaflet.js, Turf.js, leaflet.heat, MarkerCluster |
| Database | SQLite (dev) / PostgreSQL (prod) |
| Satellite | ESA Copernicus Sentinel-2 L2A (10m), Mapbox/Maxar (0.5m fallback) |

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
# Edit .env with your API keys (see below)
```

### 2. Run Locally

```bash
bash start.sh
```

This will:
- Create a Python virtual environment
- Install all dependencies
- Start the backend API on port 8000
- Start the static file server on port 8080
- Open both the mobile app and web dashboard in your browser

### 3. Access

| App | URL |
|-----|-----|
| Mobile App (Field Reporter) | http://localhost:8080/mobile-app/src/index.html |
| Web Dashboard (QRT Ops) | http://localhost:8080/web-dashboard/src/index.html |
| API Docs (Swagger) | http://localhost:8000/docs |

### 4. On a Real Phone (same Wi-Fi)

The start script prints your LAN IP. Open the mobile URL on your phone to test with real GPS and camera.

### 5. Stop

```bash
bash stop.sh
```

---

## Docker Deployment

```bash
docker compose up --build
```

Services:
- `backend` — FastAPI on port 8000
- `frontend` — Nginx serving both UIs on port 80
- `db` — PostgreSQL 15 (production-grade)

See [docker-compose.yml](docker-compose.yml) for full configuration.

---

## API Keys Required

| Service | Purpose | Free Tier | Get From |
|---------|---------|-----------|----------|
| **Anthropic** | AI truth verification (Claude Haiku) | Pay-per-use | [console.anthropic.com](https://console.anthropic.com/) |
| **Sentinel Hub** | Satellite imagery (Sentinel-2) | 30k requests/month | [apps.sentinel-hub.com](https://apps.sentinel-hub.com/) |
| **Mapbox** | Fallback satellite (Maxar) | 50k requests/month | [account.mapbox.com](https://account.mapbox.com/) |

Copy `.env.example` to `.env` and fill in your keys. Never commit `.env` to git.

---

## Data Model

```
Report
  +-- Location (GPS coords, device vs. user-corrected, place names)
  +-- Media[] (IMAGE, AUDIO — chunked upload with progress tracking)
  |     +-- MediaChunk[] (1KB base64 packets, checksummed)
  +-- AIAnalysis (Whisper transcription, damage labels, risk score)
  +-- SatelliteVerification (truth score, component breakdown, satellite metadata)
```

### Export Formats

- **CSV**: `id, type, severity, location, description, created_at, status, confidence`
- **GeoJSON**: Standard FeatureCollection with point geometries and full metadata

---

## Offline Behavior

1. **No internet**: Report saved to IndexedDB with photo thumbnail + full audio
2. **2Kbps connection**: Metadata syncs first, then media uploads in 1KB chunks with resume
3. **Full connectivity**: High-res photo + original audio uploaded, AI pipeline triggered
4. **Background sync**: Service Worker retries every 30 seconds until all data delivered

The mobile app is a **Progressive Web App** — installable on Android/iOS home screen, works completely offline after first load.

---

## Satellite Verification

When a QRT operator clicks "Verify & Report":

1. Sentinel-2 image fetched for the report's GPS coordinates (30-day window)
2. Mapbox/Maxar image fetched as alternate source for comparison
3. Claude AI analyzes both satellite + ground photo + audio transcription + description
4. Produces a **0-100 truth score** with 4 components:
   - Location authenticity (0-25)
   - Damage corroboration (0-25)
   - Description coherence (0-25)
   - Data quality (0-25)
5. Verdict: Strongly Corroborated / Likely Authentic / Partially Verified / Low Confidence / Unverified

---

## Security & Privacy

- **No PII collected**: Device identified by anonymous hash only
- **No user accounts**: Zero registration barrier for crisis reporters
- **Data minimization**: Only GPS, photos, audio, and damage classification stored
- **Anonymized exports**: No device identifiers in CSV/GeoJSON output
- **API keys**: Stored in `.env`, excluded from git via `.gitignore`

For production deployment: enable HTTPS via reverse proxy (Nginx/Caddy), encrypt database at rest, configure CORS to specific origins.

---

## Project Structure

```
crisp-platform/
  backend/
    app/
      api/endpoints/     # FastAPI route handlers
      models/            # SQLAlchemy ORM models
      schemas/           # Pydantic request/response schemas
      services/          # AI, satellite, truth scoring services
      core/              # Config, settings
      db/                # Database session, engine
    requirements.txt
  mobile-app/
    src/
      index.html         # PWA entry point
      app.js             # Full mobile app logic
      styles.css          # Mobile styles
      sw.js              # Service worker (offline + sync)
      manifest.json      # PWA manifest
  web-dashboard/
    src/
      index.html         # Dashboard entry point
      app.js             # Dashboard logic (map, feed, detail panel)
      styles.css          # Dashboard styles
      sw.js              # Dashboard service worker
      world.json         # GeoJSON world boundaries
  start.sh               # Local development launcher
  stop.sh                # Clean shutdown
  docker-compose.yml     # Production deployment
  Dockerfile             # Backend container
  .env.example           # Template for API keys
  LICENSE                # Apache 2.0
  CONTRIBUTING.md        # Contribution guidelines
```

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on submitting issues, feature requests, and pull requests.

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.

Built for the UNDP InnoCentive Challenge on Rapid Community Damage Assessment.
