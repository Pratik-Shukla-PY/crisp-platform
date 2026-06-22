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
        // 1E awareness feed — MUST precede the generic /reports/ catch (the URL
        // /reports/buildings-needing-review also contains '/reports/').
        if (u.includes('/buildings-needing-review')) return route.fulfill({ json: { buildings: [
            { building_id: 'bld-A', building_name: 'City Hospital', candidate_pairs: 3, report_count: 4, high: 2, medium: 1, low: 0 },
            { building_id: 'bld-B', building_name: 'Main Road', candidate_pairs: 1, report_count: 2, high: 0, medium: 1, low: 0 },
        ], total_buildings: 2, total_pairs: 4 } });
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
            // b3 (bld-B) has 2 CONFIRMED merged duplicates → the primary's "2 duplicates"
            // expander reveals them as nested rows.
            if (dm[1] === 'b3') return route.fulfill({ json: { report_id: 'b3', cluster_key: 'b:bld-B', primary_report_id: 'b3', candidates: [
                { report_id: 'b3d1', confidence: 'HIGH', score: 95, confirmed: true, severity: 'SEVERE', status: 'PENDING',
                  crisis_type: 'FLOOD', infrastructure_type: 'ROAD', server_created_at: NOW, location_name: 'Main Road' },
                { report_id: 'b3d2', confidence: 'HIGH', score: 91, confirmed: true, severity: 'MODERATE', status: 'PENDING',
                  crisis_type: 'FLOOD', infrastructure_type: 'ROAD', server_created_at: NOW, location_name: 'Main Road' } ] } });
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
    test('@smoke building-first: default feed groups by building (1B)', async ({ page }) => {
        await boot(page);
        // The feed is ALWAYS building-grouped now → building cards render at the top level.
        await expect(page.locator('.cc-cluster').first()).toBeVisible({ timeout: 8000 });
        // The Buildings/All-Incidents view toggle was retired (Jun 2026): status is the
        // 3-tab axis (Pending/Responding/Resolved) + the feed is always building-grouped.
        await expect(page.locator('.view-btn')).toHaveCount(0);
        await expect(page.locator('.feed-tab[data-tab="pending"]')).toBeVisible();
        await expect(page.locator('.feed-tab[data-tab="responding"]')).toBeVisible();
        await expect(page.locator('.feed-tab[data-tab="resolved"]')).toBeVisible();
    });

    test('@smoke buildings + ONE Ungrouped bucket; "N incidents · M reports"; collapsed by default (1B)', async ({ page }) => {
        await boot(page);
        // 6 reports → bld-A, bld-B, + ONE "Needs mapping / Ungrouped" bucket
        // (the 2 h3 reports + the singleton all fold into one) = 3 cards.
        await expect(page.locator('.cc-cluster')).toHaveCount(3);

        // Building card: "N incidents · M reports" (incidents = visible reports after
        // dup-collapse). bld-A = 2 reports, no merges → "2 incidents" + 1 critical.
        const hosp = page.locator('.cc-cluster[data-cluster-key="b:bld-A"]');
        await expect(hosp.locator('.cc-cluster-title')).toHaveText('City Hospital');
        await expect(hosp.locator('.cc-cluster-meta')).toContainText('2 incidents');
        await expect(hosp.locator('.cc-cluster-meta')).toContainText('1 critical');
        // bld-B = 1 incident (b3 has incident_id NULL → its own singleton incident);
        // its 2 corroborating reports live under the card's "N reports" expander, so the
        // building header is a single clean "1 incident" (no "· M reports/duplicates" dual).
        const metaB = page.locator('.cc-cluster[data-cluster-key="b:bld-B"] .cc-cluster-meta');
        await expect(metaB).toContainText('1 incident');
        await expect(metaB).not.toContainText('duplicate');
        await expect(metaB).not.toContainText('reports');

        // The 3 building-less reports collapse into ONE Ungrouped bucket (nothing hidden).
        await expect(page.locator('.cc-cluster[data-cluster-key="ungrouped"]')).toHaveCount(1);
        await expect(page.locator('.cc-cluster[data-cluster-key="ungrouped"] .cc-cluster-meta'))
            .toContainText('3 reports to map');

        // Collapsed by default → report cards inside not visible yet.
        await expect(hosp).toHaveClass(/collapsed/);
        await expect(hosp.locator('.qrt-card[data-id="b1"]')).toBeHidden();
    });

    test('@smoke expanding a building reveals its reports as evidence (1B)', async ({ page }) => {
        await boot(page);
        const hosp = page.locator('.cc-cluster[data-cluster-key="b:bld-A"]');
        await hosp.locator('.cc-cluster-meta').click();
        await expect(hosp).not.toHaveClass(/collapsed/);
        await expect(hosp.locator('.qrt-card[data-id="b1"]')).toBeVisible();
        await expect(hosp.locator('.qrt-card[data-id="b2"]')).toBeVisible();
        // Clicking a report inside the building opens its detail.
        await hosp.locator('.qrt-card[data-id="b1"]').click();
        await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });
    });

    test('@smoke 1C: Building Console is a flat collapsible dp-section stack (no Overview/Intelligence tabs)', async ({ page }) => {
        await boot(page);
        // v116: clicking anywhere on the building card opens its workspace (console).
        await page.locator('.cc-cluster[data-cluster-key="b:bld-A"] .cc-cluster-name-link').click();
        const bc = page.locator('#detail-panel .bc');
        await expect(bc).toBeVisible({ timeout: 8000 });
        // A2 (Jun 2026): the Overview/Intelligence tabs are retired in favour of one
        // consistent collapsible stack in the incident-detail visual language.
        await expect(bc.locator('.bc-tab')).toHaveCount(0);
        await expect(bc.locator('.dp-section').first()).toBeVisible();
        // History & lifecycle is open by default; Duplicates + Responders are now
        // both present as sibling sections (no longer tab-gated), collapsed by default.
        await expect(bc.locator('.bc-section-history')).toHaveAttribute('open', '');
        const dup = bc.locator('.bc-section-duplicates');
        const resp = bc.locator('.bc-section-responders');
        await expect(dup).toHaveCount(1);
        await expect(resp).toHaveCount(1);
        // Collapsed by default → the section body isn't shown until the header expands it.
        await expect(dup.locator('.dp-section-body')).toBeHidden();
        await expect(resp.locator('.dp-section-body')).toBeHidden();
        // Clicking a section header expands just that section (independent collapse).
        await dup.locator('.dp-section-header').click();
        await expect(dup.locator('.dp-section-body')).toBeVisible();
        await expect(resp.locator('.dp-section-body')).toBeHidden();
    });

    test('@smoke 1E: NO global dup-review panel; each building row shows its dup count → opens the console (merge lives there)', async ({ page }) => {
        await boot(page);
        // Jun 2026: the global "Buildings needing duplicate review" top panel is GONE.
        await expect(page.locator('#dup-review-panel')).toHaveCount(0);
        // Instead, bld-A (City Hospital, 3 candidate pairs / 2 high) shows a per-building
        // dup-count badge on its building row in the feed.
        const badge = page.locator('.cc-cluster[data-cluster-key="b:bld-A"] .cc-cluster-dup');
        await expect(badge).toBeVisible({ timeout: 8000 });
        await expect(badge).toContainText('3');
        await expect(badge).toContainText('high');
        // Clicking the building row opens the console, whose Potential-Duplicates
        // section holds the merge controls (duplicate review lives in the building).
        await page.locator('.cc-cluster[data-cluster-key="b:bld-A"] .cc-cluster-name-link').click();
        await expect(page.locator('#detail-panel .bc')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('#detail-panel .bc-section-duplicates')).toHaveCount(1);
    });

    // ── P2: Cluster View + breadcrumb context ────────────────────────────────
    test('@smoke opening a report inside a cluster: breadcrumb follows Global › [Operation] › Building › #{id}', async ({ page }) => {
        await boot(page);   // building-first default → .cc-cluster building cards already render
        const hosp = page.locator('.cc-cluster[data-cluster-key="b:bld-A"]');
        await hosp.locator('.cc-cluster-meta').click();   // expand (center of header = the title/meta)
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
        await boot(page);   // building-first default → .cc-cluster building cards already render
        const hosp = page.locator('.cc-cluster[data-cluster-key="b:bld-A"]');
        // The building NAME is the click target that opens the console (Cluster View);
        // the header/chevron toggles the incident list (tree-consistent with the op feed).
        await expect(hosp.locator('.cc-cluster-title.cc-bldg-link')).toHaveCount(0);
        await hosp.locator('.cc-cluster-name-link').click();
        // The Building Console opens as the Cluster View.
        await expect(page.locator('#detail-panel.detail-panel--building')).toBeVisible({ timeout: 8000 });
        await expect(page.locator('#detail-panel .bc')).toBeVisible({ timeout: 8000 });
        // Its breadcrumb ends at the BUILDING NAME (the Building Intelligence
        // redesign renamed the "Cluster" crumb to the building it represents).
        await expect(page.locator('#detail-panel .bc .dp-breadcrumb .dp-bc-cur')).toHaveText('City Hospital');
    });

    // ── P3: duplicate surfacing + analyst controls ───────────────────────────
    test('@smoke report detail surfaces within-cluster duplicates READ-ONLY (merge lives at the building)', async ({ page }) => {
        await boot(page);   // building-first default → .cc-cluster building cards already render
        const hosp = page.locator('.cc-cluster[data-cluster-key="b:bld-A"]');
        await hosp.locator('.cc-cluster-meta').click();
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

    // ── b3 has incident_id NULL (the auto-assign fallback) + duplicate_count=2, so it
    //    keeps the confirmed-duplicate path: a neutral "2 duplicates" expander that
    //    reveals the merged duplicates nested. (Real incident_id grouping → "N reports"
    //    is covered in 66.) ──
    test('@smoke an incident-less report keeps the "N duplicates" expander (nested members)', async ({ page }) => {
        await boot(page);
        const bldB = page.locator('.cc-cluster[data-cluster-key="b:bld-B"]');
        await bldB.locator('.cc-cluster-meta').click();
        const b3 = bldB.locator('.qrt-card[data-id="b3"]');
        await expect(b3).toBeVisible({ timeout: 8000 });
        const badge = b3.locator('.qrt-dup-merged');
        await expect(badge).toContainText('2 duplicates');
        await expect(badge).toHaveAttribute('role', 'button');
        await expect(badge).toHaveAttribute('aria-expanded', 'false');
        await badge.click();
        await expect(page.locator('.qrt-dup-children .qrt-dup-child')).toHaveCount(2, { timeout: 8000 });
        await expect(badge).toHaveAttribute('aria-expanded', 'true');
        await expect(page.locator('#detail-panel .bc')).toHaveCount(0);   // did NOT open the console
        // Collapses again on a second click.
        await badge.click();
        await expect(page.locator('.qrt-dup-children .qrt-dup-child')).toHaveCount(0);
    });

    // ── White-box scoring: the duplicate review surfaces the per-factor reasons ─
    test('@smoke duplicate review shows the transparent reason breakdown', async ({ page }) => {
        await boot(page);   // building-first default → .cc-cluster building cards already render
        const hosp = page.locator('.cc-cluster[data-cluster-key="b:bld-A"]');
        await hosp.locator('.cc-cluster-meta').click();
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
