/**
 * CRISP API Client — Same endpoints as PWA.
 * Configurable backend host for dev/prod.
 */

// Default: local network. Change for production.
let API_BASE = 'http://192.168.1.38:8000/api/v1';

export function setApiBase(host: string) {
  API_BASE = `${host}/api/v1`;
}

export function getApiBase() { return API_BASE; }

async function sendJSON(url: string, method: string, body: any, timeoutMs = 15000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    clearTimeout(timer);
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
  }, 20000);
}

/** DJB2 checksum — MUST match Python backend */
export function djb2Checksum(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
