/**
 * V4 review-page content surfaces (May 2026 operator rethink,
 * re-pinned against the HC65/HC66 Step-3 redesign).
 *
 * History:
 *   · The original rethink replaced the legacy "Captured" strip +
 *     summary card + voice drawer trio with 4 fat content cards
 *     (Photo / Description / Location / Classification).
 *   · HC65 (zero-scroll redesign) compressed those cards into compact
 *     rows and HID the description card on review — the capture stage
 *     (HC60 voice/text) is the authoritative description input now.
 *   · HC66 replaced the single photo row (`#v4-edit-photo` +
 *     `#v4-summary-thumb`) with a 3-slot photo strip
 *     (`#v4-review-photo-strip`, painted by _renderReviewPhotoStrip
 *     in v4-flow.js), flattened Location into the
 *     `.v4-review-loc-strip` button and Classification into 3 plain
 *     `.v4-classify-row` buttons.
 *   · HC67 renamed the damage display copy to the canonical i18n
 *     labels: MINIMAL → "Minimal Damage", PARTIAL → "Partial Damage",
 *     COMPLETE → "Fully Destroyed".
 *
 * This spec pins the CURRENT surfaces:
 *   1. Title (h3.v4-review-title).
 *   2. Photo strip — 3 slots; filled tiles for captured photos;
 *      `+ Add` CTA opens the camera capture entry.
 *   3. Location strip + classification rows render.
 *   4. Classification rows show the user's picks with distinct icons
 *      (regression guard against the prior .fa-house collision).
 *   5. Description card stays HIDDEN on review while its empty/filled
 *      state machine (__crispV4RefreshDesc) keeps working — no
 *      duplicate "Add voice or text" prompt can ever surface here.
 *   6. Send + UNDP trigger remain visible.
 */
import { test, expect } from '@playwright/test';

async function bootReview(page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        // Pin EN so copy assertions are immune to geo-locale variance.
        localStorage.setItem('crisp_lang_manual', 'en');
        localStorage.setItem('crisp_lang', 'en');
    });
    await page.goto('index.html');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function'
           && typeof (window as any).state === 'object',
        null, { timeout: 8000 },
    );
    await page.evaluate(() => {
        (window as any).__crispGoToStage('stage-v4-review');
    });
    await page.waitForTimeout(450);
}

test.describe('V4 review-page content cards', () => {

    test('section title is shown', async ({ page }) => {
        await bootReview(page);
        const title = page.locator('#stage-v4-review h3.v4-review-title');
        await expect(title).toBeVisible();
        await expect(title).toContainText(/Review your report/i);
    });

    test('all current content surfaces render on stage-v4-review boot', async ({ page }) => {
        await bootReview(page);
        // HC66 layout: photo strip + location strip + classification rows.
        await expect(page.locator('#v4-review-photo-strip')).toBeVisible();
        await expect(page.locator('#v4-edit-location')).toBeVisible();
        await expect(page.locator('.v4-review-classify-rows')).toBeVisible();
        await expect(page.locator('.v4-review-classify-rows .v4-classify-row')).toHaveCount(3);
        // HC65: the description card is markup-present but HIDDEN on
        // review — the capture stage owns voice/text input.
        const descCard = page.locator('#v4-desc-card');
        await expect(descCard).toHaveCount(1);
        await expect(descCard).toBeHidden();
    });

    test('legacy review surfaces are gone', async ({ page }) => {
        await bootReview(page);
        // Pre-rethink trio.
        expect(await page.locator('.v4-captured-strip').count()).toBe(0);
        expect(await page.locator('.v4-summary').count()).toBe(0);
        // HC65/HC66-retired hooks — guard against resurrection.
        expect(await page.locator('.v4-review-title-section').count()).toBe(0);
        expect(await page.locator('#v4-edit-photo').count()).toBe(0);
        expect(await page.locator('#v4-summary-thumb').count()).toBe(0);
    });

    test('description state machine shows EMPTY state when no voice + no text', async ({ page }) => {
        await bootReview(page);
        await page.evaluate(() => {
            const s: any = (window as any).state || (((window as any).state) = {});
            s.transcript = '';
            s.description = '';
            s.audioBlob = null;
            // Call the exposed refresher directly (avoids the
            // `goToStage` short-circuit when already on the target).
            (window as any).__crispV4RefreshDesc?.();
        });
        await page.waitForTimeout(100);
        // HC65 hides the whole card on review, so assert the state
        // machine via the `hidden` attribute toggles, not visibility.
        const flags = await page.evaluate(() => ({
            emptyHidden: document.getElementById('v4-desc-empty')!.hasAttribute('hidden'),
            previewHidden: document.getElementById('v4-desc-preview')!.hasAttribute('hidden'),
        }));
        expect(flags.emptyHidden).toBe(false);
        expect(flags.previewHidden).toBe(true);
        await expect(page.locator('#v4-desc-empty')).toContainText(/Add voice or text/i);
    });

    test('description state machine shows FILLED state when text is present', async ({ page }) => {
        await bootReview(page);
        await page.evaluate(() => {
            const s: any = (window as any).state || (((window as any).state) = {});
            s.transcript = '';
            s.audioBlob = null;
            s.description = 'Water is rising on Main Street, several houses underwater';
            (window as any).__crispV4RefreshDesc?.();
        });
        await page.waitForTimeout(100);
        const flags = await page.evaluate(() => ({
            emptyHidden: document.getElementById('v4-desc-empty')!.hasAttribute('hidden'),
            previewHidden: document.getElementById('v4-desc-preview')!.hasAttribute('hidden'),
        }));
        expect(flags.previewHidden).toBe(false);
        expect(flags.emptyHidden).toBe(true);
        await expect(page.locator('#v4-desc-text-snippet')).toContainText(/Water is rising/i);
    });

    test('NO duplicate "Add voice or text" prompt when content exists', async ({ page }) => {
        await bootReview(page);
        await page.evaluate(() => {
            const s: any = (window as any).state || (((window as any).state) = {});
            s.description = 'Some description';
            s.transcript = '';
            (window as any).__crispV4RefreshDesc?.();
        });
        await page.waitForTimeout(100);
        await expect(page.locator('#v4-desc-empty')).toBeHidden();
        // Drawer summary is `hidden` — no second "Add voice or text" label.
        const summaryHidden = await page.locator('#v4-voice-drawer > summary').evaluate(
            (el) => el.hasAttribute('hidden'),
        );
        expect(summaryHidden).toBe(true);
    });

    test('classification rows show 3 separate values + distinct icons', async ({ page }) => {
        await bootReview(page);
        await page.evaluate(() => {
            const s: any = (window as any).state || (((window as any).state) = {});
            s.infrastructure_type = 'UTILITY';
            s.crisis_type = 'HURRICANE';
            s.damage_classification = 'COMPLETE';
            // goToReview() re-runs _updateReviewSummary even when the
            // stage is already active (plain goToStage short-circuits).
            (window as any).CrispV4?.goToReview();
        });
        await page.waitForTimeout(300);
        await expect(page.locator('#v4-row-infra-text')).toContainText(/Utility/i);
        await expect(page.locator('#v4-row-crisis-text')).toContainText(/Hurricane/i);
        // HC67 display copy: COMPLETE renders as "Fully Destroyed"
        // (canonical `damage_complete` i18n label).
        await expect(page.locator('#v4-row-damage-text')).toContainText(/Fully Destroyed/i);
        // Distinct icon classes — regression guard against the prior
        // .fa-house collision (both infra + crisis used a house icon).
        const infraIcon = await page.locator('#v4-edit-infra i.fa-solid').first().getAttribute('class');
        const crisisIcon = await page.locator('#v4-edit-crisis i.fa-solid').first().getAttribute('class');
        const damageIcon = await page.locator('#v4-edit-damage i.fa-solid').first().getAttribute('class');
        expect(infraIcon).not.toEqual(crisisIcon);
        expect(crisisIcon).not.toEqual(damageIcon);
        expect(infraIcon).not.toEqual(damageIcon);
    });

    test('classification row taps route to stage-v4-classify', async ({ page }) => {
        await bootReview(page);
        await page.locator('#v4-edit-infra').click();
        await expect(page.locator('#stage-v4-classify.active')).toBeVisible({ timeout: 1500 });
    });

    test('photo strip paints filled tiles for captured photos', async ({ page }) => {
        await bootReview(page);
        await page.evaluate(() => {
            const s: any = (window as any).state || (((window as any).state) = {});
            // HC78 — the strip rebuilds state.v4Photos canonically from
            // [primary (photoDataUrl), ...extraPhotos] at every paint.
            s.photoDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
            s.extraPhotos = [];
            (window as any).CrispV4?.goToReview();
        });
        await page.waitForTimeout(300);
        const strip = page.locator('#v4-review-photo-strip');
        await expect(strip.locator('.v4-review-photo-tile')).toHaveCount(1);
        await expect(strip.locator('.v4-review-photo-tile img')).toHaveAttribute(
            'src', /^data:image\/png/);
        // Filled tile carries its × delete affordance.
        await expect(strip.locator('.v4-review-photo-tile-x')).toHaveCount(1);
        // Remaining slots stay as + Add CTAs (3-slot strip).
        await expect(strip.locator('.v4-review-photo-add')).toHaveCount(2);
    });

    test('photo strip + Add tap opens the camera capture entry', async ({ page }) => {
        await bootReview(page);
        // No photos seeded → all 3 slots are + Add CTAs.
        const addSlots = page.locator('#v4-review-photo-strip .v4-review-photo-add');
        await expect(addSlots).toHaveCount(3);
        // Deterministic getUserMedia mock (same pattern as spec 52) so
        // openCameraModal's stream request resolves in headless.
        await page.evaluate(() => {
            const w = window as any;
            const track = {
                kind: 'video',
                stop() {},
                applyConstraints() { return Promise.resolve(); },
            };
            const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
            w.navigator.mediaDevices = w.navigator.mediaDevices || {};
            w.navigator.mediaDevices.getUserMedia = () => Promise.resolve(stream);
            try {
                Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
                    configurable: true, set() {}, get() { return null; },
                });
            } catch (_) {}
        });
        await addSlots.first().click();
        // HC97 — review "+ Add" routes through the same smart camera
        // entry as Stage-1: the custom #camera-modal opens.
        await page.waitForFunction(() => {
            const m = document.getElementById('camera-modal');
            return !!m && getComputedStyle(m).display !== 'none';
        }, null, { timeout: 3000 });
    });

    test('Send + UNDP trigger remain visible alongside the new surfaces', async ({ page }) => {
        await bootReview(page);
        await expect(page.locator('#btn-v4-send')).toBeVisible();
        await expect(page.locator('#btn-v4-open-undp')).toBeVisible();
    });
});
