/**
 * Throttled CLS probe — reproduces PROD Lighthouse audit conditions
 * LOCALLY so we don't burn CI minutes iterating on cycle-PROD-deploy
 * cycles. PROD-audit measured CLS=0.422 on commit 169ca28 vs CLS=0.228
 * on un-throttled localhost — the ~2× delta is what this probe closes.
 *
 * Throttle profile: matches Lighthouse's "mobile" preset
 *   • Network: Slow 4G  — 1.6 Mbps down / 750 Kbps up / 150 ms RTT
 *   • CPU: 4× slowdown
 *   • Viewport: 412×823 (Moto G Power, the LHCI default UA)
 *
 * Reports every layout-shift entry over the first 10 s with the
 * shifting element's selector + prev/curr rects. Sorted by impact
 * value so the top contributors land at the top.
 *
 * NOT a regression spec. One-off investigation tool. Delete once
 * throttled CLS clears 0.25 in CI.
 */
import { test } from '@playwright/test';

test('throttled layout-shift probe — Lighthouse-mobile preset', async ({ page, context }) => {
    // Pre-seed localStorage BEFORE goto so the first-paint cycle
    // matches what a Lighthouse audit sees (fresh visitor, but
    // privacy consent already accepted via the inline pre-paint
    // script we'll add. NOTE: removed here so we measure the
    // FIRST-time-visitor case which is what Lighthouse actually
    // tests).
    // No localStorage seed — first-time-visitor scenario.

    const shifts: any[] = [];
    await page.exposeFunction('__captureShift', (s: any) => { shifts.push(s); });

    await page.addInitScript(() => {
        const w = window as any;
        const cap = () => {
            try {
                const po = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries() as any[]) {
                        const sources = (entry.sources || []).map((s: any) => {
                            const n = s.node;
                            if (!n) return { hadNoNode: true };
                            let label = n.nodeName ? n.nodeName.toLowerCase() : '?';
                            if (n.id) label += '#' + n.id;
                            else if (n.className && typeof n.className === 'string') {
                                label += '.' + n.className.split(/\s+/).slice(0, 2).join('.');
                            }
                            return {
                                target: label,
                                prev: { x: s.previousRect?.x, y: s.previousRect?.y, w: s.previousRect?.width, h: s.previousRect?.height },
                                curr: { x: s.currentRect?.x,  y: s.currentRect?.y,  w: s.currentRect?.width,  h: s.currentRect?.height },
                            };
                        });
                        w.__captureShift({
                            value: entry.value,
                            startTime: Math.round(entry.startTime),
                            hadRecentInput: entry.hadRecentInput,
                            sources,
                        });
                    }
                });
                po.observe({ type: 'layout-shift', buffered: true });
            } catch (e) { /* not supported */ }
        };
        if (document.readyState === 'loading') {
            document.addEventListener('readystatechange', cap, { once: true });
        } else { cap(); }
    });

    // ── Lighthouse-mobile throttle ────────────────────────────────────
    await page.setViewportSize({ width: 412, height: 823 });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 150,                  // 150 ms RTT
        downloadThroughput: 1.6 * 1024 * 1024 / 8,  // 1.6 Mbps
        uploadThroughput:   0.75 * 1024 * 1024 / 8, // 750 Kbps
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

    await page.goto('index.html', { waitUntil: 'load' });
    await page.waitForTimeout(10000);  // 10 s capture window (Lighthouse's TTI window)

    const sorted = shifts.sort((a, b) => b.value - a.value);
    const total = sorted.reduce((s, e) => s + (e.hadRecentInput ? 0 : e.value), 0);
    const withInput = sorted.reduce((s, e) => s + e.value, 0);
    console.log('\n=== Throttled layout-shift entries (sorted by value) ===');
    console.log(`Cumulative excl. hadRecentInput: ${total.toFixed(4)}  (Lighthouse-counted)`);
    console.log(`Cumulative incl. hadRecentInput: ${withInput.toFixed(4)}  (full set)`);
    console.log(`Total entries: ${sorted.length}`);
    for (const s of sorted.slice(0, 20)) {
        console.log(`  value=${s.value.toFixed(4)} t=${s.startTime}ms recentInput=${s.hadRecentInput}`);
        for (const src of s.sources.slice(0, 4)) {
            const prev = src.prev ? `(${Math.round(src.prev.x)},${Math.round(src.prev.y)},${Math.round(src.prev.w)}×${Math.round(src.prev.h)})` : '?';
            const curr = src.curr ? `(${Math.round(src.curr.x)},${Math.round(src.curr.y)},${Math.round(src.curr.w)}×${Math.round(src.curr.h)})` : '?';
            console.log(`    ${src.target}  prev=${prev}  curr=${curr}`);
        }
    }
});
