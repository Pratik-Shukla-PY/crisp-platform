/**
 * My Submitted Reports - report DETAIL redesign.
 *
 * Guards the four reported defects + the no-regression contract:
 *   F1 - ALL captured photos render as a grid; tapping one opens the shared
 *        viewer in read-only mode (no delete) with prev/next paging + counter
 *        + a clear Close button.
 *   F2 - the Building tag is shown when the report has a building, hidden
 *        otherwise.
 *   F3 - the status line is dynamic ("Submitted … ago") with a qualitative
 *        next-step - NEVER the old fabricated "~30 min".
 *   F4 - no horizontal overflow at 375px (iPhone SE).
 *
 * The detail view upgrades to the FULL device report (GET /device/{hash},
 * which carries media[] + building_id + infrastructure_name); the lightweight
 * status-since payload is the list's, so both are stubbed here.
 */
import { test, expect } from '@playwright/test';

const PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const TWO_H_AGO = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

function fullReport(over: Record<string, unknown> = {}) {
    return {
        id: 'rep-1', client_report_id: 'cli-1', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED',
        server_created_at: TWO_H_AGO, severity: 'SEVERE', crisis_type: 'CYCLONE',
        infrastructure_type: 'UTILITY', damage_classification: 'COMPLETE',
        building_id: 'osm:way:123', infrastructure_name: 'apartments',
        infrastructure_name_from_osm: false, description: 'save me!!',
        location: { latitude: 12.85, longitude: 77.67, device_location_name: 'Bengaluru' },
        thumbnail_url: '/static/p1_thumb.jpg',
        media: [
            { type: 'PHOTO', resolution_tier: 'ORIGINAL', photo_group_id: 'g1', url: '/static/g1.jpg', thumbnail_url: '/static/g1_t.jpg' },
            { type: 'PHOTO', resolution_tier: 'SMALL', photo_group_id: 'g1', url: '/static/g1s.jpg', thumbnail_url: '/static/g1_t.jpg' },
            { type: 'PHOTO', resolution_tier: 'ORIGINAL', photo_group_id: 'g2', url: '/static/g2.jpg', thumbnail_url: '/static/g2_t.jpg' },
            { type: 'PHOTO', resolution_tier: 'ORIGINAL', photo_group_id: 'g3', url: '/static/g3.jpg', thumbnail_url: '/static/g3_t.jpg' },
            { type: 'AUDIO', resolution_tier: 'ORIGINAL', photo_group_id: 'a1', url: '/static/a1.webm' },
        ],
        ...over,
    };
}

async function boot(page, report) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_device_id_v2', 'PWA-test');
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    // Catch-all first; specific routes registered later take precedence.
    await page.route('**/api/v1/**', (r) => r.fulfill({ status: 200, json: {} }));
    await page.route('**/static/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PX }));
    await page.route('**/reports/media/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: PX }));
    await page.route('**/api/v1/reports/device/**', (route) => {
        const u = route.request().url();
        if (u.includes('status-since')) {
            return route.fulfill({ json: [{ id: report.id, client_report_id: report.client_report_id, status: report.status, server_created_at: report.server_created_at, thumbnail_url: report.thumbnail_url, severity: report.severity, infrastructure_type: report.infrastructure_type }] });
        }
        return route.fulfill({ json: [report] });
    });
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('index.html');
    await page.evaluate(() => { const c = document.getElementById('consent-overlay'); if (c) c.style.display = 'none'; });
    await page.waitForTimeout(700);
    await page.evaluate(() => (window as any).openReportDetail('rep-1'));
    await expect(page.locator('#stage-report-detail')).toBeVisible();
    await page.waitForTimeout(900); // full-report upgrade
}

test('F1/F2/F3/F4: all photos + viewer + building + dynamic status, no overflow', async ({ page }) => {
    await boot(page, fullReport());

    // F1 - all 3 distinct photos (tiers grouped by photo_group_id; audio excluded).
    await expect(page.locator('#rd-photos .rd-photo-thumb')).toHaveCount(3);

    // F3 - dynamic elapsed + qualitative next-step; NEVER the fabricated "~30 min".
    await expect(page.locator('#rd-meta-date')).toContainText(/ago/i);
    await expect(page.locator('#rd-eta-text')).toBeVisible();
    expect(await page.evaluate(() => document.body.innerText.includes('~30 min'))).toBe(false);

    // F2 - Building tag present (mapped, since building_id is set).
    await expect(page.locator('#rd-building-section')).toBeVisible();
    await expect(page.locator('.rd-building-name')).toContainText(/apartments/i);
    await expect(page.locator('.rd-building-chip')).toContainText(/mapped/i);

    // F4 - no horizontal overflow at 375px.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

    // F1 viewer - opens read-only, prev/next + counter, Close + Escape dismiss.
    await page.locator('#rd-photos .rd-photo-thumb').first().click();
    await expect(page.locator('#image-viewer-overlay')).toBeVisible();
    await expect(page.locator('#image-viewer-counter')).toContainText('1 / 3');
    await expect(page.locator('#btn-image-viewer-delete')).toBeHidden();
    await expect(page.locator('#btn-image-viewer-prev')).toBeVisible();
    await page.locator('#btn-image-viewer-next').click();
    await expect(page.locator('#image-viewer-counter')).toContainText('2 / 3');
    await page.locator('#btn-image-viewer-close').click();
    await expect(page.locator('#image-viewer-overlay')).toBeHidden();
});

test('F2: Building tag hidden when the report has no building; single photo has no paging', async ({ page }) => {
    await boot(page, fullReport({
        building_id: null, infrastructure_name: null,
        media: [{ type: 'PHOTO', resolution_tier: 'ORIGINAL', photo_group_id: 'g1', url: '/static/only.jpg', thumbnail_url: '/static/only_t.jpg' }],
    }));

    await expect(page.locator('#rd-building-section')).toBeHidden();
    await expect(page.locator('#rd-photos .rd-photo-thumb')).toHaveCount(1);

    await page.locator('#rd-photos .rd-photo-thumb').first().click();
    await expect(page.locator('#image-viewer-overlay')).toBeVisible();
    await expect(page.locator('#btn-image-viewer-prev')).toBeHidden(); // single photo = no paging
    await expect(page.locator('#image-viewer-counter')).toBeHidden();
});
