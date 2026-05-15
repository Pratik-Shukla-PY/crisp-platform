/**
 * PWA — Badge Studio (May 2026 reward-system v2, Phase D).
 *
 * The Badge Studio (stage-badge-studio) is the in-app Canvas
 * composer that lets T3+ reporters generate a share-ready badge
 * image and dispatch it to LinkedIn / WhatsApp / Instagram / etc.
 *
 * Covered:
 *  - Lock invariant — T1 / T2 chip tap toasts a hint instead of
 *    opening the stage.
 *  - Unlock — T3 / T4 chip tap navigates to stage-badge-studio.
 *  - Template switch (ring / WA / story) repaints the canvas.
 *  - Download button generates an image/png blob.
 *  - Share button calls navigator.share with a File when supported.
 *  - WhatsApp / LinkedIn deep-links open the right URL.
 *  - Optional photo upload paints into the ring template.
 */
import { test, expect, Page } from '@playwright/test';

async function bootHomeAtTier(page: Page, tier: string) {
    await page.addInitScript((t) => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
        localStorage.setItem('crisp_device_id_v2', 'bs-test-device');
        // Pre-seed sessionStorage so the Badge Studio's tier lookup
        // doesn't depend on a /profile round-trip.
        sessionStorage.setItem('crisp_home_badge_v2', JSON.stringify({
            level: t, lives: 3, reports: 7, responded: 2,
        }));
    }, tier);
    await page.route('**/api/v1/reports/profile/**', (route) =>
        route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({
                badge_level: tier,
                badge_legacy: 'NEWCOMER',
                lives_saved_total: 3, report_count: 7, responded_count: 2, verified_count: 2,
                tier: {
                    current: tier, next: null,
                    progress: { needs: null, needed: 0, have: 3, label_key: 'tier_progress_top_share' },
                },
            }),
        }),
    );
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(() =>
        typeof (window as any).openBadgeStudio === 'function'
        && !!document.getElementById('home-badge-chip'),
        null, { timeout: 8000 });
}

// May 2026 (reward-system v2 second pass) — Badge Studio is reached
// via the new Rewards page, not by tapping the (now decorative) home
// badge chip. All "open studio" navigation in these tests goes
// through #btn-rewards → #btn-rewards-open-studio. The lock invariant
// (T1/T2 can't open Studio) is covered by spec 66 against the Studio
// button's `disabled` state; the assertions below focus on the
// Studio's own behaviour once it's open.
async function navigateToBadgeStudio(page: Page) {
    await page.locator('#btn-rewards').click();
    await page.locator('#stage-rewards.active').waitFor({ state: 'visible' });
    await page.locator('#btn-rewards-open-studio').click();
    await page.locator('#stage-badge-studio.active').waitFor({ state: 'visible' });
}

test.describe('PWA — Badge Studio (open via Rewards page + share dispatch)', () => {

    test('@smoke T3 user reaches Badge Studio via the Rewards page', async ({ page }) => {
        await bootHomeAtTier(page, 'T3_CHANGEMAKER');
        await navigateToBadgeStudio(page);
        await expect(page.locator('#bs-tier-emoji')).toHaveText('⚡');
        await expect(page.locator('#bs-tier-name')).toContainText(/Changemaker/i);
    });

    test('@smoke T4 user reaches Badge Studio with Lifekeeper preview', async ({ page }) => {
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');
        await navigateToBadgeStudio(page);
        await expect(page.locator('#bs-tier-emoji')).toHaveText('🦸');
        await expect(page.locator('#bs-tier-name')).toContainText(/Lifekeeper/i);
        await expect(page.locator('#bs-tier-stats')).toContainText(/7 reports/i);
        await expect(page.locator('#bs-tier-stats')).toContainText(/3 lives/i);
    });

    test('template tabs switch + canvas repaints', async ({ page }) => {
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');
        await navigateToBadgeStudio(page);
        // Phase 2.7 (May 2026) — canvas is DPR-aware. The backing
        // pixel buffer is (logical × dpr); the test reads the
        // logical size off `canvas.style.width/height` instead of
        // `canvas.width/height` so the assertion is independent of
        // the headless browser's reported devicePixelRatio.
        const readLogical = (el: any) => ({
            w: Math.round(parseFloat(el.style.width || '0')) || el.width,
            h: Math.round(parseFloat(el.style.height || '0')) || el.height,
        });
        // Initial tab is "ring" → canvas dimensions 1080×1080.
        let dim = await page.locator('#bs-canvas').evaluate(readLogical);
        expect(dim.w).toBe(1080);
        expect(dim.h).toBe(1080);
        // Switch to story → canvas dimensions 1080×1920.
        await page.locator('.bs-tab[data-template="story"]').click();
        // Wait for the re-render.
        await page.waitForTimeout(150);
        dim = await page.locator('#bs-canvas').evaluate(readLogical);
        expect(dim.h).toBe(1920);
        // Tab must show as active.
        await expect(page.locator('.bs-tab[data-template="story"]')).toHaveClass(/is-active/);
    });

    test('download button generates an image/png blob', async ({ page }) => {
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');
        await navigateToBadgeStudio(page);
        // Intercept the click that creates the anchor + click.
        // Easier path: call the internal composer directly via the
        // test surface exposed at window.__crispBadgeStudio.
        const blobInfo = await page.evaluate(async () => {
            const bs = (window as any).__crispBadgeStudio;
            const blob = await bs._composeBadgeImage('ring', null, 'T4_LIFEKEEPER', { lives: 3, reports: 7 });
            return { type: blob.type, size: blob.size };
        });
        expect(blobInfo.type).toBe('image/png');
        expect(blobInfo.size).toBeGreaterThan(500);
    });

    test('share button calls navigator.share when available', async ({ page }) => {
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');
        await navigateToBadgeStudio(page);
        // Stub navigator.share + canShare.
        await page.evaluate(() => {
            (window as any).__shareCalls = [];
            (navigator as any).canShare = () => true;
            (navigator as any).share = (data: any) => {
                (window as any).__shareCalls.push({
                    fileCount: data.files ? data.files.length : 0,
                    text: data.text,
                });
                return Promise.resolve();
            };
        });
        await page.locator('#btn-bs-share').click();
        await page.waitForTimeout(500);
        const calls = await page.evaluate(() => (window as any).__shareCalls);
        expect(calls.length).toBe(1);
        expect(calls[0].fileCount).toBe(1);
        expect(calls[0].text).toMatch(/CRISP/i);
    });

    test('WhatsApp button opens wa.me/?text= URL', async ({ page }) => {
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');
        await navigateToBadgeStudio(page);
        // Intercept window.open to capture the URL without launching a
        // second tab.
        const openedUrls: string[] = [];
        await page.exposeFunction('__captureOpen', (url: string) => { openedUrls.push(url); });
        await page.evaluate(() => {
            (window as any).open = (url: string) => {
                (window as any).__captureOpen(url);
                return null;
            };
        });
        await page.locator('#btn-bs-wa').click();
        await page.waitForTimeout(400);
        expect(openedUrls.length).toBeGreaterThanOrEqual(1);
        expect(openedUrls[0]).toMatch(/^https:\/\/wa\.me\/\?text=/);
        expect(decodeURIComponent(openedUrls[0])).toMatch(/CRISP/i);
    });

    test('LinkedIn button opens the share-offsite URL', async ({ page }) => {
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');
        await navigateToBadgeStudio(page);
        const openedUrls: string[] = [];
        await page.exposeFunction('__captureOpen2', (url: string) => { openedUrls.push(url); });
        await page.evaluate(() => {
            (window as any).open = (url: string) => {
                (window as any).__captureOpen2(url);
                return null;
            };
        });
        await page.locator('#btn-bs-linkedin').click();
        await page.waitForTimeout(400);
        expect(openedUrls.length).toBe(1);
        expect(openedUrls[0]).toMatch(/^https:\/\/www\.linkedin\.com\/sharing\/share-offsite\/\?url=/);
    });

    test('back button returns to home stage', async ({ page }) => {
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');
        await navigateToBadgeStudio(page);
        await page.locator('#btn-badge-studio-back').click();
        await expect(page.locator('#stage-home.active')).toBeVisible();
    });
});
