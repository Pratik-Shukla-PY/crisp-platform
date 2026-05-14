/**
 * syncEngine.selfHeal.test.ts — Phase 7 RN parity port.
 *
 * Pins the queue self-heal heuristic + the sweep flow that
 * `processQueue()` runs before pulling the queue snapshot. RN
 * companion to the PWA implementation in `mobile-app/src/app.js`
 * (functions `_isOrphanQueueRow` + `_selfHealOrphans`).
 *
 * Coverage matrix (mirrors the operator-reported 2026-05-13 PROD
 * scenario that motivated the PWA fix):
 *
 *   ✓ orphan: status='pending_sync', no server_id, no payload,
 *     age > 10 min → dequeued
 *   ✓ protection: < 10-min row stays in queue even when payload
 *     looks empty (might still be writing payload columns)
 *   ✓ protection: row with server_id stays (server has it,
 *     resume from chunk progress)
 *   ✓ protection: row with text_description stays (description-
 *     only report is a valid queued payload)
 *   ✓ protection: row with audio stays
 *   ✓ protection: row with legacy photo data-url stays
 *   ✓ protection: row with photo_variants carrying bytes stays
 *   ✓ protection: row with extra_photos_variants carrying bytes
 *     stays
 *   ✓ status='draft' rows (caller shouldn't see them, but
 *     defensively skipped)
 *   ✓ null / missing client_report_id → not an orphan
 *   ✓ corrupt JSON in variant columns → treated as empty (still
 *     orphan if other guards pass)
 *   ✓ selfHealOrphans() returns count + calls deleteReport() per
 *     orphan + handles getInFlightReports throw → 0
 *   ✓ selfHealOrphans() continues sweep after one deleteReport
 *     throws (so a single corrupt row doesn't strand the rest)
 */

// Mute info-level logs so the test output stays clean.
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

// Replace the database module so we control which rows the sweep
// sees and which deletions it issues. Other syncEngine imports
// (network-adaptive, api, telemetry, expo-crypto, async-storage)
// stay real — the self-heal path doesn't touch them.
jest.mock('../services/database', () => ({
  getInFlightReports: jest.fn(),
  deleteReport: jest.fn(),
  // Stubs so the module loads cleanly — not exercised here.
  getPendingReports: jest.fn(async () => []),
  updateReportStatus: jest.fn(),
}));

import { _isOrphanQueueRow, selfHealOrphans } from '../services/syncEngine';
import { getInFlightReports, deleteReport } from '../services/database';
import type { QueuedReport } from '../services/database';

const ORPHAN_AGE_GATE_MS = 10 * 60 * 1000;
const PAST_GATE  = Date.now() - (ORPHAN_AGE_GATE_MS + 60_000);  // 11 min ago
const INSIDE_GATE = Date.now() - 60_000;                         // 1 min ago

/** Build a base orphan-shaped row. Tests override one field at a
 *  time to assert each protection guard fires. */
function makeOrphan(overrides: Partial<QueuedReport> = {}): QueuedReport {
  return {
    client_report_id: 'orphan-aaaa-bbbb-cccc-000000000001',
    meta: '{}',
    photo: '',
    extra_photos: '',
    audio: '',
    text_description: '',
    status: 'pending_sync',
    server_id: '',
    photo_chunk_progress: 0,
    audio_chunk_progress: 0,
    retry_count: 0,
    created_at: PAST_GATE,
    updated_at: PAST_GATE,
    extra_photos_progress: null,
    photo_variants: null,
    photo_group_id: null,
    extra_photos_variants: null,
    ...overrides,
  };
}

beforeEach(() => {
  (getInFlightReports as jest.Mock).mockReset();
  (deleteReport as jest.Mock).mockReset();
});

// ─── Heuristic — positive cases ──────────────────────────────────────────

describe('_isOrphanQueueRow — positive cases', () => {
  test('orphan: pending_sync, no server_id, no payload, age > 10 min', () => {
    expect(_isOrphanQueueRow(makeOrphan())).toBe(true);
  });

  test('orphan: status=failed counts the same as pending_sync', () => {
    expect(_isOrphanQueueRow(makeOrphan({ status: 'failed' }))).toBe(true);
  });

  test('orphan: status=syncing counts the same (mid-sync crash)', () => {
    expect(_isOrphanQueueRow(makeOrphan({ status: 'syncing' }))).toBe(true);
  });

  test('corrupt photo_variants JSON treated as empty — still orphan when other guards pass', () => {
    const row = makeOrphan({ photo_variants: '{not json' });
    expect(_isOrphanQueueRow(row)).toBe(true);
  });

  test('photo_variants present but all slots empty → still orphan', () => {
    const empty = JSON.stringify({
      small:  { mediaId: 'a', base64: '', chunkProgress: 0, complete: false, bytes: 0 },
      medium: { mediaId: 'b', base64: '', chunkProgress: 0, complete: false, bytes: 0 },
      large:  { mediaId: 'c', base64: '', chunkProgress: 0, complete: false, bytes: 0 },
    });
    expect(_isOrphanQueueRow(makeOrphan({ photo_variants: empty }))).toBe(true);
  });

  test('extra_photos_variants is [] → still orphan', () => {
    expect(_isOrphanQueueRow(makeOrphan({ extra_photos_variants: '[]' }))).toBe(true);
  });

  test('extra_photos="[]" → still orphan (no legacy extras)', () => {
    expect(_isOrphanQueueRow(makeOrphan({ extra_photos: '[]' }))).toBe(true);
  });
});

// ─── Heuristic — protection guards (row must survive sweep) ─────────────

describe('_isOrphanQueueRow — protection guards', () => {
  test('< 10-min row protected (might still be writing payload)', () => {
    expect(_isOrphanQueueRow(makeOrphan({ created_at: INSIDE_GATE }))).toBe(false);
  });

  test('exactly at the 10-min boundary — NOT considered orphan (strict >)', () => {
    // age === ORPHAN_AGE_GATE_MS → predicate uses `> 10 * 60 * 1000` so
    // exact-boundary rows are protected by one ms of grace.
    const onBoundary = Date.now() - ORPHAN_AGE_GATE_MS;
    expect(_isOrphanQueueRow(makeOrphan({ created_at: onBoundary }))).toBe(false);
  });

  test('row with server_id protected (server has it; resume from chunks)', () => {
    expect(_isOrphanQueueRow(makeOrphan({ server_id: 'srv-1234' }))).toBe(false);
  });

  test('row with text_description protected (description-only is a valid report)', () => {
    expect(_isOrphanQueueRow(makeOrphan({ text_description: 'A bridge cracked.' }))).toBe(false);
  });

  test('row with audio protected', () => {
    expect(_isOrphanQueueRow(makeOrphan({ audio: 'data:audio/m4a;base64,AAAA' }))).toBe(false);
  });

  test('row with legacy photo data-url protected', () => {
    expect(_isOrphanQueueRow(makeOrphan({ photo: 'data:image/jpeg;base64,/9j/4AAQ' }))).toBe(false);
  });

  test('row with photo_variants carrying bytes (chunkProgress > 0) protected', () => {
    const partial = JSON.stringify({
      small: { mediaId: 'a', base64: 'AAAA', chunkProgress: 1024, complete: false, bytes: 1024 },
    });
    expect(_isOrphanQueueRow(makeOrphan({ photo_variants: partial }))).toBe(false);
  });

  test('row with photo_variants carrying bytes (complete=true) protected', () => {
    const done = JSON.stringify({
      small: { mediaId: 'a', base64: '', chunkProgress: 0, complete: true, bytes: 1024 },
    });
    expect(_isOrphanQueueRow(makeOrphan({ photo_variants: done }))).toBe(false);
  });

  test('row with extra_photos_variants carrying bytes protected', () => {
    const ev = JSON.stringify([
      { groupId: 'g1', small: { mediaId: 'a', base64: 'AA', chunkProgress: 1, complete: false } },
    ]);
    expect(_isOrphanQueueRow(makeOrphan({ extra_photos_variants: ev }))).toBe(false);
  });

  test('row with legacy extra_photos (non-empty JSON array) protected', () => {
    const arr = JSON.stringify(['data:image/jpeg;base64,/9j/']);
    expect(_isOrphanQueueRow(makeOrphan({ extra_photos: arr }))).toBe(false);
  });
});

// ─── Heuristic — defensive guards on bad input ──────────────────────────

describe('_isOrphanQueueRow — defensive guards', () => {
  test('null row → false (never throws)', () => {
    expect(_isOrphanQueueRow(null)).toBe(false);
  });

  test('undefined row → false', () => {
    expect(_isOrphanQueueRow(undefined)).toBe(false);
  });

  test('row without client_report_id → false (can\'t dequeue what we can\'t key)', () => {
    expect(_isOrphanQueueRow(makeOrphan({ client_report_id: '' }))).toBe(false);
  });

  test('status=draft row → false (not in the queue surface)', () => {
    expect(_isOrphanQueueRow(makeOrphan({ status: 'draft' }))).toBe(false);
  });

  test('status=synced row → false (already done)', () => {
    expect(_isOrphanQueueRow(makeOrphan({ status: 'synced' }))).toBe(false);
  });
});

// ─── selfHealOrphans() — sweep flow ─────────────────────────────────────

describe('selfHealOrphans()', () => {
  test('dequeues every orphan + returns the count + preserves non-orphans', async () => {
    const orphanA = makeOrphan({ client_report_id: 'orphan-A' });
    const orphanB = makeOrphan({ client_report_id: 'orphan-B', status: 'failed' });
    const keep    = makeOrphan({ client_report_id: 'keep-C', server_id: 'srv-1' });

    (getInFlightReports as jest.Mock).mockResolvedValue([orphanA, orphanB, keep]);
    (deleteReport as jest.Mock).mockResolvedValue(undefined);

    const healed = await selfHealOrphans();

    expect(healed).toBe(2);
    expect(deleteReport).toHaveBeenCalledTimes(2);
    expect(deleteReport).toHaveBeenCalledWith('orphan-A');
    expect(deleteReport).toHaveBeenCalledWith('orphan-B');
    expect(deleteReport).not.toHaveBeenCalledWith('keep-C');
  });

  test('empty queue → returns 0 without calling deleteReport', async () => {
    (getInFlightReports as jest.Mock).mockResolvedValue([]);

    const healed = await selfHealOrphans();

    expect(healed).toBe(0);
    expect(deleteReport).not.toHaveBeenCalled();
  });

  test('all rows protected → returns 0 without calling deleteReport', async () => {
    const recent = makeOrphan({ client_report_id: 'recent', created_at: INSIDE_GATE });
    const withId = makeOrphan({ client_report_id: 'withId', server_id: 'srv-2' });
    (getInFlightReports as jest.Mock).mockResolvedValue([recent, withId]);

    const healed = await selfHealOrphans();

    expect(healed).toBe(0);
    expect(deleteReport).not.toHaveBeenCalled();
  });

  test('getInFlightReports throws → returns 0 (best-effort, never aborts boot)', async () => {
    (getInFlightReports as jest.Mock).mockRejectedValue(new Error('DB locked'));

    const healed = await selfHealOrphans();

    expect(healed).toBe(0);
    expect(deleteReport).not.toHaveBeenCalled();
  });

  test('one deleteReport throws → sweep continues, count reflects successful deletes only', async () => {
    const orphanA = makeOrphan({ client_report_id: 'orphan-A' });
    const orphanB = makeOrphan({ client_report_id: 'orphan-B' });
    const orphanC = makeOrphan({ client_report_id: 'orphan-C' });

    (getInFlightReports as jest.Mock).mockResolvedValue([orphanA, orphanB, orphanC]);
    (deleteReport as jest.Mock)
      .mockResolvedValueOnce(undefined)               // A: ok
      .mockRejectedValueOnce(new Error('DB locked'))  // B: throws
      .mockResolvedValueOnce(undefined);              // C: ok

    const healed = await selfHealOrphans();

    expect(healed).toBe(2);
    expect(deleteReport).toHaveBeenCalledTimes(3);
    expect(deleteReport).toHaveBeenNthCalledWith(1, 'orphan-A');
    expect(deleteReport).toHaveBeenNthCalledWith(2, 'orphan-B');
    expect(deleteReport).toHaveBeenNthCalledWith(3, 'orphan-C');
  });
});
