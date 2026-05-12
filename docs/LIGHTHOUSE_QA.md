# Lighthouse QA Pipeline — Operator Runbook

CRISP runs Google Lighthouse against the PWA + Dashboard on every PR
and every production deploy. **Threshold violations block the merge**
and (on PROD) trigger auto-rollback. Optional deeper analysis happens
interactively in whichever code-review LLM the maintainer prefers —
not in CI. Zero AI cost in CI.

---

## TL;DR

* **PR opened** → CI runs Lighthouse → posts a score-table comment → sets a status check (pass/fail).
* **Status check red** → PR can't merge until you fix it OR apply the `lighthouse-approved` label.
* **Push to main** → Lighthouse re-runs → if green, deploy proceeds. Pre-deploy preflight verifies the Lighthouse status was green.
* **Post-deploy** → audit runs against `https://undp.crisplabs.tech`. If thresholds violated on PROD, auto-rollback fires.
* **Want a deeper analysis?** Open your code-review LLM of choice in the repo and ask it to analyse the latest Lighthouse report. It pulls the JSON from the `lighthouse-history` branch, prioritises fixes for low-bandwidth / low-literacy / accessibility, and proposes a fix plan you can approve.

---

## What's audited

Two URLs, mobile form factor, Slow 4G + 4× CPU slowdown (matches
realistic worst-case CRISP user — low-end Android in disaster zone):

| Page key    | URL                          | Why |
|-------------|------------------------------|---|
| `pwa-home`  | `/mobile-app/src/`           | First impression — landing page |
| `dashboard` | `/web-dashboard/src/`        | Analyst ops surface |

3 runs per URL × 2 URLs = 6 Lighthouse audits per CI run. Median is
picked for stable comparisons. Reports archived to the
[`lighthouse-history`](https://github.com/Pratik-Shukla-PY/crisp-platform/tree/lighthouse-history)
branch on every main-branch push.

---

## Threshold gate — current FLOOR values

These are the **floor**, not the target. They block PR merge if the
audit drops below them.

| Page      | Performance | Accessibility | Best Practices | PWA   |
|-----------|------------:|--------------:|---------------:|------:|
| pwa-home  | 45          | 70            | 85             | 80    |
| dashboard | 55          | 85            | 85             | n/a   |

**Plus**: CLS ≤ 0.25 hard-fails everywhere. LCP / TBT are warn-only
(reported in the comment, don't block).

**Regression gate**: any score that **drops ≥ 10 points** vs the last
main-branch run on the same page → block. Drops of 5–9 points → warn.

### Aspirational targets (raise the floor as fixes land)

| Metric         | Target |
|----------------|-------:|
| Performance    | 60+ mobile / 70+ dashboard |
| Accessibility  | 90+ (UNDP must-have) |
| LCP            | ≤ 4 s |
| TBT            | ≤ 600 ms |

When a fix lands that pushes a score to a new stable level, ratchet
the floor in `lhci.config.cjs` (and the mirror in
`scripts/lighthouse-pr-comment.mjs`). Both files have inline comments
pointing at the values to update.

---

## How to use an LLM assistant for deeper analysis

Open your code-review LLM in the repo root and ask it something like:

> *"Analyse the latest Lighthouse report on PR #128"*

or

> *"Compare the Lighthouse scores for the last 3 main-branch runs and tell me which axes are trending down."*

A good prompt will produce:

1. `git fetch origin lighthouse-history`
2. A read of the relevant `<sha>/summary.json` files (and the median
   LHR JSONs when needed for deeper drilling).
3. A prioritisation by user impact, weighted toward:
   * 4× — accessibility / low-literacy UX
   * 3× — offline-first reliability / low-bandwidth
   * 2× — mobile responsiveness
   * 1× — desktop / SEO
4. A Critical / High / Medium / Low list with file paths + specific fixes.
5. A confirmation step before implementing.

After approval, the maintainer writes the fixes (or has the assistant
write them), pushes, and the next CI run picks up the new scores.

---

## How to override the threshold gate

If a regression is **intentional** (e.g. shipping a heavy feature
behind a flag, or accepting a temporary perf hit for a user-facing
fix), use the override label:

1. Apply the **`lighthouse-approved`** label to the PR (any
   maintainer with write access).
2. Re-run the Lighthouse workflow: **Actions** tab → "Lighthouse QA"
   workflow → "Run workflow" on the PR's branch. (Or push an empty
   commit: `git commit --allow-empty -m "trigger lighthouse re-run"`.)
3. The status check turns yellow ("BLOCKERS PRESENT, OVERRIDDEN") and
   merge is allowed.
4. Document the reason in the merge commit — auditors will look here.

**The override is logged.** The PR comment shows who applied the label
and when. Don't override silently.

---

## How to read a Lighthouse PR comment

```
## 🚦 Lighthouse — `5a3752b`

| Page         | Performance | Accessibility | Best-practices | Pwa | Seo |
|--------------|------------:|--------------:|---------------:|----:|----:|
| pwa-home     | 78 ↘ (-3)   | 92 · (0)      | 95 ↗ (+1)      | 92  | 87  |
| dashboard    | 82 · (0)    | 93 · (0)      | 100 · (0)      | n/a | 70  |

Threshold check: ✅ All pass
Status: 🟢 PASS
```

* Each cell shows `current` `arrow` `(delta-from-baseline)`.
* 🟢 / ↗ / · / ↘ / 🔴 — visual cue from "+5 better" to "−5 worse".
* The bottom block is the verdict. 🟢 PASS = mergeable. 🔴 BLOCK = not
  mergeable without override.

---

## How to view the full HTML report

Every audit publishes a full Lighthouse HTML report (interactive — you
can drill into individual audits, see network waterfalls, etc.) to
the `lighthouse-history` branch. The PR comment links to it:

> 📄 [Full HTML reports](https://github.com/Pratik-Shukla-PY/crisp-platform/tree/lighthouse-history/5a3752b)

Clicking that takes you to the GitHub tree view. Open
`<sha>/<page>/median.html` and click **Raw** (or use the browser's
"View raw" link) — GitHub will serve the HTML.

Local: `git fetch origin lighthouse-history && open lighthouse-history/<sha>/<page>/median.html`.

---

## Local development — running Lighthouse manually

You don't need to run Lighthouse locally for routine work — CI does
it. But for debugging:

```bash
# Install once
npm install -g @lhci/cli@0.13.x

# Run from repo root
lhci collect --config=./lhci.config.cjs   # spins up server, runs audits
lhci assert  --config=./lhci.config.cjs   # checks thresholds

# View one report
open .lighthouseci/lhr-*.html | head -1  # or pick the latest

# Render the PR comment locally (no posting)
GITHUB_REPOSITORY=Pratik-Shukla-PY/crisp-platform \
  GITHUB_SHA=$(git rev-parse HEAD) \
  node scripts/lighthouse-pr-comment.mjs
```

LHCI auto-spins up a static server on a random port and audits
against it. No need to run `bash start.sh` separately for the
collect step.

---

## Architecture — what runs when

```
PR opened/updated
    ↓
.github/workflows/lighthouse.yml runs:
  1. lhci collect (3 URLs × 3 runs = 9 audits)
  2. lhci assert (deterministic threshold gate)
  3. scripts/lighthouse-publish.mjs → push median JSON+HTML to lighthouse-history
  4. scripts/lighthouse-pr-comment.mjs → score table + violations.json
  5. Post comment to PR via gh-script
  6. Set status check (success / failure)
    ↓
You review the comment / ask your code-review LLM for analysis
    ↓
Push to main triggers .github/workflows/deploy.yml:
  1. preflight checks Lighthouse status was green on this SHA
  2. deploy-to-EC2 (existing logic)
  3. post-deploy-smoke (existing Playwright prod-smoke)
  4. prod-lighthouse-audit (NEW — audits PROD URL)
  5. auto-rollback fires if EITHER prod-smoke OR prod-lighthouse-audit failed
```

---

## Files involved

| Path | Role |
|------|------|
| `lhci.config.cjs` | LHCI config: URLs, form factor, runs, thresholds (assertMatrix per page) |
| `scripts/lighthouse-publish.mjs` | Reads `.lighthouseci/`, picks medians, pushes to `lighthouse-history` orphan branch |
| `scripts/lighthouse-pr-comment.mjs` | Reads summary + baseline, renders Markdown comment, exits non-zero on threshold violation |
| `.github/workflows/lighthouse.yml` | The PR-time / push-to-main audit job |
| `.github/workflows/deploy.yml` | Existing deploy workflow + 2 new hooks (preflight Lighthouse check + post-deploy PROD audit) |
| `lighthouse-history` branch | Orphan branch storing `<sha>/{summary.json, <page>/median.{json,html}}` per audit |
| `docs/LIGHTHOUSE_QA.md` | This file |

---

## What Lighthouse does NOT cover (and how we cover it elsewhere)

Lighthouse alone is not enough. Phase 4 of the rollout adds these:

| Gap | Tool | Where |
|---|---|---|
| Deep accessibility (ARIA, contrast on dynamic content) | `@axe-core/playwright` | New `e2e/tests/pwa/40-axe-a11y.spec.ts` |
| Offline-first / SW behaviour | Playwright + `setOffline(true)` | Extended `e2e/tests/pwa/41-offline-strict.spec.ts` |
| Multi-stage user flow perf (capture → classify → review) | Lighthouse user-flow API + Puppeteer | `scripts/lighthouse-flow.mjs` |
| Visual regression (CSS drift) | Playwright `toHaveScreenshot()` | New `e2e/tests/pwa/42-visual-regression.spec.ts` |
| React Native parity | Detox + RN Testing Library | New `crisp-mobile/.detoxrc.js` (CI integration TBD) |
| Cognitive load / low-literacy UX | LLM-assisted screenshot review | Manual on demand |

Run them all locally:

```bash
cd e2e
npm test                       # full suite (includes Lighthouse + Playwright)
npx playwright test 40-axe     # axe-core a11y only
npx playwright test 41-offline # offline-first only
npx playwright test 42-visual  # visual regression only
```

---

## Common situations

### "My PR's Lighthouse score regressed but it's a real fix"

Apply the `lighthouse-approved` label. Document the reason in the
merge commit. Open a separate follow-up issue to recover the score.

### "Lighthouse is flaky — I get different scores on the same code"

Lighthouse has natural noise of ±3-5 points. We run 3 audits per URL
and pick the median. If you're still seeing flakiness:

1. Check the CI runner load — overloaded GH Actions runners can
   cause perf scores to swing. Re-run.
2. Check for upstream CDN flakiness (Mapbox, FontAwesome, Google
   Fonts) in the Network tab of the LH HTML report.
3. Ask your code-review LLM to *"compare the last 5 main-branch
   Lighthouse reports for variance"* — it can spot patterns.

### "I want to add a new URL to audit"

Edit `lhci.config.cjs`, add the URL to the `url:` array. Add a
matching key to `urlToPageKey()` in `scripts/lighthouse-publish.mjs`
and the threshold matrix in `scripts/lighthouse-pr-comment.mjs`. CI
will pick it up on the next run.

### "I want to raise the threshold floor"

Edit two files:

1. `lhci.config.cjs` → bump the `minScore` for the relevant `categories:*`.
2. `scripts/lighthouse-pr-comment.mjs` → bump the same number in the
   `PAGE_THRESHOLDS` map at the top.

Both files have inline comments pointing at exactly which lines to
edit. Submit as a separate PR with subject like *"chore(lighthouse):
ratchet pwa-home a11y floor 70 → 80"*.

### "auto-rollback fired on a deploy"

The workflow dashboard shows which job failed (prod-smoke OR
prod-lighthouse-audit). Read the comment / artifacts on the failed
job. The rollback already restored HEAD~1; you have time to
investigate. Ask your code-review LLM: *"the prod Lighthouse audit
fired auto-rollback at sha=abc1234, what regressed?"*.

---

## Cost

* **CI minutes**: ~12 minutes per run (3 URLs × 3 runs at ~80 sec
  each + setup overhead). Free-tier GitHub Actions covers it easily.
* **AI assistant API**: $0 — the deeper analysis path is interactive
  in a local LLM assistant; no background API calls.
* **Storage**: `lighthouse-history` orphan branch ≈ 50 KB / commit ×
  ~1000 commits/year ≈ 50 MB/year of repo bloat. Squash to last 12
  months once a year if it ever becomes a problem.

---

*Coverage extension (axe-core, user-flow, offline-strict, visual
regression, Detox) is rolled in via subsequent PRs as the surfaces
stabilise.*
