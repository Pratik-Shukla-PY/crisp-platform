/**
 * PWA in-app update prompt - the "New version available · Update" banner.
 *
 * Regression guard for the bug where the Update button froze at
 * "Updating…" forever (reproduced cross-engine, ground-truthed via
 * caches.keys()): the banner was removed ONLY by a reload fired from
 * 'controllerchange', so whenever the new worker installed but never
 * ACTIVATED (iOS standalone suspended on backgrounding; a 'redundant'
 * worker left by a 2nd deploy where postMessage is a silent no-op; a
 * wedged active worker) the button was stuck with no recovery.
 *
 * These tests need a REAL service-worker update lifecycle (install →
 * activate → cache migration), which Playwright's `route()` interception
 * of the SW script corrupts. So the spec serves a disk COPY of the PWA
 * from a tiny inline static server and mutates the copy's sw.js between
 * steps - the SW lifecycle is 100% native, and caches.keys() is the
 * ground-truth signal for whether the worker actually changed.
 */
import { test, expect } from '@playwright/test';
import { createServer, Server } from 'node:http';
import { createReadStream, cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';

const REPO_SRC = join(__dirname, '..', '..', '..', 'mobile-app', 'src');
const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

let server: Server;
let baseUrl = '';
let tmpRoot = '';
let swPath = '';
let baseSw = '';

function currentCacheName(src: string): string {
  const m = src.match(/const CACHE_NAME = '(crisp-v\d+)'/);
  if (!m) throw new Error('could not find CACHE_NAME in sw.js');
  return m[1];
}
function writeBaseSw() { writeFileSync(swPath, baseSw); }
function writeVariant(tag: string, opts: { neuter?: boolean } = {}) {
  let s = baseSw.replace(/const CACHE_NAME = 'crisp-v\d+'/, `const CACHE_NAME = 'crisp-${tag}'`);
  if (!s.includes(`'crisp-${tag}'`)) throw new Error('CACHE_NAME replace failed');
  if (opts.neuter) {
    // Suppress self.skipWaiting() so the new worker installs but never
    // activates - models the real "activation never completes" failure.
    s = s.replace(/(type === 'SKIP_WAITING'\) \{)/, '$1 return;');
    if (!s.includes('SKIP_WAITING\') { return;')) throw new Error('neuter replace failed');
  }
  writeFileSync(swPath, s + `\n// variant-${tag}\n`);
}

test.beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'crisp-pwa-upd-'));
  cpSync(REPO_SRC, join(tmpRoot, 'mobile-app', 'src'), { recursive: true });
  swPath = join(tmpRoot, 'mobile-app', 'src', 'sw.js');
  baseSw = readFileSync(swPath, 'utf8');
  server = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    let fsPath = normalize(join(tmpRoot, urlPath));
    if (!fsPath.startsWith(tmpRoot)) { res.statusCode = 403; return res.end(); }
    if (fsPath.endsWith('/')) fsPath = join(fsPath, 'index.html');
    if (!existsSync(fsPath)) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', MIME[extname(fsPath)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');   // SW update must see fresh bytes
    res.setHeader('Service-Worker-Allowed', '/');
    createReadStream(fsPath).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}/mobile-app/src/`;
});

test.afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (tmpRoot) try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* noop */ }
});

test.beforeEach(() => writeBaseSw());

// Run serially - the tests share one mutable on-disk sw.js.
test.describe.configure({ mode: 'serial' });

async function boot(page) {
  // Shorten the activation watchdog so the recovery path is testable fast.
  await page.addInitScript(() => { (window as any).__crispPwaActivateTimeoutMs = 1500; });
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 25000 });
}
const cacheKeys = (page) => page.evaluate(async () => (await caches.keys()).filter((k: string) => k.startsWith('crisp-')));
const triggerUpdate = (page) => page.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); await r!.update(); });

test.describe('PWA update banner', () => {
  test('happy path: tap Update activates the new SW and clears the banner', async ({ page }) => {
    const before = currentCacheName(baseSw);
    let loads = 0; page.on('load', () => { loads++; });
    await boot(page);
    expect(await cacheKeys(page)).toEqual([before]);

    writeVariant('v980happy');
    await triggerUpdate(page);
    await expect(page.locator('#pwa-update-banner')).toBeVisible({ timeout: 12000 });

    const loadsBefore = loads;
    await page.locator('.pwa-update-banner-btn').click();
    // Banner clears via a single confirmed-activation reload...
    await expect(page.locator('#pwa-update-banner')).toHaveCount(0, { timeout: 8000 });
    // ...and the active SW genuinely changed (ground truth).
    await expect.poll(() => cacheKeys(page), { timeout: 6000 }).toContain('crisp-v980happy');
    expect(loads - loadsBefore).toBeLessThanOrEqual(1);
  });

  test('activation never completes: button RECOVERS, never freezes, no reload loop', async ({ page }) => {
    let loads = 0; page.on('load', () => { loads++; });
    await boot(page);

    writeVariant('v981neuter', { neuter: true });
    await triggerUpdate(page);
    const banner = page.locator('#pwa-update-banner');
    await expect(banner).toBeVisible({ timeout: 12000 });

    const loadsBefore = loads;
    await page.locator('.pwa-update-banner-btn').click();

    // After the watchdog window the banner must NOT be frozen at "Updating…".
    // It recovers: error state, button re-enabled to a tappable label.
    await expect(banner).toHaveClass(/is-error/, { timeout: 5000 });
    const btn = page.locator('.pwa-update-banner-btn');
    await expect(btn).toBeEnabled();
    await expect(btn).not.toHaveText(/Updating/i);
    // Critical: NO reload happened (a blind reload would loop the banner),
    // and the SW did not (falsely) activate. The neutered worker INSTALLS
    // (its cache exists) but never ACTIVATES, so the ORIGINAL cache is
    // still present - an activated new worker would have deleted it.
    expect(loads - loadsBefore).toBe(0);
    expect(await cacheKeys(page)).toContain(currentCacheName(baseSw));
  });

  test('stale worker: a 2nd update before tap still activates a new SW and clears', async ({ page }) => {
    await boot(page);
    writeVariant('v982a');
    await triggerUpdate(page);
    await expect(page.locator('#pwa-update-banner')).toBeVisible({ timeout: 12000 });
    // A newer version lands while the banner is still showing the old worker.
    writeVariant('v982b');
    await triggerUpdate(page);
    await page.waitForTimeout(1200);

    await page.locator('.pwa-update-banner-btn').click();
    await expect(page.locator('#pwa-update-banner')).toHaveCount(0, { timeout: 8000 });
    // A newer SW (a or b - whichever the engine settled on) is now active.
    const keys = await cacheKeys(page);
    expect(keys.some((k: string) => k === 'crisp-v982a' || k === 'crisp-v982b')).toBeTruthy();
  });
});
