# CLAUDE.md — CRISP

Project memory for Claude Code. Auto-loaded every session. Edit when an
architectural rule changes; do **not** track day-to-day work here.

## Project

Crisis Response Intelligence Smart Platform. UNDP InnoCentive Challenge
submission (deadline **2026-06-23 23:59 ET**, $50k award).

Citizen reports → multi-channel ingestion (PWA / RN / WhatsApp / Telegram /
SMS / IVR) → AI classification → satellite truth-scoring (Claude vision +
AWS Sentinel-2 / Microsoft Planetary Computer / ESA Copernicus / Mapbox) →
GIS export (CSV / GeoJSON / Shapefile / KML).

Stack: FastAPI + Postgres + boto3/S3, vanilla-JS dashboard + PWA, React
Native (Android/iOS), Playwright + axe-core + Lighthouse CI.

PROD: `https://undp.crisplabs.tech` (EC2). Dev: `localhost:{8000,8080}`.

UNDP rubric source of truth: `../Problem Statement.pdf` (parent of repo).
Award is contingent on UNDP independently testing the MVP against
must-haves (1–7). **Never regress them.**

## UNDP must-haves (NEVER regress)

1. **Multi-channel parity** — PWA, Android (RN), WhatsApp, Telegram, SMS,
   IVR all produce the same `Report` row shape. New fields ship across
   every channel or get flagged as "App-only".
2. **6 UN languages** — Arabic, Chinese, English, French, Russian,
   Spanish. Every visible string ships in
   `mobile-app/src/i18n/{ar,zh,en,fr,ru,es}.json`. CI gates parity.
3. **Offline-first** — PWA accepts submissions with no network. Service
   worker queues, retries on reconnect. `41-offline-strict.spec.ts` is
   blocking.
4. **Damage taxonomy** — `MINIMAL / PARTIAL / COMPLETE` only. Backed by
   `DamageClassEnum`. No free-text.
5. **Crisis taxonomy** — `CrisisTypeEnum` only (Earthquake, Flood, Tsunami,
   Hurricane, Wildfire, Explosion, Chemical, Conflict, CivilUnrest). New
   values require UNDP sign-off.
6. **Building footprints (UNDP must-have #6)** — reporter MUST be able to
   tap an OSM footprint to set `building_id`. Free-text fallback only when
   OSM is unreachable; flag with `infrastructure_name_from_osm=false` so
   the dashboard surfaces "needs mapping".
7. **PII protection (§2.9)** — faces blurred CLIENT-SIDE before upload
   (BlazeFace via `mobile-app/src/pii-blur.js`). Server NEVER receives
   raw faces. The `client_blur_applied` flag travels with each chunk.
8. **Building versioning** — multiple reports for same `building_id`
   bias to latest COMPLETE; older versions kept for audit
   (`building_version_ordinal`, `building_is_latest`).
9. **Anonymity** — submission must always work without login. PII fields
   (email/phone) are ADMIN-only.
10. **Soft delete + 24h grace** — `deletion_requested_at` gates
    visibility; hard delete only via admin purge endpoint.
11. **Export columns** — CSV / GeoJSON / Shapefile / KML always include
    the 6 satellite verification columns (`satellite_verdict`, etc).
12. **Scale targets** — backend designed for 500k reports/crisis,
    hundreds of crises/year. No unbounded N+1; always `joinedload` +
    indexed columns. `X-Total-Count` header on listing endpoints.
13. **Open source** — repo is Apache-2.0. No proprietary deps.

## AI usage rule (UNDP-stated)

> "Submissions produced SOLELY with generative AI are not of interest."

Claude is a coding assistant; humans drive intent. Commit messages
explain the **why**, not "AI generated this." `Co-Authored-By:
Claude Opus 4.7 (1M context)` trailers are allowed and honest.

## Architecture invariants (DO NOT BREAK)

- **Storage I/O via abstraction** — always `_get_media_storage()` /
  `app.services.storage.get_storage()`. Never `os.path.join(UPLOAD_DIR,
  ...)` against a `media.url` value. That pattern silently broke
  `verify_report` on S3 — see commit `e1fd3e1`.
- **Stable URLs in API responses** — never embed presigned S3 URLs in
  JSON. Use stable backend routes:
  - Media: `/api/v1/reports/media/<id>/{file|thumb}` (commit `391d5c5`)
  - Satellite: `/api/v1/reports/<id>/satellite/{primary|alt|grid/<idx>}`
    (commit `e1fd3e1`)
  Both 302 → fresh presigned target with `Cache-Control: public,
  max-age=3600`.
- **Dashboard URL handling** — never hard-code
  `${BACKEND_HOST}${url}`. Always pipe through `getMediaUrl()` in
  `web-dashboard/src/app.js`.
- **Postgres-only** — no SQLite fallback. The seatbelt in
  `backend/tests/conftest.py` blocks any DSN whose database name does
  not end in `_test`.
- **Pydantic v2 idioms** — `field_serializer(when_used="json")`,
  `SerializationInfo.field_name` for field-aware logic,
  `model_validator(mode="before")` for ORM-attribute decoding.
- **No `@app.on_event`** — deprecated. Use lifespan handlers.
- **Service worker bumping** — any change to `STATIC_ASSETS` in
  `mobile-app/src/sw.js` MUST bump `CACHE_NAME` (`v80 → v81`).
  Without this, returning users get stale assets forever.
- **Auth model for stable-URL endpoints** — auth-free by design. The
  resource id is a UUID; listing ids still requires Bearer auth via
  `/api/v1/reports/`.
- **Conditional GET** — `/api/v1/reports/` honours `?since=<iso>` +
  `If-None-Match: <etag>` → 304 with no body. Idle polls cost <100 B
  on the wire.

## Test commands

```sh
# Backend (full suite ~3 min, 480+ tests)
cd backend && source venv/bin/activate && pytest

# Backend single
pytest tests/test_satellite_verification_urls.py -v
pytest -k "evidence" --tb=short

# Dashboard / PWA JS syntax
node -c web-dashboard/src/app.js
node -c web-dashboard/src/evidence.js
node -c mobile-app/src/app.js
node -c mobile-app/src/sw.js

# E2E
cd e2e && npx playwright test --project=dashboard
npx playwright test --project=pwa
npx playwright test tests/dashboard/06-satellite-verification.spec.ts

# Lighthouse local
lhci collect --config=./lhci.config.cjs && lhci assert
```

## Database safety

- `PYTEST_DATABASE_URL` MUST end in `_test`. Conftest seatbelt refuses
  otherwise.
- Dev default: `MEDIA_BACKEND=local` (uses `backend/uploads/`). PROD:
  `s3` (EC2 IAM instance profile, no static creds).
- Migrations: only `alembic upgrade head`, PR-reviewed. Verified
  against `crisp_test` first.
- Never `DROP SCHEMA` or `git push --force` on `main`/`origin/main`.

## Env-file safety (Phase 24+, after the AWS_REGION outage)

- **Backend refuses to start if required env vars are missing.**
  See `_validate_required_env()` at the top of
  `backend/app/main.py`. Required set: `MEDIA_BACKEND`, plus
  `AWS_S3_BUCKET` + `AWS_REGION` when `MEDIA_BACKEND=s3`. If a
  required var is missing the container exits with code 1 and
  docker-compose's healthcheck flips red within 60 s — auto-rollback
  catches the broken state BEFORE it reaches user traffic.
- **Always run `bash scripts/verify-env.sh .env.production`** after
  any operator edit, BEFORE `docker compose up`. It diffs the env
  file against the required-vars manifest and flags missing keys,
  quoted values (docker-compose may parse the quotes literally),
  and CRLF line endings. Exits non-zero on any problem.
- **Never quote env values.** `AWS_REGION=ap-south-1` works;
  `AWS_REGION='ap-south-1'` and `AWS_REGION="ap-south-1"` may or
  may not work depending on the docker-compose version.
- **Never hand-edit on EC2 without a backup.** `cp .env.production
  .env.production.bak` first; restore on failure.
- **The `TWILIO_FROM` ↔ `TWILIO_PHONE_NUMBER` alias** is the only
  pair-equivalent variable; either satisfies the outbound-SMS
  requirement. See `messaging-bot/sms/webhook.py`.

## Post-deploy operator checklist (any phase that touches infra)

After `docker compose up -d --force-recreate backend`:
1. `docker ps | grep backend` → status reads "(healthy)" within 60s.
2. `docker logs --since 2m crisp-backend-1 2>&1 | grep -iE "FATAL|error|exception"` → empty (no startup crash).
3. `docker exec crisp-backend-1 python3 -c "import sys; sys.path.insert(0,'/app/backend'); from app.services.storage import get_storage; s=get_storage(); print(type(s).__name__, getattr(s,'bucket','?'), getattr(s,'region','?'))"` → prints `S3Storage <bucket> <region>` without raising.
4. `curl https://undp.crisplabs.tech/api/v1/ivr/status` → 200 with `twilio_configured: true`.
5. Open the dashboard, click any report with media → image renders + audio plays (catches storage 500s the way Phase 23 missed).

## Secret hygiene during operator checklists

**Never paste raw `.env.production` contents into AI chats, PRs, issues,
or any logged surface.** When `verify-env.sh` flags problems (e.g.
quoted-values warning), paste only the validator's *header* output:

```
✓ all 12 required vars present
⚠ missing recommended (degraded features): SENTRY_DSN
✗ some values are quoted ...
```

The body of the warning includes the actual env values, which echo
plaintext secrets (DB password, JWT secret, Twilio token, Anthropic
key, etc.). If any of those land in a logged surface, treat them as
compromised and rotate immediately. Phase 25.2 retro (May 2026) — a
verify-env.sh failure paste leaked all 12 production secrets;
emergency rotation followed.

## Commit conventions

- Conventional Commits: `feat(area):`, `fix(area):`, `perf(area):`,
  `chore(area):`, `docs(area):`.
- HEREDOC for multi-line bodies (preserves formatting under `set -e`).
- `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
  when AI-assisted.
- NEVER `--no-verify`. Pre-commit hooks gate secrets (gitleaks), lint,
  typecheck.
- NEVER amend pushed commits. Make a new commit.
- One logical change per commit. Phase A and Phase B+C ship as
  separate commits even when developed in the same session.

## File pointer cheat-sheet

```
Reports API        backend/app/api/endpoints/reports.py     (~4100 lines, 30+ routes)
Schemas            backend/app/schemas/report.py
Storage            backend/app/services/storage.py
Truth scoring      backend/app/services/truth_scorer.py     (Claude vision)
Satellite chain    backend/app/services/satellite_fetcher.py (4-provider fan-out)
Exports            backend/app/api/endpoints/exports.py
Auth               backend/app/api/endpoints/auth.py
Channels           messaging_bot/{whatsapp,telegram,sms,ivr}/

Dashboard          web-dashboard/src/app.js                 (~4800 lines)
Evidence (public)  web-dashboard/src/evidence.{html,js}     (no auth)
Login              web-dashboard/src/login.html
Dashboard CSS      web-dashboard/src/styles.css

PWA                mobile-app/src/app.js                    (~9000 lines)
PII blur           mobile-app/src/pii-blur.js
Building select    mobile-app/src/building-select.js
Service worker     mobile-app/src/sw.js
i18n               mobile-app/src/i18n/{ar,zh,en,fr,ru,es}.json

React Native       react-native-app/src/

Backend tests      backend/tests/
E2E tests          e2e/tests/{pwa,dashboard,prod,backend}/
CI                 .github/workflows/{ci,deploy,lighthouse}.yml
LHCI config        lhci.config.cjs
Session plans      /Users/pks/.claude/plans/
```

## Submission checklist (do not ship without these)

- [ ] Pitch video ≤ 2 min: photo → damage class → geolocation on map →
      export.
- [ ] MVP at TRL ≥ 4 (we are at TRL 6+).
- [ ] All 6 UN languages render in PWA + dashboard.
- [ ] Offline submission demonstrated (kill network mid-capture; queue
      drains on reconnect).
- [ ] Building-footprint selector functional against OSM.
- [ ] Client-side PII blur visible (face redacted in preview before
      upload).
- [ ] Satellite verification produces verdict + share-evidence link.
- [ ] CSV + GeoJSON exports include verification columns.
- [ ] Lighthouse PROD a11y ≥ 90 (dashboard + PWA).
- [ ] All `e2e/tests/prod/00-prod-smoke.spec.ts` pass against
      `https://undp.crisplabs.tech`.
- [ ] Repo is Apache-2.0; `LICENSE` present at root.
- [ ] No proprietary deps in `requirements.txt` /
      `package.json`.

## Workflow notes for Claude sessions

- Use plan mode for non-trivial multi-file changes. Plan files land in
  `/Users/pks/.claude/plans/`; reference them in commit messages when
  helpful.
- Spawn explore agents for "where does X live?" questions; cheaper than
  re-deriving every session.
- Run the relevant test slice locally before committing. Full sweep is
  ~3 min — worth it before push.
- After push, `gh run watch <id>` then `gh run view <id> --json` to
  confirm CI + deploy + lighthouse all green. PROD auto-rollback fires
  if prod-smoke or lighthouse regress.
