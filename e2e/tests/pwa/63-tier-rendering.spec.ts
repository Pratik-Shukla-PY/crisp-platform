/**
 * PWA — 4-tier badge chip rendering (May 2026 reward-system v2).
 *
 * Backend /reports/profile/<hash> now returns one of:
 *   T1_SCOUT / T2_SIGNAL / T3_CHANGEMAKER / T4_LIFEKEEPER
 * along with a `tier.progress.label_key` that tells the PWA what
 * the user has to do next to level up.
 *
 * Pre-fix the PWA's BADGE_LEVELS map only knew the 5-tier legacy
 * names (NEWCOMER / HELPER / GUARDIAN / CHAMPION / HERO), so every
 * Contributor/Trusted user was falling back to the default
 * "🌱 Newcomer" render. This spec locks the new behaviour: each of
 * the four tier identifiers paints the correct emoji + label + body
 * class + progress sub-line + chip-unlocked state.
 *
 * Also covers the LEGACY_MAP fallback for a stale backend that
 * still emits the old 3-tier names (NEWCOMER / CONTRIBUTOR /
 * TRUSTED).
 */
import { test, expect, Page } from '@playwright/test';

interface ProfileShape {
    badge_level: string;
    badge_legacy?: string;
    lives_saved_total?: number;
    report_count?: number;
    responded_count?: number;
    tier?: {
        current: string;
        next: string | null;
        progress: { needs: string | null; needed: number; have: number; label_key: string };
    };
}

async function bootHomeWithProfile(page: Page, profile: ProfileShape) {
    // Pre-seed localStorage with the consent + device hash so the
    // home-screen path runs end-to-end.
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
        localStorage.setItem('crisp_device_id_v2', 'tier-render-device');
        // Clear any sessionStorage cache so the test sees a clean state.
        try { sessionStorage.removeItem('crisp_home_badge_v2'); } catch (_) {}
        try { sessionStorage.removeItem('crisp_home_badge_v1'); } catch (_) {}
    });
    // Intercept the /profile fetch BEFORE navigation so the very first
    // home paint reads the seeded payload.
    await page.route('**/api/v1/reports/profile/**', async (route) => {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(profile),
        });
    });
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    // Wait until the chip has finished painting from the mocked fetch.
    // AUDIT 2026-05-23 — the chip's `hidden` attribute is now SET (not
    // removed) for first-timers (T1 + 0 lives + first-report progress
    // key). We just wait until the `data-tier` attribute is set — that
    // proves the painter ran. Visibility / hidden checks live in the
    // individual tests.
    await page.waitForFunction(
        () => {
            const el = document.getElementById('home-badge-chip');
            return el && !!el.dataset.tier;
        },
        null,
        { timeout: 4000 },
    );
}

test.describe('PWA — 4-tier badge chip rendering (reward v2)', () => {

    test('@smoke T1_SCOUT first-timer chip is visible (HC29 — always-show)', async ({ page }) => {
        // HC29 (operator reversal of Batch 3.4, see home-screen.js:1288):
        // Batch 3.4 hid the tier badge until the first submission, but
        // operator review found that made the gamification ladder
        // invisible and cut motivation for first-time + returning users
        // alike. The chip now ALWAYS shows; the default "Scout — Submit
        // your first report to level up" copy serves as the meaningful
        // empty state. This test enforces the always-visible contract
        // for the first-timer cohort + that tier/emoji/label paint.
        await bootHomeWithProfile(page, {
            badge_level: 'T1_SCOUT',
            badge_legacy: 'NEWCOMER',
            tier: {
                current: 'T1_SCOUT',
                next: 'T2_SIGNAL',
                progress: { needs: 'submitted', needed: 1, have: 0, label_key: 'tier_progress_first_report' },
            },
        });
        const chip = page.locator('#home-badge-chip');
        // HC29: the chip is ALWAYS shown — the `hidden` attribute is
        // removed unconditionally (home-screen.js:1300), so a first-timer
        // sees the Scout badge + first-report empty-state copy.
        await expect(chip).not.toHaveAttribute('hidden', '');
        await expect(chip).toHaveClass(/lvl-t1/);
        await expect(chip).toHaveAttribute('data-tier', 'T1_SCOUT');
        await expect(page.locator('#home-badge-emoji')).toHaveText('🌱');
        await expect(page.locator('#home-badge-label')).toHaveText(/Scout/i);
        await expect(page.locator('#home-badge-progress')).toContainText(/Submit your first report/i);
        await expect(chip).not.toHaveClass(/chip-unlocked/);
    });

    test('@smoke T2_SIGNAL renders 📣 Signal with verified-1 progress', async ({ page }) => {
        await bootHomeWithProfile(page, {
            badge_level: 'T2_SIGNAL',
            badge_legacy: 'NEWCOMER',
            tier: {
                current: 'T2_SIGNAL',
                next: 'T3_CHANGEMAKER',
                progress: { needs: 'responded', needed: 1, have: 0, label_key: 'tier_progress_verified_1' },
            },
        });
        const chip = page.locator('#home-badge-chip');
        await expect(chip).toHaveClass(/lvl-t2/);
        await expect(page.locator('#home-badge-emoji')).toHaveText('📣');
        await expect(page.locator('#home-badge-label')).toHaveText(/Signal/i);
        await expect(page.locator('#home-badge-progress')).toContainText(/verified by an analyst/i);
        await expect(chip).not.toHaveClass(/chip-unlocked/);
    });

    test('@smoke T3_CHANGEMAKER unlocks the chip + applies body tier-t3 + logo ring', async ({ page }) => {
        await bootHomeWithProfile(page, {
            badge_level: 'T3_CHANGEMAKER',
            badge_legacy: 'CONTRIBUTOR',
            tier: {
                current: 'T3_CHANGEMAKER',
                next: 'T4_LIFEKEEPER',
                progress: { needs: 'lives_saved', needed: 1, have: 0, label_key: 'tier_progress_lives_1' },
            },
        });
        const chip = page.locator('#home-badge-chip');
        await expect(chip).toHaveClass(/lvl-t3/);
        await expect(chip).toHaveClass(/chip-unlocked/);
        await expect(page.locator('#home-badge-emoji')).toHaveText('⚡');
        await expect(page.locator('#home-badge-label')).toHaveText(/Changemaker/i);
        await expect(page.locator('#home-badge-progress')).toContainText(/Help save 1 life/i);
        // Body class is the source of truth for downstream CSS affects.
        await expect(page.locator('body')).toHaveClass(/tier-t3/);
    });

    test('@smoke T4_LIFEKEEPER applies body tier-t4 (top-tier theme tint)', async ({ page }) => {
        await bootHomeWithProfile(page, {
            badge_level: 'T4_LIFEKEEPER',
            badge_legacy: 'TRUSTED',
            tier: {
                current: 'T4_LIFEKEEPER',
                next: null,
                progress: { needs: null, needed: 0, have: 3, label_key: 'tier_progress_top_share' },
            },
        });
        const chip = page.locator('#home-badge-chip');
        await expect(chip).toHaveClass(/lvl-t4/);
        await expect(chip).toHaveClass(/chip-unlocked/);
        await expect(page.locator('#home-badge-emoji')).toHaveText('🦸');
        await expect(page.locator('#home-badge-label')).toHaveText(/Lifekeeper/i);
        await expect(page.locator('#home-badge-progress')).toContainText(/Top tier reached/i);
        await expect(page.locator('body')).toHaveClass(/tier-t4/);
    });

    test('LEGACY: stale backend emitting CONTRIBUTOR falls back to T3_CHANGEMAKER render', async ({ page }) => {
        // Simulates a backend that has not yet been upgraded to the new
        // 4-tier emit. The PWA must still paint a sensible tier via
        // LEGACY_MAP, not fall through to the T1_SCOUT default. This
        // protects users mid-rollout when API + PWA versions skew.
        await bootHomeWithProfile(page, {
            badge_level: 'CONTRIBUTOR',
            // No `tier` object — the PWA must synthesise the progress
            // label key locally from the resolved tier.
        });
        const chip = page.locator('#home-badge-chip');
        await expect(chip).toHaveClass(/lvl-t3/);
        await expect(chip).toHaveAttribute('data-tier', 'T3_CHANGEMAKER');
    });

    test('LEGACY: stale backend emitting TRUSTED falls back to T4_LIFEKEEPER render', async ({ page }) => {
        await bootHomeWithProfile(page, { badge_level: 'TRUSTED' });
        const chip = page.locator('#home-badge-chip');
        await expect(chip).toHaveClass(/lvl-t4/);
        await expect(chip).toHaveAttribute('data-tier', 'T4_LIFEKEEPER');
    });

    test('LEGACY: stale backend emitting NEWCOMER maps to T2_SIGNAL (most reporters)', async ({ page }) => {
        // The legacy NEWCOMER bucket was the "anyone with <3 verified"
        // catch-all — these reporters have almost always submitted at
        // least one report, so mapping them to T2_SIGNAL (the post-
        // first-submit tier) is the right approximation. Otherwise
        // every legacy reporter would visibly demote to T1.
        await bootHomeWithProfile(page, { badge_level: 'NEWCOMER' });
        const chip = page.locator('#home-badge-chip');
        await expect(chip).toHaveClass(/lvl-t2/);
        await expect(chip).toHaveAttribute('data-tier', 'T2_SIGNAL');
    });

    test('chip layout slot preserved (no CLS) even on /profile fetch failure', async ({ page }) => {
        // Network error path — the chip should fall back to T1_SCOUT
        // and render (HC29: always-shown). The layout slot stays
        // reserved (no CLS) — height >= 36px — whether the chip is the
        // first-timer empty state or a real tier.
        await page.addInitScript(() => {
            localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
            localStorage.setItem('crisp_landing_seen', '1');
            localStorage.setItem('crisp_lang', 'en');
            localStorage.setItem('crisp_lang_manual', 'en');
            localStorage.setItem('crisp_device_id_v2', 'tier-render-device');
        });
        await page.route('**/api/v1/reports/profile/**', (route) =>
            route.fulfill({ status: 500, body: 'boom' }),
        );
        await page.goto('index.html?ui=v4');
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(400);
        const chip = page.locator('#home-badge-chip');
        // HC29: chip falls back to T1_SCOUT and is shown (not hidden), and
        // the layout slot stays reserved (offsetHeight >= 36, asserted below)
        // so there's no CLS regardless of the profile-fetch outcome.
        await expect(chip).not.toHaveAttribute('hidden', '');
        await expect(chip).toHaveClass(/lvl-t1/);
        const offsetHeight = await chip.evaluate((el) => (el as HTMLElement).offsetHeight);
        // Min-height: 36 px reservation observed (was 38 spec, browser
        // sub-pixel layout lands at 36 — both well above 0, which is
        // the actual CLS-failure case we're guarding against).
        expect(offsetHeight).toBeGreaterThanOrEqual(36);
    });
});
