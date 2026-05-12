/**
 * PWA — network-hygiene regression guards (May 2026).
 *
 * Driven by a landing-page refresh HAR trace (`/Users/pks/Desktop/
 * logs-1.har`) that surfaced three bugs:
 *
 *   1. CRITICAL — `_syncDeleteQueue` (app.js:9610) fired DELETE
 *      against `/api/v1/reports/<id>` WITHOUT an Authorization
 *      header. Backend rejected with 401, the entry stayed in the
 *      delete queue forever, retried on every reconnect.
 *
 *   2. MEDIUM — `GET /api/v1/reports/profile/<device-hash>` was
 *      called 7× per page load (3 call sites + race + retry-on-404
 *      cascade). 150 ms cumulative waste + console-pollution.
 *
 *   3. LOW — `GET /api/v1/reports/device/<hash>/status-since` was
 *      called 3× per page load (boot + My Reports panel + home-
 *      screen.js home-stats badges all raced). 45 KB bandwidth waste.
 *
 * Fix shipped alongside this spec: a single-flight + short-TTL fetch
 * cache (`_singleFlightFetch` in app.js, exposed as
 * `window.__crispSingleFlightFetch`). All three problem sites are
 * routed through it; the DELETE path also picks up an Authorization
 * header from the captured-at-enqueue or live AuthStore token.
 */
import { test, expect, Page } from '@playwright/test';

async function bootPwa(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispSingleFlightFetch === 'function',
        null, { timeout: 8000 },
    );
}

test.describe('PWA — network-hygiene (HAR-driven, May 2026)', () => {

    test.beforeEach(async ({ page }) => {
        await bootPwa(page);
        // Clear the fetch cache so each test starts from a clean slate.
        await page.evaluate(() => {
            const clear = (window as any).__crispClearFetchCache;
            if (typeof clear === 'function') clear();
        });
    });

    test('@smoke single-flight helper is exposed on window', async ({ page }) => {
        const exposed = await page.evaluate(() => ({
            singleFlightFetch: typeof (window as any).__crispSingleFlightFetch === 'function',
            clearFetchCache:   typeof (window as any).__crispClearFetchCache === 'function',
        }));
        expect(exposed.singleFlightFetch).toBe(true);
        expect(exposed.clearFetchCache).toBe(true);
    });

    test('single-flight: 5 concurrent GETs for the same URL fire ONE network call', async ({ page }) => {
        // Instrument: intercept the target URL + count how many times
        // the route handler is invoked. The helper should coalesce all
        // 5 callers onto one Promise.
        let networkHits = 0;
        await page.route('**/__sf_test_endpoint', (route) => {
            networkHits++;
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ok: true, hit: networkHits }),
            });
        });
        const url = `${page.url().split('mobile-app')[0]}__sf_test_endpoint`;
        const responses = await page.evaluate(async (target) => {
            const fn = (window as any).__crispSingleFlightFetch;
            // Fire 5 concurrent GETs for the same URL.
            const promises = Array.from({ length: 5 }, () => fn(target));
            const results = await Promise.all(promises);
            // Each response must be independently readable (the helper
            // .clone()s on coalesced returns).
            const bodies = await Promise.all(results.map((r) => r.json()));
            return bodies;
        }, url);
        expect(networkHits, '5 concurrent GETs must hit network ONCE').toBe(1);
        expect(responses.length).toBe(5);
        // Each caller reads { ok: true, hit: 1 } since they all share the
        // single in-flight response.
        for (const body of responses) {
            expect(body.ok).toBe(true);
            expect(body.hit).toBe(1);
        }
    });

    test('single-flight: cached response served within TTL without re-hitting network', async ({ page }) => {
        let networkHits = 0;
        await page.route('**/__sf_cache_endpoint', (route) => {
            networkHits++;
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ tick: networkHits }),
            });
        });
        const url = `${page.url().split('mobile-app')[0]}__sf_cache_endpoint`;
        const sequence = await page.evaluate(async (target) => {
            const fn = (window as any).__crispSingleFlightFetch;
            const first = await fn(target).then((r: Response) => r.json());
            // Brief gap (longer than the inflight settle, well below TTL).
            await new Promise((r) => setTimeout(r, 200));
            const second = await fn(target).then((r: Response) => r.json());
            return [first.tick, second.tick];
        }, url);
        expect(networkHits, 'cache should serve the second call').toBe(1);
        expect(sequence[0]).toBe(1);
        expect(sequence[1], 'second read serves the cached body').toBe(1);
    });

    test('single-flight: POST always passes through (no dedupe)', async ({ page }) => {
        let networkHits = 0;
        await page.route('**/__sf_post_endpoint', (route) => {
            networkHits++;
            return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ pong: networkHits }),
            });
        });
        const url = `${page.url().split('mobile-app')[0]}__sf_post_endpoint`;
        await page.evaluate(async (target) => {
            const fn = (window as any).__crispSingleFlightFetch;
            await Promise.all([
                fn(target, { method: 'POST', body: 'a' }),
                fn(target, { method: 'POST', body: 'b' }),
                fn(target, { method: 'POST', body: 'c' }),
            ]);
        }, url);
        expect(networkHits, 'POSTs must NOT be deduped (idempotency unsafe)').toBe(3);
    });

    test('HAR Fix 1: delete-queue replay sends Authorization header when token captured', async ({ page }) => {
        // Inject a known token into AuthStore + enqueue a delete via
        // _enqueueDelete, then trigger _syncDeleteQueue and verify the
        // outgoing fetch carries Bearer.
        let observedAuth = '';
        let deleteHit = false;
        await page.route('**/api/v1/reports/test-delete-auth-id', (route) => {
            deleteHit = true;
            observedAuth = route.request().headers()['authorization'] || '';
            return route.fulfill({ status: 200, body: '{}' });
        });

        await page.evaluate(async () => {
            // Stub AuthStore so the captured-token capture works in
            // the test environment (real AuthStore needs the full
            // login flow).
            (window as any).AuthStore = {
                getAccessToken: () => 'TEST.TOKEN.HAR-FIX-1',
            };
            // Use the existing enqueueDelete machinery via the storage
            // shape it expects.
            const KEY = 'crisp_report_delete_queue_v1';
            const entry = { id: 'test-delete-auth-id', auth_token: 'TEST.TOKEN.HAR-FIX-1' };
            localStorage.setItem(KEY, JSON.stringify([entry]));
            // Trigger the sync. The function isn't exposed on window
            // — dispatch an 'online' event which is the production
            // trigger (window.addEventListener('online', ...)).
            window.dispatchEvent(new Event('online'));
            // The handler is async — give it a tick to settle.
            await new Promise((r) => setTimeout(r, 300));
        });

        expect(deleteHit, 'DELETE fetch must fire').toBe(true);
        expect(observedAuth, 'DELETE must include Bearer header').toBe('Bearer TEST.TOKEN.HAR-FIX-1');

        // Queue should have drained (200 → dequeue).
        const queueAfter = await page.evaluate(() => {
            try {
                const raw = localStorage.getItem('crisp_report_delete_queue_v1');
                return raw ? JSON.parse(raw) : [];
            } catch (_) { return null; }
        });
        expect(queueAfter, 'queue must drain on 200').toEqual([]);
    });

    test('HAR Fix 1: 401 response does NOT drain the queue (retry safety)', async ({ page }) => {
        // If the token is bad / missing, we MUST keep the entry queued
        // so a re-login can re-attempt later — the original prod bug
        // was that this case was silent + the queue accumulated forever.
        let networkHits = 0;
        await page.route('**/api/v1/reports/test-delete-401-id', (route) => {
            networkHits++;
            return route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: '{"detail":"Unauthorized"}',
            });
        });

        await page.evaluate(async () => {
            // No AuthStore token + no captured one — request goes out
            // headerless, backend 401s.
            (window as any).AuthStore = { getAccessToken: () => null };
            const KEY = 'crisp_report_delete_queue_v1';
            localStorage.setItem(KEY, JSON.stringify([{ id: 'test-delete-401-id' }]));
            window.dispatchEvent(new Event('online'));
            await new Promise((r) => setTimeout(r, 300));
        });

        expect(networkHits, 'DELETE attempt must fire').toBeGreaterThan(0);

        const queueAfter = await page.evaluate(() => {
            try {
                const raw = localStorage.getItem('crisp_report_delete_queue_v1');
                return raw ? JSON.parse(raw) : [];
            } catch (_) { return null; }
        });
        expect(queueAfter?.length, '401 must NOT drain the entry — it survives for next login').toBe(1);
    });
});
