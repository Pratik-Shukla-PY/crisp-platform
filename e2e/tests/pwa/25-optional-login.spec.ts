/**
 * Optional reporter login — Phase 1 (Apr 2026).
 *
 * Pins the "reporting must NEVER be blocked by login" contract:
 *
 *   - Start Reporting button works without any auth state (anonymous path).
 *   - AuthStore IndexedDB surface exists + init is idempotent.
 *   - Login stage wizard renders 3 steps (destination, code, link offer).
 *   - "Skip & report anonymously" link returns to stage-home in one tap.
 *
 *  No live backend — the spec asserts DOM state + AuthStore invariants;
 *  the network-side OTP flow is covered by backend pytest.
 */
import { test, expect } from '@playwright/test';

async function openPwa(page) {
    await page.goto('index.html');
    await page.evaluate(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_device_hash', 'DEV-E2E-AUTH');
    });
    await page.reload();
    const enBtn = page.locator('#btn-lang-en');
    if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
    await page.evaluate(() => {
        const c = document.getElementById('consent-overlay');
        if (c) c.style.display = 'none';
    });
}

test.describe('Phase 1 — Optional reporter login (anonymous-first)', () => {

    test('@smoke AuthStore exists and init is idempotent', async ({ page }) => {
        await openPwa(page);
        const present = await page.evaluate(async () => {
            const a = (window as any).AuthStore;
            if (!a) return { exists: false };
            await a.init();
            await a.init();   // idempotent — second call should not throw
            return {
                exists: true,
                isLoggedIn: a.isLoggedIn(),
                snapshot: a.snapshot(),
                getUserNull: a.getUser() === null,
            };
        });
        expect(present.exists).toBe(true);
        expect(present.isLoggedIn).toBe(false);
        expect(present.getUserNull).toBe(true);
    });

    test('Start Reporting works without any login (anonymous path)', async ({ page }) => {
        await openPwa(page);
        await page.locator('#btn-start').click();
        // v3 users land on stage-where; v2 would land on stage-photo.
        const active = await page.evaluate(() => {
            const el = document.querySelector('.stage.active');
            return el ? el.id : null;
        });
        expect(['stage-where', 'stage-photo']).toContain(active);
    });

    test('Login button navigates to stage-login with 3-step wizard', async ({ page }) => {
        await openPwa(page);
        const btnLogin = page.locator('#btn-login');
        await expect(btnLogin).toBeVisible();
        await btnLogin.click();
        await expect(page.locator('#stage-login')).toHaveClass(/active/);
        // Step 1 visible — channel row + destination input + Send button.
        await expect(page.locator('#login-channel-phone')).toBeVisible();
        await expect(page.locator('#login-channel-email')).toBeVisible();
        await expect(page.locator('#btn-login-send-code')).toBeVisible();
        // Steps 2 + 3 start hidden.
        const step2Display = await page.locator('#login-step2').evaluate((el: any) => getComputedStyle(el).display);
        const step3Display = await page.locator('#login-step3').evaluate((el: any) => getComputedStyle(el).display);
        expect(step2Display).toBe('none');
        expect(step3Display).toBe('none');
    });

    test('Skip link on stage-login returns to stage-home', async ({ page }) => {
        await openPwa(page);
        await page.locator('#btn-login').click();
        await page.locator('#btn-login-skip').click();
        await expect(page.locator('#stage-home')).toHaveClass(/active/);
    });

    test('Channel picker toggles between phone and email inputs', async ({ page }) => {
        await openPwa(page);
        await page.locator('#btn-login').click();
        // Phone is default (spec answer 4).
        await expect(page.locator('#login-phone-row')).toBeVisible();
        await page.locator('#login-channel-email').click();
        await expect(page.locator('#login-email-input')).toBeVisible();
        const phoneRowDisplay = await page.locator('#login-phone-row').evaluate(
            (el: any) => getComputedStyle(el).display,
        );
        expect(phoneRowDisplay).toBe('none');
    });

    test('Country-code dropdown is populated with a device-default pre-selected', async ({ page }) => {
        await openPwa(page);
        await page.locator('#btn-login').click();
        const optionCount = await page.locator('#login-cc-select option').count();
        expect(optionCount).toBeGreaterThan(5);
        const selected = await page.locator('#login-cc-select').inputValue();
        expect(selected).toMatch(/^\+\d/);
    });

    test('Settings stage exists and is reachable programmatically', async ({ page }) => {
        await openPwa(page);
        await page.evaluate(() => (window as any).__crispGoToStage('stage-settings'));
        await expect(page.locator('#stage-settings')).toHaveClass(/active/);
        await expect(page.locator('#btn-settings-logout')).toBeVisible();
        await expect(page.locator('#btn-settings-unlink-device')).toBeVisible();
    });

    test('Logout clears AuthStore local state even without network', async ({ page }) => {
        await openPwa(page);
        const cleared = await page.evaluate(async () => {
            const a = (window as any).AuthStore;
            await a.init();
            await a.logoutLocal();
            return { loggedIn: a.isLoggedIn(), user: a.getUser() };
        });
        expect(cleared.loggedIn).toBe(false);
        expect(cleared.user).toBeNull();
    });
});
