# Web Push setup runbook

The CRISP backend ships with the Web Push code paths in place but the
push-delivery feature is **gated on three env vars being set**. Until
those vars land in the production environment, `GET /api/v1/push/vapid-public`
returns `{ enabled: false, key: "" }` and the PWA silently skips the
permission prompt — i.e., everything degrades gracefully and nothing
breaks. The platform stays healthy even with zero VAPID config.

This runbook walks through enabling push end-to-end.

## 0 · Prerequisites

You need:
- Shell access to a checkout of the backend (the keypair script is
  pure Python + cryptography, no live DB needed).
- Permission to add secrets to AWS Secrets Manager (or the equivalent
  for whatever the deployment uses) AND to the GitHub Actions
  workflow secrets.
- A maintainer email address that you're OK with push providers
  contacting if our traffic looks abusive.

Time estimate: **~10 minutes the first time, ~1 minute on rotation.**

## 1 · Generate a VAPID keypair (once per environment)

```bash
cd backend
source venv/bin/activate
python scripts/generate_vapid.py
```

Output:

```
VAPID_PUBLIC_KEY=BNi8...long-base64url-string...
VAPID_PRIVATE_KEY=qV3K...long-base64url-string...

# Also set:
# VAPID_CONTACT_EMAIL=admin@yourdomain.example  # provider abuse-contact (RFC 8292 §2)
```

**Critical:** these strings are sensitive. Don't paste them into
Slack, email, or any commit. Open the AWS Secrets Manager console (or
the secret store the deploy uses) and create three keys:

| Key | Value | Visibility |
|---|---|---|
| `VAPID_PUBLIC_KEY`    | the first line, after `=` | safe to expose to clients |
| `VAPID_PRIVATE_KEY`   | the second line, after `=` | **sensitive** |
| `VAPID_CONTACT_EMAIL` | a real on-call mailbox | safe |

Even though the public key is "safe to expose," put it in Secrets
Manager too — that's where the rest of the deploy reads from, and you
don't want this drifting between environments.

## 2 · Wire the secrets into the running container

The `docker-compose.prod.yml` file expects the env vars to be in the
host environment when you run `docker compose up -d backend`. The
deploy workflow reads them from GitHub Actions secrets and exports
them on the EC2 host. Add the same three names to the GitHub repo
secrets:

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_CONTACT_EMAIL`

After they're set, redeploy:

```bash
gh workflow run "Deploy to Production" --ref main
```

The deploy script propagates the secrets into the systemd unit / docker-
compose env file on EC2. No code change needed.

## 3 · Verify end-to-end

```bash
# 3a. Backend reports VAPID as enabled.
curl -s https://undp.crisplabs.tech/api/v1/push/vapid-public | jq
# expected: { "key": "BNi8...", "enabled": true }

# 3b. From a real browser (Chrome/Firefox/Edge on Android, or Safari on
# iPhone WITH the PWA added to home screen):
#   1. Open https://undp.crisplabs.tech/mobile-app/src/
#   2. Submit a test report.
#   3. Permission prompt appears 2 seconds after the success screen.
#   4. Accept.
#   5. From the dashboard, dispatch a team for that report.
#   6. The device receives a "Help is on the way" notification within
#      a second or two.

# 3c. From the backend, eyeball the subscription row + last_pushed_at:
docker compose -f docker-compose.prod.yml exec -T db psql -U crisp -c \
  "SELECT id, device_hash, last_pushed_at, failure_count
   FROM push_subscriptions ORDER BY created_at DESC LIMIT 5;"
```

## 4 · Failure modes + how to read them

| Symptom | Likely cause | Fix |
|---|---|---|
| `vapid-public` returns `enabled: false` after step 2 | Secrets aren't reaching the container. | Check `docker compose -f docker-compose.prod.yml exec backend env \| grep VAPID`. |
| Permission prompt doesn't appear | `Notification.permission` is already `denied`, OR you're on iOS Safari without home-screen install, OR the user already accepted/declined once. | Reset site notifications in browser settings, then refresh. |
| PWA logs `PushManager.subscribe failed` | Public key is malformed (likely paste error). | Re-run step 1 fresh, re-paste in Secrets Manager. |
| No notification arrives despite a 200 from `/dispatch` | Provider returned 410 (subscription died) — see `failure_count` and missing rows in `push_subscriptions`. | Re-subscribe from the device. |
| Backend logs `[push] AUTH FAILURE (status=401)` | Wrong VAPID private key, OR system clock skew (provider rejects expired claims). | Verify `VAPID_PRIVATE_KEY` matches the public, check `chronyc tracking`. |

## 5 · Rotation

If the private key leaks, rotate immediately:

```bash
cd backend && python scripts/generate_vapid.py
# update the three secrets in Secrets Manager + GitHub
gh workflow run "Deploy to Production" --ref main
```

After the new keys are live, **every existing subscription becomes
invalid** — the public key embedded in each subscription endpoint URL
no longer matches the new VAPID identity. Tell users to re-subscribe
(reload the PWA; the subscription flow will re-fire automatically).

The backend will start receiving 410s from providers for the old
subscriptions and GC them on the fly — no manual cleanup needed.

## 6 · Why this is gated behind a manual step

VAPID keys are intrinsically per-environment secrets. Generating and
shipping a default keypair in the repo would be a security
regression: anyone with read access to the repo would be able to send
push notifications to users on the platform. The same reason
`JWT_SECRET` and `CRISP_ADMIN_KEY` are operator-set, not committed.
