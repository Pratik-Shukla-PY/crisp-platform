/**
 * CRISP — Production smoke suite.
 *
 * Runs against the LIVE prod URL (https://undp.crisplabs.tech by default,
 * override with CRISP_PROD_BASE_URL). Catches every class of "worked locally,
 * broke in prod" issue the team has hit during the UNDP submission deploy:
 *
 *   1. CSP violations (a script/style/connect/img/font/worker source the
 *      page tries to use that isn't in nginx's Content-Security-Policy).
 *   2. Static-asset 404s (a JS / CSS / locale JSON file that's referenced
 *      from index.html but missing on disk in the served container).
 *   3. JS runtime errors during boot (uncaught exceptions before user
 *      interaction starts — usually breaks the whole capture flow).
 *   4. Service-worker registration failures.
 *   5. External-CDN unreachability (Leaflet, TFJS, BlazeFace, Nominatim,
 *      Overpass, Google Fonts).
 *   6. Backend-via-nginx routing (POST/GET against /api/v1 returns
 *      something sensible, not a stack trace or 502).
 *   7. Critical UI elements present in the DOM after page load.
 *
 * Run:
 *   npm run check:prod              # default — undp.crisplabs.tech
 *   CRISP_PROD_BASE_URL=https://staging.example.com npm run check:prod
 *
 * Designed to finish in under 60 seconds. If it goes red, the failure
 * message tells you EXACTLY which CDN / asset / endpoint is broken,
 * not "something didn't render."
 */
import { test, expect, Page, ConsoleMessage } from '@playwright/test';

const BASE = process.env.CRISP_PROD_BASE_URL || 'https://undp.crisplabs.tech';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface PageDiagnostics {
  consoleErrors: string[];
  cspViolations: string[];
  failedRequests: { url: string; failure: string | null; status?: number }[];
  pageErrors: string[];
}

/** Attach listeners to a fresh page that capture every diagnostic signal we
 *  need. Returns the bag — call `.consoleErrors` etc. after the actions.
 *
 *  We classify console errors:
 *    - CSP violations (start with "Refused to ... violates the following
 *      Content Security Policy directive") get their own bucket so the
 *      failure message is actionable.
 *    - Other "error"-level console messages bucket as JS runtime errors.
 */
function instrument(page: Page): PageDiagnostics {
  const bag: PageDiagnostics = {
    consoleErrors: [],
    cspViolations: [],
    failedRequests: [],
    pageErrors: [],
  };

  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    if (text.includes('Content Security Policy') ||
        text.includes('violates the following') ||
        text.includes('Refused to')) {
      bag.cspViolations.push(text);
    } else if (msg.type() === 'error') {
      bag.consoleErrors.push(text);
    }
  });

  page.on('pageerror', (err) => {
    bag.pageErrors.push(`${err.name}: ${err.message}`);
  });

  page.on('requestfailed', (req) => {
    bag.failedRequests.push({
      url: req.url(),
      failure: req.failure()?.errorText ?? null,
    });
  });

  page.on('response', async (res) => {
    if (res.status() >= 400 && res.url().startsWith('http')) {
      // Skip well-known noise: /api/v1/auth/* expects 401 when probed
      // unauthenticated. /favicon.ico 404 is cosmetic.
      const u = res.url();
      const ignorable =
        u.includes('/favicon.ico') ||
        u.includes('/api/v1/auth/');
      if (!ignorable) {
        bag.failedRequests.push({
          url: u,
          failure: `HTTP ${res.status()}`,
          status: res.status(),
        });
      }
    }
  });

  return bag;
}

/** Format a diagnostics bag into a multi-line failure message. */
function formatDiagnostics(label: string, d: PageDiagnostics): string {
  const lines = [`${label}:`];
  if (d.cspViolations.length) {
    lines.push('  CSP VIOLATIONS:');
    d.cspViolations.forEach((v) => lines.push(`    - ${v.slice(0, 240)}`));
  }
  if (d.failedRequests.length) {
    lines.push('  FAILED REQUESTS:');
    d.failedRequests.forEach((r) =>
      lines.push(`    - [${r.failure}] ${r.url.slice(0, 200)}`),
    );
  }
  if (d.pageErrors.length) {
    lines.push('  UNCAUGHT JS ERRORS:');
    d.pageErrors.forEach((e) => lines.push(`    - ${e.slice(0, 240)}`));
  }
  if (d.consoleErrors.length) {
    lines.push('  CONSOLE ERRORS:');
    d.consoleErrors.forEach((e) => lines.push(`    - ${e.slice(0, 240)}`));
  }
  return lines.join('\n');
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Production — PWA', () => {
  test('loads index without CSP violations or failed resources', async ({ page }) => {
    const diag = instrument(page);

    // `load` (not networkidle) — the PWA has a service worker that
    // does opportunistic background fetches, which means networkidle
    // never fires within a sane timeout. `load` waits for DOMContentLoaded
    // + main subresources, which is enough to trigger any boot-time CSP
    // violation or asset 404.
    await page.goto(`${BASE}/mobile-app/src/`, { waitUntil: 'load', timeout: 20_000 });

    // Wait an extra beat for any deferred scripts (TFJS, BlazeFace lazy
    // loaders) to settle and surface any errors.
    await page.waitForTimeout(3000);

    const msg = formatDiagnostics('PWA index load', diag);
    expect(diag.cspViolations, msg).toEqual([]);
    expect(diag.failedRequests, msg).toEqual([]);
    expect(diag.pageErrors, msg).toEqual([]);
  });

  test('service worker registers + cache version is current', async ({ page }) => {
    await page.goto(`${BASE}/mobile-app/src/`, { waitUntil: 'load' });

    // Wait for SW registration to complete.
    const swReady = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { error: 'no SW support' };
      const reg = await navigator.serviceWorker.ready.catch(() => null);
      return {
        scope: reg?.scope || null,
        active: !!reg?.active,
        state: reg?.active?.state ?? null,
      };
    });

    expect(swReady.active, `SW did not become active: ${JSON.stringify(swReady)}`).toBe(true);

    // Pull sw.js directly to confirm cache version.
    const swJs = await page.evaluate(async (url) => {
      const r = await fetch(url, { cache: 'no-store' });
      return r.text();
    }, `${BASE}/mobile-app/src/sw.js`);
    const m = swJs.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
    expect(m, 'CACHE_NAME line not found in sw.js').not.toBeNull();
    // Lock to v55+ — older means a stale deploy.
    const version = parseInt((m?.[1] || '').replace('crisp-v', ''), 10);
    expect(version, `sw.js CACHE_NAME = ${m?.[1]} is older than expected`).toBeGreaterThanOrEqual(55);
  });

  test('global libraries from CDN are loaded (BuildingSelect + I18N + PIIBlur)', async ({ page }) => {
    await page.goto(`${BASE}/mobile-app/src/`, { waitUntil: 'load' });
    // May 2026 — TFJS + BlazeFace + Leaflet are NO LONGER eagerly
    // loaded at boot.
    //  - pii-blur.js dynamically injects tfjs/blazeface on first photo
    //    capture (verified by 30-v4-bug-fixes BUG 6).
    //  - building-select.js dynamically injects Leaflet on first map
    //    init (verified by 30-v4-bug-fixes BUG 5).
    // We only assert the wrapper helpers (PIIBlur + BuildingSelect)
    // exist at boot — those are the API surface app code touches first.
    const globals = await page.evaluate(() => ({
      PIIBlur: typeof (window as any).PIIBlur,
      BuildingSelect: typeof (window as any).BuildingSelect,
      I18N: typeof (window as any).I18N,
    }));
    expect(globals.PIIBlur, 'PIIBlur (window.PIIBlur) — face detection wrapper').toBe('object');
    expect(globals.BuildingSelect, 'BuildingSelect helper — building tagging will not work').toBe('object');
    expect(globals.I18N, 'I18N inline pack — all text will be raw keys').toBe('object');
  });

  test('all 6 UN locale JSONs return 200', async ({ page }) => {
    const locales = ['en', 'fr', 'es', 'ar', 'ru', 'zh'];
    for (const loc of locales) {
      const res = await page.request.get(`${BASE}/mobile-app/src/i18n/${loc}.json`);
      expect(res.status(), `i18n/${loc}.json must serve`).toBe(200);
      const body = await res.json();
      expect(body && typeof body === 'object', `i18n/${loc}.json must parse as JSON object`).toBe(true);
    }
  });

  test('PWA wiring: critical UI elements + handlers attached', async ({ page }) => {
    // Apr 2026 — catches the class of "code shipped but not wired up" bugs.
    // Past offenders this test would have caught:
    //   - sync-badge tap doing nothing because index.html had no onclick
    //     and app.js never wired addEventListener to the badge
    //   - building-select-box missing from the DOM after a refactor
    //   - language switcher button hidden behind a CSS regression
    //   - BlazeFace global named differently than callers expect
    await page.goto(`${BASE}/mobile-app/src/`, { waitUntil: 'load' });
    await page.waitForTimeout(2000);  // settle for SW + lazy globals

    // Critical DOM elements must exist (display:none is OK — we only check
    // they're in the DOM tree, not their visibility, since some are stage-
    // gated and only show after navigation).
    //
    // May 2026 — V3→V4 consolidation (commit 8556979) collapsed the
    // 7-step V3 flow into 3 V4 stages. V3 stages #stage-photo /
    // -audio / -where / -infra / -crisis / -extras are retained as
    // hidden fallback DOM for backwards-compat (commit 4671205); but
    // #stage-review was deliberately deleted, and #building-select-box
    // / #building-map-placeholder no longer exist as top-level
    // elements (the V4 picker is inline in #stage-v4-classify, mounted
    // into #v4-building-mount on demand).
    //
    // Assert BOTH the surviving V3 fallbacks AND the new V4 stages so
    // the test catches "code shipped but V4 stage missing" AND
    // "fallback DOM accidentally deleted".
    const requiredElements = [
      '#sync-badge',                     // offline queue indicator
      '#sync-badge-text',                // its text content
      // V4 stages — the canonical capture flow as of commit 8556979.
      '#stage-v4-capture',               // V4: photo + voice + text on one screen
      '#stage-v4-classify',              // V4: infra / hazard / damage / building
      '#stage-v4-review',                // V4: confirm + submit (replaces V3 #stage-review)
      '#v4-building-mount',              // V4: where building-select picker mounts inline
      // V3 fallback DOM — retained per commit 4671205 so re-toggle of
      // the V3 flow still works. These IDs MUST stay in the tree even
      // though V4 is the active flow.
      '#stage-where',                    // V3 fallback: where (location)
      '#stage-infra',                    // V3 fallback: infrastructure type
      '#stage-crisis',                   // V3 fallback: crisis type
      '#stage-extras',                   // V3 fallback: damage / debris / service
      '#stage-photo',                    // V3 fallback: photo capture
      '#stage-audio',                    // V3 fallback: voice description
      '#lang-switcher',                  // language picker
    ];
    const missing = await page.evaluate((selectors) => {
      return selectors.filter((s) => !document.querySelector(s));
    }, requiredElements);
    expect(missing, `Missing critical PWA elements: ${missing.join(', ')}`).toEqual([]);

    // Sync-badge MUST have a tap handler — otherwise the user can't
    // manually retry stuck queue items. Past bug: button was display-only.
    const syncBadgeWired = await page.evaluate(() => {
      const el = document.getElementById('sync-badge');
      if (!el) return { reason: 'no element' };
      // Either inline onclick or addEventListener-attached listener works.
      // Inline is detectable; addEventListener isn't from outside, so we
      // accept either onclick OR the role=button + tabindex pattern.
      const inlineClick = el.getAttribute('onclick');
      const role = el.getAttribute('role');
      const tabindex = el.getAttribute('tabindex');
      return {
        inlineClick,
        role,
        tabindex,
        wired: !!inlineClick || (role === 'button' && tabindex !== null),
      };
    });
    expect(
      syncBadgeWired.wired,
      `sync-badge missing tap handler. Without this, users CAN'T manually retry stuck queue items. inline=${syncBadgeWired.inlineClick} role=${syncBadgeWired.role} tabindex=${syncBadgeWired.tabindex}`,
    ).toBe(true);

    // PIIBlur (BlazeFace wrapper) needs window-exposed API for app.js to call.
    const piiBlurExposed = await page.evaluate(() => {
      return typeof (window as any).PIIBlur !== 'undefined' ||
             typeof (window as any).blurFaces !== 'undefined' ||
             typeof (window as any).faceBlur !== 'undefined';
    });
    expect(piiBlurExposed, 'PII blur module not exposed on window').toBe(true);
  });

  test('PWA wiring: BuildingSelect API surface (UNDP must-have #6)', async ({ page }) => {
    // The UNDP brief mandates "interactive map with building footprints".
    // Past prod bugs we want to catch here:
    //   - window.BuildingSelect undefined (whole module didn't load)
    //   - BuildingSelect missing one of the 3 methods app.js calls
    //   - Calling preCacheNearest crashes without GPS (regression)
    await page.goto(`${BASE}/mobile-app/src/`, { waitUntil: 'load' });
    await page.waitForTimeout(1000);

    const api = await page.evaluate(() => {
      const bs = (window as any).BuildingSelect;
      if (!bs || typeof bs !== 'object') return { ok: false, why: 'window.BuildingSelect not defined' };
      const required = ['ensureMap', 'getSelection', 'preCacheNearest'];
      const missing = required.filter((m) => typeof bs[m] !== 'function');
      return { ok: missing.length === 0, missing };
    });
    expect(api.ok, `BuildingSelect API broken: ${JSON.stringify(api)}`).toBe(true);
  });

  test('upstream geo CDNs reachable from the browser (CSP allows fetch)', async ({ page }) => {
    await page.goto(`${BASE}/mobile-app/src/`, { waitUntil: 'load' });
    const results = await page.evaluate(async () => {
      const probe = async (url: string) => {
        try {
          // mode:'no-cors' so we just verify the network can reach it.
          // CSP would block at the connect-src check before this even fires.
          const r = await fetch(url, { mode: 'no-cors', cache: 'no-store' });
          return { url, ok: true };
        } catch (e: any) {
          return { url, ok: false, error: String(e?.message || e) };
        }
      };
      return Promise.all([
        probe('https://nominatim.openstreetmap.org/status'),
        probe('https://overpass-api.de/api/status'),
      ]);
    });
    for (const r of results) {
      expect(r.ok, `fetch blocked for ${r.url}: ${r.error || ''} — likely CSP connect-src missing`).toBe(true);
    }
  });
});

test.describe('Production — Dashboard', () => {
  test('login page loads without CSP / asset issues', async ({ page }) => {
    const diag = instrument(page);
    await page.goto(`${BASE}/web-dashboard/src/login.html`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    const msg = formatDiagnostics('Dashboard login load', diag);
    expect(diag.cspViolations, msg).toEqual([]);
    expect(diag.failedRequests, msg).toEqual([]);
    expect(diag.pageErrors, msg).toEqual([]);
  });

  test('login form has expected fields (lockdown UI)', async ({ page }) => {
    await page.goto(`${BASE}/web-dashboard/src/login.html`);
    // Email + password + 6-digit TOTP code
    await expect(page.locator('#login-email')).toBeVisible();
    await expect(page.locator('#login-password')).toBeVisible();
    await expect(page.locator('#login-totp')).toBeVisible();
    // Register / SSO tabs hidden under display:none
    const tabsHidden = await page.locator('.tabs').first().evaluate((el) =>
      window.getComputedStyle(el).display === 'none',
    );
    expect(tabsHidden, 'Register/SSO tabs must be hidden in lockdown mode').toBe(true);
  });

  test('main app loads with Leaflet + clustering + heatmap libs', async ({ page }) => {
    // Without a valid JWT, the dashboard redirects to login.html. We can't
    // exercise the in-app code paths here; instead we (a) capture all
    // <script src=...> tags from the deployed index.html, (b) probe each
    // one returns 200, (c) spot-check that Leaflet/Turf serve from unpkg
    // (proxied via CSP). This catches the prod-only "asset 404 / CDN
    // blocked" regressions without depending on auth.
    const html = await (await page.request.get(`${BASE}/web-dashboard/src/index.html`)).text();
    const scriptSrcs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
    expect(scriptSrcs.length, 'index.html should reference at least one <script src>').toBeGreaterThan(0);

    // Resolve relative URLs against the index page.
    const resolved = scriptSrcs.map((s) =>
      s.startsWith('http') ? s : new URL(s, `${BASE}/web-dashboard/src/`).toString(),
    );

    const failures: string[] = [];
    for (const url of resolved) {
      const r = await page.request.get(url);
      if (r.status() !== 200) failures.push(`${r.status()} ${url}`);
    }
    expect(failures, `One or more dashboard scripts failed to load:\n  ${failures.join('\n  ')}`).toEqual([]);
  });

  test('SW-controlled fetch for CDN assets returns 200, not 503 (refresh symptom)', async ({ page }) => {
    // Apr 2026 — behavioral guard for "normal-refresh fails / hard-refresh works."
    // The structural CSP test above asserts connect-src has the expected hosts.
    // This test goes one layer deeper: registers the dashboard SW, waits
    // for it to claim the page, then performs a fetch from page context
    // to a host the SW cacheFirst-intercepts. That request flow is exactly
    // what broke in prod: page → SW.fetch event → cacheFirst miss →
    // fetch(req) under connect-src governance. If connect-src omits the
    // host, the SW catch handler returns a synthetic Response('Offline',
    // { status: 503 }).
    //
    // We navigate to login.html (auth-free) and register the SW manually,
    // rather than relying on index.html's automatic registration — index.html
    // hard-redirects to login.html on its first 401, which destroys the
    // execution context before the SW probe can run.
    await page.goto(`${BASE}/web-dashboard/src/login.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });

    const swStatus = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { ok: false, why: 'no SW support' };
      try {
        // Manually register the dashboard SW. Same registration call the
        // page itself uses when running index.html's bottom <script> block.
        await navigator.serviceWorker.register('/web-dashboard/src/sw.js', {
          scope: '/web-dashboard/src/',
        });
        const reg = await navigator.serviceWorker.ready;
        // Wait for clients.claim() to take effect.
        let tries = 0;
        while (!navigator.serviceWorker.controller && tries < 50) {
          await new Promise((r) => setTimeout(r, 100));
          tries += 1;
        }
        return {
          ok: !!reg.active && !!navigator.serviceWorker.controller,
          activeState: reg.active?.state ?? null,
          controlled: !!navigator.serviceWorker.controller,
        };
      } catch (e: any) {
        return { ok: false, why: String(e?.message || e) };
      }
    });
    expect(swStatus.ok, `dashboard SW not active+controlling page: ${JSON.stringify(swStatus)}`).toBe(true);

    // Now exercise the bug path. Mix of:
    //   - CDN_HOSTS the dashboard SW cacheFirst-intercepts (unpkg, cdnjs)
    //   - Tile hosts that hit the SW catch-all (basemaps, arcgisonline)
    // The tile hosts were the second-wave bug: they're allowed under img-src
    // for browser-driven <img> loads on first visit, but once the SW claims
    // the page, every fetch goes SW-mediated and connect-src governs. If
    // *.basemaps.cartocdn.com or server.arcgisonline.com is missing from
    // connect-src, this test catches it before users hit "normal refresh."
    const probes = await page.evaluate(async () => {
      const urls = [
        'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
        'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
        'https://a.basemaps.cartocdn.com/dark_all/2/0/0.png',
        'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/2/0/0',
      ];
      return Promise.all(
        urls.map(async (url) => {
          try {
            // Important: don't pass cache:'no-store' — that's the BROWSER
            // cache, not the SW CacheStorage. We want the SW to handle this
            // request exactly like a real cacheFirst lookup.
            // Use no-cors mode for tile hosts which don't ship CORS headers;
            // we only care that SW didn't synth-503 it. status will be 0
            // for opaque responses but that's fine — the catch-handler 503
            // would manifest as a real error or status=503.
            const r = await fetch(url, { mode: 'no-cors' });
            return { url, status: r.status, type: r.type, ok: r.ok };
          } catch (e: any) {
            return { url, status: 0, type: '', error: String(e?.message || e) };
          }
        }),
      );
    });

    for (const p of probes) {
      // Two valid success modes:
      //   - CORS-friendly hosts (unpkg, cdnjs): r.status=200, type=basic|cors.
      //   - Non-CORS hosts (tile providers): r.status=0, type='opaque'.
      //     Browsers expose opaque responses with status=0 by spec, but the
      //     fetch DID succeed — the alternative would be the synthetic 503
      //     from the SW catch handler, which would fail the no-cors fetch
      //     with a network error (caught above as p.error).
      const succeeded = p.status === 200 || (p.type === 'opaque' && !p.error);
      expect(
        succeeded,
        `SW-mediated fetch failed for ${p.url}\n` +
          `  status=${p.status} type=${p.type} error=${(p as any).error || '(none)'}\n` +
          (p.status === 503
            ? `  ↑ Synthetic 503 from SW catch handler. Likely connect-src is missing\n` +
              `    this host. See nginx.conf and web-dashboard/src/sw.js:103.`
            : (p as any).error
              ? `  ↑ Network error from SW. Likely connect-src is missing this host\n` +
                `    OR the upstream is unreachable from prod.`
              : `  ↑ Unexpected status — investigate.`),
      ).toBe(true);
    }
  });
});

test.describe('Production — Backend via nginx', () => {
  test('public root redirects to dashboard (alive signal)', async ({ request }) => {
    const res = await request.get(`${BASE}/`, { maxRedirects: 0 });
    expect([301, 302]).toContain(res.status());
  });

  test('GET /api/v1/reports/ returns 401 (auth-protected, not 5xx)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/v1/reports/`);
    expect(res.status(), 'API should be reachable through nginx and require auth').toBe(401);
  });

  test('GET /api/v1/auth/sso/providers is reachable (no auth required)', async ({ request }) => {
    const res = await request.get(`${BASE}/api/v1/auth/sso/providers`);
    expect(res.status(), 'public API endpoint should respond 200').toBe(200);
    const body = await res.json();
    expect(Array.isArray(body), 'sso/providers should return an array').toBe(true);
  });

  test('GET /api/v1/push/vapid-public returns the expected shape', async ({ request }) => {
    // Apr 2026 — Web Push reporter-feedback channel. The PWA fetches
    // this key once at startup and uses it as `applicationServerKey`
    // for PushManager.subscribe(). Two valid prod states:
    //   - VAPID configured: { enabled: true, key: "<base64url string>" }
    //   - VAPID unset:      { enabled: false, key: "" }
    // Either is acceptable here — what we're guarding against is the
    // endpoint 404'ing or returning a malformed body, which would
    // break the PWA's permission flow silently.
    const res = await request.get(`${BASE}/api/v1/push/vapid-public`);
    expect(res.status(), 'push/vapid-public must respond 200').toBe(200);
    const body = await res.json();
    expect(typeof body.enabled, 'response.enabled must be boolean').toBe('boolean');
    expect(typeof body.key, 'response.key must be string').toBe('string');
    if (body.enabled) {
      // When enabled, the key MUST be a base64url string of at least
      // ~80 chars (raw P-256 public key is 65 bytes → ~87 chars b64u).
      expect(body.key.length, 'configured VAPID key looks too short').toBeGreaterThan(40);
      expect(body.key, 'VAPID key must be URL-base64 (no + / =)').not.toMatch(/[+/=]/);
    } else {
      expect(body.key, 'when not enabled, key must be empty string').toBe('');
    }
  });

  test('POST /api/v1/push/subscribe rejects missing identity (400)', async ({ request }) => {
    // Identity guard: device_hash AND user_id both empty must 400.
    const res = await request.post(`${BASE}/api/v1/push/subscribe`, {
      data: {
        endpoint: 'https://fcm.googleapis.com/wp/test/prod-smoke-no-id',
        keys: { p256dh: 'x'.repeat(80), auth: 'y'.repeat(20) },
        device_hash: null,
      },
      headers: { 'Content-Type': 'application/json' },
    });
    // 400 (no_identity) OR 422 (pydantic) both acceptable — both mean
    // the endpoint refused the malformed body, which is the contract.
    expect([400, 422]).toContain(res.status());
  });

  test('end-to-end submission: POST /reports/meta + GET /reports/ shows it', async ({ request }) => {
    // Apr 2026 — the deepest smoke we have. Catches:
    //   - PWA submission path broken at the BACKEND layer (auth, schema,
    //     persistence, retrieval) regardless of whether the UI works.
    //   - "Reports submitted but never appear on dashboard" symptom — IF
    //     it's actually a backend bug rather than a PWA wiring issue.
    //   - Backend deployment that boots but rejects the canonical capture
    //     payload shape (e.g., a schema-validator regression on a required
    //     enum value).
    //
    // Skip when the demo creds aren't injected (local dev — we don't want
    // tests prompting for passwords). In CI / prod-gate these are set as
    // workflow env vars.
    const email = process.env.CRISP_PROD_DEMO_EMAIL;
    const password = process.env.CRISP_PROD_DEMO_PASSWORD;
    const totpSecret = process.env.CRISP_PROD_DEMO_TOTP_SECRET;
    test.skip(
      !email || !password || !totpSecret,
      'demo creds not in env (CRISP_PROD_DEMO_{EMAIL,PASSWORD,TOTP_SECRET}) — skipping end-to-end submission smoke',
    );

    // Compute current TOTP code from the base32 secret — same algorithm
    // pyotp uses on the backend.
    const totp = await (async () => {
      const crypto = await import('node:crypto');
      const decoded = Buffer.from(
        (totpSecret as string).toUpperCase().replace(/=+$/, '') + '='.repeat((8 - (totpSecret as string).length % 8) % 8),
        'base64',
      );
      // Above is wrong base32; use a proper base32 decoder:
      const ALPH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      const clean = (totpSecret as string).toUpperCase().replace(/=+$/, '');
      let bits = '', bytes: number[] = [];
      for (const c of clean) {
        const v = ALPH.indexOf(c);
        if (v < 0) continue;
        bits += v.toString(2).padStart(5, '0');
      }
      while (bits.length >= 8) {
        bytes.push(parseInt(bits.slice(0, 8), 2));
        bits = bits.slice(8);
      }
      const key = Buffer.from(bytes);
      const counter = Buffer.alloc(8);
      counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
      const hmac = crypto.createHmac('sha1', key).update(counter).digest();
      const offset = hmac[hmac.length - 1] & 0x0f;
      const code =
        ((hmac[offset] & 0x7f) << 24 | (hmac[offset + 1] & 0xff) << 16 |
         (hmac[offset + 2] & 0xff) << 8 | (hmac[offset + 3] & 0xff)) % 1000000;
      return String(code).padStart(6, '0');
    })();

    // Step 1 — login
    const loginRes = await request.post(`${BASE}/api/v1/auth/login`, {
      data: { email, password, totp_code: totp },
      headers: { 'Content-Type': 'application/json' },
    });
    expect(loginRes.status(), `login failed: ${loginRes.status()} ${await loginRes.text()}`).toBe(200);
    const { access_token: token } = await loginRes.json();
    expect(token, 'login response missing access_token').toBeTruthy();

    // Pre-allocated outside the try block so the finally cleanup can
    // see them even if assertions fail in the middle of the test.
    const deviceHash = `prod-smoke-${Date.now()}`;
    const clientReportId = `cr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // May 2026 — wrap in try/finally so the synthetic row is ALWAYS
    // cleaned up, even on assertion failure. Before this guard every
    // deploy left a "Prod-smoke synthetic report …" row behind in
    // production; over weeks of CI activity that accumulated into
    // visible noise on the analyst dashboard. The DELETE endpoint is
    // the same one the PWA's "Delete My Data" privacy feature uses
    // (open, no auth — keyed by device_hash) so the cleanup doesn't
    // need extra permissions.
    try {
      // Step 2 — count current reports
      const beforeRes = await request.get(`${BASE}/api/v1/reports/?limit=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const beforeCount = parseInt(beforeRes.headers()['x-total-count'] || '0', 10);

      // Step 3 — submit a synthetic report. Schema mirrors what the PWA's
      // app.js builds before POST /reports/meta. Required fields per the
      // FastAPI Pydantic validator: device_hash, client_report_id,
      // crisis_type, damage_classification (MINIMAL|NO_DAMAGE|PARTIAL|COMPLETE),
      // infrastructure_type, etc.
      // infrastructure_type=COMMERCIAL is intentionally chosen here over
      // RESIDENTIAL — COMMERCIAL was missing from the Postgres infratypeenum
      // until migration 0012 because 0003 only added the targets of legacy
      // chip remaps (CHIP_TO_UNDP.values()) and no legacy chips mapped to
      // COMMERCIAL or PUBLIC_SPACES. Submitting COMMERCIAL here ensures that
      // class of "Python enum has it, Postgres enum doesn't" drift gets
      // caught at the gate, not by user reports.
      const submitRes = await request.post(`${BASE}/api/v1/reports/meta`, {
        data: {
          device_hash: deviceHash,
          client_report_id: clientReportId,
          crisis_type: 'EARTHQUAKE',
          damage_classification: 'PARTIAL',
          infrastructure_type: 'COMMERCIAL',
          severity: 'MODERATE',
          description: `Prod-smoke synthetic report ${new Date().toISOString()}`,
          gps_lat: 12.9716,
          gps_lng: 77.5946,
          gps_accuracy_m: 10,
          client_created_at: new Date().toISOString(),
          client_blur_applied: true,
        },
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      expect(
        submitRes.status(),
        `submission rejected: ${submitRes.status()} ${await submitRes.text()}`,
      ).toBe(201);
      const newReport = await submitRes.json();
      expect(newReport.id, 'submission response missing report id').toBeTruthy();

      // Step 4 — verify it shows up in the list
      const afterRes = await request.get(`${BASE}/api/v1/reports/?limit=10`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const afterCount = parseInt(afterRes.headers()['x-total-count'] || '0', 10);
      expect(
        afterCount,
        `report count didn't increment: before=${beforeCount} after=${afterCount}`,
      ).toBe(beforeCount + 1);

      const afterList = await afterRes.json();
      const found = afterList.some((r: any) => r.id === newReport.id);
      expect(found, `submitted report ${newReport.id} not in dashboard fetch`).toBe(true);
    } finally {
      // Step 5 — ALWAYS clean up. Best-effort: if the deletion endpoint
      // is itself broken, surface the error in console but don't mask
      // an upstream assertion failure. Each deploy used to leak one
      // synthetic row to prod; over the May 2026 sprint that turned
      // into ~30 stale rows. Now: 0 net new rows per deploy.
      try {
        const cleanupRes = await request.delete(
          `${BASE}/api/v1/reports/device/${encodeURIComponent(deviceHash)}`,
        );
        if (cleanupRes.status() !== 200) {
          console.error(
            `[prod-smoke] cleanup DELETE returned ${cleanupRes.status()} for ` +
              `device_hash=${deviceHash}; row may persist in prod`,
          );
        } else {
          const body = await cleanupRes.json().catch(() => ({}));
          console.log(
            `[prod-smoke] cleaned up ${body.deleted ?? '?'} report(s) for ` +
              `device_hash=${deviceHash}`,
          );
        }
      } catch (e: any) {
        console.error(
          `[prod-smoke] cleanup threw for device_hash=${deviceHash}: ${e?.message || e}`,
        );
      }
    }
  });

  test('Content-Security-Policy header is present + complete', async ({ request }) => {
    const res = await request.get(`${BASE}/mobile-app/src/index.html`);
    const csp = res.headers()['content-security-policy'] || '';
    // Required pieces — without these, prod features break:
    const required = [
      "script-src 'self'",
      "'unsafe-eval'",                          // TFJS WebGL shader compilation
      'https://unpkg.com',                      // Leaflet + Turf
      'https://cdn.jsdelivr.net',               // TFJS, BlazeFace
      'https://nominatim.openstreetmap.org',    // PWA reverse-geocode
      'https://overpass-api.de',                // Building selector
      'https://storage.googleapis.com',         // TFJS model weights
      'https://www.kaggle.com',                 // BlazeFace model.json (newer)
      'https://*.basemaps.cartocdn.com',        // Dashboard dark map tiles
      'https://server.arcgisonline.com',        // Dashboard satellite tiles
      'worker-src',                             // TFJS workers
    ];
    for (const piece of required) {
      expect(csp, `CSP missing: ${piece}\nactual:\n${csp}`).toContain(piece);
    }
  });

  test('CSP connect-src covers every SW-intercepted CDN host', async ({ request }) => {
    // Apr 2026 — regression guard for the "normal-refresh fails / hard-refresh
    // works" prod outage. Root cause: the dashboard service worker uses
    // cacheFirst for CDN assets (unpkg, cdnjs.cloudflare.com, fonts.gstatic.com,
    // fonts.googleapis.com). On cache miss, it does fetch(request) FROM
    // INSIDE THE SW. That SW-context fetch is governed by `connect-src`,
    // NOT by the directive that originally allowed the resource (script-src
    // / style-src / font-src). The page CSP allowed those hosts under their
    // load-time directives but had not extended `connect-src` — so the SW's
    // internal refetch was hitting the connect-src wall and falling through
    // to the catch block, which returned a synthetic 503. Hard-refresh
    // bypassed the SW entirely so the browser-driven element fetch succeeded.
    //
    // This test parses the CSP and asserts every SW-intercepted host is in
    // connect-src so the bug class never reships.
    const res = await request.get(`${BASE}/mobile-app/src/index.html`);
    const csp = res.headers()['content-security-policy'] || '';

    // Parse "directive 'src' 'src' ..." segments (split on ';').
    const directives: Record<string, string[]> = {};
    for (const seg of csp.split(';').map((s) => s.trim()).filter(Boolean)) {
      const [name, ...sources] = seg.split(/\s+/);
      directives[name] = sources;
    }

    // Hosts the dashboard + PWA service workers cacheFirst-intercept. If you
    // add a new CDN to either sw.js, add it here too — and also to
    // connect-src in nginx.conf, which is what this test guards.
    //
    // Apr 2026 (round 2) — extended to cover ALL cross-origin hosts the
    // dashboard SW could intercept via its catch-all (web-dashboard/src/
    // sw.js:103: `event.respondWith(fetch(request).catch(...))`). Any
    // cross-origin GET that hits that branch goes through SW.fetch →
    // governed by connect-src. So tile hosts (which are only in img-src
    // for browser-driven loads) ALSO need connect-src once the SW is
    // active. Previously we only covered the unpkg/cdnjs/gstatic trio
    // and shipped a bug where map tiles failed normal-refresh.
    const swInterceptedHosts = [
      'https://unpkg.com',                  // Leaflet + clustering + heat
      'https://cdnjs.cloudflare.com',       // FontAwesome
      'https://fonts.gstatic.com',          // Google Fonts files
      'https://*.tile.openstreetmap.org',   // OSM tiles (PWA + dashboard)
      'https://*.basemaps.cartocdn.com',    // Dashboard dark map tiles
      'https://server.arcgisonline.com',    // Dashboard satellite tiles
      // fonts.googleapis.com covered by *.googleapis.com wildcard.
    ];

    const connectSrc = directives['connect-src'] || [];
    const missing = swInterceptedHosts.filter((h) => {
      if (connectSrc.includes(h)) return false;
      // Wildcard match: if the directive has https://*.foo.com, it covers
      // any subdomain. h itself may also be a wildcard literal.
      return !connectSrc.some((s) =>
        s.startsWith('https://*.') &&
        (h === s || h.endsWith(s.slice(9))),
      );
    });

    expect(
      missing,
      `connect-src missing SW-intercepted host(s): ${missing.join(', ')}\n` +
        `WHY THIS MATTERS: SW cacheFirst does fetch(request) on cache miss; that fetch\n` +
        `is governed by connect-src (NOT script-src / style-src / font-src). Without\n` +
        `these in connect-src, normal-refresh returns 503 from the SW catch handler.\n` +
        `Hard-refresh bypasses the SW so the symptom is "refresh fails, hard-refresh works."\n` +
        `actual connect-src:\n  ${connectSrc.join(' ')}`,
    ).toEqual([]);
  });

  test('HTML responses set Cache-Control: no-cache to prevent stale-CSP pinning', async ({ request }) => {
    // Apr 2026 — companion regression guard. Even after a CSP fix is
    // deployed, browsers can keep serving the OLD HTML from their HTTP
    // cache (heuristic-cached because nginx didn't send any Cache-Control
    // header). The page's CSP comes back from that cached response, so
    // the browser keeps applying the OLD CSP. User symptom: "I deployed
    // the fix, hard-refresh works, normal-refresh still fails."
    //
    // Fix: nginx adds `Cache-Control: no-cache, must-revalidate` for HTML
    // (and sw.js). That forces every refresh to revalidate the body +
    // headers with the server. Body still cached locally and reused on
    // 304 — UX stays fast.
    const probes = [
      `${BASE}/mobile-app/src/index.html`,
      `${BASE}/web-dashboard/src/index.html`,
      `${BASE}/web-dashboard/src/login.html`,
      `${BASE}/mobile-app/src/sw.js`,
      `${BASE}/web-dashboard/src/sw.js`,
    ];
    for (const url of probes) {
      const res = await request.get(url);
      expect(res.status(), `${url} must return 200`).toBe(200);
      const cc = (res.headers()['cache-control'] || '').toLowerCase();
      expect(
        cc,
        `${url} must declare no-cache so a deployed CSP fix isn't pinned by browser HTTP cache.\n` +
          `Without this, "normal refresh" can keep serving stale HTML with stale CSP for hours.\n` +
          `actual: '${res.headers()['cache-control']}'`,
      ).toContain('no-cache');
    }
  });
});
