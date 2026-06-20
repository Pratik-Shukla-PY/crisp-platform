/**
 * Dashboard — Actions section (Jun 2026 simplification).
 *
 * The Actions section is now ONE state-aware primary + exactly two buttons:
 *   · "Notify Response Team" — one click always dispatches the response AND
 *     notifies the reporter's PWA (a dummy responder set; no selection modal),
 *     moving the incident to Active Response (RESPONDING).
 *   · "Reject" — confirm modal requiring a reason; rejected reports leave the
 *     active feed/queues and surface only under the Rejected view.
 *   · "Delete" — high-severity confirm modal requiring a reason.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { ADMIN } from '../helpers/api';

const B = 'http://localhost:8000';

async function login(page, request: APIRequestContext): Promise<string> {
  const res = await request.post(`${B}/api/v1/auth/login`, { data: { email: ADMIN.email, password: ADMIN.password } });
  const token = (await res.json()).access_token;
  await page.goto('index.html');
  await page.evaluate((t) => {
    localStorage.setItem('crisp_token', t);
    localStorage.setItem('crisp_user', JSON.stringify({ email: 'act@crisp.test', role: 'SUPER_ADMIN', full_name: 'Act' }));
  }, token);
  await page.reload();
  return token;
}

async function seed(request: APIRequestContext, token: string) {
  const res = await request.post(`${B}/api/v1/reports/meta`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: {
      device_hash: `ACT-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      client_report_id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      source: 'TELEGRAM', severity: 'CRITICAL', infrastructure_type: 'HOSPITAL', crisis_type: 'FLOOD',
      damage_classification: 'PARTIAL', expected_media: 0,
      location: { latitude: 12.97, longitude: 77.59, accuracy_meters: 12 },
    },
  });
  return (await res.json()).id;
}

async function openDetail(page, id: string) {
  await expect.poll(async () => {
    await page.evaluate(() => (window as any).__crispFetchReports && (window as any).__crispFetchReports()).catch(() => {});
    return page.evaluate((rid) => Array.isArray((window as any).allReports) && (window as any).allReports.some((r: any) => r.id === rid), id);
  }, { timeout: 20000, intervals: [500, 1000] }).toBe(true);
  await page.evaluate((rid) => (window as any).selectReport(rid), id);
  await expect(page.locator('#detail-panel')).toBeVisible();
}

test.describe('Actions section', () => {
  let token: string;
  test.beforeEach(async ({ page, request }) => { token = await login(page, request); });

  test('Notify Response Team — one click dispatches + moves to Active Response', async ({ page, request }) => {
    const id = await seed(request, token);
    await openDetail(page, id);
    // Exactly the simplified action set: one primary + Reject + Delete.
    await expect(page.locator('.dp-actions .dp-act-primary')).toHaveText(/Notify Response Team/);
    await expect(page.locator('.dp-act-reject')).toBeVisible();
    await expect(page.locator('.dp-act-delete')).toBeVisible();
    // Dropped controls are gone.
    await expect(page.locator('.dp-verdict-trigger')).toHaveCount(0);
    await expect(page.locator('.dp-resp-chip-action')).toHaveCount(0);
    await expect(page.locator('.dp-overflow-btn')).toHaveCount(0);

    await page.locator('.dp-act-respond').click();
    await expect.poll(() => page.evaluate((rid) => (window as any).allReports.find((r: any) => r.id === rid)?.status, id),
      { timeout: 8000 }).toBe('RESPONDING');

    await request.delete(`${B}/api/v1/reports/${id}?reason=cleanup`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  });

  test('Reject button requires a reason and moves the report to the Rejected view', async ({ page, request }) => {
    const id = await seed(request, token);
    await openDetail(page, id);
    await page.locator('.dp-act-reject').click();
    await expect(page.locator('.crisp-action-modal.crisp-action-warn')).toBeVisible();
    await page.locator('.crisp-action-confirm').click();    // empty reason blocked
    await expect(page.locator('#crisp-reject-reason.crisp-action-invalid')).toBeVisible();
    await page.locator('#crisp-reject-reason').fill('Duplicate of an existing incident');
    await page.locator('.crisp-action-confirm').click();
    await expect(page.locator('.crisp-action-overlay')).toHaveCount(0, { timeout: 8000 });
    await expect.poll(() => page.evaluate((rid) => (window as any).allReports.find((r: any) => r.id === rid)?.reviewer_verdict, id),
      { timeout: 8000 }).toBe('REJECTED');
    // Excluded from the default feed filter; present only in the 'rejected' queue.
    expect(await page.evaluate((rid) => { (window as any).setActiveQueue(null); return (window as any)._applyQueueFilter((window as any).allReports).some((r: any) => r.id === rid); }, id)).toBe(false);
    expect(await page.evaluate((rid) => { (window as any).setActiveQueue('rejected'); return (window as any)._applyQueueFilter((window as any).allReports).some((r: any) => r.id === rid); }, id)).toBe(true);
    await request.delete(`${B}/api/v1/reports/${id}?reason=cleanup`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  });

  test('Delete button is a high-severity confirm that requires a reason', async ({ page, request }) => {
    const id = await seed(request, token);
    await openDetail(page, id);
    await page.locator('.dp-act-delete').click();
    await expect(page.locator('.crisp-action-modal.crisp-action-danger')).toBeVisible();
    await expect(page.locator('.crisp-action-msg-danger')).toContainText(/permanent/i);
    await page.locator('.crisp-action-confirm').click();    // empty reason blocked
    await expect(page.locator('#crisp-delete-reason.crisp-action-invalid')).toBeVisible();
    await page.locator('#crisp-delete-reason').fill('Spam / test submission');
    await page.locator('.crisp-action-confirm').click();
    await expect(page.locator('.crisp-action-overlay')).toHaveCount(0, { timeout: 8000 });
    await expect.poll(() => page.evaluate((rid) => (window as any).allReports.some((r: any) => r.id === rid), id),
      { timeout: 8000 }).toBe(false);
  });
});
