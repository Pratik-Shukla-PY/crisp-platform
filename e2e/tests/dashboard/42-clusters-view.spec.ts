/**
 * Dashboard — Clusters feed view (opt-in, P1 of the Incident Intelligence redesign).
 *
 * Groups reports into Building/Location incident clusters so the analyst sees ONE
 * operational problem, not N report cards. Cluster key precedence:
 *   building_id → h3 cell → the report itself (singleton) — nothing disappears.
 * Opt-in: default view stays Queue; Clusters is a 3rd view-mode button.
 *
 * Self-contained: fakes auth + stubs /api/v1 (no backend).
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();
const loc = (name: string, h3: string | null) => ({ latitude: 25.6, longitude: 85.1, device_location_name: name, h3_idx: h3 });

// 6 reports → 4 clusters: bld-A (2, incl. 1 critical), bld-B (1), h3:hexZ (2), singleton s1 (1).
const REPORTS = [
    { id: 'b1', severity: 'CRITICAL', status: 'PENDING', crisis_type: 'FLOOD', infrastructure_type: 'HOSPITAL', building_id: 'bld-A', server_created_at: NOW, location: loc('City Hospital', 'h1') },
    { id: 'b2', severity: 'MODERATE', status: 'PENDING', crisis_type: 'FLOOD', building_id: 'bld-A', server_created_at: NOW, location: loc('City Hospital', 'h1') },
    { id: 'b3', severity: 'SEVERE', status: 'PENDING', crisis_type: 'FLOOD', infrastructure_type: 'ROAD', building_id: 'bld-B', server_created_at: NOW, location: loc('Main Road', 'h2'), duplicate_count: 2 },
    { id: 'h1', severity: 'MODERATE', status: 'PENDING', crisis_type: 'FLOOD', building_id: null, server_created_at: NOW, location: loc('Riverside', 'hexZ') },
    { id: 'h2', severity: 'MINOR', status: 'PENDING', crisis_type: 'FLOOD', building_id: null, server_created_at: NOW, location: loc('Riverside', 'hexZ') },
    { id: 's1', severity: 'MODERATE', status: 'PENDING', crisis_type: 'FLOOD', building_id: null, server_created_at: NOW, location: loc('Lone report', null) },
];

const SUMMARY = { generated_at: NOW, window_hours: 24, stale_hours: 24, total_reports: 6,
    counts: { active: 6, critical: 1, needs_review: 6, needs_response: 0, active_operations: 0, critical_incidents: 1,
        pending_verification: 6, awaiting_triage: 6, open_dispatch: 0, resolved_in_window: 0, active_ops: 0, escalating: 0, stale: 0, sla_at_risk: 0 },
    distributions: { by_severity: {}, by_crisis_type: {}, by_status: {}, verified: 0, unverified: 6 }, timings: {}, impact: {}, deltas: {} };

// Building detail for the Cluster View (Building Console) — bld-A holds b1+b2.
const BUILDING_A = {
    id: 'bld-A', state: 'ACTIVE', severity_max: 'CRITICAL',
    report_count: 2, verified_report_count: 0, responding_report_count: 0, debris_clearing_needed_count: 0,
    crisis_types_top3: ['FLOOD'], centroid_lat: 25.6, centroid_lng: 85.1, osm_name: 'City Hospital',
    severity_score: 80, confidence_score: 50, activity_score: 40, escalation_risk: 30, humanitarian_priority: 60,
    first_report_at: NOW, latest_report_at: NOW,
    reports: REPORTS.filter((r) => r.building_id === 'bld-A'),
};

async function boot(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops Lead' }));
    });
    await page.route('**/api/v1/**', async (route) => {
        const u = route.request().url();
        if (u.includes('/analytics/summary')) return route.fulfill({ json: SUMMARY });
        if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
        if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
        if (u.includes('/duplicate-decision')) return route.fulfill({ json: { ok: true } });
        const dm = u.match(/\/reports\/([^/?]+)\/duplicates/);
        if (dm) {
            if (dm[1] === 'b1') return route.fulfill({ json: { report_id: 'b1', cluster_key: 'bld-A', primary_report_id: null, candidates: [
                { report_id: 'b2', confidence: 'MEDIUM', score: 75, confirmed: false, description_similarity: 0.5,
                  reasons: [{ factor: 'same_building', matched: true, weight: 20, label: 'Same building' },
                            { factor: 'within_1h', matched: true, weight: 25, label: 'Within 1 hour', detail: '12 min apart' }],
                  reporter: 'User a1b2c3d',
                  severity: 'MODERATE', status: 'PENDING', crisis_type: 'FLOOD', infrastructure_type: 'HOSPITAL',
                  server_created_at: NOW, location_name: 'City Hospital' } ] } });
            return route.fulfill({ json: { report_id: dm[1], cluster_key: null, primary_report_id: null, candidates: [] } });
        }
        if (u.includes('/buildings/')) return route.fulfill({ json: BUILDING_A });
        if (u.includes('/operations')) return route.fulfill({ json: [] });
        if (u.includes('/reports/')) return route.fulfill({ status: 200, headers: { 'X-Total-Count': '6' }, json: REPORTS });
        return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html#/incidents');
    await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 8000 });
}

test.describe('Dashboard — Clusters feed view (P1)', () => {
    test('@smoke Clusters is OPT-IN: default feed is Queue, not clusters', async ({ page }) => {
        await boot(page);
        // A queue card is present; no cluster cards until the operator opts in.
        await expect(page.locator('.qrt-card[data-id="b1"]')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('.cc-cluster')).toHaveCount(0);
        // The Clusters view button exists.
        await expect(page.locator('.view-btn[data-mode="clusters"]')).toBeVisible();
    });

    test('@smoke switching to Clusters groups by building → h3 → singleton; collapsed by default', async ({ page }) => {
        await boot(page);
        await page.locator('.view-btn[data-mode="clusters"]').click();

        // 4 clusters from 6 reports.
        await expect(page.locator('.cc-cluster')).toHaveCount(4);

        // The building cluster is named + summarised (2 reports incl. 1 critical).
        const hosp = page.locator('.cc-cluster[data-cluster-key="b:bld-A"]');
        await expect(hosp.locator('.cc-cluster-title')).toHaveText('City Hospital');
        await expect(hosp.locator('.cc-cluster-meta')).toContainText('2 reports');
        await expect(hosp.locator('.cc-cluster-meta')).toContainText('1 critical');

        // The h3-fallback cluster groups the 2 null-building Riverside reports.
        await expect(page.locator('.cc-cluster[data-cluster-key="h3:hexZ"]')).toHaveCount(1);
        await expect(page.locator('.cc-cluster[data-cluster-key="h3:hexZ"] .cc-cluster-meta')).toContainText('2 reports');
        // The lone ungroupable report is its own singleton cluster (nothing lost).
        await expect(page.locator('.cc-cluster[data-cluster-key="r:s1"].cc-cluster-single')).toHaveCount(1);

        // Collapsed by default → report cards inside are not visible yet.
        await expect(hosp).toHaveClass(/collapsed/);
        await expect(hosp.locator('.qrt-card[data-id="b1"]')).toBeHidden();
    });

    test('@smoke expanding a cluster reveals its reports as evidence', async ({ page }) => {
        await boot(page);
        await page.locator('.view-btn[data-mode="clusters"]').click();
        const hosp = page.locator('.cc-cluster[data-cluster-key="b:bld-A"]');
        await hosp.locator('.cc-cluster-main').click();
        await expect(hosp).not.toHaveClass(/collapsed/);
        await expect(hosp.locator('.qrt-card[data-id="b1"]')).toBeVisible();
        await expect(hosp.locator('.qrt-card[data-id="b2"]')).toBeVisible();
        // Clicking a report inside the cluster opens its detail.
        await hosp.locator('.qrt-card[data-id="b1"]').click();
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });
    });

    // ── P2: Cluster View + breadcrumb context ────────────────────────────────
    test('@smoke opening a report inside a cluster: breadcrumb follows Global › [Operation] › Building › #{id}', async ({ page }) => {
        await boot(page);
        await page.locator('.view-btn[data-mode="clusters"]').click();
        const hosp = page.locator('.cc-cluster[data-cluster-key="b:bld-A"]');
        await hosp.locator('.cc-cluster-main').click();   // expand (center of header = the title/meta)
        const b1 = hosp.locator('.qrt-card[data-id="b1"]');
        await expect(b1).toBeVisible();
        await b1.click();
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });
        // Full hierarchy: the building segment is in the breadcrumb (b1 has no
        // operation, so: Global › Building › #b1) and links to the Building Console.
        const bc = page.locator('#detail-panel .dp-breadcrumb');
        await expect(bc).toContainText('Global');
        await expect(bc.locator('.dp-bc-bldg')).toHaveCount(1);
        await expect(bc.locator('.dp-bc-cluster')).toHaveCount(0);
        await expect(bc.locator('.dp-bc-cur')).toContainText('#b1');
    });

    test('@smoke the cluster card opens the Cluster View (Building Console) with its own breadcrumb', async ({ page }) => {
        await boot(page);
        await page.locator('.view-btn[data-mode="clusters"]').click();
        const hosp = page.locator('.cc-cluster[data-cluster-key="b:bld-A"]');
        // Building-backed clusters expose an "open cluster view" affordance.
        await expect(hosp.locator('.cc-cluster-open')).toBeVisible();
        await hosp.locator('.cc-cluster-open').click();
        // The Building Console opens as the Cluster View.
        await expect(page.locator('#detail-panel.detail-panel--building')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('#detail-panel .bc')).toBeVisible({ timeout: 8000 });
        // Its breadcrumb ends at the BUILDING NAME (the Building Intelligence
        // redesign renamed the "Cluster" crumb to the building it represents).
        await expect(page.locator('#detail-panel .bc .dp-breadcrumb .dp-bc-cur')).toHaveText('City Hospital');
        // Singleton / h3 clusters have NO open-cluster affordance (no console).
        await expect(page.locator('.cc-cluster[data-cluster-key="r:s1"] .cc-cluster-open')).toHaveCount(0);
        await expect(page.locator('.cc-cluster[data-cluster-key="h3:hexZ"] .cc-cluster-open')).toHaveCount(0);
    });

    // ── P3: duplicate surfacing + analyst controls ───────────────────────────
    test('@smoke report detail surfaces within-cluster duplicates READ-ONLY (merge lives at the building)', async ({ page }) => {
        await boot(page);
        await page.locator('.view-btn[data-mode="clusters"]').click();
        const hosp = page.locator('.cc-cluster[data-cluster-key="b:bld-A"]');
        await hosp.locator('.cc-cluster-main').click();
        const b1 = hosp.locator('.qrt-card[data-id="b1"]');
        await expect(b1).toBeVisible();
        await b1.click();
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });

        // Duplicate analysis now lives in the Confidence Assessment workspace
        // (Section 3), not a separate panel section. Open it via a synthetic
        // assessed snapshot (avoids a live AI/satellite call); the dup section
        // still loads from the real GET /reports/{id}/duplicates.
        await page.evaluate(() => {
            window.__assessCache = window.__assessCache || {};
            window.__assessCache['b1'] = { ic: { score: 70, band: 'LIKELY', assessed: true, max_score: 100, ran_count: 4, total_checks: 5, reasons: [], factors: [] }, verification: null, ai_assessment: null, duplicate_count: 1, building_id: 'bld-A', at: null };
            (window as any)._showAssessmentModal('b1');
        });
        const host = page.locator('#assess-dup-host');
        await expect(host.locator('.assess-dup-conf').first()).toHaveText('MEDIUM', { timeout: 8000 });

        // Expand the Duplicate analysis section (open the workspace's <details>).
        await page.locator('.assess-sec', { hasText: 'Duplicate analysis' }).locator('summary').click();

        // Dedup consolidation (Jun 2026): the merge DECISIONS live at the Building
        // Console. The breakdown is READ-ONLY - no Merge / Not / Set-primary
        // controls - and offers a single "Review & merge in Building Console" link.
        // Each candidate stays reachable to inspect its unique evidence.
        await expect(host.locator('.assess-dup-yes, .assess-dup-primary, .assess-dup-btn')).toHaveCount(0);
        await expect(host.locator('.assess-dup-review')).toBeVisible();
        await expect(host.locator('.assess-dup-open').first()).toBeVisible();
    });

    // ── Duplicate collapse: the primary feed card wears the merged badge ──────
    test('@smoke a primary with merged duplicates shows the "N duplicate reports" badge', async ({ page }) => {
        await boot(page);   // default Queue view
        const b3 = page.locator('.qrt-card[data-id="b3"]');
        await expect(b3).toBeVisible({ timeout: 8000 });
        await expect(b3.locator('.qrt-dup-merged')).toContainText('2 duplicate reports');
    });

    // ── White-box scoring: the duplicate review surfaces the per-factor reasons ─
    test('@smoke duplicate review shows the transparent reason breakdown', async ({ page }) => {
        await boot(page);
        await page.locator('.view-btn[data-mode="clusters"]').click();
        const hosp = page.locator('.cc-cluster[data-cluster-key="b:bld-A"]');
        await hosp.locator('.cc-cluster-main').click();
        await hosp.locator('.qrt-card[data-id="b1"]').click();
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });
        await page.evaluate(() => {
            window.__assessCache = window.__assessCache || {};
            window.__assessCache['b1'] = { ic: { score: 70, band: 'LIKELY', assessed: true, max_score: 100, ran_count: 4, total_checks: 5, reasons: [], factors: [] }, verification: null, ai_assessment: null, duplicate_count: 1, building_id: 'bld-A', at: null };
            (window as any)._showAssessmentModal('b1');
        });
        const host = page.locator('#assess-dup-host');
        // The white-box reason chips render the documented factors.
        await expect(host.locator('.assess-dup-reason').first()).toContainText('Same building', { timeout: 8000 });
        await expect(host.locator('.assess-dup-reason')).toContainText(['Same building', 'Within 1 hour']);
    });
});
