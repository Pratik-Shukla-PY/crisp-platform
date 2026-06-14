/**
 * CRISP API Client - Same endpoints as PWA.
 *
 * Backend host resolution (Apr 2026):
 *   1. EXPO_PUBLIC_CRISP_BACKEND env var - hard override (prod builds).
 *   2. Expo Constants.expoConfig.hostUri - auto-detect the Metro host's
 *      LAN IP in dev, so `expo start` on a Mac with any DHCP lease
 *      Just Works for testers on Expo Go without editing this file.
 *      Previously we hardcoded an ngrok URL that went stale the moment
 *      the tunnel was torn down - field testers saw "HTTP 404" on
 *      POST /reports/meta because the domain no longer pointed anywhere.
 *   3. Final fallback: localhost (only useful on iOS Simulator or an
 *      Android emulator on the same host).
 */
import Constants from 'expo-constants';

function _resolveBackendHost(): string {
  // Explicit override wins.
  const override = (process.env.EXPO_PUBLIC_CRISP_BACKEND || '').trim();
  if (override) return override.replace(/\/$/, '');

  // Expo injects hostUri like "192.168.1.49:8081" when Metro is running
  // on a LAN IP. Strip the Metro port and swap in the backend's 8000.
  // `hostUri` can be undefined in a production build - in that case fall
  // through to the final default.
  const hostUri: string | undefined =
    (Constants as any)?.expoConfig?.hostUri ||
    (Constants as any)?.manifest2?.extra?.expoGo?.hostUri ||
    (Constants as any)?.manifest?.hostUri;
  if (hostUri) {
    const host = hostUri.split(':')[0];
    if (host && host !== 'localhost') {
      return `http://${host}:8000`;
    }
  }
  return 'http://localhost:8000';
}

let API_BASE = `${_resolveBackendHost()}/api/v1`;

export function setApiBase(host: string) {
  API_BASE = `${host}/api/v1`;
}

export function getApiBase() { return API_BASE; }

async function sendJSON(url: string, method: string, body: any, _timeoutMs = 30000): Promise<any> {
  // No AbortController - React Native's implementation is unreliable and causes
  // spurious "Aborted" errors. Plain fetch waits for server response naturally.
  const options: any = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  // Phase 1 (Apr 2026 - Optional reporter login). Attach the current
  // access token to every JSON call, incl. /reports/meta. Lazy import
  // avoids a circular dep between api.ts + auth.ts (auth calls sendJSON).
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AuthStore = require('./auth');
    const tok = AuthStore.getAccessToken && AuthStore.getAccessToken();
    if (tok) options.headers['Authorization'] = `Bearer ${tok}`;
  } catch { /* auth module not yet loaded; proceed anonymously */ }
  if (body !== null && body !== undefined) {
    options.body = JSON.stringify(body);
  }
  console.log(`[API] ${method} ${url.replace(API_BASE, '')}`);
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.warn(`[API] ${res.status} ${errText.substring(0, 200)}`);
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.json();
  } catch (e: any) {
    console.error(`[API] FAILED ${method} ${url.replace(API_BASE, '')}: ${e.message}`);
    throw e;
  }
}

/** Stage 1: Create report with metadata only (<1KB) */
export async function createReportMeta(meta: any): Promise<{ id: string }> {
  return sendJSON(`${API_BASE}/reports/meta`, 'POST', meta);
}

/** Geo-gated crisis-form pack active at a point (public, cacheable). Mirrors the
 *  PWA's _maybeFetchCrisisPack fetch. FAIL-SAFE: any non-200 / offline / parse
 *  error → null, so the caller leaves crisisPack null and the default Stage-2/3
 *  flow runs unchanged. Returns the raw {active, pack_id, pack_version,
 *  event_id, crisis_type, schema_json} body on a hit. */
export async function getCrisisFormsActive(lat: number, lng: number): Promise<any | null> {
  try {
    const url = `${API_BASE}/crisis-forms/active?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Stage 2: Send text description */
export async function sendDescription(reportId: string, description: string): Promise<any> {
  return sendJSON(`${API_BASE}/reports/${reportId}/description`, 'PATCH', { description }, 20000);
}

/** Send thumbnail (<20KB preview) */
export async function sendThumbnail(reportId: string, mediaId: string, thumbnailData: string): Promise<any> {
  return sendJSON(`${API_BASE}/reports/${reportId}/media/thumbnail`, 'POST', {
    media_id: mediaId,
    thumbnail_data: thumbnailData,
  });
}

/** Send one media chunk (1KB) */
export async function sendChunk(
  reportId: string, mediaId: string, type: string,
  seqNum: number, totalChunks: number, data: string, checksum: string
): Promise<any> {
  return sendJSON(`${API_BASE}/reports/${reportId}/media/chunk`, 'POST', {
    media_id: mediaId, type, seq_num: seqNum,
    total_chunks: totalChunks, data, checksum,
  }, 30000);
}

/** Send entire media file in one request (simpler than chunking for mobile) */
export async function attachMedia(reportId: string, type: string, dataUrl: string): Promise<any> {
  return sendJSON(`${API_BASE}/reports/${reportId}/media/attach`, 'PATCH', {
    type, resolution_tier: 'MEDIUM', url: dataUrl, file_size_bytes: 0,
  }, 60000);  // 60s timeout for large files
}

/** DJB2 checksum - MUST match Python backend */
export function djb2Checksum(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Get status updates for a device since a timestamp */
export async function getDeviceStatusSince(deviceHash: string, since?: string): Promise<any[]> {
  try {
    const url = since
      ? `${API_BASE}/reports/device/${deviceHash}/status-since?since=${since}`
      : `${API_BASE}/reports/device/${deviceHash}/status-since`;
    const res = await fetch(url);
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

/** Delete a report (soft-delete with 30min grace for mobile) */
export async function deleteReportFromServer(reportId: string): Promise<any> {
  try {
    const res = await fetch(`${API_BASE}/reports/${reportId}?grace_minutes=30&deletion_source=MOBILE`, {
      method: 'DELETE',
    });
    if (!res.ok) throw new Error(`Delete failed: HTTP ${res.status}`);
    return res.json();
  } catch (e) {
    console.warn('[API] Delete failed:', e);
    return null;
  }
}
