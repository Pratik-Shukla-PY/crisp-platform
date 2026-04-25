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

    await page.goto(`${BASE}/mobile-app/src/`, { waitUntil: 'networkidle' });

    // Wait one extra beat for any lazy-loaded scripts to settle.
    await page.waitForTimeout(2000);

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

  test('global libraries from CDN are loaded (Leaflet + TFJS + BlazeFace)', async ({ page }) => {
    await page.goto(`${BASE}/mobile-app/src/`, { waitUntil: 'load' });
    // These are loaded by <script> tags in index.html. If CSP blocks them,
    // the global will be undefined.
    const globals = await page.evaluate(() => ({
      L: typeof (window as any).L,
      tf: typeof (window as any).tf,
      blazeface: typeof (window as any).blazeface,
      BuildingSelect: typeof (window as any).BuildingSelect,
      I18N: typeof (window as any).I18N,
    }));
    expect(globals.L, 'Leaflet (window.L) — building selector + map will not work').toBe('object');
    expect(globals.tf, 'TFJS (window.tf) — PII blur will not work').toBe('object');
    expect(globals.blazeface, 'BlazeFace (window.blazeface) — face detection will not work').toBe('object');
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

  test('Content-Security-Policy header is present + complete', async ({ request }) => {
    const res = await request.get(`${BASE}/mobile-app/src/index.html`);
    const csp = res.headers()['content-security-policy'] || '';
    // Required pieces — without these, prod features break:
    const required = [
      "script-src 'self'",
      'https://unpkg.com',         // Leaflet + Turf
      'https://cdn.jsdelivr.net',  // TFJS, BlazeFace
      'https://nominatim.openstreetmap.org',
      'https://overpass-api.de',
      'https://storage.googleapis.com',
      'worker-src',
    ];
    for (const piece of required) {
      expect(csp, `CSP missing: ${piece}\nactual:\n${csp}`).toContain(piece);
    }
  });
});
