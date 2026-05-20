/**
 * UNDP §5 adaptive-tier regression guards (Apr 2026).
 *
 * Fixes the 2 Kbps bug: tier detector trusted `navigator.connection.effectiveType`
 * which Chrome DevTools throttling doesn't update. Client stuck on MEDIUM
 * → 128 KB chunks → every chunk times out → upload dead for 40+ minutes.
 *
 * This spec verifies the three fixes:
 *
 *   1. `detectPWANetworkTier()` with `downlink: 0` on `effectiveType: "4g"`
 *      falls to SLOW, not MEDIUM (the browser is explicitly saying "I
 *      don't know the bandwidth" in that shape).
 *   2. `measureUploadBandwidth()` measures actual round-trip throughput
 *      against `/reports/upload-probe` and returns bytes/sec.
 *   3. `pickTierFromBandwidth(bps)` maps thresholds correctly — in
 *      particular, any throughput below 10 KB/s (80 Kbps) resolves to
 *      VERY_SLOW, which is the only tier that can uphold a 2 Kbps
 *      upload (1 KB chunks, 60 s tier timeout, ~17 s dynamic timeout).
 *   4. `computeChunkTimeout(chunkSize, bps)` scales a timeout to the
 *      measurement so a correctly-sized chunk never false-times-out.
 */
import { test, expect } from '@playwright/test';

async function openPwa(page) {
  await page.goto('index.html');
  await page.evaluate(() => {
    localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');  // Pre-v4 tests target the v3 capture flow.
  });
  await page.reload();
  const enBtn = page.locator('#btn-lang-en');
  if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
  await page.evaluate(() => {
    const c = document.getElementById('consent-overlay');
    if (c) c.style.display = 'none';
  });
}

test.describe('PWA adaptive-tier (UNDP §5 follow-up)', () => {
  test.beforeEach(async ({ page }) => { await openPwa(page); });

  test('helpers are exposed on window', async ({ page }) => {
    const g = await page.evaluate(() => ({
      measureUploadBandwidth:  typeof (window as any).measureUploadBandwidth  === 'function',
      pickTierFromBandwidth:   typeof (window as any).pickTierFromBandwidth   === 'function',
      adaptTierViaProbe:       typeof (window as any).adaptTierViaProbe       === 'function',
      computeChunkTimeout:     typeof (window as any).computeChunkTimeout     === 'function',
      getMeasuredBandwidth:    typeof (window as any).getMeasuredBandwidth    === 'function',
      getCurrentPWATier:       typeof (window as any).getCurrentPWATier       === 'function',
    }));
    expect(g.measureUploadBandwidth).toBeTruthy();
    expect(g.pickTierFromBandwidth).toBeTruthy();
    expect(g.adaptTierViaProbe).toBeTruthy();
    expect(g.computeChunkTimeout).toBeTruthy();
    expect(g.getMeasuredBandwidth).toBeTruthy();
    expect(g.getCurrentPWATier).toBeTruthy();
  });

  test('pickTierFromBandwidth covers every boundary correctly', async ({ page }) => {
    const results = await page.evaluate(() => {
      const pick = (window as any).pickTierFromBandwidth;
      return {
        zero:              pick(0),
        negative:          pick(-1),
        dial_up_2kbps:     pick(250),           // 2 Kbps = 250 B/s
        slow_100kbps:      pick(12_500),        // 100 Kbps
        medium_1_5mbps:    pick(200_000),       // 1.6 Mbps
        fast_20mbps:       pick(2_500_000),     // 20 Mbps
        edge_very_slow:    pick(9_999),         // just under 10 KB/s
        edge_slow:         pick(10_000),        // exactly 10 KB/s → SLOW
        edge_medium:       pick(100_000),       // exactly 100 KB/s → MEDIUM
        edge_fast:         pick(1_000_000),     // exactly 1 MB/s → FAST
      };
    });
    expect(results.zero).toBe('VERY_SLOW');
    expect(results.negative).toBe('VERY_SLOW');
    expect(results.dial_up_2kbps).toBe('VERY_SLOW');
    expect(results.slow_100kbps).toBe('SLOW');
    expect(results.medium_1_5mbps).toBe('MEDIUM');
    expect(results.fast_20mbps).toBe('FAST');
    expect(results.edge_very_slow).toBe('VERY_SLOW');
    expect(results.edge_slow).toBe('SLOW');
    expect(results.edge_medium).toBe('MEDIUM');
    expect(results.edge_fast).toBe('FAST');
  });

  test('detectPWANetworkTier with downlink=0 falls to SLOW (not MEDIUM)', async ({ page }) => {
    // Monkey-patch navigator.connection before the detector runs. This
    // reproduces the exact state observed in the 2 Kbps field test:
    // effectiveType: "4g", downlink: 0.
    const tier = await page.evaluate(() => {
      try {
        Object.defineProperty(navigator, 'connection', {
          configurable: true,
          value: { effectiveType: '4g', downlink: 0, rtt: 0, saveData: false },
        });
      } catch (_) { /* some browsers lock it — skip */ }
      (window as any).detectPWANetworkTier();
      return (window as any).getCurrentPWATier();
    });
    // Before the fix this returned 'MEDIUM'. After the fix it falls to
    // SLOW as a conservative pre-probe default.
    expect(tier).toBe('SLOW');
  });

  test('computeChunkTimeout scales with measured bandwidth', async ({ page }) => {
    const result = await page.evaluate(() => {
      const compute = (window as any).computeChunkTimeout;
      return {
        // Dial-up 250 B/s, 1 KB chunk → expected 4000 ms × 3 + 5000 = 17000 ms
        very_slow_1kb:  compute(1024,    250),
        // 100 KB/s, 32 KB chunk → 320 ms × 3 + 5000 = 5960 → floored at 10000
        slow_32kb:      compute(32768,   100_000),
        // 1 MB/s, 128 KB chunk → 128 ms × 3 + 5000 = 5384 → floored at 10000
        medium_128kb:   compute(131072,  1_000_000),
        // No measurement — falls to the tier-table default 30000.
        no_probe_512kb: compute(524288,  null),
      };
    });
    expect(result.very_slow_1kb).toBeGreaterThanOrEqual(15_000);
    expect(result.very_slow_1kb).toBeLessThanOrEqual(20_000);
    expect(result.slow_32kb).toBe(10_000);       // floor
    expect(result.medium_128kb).toBe(10_000);    // floor
    expect(result.no_probe_512kb).toBeGreaterThanOrEqual(30_000);
  });

  test('adaptTierViaProbe picks VERY_SLOW when probe round-trip is slow', async ({ page, baseURL }) => {
    // Intercept the probe endpoint and delay the response so the
    // client's measured bytes/sec lands in the VERY_SLOW bucket.
    //
    // Phase L L.5 (May 2026): probe size bumped 8 KB → 64 KB to clear
    // the latency floor at typical cloudflare-tunnel RTTs. The bps
    // arithmetic now uses 65 536 bytes, so the delay needed to fall
    // below the 10 KB/s SLOW→VERY_SLOW threshold is:
    //   65 536 ÷ 10 000 = 6.55 s minimum
    // Use 7 500 ms for headroom: 65 536 / 7 500 = ~8 740 B/s ⇒ VERY_SLOW.
    // Pre-L.5 this test delayed 1 500 ms (8 192 / 1.5 s ≈ 5 461 B/s).
    await page.route('**/reports/upload-probe', async (route) => {
      await new Promise((r) => setTimeout(r, 7500));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ received_bytes: 65_536, server_time_ms: Date.now() }),
      });
    });
    const tier = await page.evaluate(async () => {
      await (window as any).adaptTierViaProbe({ force: true });
      return (window as any).getCurrentPWATier();
    });
    expect(tier).toBe('VERY_SLOW');
  });
});
