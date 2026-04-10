/**
 * CRISP SQLite Database — Offline-first report queue.
 * All actions write locally first. Sync engine uploads when online.
 */
import * as SQLite from 'expo-sqlite';

const DB_NAME = 'crisp_offline.db';

let db: SQLite.SQLiteDatabase | null = null;

export async function initDatabase(): Promise<void> {
  db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS reports (
      client_report_id TEXT PRIMARY KEY,
      meta TEXT,
      photo TEXT,
      extra_photos TEXT,
      audio TEXT,
      text_description TEXT,
      status TEXT DEFAULT 'draft',
      server_id TEXT,
      photo_chunk_progress INTEGER DEFAULT 0,
      audio_chunk_progress INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER
    );
  `);
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
  if (!db) await initDatabase();
  const now = Date.now();
  await db!.runAsync(
    `INSERT OR REPLACE INTO reports
     (client_report_id, meta, photo, extra_photos, audio, text_description, status, server_id,
      photo_chunk_progress, audio_chunk_progress, retry_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    report.client_report_id || '',
    report.meta || '{}',
    report.photo || null,
    report.extra_photos || null,
    report.audio || null,
    report.text_description || null,
    report.status || 'pending_sync',
    report.server_id || null,
    report.photo_chunk_progress || 0,
    report.audio_chunk_progress || 0,
    report.retry_count || 0,
    report.created_at || now,
    now,
  );
}

export async function getPendingReports(): Promise<QueuedReport[]> {
  if (!db) await initDatabase();
  return await db!.getAllAsync<QueuedReport>(
    `SELECT * FROM reports WHERE status IN ('pending_sync', 'failed') ORDER BY created_at ASC`
  );
}

export async function getQueueCount(): Promise<number> {
  if (!db) await initDatabase();
  const result = await db!.getFirstAsync<{ count: number }>(
    `SELECT COUNT(*) as count FROM reports WHERE status != 'synced'`
  );
  return result?.count || 0;
}

export async function updateReportStatus(
  clientId: string,
  status: string,
  updates?: Partial<QueuedReport>
): Promise<void> {
  if (!db) await initDatabase();
  const fields = ['status = ?', 'updated_at = ?'];
  const values: any[] = [status, Date.now()];

  if (updates?.server_id !== undefined) { fields.push('server_id = ?'); values.push(updates.server_id); }
  if (updates?.photo_chunk_progress !== undefined) { fields.push('photo_chunk_progress = ?'); values.push(updates.photo_chunk_progress); }
  if (updates?.audio_chunk_progress !== undefined) { fields.push('audio_chunk_progress = ?'); values.push(updates.audio_chunk_progress); }
  if (updates?.retry_count !== undefined) { fields.push('retry_count = ?'); values.push(updates.retry_count); }

  values.push(clientId);
  await db!.runAsync(`UPDATE reports SET ${fields.join(', ')} WHERE client_report_id = ?`, ...values);
}

export async function deleteReport(clientId: string): Promise<void> {
  if (!db) await initDatabase();
  await db!.runAsync(`DELETE FROM reports WHERE client_report_id = ?`, clientId);
}

export async function clearSyncedReports(): Promise<void> {
  if (!db) await initDatabase();
  await db!.runAsync(`DELETE FROM reports WHERE status = 'synced'`);
}
