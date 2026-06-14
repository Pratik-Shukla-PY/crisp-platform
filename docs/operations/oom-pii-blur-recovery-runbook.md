# OOM crash-loop + stuck PII-blur (425) - operator runbook

Diagnostic + intervention guide for the May 2026 production incident:
multi-image uploads drove the backend out of memory, the host
OOM-killed `uvicorn` repeatedly, and a subset of images got stranded at
`pii_blur_status='pending'` - served as a perpetual **425 Too Early**
("Checking PII…" broken image) on the dashboard.

Use this when: the dashboard shows images stuck on "Checking PII", the
backend container is restart-looping, or `dmesg` shows OOM kills.

## Background - root cause

The public media route gates on blur status:

```
GET /api/v1/reports/media/{id}/file
  pii_blur_status == 'pending'  → 425 Too Early (Retry-After: 2)
  any terminal status           → 302 → presigned S3 / /static
```

(The 425 exists so an unblurred, mid-pipeline image is never served -
UNDP must-have #7.)

The incident chain:

```
multi-image upload → partial-preview pipeline ran the FULL PII blur
  (MediaPipe + easyocr/PyTorch) on EVERY partial render (~every 10
  chunks) → blur storm → uvicorn RSS ≈ 3.5 GB on a 3.75 GB host
  (Swap: 0) → kernel global OOM kills uvicorn → container restarts →
  in-memory _ai_executor blur queue lost → those Media rows stay
  pii_blur_status='pending' forever → /file returns 425 forever.
```

A single camera shot = one small blur = no spike = fine. The storm only
appeared with multiple images (especially gallery multi-select) where
many partial-renders blurred concurrently.

## The fix (this hotfix - branch `hotfix/pii-blur-gate` off v34)

Four layers, memory-first:

| Layer | Change | File |
|---|---|---|
| 1 - kill the storm | `_try_partial_image_bg` returns immediately unless `CRISP_PARTIAL_PREVIEW=1`. No more full blur on every partial render - each image runs ONE final blur. (Bonus: a disabled partial can never serve an unblurred progressive frame.) | `backend/app/api/endpoints/reports.py` |
| 1 - reclaim RSS | `gc.collect()` after each `_run_server_pii_blur` so cv2/PyTorch per-call tensors don't ratchet | `backend/app/api/endpoints/reports.py` |
| 2 - container guardrail | `mem_limit: 3g` + `memswap_limit: 5g` on the backend service - a future spike can only OOM-kill (and auto-restart) THIS container, never the host/redis/nginx | `docker-compose.prod.yml` |
| 3 - recovery sweep | `_run_pii_blur_recovery_sweep` (boot + every 5 min) drains orphaned `pending` rows so a restart self-heals the 425 backlog | `backend/app/main.py` |
| 4 - one-shot drainer | `scripts/drain_stuck_pii_blur.py` clears the existing backlog on demand | `backend/scripts/` |

### The recovery sweep - PII-safe by construction

`_run_pii_blur_recovery_sweep` runs at boot and every
`_ASSEMBLE_SWEEP_INTERVAL_S` (5 min), alongside the assembly sweep:

| Step | Filter | Action | Reason |
|---|---|---|---|
| ① GIVE UP | `pending` + assembled + **`client_blur_applied=true`** + `updated_at > CRISP_PII_BLUR_WEDGED_MIN` (60 min) | flip to `failed` | lifts the 425; client-side-blurred bytes are served (PII-safe); red "redaction failed" chip |
| ② RE-DRIVE | `pending` + assembled + **`client_blur_applied=true`** + has-url + `STALE_MIN (5) < age < WEDGED_MIN (60)` | re-submit `_run_server_pii_blur` to `_ai_executor` | salvage a blur orphaned by an OOM restart |
| ③ HOLD (visibility) | `pending` + assembled + **`client_blur_applied=false`** + age > WEDGED_MIN | log a warning, **do nothing** | server blur is the ONLY face protection - never auto-lift (would expose a raw face) |

The `client_blur_applied` split is the load-bearing PII guard. PWA
uploads are client-blurred (BlazeFace before upload) → safe to un-gate.
Non-client-blurred rows (Telegram/WhatsApp/SMS, if any) stay gated at
425 - image lost-but-safe - until a server blur naturally completes.

## IMMEDIATE mitigation (no code, no deploy - do this first)

PROD is crash-looping? Stop the bleeding **before** deploying. All
reversible:

### Add 4 GB swap (host has none - this alone stops the OOM kills)

```sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile \
  && sudo mkswap /swapfile && sudo swapon /swapfile
# persist across reboot:
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
# verify:
free -m   # Swap row should now be ~4096
```

Reverse: `sudo swapoff /swapfile && sudo rm /swapfile` (and remove the
fstab line).

### Optional: halve concurrent blur memory immediately

```sh
docker compose -f docker-compose.prod.yml exec -e CRISP_AI_WORKERS=1 \
  -T backend true   # or set in .env.production + restart for persistence
```

### Confirm the OOM was real

```sh
sudo dmesg | grep -iE "out of memory|oom-kill|killed process" | tail -20
docker inspect crisp-backend-1 --format '{{.RestartCount}} {{.State.OOMKilled}}'
```

## Deploy (approval-gated - requires explicit "deploy to prod")

The hotfix is additive only (no migration). Per `the project invariants`, never push
without an explicit in-chat deploy confirmation.

1. PR `hotfix/pii-blur-gate` → `origin/main`, merge. (Because the
   multi-tenant commits were never pushed, the PR diff is ONLY this
   hotfix.)
2. Deploy via the normal path (`deploy.yml` on push-to-main, auto-
   rollback) **or** on the box:
   ```sh
   cd ~/crisp && git pull
   docker compose -f docker-compose.prod.yml up -d --force-recreate backend
   ```
3. On boot, `_run_pii_blur_recovery_sweep(boot=True)` runs automatically
   and re-drives the client-blurred backlog - no manual drainer needed
   in the common case.

## Post-deploy verification

```sh
# 1. Container healthy, not restart-looping:
docker ps | grep backend            # "(healthy)" within 60s
docker inspect crisp-backend-1 --format '{{.RestartCount}}'   # stops climbing

# 2. Boot sweep ran:
docker logs --since 3m crisp-backend-1 2>&1 | grep -i "PII-blur recovery"

# 3. Memory cap applied:
docker inspect crisp-backend-1 --format '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}'
#   → 3221225472 5368709120   (3g / 5g)

# 4. No more 425s on the stuck ids (replace <id>):
curl -sI https://undp.crisplabs.tech/api/v1/reports/media/<id>/file | head -1
#   → HTTP/2 302   (was 425)
```

Then open the dashboard, click a previously-broken report → image
renders.

## Manual interventions

### Trigger a sweep tick immediately (don't wait 5 min)

```sh
docker exec crisp-backend-1 python3 -c "
import sys; sys.path.insert(0, '/app/backend')
from app.main import _run_pii_blur_recovery_sweep
_run_pii_blur_recovery_sweep(boot=False)
"
```

Idempotent; logs per-action counts.

### Drain the existing backlog on demand

Dry-run first (changes nothing):

```sh
docker compose -f docker-compose.prod.yml exec -T backend \
  python /app/backend/scripts/drain_stuck_pii_blur.py
```

Lift the 425 NOW for client-blurred rows (DB-only, instant, red chip;
safe during an active OOM window - no ML deps, no memory pressure):

```sh
docker compose -f docker-compose.prod.yml exec -T backend \
  python /app/backend/scripts/drain_stuck_pii_blur.py --confirm
```

Re-blur to a clean green status instead of a red chip (heavier - loads
the blur stack, runs one row at a time; prefer post-deploy / post-swap):

```sh
docker compose -f docker-compose.prod.yml exec -T backend \
  python /app/backend/scripts/drain_stuck_pii_blur.py --confirm --mode redrive
```

Target one report's media:

```sh
... drain_stuck_pii_blur.py --confirm --report-id <uuid>
```

⚠ `--include-unblurred` also acts on `client_blur_applied=false` rows.
In `fail` mode that serves the stored bytes AS-IS, which **may contain
raw faces**. Only use it if you have confirmed the source is trusted /
contains no people. Default behaviour leaves those rows safely gated.

## Diagnostic queries

```sql
-- How many images are stuck at the 425 gate, split by client-blur?
SELECT client_blur_applied,
       COUNT(*) AS n,
       MIN(updated_at) AS oldest
FROM media
WHERE type = 'IMAGE'
  AND pii_blur_status = 'pending'
  AND assembly_status = 'complete'
GROUP BY client_blur_applied;
```

```sql
-- Pinpoint the stuck rows (what the dashboard is 425-ing on).
SELECT id, report_id, client_blur_applied,
       EXTRACT(EPOCH FROM NOW() - updated_at) / 60 AS age_min
FROM media
WHERE type = 'IMAGE'
  AND pii_blur_status = 'pending'
  AND assembly_status = 'complete'
ORDER BY age_min DESC
LIMIT 20;
```

## Tuning knobs (env vars)

| Var | Default | Effect |
|---|---|---|
| `CRISP_PARTIAL_PREVIEW` | `0` | `1` re-enables the partial-preview blur. **Leave at 0** until a memory-safe partial path exists - re-enabling restores the storm. |
| `CRISP_PII_BLUR_STALE_MIN` | `5` | minutes before a `pending` row is re-driven |
| `CRISP_PII_BLUR_WEDGED_MIN` | `60` | minutes before a `pending` client-blurred row is given up (→ `failed`, 425 lifts) |
| `CRISP_AI_WORKERS` | `2` | blur/phash/AI-pipeline executor concurrency. Set `1` for extra memory headroom on the 3.75 GB host (serializes blur; throughput cost accepted). |

## Rollback

The change is additive + behind defaults that match the safe state:

- Revert the merge commit (or `git revert`) → redeploy. No migration to
  unwind.
- Or, without a redeploy, set `CRISP_PARTIAL_PREVIEW=1` to restore the
  old partial-preview behaviour (NOT recommended - reintroduces the
  storm). The sweep + drainer are inert when there are no stuck rows.
- Keep the 4 GB swap regardless - it is pure upside on a 3.75 GB host.

## Escalation paths

| Trigger | Action | Owner |
|---|---|---|
| Container still OOM-looping after deploy + swap | Confirm `mem_limit` applied (verify step 3); drop `CRISP_AI_WORKERS=1`; consider resizing 3.75 GB → 8 GB | On-call |
| Stuck-`pending` count keeps growing post-deploy | Sweep not running? `docker logs … \| grep "PII-blur recovery"`; trigger a manual tick | On-call |
| Many `client_blur_applied=false` rows held (③) | Non-PWA channel uploading faces with no server blur completing - investigate the blur backend (MediaPipe/easyocr import health); do NOT mass `--include-unblurred` without sign-off | On-call + operator |
| Raw face suspected served | Check the row's `client_blur_applied`; if false + status≠pending, withhold + file an incident - this is a must-have #7 breach | Operator |

## Related references

- `backend/app/main.py:_run_pii_blur_recovery_sweep` - implementation
- `backend/app/api/endpoints/reports.py:_run_server_pii_blur` /
  `_try_partial_image_bg` / `get_media_redirect` (the 425 gate)
- `backend/scripts/drain_stuck_pii_blur.py` - one-shot drainer
- `backend/tests/test_pii_blur_recovery_sweep.py` - pinned behaviour
- `docs/operations/assembly-recovery-runbook.md` - sibling sweep
- UNDP must-have #7 (PII protection) - `the project invariants`
