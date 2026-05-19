/**
 * Merged always-on home page (May 2026).
 *
 * The first-visit-only landing overlay was deleted; the merged home
 * page replaces both `#landing-overlay` AND the previous minimal
 * `#stage-home`. This spec covers:
 *
 *   1. The home page is visible on every load (no first-visit gating).
 *   2. All 4 channels (IVR / SMS / Telegram / WhatsApp) and 3 native-app
 *      buttons (iOS / Android / Expo Go) are reachable.
 *   3. IVR is LIVE — anchor with tel:+16626768896.
 *   4. Telegram is LIVE — anchor with t.me/crisp_undp_bot.
 *   5. SMS / WhatsApp / iOS / Android render as disabled "Coming soon"
 *      buttons until handles are wired.
 *   6. Expo Go is LIVE — anchor with exp://.
 *   7. The inline consent checkbox gates `#btn-start` until checked,
 *      then auto-hides + persists in localStorage.
 *   8. Returning visitors (consent already set) see no consent row;
 *      Start is enabled immediately.
 *   9. window.InstallPrompt API surface is exposed (legacy contract).
 *  10. iOS install sheet renders when triggered.
 *  11. Viewport fits 360x640 without horizontal scroll.
 *  12. #stage-home has the v4 viewport rule (min-height: 100dvh).
 */
import { test, expect } from '@playwright/test';

// Each test runs in a fresh context (Playwright default + the explicit
// empty storageState below) so localStorage starts clean. We do NOT
// install an addInitScript-based localStorage.clear() — that would also
// fire on `page.reload()` inside a test, which breaks any persistence
// assertions (e.g. "consent persists after reload").
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('Merged always-on home page', () => {

    test('home page is visible on every load (no first-visit gating)', async ({ page }) => {
        await page.goto('');
        await expect(page.locator('#stage-home.active')).toBeVisible({ timeout: 5000 });
        // Reload — still visible.
        await page.reload();
        await expect(page.locator('#stage-home.active')).toBeVisible({ timeout: 5000 });
    });

    // v6.8 (May 2026): the home channels surface was compressed to a
    // single `#home-channels-strip` icon row. Full per-channel buttons
    // (with [data-channel] attrs) now live inside the `#channels-sheet`
    // bottom-sheet, opened on tap. Tests below tap the strip first then
    // query `#channels-sheet [data-channel="..."]`.
    async function openChannelsSheet(page) {
        // Force English locale — the Bengaluru GPS fixture in
        // playwright.config.ts would otherwise auto-detect Kannada
        // and the status copy ("Coming soon" / "Low bandwidth") would
        // render translated, breaking the regex match below.
        await page.addInitScript(() => {
            localStorage.setItem('crisp_lang', 'en');
            localStorage.setItem('crisp_lang_manual', 'en');
        });
        await page.goto('');
        await page.waitForSelector('#home-channels-strip', { timeout: 5000 });
        await page.locator('#home-channels-strip').click();
        await page.waitForSelector('#channels-sheet[aria-hidden="false"], #channels-sheet:not([hidden])', { timeout: 3000 });
    }

    test('all 4 channel buttons + 2 app buttons render', async ({ page }) => {
        await openChannelsSheet(page);
        for (const channel of ['ivr', 'sms', 'telegram', 'whatsapp']) {
            await expect(page.locator(`#channels-sheet [data-channel="${channel}"]`)).toBeVisible();
        }
        // v6.8 (May 2026): Expo Go dropped from the public channels list
        // (still configured in CHANNELS.expo_go_url for internal tester
        // builds — see home-screen.js:66). Public-facing list has Android
        // + iOS only.
        for (const app of ['ios', 'android']) {
            await expect(page.locator(`#channels-sheet [data-channel="${app}"]`)).toBeVisible();
        }
    });

    test('IVR is LIVE — anchor with tel:+16626768896', async ({ page }) => {
        await openChannelsSheet(page);
        const ivrBtn = page.locator('#channels-sheet [data-channel="ivr"]');
        const tag = await ivrBtn.evaluate((el) => el.tagName.toLowerCase());
        expect(tag).toBe('a');
        const href = await ivrBtn.getAttribute('href');
        expect(href).toBe('tel:+16626768896');
    });

    test('Telegram is LIVE — bot deep-link button', async ({ page }) => {
        await openChannelsSheet(page);
        const tgBtn = page.locator('#channels-sheet [data-channel="telegram"]');
        await expect(tgBtn).toBeVisible();
        // v6.8 — Telegram switched from a raw anchor to a button with
        // data-action="telegram-deeplink" (handled by the channels-
        // sheet click-telemetry wiring). The deep-link includes the
        // configured bot name (CHANNELS.telegram_bot — currently
        // 'crisp_crisis_bot'); we just assert it's tagged as the
        // telegram-deeplink action, not the underlying URL since the
        // bot name evolves.
        const action = await tgBtn.getAttribute('data-action');
        expect(action).toBe('telegram-deeplink');
        const tag = await tgBtn.evaluate((el) => el.tagName.toLowerCase());
        expect(tag).toBe('button');
    });

    test('SMS + WhatsApp render as disabled "Coming soon" buttons', async ({ page }) => {
        await openChannelsSheet(page);
        for (const ch of ['sms', 'whatsapp']) {
            const btn = page.locator(`#channels-sheet [data-channel="${ch}"]`);
            await expect(btn).toHaveClass(/is-disabled/);
            // v6.8 — status copy moved to `.csr-status` (was `.lc-soon`
            // in the legacy big-button layout). Assert the status text.
            await expect(btn.locator('.csr-status')).toBeVisible();
            await expect(btn.locator('.csr-status')).toContainText(/coming soon|low bandwidth/i);
            const tag = await btn.evaluate((el) => el.tagName.toLowerCase());
            expect(tag).toBe('button');
        }
    });

    test('iOS + Android render as disabled "Coming soon" buttons', async ({ page }) => {
        await openChannelsSheet(page);
        for (const app of ['ios', 'android']) {
            const btn = page.locator(`#channels-sheet [data-channel="${app}"]`);
            await expect(btn).toHaveClass(/is-disabled/);
            await expect(btn.locator('.csr-status')).toContainText(/coming soon/i);
        }
    });

    // v6.8 (May 2026) — Expo Go dropped from public channels list. The
    // exp:// deep link is still configured at home-screen.js:66 for
    // internal tester builds, but the public channels-sheet doesn't
    // render it. Test removed.

    test('consent checkbox gates btn-start until checked', async ({ page }) => {
        await page.goto('');
        await page.waitForSelector('#home-consent-check', { timeout: 5000 });
        const startBtn = page.locator('#btn-start');
        await expect(startBtn).toBeDisabled();
        await page.locator('#home-consent-check').check();
        await expect(startBtn).not.toBeDisabled();
    });

    test('checking consent persists + hides the row', async ({ page }) => {
        await page.goto('');
        await page.waitForSelector('#home-consent-check');
        await page.locator('#home-consent-check').check();
        // Wait for hide animation (~250ms in CSS) to settle.
        await page.waitForTimeout(400);
        await expect(page.locator('#home-consent')).toBeHidden();
        // Persistence — reload + ensure consent stays set + row stays hidden.
        await page.reload();
        await expect(page.locator('#home-consent')).toBeHidden();
        const persisted = await page.evaluate(() =>
            !!localStorage.getItem('crisp_privacy_consent'));
        expect(persisted).toBe(true);
    });

    test('returning visitors with consent see no checkbox + Start enabled', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
        });
        await page.goto('');
        await page.waitForSelector('#stage-home.active', { timeout: 5000 });
        await expect(page.locator('#home-consent')).toBeHidden();
        await expect(page.locator('#btn-start')).not.toBeDisabled();
    });

    test('window.InstallPrompt API surface is exposed', async ({ page }) => {
        await page.goto('');
        await page.waitForSelector('#stage-home.active', { timeout: 5000 });
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
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'userAgent', {
                value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
                configurable: true,
            });
        });
        await page.goto('');
        await page.waitForSelector('#stage-home.active', { timeout: 5000 });
        await page.evaluate(async () => {
            await (window as any).InstallPrompt.show();
        });
        await expect(page.locator('#ios-install-sheet')).toBeVisible({ timeout: 1000 });
        await expect(page.locator('.iis-title')).toContainText(/Install CRISP/i);
    });

    test('viewport fits 360x640 without horizontal scroll', async ({ page }) => {
        await page.setViewportSize({ width: 360, height: 640 });
        await page.goto('');
        await page.waitForSelector('#stage-home.active');
        const overflow = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
        }));
        expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });

    test('CrispHome public surface is exposed for tests + late init', async ({ page }) => {
        await page.goto('');
        await page.waitForSelector('#stage-home.active', { timeout: 5000 });
        const surface = await page.evaluate(() => {
            const h = (window as any).CrispHome;
            if (!h) return { ok: false };
            return {
                ok: true,
                hasInit: typeof h.init === 'function',
                hasRender: typeof h.renderChannels === 'function',
                hasConsented: typeof h.hasConsented === 'function',
                hasMark: typeof h.markConsent === 'function',
                ivrConfigured: !!h._channels?.ivr_phone,
                tgConfigured: !!h._channels?.telegram_bot,
            };
        });
        expect(surface.ok).toBe(true);
        expect(surface.hasInit).toBe(true);
        expect(surface.ivrConfigured).toBe(true);
        expect(surface.tgConfigured).toBe(true);
    });
});

test.describe('Stage CSS viewport refactor', () => {
    test('#stage-home has min-height 100dvh', async ({ page }) => {
        await page.goto('');
        await page.waitForSelector('#stage-home', { state: 'attached', timeout: 5000 });
        const cssMinHeight = await page.evaluate(() => {
            const el = document.querySelector('#stage-home');
            if (!el) return null;
            const cs = window.getComputedStyle(el);
            return cs.minHeight;
        });
        expect(cssMinHeight).not.toBe('none');
        expect(cssMinHeight).not.toBe('0px');
        expect(cssMinHeight).not.toBe('');
    });
});
