/**
 * Dashboard — unified incident routing + deep-linking (CrispNav).
 *
 * Every incident click anywhere must: route to the right context (the incident's
 * OPERATION if it has one, else GLOBAL), auto-open the detail, write a
 * deep-linkable #…?incident=<id> URL, and survive refresh / Back / Forward.
 *
 * Fully stubbed (token + every /api/v1 call) like 34/35/36 — no backend.
 */
import { test, expect, Page } from '@playwright/test';

const NOW = new Date().toISOString();

// A report op-linked to op-a, and a global one (no operation).
function report(id: string, crisisEventId: string | null) {
  return {
    id, severity: 'CRITICAL', status: 'PENDING', sync_status: 'SYNCED',
    crisis_type: 'FLOOD', infrastructure_type: 'HOSPITAL', reviewer_verdict: 'NOT_REVIEWED',
    source: 'APP', server_created_at: NOW, created_at: NOW, updated_at: NOW,
    description: 'deep-link test', media: [], crisis_event_id: crisisEventId,
    crisis_event_name: crisisEventId ? 'Bihar Floods' : null,
    location: { latitude: 25.6, longitude: 85.1, user_location_name: 'Patna, IN' },
  };
}
const R_OP = report('rid-op', 'op-a');
const R_GLOBAL = report('rid-global', null);

const OPERATIONS = [
  { id: 'op-a', name: 'Bihar Floods', crisis_type: 'FLOOD', status: 'LIVE', is_active: true,
    center_lat: 25.6, center_lng: 85.1, radius_km: 22, place_name: 'Patna', critical: 1, new_24h: 1,
    total: 1, verified: 0, is_cluster: false, health: 'RED', health_reason: '1 critical', responders_active: 0 },
];

async function boot(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('crisp_token', 'e2e-fake-token');
    localStorage.setItem('crisp_user', JSON.stringify({ role: 'ADMIN', email: 'ops@undp.org', full_name: 'Ops Lead' }));
    localStorage.setItem('crisp_router_force_root', '1');
  });
  await page.route('**/api/v1/**', async (route) => {
    const u = route.request().url();
    if (u.includes('/analytics/summary')) return route.fulfill({ json: { generated_at: NOW, counts: { critical: 1 }, distributions: { by_severity: {}, by_crisis_type: {}, by_status: {} }, timings: {}, impact: {}, deltas: {} } });
    if (u.includes('/analytics/')) return route.fulfill({ json: { buckets: [] } });
    if (u.includes('/operations/form-templates')) return route.fulfill({ json: [] });
    if (u.includes('/operations')) return route.fulfill({ json: OPERATIONS });
    if (u.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
    if (u.includes('/reports/nearby')) return route.fulfill({ json: { groups: [] } });
    if (u.includes('/reports/markers')) return route.fulfill({ json: [] });
    // The report listing — scoped (op) and unscoped (global) both return our two rows.
    if (/\/api\/v1\/reports\/?(\?|$)/.test(u)) {
      const scoped = u.includes('crisis_event_id=op-a');
      const body = scoped ? [R_OP] : [R_OP, R_GLOBAL];
      return route.fulfill({
        status: 200,
        headers: { 'content-type': 'application/json', 'access-control-expose-headers': 'X-Total-Count, X-Server-Time, ETag', 'X-Total-Count': String(body.length), 'X-Server-Time': NOW, 'ETag': `"dl-${Date.now()}-${Math.round(Math.random() * 1e9)}"` },
        body: JSON.stringify(body),
      });
    }
    if (u.includes('/api/v1/reports/')) return route.fulfill({ status: 200, json: {} });
    return route.fulfill({ status: 200, json: {} });
  });
}

const hash = (page: Page) => page.evaluate(() => location.hash);

test.describe('Incident routing + deep-linking (CrispNav)', () => {
  test('router parseHash round-trips ?incident= and builds the right URLs', async ({ page }) => {
    await boot(page);
    await page.goto('index.html');
    await page.waitForFunction(() => !!(window as any).__crispRouter && !!(window as any).CrispNav, null, { timeout: 10000 });
    const r = await page.evaluate(() => {
      const R = (window as any).__crispRouter;
      // parse a deep-link hash
      location.hash = '#/operations/op-x?incident=rid-1';
      const p = R.parseHash();
      return { route: p.route, opId: p.params.id, incident: p.query.incident };
    });
    expect(r.route).toBe('/operations');
    expect(r.opId).toBe('op-x');
    expect(r.incident).toBe('rid-1');
  });

  test('@smoke global incident → #/incidents?incident=<id> + detail opens', async ({ page }) => {
    await boot(page);
    await page.goto('index.html#/incidents');
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.some((r: any) => r.id === 'rid-global'), null, { timeout: 12000 });
    await page.evaluate(() => (window as any).openIncident('rid-global'));
    await expect.poll(() => hash(page)).toContain('/incidents?incident=rid-global');
    await expect(page.locator('#detail-panel')).toBeVisible();
  });

  test('@smoke operation incident → #/operations/{op}?incident=<id> (stays in op) + detail opens', async ({ page }) => {
    await boot(page);
    await page.goto('index.html#/incidents');
    await page.waitForFunction(() => !!(window as any).CrispNav, null, { timeout: 10000 });
    // op-linked report — resolves its operation from crisis_event_id and switches context.
    await page.evaluate(() => (window as any).openIncident('rid-op', { operationId: 'op-a' }));
    await expect.poll(() => hash(page)).toContain('/operations/op-a?incident=rid-op');
    await expect(page.locator('#cc-ops-overlay.cc-ops-open')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 8000 });
  });

  test('@smoke cold-load deep-link reopens the detail (refresh survival)', async ({ page }) => {
    await boot(page);
    await page.goto('index.html#/incidents?incident=rid-global');
    await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 12000 });
    expect(await hash(page)).toContain('incident=rid-global');
  });

  test('@smoke Back closes the detail; Forward reopens it', async ({ page }) => {
    await boot(page);
    await page.goto('index.html#/incidents');
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 12000 });
    await page.evaluate(() => (window as any).openIncident('rid-global'));
    await expect(page.locator('#detail-panel')).toBeVisible();
    await expect.poll(() => hash(page)).toContain('incident=rid-global');
    // Back → detail closes, seg gone
    await page.goBack();
    await expect(page.locator('#detail-panel')).toBeHidden({ timeout: 6000 });
    expect(await hash(page)).not.toContain('incident=');
    // Forward → detail reopens
    await page.goForward();
    await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 6000 });
    expect(await hash(page)).toContain('incident=rid-global');
  });

  test('✕ close clears ?incident= without leaving a dangling history entry', async ({ page }) => {
    await boot(page);
    await page.goto('index.html#/incidents');
    await page.waitForFunction(() => Array.isArray((window as any).allReports) && (window as any).allReports.length > 0, null, { timeout: 12000 });
    await page.evaluate(() => (window as any).openIncident('rid-global'));
    await expect(page.locator('#detail-panel')).toBeVisible();
    await page.evaluate(() => (window as any).closeDetail());
    await expect(page.locator('#detail-panel')).toBeHidden();
    expect(await hash(page)).not.toContain('incident=');
  });
});
