/**
 * Dashboard — unified notification shell (Jun 2026).
 *
 * The new-incident bell used to live in the Operations command-bar, which the
 * router hides on every other route — so a user on Home/Exports/etc. had no
 * visibility of incoming reports. The notification bell now lives in the global
 * Command Center shell (#crisp-globalnav), so it is present on EVERY surface,
 * backed by the single _unseenReports source (counts synced, no duplicates).
 * The Home route also surfaces a "new incidents" alert, and notifications +
 * panel shortcuts deep-link into the relevant operational queue / incident.
 *
 * Fully stubbed (token + all /api/v1) like 30-crisis-intel-landing — no backend.
 */
import { test, expect, Page } from '@playwright/test';

const SUMMARY = {
  generated_at: new Date().toISOString(), window_hours: 24, stale_hours: 24, total_reports: 5,
  counts: {
    active: 5, critical: 1, pending_verification: 2, awaiting_triage: 2,
    open_dispatch: 0, resolved_in_window: 0, active_ops: 0, escalating: 0, stale: 0, sla_at_risk: 1,
  },
  distributions: { by_severity: { CRITICAL: 1, MODERATE: 4 }, by_crisis_type: { FLOOD: 5 }, verified: 1, unverified: 4 },
  timings: { avg_verification_seconds: 600, avg_response_seconds: 900 },
  impact: { critical_infrastructure: 1, lives_impacted_sum: 3, responders_active: 0, service_disruptions: 0 },
  deltas: { reports_24h: 0, reports_prev_24h: 0, reports_7d: 0, reports_prev_7d: 0 },
};

function reportRow(id: string, severity = 'CRITICAL') {
  return {
    id, severity, status: 'PENDING', crisis_type: 'FLOOD', infrastructure_type: 'HOSPITAL',
    reviewer_verdict: 'NOT_REVIEWED', source: 'APP', server_created_at: new Date().toISOString(),
    location: { latitude: 25.6, longitude: 85.1, user_location_name: 'Patna, IN' },
  };
}

test.describe('Dashboard — unified notification shell', () => {
  // Mutable across a test so an injected report is picked up by the live poller.
  let reportsBody = '[]';
  let total = '0';

  async function boot(page: Page, role = 'ADMIN') {
    reportsBody = '[]';
    total = '0';
    await page.addInitScript((r) => {
      localStorage.setItem('crisp_token', 'e2e-fake-token');
      localStorage.setItem('crisp_user', JSON.stringify({ role: r, email: 'ops@undp.org', full_name: 'Ops Lead' }));
      localStorage.setItem('crisp_router_force_root', '1');   // land on the Home root, not the automation feed
    }, role);
    await page.route('**/api/v1/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/analytics/summary')) return route.fulfill({ json: SUMMARY });
      if (url.includes('/analytics/damage-rate-24h')) return route.fulfill({ json: { buckets: [] } });
      if (url.includes('/reports/nearby')) return route.fulfill({ json: { groups: [] } });
      if (url.includes('/config/')) return route.fulfill({ json: { org: { org_public_name: 'UNDP CRISP' } } });
      // listing endpoint: /reports/ or /reports/?…  (ETag changes every call → never 304 → new ids detected)
      if (/\/api\/v1\/reports\/?(\?|$)/.test(url)) {
        return route.fulfill({
          status: 200,
          headers: {
            'content-type': 'application/json',
            'access-control-allow-origin': '*',
            'access-control-expose-headers': 'X-Total-Count, X-Server-Time, ETag',
            'X-Total-Count': total,
            'X-Server-Time': new Date().toISOString(),
            'ETag': `"nt-${Date.now()}-${Math.round(Math.random() * 1e9)}"`,
          },
          body: reportsBody,
        });
      }
      if (url.includes('/api/v1/reports/')) return route.fulfill({ status: 200, json: {} });   // single report / sub-resource
      return route.fulfill({ status: 200, json: {} });
    });
    await page.goto('index.html');
    await page.waitForFunction(
      () => typeof (window as any).__crispNotifDebug === 'function'
        && (window as any).__crispNotifDebug().initialLoadDone === true,
      null, { timeout: 15000 },
    );
    await expect(page.locator('#crisp-globalnav')).toBeVisible({ timeout: 6000 });
  }

  test('@smoke the bell lives in the global shell — one source, present everywhere', async ({ page }) => {
    await boot(page);
    await expect(page.locator('#crisp-globalnav #notif-area')).toHaveCount(1);
    await expect(page.locator('#crisp-globalnav #notif-bell')).toBeVisible();
    await expect(page.locator('#notif-area')).toHaveCount(1);   // exactly one in the whole document → no duplicates
    expect(await page.evaluate(() => typeof (window as any).__crispNotifSummary)).toBe('function');
  });

  test('@smoke panel opens on Home AND over the Exports overlay (stacked above it)', async ({ page }) => {
    await boot(page);
    await expect(page).toHaveURL(/#\/$/);
    // Home
    await page.locator('#crisp-globalnav #notif-bell').click();
    await expect(page.locator('#notif-panel')).toBeVisible();
    await page.locator('#crisp-globalnav #notif-bell').click();   // close
    // Exports overlay open — the panel must still open and render ABOVE the overlay
    await page.evaluate(() => (window as any).__crispRouter.navigate('/exports'));
    await expect(page.locator('#cc-ex-overlay.cc-ex-open')).toBeVisible({ timeout: 5000 });
    await page.locator('#crisp-globalnav #notif-bell').click();
    await expect(page.locator('#notif-panel')).toBeVisible();
    const onTop = await page.evaluate(() => {
      const p = document.getElementById('notif-panel')!;
      const r = p.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 10);
      return !!(hit && p.contains(hit));
    });
    expect(onTop, 'notif panel must stack above the Exports overlay').toBe(true);
  });

  test('@smoke a new incident surfaces on Home (count + alert) and deep-links to Operations', async ({ page }) => {
    await boot(page);
    await expect(page).toHaveURL(/#\/$/);
    // Inject a brand-new CRITICAL incident; the always-on poller picks it up.
    reportsBody = JSON.stringify([reportRow('notif-shell-1', 'CRITICAL')]);
    total = '1';
    // Bell count updates even though we're on Home (single source).
    await expect(page.locator('#crisp-globalnav #notif-count')).toHaveText('1', { timeout: 12000 });
    // Home "new incidents" alert appears and flags the critical arrival.
    await expect(page.locator('#cgn-home-alert.show')).toBeVisible();
    await expect(page.locator('#cgn-home-alert')).toContainText(/critical incident received/i);
    // Clicking the notification deep-links to Operations and reveals the feed.
    await page.locator('#crisp-globalnav #notif-bell').click();
    await expect(page.locator('#notif-panel .notif-card')).toHaveCount(1);
    await page.locator('#notif-panel .notif-card').first().click();
    await expect(page).toHaveURL(/#\/incidents/);
    await expect(page.locator('#view-incidents')).toBeVisible();
  });

  test('@smoke panel queue shortcut deep-links into the verification queue', async ({ page }) => {
    await boot(page);
    await page.locator('#crisp-globalnav #notif-bell').click();
    await expect(page.locator('#notif-panel')).toBeVisible();
    await page.locator('.notif-panel-footer button', { hasText: 'Verification' }).click();
    await expect(page).toHaveURL(/queue=verification/);
    await expect(page.locator('#view-incidents')).toBeVisible();
  });

  // Operations redesign v2 — every incident notification names its operation
  // (or "Global"), on the center-screen card AND in the bell panel.
  test('@smoke a new incident names its operation on the card + in the bell', async ({ page }) => {
    await boot(page);
    reportsBody = JSON.stringify([
      { ...reportRow('notif-op-1', 'CRITICAL'), crisis_event_id: 'op-x', crisis_event_name: 'Bihar Floods' },
    ]);
    total = '1';
    // the on-screen incident card names the operation
    await expect(page.locator('#notif-stack .notif-flash-op')).toContainText('Bihar Floods', { timeout: 12000 });
    // and it persists in the bell panel
    await page.locator('#crisp-globalnav #notif-bell').click();
    await expect(page.locator('#notif-panel .notif-card .notif-op')).toContainText('Bihar Floods');
  });

  test('@smoke a global incident (no operation) is labelled Global', async ({ page }) => {
    await boot(page);
    reportsBody = JSON.stringify([
      { ...reportRow('notif-glob-1', 'MODERATE'), crisis_event_id: null, crisis_event_name: null },
    ]);
    total = '1';
    await expect(page.locator('#notif-stack .notif-flash-op.global')).toContainText('Global', { timeout: 12000 });
  });
});
