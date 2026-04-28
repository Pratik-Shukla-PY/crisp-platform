# S3 + CloudFront media migration runbook

CRISP's media (photos, audio, satellite verify thumbnails) used to land
on the EC2 instance's local disk and serve via nginx `/static/`. That
made EC2 a single-point-of-failure for media: container restart with
the volume reset would drop everything, disk-full halted deploys, and
the architecture didn't scale horizontally.

This runbook covers the migration to private-S3 storage with backend-
signed presigned URLs (Phase 1) and the optional CloudFront edge cache
on top (Phase 2).

## Prerequisites

| | What | Where |
|---|---|---|
| 1 | S3 bucket, private (Block Public Access ON) | `crisp-uploads-prod-<account-id>` already exists |
| 2 | EC2 IAM role with `s3:{Get,Put,Delete}Object` + `s3:ListBucket` on the bucket | already attached, see policy below |
| 3 | Backend deployed with the storage abstraction code (`feat(storage): pluggable LocalStorage + S3Storage backends`) | shipped as part of this commit |

The IAM policy currently attached to the EC2 instance role:

```json
{
  "Sid": "UploadBucketObjects",
  "Effect": "Allow",
  "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
  "Resource": [
    "arn:aws:s3:::crisp-uploads-prod-824604027263",
    "arn:aws:s3:::crisp-uploads-prod-824604027263/*"
  ]
}
```

`s3:ListBucket` is needed by the migration script's idempotency check (`HeadObject` requires it).

## Phase 1 — flip new uploads to S3, migrate existing files

Order matters: get the env in place first, then migrate, then verify.
Default `MEDIA_BACKEND=local` means doing this in the wrong order is harmless — new uploads keep going to disk until you flip the flag.

### 1. Add the env vars to `.env.production` on EC2

```bash
ssh ec2-user@undp.crisplabs.tech
cd ~/crisp
nano .env.production
```

Append:

```
# Apr 2026 — flip media off EC2 disk onto S3
MEDIA_BACKEND=s3
AWS_S3_BUCKET=crisp-uploads-prod-824604027263
AWS_REGION=ap-south-1
```

`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` should NOT be set — the EC2 instance profile provides credentials automatically through boto3's default chain. If those env vars are present, boto3 prefers them and you bypass the IAM role; remove them.

Save (Ctrl+O Enter Ctrl+X).

### 2. Recreate the backend container

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate backend
```

Wait ~20 s, then verify the container picked up the new env:

```bash
docker compose -f docker-compose.prod.yml exec backend env | grep -E "MEDIA_BACKEND|AWS_S3|AWS_REGION" | sed 's/=.*/=<set>/'
```

Should show:
```
MEDIA_BACKEND=<set>
AWS_S3_BUCKET=<set>
AWS_REGION=<set>
```

### 3. Sanity-check IAM access from inside the container

```bash
docker compose -f docker-compose.prod.yml exec backend python -c "
import boto3
s3 = boto3.client('s3', region_name='ap-south-1')
# HeadBucket requires neither GetObject nor ListBucket on objects — just bucket exists + reachable.
s3.head_bucket(Bucket='crisp-uploads-prod-824604027263')
print('S3 reachable + IAM OK')
"
```

Expected: `S3 reachable + IAM OK`. If you get `AccessDenied` or `NoCredentialsError`, the IAM role isn't attached or the policy is wrong — fix that first.

### 4. Run the migration script in dry-run mode

```bash
docker compose -f docker-compose.prod.yml exec -T backend python /app/backend/scripts/migrate_media_to_s3.py --dry-run
```

This walks `/app/backend/uploads`, prints each file it WOULD upload, and each `media.url` row it WOULD rewrite. Nothing is uploaded or changed.

Review the output. Look for:
- Total file count matches what you expect (`ls /app/backend/uploads | wc -l` from inside the container)
- No "upload FAILED" lines (means S3 PUT permission works)
- The number of legacy `/static/` rows matches what you'd expect from the dashboard

### 5. Run for real

```bash
docker compose -f docker-compose.prod.yml exec -T backend python /app/backend/scripts/migrate_media_to_s3.py --confirm
```

The script:
1. Uploads each local file to S3 (idempotent — skips files that are already there).
2. Rewrites `media.url` from `/static/foo.jpg` to `s3://foo.jpg` for every legacy row.
3. Same rewrite for `satellite_verifications.satellite_image_url`, `satellite_image_url_alt`, and the `satellite_images_json` list entries.
4. Commits the DB transaction.

For ~hundreds of files this completes in seconds; thousands of files in a minute or two.

### 6. Verify the dashboard still shows existing media

Open the dashboard, click an existing report, view its photo + satellite verify panel. Both should load — they're now coming from S3 via signed URLs (you'll see `https://crisp-uploads-prod-...s3.ap-south-1.amazonaws.com/...?X-Amz-Signature=...` in the network tab).

### 7. Verify a NEW upload lands directly in S3

From your phone (or PWA on Mac), capture and submit a fresh report. Check the photo on the dashboard.

```bash
docker compose -f docker-compose.prod.yml exec backend python -c "
from app.db.session import SessionLocal
from app.models.report import Media
from sqlalchemy import desc
db = SessionLocal()
r = db.query(Media).filter(Media.type=='IMAGE').order_by(desc(Media.created_at)).first()
print(f'media.url = {r.url}')
db.close()
"
```

Expected: `media.url = s3://<media_id>_assembled.jpg` (NOT `/static/...`).

## Rollback

If S3 misbehaves and you need to revert to local-disk:

1. Set `MEDIA_BACKEND=local` in `.env.production`.
2. `docker compose ... up -d --force-recreate backend`.
3. New uploads land on disk. Existing `s3://` rows still resolve from S3 (LocalStorage falls through to S3 lookup if AWS creds present), but the safest path is to also migrate them back via a reverse script (not yet written — call out if needed).

## Phase 2 — CloudFront edge cache (optional, follow-up)

After Phase 1 is stable, layer CloudFront in front for edge caching. Adds:
- Faster repeat dashboard views (CloudFront edge POPs cache the S3 response).
- Lower S3 GET cost at scale.
- Origin Access Control means S3 only accepts CloudFront reads; the bucket itself stays unreachable from outside.

Setup:
1. Console: CloudFront → Create distribution → Origin = your S3 bucket → Origin access = "Origin access control" → create new OAC → "Sign requests".
2. Default cache behavior: viewer protocol = "Redirect HTTP to HTTPS".
3. After distribution creates, CloudFront will offer a "Copy policy" snippet — paste it into the bucket policy in S3 console (grants CloudFront read access to the bucket).
4. Wait ~10 minutes for the distribution to deploy.
5. Note the distribution domain (`d12345.cloudfront.net`).

Then on EC2:

```bash
nano .env.production
# Add:
CLOUDFRONT_DOMAIN=d12345.cloudfront.net
```

Recreate the container. The backend's `S3Storage.public_url()` will switch to signing CloudFront URLs (instead of S3 presigned). No client-side change.

## Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| Dashboard photos show 403 | Presign expired (15-min TTL) and the page sat open. Reload. | Reload — backend re-signs on each response. |
| Migration script: `AccessDenied` on `head_object` | IAM policy missing `s3:GetObject` or bucket name typo | Verify policy + bucket name in env. |
| New uploads still land on `/static/` | `MEDIA_BACKEND` not set, or container didn't pick up env (used `restart` instead of `up -d --force-recreate`) | Recreate the container, not just restart. |
| `boto3.session.Session` fails to find creds | EC2 IAM role detached | Re-attach the role in EC2 console → Instance → Actions → Security → Modify IAM role. |
| Disk fills again on EC2 | We still write transient working copies to local disk for inline processing (CAFF transcode + blur). Schedule a periodic cleaner. | Cron `find /app/backend/uploads -mtime +1 -type f -delete` (or run `scripts/gc_local_uploads.py` once it's added). |

## What's deliberately unchanged

- Inline processing (CAFF→WAV transcode, server-side PII blur, perceptual hash) still uses local disk as a transient working copy. The blur worker re-uploads to S3 after redacting, so the canonical S3 object always has the blurred bytes. Local disk fills slowly with these working copies — clean periodically.
- GDPR delete (`DELETE /api/v1/reports/...`) currently only removes local-disk copies. For S3 backend we'd need to also call `storage.delete()`. Tracked as a follow-up; manually delete the S3 keys for any GDPR purge during the gap window.
- IVR + Telegram media uploads use `_assemble_media_file` so they ride the storage abstraction transparently — no per-channel changes needed.
