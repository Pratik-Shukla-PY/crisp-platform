# Disaster Recovery — Backup, Restore, RTO/RPO

Runbook for backing up PROD, verifying restorability, and recovering
from data loss. Complements `docs/DEPLOYMENT_RUNBOOK.md` § Rollback
(which covers code rollback, not data loss).

Last reviewed Sprint 3D, May 2026. Re-validate after any schema
migration that touches the photo / media / report tables.

---

## Data classes — what we back up + where

| Class | Where | Frequency | Retention | Encryption |
|---|---|---|---|---|
| Postgres logical dump | S3 (`s3://crisp-backups/postgres/`) | hourly (cron on EC2) | 7 days hourly + 30 days daily + 12 months monthly | SSE-S3 (AES-256 at rest) |
| Postgres WAL archives | S3 (`s3://crisp-backups/postgres-wal/`) | continuous (archive_command) | 7 days | SSE-S3 |
| Media (uploaded photos + audio) | S3 (`s3://crisp-media/`, **primary** storage) | n/a — primary | versioning ON, 90-day lifecycle to glacier | SSE-S3 + IAM bucket policy |
| Env files | NOT BACKED UP (regenerated from a 1Password vault) | n/a | n/a | n/a |
| Git history (source) | GitHub | continuous | indefinite | TLS in transit |

**Recovery Point Objective (RPO):** ≤ 1 hour for Postgres state.
With WAL archives + hourly dumps, we can replay to any point in
the last 7 days.

**Recovery Time Objective (RTO):** ≤ 2 hours from "outage declared"
to "PROD healthy on new infrastructure".

---

## Postgres backup strategy

### 1. Hourly logical dump

Cron entry on the EC2 host (set up post-Sprint 3D):

```cron
# /etc/cron.d/crisp-backup-postgres
0 * * * * crisp /usr/local/bin/crisp-pg-backup.sh >> /var/log/crisp-backup.log 2>&1
```

`crisp-pg-backup.sh` (to be added to `scripts/ops/` as part of the
implementation; flagged out-of-scope for Sprint 3D doc but the
shape is):

```sh
#!/usr/bin/env bash
set -euo pipefail
TS=$(date -u +%Y%m%dT%H%M%SZ)
KEY="postgres/crisp-${TS}.sql.gz"

docker exec crisp-db-1 pg_dump -U crisp -F p --no-owner --no-acl crisp \
  | gzip --best \
  | aws s3 cp - "s3://crisp-backups/${KEY}" \
      --storage-class STANDARD_IA \
      --metadata "git-sha=$(git -C /opt/crisp rev-parse HEAD)"

# Retention pruning — keep last 168 hourly + last 30 daily + last 12 monthly
aws s3 ls "s3://crisp-backups/postgres/" \
  | python3 /opt/crisp/scripts/ops/prune-backups.py
```

### 2. WAL archiving

`postgresql.conf` on PROD (set by the operator post-pilot):

```conf
wal_level = replica
archive_mode = on
archive_command = 'aws s3 cp %p s3://crisp-backups/postgres-wal/%f \
                   --storage-class STANDARD_IA'
archive_timeout = 60   # force WAL switch every minute (RPO bound)
```

Combined with the hourly logical dumps, point-in-time recovery (PITR)
to any second within the last 7 days is possible.

---

## Media (S3) — backed up by S3 itself

The media bucket (`crisp-media`) uses S3 versioning + a lifecycle
policy. We do NOT separately dump it because:

1. S3 is already 99.999999999% durable across 3 AZs.
2. Versioning protects against accidental overwrite / delete.
3. Cross-region replication (CRR) can be enabled for region-failure
   protection — flagged as a separate Sprint 3D follow-up if the
   pilot expands to multi-region.

Lifecycle:
- Day 0-90: Standard
- Day 91-365: Glacier Instant Retrieval
- Day 366+: Glacier Deep Archive

---

## Restore procedures

### Procedure A — Full PROD restore (worst-case)

Use when PROD EC2 + DB are both gone (region outage, ransomware, etc.).

```sh
# 1. Spin up new EC2 + RDS / postgres container in the target region
#    (terraform / manual; out of scope here).

# 2. Restore the latest hourly logical dump:
LATEST=$(aws s3 ls s3://crisp-backups/postgres/ | sort | tail -1 | awk '{print $4}')
aws s3 cp "s3://crisp-backups/postgres/${LATEST}" - \
  | gunzip - \
  | docker exec -i crisp-db-1 psql -U crisp -d crisp

# 3. If finer RPO than the hourly dump is needed (e.g. 5-min granularity),
#    apply WAL replay on top:
#    (PITR setup is out of scope here — see Postgres docs for the
#    recovery_target_time configuration)

# 4. Run migrations to current head — backups predate the latest
#    schema if the dump was taken before the last `alembic upgrade`:
docker exec crisp-backend-1 alembic upgrade head

# 5. Smoke test from the dashboard:
curl https://undp.crisplabs.tech/api/v1/ivr/status   # expect 200
docker exec crisp-backend-1 python3 -c "
from app.db.session import SessionLocal
from app.models.report import Report
s = SessionLocal()
print('Reports:', s.query(Report).count())
"
```

### Procedure B — Single-row recovery

A specific Report or Media row was deleted by mistake. Restore just
that row from the latest dump WITHOUT touching the rest:

```sh
# 1. Find the dump that has the row (hourly = last hour, daily = older).
LATEST=$(aws s3 ls s3://crisp-backups/postgres/ | sort | tail -1 | awk '{print $4}')
aws s3 cp "s3://crisp-backups/postgres/${LATEST}" /tmp/full-dump.sql.gz
gunzip /tmp/full-dump.sql.gz

# 2. Extract just the row(s) of interest:
grep "^COPY public.reports" /tmp/full-dump.sql | \
    awk '/^COPY/,/^\\\.$/ { print }' | \
    grep "<report_uuid>" > /tmp/single-row.sql

# 3. Re-insert into the live DB (the operator must verify the row is
#    legitimately missing — don't overwrite a deliberate delete).
docker exec -i crisp-db-1 psql -U crisp -d crisp < /tmp/single-row.sql
```

For Media rows, the same procedure but check the underlying S3 object
exists at the same `url` field — if it doesn't, the row can't be
restored to a useful state.

---

## Verification drill — quarterly

Operator MUST run the following on the first Monday of every quarter
+ document the result in the operator log. Skipping the drill means
RPO/RTO numbers are speculative, not measured.

### Drill steps

1. Stand up a parallel `crisp-stage` environment (separate EC2 t3.small
   + dockerised Postgres).
2. Restore the latest hourly dump into `crisp-stage`.
3. Run `alembic upgrade head`.
4. Smoke test:
   - `curl crisp-stage/api/v1/ivr/status` → 200
   - dashboard loads, shows reports from the restored window
   - one media URL renders (i.e. the S3 reference is intact)
5. Record: time taken (target ≤ 2h), any errors, drift between
   restored state and live PROD.
6. Tear down `crisp-stage` (we don't keep it running between drills).

If the drill takes > 2h or fails any smoke step, raise an incident
ticket + tune the procedure BEFORE the next quarterly window.

---

## Pre-pilot checklist

Before going live at the first pilot location:

- [ ] `s3://crisp-backups/` bucket exists in the same region as the
      EC2 host (avoid cross-region transfer cost).
- [ ] EC2 IAM instance role has `s3:PutObject` + `s3:ListBucket` on
      `crisp-backups/*`.
- [ ] `crisp-pg-backup.sh` cron entry installed + verified by tailing
      one hourly run.
- [ ] WAL archiving turned on + verified by checking
      `s3://crisp-backups/postgres-wal/` lands files every minute.
- [ ] First restore drill completed; result documented in
      `docs/operations/drill-log.md` (create on first run).
- [ ] DNS TTL on `undp.crisplabs.tech` ≤ 300s so a region-failover
      can complete within the 2h RTO.

The backup cron + WAL archiving setup is **not yet implemented**
(out of scope for Sprint 3D — this is the runbook for when the
operator wires it). The current pilot is exposed: a region failure
loses up to 24h of data. Treat this as the **single biggest
operational risk** post-Sprint 3D.

---

## Out of scope (future hardening)

- **Cross-region replication** for `crisp-media`. Activates when the
  pilot expands to multi-region.
- **Encrypted backup off-S3** (e.g. Backblaze, off-AWS) for the
  paranoid scenario where AWS root credentials are compromised.
- **Logical replication subscriber** for hot-standby (zero-data-loss
  failover). Worth it past ~10 reports/sec sustained.

---

## Related references

- `docs/DEPLOYMENT_RUNBOOK.md` § Rollback — code rollback (not data
  rollback)
- `docs/MIGRATIONS.md` — schema migration safety + downgrade paths
- `docs/operations/SLOs.md` — RTO/RPO surface as SLOs in future
- `docs/breach-procedure.md` — data-leak response (orthogonal: this
  doc covers loss, that covers exfiltration)
