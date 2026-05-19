/**
 * Hotfix (Apr 2026) — "In Flight" list shouldn't keep reports the server
 * already has.
 *
 * Regression guard for a real user-reported bug: a report reached the
 * backend (visible on the dashboard) but the PWA's My Reports screen
 * still showed it as 50% / Queued in the "In Flight" section — because
 * one of the four stage flags (`meta`/`text`/`photo`/`audio`) never
 * flipped to true even though the corresponding upload succeeded. The
 * client was stuck on stale IDB state with no recovery path.
 *
 * Fix: `_reconcileQueueAgainstServer()` dequeues any IDB entry whose
 * `client_report_id` appears in the server's status-since response
 * (with a safety check on `expected_media` so mid-upload items aren't
 * prematurely dequeued).
 *
 * End-to-end flow:
 *   1. Seed the server with a real report (via API) using a known
 *      client_report_id + device_hash.
 *   2. Seed the client's IDB queue with a stuck in-flight entry that
 *      uses the SAME client_report_id but with stages.photo=false
 *      (the "would otherwise be stuck forever" state).
 *   3. Open My Reports → reconcile runs → the in-flight entry vanishes.
 *   4. Verify: IDB queue no longer contains that client_report_id AND
 *      the UI shows the "Nothing in flight" empty state.
 */
import { test, expect, APIRequestContext } from '@playwright/test';
import { ADMIN, ensureAdminAndLogin } from '../helpers/api';

const BACKEND = process.env.CRISP_BACKEND_URL || 'http://localhost:8000';

async function seedServerReport(
  request: APIRequestContext,
  deviceHash: string,
  clientReportId: string,
  opts: { description?: string } = {}
) {
  const token = await ensureAdminAndLogin(request);
  const meta = await request.post(`${BACKEND}/api/v1/reports/meta`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      device_hash: deviceHash,
      client_report_id: clientReportId,
      source: 'APP',
      severity: 'MODERATE',
      infrastructure_type: 'HOSPITAL',
      crisis_type: 'WILDFIRE',
      damage_classification: 'PARTIAL',
      description: opts.description || 'Reconcile test — server has it.',
      // expected_media=0 so reconcile treats the server row as complete
      // without needing any media uploads.
      expected_media: 0,
      location: { latitude: 12.9716, longitude: 77.5946, accuracy_meters: 10 },
    },
  });
  expect(meta.status(), `meta failed: ${await meta.text()}`).toBe(201);
  return (await meta.json()).id;
}

async function cleanup(request: APIRequestContext, deviceHash: string) {
  await request.delete(`${BACKEND}/api/v1/reports/device/${deviceHash}`).catch(() => {});
}

test.describe('PWA My Reports — in-flight reconcile hotfix', () => {
  let deviceHash: string;

  test.beforeEach(async ({ page }) => {
    deviceHash = `E2E-RECONCILE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    await page.goto('index.html');
    await page.evaluate((hash) => {
      localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');  // Pre-v4 tests target the v3 capture flow.
      // PRIMARY device-id key (v6.8+) — _deviceHashForHistory + the
      // reconcile fetch both read this first. The legacy keys are
      // defensive fallbacks; without v2 the reconcile uses a
      // different (auto-generated) hash + status-since returns 0
      // reports for THIS test's seeded one.
      localStorage.setItem('crisp_device_id_v2', hash);
      localStorage.setItem('crisp_device_hash', hash);
      localStorage.setItem('crisp_device_id', hash);
    }, deviceHash);
    await page.reload();
    const enBtn = page.locator('#btn-lang-en');
    if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
    await page.evaluate(() => {
      const c = document.getElementById('consent-overlay');
      if (c) c.style.display = 'none';
    });
  });

  test.afterEach(async ({ request }) => {
    if (deviceHash) await cleanup(request, deviceHash);
  });

  test('@smoke reconcile dequeues a stuck in-flight entry when server has the report', async ({ page, request }) => {
    const clientReportId = `e2e-stuck-${Date.now()}`;

    // 1. Seed the server with the report.
    const serverId = await seedServerReport(request, deviceHash, clientReportId);

    // 2. Seed the client IDB queue with a "stuck" entry — meta true, photo
    //    still false (the shape that previously rendered at 50% forever).
    await page.evaluate(async ({ cid, sid, hash }) => {
      await (window as any).__crispEnqueueReport({
        client_report_id: cid,
        serverId: sid,
        meta: {
          client_report_id: cid,
          device_hash: hash,
          source: 'APP',
          severity: 'MODERATE',
          infrastructure_type: 'HOSPITAL',
          crisis_type: 'WILDFIRE',
          damage_classification: 'PARTIAL',
          description: 'Reconcile test — server has it.',
          expected_media: 0,
        },
        photo: null,
        photoSize: 0,
        extraPhotos: [],
        audioBlob: null,
        audioSize: 0,
        text: 'Reconcile test — server has it.',
        // The shape that reproduced the bug: photo flag stuck false
        // even though the server reported receiving the report.
        stages: { meta: true, text: true, photo: false, audio: true },
      });
    }, { cid: clientReportId, sid: serverId, hash: deviceHash });

    // Sanity: entry is in IDB before reconcile.
    const beforeCount = await page.evaluate(async (cid) => {
      const queued = await (window as any).__crispGetAllQueued();
      return queued.filter((q: any) => q.client_report_id === cid).length;
    }, clientReportId);
    expect(beforeCount).toBe(1);

    // 3. Open My Reports — reconcile runs as part of openMyReports().
    await page.locator('#btn-my-reports').click();
    await expect(page.locator('#stage-history.active')).toBeVisible();

    // Reconcile is async; give it a moment to finish the fetch + dequeue.
    await page.waitForFunction(async (cid) => {
      const queued = await (window as any).__crispGetAllQueued();
      return queued.filter((q: any) => q.client_report_id === cid).length === 0;
    }, clientReportId, { timeout: 10_000 });

    // 4. Verify: in-flight list is empty (no stuck card). v6.8 (May
    //    2026) changed empty-state behaviour: instead of rendering
    //    `.history-empty` inside `#history-partial-list`, the renderer
    //    HIDES the entire `#history-inflight-section` and clears the
    //    list innerHTML. The dequeue happens async AFTER the initial
    //    history-stage render, so we need to force a re-render before
    //    asserting the list is clear.
    await page.evaluate(async () => {
      const r = (window as any).__crispRenderPartialReports;
      if (typeof r === 'function') await r();
    });
    await expect(page.locator('#history-partial-list')).toBeEmpty();
    // And the submitted list shows the server-authoritative report.
    await expect(page.locator('#history-synced-list .mr-card').first()).toBeVisible({ timeout: 10_000 });
  });

  test('reconcile KEEPS queued entries with incomplete media (no premature dequeue)', async ({ page, request }) => {
    // Safety test — the reconcile must NOT dequeue when the server has the
    // report row but still hasn't received all expected media. Otherwise
    // we'd abandon mid-upload items and lose photos/audio.
    const clientReportId = `e2e-partial-${Date.now()}`;
    const serverId = await seedServerReport(request, deviceHash, clientReportId);

    await page.evaluate(async ({ cid, sid, hash }) => {
      await (window as any).__crispEnqueueReport({
        client_report_id: cid,
        serverId: sid,
        meta: {
          client_report_id: cid,
          device_hash: hash,
          source: 'APP',
          severity: 'MODERATE',
          infrastructure_type: 'HOUSE',
          crisis_type: 'FLOOD',
          damage_classification: 'COMPLETE',
          description: 'Partial-upload test',
          // Client expected 3 media rows but server currently has 0 — this
          // entry is genuinely still in-flight and must stay queued.
          expected_media: 3,
        },
        photo: 'data:image/jpeg;base64,AAAA',
        photoSize: 1000,
        extraPhotos: [],
        audioBlob: null,
        audioSize: 0,
        text: 'Partial-upload test',
        stages: { meta: true, text: true, photo: false, audio: true },
      });
    }, { cid: clientReportId, sid: serverId, hash: deviceHash });

    await page.evaluate(() => (window as any).__crispReconcileQueue());

    const stillQueued = await page.evaluate(async (cid) => {
      const queued = await (window as any).__crispGetAllQueued();
      return queued.filter((q: any) => q.client_report_id === cid).length;
    }, clientReportId);
    expect(stillQueued).toBe(1);
  });
});
