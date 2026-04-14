/**
 * CRISP API Client — Same endpoints as PWA.
 * Configurable backend host for dev/prod.
 */

// Default: local network. Change for production.
let API_BASE = 'http://172.16.110.18:8000/api/v1';

export function setApiBase(host: string) {
  API_BASE = `${host}/api/v1`;
}

export function getApiBase() { return API_BASE; }

async function sendJSON(url: string, method: string, body: any, _timeoutMs = 30000): Promise<any> {
  // No AbortController — React Native's implementation is unreliable and causes
  // spurious "Aborted" errors. Plain fetch waits for server response naturally.
  const options: any = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
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

/** DJB2 checksum — MUST match Python backend */
export function djb2Checksum(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Get status updates for a device since a timestamp */
export async function getDeviceStatusSince(deviceHash: string, since?: string): Promise<any[]> {
  const url = since
    ? `${API_BASE}/reports/device/${deviceHash}/status-since?since=${since}`
    : `${API_BASE}/reports/device/${deviceHash}/status-since`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return [];
  return res.json();
}

/** Delete a report (soft-delete with 30min grace for mobile) */
export async function deleteReportFromServer(reportId: string): Promise<any> {
  const res = await fetch(`${API_BASE}/reports/${reportId}?grace_minutes=30&deletion_source=MOBILE`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Delete failed: HTTP ${res.status}`);
  return res.json();
}
