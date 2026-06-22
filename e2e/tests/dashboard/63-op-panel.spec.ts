import { test, expect, Page } from '@playwright/test';
const NOW = new Date().toISOString();
const loc = { latitude: 36.2, longitude: 37.1, user_location_name: 'Aleppo' };
const OPS = [{ id: 'op-a', name: 'Aleppo Quake', place_name: 'Aleppo, SY', status: 'LIVE', is_active: true,
  health: 'RED', health_reason: 'critical', incident_count: 3, total: 4, verified: 1, new_24h: 2, responders_active: 2,
  center_lat: 36.2, center_lng: 37.1, critical: 3 }];
const REPORTS = [
  { id: 'r1', severity: 'CRITICAL', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'EARTHQUAKE',
    crisis_event_id: 'op-a', building_id: 'b1', infrastructure_name: 'Al-Razi Hospital', infrastructure_name_from_osm: true,
    infrastructure_type: 'HOSPITAL', source: 'APP', server_created_at: NOW, location: { ...loc }, media: [] },
  { id: 'r2', severity: 'SEVERE', status: 'PENDING', reviewer_verdict: 'NOT_REVIEWED', crisis_type: 'EARTHQUAKE',
    crisis_event_id: 'op-a', building_id: 'b2', infrastructure_name: 'Central School', infrastructure_name_from_osm: true,
    infrastructure_type: 'SCHOOL', source: 'WHATSAPP', server_created_at: NOW, location: { ...loc }, media: [] },
];
const SUMMARY = { counts: { critical: 3, needs_review: 1, needs_response: 2, active_operations: 1, active: 4, active_ops: 1 }, total_reports: 4, distributions: {}, timings: {}, impact: {}, deltas: {} };
async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('crisp_token', 'e2e-fake-token');
    localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops' }));
    localStorage.setItem('crisp_router_force_root', '1');
  });
  await page.route('**/api/v1/**', async (route) => {
    const u = route.request().url();
    if (u.includes('/analytics/summary')) return route.fulfill({ json: SUMMARY });
    if (/\/operations(\?|$)/.test(u)) return route.fulfill({ json: OPS });
    if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
    if (u.includes('/reports/buildings-needing-review')) return route.fulfill({ json: { buildings: [], total_buildings: 0, total_pairs: 0 } });
    if (u.includes('/weather') || u.includes('/conditions')) return route.fulfill({ json: {} });
    if (/\/reports\/?\?/.test(u)) {
      const scoped = /crisis_event_id=op-a/.test(u);
      return route.fulfill({ status: 200, headers: { 'X-Total-Count': String(scoped ? 2 : REPORTS.length) }, json: REPORTS });
    }
    const s = u.match(/\/reports\/(r\d)(?:\?|$)/); if (s) return route.fulfill({ json: REPORTS.find((r) => r.id === s[1]) || {} });
    return route.fulfill({ status: 200, json: {} });
  });
  await page.goto('index.html');
  await page.waitForFunction(() => Array.isArray((window as any).allReports), null, { timeout: 15000 });
}
test.describe('Dashboard — operation opens in the console right-panel', () => {}); test('operation opens in the right panel (not a full-page route)', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await boot(page);
  // Navigate to a specific operation — the router aliases it to the Console + panel.
  await page.evaluate(() => { location.hash = '#/operations/op-a'; });
  // The operation renders in the right detail panel.
  const panel = page.locator('#detail-panel.detail-panel--operation');
  await expect(panel).toBeVisible({ timeout: 8000 });
  await expect(panel.locator('#cco-command')).toContainText('Aleppo Quake', { timeout: 8000 });
  await expect(panel.locator('#cco-weather')).toBeVisible();
  // The feed (left) is the incidents view (scoped), NOT the operations full-page overlay.
  await expect(page.locator('#view-incidents')).toBeVisible();
  // Canonical URL became #/incidents;op=op-a (replaceState).
  await expect.poll(() => page.evaluate(() => location.hash)).toContain('op=op-a');
  await page.locator('#detail-panel').screenshot({ path: 'test-results/op-summary-panel.png' });
});
