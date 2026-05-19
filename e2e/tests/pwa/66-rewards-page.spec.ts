/**
 * PWA — dedicated Rewards page (May 2026, reward-system v2 second pass).
 *
 * Pre-fix the home badge chip doubled as both a status display AND a
 * tap-to-open-Badge-Studio button — confusing for users. This spec
 * pins the new architecture:
 *
 *   • Chip becomes DECORATIVE-only (no tap action)
 *   • #home-badge-chip on home opens the new stage-rewards page
 *   • stage-rewards shows the 4-tier ladder with per-card state
 *     (.is-done / .is-current / .is-locked)
 *   • Rewards page hosts the Badge Studio entry CTA, locked
 *     behind T3_CHANGEMAKER (T1/T2 see disabled state + hint)
 *
 * Companion specs:
 *   * 63-tier-rendering — chip rendering across all 4 tiers
 *   * 64-tier-promotion-celebration — tier-up toast on My Reports open
 *   * 65-badge-studio — Canvas composer + share dispatch
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

async function bootHomeAtTier(page: Page, tier: string, extra: Partial<ProfileShape> = {}) {
    await page.addInitScript((t) => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
        localStorage.setItem('crisp_device_id_v2', 'rewards-test-device');
        // Pre-seed sessionStorage so the Rewards page can read from
        // cache before /profile lands.
        sessionStorage.setItem('crisp_home_badge_v2', JSON.stringify({
            level: t, lives: 3, reports: 38, responded: 2,
        }));
    }, tier);
    await page.route('**/api/v1/reports/profile/**', (route) =>
        route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({
                badge_level: tier,
                badge_legacy: 'NEWCOMER',
                lives_saved_total: 3,
                report_count: 38,
                responded_count: 2,
                verified_count: 2,
                tier: {
                    current: tier,
                    next: null,
                    progress: {
                        needs: null, needed: 0, have: 3,
                        label_key: tier === 'T1_SCOUT'       ? 'tier_progress_first_report' :
                                   tier === 'T2_SIGNAL'      ? 'tier_progress_verified_1'   :
                                   tier === 'T3_CHANGEMAKER' ? 'tier_progress_lives_1'      :
                                                               'tier_progress_top_share',
                    },
                },
                ...extra,
            }),
        }),
    );
    await page.goto('index.html?ui=v4');
    // Wait for boot + the chip to paint.
    await page.waitForFunction(() => {
        const chip = document.getElementById('home-badge-chip');
        return chip && !chip.hasAttribute('hidden');
    }, null, { timeout: 8000 });
}

test.describe('PWA — dedicated Rewards page (reward-system v2 second pass)', () => {

    // v6.8's actual rendering (ladder card states, CTA disabled-by-tier
    // copy, decorative-chip claim contradicts the new tappable chip
    // design). Needs per-test rewrite against the live DOM state. See
    // 66-rewards-page failure triage notes.
    test('@smoke home chip is decorative — has role=status, no tabindex, no click handler', async ({ page }) => {
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');
        const chip = page.locator('#home-badge-chip');
        await expect(chip).toHaveAttribute('role', 'status');
        // tabindex was removed when chip went decorative.
        const tabindex = await chip.getAttribute('tabindex');
        expect(tabindex).toBeNull();
        // Clicking the chip must NOT navigate away from home.
        await chip.click().catch(() => { /* might fail in some browsers when role=status */ });
        await page.waitForTimeout(200);
        await expect(page.locator('#stage-home.active')).toBeVisible();
        await expect(page.locator('#stage-rewards.active')).toHaveCount(0);
        await expect(page.locator('#stage-badge-studio.active')).toHaveCount(0);
    });

    test('@smoke home #home-badge-chip opens stage-rewards', async ({ page }) => {
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');
        const btn = page.locator('#home-badge-chip');
        await expect(btn).toBeVisible();
        await btn.click();
        await expect(page.locator('#stage-rewards.active')).toBeVisible({ timeout: 3000 });
    });

    // v6.8's actual rendering (ladder card states, CTA disabled-by-tier
    // copy, decorative-chip claim contradicts the new tappable chip
    // design). Needs per-test rewrite against the live DOM state. See
    // 66-rewards-page failure triage notes.
    test('@smoke ladder reflects T1 — first card is current, rest locked', async ({ page }) => {
        await bootHomeAtTier(page, 'T1_SCOUT');
        await page.locator('#home-badge-chip').click();
        await expect(page.locator('#stage-rewards.active')).toBeVisible();
        await expect(page.locator('.rt-card[data-tier="T1_SCOUT"]')).toHaveClass(/is-current/);
        await expect(page.locator('.rt-card[data-tier="T2_SIGNAL"]')).toHaveClass(/is-locked/);
        await expect(page.locator('.rt-card[data-tier="T3_CHANGEMAKER"]')).toHaveClass(/is-locked/);
        await expect(page.locator('.rt-card[data-tier="T4_LIFEKEEPER"]')).toHaveClass(/is-locked/);
        // Hero card shows Scout + the first-report progress.
        await expect(page.locator('#rh-emoji')).toHaveText('🌱');
        await expect(page.locator('#rh-name')).toContainText(/Scout/i);
        await expect(page.locator('#rh-progress')).toContainText(/Submit your first report/i);
    });

    // v6.8's actual rendering (ladder card states, CTA disabled-by-tier
    // copy, decorative-chip claim contradicts the new tappable chip
    // design). Needs per-test rewrite against the live DOM state. See
    // 66-rewards-page failure triage notes.
    test('@smoke ladder reflects T3 — T1+T2 done, T3 current, T4 locked', async ({ page }) => {
        await bootHomeAtTier(page, 'T3_CHANGEMAKER');
        await page.locator('#home-badge-chip').click();
        await expect(page.locator('.rt-card[data-tier="T1_SCOUT"]')).toHaveClass(/is-done/);
        await expect(page.locator('.rt-card[data-tier="T2_SIGNAL"]')).toHaveClass(/is-done/);
        await expect(page.locator('.rt-card[data-tier="T3_CHANGEMAKER"]')).toHaveClass(/is-current/);
        await expect(page.locator('.rt-card[data-tier="T4_LIFEKEEPER"]')).toHaveClass(/is-locked/);
    });

    // v6.8's actual rendering (ladder card states, CTA disabled-by-tier
    // copy, decorative-chip claim contradicts the new tappable chip
    // design). Needs per-test rewrite against the live DOM state. See
    // 66-rewards-page failure triage notes.
    test('@smoke ladder reflects T4 — all done except T4 which is current', async ({ page }) => {
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');
        await page.locator('#home-badge-chip').click();
        await expect(page.locator('.rt-card[data-tier="T1_SCOUT"]')).toHaveClass(/is-done/);
        await expect(page.locator('.rt-card[data-tier="T2_SIGNAL"]')).toHaveClass(/is-done/);
        await expect(page.locator('.rt-card[data-tier="T3_CHANGEMAKER"]')).toHaveClass(/is-done/);
        await expect(page.locator('.rt-card[data-tier="T4_LIFEKEEPER"]')).toHaveClass(/is-current/);
    });

    // v6.8's actual rendering (ladder card states, CTA disabled-by-tier
    // copy, decorative-chip claim contradicts the new tappable chip
    // design). Needs per-test rewrite against the live DOM state. See
    // 66-rewards-page failure triage notes.
    test('Badge Studio CTA is DISABLED at T1 + carries locked hint', async ({ page }) => {
        await bootHomeAtTier(page, 'T1_SCOUT');
        await page.locator('#home-badge-chip').click();
        const btn = page.locator('#btn-rewards-open-studio');
        await expect(btn).toBeDisabled();
        await expect(btn).toHaveClass(/is-locked/);
        const hint = page.locator('#rewards-share-hint');
        await expect(hint).toContainText(/Reach Changemaker/i);
    });

    // v6.8's actual rendering (ladder card states, CTA disabled-by-tier
    // copy, decorative-chip claim contradicts the new tappable chip
    // design). Needs per-test rewrite against the live DOM state. See
    // 66-rewards-page failure triage notes.
    test('Badge Studio CTA is DISABLED at T2 too (still pre-Changemaker)', async ({ page }) => {
        await bootHomeAtTier(page, 'T2_SIGNAL');
        await page.locator('#home-badge-chip').click();
        await expect(page.locator('#btn-rewards-open-studio')).toBeDisabled();
    });

    // v6.8's actual rendering (ladder card states, CTA disabled-by-tier
    // copy, decorative-chip claim contradicts the new tappable chip
    // design). Needs per-test rewrite against the live DOM state. See
    // 66-rewards-page failure triage notes.
    test('@smoke Badge Studio CTA is ENABLED at T3 + opens stage-badge-studio', async ({ page }) => {
        await bootHomeAtTier(page, 'T3_CHANGEMAKER');
        await page.locator('#home-badge-chip').click();
        const btn = page.locator('#btn-rewards-open-studio');
        await expect(btn).not.toBeDisabled();
        await expect(btn).not.toHaveClass(/is-locked/);
        await expect(page.locator('#rewards-share-hint')).toContainText(/Tap to create/i);
        await btn.click();
        await expect(page.locator('#stage-badge-studio.active')).toBeVisible();
    });

    test('@smoke Badge Studio CTA is ENABLED at T4 + opens stage-badge-studio', async ({ page }) => {
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');
        await page.locator('#home-badge-chip').click();
        await expect(page.locator('#btn-rewards-open-studio')).not.toBeDisabled();
        await page.locator('#btn-rewards-open-studio').click();
        await expect(page.locator('#stage-badge-studio.active')).toBeVisible();
    });

    test('back button on Rewards page returns to home stage', async ({ page }) => {
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');
        await page.locator('#home-badge-chip').click();
        await expect(page.locator('#stage-rewards.active')).toBeVisible();
        await page.locator('#btn-rewards-back').click();
        await expect(page.locator('#stage-home.active')).toBeVisible();
    });

    test('@smoke navigating Home → Rewards → Badge Studio never leaves two stages .active at once', async ({ page }) => {
        // Operator-flagged May 2026 — `goToStage` was iterating a
        // hard-coded STAGES + STAGES_V3 list, missing the new
        // stage-rewards + stage-badge-studio. Result: tapping
        // "Open Badge Studio" added .active to stage-badge-studio
        // without removing it from stage-rewards → both rendered
        // simultaneously, overlapping content shown in operator
        // screenshot. This test pins the invariant that exactly ONE
        // .stage carries `.active` at every navigation hop.
        await bootHomeAtTier(page, 'T4_LIFEKEEPER');

        async function assertExactlyOneActive(expectedId: string) {
            const count = await page.locator('.stage.active').count();
            expect(count, `expected exactly one .stage.active; got ${count}`).toBe(1);
            await expect(page.locator(`#${expectedId}.active`)).toBeVisible();
        }

        await assertExactlyOneActive('stage-home');
        await page.locator('#home-badge-chip').click();
        await assertExactlyOneActive('stage-rewards');
        await page.locator('#btn-rewards-open-studio').click();
        await assertExactlyOneActive('stage-badge-studio');
        // Bounce back to home and confirm everything cleans up.
        await page.locator('#btn-badge-studio-back').click();
        await assertExactlyOneActive('stage-home');
    });
});
