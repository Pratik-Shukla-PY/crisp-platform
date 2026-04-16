/**
 * CRISP SQLite Database — Offline-first report queue.
 * All actions write locally first. Sync engine uploads when online.
 */
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'crisp_offline.db';

let db: SQLite.SQLiteDatabase | null = null;
let dbReady = false;

async function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (db && dbReady) return db;
  try {
    db = await SQLite.openDatabaseAsync(DB_NAME);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS reports (
        client_report_id TEXT PRIMARY KEY,
        meta TEXT, photo TEXT, extra_photos TEXT, audio TEXT, text_description TEXT,
        status TEXT DEFAULT 'draft', server_id TEXT,
        photo_chunk_progress INTEGER DEFAULT 0, audio_chunk_progress INTEGER DEFAULT 0,
        retry_count INTEGER DEFAULT 0, created_at INTEGER, updated_at INTEGER
      );
    `);
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS report_history (
        client_report_id TEXT PRIMARY KEY,
        server_id TEXT, status TEXT DEFAULT 'PENDING', severity TEXT,
        infrastructure_type TEXT, description TEXT, lives_impacted INTEGER,
        synced_at INTEGER, last_status_update INTEGER, deletion_requested INTEGER DEFAULT 0
      );
    `);
    dbReady = true;
    return db;
  } catch (e) {
    console.error('[DB] Init failed:', e);
    throw e;
  }
}

export async function initDatabase(): Promise<void> {
  await getDb();
}

export interface QueuedReport {
  client_report_id: string;
  meta: string;
  photo: string | null;
  extra_photos: string | null;
  audio: string | null;
  text_description: string | null;
  status: string;
  server_id: string | null;
  photo_chunk_progress: number;
  audio_chunk_progress: number;
  retry_count: number;
  created_at: number;
  updated_at: number;
}

export async function enqueueReport(report: Partial<QueuedReport>): Promise<void> {
  const d = await getDb();
  const now = Date.now();
  await d.runAsync(
    `INSERT OR REPLACE INTO reports
     (client_report_id, meta, photo, extra_photos, audio, text_description, status, server_id,
      photo_chunk_progress, audio_chunk_progress, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      report.client_report_id || '',
      report.meta || '{}',
      report.photo || '',
      report.extra_photos || '',
      report.audio || '',
      report.text_description || '',
      report.status || 'pending_sync',
      report.server_id || '',
      report.photo_chunk_progress || 0,
      report.audio_chunk_progress || 0,
      report.retry_count || 0,
      report.created_at || now,
      now,
    ]
  );
}

export async function getPendingReports(): Promise<QueuedReport[]> {
  const d = await getDb();
  return await d.getAllAsync<QueuedReport>(
    `SELECT * FROM reports WHERE status IN ('pending_sync', 'failed') ORDER BY created_at ASC`
  );
}

export async function getQueueCount(): Promise<number> {
  try {
    const d = await getDb();
    const result = await d.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) as count FROM reports WHERE status != 'synced'`
    );
    return result?.count || 0;
  } catch { return 0; }
}

export async function updateReportStatus(
  clientId: string,
  status: string,
  updates?: Partial<QueuedReport>
): Promise<void> {
  const d = await getDb();
  const fields = ['status = ?', 'updated_at = ?'];
  const values: any[] = [status, Date.now()];

  if (updates?.server_id !== undefined) { fields.push('server_id = ?'); values.push(updates.server_id); }
  if (updates?.photo_chunk_progress !== undefined) { fields.push('photo_chunk_progress = ?'); values.push(updates.photo_chunk_progress); }
  if (updates?.audio_chunk_progress !== undefined) { fields.push('audio_chunk_progress = ?'); values.push(updates.audio_chunk_progress); }
  if (updates?.retry_count !== undefined) { fields.push('retry_count = ?'); values.push(updates.retry_count); }

  values.push(clientId);
  await d.runAsync(`UPDATE reports SET ${fields.join(', ')} WHERE client_report_id = ?`, values);
}

export async function deleteReport(clientId: string): Promise<void> {
  const d = await getDb();
  await d.runAsync(`DELETE FROM reports WHERE client_report_id = ?`, [clientId]);
}

export async function clearSyncedReports(): Promise<void> {
  const d = await getDb();
  await d.runAsync(`DELETE FROM reports WHERE status = 'synced'`);
}

export async function clearAllQueuedReports(): Promise<number> {
  const d = await getDb();
  const result = await d.getFirstAsync<{ count: number }>(`SELECT COUNT(*) as count FROM reports WHERE status != 'synced'`);
  const count = result?.count || 0;
  await d.runAsync(`DELETE FROM reports WHERE status != 'synced'`);
  return count;
}

// ── Report History (synced reports with status tracking) ─────────────────────

export interface HistoryReport {
  client_report_id: string;
  server_id: string | null;
  status: string;
  severity: string;
  infrastructure_type: string;
  description: string | null;
  lives_impacted: number | null;
  synced_at: number;
  last_status_update: number;
  deletion_requested: number;
}

export async function saveToHistory(report: Partial<HistoryReport>): Promise<void> {
  const d = await getDb();
  const now = Date.now();
  await d.runAsync(
    `INSERT OR REPLACE INTO report_history
     (client_report_id, server_id, status, severity, infrastructure_type, description, lives_impacted, synced_at, last_status_update)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      report.client_report_id || '', report.server_id || '',
      report.status || 'PENDING', report.severity || 'UNKNOWN',
      report.infrastructure_type || 'OTHER', report.description || '',
      report.lives_impacted || 0, report.synced_at || now, now,
    ]
  );
}

export async function getHistory(): Promise<HistoryReport[]> {
  const d = await getDb();
  return await d.getAllAsync<HistoryReport>(
    `SELECT * FROM report_history WHERE deletion_requested = 0 ORDER BY synced_at DESC`
  );
}

export async function updateHistoryStatus(serverId: string, status: string, livesImpacted?: number | null): Promise<void> {
  const d = await getDb();
  if (livesImpacted !== undefined && livesImpacted !== null) {
    await d.runAsync(`UPDATE report_history SET status = ?, lives_impacted = ?, last_status_update = ? WHERE server_id = ?`,
      [status, livesImpacted, Date.now(), serverId]);
  } else {
    await d.runAsync(`UPDATE report_history SET status = ?, last_status_update = ? WHERE server_id = ?`,
      [status, Date.now(), serverId]);
  }
}

export async function markHistoryDeletionRequested(clientId: string): Promise<void> {
  const d = await getDb();
  await d.runAsync(`UPDATE report_history SET deletion_requested = 1 WHERE client_report_id = ?`, [clientId]);
}

export async function getImpactStats(): Promise<{ totalLives: number; resolvedCount: number }> {
  try {
    const d = await getDb();
    const r = await d.getFirstAsync<{ total: number; cnt: number }>(
      `SELECT COALESCE(SUM(lives_impacted), 0) as total, COUNT(*) as cnt FROM report_history WHERE status = 'RESOLVED' AND lives_impacted > 0`
    );
    return { totalLives: r?.total || 0, resolvedCount: r?.cnt || 0 };
  } catch { return { totalLives: 0, resolvedCount: 0 }; }
}
