/**
 * Home Share feature (v353).
 *
 * A single Share icon on the home header:
 *   - uses the native Web Share sheet when available;
 *   - falls back to copying the app link + a "Link copied" toast otherwise.
 * Offline-safe (share/clipboard are local APIs). No FontAwesome (inline SVG).
 */
import { test, expect } from '@playwright/test';

async function boot(page, init) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    if (init) await page.addInitScript(init);
    await page.goto('index.html');
    await page.evaluate(() => { const c = document.getElementById('consent-overlay'); if (c) c.style.display = 'none'; });
    await page.waitForSelector('#btn-home-share', { timeout: 8000 });
    await page.waitForTimeout(300);
}

test('a single Share icon is present in the header (inline SVG, no FontAwesome)', async ({ page }) => {
    await boot(page);
    const btn = page.locator('#btn-home-share');
    await expect(btn).toBeVisible();
    // Inline SVG icon (home never loads FontAwesome).
    expect(await btn.locator('svg').count()).toBe(1);
    expect(await btn.locator('i.fa-solid, i.fa-brands').count()).toBe(0);
    // Lives in the header utility cluster next to the voice + language controls.
    expect(await page.locator('.home-brand-utility #btn-home-share').count()).toBe(1);
});

test('native Web Share is used when available (shares the app URL)', async ({ page }) => {
    await boot(page, () => {
        (window as any).__shared = null;
        (navigator as any).share = (data) => { (window as any).__shared = data; return Promise.resolve(); };
    });
    await page.locator('#btn-home-share').click();
    await page.waitForTimeout(150);
    const shared = await page.evaluate(() => (window as any).__shared);
    expect(shared).toBeTruthy();
    expect(String(shared.url || '')).toContain('index.html');
    expect(String(shared.title || '')).toContain('CRISP');
});

test('falls back to Copy Link + toast when native share is unavailable', async ({ page }) => {
    await boot(page, () => {
        try { delete (navigator as any).share; } catch (_) {}
        (window as any).__copied = null;
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: (t) => { (window as any).__copied = t; return Promise.resolve(); } },
        });
    });
    await page.locator('#btn-home-share').click();
    await page.waitForTimeout(200);
    const copied = await page.evaluate(() => (window as any).__copied);
    expect(String(copied || '')).toContain('index.html');
    // A confirmation toast is shown.
    await expect(page.getByText(/Link copied/i).first()).toBeVisible({ timeout: 4000 });
});
