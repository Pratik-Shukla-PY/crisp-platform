# Secret Management - CRISP Backend

This document covers the two server-side secrets that the backend refuses to
boot without in production (Sprint 1 / P1.2 + P1.8):

| Env var            | Purpose                                                |
|--------------------|--------------------------------------------------------|
| `JWT_SECRET`       | HS256 signing key for access + refresh tokens          |
| `CRISP_ADMIN_KEY`  | Guards admin-only endpoints (purge, audit, user list)  |

The backend also reads `APP_ENV`:

- `APP_ENV=production` (default) - both secrets are **required**. Missing or
  weak values abort the boot.
- `APP_ENV=dev` - missing values generate an ephemeral dev secret and log a
  loud warning. Tokens invalidate on every restart.

---

## Rotation procedure

### Local / single-server deploy

```bash
cd /path/to/crisp-platform
./scripts/rotate_secrets.sh --write-env   # replaces values in backend/.env
systemctl restart crisp-backend           # or: pkill -HUP -f uvicorn
```

After restart:
- All existing JWTs are invalid. Users are forced to log in again.
- All refresh tokens are invalid.
- Admin tools that used the old `CRISP_ADMIN_KEY` must be updated.

### Safer rotation (zero-downtime, when we move to load-balanced AWS)

1. Generate new values but do **not** yet apply them:
   ```bash
   ./scripts/rotate_secrets.sh > /tmp/new-secrets.env
   ```
2. Store the new values in AWS Secrets Manager alongside the current ones
   (e.g. `crisp/jwt-secret-next`).
3. Roll out a backend version that accepts **both** current and next secrets
   when verifying tokens (current implementation only accepts one - extending
   this is a Phase 3 task, track in GitHub as `phase3/jwt-key-rollover`).
4. Once all instances are on the dual-accept build, promote `-next` to the
   primary slot. Wait for max token TTL (30 min access + 30 days refresh) or
   force re-auth.
5. Remove the old value from Secrets Manager.

---

## Where secrets actually live

- **Repo:** `backend/.env` (gitignored - verified with `git ls-files | grep .env`
  returning only `.env.example`).
- **Example template:** `backend/.env.example` - tracked in git, does NOT
  contain real values. Every new env var must be added here.
- **Production (when we move to AWS - Sprint 5):** AWS Secrets Manager,
  injected into the task definition as env vars. No secrets in AMI, user-data,
  or container image layers.

---

## Rotation cadence

- **Minimum:** once per quarter.
- **Immediate** if any of:
  - a server log file with env vars was shared outside the team
  - a former contributor had production env access
  - a dependency in `requirements.txt` had a known supply-chain compromise
  - a penetration test flagged the current value

---

## Manual verification after rotation

```bash
# 1. Confirm backend boots
curl -sSf http://localhost:8000/api/v1/health
# 2. Old token should 401
curl -s -H "Authorization: Bearer $OLD_TOKEN" http://localhost:8000/api/v1/reports/
# → {"detail":"Invalid or expired token"}
# 3. New login works
curl -sX POST http://localhost:8000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"test@crisp.undp.org","password":"..."}'
```

---

## Related files

- `scripts/rotate_secrets.sh` - generator / in-place rotator.
- `backend/app/core/security.py` - JWT config, fail-fast check.
- `backend/app/main.py` - admin-key config, fail-fast check.
- `backend/.env.example` - template showing all required env vars.
