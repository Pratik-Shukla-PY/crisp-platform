/**
 * Dashboard V4 field parity — regression spec for Phase 1.6.
 *
 * Audit critical-finding #3 (May 2026): the dashboard was months behind
 * the PWA on V4 fields. `water_status` / `debris_present` /
 * `pressing_needs` / `reporter_tier` were all stored in Postgres but
 * NEVER rendered on the dashboard's report detail. UNDP evaluators
 * look at the dashboard — so these fields MUST surface.
 *
 * This spec pins:
 *   1. service_status (electricity/water/health) renders with the full
 *      UNDP Appendix-1 enum coverage (OPERATIONAL / DISRUPTED /
 *      DESTROYED + INTERMITTENT / LOAD_SHEDDING / BLACKOUT for power
 *      + FULLY_OPERATIONAL / PARTIALLY_OPERATIONAL / NOT_OPERATIONAL
 *      for health).
 *   2. pressing_needs codes are humanized (`food_water` → "Food & water").
 *   3. reporter_tier emoji-label badge renders when the report's device
 *      has earned a V4 tier (T1_SCOUT / T2_SIGNAL / T3_CHANGEMAKER /
 *      T4_LIFEKEEPER).
 *   4. Reports without a tier (anonymous / pre-gamification / legacy
 *      badge_level) DO NOT render a tier badge — null is null, not
 *      "T1_SCOUT by default".
 *
 * This spec talks to the live backend at `localhost:8000` and the
 * dashboard at `localhost:8080/dashboard`. Both must be running.
 */
import { test, expect, type Page } from '@playwright/test';
import { ensureAdminAndLogin } from '../helpers/api';

async function loginToDashboard(page: Page, token: string) {
  await page.goto('index.html');
  await page.evaluate((t: string) => {
    localStorage.setItem('crisp_token', t);
    localStorage.setItem('crisp_user', JSON.stringify({
      email: 'e2e-admin@crisp.test', role: 'SUPER_ADMIN', full_name: 'E2E Admin',
    }));
  }, token);
  await page.reload();
  await expect(page.locator('#report-feed-list')).toBeVisible({ timeout: 15_000 });
}

test.describe('Dashboard V4 field parity (Phase 1.6)', () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    token = await ensureAdminAndLogin(request);
  });

  /**
   * Inject a synthetic report directly into window.allReports + open
   * its detail panel. Sidesteps the SW stale-while-revalidate cache
   * that would otherwise mask freshly-dispatched / freshly-seeded
   * rows within a single test. Round-trip wire coverage lives in the
   * backend pytest suite (TestReporterTierOnReportResponse).
   */
  async function injectAndOpen(
    page: Page,
    overrides: Record<string, any>,
  ): Promise<string> {
    const id = `synthetic-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    await page.evaluate(({ id, overrides }) => {
      (window as any).allReports = (window as any).allReports || [];
      (window as any).allReports.push({
        id,
        source: 'APP',
        status: 'PENDING',
        sync_status: 'SYNCED',
        severity: 'MODERATE',
        infrastructure_type: 'ROAD',
        expected_media: 0,
        received_media: 0,
        server_created_at: new Date().toISOString(),
        crisis_type: 'EARTHQUAKE',
        damage_classification: 'PARTIAL',
        reporter_tier: null,
        reporter_badge: null,
        service_status: null,
        media: [],
        location: { latitude: 12.97, longitude: 77.59 },
        ...overrides,
      });
    }, { id, overrides });
    await page.evaluate((id) => (window as any).selectReport(id, true), id);
    await expect(page.locator('#detail-panel')).toBeVisible({ timeout: 5_000 });
    return id;
  }

  test('renders all 3 legacy service_status chips (OPERATIONAL/DISRUPTED/DESTROYED)', async ({
    page,
  }) => {
    await loginToDashboard(page, token);
    await injectAndOpen(page, {
      service_status: {
        electricity: 'OPERATIONAL',
        water: 'DISRUPTED',
        health: 'DESTROYED',
        pressing_needs: [],
      },
    });

    const electricityChip = page.locator('#detail-panel .dp-svc-electricity').first();
    await expect(electricityChip).toBeVisible({ timeout: 5_000 });
    await expect(electricityChip).toHaveAttribute('data-value', 'OPERATIONAL');
    await expect(electricityChip).toContainText(/Operational/);

    const waterChip = page.locator('#detail-panel .dp-svc-water').first();
    await expect(waterChip).toHaveAttribute('data-value', 'DISRUPTED');
    await expect(waterChip).toContainText(/Disrupted/);

    const healthChip = page.locator('#detail-panel .dp-svc-health').first();
    await expect(healthChip).toHaveAttribute('data-value', 'DESTROYED');
    await expect(healthChip).toContainText(/Destroyed/);
  });

  test('renders UNDP Appendix-1 electricity expansions (INTERMITTENT/LOAD_SHEDDING/BLACKOUT)', async ({
    page,
  }) => {
    await loginToDashboard(page, token);

    for (const [value, label] of [
      ['INTERMITTENT',  /Intermittent/],
      ['LOAD_SHEDDING', /Load shedding/],
      ['BLACKOUT',      /Blackout/],
    ] as Array<[string, RegExp]>) {
      await injectAndOpen(page, {
        service_status: {
          electricity: value,
          water: 'UNKNOWN',
          health: 'UNKNOWN',
          pressing_needs: [],
        },
      });
      const chip = page.locator('#detail-panel .dp-svc-electricity').first();
      await expect(chip).toBeVisible({ timeout: 5_000 });
      await expect(chip).toHaveAttribute('data-value', value);
      await expect(chip).toContainText(label);
    }
  });

  test('renders UNDP Appendix-1 health expansions (FULLY/PARTIALLY/NOT_OPERATIONAL)', async ({
    page,
  }) => {
    await loginToDashboard(page, token);

    for (const [value, label] of [
      ['FULLY_OPERATIONAL',     /Fully operational/],
      ['PARTIALLY_OPERATIONAL', /Partially operational/],
      ['NOT_OPERATIONAL',       /Not operational/],
    ] as Array<[string, RegExp]>) {
      await injectAndOpen(page, {
        service_status: {
          electricity: 'UNKNOWN',
          water: 'UNKNOWN',
          health: value,
          pressing_needs: [],
        },
      });
      const chip = page.locator('#detail-panel .dp-svc-health').first();
      await expect(chip).toBeVisible({ timeout: 5_000 });
      await expect(chip).toHaveAttribute('data-value', value);
      await expect(chip).toContainText(label);
    }
  });

  test('humanizes pressing_needs codes (food_water → "Food & water")', async ({
    page,
  }) => {
    await loginToDashboard(page, token);
    await injectAndOpen(page, {
      service_status: {
        electricity: 'UNKNOWN',
        water: 'UNKNOWN',
        health: 'UNKNOWN',
        pressing_needs: ['food_water', 'medical', 'shelter'],
      },
    });
    const needsChip = page.locator('#detail-panel .dp-svc-needs').first();
    await expect(needsChip).toBeVisible({ timeout: 5_000 });
    await expect(needsChip).toHaveAttribute('data-needs', 'food_water,medical,shelter');
    await expect(needsChip).toContainText(/Food & water/);
    await expect(needsChip).toContainText(/Medical care/);
    await expect(needsChip).toContainText(/Shelter/);
  });

  test('reporter_tier badge renders for each V4 tier (synthetic-injected)', async ({
    page,
  }) => {
    // Synthetic injection avoids the SW stale-while-revalidate cache
    // race that breaks a round-trip dispatch-then-fetch flow inside a
    // single test. The renderer is the system-under-test here; the
    // round-trip (API → schema → listing) is covered by the backend
    // pytest suite (TestReporterTierOnReportResponse).
    await loginToDashboard(page, token);

    const labels: Record<string, RegExp> = {
      'T1_SCOUT':       /Scout/,
      'T2_SIGNAL':      /Signal/,
      'T3_CHANGEMAKER': /Changemaker/,
      'T4_LIFEKEEPER':  /Lifekeeper/,
    };

    for (const tier of ['T1_SCOUT', 'T2_SIGNAL', 'T3_CHANGEMAKER', 'T4_LIFEKEEPER']) {
      await injectAndOpen(page, {
        reporter_tier: tier,
        reporter_badge: 'User test1234',
        service_status: {
          electricity: 'OPERATIONAL', water: 'UNKNOWN', health: 'UNKNOWN', pressing_needs: [],
        },
      });
      const tierBadge = page.locator('#detail-panel .dp-reporter-tier').first();
      await expect(tierBadge).toBeVisible({ timeout: 5_000 });
      await expect(tierBadge).toHaveAttribute('data-tier', tier);
      await expect(tierBadge).toContainText(labels[tier]);
    }
  });

  test('reporter_tier badge ABSENT when API returns no reporter_tier on the report', async ({
    page,
  }) => {
    await loginToDashboard(page, token);
    await injectAndOpen(page, {
      reporter_tier: null,
      service_status: {
        electricity: 'OPERATIONAL', water: 'UNKNOWN', health: 'UNKNOWN', pressing_needs: [],
      },
    });
    // No reporter_tier badge anywhere in the open detail panel.
    const tierBadge = page.locator('#detail-panel .dp-reporter-tier');
    await expect(tierBadge).toHaveCount(0);
  });
});
