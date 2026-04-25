# CRISP — CI/CD Pipeline

**Status**: Production
**Last updated**: 2026-04-25

This document describes the continuous integration and deployment pipeline
for CRISP and the one-time setup steps an operator must perform on
GitHub + AWS to enable automated deploys.

---

## 1. What runs when

```
            ┌─────────────────────────────────────────────────────────┐
            │                                                         │
            │   git push  →  PR opened  →  Pratik's / main updated    │
            │                                                         │
            └────────────────────────┬────────────────────────────────┘
                                     │
                ┌────────────────────┴───────────────────┐
                │                                        │
                ▼                                        ▼
       ┌───────────────────┐                  ┌────────────────────┐
       │  ci.yml           │                  │ deploy.yml         │
       │  (every push/PR)  │                  │ (push to main only)│
       └────────┬──────────┘                  └─────────┬──────────┘
                │                                       │
   ┌────────────┴────────────┐                          │
   │                         │                          │
   ▼                         ▼                          ▼
┌──────┐  ┌──────┐  ┌──────┐  ┌──────────┐  ┌─────────────────┐
│back- │  │mobile│  │PWA + │  │secrets   │  │  SSH to EC2     │
│end   │  │RN    │  │dash  │  │scan +    │  │  → deploy.sh    │
│pytest│  │tsc   │  │JS    │  │i18n +    │  │  → migrations   │
│      │  │      │  │check │  │pip-audit │  │  → up -d        │
└──────┘  └──────┘  └──────┘  └──────────┘  │  → health check │
                                            │  → auto-rollback│
                                            │     on failure  │
                                            └─────────────────┘
```

**Branch coverage**: CI runs on `main`, `master`, `develop`, `Pratik's`. Deploy
runs on `main` only (or any branch via `workflow_dispatch`).

---

## 2. CI jobs (`.github/workflows/ci.yml`)

| Job | Purpose | Failure action |
|---|---|---|
| `Backend (pytest + import check)` | Postgres-15 service, full pytest suite, compile-check every Python module | Hard fail |
| `React Native typecheck` | `npx tsc --noEmit` in `crisp-mobile/` | Hard fail |
| `PWA + Dashboard JS syntax` | `node --check` on every shipped `.js` | Hard fail |
| `Shell scripts` | `bash -n` on every `scripts/*.sh` | Hard fail |
| `No secrets in tracked files` | refuses commits that include `.env` | Hard fail |
| `i18n — locale parity + template-var preservation` | runs `validate-i18n.mjs` over all 6 UN locales | Hard fail |
| `Python dep vulnerability scan (pip-audit)` | scans `backend/requirements.txt` against OSV | **Soft fail** (logged, doesn't block) |
| `Secrets scan (gitleaks)` | scans full git history for leaked credentials | Hard fail |
| `Shellcheck (deploy + ops scripts)` | `shellcheck -x` on every `scripts/*.sh` | Hard fail |

**Why `pip-audit` is soft-fail**: advisories often land before upstream
patches are available. Hard-failing CI on a transitive `urllib3` advisory
that has no fix yet would block all merges. The job runs and the result
is visible in the run log — promote it to hard-fail once you have a
triage cadence.

---

## 3. Deploy pipeline (`.github/workflows/deploy.yml`)

### Triggers

- **Push to `main`** → automatic deploy.
- **Manual dispatch** (Actions → Deploy to Production → Run workflow):
  - Pick any branch.
  - Optionally tick "Skip backend rebuild" for static-only changes
    (PWA/dashboard tweaks; saves ~2 min).

### Concurrency

Only **one deploy at a time** — concurrent pushes are queued, not
cancelled (cancelling mid-migration would leave the schema in an
unknown state).

### Pre-flight check

Before SSHing to EC2, the workflow verifies the latest CI run on the
target SHA was successful. This is belt-and-suspenders — branch
protection should already be enforcing this — but a manual
`workflow_dispatch` deploy that skips CI surfaces a warning.

### What `deploy.sh` does on the EC2

1. `git fetch` + capture `OLD_SHA` and `TARGET_SHA`.
2. If they're equal, exit cleanly (no-op).
3. Detect whether `backend/`, `Dockerfile`, or `requirements.txt`
   changed. If yes, rebuild the backend image. Otherwise reuse the
   existing image (frontend, dashboard, PWA changes are static-volume
   mounts — no rebuild needed).
4. `docker compose down`.
5. Run `alembic upgrade head` in a one-shot `--rm` container with
   `APP_ENV=migrate` (skips production guards during migration).
6. `docker compose up -d`.
7. Poll `/health` locally for up to 120 s.
8. **If health never goes green** → `git reset --hard OLD_SHA`,
   rebuild, restart. If THAT also fails, exit with code `2` (manual
   intervention required).
9. Optional public probe (`PUBLIC_HEALTH_URL`) so an ALB / cert / DNS
   regression at deploy time is caught immediately.

### Post-deploy smoke (from GitHub runner)

The runner curls the public URL after `deploy.sh` returns success.
This catches any path that's only visible from outside AWS:

- DNS resolves
- ALB returns expected status
- TLS handshake succeeds
- nginx serves the PWA + dashboard

---

## 4. One-time setup

You'll need to do this once per repository / EC2 instance.

### 4.1 Generate a deploy-only SSH key on EC2

**Important**: don't reuse your personal `crisp-prod-key.pem`. Create a
separate key dedicated to CI deploys so you can rotate it independently.

```bash
# On the EC2 (or any local machine — the key just needs the public half on EC2)
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/crisp-deploy -N ""

# Add the public key to ec2-user's authorized_keys
cat ~/.ssh/crisp-deploy.pub >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

# Print the PRIVATE key — copy this entire output (incl. BEGIN/END lines)
cat ~/.ssh/crisp-deploy
```

The public key (`crisp-deploy.pub`) stays on the EC2 in
`authorized_keys`. The **private key** goes into a GitHub Secret (next
step). Delete `~/.ssh/crisp-deploy` from the local copy after pasting.

### 4.2 Add GitHub Secrets

GitHub → repo → Settings → Secrets and variables → Actions → New
repository secret. Add:

| Name | Value | Notes |
|---|---|---|
| `EC2_DEPLOY_KEY` | The PRIVATE key contents from 4.1 (entire file, incl. BEGIN/END) | Used by `deploy.yml` to SSH |
| `EC2_HOST` | `65.0.245.228` (your EIP) — or `undp.crisplabs.tech` once DNS settles | Where to SSH |
| `EC2_USER` | `ec2-user` | Optional — defaults to `ec2-user` |

### 4.3 Configure the production environment

GitHub → Settings → Environments → New environment → name:
`production`.

Recommended settings:

- **Required reviewers**: yourself. Means deploys to main require a
  manual click before they actually run. For UNDP submission week,
  toggle this off so emergency hotfixes auto-deploy.
- **Deployment branches**: restrict to `main` only.
- **Environment secrets**: not needed — repository secrets cover us.

### 4.4 Set branch protection on `main`

GitHub → Settings → Branches → Add rule for `main`:

- ✅ Require pull request before merging
- ✅ Require status checks to pass before merging
  - Required: `Backend (pytest + import check)`
  - Required: `PWA + Dashboard JS syntax`
  - Required: `i18n — locale parity + template-var preservation`
  - Required: `Secrets scan (gitleaks)`
- ✅ Require conversation resolution before merging
- ✅ Do not allow bypassing the above settings (even for admins)

This means: every merge to `main` triggers a deploy, AND every merge
must pass CI first.

### 4.5 Enable Dependabot

`.github/dependabot.yml` is committed to the repo — Dependabot picks
it up automatically. First scan happens on the next Monday at 06:00
IST. To trigger an immediate scan:

GitHub → Settings → Code security and analysis → Dependabot version
updates → "Last checked: …" — click the link, then "Check for
updates".

---

## 5. Operator runbook

### Deploy a feature

1. Open PR from `Pratik's` (or feature branch) → `main`
2. Wait for green CI ✅
3. Merge → `deploy.yml` triggers automatically
4. Watch Actions tab for green ✅; ~5 min including post-deploy smoke
5. Done

### Hotfix (skip the PR review)

```bash
# On main directly
git push origin main
# OR via GitHub UI: Actions → Deploy to Production → Run workflow
#   → branch: <your-branch>, skip_rebuild: false
```

### Manual deploy of a specific branch

GitHub → Actions → Deploy to Production → Run workflow → fill in
branch name → Run.

### Rollback to previous SHA

```bash
ssh ec2-user@<host>
cd ~/crisp
bash scripts/rollback.sh HEAD~1
# or to a specific SHA:
bash scripts/rollback.sh 8e53736
```

The script asks for confirmation before resetting + rebuilding.

### Rollback during a deploy that fails health check

Already automatic. `deploy.sh` resets to OLD_SHA, rebuilds, restarts,
exits non-zero. Check the GitHub Actions run log for the post-mortem.

### Production is dead, deploy.sh's auto-rollback also failed

Exit code `2` from `deploy.sh` means manual intervention. Quick
recovery:

```bash
ssh ec2-user@<host>
cd ~/crisp
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs backend --tail 100
# Pick a known-good SHA from `git log --oneline`:
git log --oneline -10
bash scripts/rollback.sh <known-good-sha>
```

If even that fails, the EC2 is in a state where docker images are
broken. Last resort:

```bash
docker system prune -af   # WARNING: deletes all stopped containers + dangling images
docker compose -f docker-compose.prod.yml build --no-cache
docker compose -f docker-compose.prod.yml up -d
```

### Rotate the deploy SSH key

When an engineer leaves or you suspect compromise:

```bash
# On EC2
sed -i.bak '/github-actions-deploy/d' ~/.ssh/authorized_keys
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ~/.ssh/crisp-deploy-new -N ""
cat ~/.ssh/crisp-deploy-new.pub >> ~/.ssh/authorized_keys
cat ~/.ssh/crisp-deploy-new
```

Update `EC2_DEPLOY_KEY` in GitHub Secrets with the new private key.
Delete the local copy (`rm ~/.ssh/crisp-deploy-new`). Trigger a
manual deploy to verify the new key works.

---

## 6. Future hardening (not blocking submission)

| Improvement | Effort | Why |
|---|---|---|
| Switch SSH → AWS SSM Session Manager via OIDC | 2 hr | Eliminates the long-lived private key. GitHub workflows assume an IAM role at deploy time, no SSH artifacts on the runner. |
| Push backend image to ECR before deploy | 2 hr | Decouples build from EC2. Faster deploys (just `docker pull`), enables blue/green on EC2 without rebuild. |
| Add Trivy image scan to CI | 30 min | Shifts CVE detection from runtime to build time. Hard-fail on critical CVEs. |
| Add semgrep SAST scan | 30 min | Catches Python/JS security anti-patterns (SQL string concat, weak crypto, etc.). |
| Move from single EC2 → ASG + ALB target group with rolling deploy | 4 hr | Zero-downtime deploys. Requires Postgres connection pooling (PgBouncer or RDS Proxy). |
| Schedule weekly `restic` snapshot of `/var/lib/docker/volumes/uploads/` to S3 | 1 hr | Disaster recovery for media that hasn't been migrated to S3 yet. |
| Add staging environment | 4 hr | Separate `staging.crisplabs.tech`. PRs deploy to staging on merge to `Pratik's`; main deploys to prod. Currently we go straight to prod. |

---

## 7. Cost

The CI/CD pipeline itself runs on free-tier GitHub Actions for public
repos and uses repo-included minutes for private. Our typical run:

- CI on PR: ~6 min total (parallelised across 9 jobs)
- Deploy on merge: ~5 min including post-deploy smoke

Monthly minutes burn for a 1-engineer cadence (5 PRs/week + 5
deploys/week): ~250 min/month. GitHub's free quota for private repos
on the team plan is 3,000 min/month. We're well under.
