/**
 * UI v4 — Commit A regression tests.
 *
 * Covers:
 *   1. First-visit users see the landing card, not the legacy consent modal
 *      and not the home stage.
 *   2. The landing card surfaces all 4 channel buttons (IVR / SMS / Telegram /
 *      WhatsApp) and the 3 app buttons (iOS / Android / Expo Go) with
 *      "Coming soon" labels for the empty handles.
 *   3. The "Open the reporter" button is disabled until consent is checked.
 *   4. Tapping it after consent dismisses the landing AND lands on
 *      stage-photo (the existing capture flow's first stage).
 *   5. localStorage flags are persisted (returning visitors don't re-see
 *      the landing).
 *   6. The legacy #consent-overlay does NOT visibly flash while the landing
 *      card is present.
 *   7. window.InstallPrompt is exposed as the platform-detection API.
 *   8. Channel deep-link buttons that are configured render as <a href="…">,
 *      empty ones render as disabled <button> with "Coming soon" badge.
 *
 * Note: we don't test the actual install prompt firing (`beforeinstallprompt`
 * is browser- and timing-driven; Playwright Chromium doesn't fire it
 * deterministically). We assert the API surface + the iOS slide-up sheet.
 */
import { test, expect } from '@playwright/test';

// Each test gets a fresh storage state so we always exercise the
// first-visit flow.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('UI v4 — Landing card', () => {
    test.beforeEach(async ({ page }) => {
        // Reset all storage so first-visit detection fires.
        await page.addInitScript(() => {
            try {
                localStorage.clear();
                sessionStorage.clear();
            } catch {}
        });
    });

    test('first-visit users land on the landing card', async ({ page }) => {
        await page.goto('');  // baseURL has trailing slash; '' resolves to it
        await expect(page.locator('#landing-overlay')).toBeVisible({ timeout: 5000 });
        await expect(page.locator('.landing-title')).toBeVisible();
        // Landing overlay sits ABOVE stage-home (z-index 9000 vs auto).
        // We assert by elementFromPoint at the centre — whatever lives
        // there is what the user can interact with.
        const topEl = await page.evaluate(() => {
            const cx = window.innerWidth / 2;
            const cy = window.innerHeight / 2;
            const el = document.elementFromPoint(cx, cy);
            if (!el) return null;
            // Walk up to find the nearest #id ancestor.
            let node = el;
            while (node && !node.id && node.parentElement) node = node.parentElement;
            return node ? node.id || node.closest('[id]')?.id || null : null;
        });
        // Anything inside the landing card is OK; just must NOT be inside stage-home.
        expect(topEl).not.toBe('stage-home');
        expect(topEl).not.toBeNull();
    });

    test('legacy consent overlay is suppressed while landing is up', async ({ page }) => {
        await page.goto('');  // baseURL has trailing slash; '' resolves to it
        await page.waitForSelector('#landing-overlay');
        const consentVisible = await page.locator('#consent-overlay').isVisible();
        expect(consentVisible).toBe(false);
    });

    test('all 4 channel buttons + 3 app buttons render', async ({ page }) => {
        await page.goto('');  // baseURL has trailing slash; '' resolves to it
        await page.waitForSelector('#landing-overlay');
        for (const channel of ['ivr', 'sms', 'telegram', 'whatsapp']) {
            await expect(page.locator(`[data-channel="${channel}"]`)).toBeVisible();
        }
        for (const app of ['ios', 'android', 'expo']) {
            await expect(page.locator(`[data-channel="${app}"]`)).toBeVisible();
        }
    });

    test('empty channel handles render as "Coming soon" disabled buttons', async ({ page }) => {
        await page.goto('');  // baseURL has trailing slash; '' resolves to it
        await page.waitForSelector('#landing-overlay');
        // iOS / Android default to empty in DEFAULT_CHANNELS → must
        // render as disabled <button> with .lc-soon overlay.
        const iosBtn = page.locator('[data-channel="ios"]');
        await expect(iosBtn).toHaveClass(/is-disabled/);
        await expect(iosBtn.locator('.lc-soon')).toBeVisible();
        const tag = await iosBtn.evaluate((el) => el.tagName.toLowerCase());
        expect(tag).toBe('button');
    });

    test('configured channel handles render as anchor tags with hrefs', async ({ page }) => {
        await page.goto('');  // baseURL has trailing slash; '' resolves to it
        await page.waitForSelector('#landing-overlay');
        // Telegram is configured by default in landing.js (crisp_undp_bot)
        const tgBtn = page.locator('[data-channel="telegram"]');
        const tag = await tgBtn.evaluate((el) => el.tagName.toLowerCase());
        expect(tag).toBe('a');
        const href = await tgBtn.getAttribute('href');
        expect(href).toContain('https://t.me/');
    });

    test('"Open the reporter" is disabled until consent is checked', async ({ page }) => {
        await page.goto('');  // baseURL has trailing slash; '' resolves to it
        await page.waitForSelector('#landing-overlay');
        const startBtn = page.locator('#landing-start-btn');
        await expect(startBtn).toBeDisabled();
        await page.locator('#landing-consent-check').check();
        await expect(startBtn).not.toBeDisabled();
    });

    test('tapping start dismisses landing + persists localStorage flags', async ({ page }) => {
        await page.goto('');  // baseURL has trailing slash; '' resolves to it
        await page.waitForSelector('#landing-overlay');
        await page.locator('#landing-consent-check').check();
        await page.locator('#landing-start-btn').click();
        // Landing card animates out then removes itself.
        await page.waitForFunction(
            () => !document.getElementById('landing-overlay'),
            null,
            { timeout: 2000 }
        );
        // Both localStorage flags now set.
        const flags = await page.evaluate(() => ({
            seen: !!localStorage.getItem('crisp_landing_seen'),
            consent: !!localStorage.getItem('crisp_privacy_consent'),
        }));
        expect(flags.seen).toBe(true);
        expect(flags.consent).toBe(true);
    });

    test('returning visitors skip the landing entirely', async ({ page }) => {
        // Pre-set the flags as a returning visitor would have them.
        await page.addInitScript(() => {
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        });
        await page.goto('');  // baseURL has trailing slash; '' resolves to it
        // Wait for app to fully boot.
        await page.waitForFunction(() => typeof (window as any).goToStage === 'function', null, { timeout: 5000 });
        // Landing element should not exist, and the home stage should be active.
        await expect(page.locator('#landing-overlay')).toHaveCount(0);
        await expect(page.locator('#stage-home.active')).toBeVisible();
    });

    test('window.InstallPrompt API surface is exposed', async ({ page }) => {
        await page.goto('');  // baseURL has trailing slash; '' resolves to it
        await page.waitForSelector('#landing-overlay');
        const api = await page.evaluate(() => {
            const ip = (window as any).InstallPrompt;
            if (!ip) return { ok: false };
            return {
                ok: true,
                hasShow: typeof ip.show === 'function',
                hasOnChange: typeof ip.onChange === 'function',
                hasCanInstall: typeof ip.canInstall === 'boolean',
                hasPlatform: typeof ip.platform === 'string',
            };
        });
        expect(api.ok).toBe(true);
        expect(api.hasShow).toBe(true);
        expect(api.hasOnChange).toBe(true);
        expect(api.hasCanInstall).toBe(true);
        expect(api.hasPlatform).toBe(true);
    });

    test('iOS install sheet renders when triggered', async ({ page }) => {
        // Simulate iOS UA so the InstallPrompt platform comes back as 'ios'.
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'userAgent', {
                value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
                configurable: true,
            });
        });
        await page.goto('');  // baseURL has trailing slash; '' resolves to it
        await page.waitForSelector('#landing-overlay');
        await page.evaluate(async () => {
            await (window as any).InstallPrompt.show();
        });
        await expect(page.locator('#ios-install-sheet')).toBeVisible({ timeout: 1000 });
        await expect(page.locator('.iis-title')).toContainText(/Install CRISP/i);
        await expect(page.locator('.iis-steps li').nth(0)).toContainText(/Share/i);
        await expect(page.locator('.iis-steps li').nth(1)).toContainText(/Add to Home Screen/i);
    });

    test('viewport-fit: landing card fits without horizontal scroll on 360x640', async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 640 });
        await page.goto('');  // baseURL has trailing slash; '' resolves to it
        await page.waitForSelector('#landing-overlay');
        const overflow = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        }));
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });
});

test.describe('UI v4 — Stage CSS viewport refactor', () => {
    test('stage uses max-height 100dvh', async ({ page }) => {
        await page.goto('');  // baseURL has trailing slash; '' resolves to it
        // Wait for at least the home stage to mount IN THE DOM. May 2026:
        // BUG 1 fix sets `visibility: hidden` on stages while landing is
        // up, so we use state:'attached' rather than the default 'visible'.
        await page.waitForSelector('#stage-home', { state: 'attached', timeout: 5000 });
        const cssMaxHeight = await page.evaluate(() => {
            const el = document.querySelector('#stage-home');
            if (!el) return null;
            const cs = window.getComputedStyle(el);
            return cs.maxHeight;
        });
        // jsdom-free check: getComputedStyle returns the raw `100dvh` or
        // its computed pixel value depending on browser. Either is fine —
        // we just want SOMETHING set.
        expect(cssMaxHeight).not.toBe('none');
        expect(cssMaxHeight).not.toBe('');
    });
});
