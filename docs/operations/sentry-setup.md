# Sentry — Operator Setup

CRISP wires the official Sentry browser SDK on both the PWA and the
Dashboard. The SDK itself is **vendored** at
`mobile-app/src/vendor/sentry.min.js` + `web-dashboard/src/vendor/sentry.min.js`
— no third-party CDN load at runtime, consistent with the rest of the
"self-host everything" posture.

DSN configuration is done **at deploy time**, not at build time, so
the source tree never carries a DSN in git.

## One-time setup (per environment)

### 1. Create a Sentry project

- Sign in to https://sentry.io
- Create a new project: platform = `JavaScript / Browser`
- Capture the project's **DSN** — it looks like
  `https://<32-hex-key>@o<orgid>.ingest.us.sentry.io/<projectid>`
- The DSN is a public-safe ingest key (write-only, no read access).
  Safe to ship to the browser. Documented in `docs/SECURITY.md`.

### 2. Add `SENTRY_DSN` to your env

For **PROD** (EC2 host):

```sh
# On the EC2 host:
echo "SENTRY_DSN=https://...@...ingest.sentry.io/..." >> .env.production
bash scripts/verify-env.sh .env.production   # must exit 0
```

For **GitHub Actions** (deploy workflow):

```sh
# In repo Settings → Secrets and variables → Actions → New repository secret:
#   Name:  SENTRY_DSN
#   Value: <the DSN>
# (already plumbed through deploy.yml as an env var on the deploy step)
```

### 3. Patch the HTML entrypoints

The four HTML files all start with `<meta name="crisp-sentry-dsn" content="">`
(empty in source). Before serving from PROD, run:

```sh
SENTRY_DSN="$DSN_VALUE" node scripts/patch-sentry-dsn.mjs
```

Files patched (must stay in lockstep so PWA + dashboard report into
the same project):

- `mobile-app/src/index.html`
- `web-dashboard/src/index.html`
- `web-dashboard/src/login.html`
- `web-dashboard/src/evidence.html`

Idempotent — re-running with the same DSN is a no-op; re-running
with empty string un-wires Sentry.

### 4. Verify

Open the PWA in a browser:

```js
// In DevTools console:
window.Sentry?.captureMessage("crisp deploy smoke", { level: "info" });
```

A message should appear in the Sentry project within ~30 seconds.

For automated verification, the deploy pipeline can call:

```sh
SENTRY_DSN="$DSN_VALUE" node scripts/patch-sentry-dsn.mjs --check
```

Exit code 1 if any HTML file's DSN doesn't match `$SENTRY_DSN` —
catches the "forgot to patch" failure mode at deploy time.

## What the SDK captures

`mobile-app/src/sentry-init.js` and the dashboard equivalent both
configure:

- **Error capture**: uncaught exceptions, unhandled promise
  rejections, console.error calls.
- **`beforeSend` PII strip**: removes `description`, `transcript`,
  `location` from the event payload before transmission. Extends
  UNDP must-have #7 (PII protection) to error metadata so a stack
  trace can't leak the reporter's input text or coordinates.
- **Performance sampling**: 10% transaction sample rate (configurable
  via `Sentry.init({ tracesSampleRate })` in the init wrapper).
- **Release tag**: read from the `<meta name="crisp-release">` tag
  (set by `scripts/sync-release-tags.mjs`) so Sentry can bisect
  regressions across PWA cache bumps.

## What it does NOT capture

- Sentry stays **inert** when DSN is empty. No network requests at
  all — won't fire events at any endpoint until a valid DSN lands.
- Pre-init errors (first ~2 seconds of page life): the SDK is
  lazy-loaded on `requestIdleCallback` (perf Sprint A.2) so errors
  before idle aren't captured. Acceptable trade-off — most JS errors
  surface after user interaction.
- Source maps: PWA ships unminified, so stack traces are already
  symbolicated. If we ever minify, wire `sentry-cli sourcemaps upload`
  into the deploy step.

## SLO + alerting

See `docs/operations/SLOs.md` for the error-rate SLOs. Sentry's
default alerting (issue created on first occurrence, alert on
high-frequency new errors) is the on-call signal until we add
Slack / PagerDuty integrations.
