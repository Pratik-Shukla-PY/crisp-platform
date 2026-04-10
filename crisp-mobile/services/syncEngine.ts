/**
 * CRISP Sync Engine — Background sync with exponential backoff.
 * Processes queued reports: meta → text → photo chunks → audio chunks.
 */
import { getPendingReports, updateReportStatus, QueuedReport } from './database';
import { createReportMeta, sendDescription, sendChunk, djb2Checksum } from './api';
import * as crypto from 'expo-crypto';

const CHUNK_SIZE = 1024; // 1024 base64 chars ≈ 768 bytes
const MAX_RETRIES = 10;

let _isSyncing = false;

export async function processQueue(): Promise<number> {
  if (_isSyncing) return 0;
  _isSyncing = true;

  let synced = 0;
  try {
    const pending = await getPendingReports();
    for (const report of pending) {
      try {
        await syncReport(report);
        synced++;
      } catch (e) {
        const newRetry = (report.retry_count || 0) + 1;
        const status = newRetry >= MAX_RETRIES ? 'failed' : 'pending_sync';
        await updateReportStatus(report.client_report_id, status, { retry_count: newRetry });
        console.warn(`[Sync] Report ${report.client_report_id.substring(0,8)} failed (retry ${newRetry}):`, e);
      }
    }
  } finally {
    _isSyncing = false;
  }
  return synced;
}

async function syncReport(report: QueuedReport): Promise<void> {
  const meta = JSON.parse(report.meta || '{}');

  // Stage 1: Create report on server
  let serverId = report.server_id;
  if (!serverId) {
    await updateReportStatus(report.client_report_id, 'syncing');
    const result = await createReportMeta(meta);
    serverId = result.id;
    await updateReportStatus(report.client_report_id, 'syncing', { server_id: serverId });
  }

  // Stage 2: Send description
  if (report.text_description) {
    try {
      await sendDescription(serverId, report.text_description);
    } catch (e) {
      console.warn('[Sync] Description send failed (non-blocking):', e);
    }
  }

  // Stage 3: Send photo chunks
  if (report.photo) {
    const b64 = extractBase64(report.photo);
    if (b64) {
      const mediaId = await generateMediaId();
      await uploadChunked(serverId, mediaId, 'IMAGE', b64, report.photo_chunk_progress || 0,
        async (progress) => {
          await updateReportStatus(report.client_report_id, 'syncing', { photo_chunk_progress: progress });
        });
    }
  }

  // Stage 4: Send audio chunks
  if (report.audio) {
    const b64 = extractBase64(report.audio);
    if (b64) {
      const mediaId = await generateMediaId();
      await uploadChunked(serverId, mediaId, 'AUDIO', b64, report.audio_chunk_progress || 0,
        async (progress) => {
          await updateReportStatus(report.client_report_id, 'syncing', { audio_chunk_progress: progress });
        });
    }
  }

  // All done
  await updateReportStatus(report.client_report_id, 'synced');
}

async function uploadChunked(
  reportId: string, mediaId: string, type: string,
  b64: string, startFrom: number,
  onProgress: (chunk: number) => Promise<void>
): Promise<void> {
  const totalChunks = Math.ceil(b64.length / CHUNK_SIZE);

  for (let i = startFrom; i < totalChunks; i++) {
    const chunk = b64.substring(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const checksum = djb2Checksum(chunk);
    await sendChunk(reportId, mediaId, type, i, totalChunks, chunk, checksum);
    await onProgress(i + 1);

    // Small delay every 5 chunks to avoid overwhelming server
    if (i > 0 && i % 5 === 0) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
}

function extractBase64(dataUrl: string): string | null {
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
}

async function generateMediaId(): Promise<string> {
  return crypto.randomUUID();
}

export function isSyncing(): boolean {
  return _isSyncing;
}
