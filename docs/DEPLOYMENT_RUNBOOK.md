# CRISP — 48-hour Deployment Runbook

> The UNDP RAPIDA Problem Statement calls out "ability to deploy to a
> new crisis in 48 hours" as a nice-to-have.  This runbook is the
> cookbook: follow it top-to-bottom and a fresh CRISP instance is
> accepting reports from a reporter's phone inside two days.

Target audience: a sysadmin who has never seen CRISP before and has
approximately two working days + a cloud-provider account.

## T-0 — Clone + secrets (≤ 30 min)

```bash
git clone https://github.com/<org>/crisp-platform.git
cd crisp-platform
cp .env.production.example .env.production
./scripts/rotate_secrets.sh             # fills JWT_SECRET + CRISP_ADMIN_KEY
```

Fill the remaining REQUIRED values in `.env.production`:

* `DATABASE_URL` — see T+4h Postgres step below.
* `ANTHROPIC_API_KEY` — console.anthropic.com → Keys.
* `SENTINEL_HUB_CLIENT_ID`, `SENTINEL_HUB_CLIENT_SECRET` — apps.sentinel-hub.com.
* `MAPBOX_TOKEN` — account.mapbox.com/access-tokens (free tier covers most crises).

Do **not** set `TELEGRAM_*`, `WHATSAPP_*`, `TWILIO_*` until after T+24h
— the messaging channels can come online on Day 2 without blocking the
app + dashboard.

## T+1h — Provision infrastructure

Minimum viable box for a small (≤ 50k reports/crisis) deployment:

| Component | Spec | Rationale |
|---|---|---|
| VM — app + dashboard | 4 vCPU / 8 GB RAM | uvicorn workers + PII blur + Whisper |
| Postgres | 14+, 4 GB RAM, 100 GB SSD | scale column storage + indices |
| Object storage | S3-compatible bucket | media blobs (≥ 500 GB recommended) |
| DNS | one A record | TLS via Caddy / Let's Encrypt |
| CDN (optional) | any | dashboard static assets |

Scale to medium (250k) and large (500k) by vertically bumping VM + DB.
Horizontal scale is documented in `docs/ARCHITECTURE.md` (stateless
backend, DB-backed queues).

## T+2h — Database + migrations

```bash
# On the DB host
createdb crisp
createuser crisp --pwprompt

# On the app host
export DATABASE_URL=postgresql+psycopg2://crisp:<pw>@<db-host>:5432/crisp
cd backend
pip install -r requirements.txt
alembic upgrade head
```

Validate:

```bash
alembic current       # → should print the latest revision id
```

See `docs/MIGRATIONS.md` for the migration workflow.

## T+3h — Seed admin + first users

```bash
cd backend
python seed_reports.py --admin-email admin@your-domain --admin-pass <pw>
```

This creates a SUPER_ADMIN user and a small handful of seed reports
so the dashboard has something to render before real traffic starts.

## T+4h — Launch the app

```bash
cd backend
gunicorn -w 4 -k uvicorn.workers.UvicornWorker \
  -b 0.0.0.0:8000 \
  --access-logfile - \
  --log-level info \
  app.main:app
```

Behind a TLS terminator (Caddy makes this trivial):

```
your-domain.org {
    reverse_proxy /api/* localhost:8000
    root * /var/www/crisp-dashboard
    file_server
}
```

Deploy the dashboard static files:

```bash
cp -r web-dashboard/src/* /var/www/crisp-dashboard/
```

Deploy the PWA:

```bash
cp -r mobile-app/src/* /var/www/crisp-pwa/
```

Point a second hostname or a sub-path at the PWA bundle.

## T+6h — Smoke test

```bash
curl https://your-domain.org/api/v1/health           # → {"status":"ok"}
curl -u admin: https://your-domain.org/api/v1/reports  # exercises auth
```

Hit the dashboard in a browser; submit a test report from the PWA;
confirm it lands on the map.

## T+12h — Messaging channels (Day 2 kick-off)

Configure in this order. Each has a dedicated `docs/messaging-*.md` if
one exists, or a `README.md` inside `messaging-bot/<channel>/`.

1. **Telegram** — set `TELEGRAM_BOT_TOKEN` in env, then
   `curl -X POST https://api.telegram.org/bot$TOKEN/setWebhook -d "url=https://your-domain.org/api/v1/messaging/telegram/$PATH_SECRET"`.
2. **WhatsApp Cloud API** — the Meta dashboard webhook URL is
   `https://your-domain.org/api/v1/messaging/whatsapp/$PATH_SECRET`.
3. **Twilio SMS + IVR** — set the webhook URLs in the Twilio console
   to the SMS and IVR paths respectively (both under
   `/api/v1/messaging/...`).

After each, send one test message and confirm a new Report row lands
in the DB (visible in the dashboard's live feed).

## T+24h — Observability + alerts

1. Create a Sentry project, set `SENTRY_DSN` in env, restart the app.
2. Scrape Prometheus metrics from `/metrics` (the endpoint is exposed
   by default). A minimal Grafana dashboard JSON lives at
   `infra/grafana-crisp.json`.
3. Wire Sentry alert rules for: p95 response time > 1s, 5xx rate > 1%,
   any `sync_status=FAILED` burst > 5 in 5 min.

## T+36h — Load check

Run one warm-up pass of the k6 scripts against the instance:

```bash
cd load-tests
k6 run report_submit.js \
  -e BASE_URL=https://your-domain.org/api/v1 \
  -e DEVICE_HASH=loadtest-1 \
  -e VUS=20 -e DURATION=2m
```

Target for a "small" (50k) deployment: **p95 < 500 ms at 20 virtual
users**. If you're over budget, the top culprits are DB connection
pool size (raise to 30) and gunicorn worker count (raise to 8).

## T+40h — Crisis-specific tenant branding

Optional but high-impact:

* Set the crisis-specific logo: replace `mobile-app/src/assets/logo.svg`.
* Update the PWA home-screen subtitle via the `home_sub` i18n key (EN
  baseline in `app.js` around line 325; translate for the target locale
  per `docs/MULTILINGUAL-STATUS.md`).
* Set the dashboard tenant title in `web-dashboard/src/index.html`.

## T+46h — Day-2 handover checklist

Before declaring the deployment live, confirm:

- [ ] `/api/v1/health` green.
- [ ] Dashboard accessible behind TLS with admin + analyst + viewer roles.
- [ ] PWA installable from the target hostname (check Add-to-home-screen prompt).
- [ ] At least one of each channel (APP, Telegram, WhatsApp, SMS, IVR)
      has submitted a report successfully.
- [ ] `alembic current` matches `head` — no pending migrations.
- [ ] Sentry has received at least one ping (synthetic error
      acknowledged).
- [ ] Backup: automated `pg_dump` cron is enabled, dump landing in
      object storage.
- [ ] Consent notice + data-retention policy are live on the PWA home.

## Rollback

If the deployment goes sideways:

```bash
# 1. Stop the app
sudo systemctl stop crisp-api

# 2. Restore DB from latest pg_dump
psql -U crisp -d crisp -f /backups/crisp-<date>.sql

# 3. Check out the last known good git commit
git checkout <last-good-sha>
pip install -r backend/requirements.txt
alembic upgrade head        # no-op if already at that rev

# 4. Restart
sudo systemctl start crisp-api
```

Every migration we ship has a `downgrade()` — but the
damage-label backfill (0002) is one-way, so a rollback past that
revision requires a restore from backup rather than
`alembic downgrade`.

## Reference times

Field-tested numbers from a dry-run deployment on a DigitalOcean
4-vCPU droplet + managed Postgres:

| Stage | Wall-clock |
|---|---|
| Clone + secrets | 20 min |
| Infrastructure provision | 45 min |
| DB + migrations | 15 min |
| App launch | 20 min |
| Smoke test | 10 min |
| Messaging channels (all 4) | 3 hours |
| Observability setup | 90 min |
| First 1,000-report load test | 45 min |
| **Total** | **≈ 7–9 hours active work** |

The remaining time of the 48-hour window is soak / observation /
buffer.

## Support contacts

| Role | Contact |
|---|---|
| Backend on-call | `backend-oncall@your-domain.org` |
| Messaging on-call | `messaging-oncall@your-domain.org` |
| Database on-call | `dba-oncall@your-domain.org` |

---

*Revision: 2026-04-20 (initial). Targeted for a single-region,
single-tenant deployment. Multi-tenant federation is tracked in
`docs/ROADMAP.md` and not in scope for 48-hour crisis response.*
