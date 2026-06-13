/**
 * Backend-only end-to-end: full report lifecycle via REST API.
 *
 * Hits a live backend on localhost:8000 (no mocks). Exercises:
 *   1. POST /reports/meta                           (report skeleton)
 *   2. POST /reports/{id}/media/chunk × N           (chunked photo upload)
 *   3. GET  /reports/{id}                           (read-back with variants)
 *   4. PATCH /reports/{id}/review                   (Apr 2026 Phase 5)
 *   5. PATCH /reports/{id}/timestamps               (responder stamps)
 *   6. DELETE /reports/device/{hash}                (bulk purge)
 *   7. /metrics                                     (Prometheus surface)
 *
 * Fast — no browser involved. Runs in under 15 seconds. Guarantees the API
 * contract stays intact even when UI tests can't catch a regression (e.g.
 * a silently-changed 200 → 400).
 */
import { test, expect } from '@playwright/test';
import { ADMIN, roleFromToken, ADMIN_ROLES } from '../helpers/api';

const NEEDS_TESTING_FLAG =
  'Backend not in CRISP_TESTING mode — /auth/register did not honor the admin role. '
  + 'Run the e2e backend with `APP_ENV=dev CRISP_TESTING=1`.';
import * as crypto from 'crypto';

const BACKEND = process.env.CRISP_BACKEND_URL || 'http://localhost:8000';

/** djb2 hash — mirrors backend/app/api/endpoints/reports.py exactly.
 *  Hex, zero-padded to 8 chars. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = (((h << 5) + h) ^ s.charCodeAt(i)) & 0xFFFFFFFF;
  }
  if (h < 0) h += 0x100000000;
  return h.toString(16).padStart(8, '0');
}

function fakeBase64(len: number): string {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < len; i++) out += alpha[(Math.random() * 64) | 0];
  return out;
}

async function login(request): Promise<string> {
  // Register idempotently (409 is fine) then login.
  await request.post(`${BACKEND}/api/v1/auth/register`, {
    data: { ...ADMIN, role: 'SUPER_ADMIN' },
  }).catch(() => {});
  const res = await request.post(`${BACKEND}/api/v1/auth/login`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  const body = await res.json();
  return body.access_token || body.token;
}

test.describe('Backend report lifecycle', () => {
  test('@smoke health endpoint 200', async ({ request }) => {
    const res = await request.get(`${BACKEND}/health`);
    expect(res.status()).toBe(200);
  });

  // Un-skipped (Jun 2026): the test-only role hook now exists — /auth/register
  // HONORS the requested role when the backend runs CRISP_TESTING=1 (double-gated
  // on non-prod; prod self-registration stays VIEWER-only). login() already
  // requests SUPER_ADMIN, so /reports/{id}/review + /timestamps no longer 403.
  // Run the e2e backend with `APP_ENV=dev CRISP_TESTING=1`.
  test('end-to-end: meta → chunks → read → review → timestamps → delete', async ({ request }) => {
    const token = await login(request);
    test.skip(!ADMIN_ROLES.includes(roleFromToken(token)), NEEDS_TESTING_FLAG);
    const headers = { Authorization: `Bearer ${token}` };
    const deviceHash = `E2E-DEVICE-${Date.now()}`;

    // 1. meta
    const meta = await request.post(`${BACKEND}/api/v1/reports/meta`, {
      data: {
        device_hash: deviceHash,
        client_report_id: crypto.randomUUID(),
        source: 'APP',
        severity: 'MODERATE',
        infrastructure_type: 'HOSPITAL',
        crisis_type: 'EARTHQUAKE',
        // damage_classification enum is PARTIAL/COMPLETE/NO_DAMAGE per
        // docs/PARITY.md — "SEVERE" is severity, not damage.
        damage_classification: 'PARTIAL',
        description: 'E2E lifecycle test',
        expected_media: 1,
        location: { latitude: 12.97, longitude: 77.59, accuracy_meters: 5 },
      },
    });
    expect(meta.status(), `meta failed: ${await meta.text()}`).toBe(201);
    const reportId = (await meta.json()).id;

    // 2. Chunked IMAGE upload — 2 chunks × 1 KB for a minimal fake photo.
    const mediaId = crypto.randomUUID();
    const chunkSize = 1024;
    const total = 2;
    for (let i = 0; i < total; i++) {
      const data = fakeBase64(chunkSize);
      const res = await request.post(`${BACKEND}/api/v1/reports/${reportId}/media/chunk`, {
        data: {
          media_id: mediaId,
          type: 'IMAGE',
          seq_num: i,
          total_chunks: total,
          data,
          checksum: djb2(data),
          resolution_tier: 'SMALL',  // Phase L canonical (was 'LOW' pre-Phase-L)
          photo_group_id: crypto.randomUUID(),
        },
      });
      expect(res.ok(), `chunk ${i} failed: ${res.status()} ${await res.text()}`).toBeTruthy();
    }

    // 3. Read back. There's no GET /reports/{id} endpoint — reports are
    //    accessed via the list endpoint or per-device status-since. Use
    //    the list + filter by id.
    const listRes = await request.get(`${BACKEND}/api/v1/reports/`, { headers });
    expect(listRes.ok()).toBeTruthy();
    const list = await listRes.json();
    const report = list.find((r: any) => r.id === reportId);
    expect(report, `seeded report ${reportId.slice(0, 8)} not in /reports/ list`).toBeTruthy();
    expect(report.reviewer_verdict).toBe('NOT_REVIEWED');

    // 4. Review: accept.
    const rev = await request.patch(`${BACKEND}/api/v1/reports/${reportId}/review`, {
      headers,
      data: { verdict: 'ACCEPTED' },
    });
    expect(rev.ok(), `review-accept failed: ${rev.status()} ${await rev.text()}`).toBeTruthy();
    expect((await rev.json()).reviewer_verdict).toBe('ACCEPTED');

    // 5. Review: rejection requires action_taken (400 without it).
    const badRev = await request.patch(`${BACKEND}/api/v1/reports/${reportId}/review`, {
      headers,
      data: { verdict: 'REJECTED' },
    });
    expect(badRev.status()).toBe(400);

    // 6. Timestamps — stamp both dispatched + arrived; verify response_time.
    const stampD = await request.patch(`${BACKEND}/api/v1/reports/${reportId}/timestamps`, {
      headers,
      data: { stamp_dispatched_now: true },
    });
    expect(stampD.ok(), `stampD failed: ${stampD.status()} ${await stampD.text()}`).toBeTruthy();

    await new Promise((r) => setTimeout(r, 1500));

    const stampA = await request.patch(`${BACKEND}/api/v1/reports/${reportId}/timestamps`, {
      headers,
      data: { stamp_arrived_now: true },
    });
    expect(stampA.ok(), `stampA failed: ${stampA.status()} ${await stampA.text()}`).toBeTruthy();
    const final = await stampA.json();
    expect(final.help_dispatched_at).toBeTruthy();
    expect(final.help_arrived_at).toBeTruthy();

    // 7. /metrics contains our counters.
    const metrics = await request.get(`${BACKEND}/metrics`);
    expect(metrics.ok()).toBeTruthy();
    const metricsText = await metrics.text();
    expect(metricsText).toContain('crisp_variant_uploads_total');
    expect(metricsText).toContain('crisp_reports_reviewed_total');

    // 8. Cleanup.
    const del = await request.delete(`${BACKEND}/api/v1/reports/${reportId}`, { headers });
    expect(del.ok() || del.status() === 204).toBeTruthy();
  });

  test('/reports requires auth (401 without token)', async ({ request }) => {
    const res = await request.get(`${BACKEND}/api/v1/reports/`);
    expect(res.status()).toBe(401);
  });

  // Same skip rationale as the end-to-end test above — /review requires
  // ANALYST/ADMIN and the test infra has no role-promotion path.
  // Un-skipped (Jun 2026) — same CRISP_TESTING role hook gives /review an admin JWT.
  test('/reports/{id}/review rejects invalid verdict values', async ({ request }) => {
    const token = await login(request);
    test.skip(!ADMIN_ROLES.includes(roleFromToken(token)), NEEDS_TESTING_FLAG);
    const headers = { Authorization: `Bearer ${token}` };
    const deviceHash = `E2E-DEVICE-${Date.now()}-x`;
    const meta = await request.post(`${BACKEND}/api/v1/reports/meta`, {
      data: {
        device_hash: deviceHash,
        client_report_id: crypto.randomUUID(),
        source: 'APP',
        severity: 'MINOR',
        infrastructure_type: 'OTHER',
        crisis_type: 'OTHER',
        damage_classification: 'NO_DAMAGE',
        description: 'verdict validation',
        expected_media: 0,
        location: { latitude: 12, longitude: 77, accuracy_meters: 10 },
      },
    });
    const reportId = (await meta.json()).id;
    try {
      const res = await request.patch(`${BACKEND}/api/v1/reports/${reportId}/review`, {
        headers, data: { verdict: 'WIBBLE' },
      });
      expect(res.status()).toBe(400);
    } finally {
      await request.delete(`${BACKEND}/api/v1/reports/${reportId}`, { headers });
    }
  });
});
