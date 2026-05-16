/**
 * One-off CLS investigation probe (NOT a regression spec — to be
 * deleted after the CLS root-cause work lands).
 *
 * Reports every layout-shift entry on stage-home during the first 5s,
 * with selectors for the shifting elements so we can pinpoint which
 * change introduced the 0.298 CLS that's been rolling back PROD
 * deploys.
 */
import { test } from '@playwright/test';

test('layout-shift probe: stage-home first 5s', async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        // Pretend we have a device_hash so the badge chip renders fully
        // (which is the suspect element).
        localStorage.setItem('crisp_device_id_v2', 'CLS-PROBE-DEV');
        // Pre-seed the badge cache so the chip paints with real tier
        // data immediately — exercises the same render path that PROD
        // hits.
        sessionStorage.setItem('crisp_home_badge_v2', JSON.stringify({
            level: 'T2_SIGNAL',
            progressLabelKey: 'tier_progress_verified_1',
            lives: 0,
            reports: 3,
            responded: 0,
        }));
    });

    const shifts: any[] = [];
    await page.exposeFunction('__captureShift', (s: any) => { shifts.push(s); });

    await page.addInitScript(() => {
        const w = window as any;
        const cap = () => {
            try {
                const po = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries() as any[]) {
                        // entry.sources is an array of { node?, previousRect, currentRect }
                        // Node is a real DOM ref we can introspect for an id/class.
                        const sources = (entry.sources || []).map((s: any) => {
                            const n = s.node;
                            if (!n) return { hadNoNode: true, prev: s.previousRect, curr: s.currentRect };
                            let label = n.nodeName ? n.nodeName.toLowerCase() : '?';
                            if (n.id) label += '#' + n.id;
                            else if (n.className && typeof n.className === 'string') {
                                label += '.' + n.className.split(/\s+/).slice(0, 2).join('.');
                            }
                            return {
                                target: label,
                                prev: { x: s.previousRect?.x, y: s.previousRect?.y, w: s.previousRect?.width, h: s.previousRect?.height },
                                curr: { x: s.currentRect?.x, y: s.currentRect?.y, w: s.currentRect?.width, h: s.currentRect?.height },
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
        // Install the observer as early as possible.
        if (document.readyState === 'loading') {
            document.addEventListener('readystatechange', cap, { once: true });
        } else { cap(); }
    });

    await page.goto('index.html');
    await page.waitForTimeout(5500);  // capture window

    // Print a sorted report
    const sorted = shifts.sort((a, b) => b.value - a.value);
    const total = sorted.reduce((s, e) => s + (e.hadRecentInput ? 0 : e.value), 0);
    console.log('\n=== Layout-shift entries (sorted by value) ===');
    console.log(`Cumulative (excluding hadRecentInput): ${total.toFixed(4)}`);
    console.log(`Total entries: ${sorted.length}`);
    for (const s of sorted.slice(0, 15)) {
        console.log(`  value=${s.value.toFixed(4)} t=${s.startTime}ms recentInput=${s.hadRecentInput}`);
        for (const src of s.sources.slice(0, 4)) {
            const prev = src.prev ? `(${Math.round(src.prev.x)},${Math.round(src.prev.y)},${Math.round(src.prev.w)}×${Math.round(src.prev.h)})` : 'no-prev';
            const curr = src.curr ? `(${Math.round(src.curr.x)},${Math.round(src.curr.y)},${Math.round(src.curr.w)}×${Math.round(src.curr.h)})` : 'no-curr';
            console.log(`    ${src.target}  prev=${prev}  curr=${curr}`);
        }
    }
});
