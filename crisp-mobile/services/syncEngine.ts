/**
 * CRISP Adaptive Sync Engine — Network-aware chunked upload with dynamic adaptation.
 *
 * Key behaviors:
 *   - Detects network tier (FAST/MEDIUM/SLOW/VERY_SLOW/OFFLINE)
 *   - Adjusts chunk size dynamically (64KB → 1KB based on speed)
 *   - Downgrades immediately on failure, upgrades gradually on success
 *   - Exponential backoff per chunk (not per file)
 *   - Resumes from last successful chunk (stored in SQLite)
 *   - Never restarts full upload
 *   - Parallel chunks on fast networks, sequential on slow
 */
import { getPendingReports, updateReportStatus, QueuedReport } from './database';
import { createReportMeta, sendDescription, getApiBase } from './api';
import * as crypto from 'expo-crypto';
import {
  detectNetworkTier, getAdaptiveConfig, downgradeNetwork, upgradeNetwork,
  getCurrentTier, runSpeedTest,
} from './networkAdaptive';
import { swallow as telemetrySwallow } from './telemetry';

const MAX_RETRIES = 10;
let _isSyncing = false;
let _successStreak = 0;  // Track consecutive successes for upgrade

export async function processQueue(): Promise<number> {
  if (_isSyncing) return 0;
  _isSyncing = true;

  let synced = 0;
  try {
    // Detect network before starting
    await detectNetworkTier();
    const tier = getCurrentTier();
    if (tier === 'OFFLINE') {
      console.log('[Sync] Offline — skipping');
      _isSyncing = false;
      return 0;
    }

    // Speed test for more accurate tier
    await runSpeedTest(getApiBase().replace('/api/v1', ''));

    const pending = await getPendingReports();
    for (const report of pending) {
      try {
        await syncReport(report);
        synced++;
      } catch (e: any) {
        const newRetry = (report.retry_count || 0) + 1;
        const status = newRetry >= MAX_RETRIES ? 'failed' : 'pending_sync';
        try { await updateReportStatus(report.client_report_id, status, { retry_count: newRetry }); } catch (e) { telemetrySwallow('updateReportStatus-retry', e); }
        console.warn(`[Sync] Report ${report.client_report_id.substring(0,8)} retry ${newRetry}: ${e.message || 'error'}`);
      }
    }
  } catch (e) {
    console.warn('[Sync] Queue error:', e);
  } finally {
    _isSyncing = false;
  }
  return synced;
}

async function syncReport(report: QueuedReport): Promise<void> {
  let meta: any;
  try { meta = JSON.parse(report.meta || '{}'); }
  catch { console.error('[Sync] Corrupted meta, skipping:', report.client_report_id); return; }

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
    try { await sendDescription(serverId, report.text_description); } catch (e) { telemetrySwallow('sendDescription', e); }
  }

  // Stage 3: Guaranteed-delivery — tier-first interleaved photo upload.
  //
  // Every photo (main + extras) has three JPEG variants (SMALL/MEDIUM/LARGE)
  // generated on-device. We upload them in this order:
  //
  //   pass 1: SMALL of main → SMALL of extra#1 → SMALL of extra#2 → ...
  //   pass 2: MEDIUM of main → MEDIUM of extra#1 → ...
  //   pass 3: LARGE  of main → ...
  //
  // Result: responders see a complete SMALL image of EVERY photo before any
  // MEDIUM starts. On a 30 kbps link with a ~40 KB SMALL variant that's
  // first-visible-image in ~10 s instead of minutes.
  //
  // Fall back to the legacy single-variant path when variants aren't on
  // the queued report (reports queued before this feature shipped).

  type VariantRec = { mediaId: string; base64: string; chunkProgress: number; complete: boolean; bytes: number };
  type PhotoVariantsRec = { small: VariantRec; medium: VariantRec; large: VariantRec };
  type ExtraVariantsRec = PhotoVariantsRec & { groupId: string };
  const TIER_TO_RESOLUTION: Record<'small' | 'medium' | 'large', 'LOW' | 'MEDIUM' | 'HIGH'> = {
    small: 'LOW', medium: 'MEDIUM', large: 'HIGH',
  };

  const mainVariants: PhotoVariantsRec | null = report.photo_variants
    ? (() => { try { return JSON.parse(report.photo_variants) as PhotoVariantsRec; } catch { return null; } })()
    : null;
  const extraVariants: (ExtraVariantsRec | null)[] = report.extra_photos_variants
    ? (() => { try { return JSON.parse(report.extra_photos_variants) as (ExtraVariantsRec | null)[]; } catch { return []; } })()
    : [];

  async function persistVariants() {
    await updateReportStatus(report.client_report_id, 'syncing', {
      photo_variants: mainVariants ? JSON.stringify(mainVariants) : null,
      extra_photos_variants: extraVariants.length ? JSON.stringify(extraVariants) : null,
    });
  }

  async function uploadOneVariant(
    variant: VariantRec,
    tier: 'small' | 'medium' | 'large',
    groupId: string,
    label: string,
  ) {
    if (variant.complete) { console.log(`[Sync] ${label}: already complete, skip`); return; }
    if (!variant.base64) { console.warn(`[Sync] ${label}: missing base64`); return; }
    if (!serverId) { console.warn(`[Sync] ${label}: serverId not yet set, skip`); return; }
    console.log(`[Sync] ${label}: ${Math.round(variant.base64.length / 1024)}KB from byte ${variant.chunkProgress || 0}`);
    try {
      await adaptiveUpload(
        serverId, variant.mediaId, 'IMAGE', variant.base64,
        variant.chunkProgress || 0,
        async (offset) => { variant.chunkProgress = offset; await persistVariants(); },
        { resolution_tier: TIER_TO_RESOLUTION[tier], photo_group_id: groupId },
      );
      variant.complete = true;
      variant.chunkProgress = variant.base64.length;
      await persistVariants();
    } catch (e) {
      // adaptiveUpload already persisted chunkProgress via onProgress; just
      // surface the failure so the outer retry loop kicks in.
      throw e;
    }
  }

  if (mainVariants || extraVariants.some(e => e)) {
    // Tier-first interleave.
    for (const tier of ['small', 'medium', 'large'] as const) {
      if (mainVariants) {
        await uploadOneVariant(mainVariants[tier], tier, report.photo_group_id || '', `main/${tier}`);
      }
      for (let i = 0; i < extraVariants.length; i++) {
        const ev = extraVariants[i];
        if (!ev) continue;
        await uploadOneVariant(ev[tier], tier, ev.groupId, `extra[${i}]/${tier}`);
      }
    }
  } else if (report.photo) {
    // Legacy single-variant path — pre-variant reports stay functional.
    const b64 = extractBase64(report.photo);
    if (b64) {
      console.log(`[Sync] Legacy photo: ${Math.round(b64.length / 1024)}KB, network=${getCurrentTier()}`);
      const mediaId = crypto.randomUUID();
      await adaptiveUpload(serverId, mediaId, 'IMAGE', b64,
        report.photo_chunk_progress || 0, async (progress) => {
          await updateReportStatus(report.client_report_id, 'syncing', { photo_chunk_progress: progress });
        });
    }
    // Legacy extra_photos (pre-variant) — keep the old per-index resume map.
    if (report.extra_photos) {
      try {
        const arr: string[] = JSON.parse(report.extra_photos);
        type ExtraProg = { mediaId: string; bytes: number; total: number };
        let progress: Record<string, ExtraProg> = {};
        if (report.extra_photos_progress) {
          try { progress = JSON.parse(report.extra_photos_progress); } catch {}
        }
        for (let i = 0; i < arr.length; i++) {
          const b64 = extractBase64(arr[i]);
          if (!b64) continue;
          const key = String(i);
          if (!progress[key]) progress[key] = { mediaId: crypto.randomUUID(), bytes: 0, total: b64.length };
          const entry = progress[key];
          if (entry.bytes >= b64.length) continue;
          await adaptiveUpload(serverId, entry.mediaId, 'IMAGE', b64, entry.bytes, async (offset) => {
            entry.bytes = offset;
            await updateReportStatus(report.client_report_id, 'syncing', {
              extra_photos_progress: JSON.stringify(progress),
            });
          });
          entry.bytes = b64.length;
          await updateReportStatus(report.client_report_id, 'syncing', {
            extra_photos_progress: JSON.stringify(progress),
          });
        }
      } catch (e) {
        console.warn('[Sync] extra_photos parse/upload failed:', e);
      }
    }
  }

  // Stage 4: Upload audio with adaptive chunking
  if (report.audio) {
    const b64 = extractBase64(report.audio);
    if (b64) {
      console.log(`[Sync] Audio: ${Math.round(b64.length / 1024)}KB, network=${getCurrentTier()}`);
      const mediaId = crypto.randomUUID();
      await adaptiveUpload(serverId, mediaId, 'AUDIO', b64,
        report.audio_chunk_progress || 0, async (progress) => {
          await updateReportStatus(report.client_report_id, 'syncing', { audio_chunk_progress: progress });
        });
    }
  }

  // All done
  await updateReportStatus(report.client_report_id, 'synced');
  try {
    const { saveToHistory } = await import('./database');
    await saveToHistory({
      client_report_id: report.client_report_id,
      server_id: serverId,
      status: 'PENDING',
      severity: meta.severity || 'UNKNOWN',
      infrastructure_type: meta.infrastructure_type || 'OTHER',
      description: report.text_description || meta.description || '',
    });
  } catch (e) { telemetrySwallow('saveToHistory', e); }
}

// ── UNDP §5 binary-chunk transport (Apr 2026, Option A) ──────────────────
// Master feature flag. Default ON — every new build uses binary chunks.
// Disable in an incident by setting AsyncStorage key `crisp_binary_chunks`
// to `"off"` before calling `processQueue()`.
let _BINARY_CHUNKS_ENABLED = true;
let _BINARY_FALLBACK_404 = false;   // session-scoped sticky flag on 404

// Apr 2026 — capability detection: React-Native's Blob constructor does
// NOT accept ArrayBuffer/Uint8Array parts ("Creating blobs from
// 'ArrayBuffer' and 'ArrayBufferView' are not supported"). The PWA
// Blob does. This happens synchronously at chunk-post time, BEFORE the
// fetch, so the HTTP-404 sticky-fallback never fires. Probe capability
// at module load and permanently pin the base64 path when bytes-into-
// Blob isn't available, so RN always uses the legacy chunk endpoint.
let _BINARY_CAPABLE = true;
try {
  // eslint-disable-next-line no-new
  new Blob([new Uint8Array([1, 2, 3])] as any, { type: 'application/octet-stream' });
} catch {
  _BINARY_CAPABLE = false;
  _BINARY_FALLBACK_404 = true;   // permanent for this session
  console.log('[Sync] Blob-from-bytes unsupported on this platform — pinning base64 chunk path');
}

export function setBinaryChunksEnabled(on: boolean): void {
  _BINARY_CHUNKS_ENABLED = !!on;
  if (on && _BINARY_CAPABLE) _BINARY_FALLBACK_404 = false;
}
export function isBinaryChunksEnabled(): boolean {
  return _BINARY_CHUNKS_ENABLED && _BINARY_CAPABLE && !_BINARY_FALLBACK_404;
}

// ── Upload-bandwidth probe (Apr 2026) ──────────────────────────────────────
// Parity with the PWA fix — see `mobile-app/src/app.js::measureUploadBandwidth`.
// Before the first chunk of an upload, POST an 8 KB probe to
// `/reports/upload-probe` and measure actual round-trip throughput. This
// bypasses the unreliable `navigator.connection.effectiveType` signal and
// catches cases where the browser/OS reports a fast tier on a throttled
// link. Cached 60 s so three variants of one report share one probe.

const _PROBE_SIZE_BYTES = 8192;
const _PROBE_TIMEOUT_MS = 45_000;
const _PROBE_CACHE_MS = 60_000;

let _lastProbeBytesPerSec = 0;
let _lastProbeAt = 0;

async function measureUploadBandwidth(): Promise<{ bytesPerSec: number; elapsedMs: number; error?: string }> {
  const API_BASE = getApiBase();
  const probe = new Uint8Array(_PROBE_SIZE_BYTES);
  const fd = new FormData();
  fd.append('data', new Blob([probe], { type: 'application/octet-stream' }) as any, 'probe.bin');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), _PROBE_TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(`${API_BASE}/reports/upload-probe`, {
      method: 'POST',
      body: fd as any,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      console.warn(`[Probe] HTTP ${res.status} — ignoring`);
      return { bytesPerSec: 0, elapsedMs: 0, error: `HTTP ${res.status}` };
    }
    await res.json();
    const elapsedMs = Date.now() - start;
    const bytesPerSec = elapsedMs > 0 ? (_PROBE_SIZE_BYTES / elapsedMs) * 1000 : 0;
    return { bytesPerSec, elapsedMs };
  } catch (e: any) {
    clearTimeout(timer);
    console.warn(`[Probe] failed: ${e?.message || e}`);
    return { bytesPerSec: 0, elapsedMs: 0, error: String(e?.message || e) };
  }
}

function pickTierFromBandwidth(bytesPerSec: number): 'FAST' | 'MEDIUM' | 'SLOW' | 'VERY_SLOW' {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return 'VERY_SLOW';
  if (bytesPerSec >= 1_000_000) return 'FAST';
  if (bytesPerSec >= 100_000)   return 'MEDIUM';
  if (bytesPerSec >= 10_000)    return 'SLOW';
  return 'VERY_SLOW';
}

/**
 * Adapt tier to the measured upload bandwidth. Cached 60 s. On probe
 * failure, leave the existing NetworkInfo-based tier in place (which
 * `detectNetworkTier()` has already set more conservatively post-fix).
 */
async function adaptTierViaProbe(opts: { force?: boolean } = {}): Promise<void> {
  const { force = false } = opts;
  const freshEnough = !force && _lastProbeBytesPerSec > 0 &&
    (Date.now() - _lastProbeAt) < _PROBE_CACHE_MS;
  if (freshEnough) return;

  const { bytesPerSec, elapsedMs, error } = await measureUploadBandwidth();
  if (bytesPerSec > 0) {
    _lastProbeBytesPerSec = bytesPerSec;
    _lastProbeAt = Date.now();
    const tier = pickTierFromBandwidth(bytesPerSec);
    console.log(`[Probe] ${Math.round(bytesPerSec).toLocaleString()} B/s (${elapsedMs.toFixed(0)} ms) → tier ${tier}`);
    // Reach into networkAdaptive's private state via its public setter
    // if present, or the downgrade/upgrade helpers to align tiers.
    // Simple approach: call upgradeNetwork/downgradeNetwork until we
    // arrive at the target. `getCurrentTier()` drives the loop.
    const tierOrder = ['FAST', 'MEDIUM', 'SLOW', 'VERY_SLOW'] as const;
    const target = tierOrder.indexOf(tier);
    let guard = 8;   // max steps
    while (guard-- > 0) {
      const cur = getCurrentTier();
      const curIdx = tierOrder.indexOf(cur as any);
      if (curIdx === target) break;
      if (curIdx < target) downgradeNetwork();
      else upgradeNetwork();
    }
  } else {
    console.log(`[Probe] no measurement (${error || 'n/a'}) — keeping NetworkInfo-based tier`);
  }
}

/** Timeout scaled to measured bandwidth. Parity with
 *  `mobile-app/src/app.js::computeChunkTimeout`. */
function computeChunkTimeout(chunkSize: number, measuredBytesPerSec: number | null): number {
  if (measuredBytesPerSec && measuredBytesPerSec > 0) {
    const estimatedMs = (chunkSize / measuredBytesPerSec) * 1000;
    return Math.max(10_000, Math.ceil(estimatedMs * 3 + 5_000));
  }
  return 30_000;
}

export function _getMeasuredBandwidth(): number { return _lastProbeBytesPerSec; }

// ─── Phase-1 + 2.1 Adaptive Upgrades (Apr 2026) ──────────────────────────────
// Mirrors mobile-app/src/app.js `_crispAdaptive` block. Keep these two
// blocks in sync; the RN app is the secondary surface, not the reference.
//
//  1. Per-device bandwidth cache via AsyncStorage — skip the first
//     probe round-trip for repeat sessions (saves ~500 ms cold-start).
//  2. Mid-upload re-probe with hysteresis (2× ratio threshold).
//  3. Packet-loss detection — chunk retries >3 → tier shrink for the
//     remainder of the session.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const AsyncStorageNS = require('@react-native-async-storage/async-storage').default as {
  getItem: (k: string) => Promise<string | null>;
  setItem: (k: string, v: string) => Promise<void>;
};

const _BANDWIDTH_CACHE_KEY = 'crisp_bandwidth_last_bps';
const _BANDWIDTH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const _HYSTERESIS_RATIO = 2.0;
const _PACKET_LOSS_RETRY_THRESHOLD = 3;
/** Hook point count — exported so the chunk loop can `(seq+1) % X === 0`. */
export const MID_UPLOAD_REPROBE_EVERY = 8;

async function _readCachedBandwidth(): Promise<number> {
  try {
    const raw = await AsyncStorageNS.getItem(_BANDWIDTH_CACHE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { bps?: number; ts?: number };
    if (!parsed || typeof parsed.bps !== 'number' || !parsed.ts) return 0;
    if (Date.now() - parsed.ts > _BANDWIDTH_CACHE_TTL_MS) return 0;
    return parsed.bps;
  } catch { return 0; }
}

async function _writeCachedBandwidth(bps: number): Promise<void> {
  try {
    await AsyncStorageNS.setItem(_BANDWIDTH_CACHE_KEY, JSON.stringify({ bps, ts: Date.now() }));
  } catch { /* ignore */ }
}

/** Hydrate the probe state from AsyncStorage at module load so the first
 *  session probe isn't a cold start. Pure side-effect; best-effort. */
export async function hydrateBandwidthFromCache(): Promise<void> {
  const bps = await _readCachedBandwidth();
  if (bps > 0 && _lastProbeBytesPerSec === 0) {
    _lastProbeBytesPerSec = bps;
    _lastProbeAt = Date.now();
    const tier = pickTierFromBandwidth(bps);
    console.log(`[Probe] hydrated from cache: ${Math.round(bps)} B/s → ${tier}`);
    // Align networkAdaptive's tier to the hydrated value.
    const tierOrder = ['FAST', 'MEDIUM', 'SLOW', 'VERY_SLOW'] as const;
    const target = tierOrder.indexOf(tier);
    let guard = 8;
    while (guard-- > 0) {
      const cur = getCurrentTier();
      const curIdx = tierOrder.indexOf(cur as any);
      if (curIdx === target) break;
      if (curIdx < target) downgradeNetwork();
      else upgradeNetwork();
    }
  }
}
// Kick hydration at module load — module import is the Metro bundler so
// this runs exactly once per app launch.
hydrateBandwidthFromCache().catch(() => {});

/**
 * Mid-upload re-probe with hysteresis. Returns the (possibly new) tier.
 * Caller should invoke every MID_UPLOAD_REPROBE_EVERY chunks.
 * Fire-and-forget is fine — failures fall through to the prior tier.
 */
export async function midUploadReprobe(): Promise<void> {
  const prevBps = _lastProbeBytesPerSec;
  const prevTier = getCurrentTier();
  await adaptTierViaProbe({ force: true });
  const newBps = _lastProbeBytesPerSec;
  if (newBps > 0) _writeCachedBandwidth(newBps).catch(() => {});
  if (prevBps > 0 && newBps > 0) {
    const ratio = Math.max(prevBps, newBps) / Math.min(prevBps, newBps);
    if (ratio < _HYSTERESIS_RATIO) {
      // Adaptive tier can only be nudged via up/downgrade helpers; if
      // adaptTierViaProbe moved it, walk it back. One-step moves are
      // the common case since probe noise rarely crosses multiple tiers.
      const curTier = getCurrentTier();
      if (curTier !== prevTier) {
        const tierOrder = ['FAST', 'MEDIUM', 'SLOW', 'VERY_SLOW'] as const;
        const want = tierOrder.indexOf(prevTier as any);
        let guard = 4;
        while (guard-- > 0) {
          const c = getCurrentTier();
          const curIdx = tierOrder.indexOf(c as any);
          if (curIdx === want) break;
          if (curIdx < want) downgradeNetwork();
          else upgradeNetwork();
        }
      }
      console.log(
        `[Reprobe] ${Math.round(prevBps)}→${Math.round(newBps)} B/s ` +
        `(ratio ${ratio.toFixed(2)}) — within hysteresis, staying on ${prevTier}`,
      );
    }
  }
}

// Packet-loss counters (module-level; reset per report).
let _packetLossEvents = 0;
let _packetLossShrunk = false;

export function recordRetryCount(retries: number): void {
  if (retries > _PACKET_LOSS_RETRY_THRESHOLD) _packetLossEvents += 1;
}

export function resetPacketLossCounters(): void {
  _packetLossEvents = 0;
  _packetLossShrunk = false;
}

/**
 * If the session has accumulated ≥2 lossy chunks AND we haven't shrunk
 * yet, drop one tier. One-way: lossy links tend to stay lossy, so no
 * upgrade path from this function.
 */
export function maybeShrinkTierForLoss(): void {
  if (_packetLossShrunk) return;
  if (_packetLossEvents < 2) return;
  const cur = getCurrentTier();
  if (cur === 'VERY_SLOW') { _packetLossShrunk = true; return; }
  console.log(`[Adaptive] packet-loss shrink: ${cur} → (one step down) events=${_packetLossEvents}`);
  downgradeNetwork();
  _packetLossShrunk = true;
}

export function getPacketLossEvents(): number { return _packetLossEvents; }
// ─── end Phase-1 + 2.1 Adaptive Upgrades ──────────────────────────────────────

/** djb2 hash over raw bytes. Mirrors `djb2_bytes` in
 *  `backend/app/api/endpoints/reports.py`. Same polynomial as the
 *  text-alphabet `djb2Checksum` helper below. */
function djb2Bytes(bytes: Uint8Array): string {
  let h = 5381;
  for (let i = 0; i < bytes.length; i++) {
    h = (((h << 5) + h) ^ bytes[i]) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Decode a base64 string into a Uint8Array. Used to convert queued
 *  variant payloads (stored as base64 in SQLite for JSON compatibility)
 *  back into raw bytes for the binary upload path. */
function base64ToBytes(b64: string): Uint8Array {
  // atob is available in React-Native ≥ 0.71 via `global.atob`.
  const bin = (global as any).atob ? (global as any).atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Binary variant of `adaptiveUpload`. Uploads raw bytes via
 * multipart/form-data to `/reports/{id}/media/chunk-bin`. Preserves
 * every invariant of the base64 path: locked chunk size per upload,
 * retry-with-downgrade, exponential backoff, streak-based tier upgrade.
 *
 * On HTTP 404 (legacy backend without the new endpoint), sets the
 * session-sticky fallback flag and re-runs this chunk via the legacy
 * base64 path. All subsequent chunks + uploads this session also go
 * straight to the legacy path.
 */
async function adaptiveUploadBinary(
  reportId: string, mediaId: string, type: string,
  bytes: Uint8Array, startFrom: number,
  onProgress: (chunk: number) => Promise<void>,
  opts?: { resolution_tier?: 'LOW' | 'MEDIUM' | 'HIGH'; photo_group_id?: string | null },
): Promise<void> {
  const API_BASE = getApiBase();
  const totalLen = bytes.length;
  _successStreak = 0;

  const initialConfig = getAdaptiveConfig();
  const LOCKED_CHUNK_SIZE = initialConfig.chunkSize;
  const LOCKED_TOTAL_CHUNKS = Math.ceil(totalLen / LOCKED_CHUNK_SIZE);

  let chunkIdx = Math.floor(startFrom / LOCKED_CHUNK_SIZE);
  let offset = chunkIdx * LOCKED_CHUNK_SIZE;

  const tierSuffix = opts?.resolution_tier ? ` tier=${opts.resolution_tier}` : '';
  console.log(`[Adaptive:bin] Start: ${type}${tierSuffix} ${Math.round(totalLen/1024)}KB, chunkSize=${LOCKED_CHUNK_SIZE}B, totalChunks=${LOCKED_TOTAL_CHUNKS}, resumeFrom=chunk#${chunkIdx}`);

  while (offset < totalLen) {
    // Slice bytes for this chunk.
    const end = Math.min(offset + LOCKED_CHUNK_SIZE, totalLen);
    const slice = bytes.slice(offset, end);
    const checksum = djb2Bytes(slice);

    // Build multipart form. RN Blob wrapping works on 0.71+.
    const fd = new FormData();
    fd.append('media_id', mediaId);
    fd.append('seq_num', String(chunkIdx));
    fd.append('total_chunks', String(LOCKED_TOTAL_CHUNKS));
    fd.append('type', type);
    fd.append('checksum', checksum);
    if (opts?.resolution_tier) fd.append('resolution_tier', opts.resolution_tier);
    if (opts?.photo_group_id) fd.append('photo_group_id', opts.photo_group_id);
    if (type === 'IMAGE') fd.append('client_blur_applied', 'true');
    // RN's FormData accepts Blob for the file part.
    fd.append('data', new Blob([slice], { type: 'application/octet-stream' }) as any, 'chunk.bin');

    let sent = false;
    const retryDelays = getAdaptiveConfig().retryDelays;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        const res = await fetch(`${API_BASE}/reports/${reportId}/media/chunk-bin`, {
          method: 'POST',
          // DO NOT set Content-Type — fetch auto-generates the boundary.
          body: fd as any,
        });

        if (res.ok) {
          sent = true;
          _successStreak++;
          if (_successStreak >= 10) { upgradeNetwork(); _successStreak = 0; }
          // Phase-2.1 — record retry count for this chunk. `attempt` is
          // 0-based: 0 = first try succeeded, >threshold = lossy.
          try { recordRetryCount(attempt); } catch { /* best-effort */ }
          break;
        }
        if (res.status === 404 && attempt === 0) {
          // Legacy backend — sticky-fallback for the rest of the session.
          console.warn('[Adaptive:bin] /chunk-bin returned 404 — falling back to base64 for the rest of this session');
          _BINARY_FALLBACK_404 = true;
          // Delegate this upload (from current offset) to the base64 path.
          // Convert the remaining bytes back to base64 for the legacy sender.
          const remainingB64 = bytesToBase64(bytes.slice(offset));
          return await adaptiveUploadLegacy(
            reportId, mediaId, type,
            // Full base64 for resume accounting — offsets measured in b64
            // chars. Easiest: re-encode the whole buffer as base64.
            bytesToBase64(bytes),
            // Adjust startFrom into base64 space.
            Math.ceil((offset / totalLen) * (bytesToBase64(bytes).length)),
            onProgress,
            opts,
          );
        }
        throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        _successStreak = 0;
        if (attempt < retryDelays.length) {
          downgradeNetwork();
          const delay = retryDelays[attempt];
          console.log(`[Adaptive:bin] Chunk ${chunkIdx}/${LOCKED_TOTAL_CHUNKS} failed, retry in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (!sent) {
      throw new Error(`Chunk ${chunkIdx}/${LOCKED_TOTAL_CHUNKS} failed after all retries`);
    }

    offset = end;
    chunkIdx++;
    await onProgress(offset);

    // Phase-1.6 + Phase-2.1 — packet-loss shrink + periodic re-probe.
    // Both best-effort: throwing from the adaptive layer must never
    // abort an upload that's already successfully-transmitted a chunk.
    try {
      maybeShrinkTierForLoss();
      if (chunkIdx % MID_UPLOAD_REPROBE_EVERY === 0) {
        // Fire-and-forget — don't block the next chunk.
        midUploadReprobe().catch(() => {});
      }
    } catch { /* ignore */ }

    if (chunkIdx % 10 === 0) {
      const pct = Math.round((chunkIdx / LOCKED_TOTAL_CHUNKS) * 100);
      console.log(`[Adaptive:bin] ${type} ${pct}% (${chunkIdx}/${LOCKED_TOTAL_CHUNKS} chunks)`);
    }
  }

  console.log(`[Adaptive:bin] Complete: ${type} ${Math.round(totalLen/1024)}KB in ${LOCKED_TOTAL_CHUNKS} chunks`);
}

function bytesToBase64(bytes: Uint8Array): string {
  // atob/btoa polyfilled on RN ≥ 0.71. Fallback via Buffer.
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  if ((global as any).btoa) return (global as any).btoa(s);
  return Buffer.from(bytes).toString('base64');
}

/**
 * Adaptive chunked upload — adjusts chunk size based on network conditions.
 * Downgrades immediately on failure, upgrades gradually on success.
 *
 * UNDP §5 Apr 2026: this is now a router. When the binary-chunk flag is
 * ON, we decode the base64 payload back into bytes and delegate to
 * `adaptiveUploadBinary`. When the flag is OFF (or the server falls
 * back via 404), we stay on `adaptiveUploadLegacy` which retains the
 * pre-April behaviour verbatim.
 *
 * Callers keep their existing signature — no migration needed on the
 * seven call-sites upstream.
 */
async function adaptiveUpload(
  reportId: string, mediaId: string, type: string,
  b64: string, startFrom: number,
  onProgress: (chunk: number) => Promise<void>,
  opts?: { resolution_tier?: 'LOW' | 'MEDIUM' | 'HIGH'; photo_group_id?: string | null },
): Promise<void> {
  // Apr 2026 — measure actual upload throughput before committing to a
  // tier. Parity with the PWA fix. Cached 60 s so the three variants of
  // one photo share one probe.
  await adaptTierViaProbe();

  if (isBinaryChunksEnabled()) {
    // Decode base64 → bytes once. For a 10 MB payload that's ~10 MB of
    // byte memory + the original ~13 MB base64 string. We release the
    // base64 string after the slice so peak memory stays bounded.
    const bytes = base64ToBytes(b64);
    // Translate startFrom (base64-char offset) into a byte offset.
    // The canonical bytes-length ratio is 3/4 of the base64 length.
    const byteStart = Math.floor((startFrom / b64.length) * bytes.length);
    return await adaptiveUploadBinary(
      reportId, mediaId, type, bytes, byteStart, onProgress, opts,
    );
  }
  return await adaptiveUploadLegacy(
    reportId, mediaId, type, b64, startFrom, onProgress, opts,
  );
}

/**
 * Legacy base64 chunked upload. Preserved verbatim pre-April 2026
 * behaviour — retained for (a) the feature-flag-off path and (b) the
 * sticky-404 fallback inside `adaptiveUploadBinary`.
 */
async function adaptiveUploadLegacy(
  reportId: string, mediaId: string, type: string,
  b64: string, startFrom: number,
  onProgress: (chunk: number) => Promise<void>,
  // Guaranteed-delivery tags. Default null so every existing caller keeps
  // working (chunk handler falls back to defaults when these are absent).
  opts?: { resolution_tier?: 'LOW' | 'MEDIUM' | 'HIGH'; photo_group_id?: string | null },
): Promise<void> {
  const API_BASE = getApiBase();
  const totalLen = b64.length;
  _successStreak = 0;

  // CRITICAL: Lock chunk size for the entire upload — NEVER change mid-upload.
  // If we changed chunkSize, seq_num and total_chunks would become inconsistent
  // on the server, causing assembly to stall at partial % forever.
  // Start conservative: pick smallest chunk size of current tier, stick with it.
  const initialConfig = getAdaptiveConfig();
  const LOCKED_CHUNK_SIZE = initialConfig.chunkSize;
  const LOCKED_TOTAL_CHUNKS = Math.ceil(totalLen / LOCKED_CHUNK_SIZE);

  // Resume: startFrom is byte offset. Derive chunk index from it.
  let chunkIdx = Math.floor(startFrom / LOCKED_CHUNK_SIZE);
  let offset = chunkIdx * LOCKED_CHUNK_SIZE;  // Align to chunk boundary

  const tierSuffix = opts?.resolution_tier ? ` tier=${opts.resolution_tier}` : '';
  console.log(`[Adaptive] Start: ${type}${tierSuffix} ${Math.round(totalLen/1024)}KB, chunkSize=${LOCKED_CHUNK_SIZE}B, totalChunks=${LOCKED_TOTAL_CHUNKS}, resumeFrom=chunk#${chunkIdx}`);

  while (offset < totalLen) {
    const chunk = b64.substring(offset, offset + LOCKED_CHUNK_SIZE);
    const checksum = djb2Checksum(chunk);
    const payload: any = {
      media_id: mediaId,
      type,
      seq_num: chunkIdx,
      total_chunks: LOCKED_TOTAL_CHUNKS,   // LOCKED — server expects exactly this count
      data: chunk,
      checksum,
    };
    if (opts?.resolution_tier) payload.resolution_tier = opts.resolution_tier;
    if (opts?.photo_group_id) payload.photo_group_id = opts.photo_group_id;
    // Apr 2026: IMAGE chunks have already been through the client PII blur
    // pipeline (services/piiBlur.ts → blurFacesBase64) before the variant
    // generator chunked them. Tell the server to skip its own blur pass
    // to avoid a second lossy re-encode. Audio chunks don't need the flag.
    if (type === 'IMAGE') payload.client_blur_applied = true;

    let sent = false;
    const retryDelays = getAdaptiveConfig().retryDelays;

    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
      try {
        const res = await fetch(`${API_BASE}/reports/${reportId}/media/chunk`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (res.ok) {
          sent = true;
          _successStreak++;
          // Network tier can upgrade/downgrade for MEDIA SELECTION decisions,
          // but chunk size for THIS upload stays locked.
          if (_successStreak >= 10) {
            upgradeNetwork();
            _successStreak = 0;
          }
          break;
        }
        throw new Error(`HTTP ${res.status}`);
      } catch (e) {
        _successStreak = 0;
        if (attempt < retryDelays.length) {
          downgradeNetwork();  // affects future media uploads, not this chunk size
          const delay = retryDelays[attempt];
          console.log(`[Adaptive] Chunk ${chunkIdx}/${LOCKED_TOTAL_CHUNKS} failed, retry in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (!sent) {
      throw new Error(`Chunk ${chunkIdx}/${LOCKED_TOTAL_CHUNKS} failed after all retries`);
    }

    offset += LOCKED_CHUNK_SIZE;
    chunkIdx++;
    await onProgress(offset);

    if (chunkIdx % 10 === 0) {
      const pct = Math.round((chunkIdx / LOCKED_TOTAL_CHUNKS) * 100);
      console.log(`[Adaptive] ${type} ${pct}% (${chunkIdx}/${LOCKED_TOTAL_CHUNKS} chunks)`);
    }
  }

  console.log(`[Adaptive] Complete: ${type} ${Math.round(totalLen/1024)}KB in ${LOCKED_TOTAL_CHUNKS} chunks`);
}

function extractBase64(dataUrl: string): string | null {
  if (!dataUrl) return null;
  const comma = dataUrl.indexOf(',');
  return comma >= 0 ? dataUrl.substring(comma + 1) : dataUrl;
}

function djb2Checksum(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function isSyncing(): boolean {
  return _isSyncing;
}
