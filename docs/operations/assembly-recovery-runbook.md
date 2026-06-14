# Assembly recovery - operator runbook

Diagnostic + intervention guide for the chunked-media assembly
pipeline. Use this when a row gets stuck in a non-terminal
`assembly_status` and the automated sweep can't make progress.

## Background

Every photo upload lands as a sequence of chunks
(`POST /api/v1/reports/{id}/media/{media_id}/chunk-bin`), reassembled
server-side into a single file. The reassembly path:

```
chunk POSTs → received_chunks++ → ON LAST CHUNK →
    Media.assembly_status = 'assembling' →
    _assembly_executor.submit(_try_full_assembly_bg) →
    on success: assembly_status = 'complete' + url set
    on failure: assembly_status = 'failed'
```

The recovery daemon (`backend/app/main.py:_run_assembly_recovery_sweep`)
runs every 5 minutes and applies four actions in order:

| Step | Filter | Action | Reason |
|---|---|---|---|
| ⓪ HC91 (May 2026) | `assembling`/`pending` + chunks complete + `created_at > 60 min ago` | flip to `failed`, abandon | wedged assembler - Action ① reviving forever |
| ① REVIVE | `assembling`/`failed` + chunks complete + `updated_at > 2 min ago` + not abandoned | flip to `pending` + re-submit | salvage worker crash mid-assembly |
| ② ABANDON worker-lost | `assembling` + chunks INCOMPLETE + `updated_at > 30 min ago` | flip to `failed`, abandon (`assembly_worker_lost`) | worker hung mid-stream, chunks won't complete |
| ③ ABANDON chunks-never-arrived | `pending` + chunks incomplete + `updated_at > 30 min ago` | flip to `failed`, abandon (`chunks_never_arrived`) | client never delivered final chunks |
| ④ PROMOTE PARTIAL → SYNCED | every photo_group has ≥ 1 complete variant + no Media activity in last 60 s | flip Report.sync_status | bandwidth-tier deferred uploads finalised |

All abandon paths increment the `media_abandon_reason_total{reason}`
Prometheus counter (when observability is wired).

## Symptoms → likely cause

| User-visible symptom | Likely state | First place to look |
|---|---|---|
| Dashboard shows "Original lost (network timeout)" | `assembly_status=failed`, `abandon_reason=chunks_never_arrived` | Step ③ - client tab closed |
| Dashboard shows "uploading…" forever | `assembly_status=assembling` or `pending`, not yet abandoned | Step ① / ② / ⓪ - depends on chunk completeness |
| PWA "queued" count never decreases | client-side `_reconcileBeforeDequeue` rejecting | HC88 `reconcileWaitTicks` cap (3 min) - also see HC90 send-attempts cap |
| Report appears, photos blank | `assembly_status=complete` but `url=''` | rare - server-side bug, file a Sentry issue |
| Abandon-rate alert (SLO § 4) | `media_abandon_reason_total` spike | this runbook |

## Diagnostic queries

Run against the PROD Postgres (read-only via the operator's psql alias):

### Count rows by state, last 24h

```sql
SELECT
  assembly_status,
  abandon_reason,
  COUNT(*) AS n,
  MIN(created_at) AS oldest,
  MAX(updated_at) AS most_recent
FROM media
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY assembly_status, abandon_reason
ORDER BY n DESC;
```

### Pinpoint stuck rows (chunks complete but not assembling)

```sql
SELECT
  id, report_id, type, chunk_count, received_chunks,
  assembly_status, abandon_reason,
  EXTRACT(EPOCH FROM NOW() - created_at) / 60 AS age_min,
  EXTRACT(EPOCH FROM NOW() - updated_at) / 60 AS idle_min
FROM media
WHERE chunk_count > 0
  AND received_chunks >= chunk_count
  AND assembly_status IN ('assembling', 'pending', 'failed')
  AND abandoned_at IS NULL
ORDER BY age_min DESC
LIMIT 20;
```

### Find rows that HC91 will abandon on next sweep tick

```sql
SELECT id, report_id, assembly_status, created_at,
       EXTRACT(EPOCH FROM NOW() - created_at) / 60 AS age_min
FROM media
WHERE assembly_status IN ('assembling', 'pending')
  AND chunk_count > 0
  AND received_chunks >= chunk_count
  AND abandoned_at IS NULL
  AND created_at < NOW() - INTERVAL '60 minutes';
```

If this query returns rows, the wedged-assembler check at the next
sweep tick will abandon them with `reason='assembler_wedged'`.

### Abandon-reason rate, last 7 days

```sql
SELECT
  abandon_reason,
  DATE_TRUNC('hour', abandoned_at) AS hour,
  COUNT(*) AS n
FROM media
WHERE abandoned_at > NOW() - INTERVAL '7 days'
GROUP BY abandon_reason, hour
ORDER BY hour DESC, n DESC;
```

Useful when SLO § 4 alerts fire - gives the per-hour distribution
so you can correlate spikes with deploy windows.

## Manual interventions

### 1. Trigger a sweep tick immediately

Don't wait for the 5-minute periodic tick. SSH to EC2 + invoke from
the running container:

```sh
docker exec crisp-backend-1 python3 -c "
import sys; sys.path.insert(0, '/app/backend')
from app.main import _run_assembly_recovery_sweep
_run_assembly_recovery_sweep(boot=False)
"
```

Output includes per-action counts (`revived N`, `abandoned M`, etc.).
Safe to run repeatedly - all actions are idempotent.

### 2. Force-revive an abandoned row (operator-authorised reclaim)

Used when the abandon was wrong (e.g. operator manually re-uploaded
the missing chunks via the F3 reclaim endpoint). The dashboard
exposes this via the per-row "Recover" action, but if the UI is
unavailable:

```sql
UPDATE media
   SET abandoned_at      = NULL,
       abandon_reason    = NULL,
       recovered_at      = NOW(),
       assembly_status   = 'pending'
 WHERE id = '<media_uuid>';
```

The next sweep tick's Action ① will then re-submit the row to the
executor pool. Logged via the `recovered_at` timestamp so the audit
trail shows it was operator-driven rather than automated.

### 3. Hard-fail a row the sweep can't catch

Rare: a row stuck in a state the four actions don't match (e.g.
`assembly_status='complete'` but `url=''` - a partial commit bug).
Use only after confirming the row is truly broken:

```sql
UPDATE media
   SET assembly_status = 'failed',
       abandoned_at    = NOW(),
       abandon_reason  = 'operator_intervention'
 WHERE id = '<media_uuid>';
```

Document the rationale in the operator log + file a Sentry issue
so the root cause can be patched.

### 4. Operator dry-run of HC91 wedged-abandon

If you suspect HC91 is over-firing (mass-abandoning legitimately
slow rows), check what it WOULD do before letting the next sweep
run:

```sql
SELECT id, report_id, assembly_status, created_at,
       chunk_count, received_chunks
FROM media
WHERE assembly_status IN ('assembling', 'pending')
  AND chunk_count > 0
  AND received_chunks >= chunk_count
  AND abandoned_at IS NULL
  AND created_at < NOW() - INTERVAL '60 minutes';
```

If the list is unexpectedly large (> a handful), bump the
`CRISP_ASSEMBLER_WEDGED_MIN` env var temporarily - e.g. `120` for
two hours of additional retry budget - and re-evaluate after a sweep
cycle:

```sh
docker exec -e CRISP_ASSEMBLER_WEDGED_MIN=120 crisp-backend-1 \
    python3 -c "from app.main import _run_assembly_recovery_sweep; \
                _run_assembly_recovery_sweep(boot=False)"
```

(For persistent change, edit `.env.production` + restart the container.)

## Escalation paths

| Trigger | Action | Owner |
|---|---|---|
| `assembler_wedged` rate > 5× rolling baseline | Diagnose: same media_id repeating? S3 5xx pattern? PII-blur OOM? | On-call |
| Sweep daemon not running (no logs in 10+ min) | `docker logs crisp-backend-1 \| grep "Assembly recovery"` + restart container | On-call |
| Postgres `media` table lock | Long-running query holding `media` exclusive lock; identify via `pg_stat_activity` + KILL | DBA + on-call |
| Abandoned-row mass-revival needed (post-incident) | UPDATE batch via psql against backup of `abandoned_at` snapshot; document in incident report | DBA + operator sign-off |

## Related references

- `backend/app/main.py:_run_assembly_recovery_sweep` - implementation
- `backend/tests/test_assembly_recovery_sweep.py` - pinned behaviour
- `docs/operations/SLOs.md` § 4 - abandon-rate SLO
- `mobile-app/src/app.js` HC88 (reconcile wait cap) + HC90 (send-attempts cap)
- Operator HAR from May 2026 (`/Users/pks/Desktop/api-log-1.har`) -
  the regression that motivated HC88+HC90+HC91
