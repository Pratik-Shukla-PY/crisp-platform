# CRISP — Security & Privacy Design

> **Scope**: UNDP Crisis Mapping Challenge submission v2.1 (Apr 2026).
> Owner: engineering team. Audience: UNDP evaluators + deploying
> partners + downstream NGO reviewers.

This document explains how CRISP meets UNDP's "**Secure data handling
and hosting: compliance with global data security standards and privacy
practices**" must-have clause. Every claim here is backed by a
file path in the repo — no aspirational text, no future-work.

---

## 1. Threat model (STRIDE)

| Threat                     | Mitigation                                                                                                          | Code / evidence                                                                 |
|----------------------------|---------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------|
| **S**poofing               | JWT auth; Refresh-token rotation; WhatsApp/Telegram/SMS webhook signature verification                              | `app/core/security.py`, `messaging_bot/whatsapp/webhook.py::_verify_signature`  |
| **T**ampering              | HTTPS-only in prod; DB integrity via per-chunk `djb2` checksums; CHECK constraint on MediaChunk payload              | `app/api/endpoints/reports.py::attach_media_chunk`, migrations 0004            |
| **R**epudiation            | `auth_audit_log` table — every LOGIN/LOGOUT/DELETE/FAILED_LOGIN, IP, user-agent, 30-day retention                     | `app/models/auth.py::AuthAuditLog` + `app/api/endpoints/auth.py::_audit`        |
| **I**nformation disclosure | Face-blur at-source (BlazeFace in-browser/RN) + server MediaPipe + easyocr safety net; no PII in URL params          | `pii-blur.js`, `app/services/pii_blur.py`, `/api/v1/health/pii`                 |
| **D**oS                    | Per-IP + per-device rate limits (30/min meta, 180/min chunk); Nginx/ALB rate-limit layer above                        | `app/main.py::check_rate_limit`, `docs/DEPLOYMENT_RUNBOOK.md#rate-limits`       |
| **E**levation of privilege | Role-based auth (SUPER_ADMIN / ADMIN / ANALYST / VIEWER); `require_admin` dependency on every mutating admin route  | `app/core/deps.py::require_analyst`, `require_admin`                            |

---

## 2. PII flow — where personal data can exist, for how long, and what protects it

```
                  ┌─────────────── CAPTURE ────────────────┐
  Camera ──► PWA/RN ──► BlazeFace (face-blur)              │
  Voice  ──►          └─► Base64 → IndexedDB queue         │  All on-device.
  GPS    ──►             (ephemeral; cleared on send)      │  Never leaves.
                  └─────────────────────────────────────────┘
                              │
                              ▼ HTTPS (TLS 1.2+, ACM cert)
                  ┌───────── INGEST ───────────────────────┐
  /reports/meta   ──►  rate-limit ──► Pydantic validate    │
  /media/chunk-bin ─►  multipart ──► per-chunk checksum    │
                              │                             │
                              ▼                             │
                  ┌───────── ASSEMBLY ────────────────────┐ │
                  │ _assemble_media_file                  │ │
                  │   ├─► PII-blur safety net (MediaPipe) │ │
                  │   ├─► easyocr text redaction          │ │
                  │   ├─► pHash → redundancy fingerprint  │ │
                  │   └─► /static/<id>.jpg OR S3 object   │ │
                  └───────────────────────────────────────┘ │
                              │                             │
                              ▼                             │
                  ┌─────── STORAGE (Postgres + S3) ───────┐ │
                  │ reports.*, media.*                    │ │
                  │ retention: soft-delete + 24h grace    │ │
                  │ purge worker → hard-delete every 15m  │ │
                  └───────────────────────────────────────┘ │
                              │                             │
                              ▼                             │
                  ┌────────── ACCESS ─────────────────────┐ │
                  │ Dashboard (JWT)                        │ │
                  │ Exports (CSV / GeoJSON / KML / PDF)    │ │
                  │ CloudWatch (structured logs — no PII)  │ │
                  └────────────────────────────────────────┘ │
                  └─────────────────────────────────────────┘
```

### 2.1 What is captured

| Data class             | Captured? | Form                                       |
|------------------------|-----------|--------------------------------------------|
| Name / email / phone   | **No**    | CRISP has no user-login step for reporters |
| Device fingerprint     | Opaque    | `device_hash` = random UUID, not IMEI      |
| GPS                    | Yes       | lat/lng (± accuracy metres)                |
| Photo                  | Yes       | Face-blurred at-source                     |
| Voice memo             | Optional  | Transcribed via Whisper; raw kept ≤ 24 h   |
| Description text       | Optional  | Auto-translated to EN for dashboard        |

### 2.2 What is **not** captured

- No IMEI, SIM, MAC, advertising ID, browser fingerprint.
- No IP-address-based location lookup on the client — the device may
  fall back to IP-geolocation for a coarse map pin, but the IP itself
  is never persisted beyond the single request's audit log entry.
- No contact list, calendar, saved-password access.
- No third-party ad trackers, analytics beacons, or SDKs.

---

## 3. Retention & deletion (GDPR-aligned)

| Artefact                | Retention                                   | Delete path                                                               |
|-------------------------|---------------------------------------------|---------------------------------------------------------------------------|
| Report metadata         | Soft-delete + 24 h grace                    | `DELETE /reports/{id}` → `deletion_requested_at` set                      |
| Media files             | Same grace window, then disk unlink         | `_purge_expired_deletions` (15-min cron)                                  |
| Audio raw bytes         | 24 h after transcription                    | Background worker at `app/services/transcription.py`                      |
| Audit log               | 30 days rolling                             | Postgres scheduled `DELETE FROM auth_audit_log WHERE created_at < now() - 30d` (see `DEPLOYMENT_RUNBOOK.md`) |
| Device deletion (GDPR) | Immediate + cascade to reports + media files| `DELETE /reports/device/{hash}` → `delete_device_data`                    |

Tests pinning each: `tests/test_auth_gdpr.py`, `tests/test_purge_worker_integration.py`, `tests/test_status_polling.py::TestDeviceDeletion`.

---

## 4. Secrets & key management

| Secret                   | Source in prod         | Rotation cadence                    | Code ref                                    |
|--------------------------|------------------------|-------------------------------------|---------------------------------------------|
| `JWT_SECRET`             | AWS Secrets Manager    | 90-day rotation via `scripts/rotate_secrets.sh` | `app/core/security.py:12`              |
| `CRISP_ADMIN_KEY`        | AWS Secrets Manager    | On-demand (purge/admin endpoints)   | `app/api/endpoints/auth.py::require_admin_key` |
| `ANTHROPIC_API_KEY`      | AWS Secrets Manager    | Per-key quotas; rotated on leak     | `app/services/ai_service.py`                |
| `TWILIO_AUTH_TOKEN`      | AWS Secrets Manager    | 180 days                            | `messaging_bot/sms/webhook.py`              |
| `TELEGRAM_BOT_TOKEN`     | AWS Secrets Manager    | On compromise                       | `messaging_bot/telegram/webhook.py`         |
| `WHATSAPP_APP_SECRET`    | AWS Secrets Manager    | On compromise                       | `messaging_bot/whatsapp/webhook.py`         |
| DB credentials           | RDS IAM auth (preferred) or Secrets Manager | 90 days           | `app/db/session.py`                         |
| S3 access                | IAM Role attached to Fargate / EC2          | N/A (no keys)     | `app/services/storage.py` (adapter, W2)     |

`JWT_SECRET` < 64 chars → boot refusal (`app/core/security.py:52`).
Production boot refuses `CORS_ORIGINS=*` and any URL-embedded DB password
(see `app/main.py::_validate_prod_bootstrap`).

---

## 5. Data residency

- RDS + S3 deployed in one AWS region per UNDP-partner's jurisdiction.
  No cross-region replication unless explicitly requested.
- Client-side Leaflet tiles fetch from CartoDB / OSM public endpoints —
  no CRISP data flows to those third parties; URL params only carry
  `{z}/{x}/{y}` tile coordinates.
- Messaging webhooks (Twilio, Telegram, WhatsApp) transit via their
  respective platforms; CRISP stores only the parsed content, not the
  raw transport metadata.
- For regulated jurisdictions (EU), AWS Frankfurt (`eu-central-1`) is
  the default. Switch via `AWS_REGION` Terraform variable.

---

## 6. Transport & at-rest encryption

| Channel / storage            | Encryption                                                                |
|------------------------------|---------------------------------------------------------------------------|
| Browser ↔ API                | TLS 1.2+ enforced at ALB; HSTS with 1-year max-age                        |
| RN app ↔ API                 | Same (Expo HTTPS)                                                         |
| Telegram/WhatsApp/Twilio ↔ API | Platform HTTPS (Telegram enforces; WhatsApp signed per-payload)           |
| API ↔ RDS                    | `sslmode=require` in the psycopg2 DSN                                     |
| RDS at rest                  | AWS-managed KMS (default RDS encryption); snapshots encrypted             |
| S3 at rest                   | AES-256 (SSE-S3) on bucket default; versioning + lifecycle policy enabled |
| Local disk fallback (dev)    | No encryption — **dev only**; production uses S3                          |

---

## 7. Input validation & sanitisation

- Every API payload goes through Pydantic validators (`app/schemas/report.py`)
  with explicit bounds (`lat -90..90`, `radius_km > 0 ≤ 2000`, text
  length limits, ENUM membership).
- File uploads: magic-byte sniff before PIL decode; size cap via
  `MAX_FILE_SIZE_BYTES` (default 25 MB); unknown MIME → 415.
- SQL: SQLAlchemy ORM only; no raw-string composition outside Alembic
  migrations. Parameterised bind params verified via
  `grep -n "f\".*SELECT" app/**/*.py` = 0 hits.
- HTML in reports.description is escaped via `escapeHtmlSimple` before
  dashboard render (`web-dashboard/src/app.js`).

---

## 8. Abuse + anti-gaming posture

- Per-device rate limit: 30 report submissions/min (`app/main.py:check_rate_limit`).
- Per-IP rate limit on chunk uploads: 180/min (typical capture needs < 10).
- Badge / reputation keyed on `verified_count`, NOT submission volume —
  a bad-faith user flooding duplicates never earns status
  (`docs/INCENTIVES.md`, `tests/test_reporter_profile_counter.py::TestUNDPQualityBasedCredibility`).
- Perceptual-hash dedup (W3, Apr 2026) flags near-duplicate photos
  within the same building + 24 h window; dashboard surfaces the
  candidate cluster so the analyst can suppress repeats
  (`app/services/phash.py`, `tests/test_phash_dedup.py`).

---

## 9. Observability & incident response

- Structured JSON logs via structlog; every request carries a
  request-id; no raw PII in log payloads.
- Prometheus `/metrics` endpoint, scraped by Grafana Cloud:
  - `chunk_transport_total{transport,outcome}`
  - `pii_blur_runs_total{outcome}`
  - `pii_blur_queue_depth`
- Sentry DSN wired in `app/main.py` (optional; operator-set).
- `/api/v1/health/pii` + `/api/v1/health/db` surfaces backend liveness
  for external canaries.

---

## 10. What CRISP deliberately does NOT do

- Store raw voice memos indefinitely. Transcript is canonical; raw
  audio is purged after 24 h.
- Accept arbitrary file uploads beyond the declared image/audio MIME
  set.
- Expose device_hash → device correlation on the public dashboard.
- Pass user data to third-party analytics, ad networks, or A/B-testing
  services.
- Ship with default passwords. All bootstrap is via explicit env vars;
  the app refuses to boot in `APP_ENV=production` if any required
  secret is missing.

---

## 11. Open questions / known limits

- **WhatsApp Business API approval** is Meta-controlled; lead time 3–14
  days. CRISP's deployment plan assumes the operator completes this
  before go-live; until then, WhatsApp submissions 404 without data loss.
- **CLOUDHSM / FIPS 140-2** is not enabled by default; recommend for
  UNDP deployments handling OCHA-classified data.
- **Granular audit retention per region** — today the 30-day cron is
  global; multi-region deployment should tune per jurisdiction.

---

**Review cadence**: this document is regenerated + signed off each
sprint alongside the CHANGELOG. Last regenerated: 2026-04-22.
