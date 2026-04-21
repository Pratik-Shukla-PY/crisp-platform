/**
 * Test helpers that talk directly to the CRISP backend API.
 * Used for seeding state (admin user, regions) and asserting post-conditions
 * (the report we just submitted via the UI actually landed on the server).
 */
import { APIRequestContext, expect } from '@playwright/test';

const BACKEND = process.env.CRISP_BACKEND_URL || 'http://localhost:8000';

/** Seed admin credentials — deterministic so tests can repeatedly log in
 *  without spamming the users table. Password must satisfy the backend's
 *  complexity rules (see backend/app/core/security.py). */
// `.test` is a reserved TLD that Pydantic's EmailStr validator rejects
// (reason: 'special-use or reserved name'). Use `.org` on a clearly
// test-only subdomain instead.
export const ADMIN = {
  email: 'e2e-admin@crisp-e2e-tests.org',
  password: 'E2eAdmin!2026',
  full_name: 'E2E Admin',
};

/** Idempotent: tries to register; if 409 (already exists) just logs in.
 *  Returns the access token — every further admin-scoped call should
 *  thread it through as a Bearer header. */
export async function ensureAdminAndLogin(request: APIRequestContext): Promise<string> {
  // 1) register — ok if it 409's.
  await request.post(`${BACKEND}/api/v1/auth/register`, {
    data: { ...ADMIN, role: 'SUPER_ADMIN' },
  }).catch(() => {});
  // 2) login.
  const res = await request.post(`${BACKEND}/api/v1/auth/login`, {
    data: { email: ADMIN.email, password: ADMIN.password },
  });
  // Some deployments enforce admin-approval before first login — we promote
  // automatically via the bootstrap SUPER_ADMIN env if present; in CI we
  // just need *a* login. If this assertion fires, the backend rejected the
  // test user — check JWT_SECRET + DB migrations.
  expect(res.ok(), `Login failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  const body = await res.json();
  return body.access_token || body.token;
}

/** Delete every auto-submit region created by previous test runs so each
 *  suite starts from a clean slate. Safe: only deletes rows whose name
 *  starts with "E2E ". */
export async function cleanupTestRegions(request: APIRequestContext, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const list = await request.get(`${BACKEND}/api/v1/admin/regions`, { headers });
  if (!list.ok()) return;
  const regions = await list.json();
  for (const r of regions) {
    if (typeof r.name === 'string' && r.name.startsWith('E2E ')) {
      await request.delete(`${BACKEND}/api/v1/admin/regions/${r.id}`, { headers });
    }
  }
}

/** Drop any synthetic report rows we know belong to the test device_hash
 *  family (pattern: E2E-DEVICE-*). Uses the admin delete endpoint. */
export async function cleanupTestReports(request: APIRequestContext, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  const list = await request.get(`${BACKEND}/api/v1/reports/`, { headers });
  if (!list.ok()) return;
  const reports = await list.json();
  for (const r of reports) {
    const hash = r.device?.device_hash || '';
    if (hash.startsWith('E2E-DEVICE-')) {
      await request.delete(`${BACKEND}/api/v1/reports/${r.id}`, { headers });
    }
  }
}

/** Poll the backend until a report for this device_hash shows up. The sync
 *  engine's chunked-upload flow means there's a small lag (100ms–2s) between
 *  the UI saying "submitted" and the row being queryable. */
export async function waitForReportByDeviceHash(
  request: APIRequestContext,
  token: string,
  deviceHash: string,
  timeoutMs = 15_000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  const headers = { Authorization: `Bearer ${token}` };
  while (Date.now() < deadline) {
    const res = await request.get(
      `${BACKEND}/api/v1/reports/device/${deviceHash}/status-since?since=1970-01-01T00:00:00Z`,
      { headers },
    );
    if (res.ok()) {
      const rows = await res.json();
      if (Array.isArray(rows) && rows.length > 0) return rows[0];
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No report for device_hash=${deviceHash} within ${timeoutMs}ms`);
}

/** Small base64-encoded 10×10 JPEG. Tests that need a "real" photo upload
 *  use this to bypass camera-permission prompts. */
export const TEST_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAKAAoDASIA' +
  'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
  'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
  'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
  'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB' +
  'AAIRAxEAPwD3+iiigD//2Q==';
