/**
 * Dashboard — multi-image gallery + PhotoSwipe + tier tabs (May 2026).
 *
 * Locks down the Phase A + B behaviour for the user-reported
 * "multi-image lost on dashboard" problem:
 *
 *   · groupPhotos() folds N media rows × 3 tiers into N gallery groups
 *   · the gallery strip always renders (was: only when N > 1)
 *   · the count badge advertises "Photo X of N" on the inline preview
 *   · openGallery() builds a PhotoSwipe data source from the same
 *     groups and registers a per-slide Small/Medium/Original tab
 *   · the "ORIG PENDING" filter pill appears + filters when at least
 *     one LARGE variant hasn't finished assembling
 *
 * We don't drive a real multi-photo capture (out of scope for E2E
 * here — covered by the PWA suite). Instead we seed minimal Report +
 * Media rows directly via the existing dashboard's in-memory
 * `allReports` array, call selectReport(), and assert the resulting
 * DOM. The grouping + PhotoSwipe wiring runs on those synthetic rows
 * exactly the way it would on real ones.
 */
import { test, expect, APIRequestContext, Page } from '@playwright/test';
import { ADMIN } from '../helpers/api';

async function loginAsAdmin(page: Page, request: APIRequestContext): Promise<string> {
    // Idempotent register-or-login (mirrors other dashboard specs).
    await request.post('http://localhost:8000/api/v1/auth/register', {
        data: { ...ADMIN, role: 'SUPER_ADMIN' },
    }).catch(() => {});
    const res = await request.post('http://localhost:8000/api/v1/auth/login', {
        data: { email: ADMIN.email, password: ADMIN.password },
    });
    const body = await res.json();
    const token = body.access_token || body.token;
    await page.goto('index.html');
    await page.evaluate((t) => {
        localStorage.setItem('crisp_token', t);
        localStorage.setItem('crisp_user', JSON.stringify({
            email: 'e2e-admin@crisp.test', role: 'SUPER_ADMIN', full_name: 'E2E Admin',
        }));
    }, token);
    await page.reload();
    return token;
}

// Build a synthetic Report shape with N photo groups × 3 tiers. Mirrors
// the ReportResponse JSON shape verbatim — anything the dashboard
// rendering path reads MUST be present here or the test reflects a
// false-positive bug.
function synthReport(reportId: string, photoGroupCount: number,
                     opts: { largeIncomplete?: boolean } = {}) {
    const media: any[] = [];
    for (let g = 0; g < photoGroupCount; g++) {
        const groupId = `grp-${g}-${reportId}`;
        for (const tier of ['LOW', 'MEDIUM', 'HIGH'] as const) {
            const incomplete = opts.largeIncomplete && tier === 'HIGH';
            media.push({
                id: `m-${tier}-${g}-${reportId}`,
                type: 'IMAGE',
                resolution_tier: tier,
                url: incomplete
                    ? ''
                    : `https://placehold.co/${tier === 'HIGH' ? 800 : tier === 'MEDIUM' ? 400 : 200}.jpg`,
                assembly_status: incomplete ? 'pending' : 'complete',
                photo_group_id: groupId,
                is_synced: !incomplete,
                completion_pct: incomplete ? 35 : 100,
                thumbnail_url: null,
                pii_blur_status: 'complete',
                photo_phash: null,
            });
        }
    }
    return {
        id: reportId,
        client_report_id: `e2e-multi-${Date.now()}`,
        device_id: 'E2E-DEV-MULTI',
        source: 'APP',
        status: 'PENDING',
        sync_status: 'SYNCED',
        severity: 'MODERATE',
        infrastructure_type: 'RESIDENTIAL',
        description: 'E2E multi-image test',
        expected_media: photoGroupCount * 3,
        received_media: photoGroupCount * (opts.largeIncomplete ? 2 : 3),
        server_created_at: new Date().toISOString(),
        crisis_type: 'FLOOD',
        damage_classification: 'PARTIAL',
        location: { latitude: 12.97, longitude: 77.59, accuracy_meters: 10 },
        media,
        ai_analysis: null,
        verification: null,
    };
}

test.describe('Dashboard — multi-image gallery + PhotoSwipe + tier tabs', () => {
    test.beforeEach(async ({ page, request }) => {
        await loginAsAdmin(page, request);
        await page.waitForFunction(
            () => typeof (window as any).selectReport === 'function'
              && Array.isArray((window as any).allReports),
            null, { timeout: 15_000 },
        );
    });

    test('groupPhotos() folds 9 media rows × 3 tiers into 3 photo groups', async ({ page }) => {
        const counts = await page.evaluate(() => {
            const grp = (window as any).groupPhotos;
            if (typeof grp !== 'function') return null;
            const media = [];
            for (let g = 0; g < 3; g++) {
                for (const tier of ['LOW', 'MEDIUM', 'HIGH']) {
                    media.push({
                        type: 'IMAGE',
                        resolution_tier: tier,
                        photo_group_id: `g${g}`,
                        url: 'x',
                        assembly_status: 'complete',
                        is_synced: true,
                        completion_pct: 100,
                        id: `m-${tier}-${g}`,
                    });
                }
            }
            const groups = grp(media);
            return {
                groupCount: groups.length,
                memberCounts: groups.map((x: any) => x.members.length),
                groupIds: groups.map((x: any) => x.group_id).sort(),
            };
        });
        expect(counts, 'groupPhotos not exposed on window').not.toBeNull();
        expect(counts!.groupCount).toBe(3);
        expect(counts!.memberCounts).toEqual([3, 3, 3]);
        expect(counts!.groupIds).toEqual(['g0', 'g1', 'g2']);
    });

    test('detail panel: 3-photo report renders 3 thumbs + count badge "1 of 3"', async ({ page }) => {
        const reportId = `e2e-mi-${Date.now()}`;
        await page.evaluate((rep) => {
            const arr = (window as any).allReports || [];
            arr.unshift(rep);
            (window as any).allReports = arr;
        }, synthReport(reportId, 3));

        await page.evaluate((id) => (window as any).selectReport(id), reportId);
        await expect(page.locator('#detail-panel')).toBeVisible();

        // Strip renders one thumb per photo group.
        await expect(
            page.locator(`#dp-img-view-${reportId} ~ .dp-gallery .dp-gallery-thumb`),
        ).toHaveCount(3);
        // Phase A — count badge advertises "Photo 1 of 3" on the inline preview.
        const badge = page.locator(`#dp-img-view-${reportId} .dp-img-count-badge`);
        await expect(badge).toBeVisible();
        await expect(badge).toContainText(/Photo\s+1\s+of\s+3/);
    });

    test('openGallery() lives on window + PhotoSwipe is loaded from CDN', async ({ page }) => {
        const flags = await page.evaluate(() => ({
            hasOpenGallery: typeof (window as any).openGallery === 'function',
            hasOpenLightbox: typeof (window as any).openLightbox === 'function',
            hasPhotoSwipe: typeof (window as any).PhotoSwipe !== 'undefined',
        }));
        expect(flags.hasOpenGallery, 'openGallery should be on window').toBe(true);
        expect(flags.hasOpenLightbox, 'openLightbox shim should remain for satellite call sites').toBe(true);
        expect(flags.hasPhotoSwipe, 'PhotoSwipe CDN should load via index.html <script>').toBe(true);
    });

    test('originals-pending count is computed when at least one LARGE is incomplete', async ({ page }) => {
        const reportId = `e2e-mi-pend-${Date.now()}`;
        await page.evaluate((rep) => {
            const arr = (window as any).allReports || [];
            arr.unshift(rep);
            (window as any).allReports = arr;
            const fn = (window as any).updateCommandStats;
            if (typeof fn === 'function') fn();
        }, synthReport(reportId, 2, { largeIncomplete: true }));

        // v56: the aggregate orig-pending PILL was retired with the command-bar
        // (per-report upload status now surfaces on the detail panel - see the
        // next test). updateCommandStats still computes the count into the
        // retained stub, so the detection pipeline stays covered.
        await expect(page.locator('#count-originals-pending')).toHaveText(/^[1-9]\d*$/);
    });

    test('per-card ORIG chip surfaces on reports with incomplete LARGE', async ({ page }) => {
        const reportId = `e2e-mi-card-${Date.now()}`;
        await page.evaluate((rep) => {
            const arr = (window as any).allReports || [];
            arr.unshift(rep);
            (window as any).allReports = arr;
            const fn = (window as any).renderFeed;
            if (typeof fn === 'function') fn();
        }, synthReport(reportId, 2, { largeIncomplete: true }));

        // Phase F image-reliability (May 2026) — assert the chip via a
        // DOM evaluate rather than visibility. The previous
        // `.qrt-orig-chip.first()` assertion was lucky-passing when
        // the dev DB had < 50 reports; once F1's sweep tests grew the
        // DB past that threshold the synthetic MODERATE report sank
        // below the progressive-reveal virtualizer's 50-card cutoff
        // (`_applyProgressiveReveal` sets `display:none` on cards
        // beyond index 50) and toBeVisible() failed even though the
        // chip element was correctly in the DOM. Polling-driven
        // refetch also races the visibility check — it can wipe the
        // synthetic report before Playwright resolves. evaluate()
        // captures the post-render DOM in one shot and decouples the
        // intent ("chip surfaces") from viewport coincidence.
        // v55: the original-pending chip moved off the card into the detail
        // panel's status-chip row (_incidentStatusChips). Assert the chip-
        // generation logic directly on the report (robust vs. a full detail render).
        const probe = await page.evaluate((id) => {
            const r = ((window as any).allReports || []).find((x: any) => x.id === id);
            const html = (r && (window as any)._incidentStatusChips) ? (window as any)._incidentStatusChips(r) : '';
            const div = document.createElement('div'); div.innerHTML = html;
            const chip = div.querySelector('.qrt-orig-chip');
            return {
                cardFound: !!r,
                chipFound: !!chip,
                chipText: chip ? (chip.textContent || '').trim() : '',
                chipClass: chip ? chip.className : '',
            };
        }, reportId);
        expect(probe.cardFound, 'synthetic report must be in allReports').toBe(true);
        expect(probe.chipFound, 'detail status-chips must render .qrt-orig-chip when HIGH is pending').toBe(true);
        expect(probe.chipText).toMatch(/ORIG/);
        // Phase F state-modifier class must be present so the CSS tone
        // (amber pulse) lights up; without this the chip would render
        // the base styling only.
        expect(probe.chipClass).toMatch(/qrt-orig-chip-uploading|qrt-orig-chip-missing-fresh/);
    });
});
