/**
 * nearbyApi — RN client for /api/v1/reports/nearby (May 2026).
 *
 * Mirrors the PWA's mobile-app/src/nearby.js behaviour matrix:
 *
 *   Connectivity  GPS         Cache               Render?
 *   ────────────  ────────    ─────────────────   ──────────────────
 *   online        granted     live API            YES (full list)
 *   online        granted     empty 200           YES (empty state)
 *   online        denied      —                   HIDDEN
 *   offline       granted     fresh < 5 min       OPTIONAL (cached)
 *   offline       —           stale / none        HIDDEN
 *   any           any         API error           HIDDEN (silent fail)
 *
 * The module NEVER triggers a GPS prompt on the home screen — caller
 * supplies the already-cached location (typically from
 * App.tsx's location state set by the v4 capture flow).
 *
 * Privacy:
 *   ✓ Lat/lng rounded to 3 decimals (~110 m) before sending
 *   ✓ Endpoint response carries no PII (server-side projection)
 *   ✓ Cached payload is PII-free (same projection)
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { getApiBase } from './api';

// ── Wire types — must match backend/app/schemas/report.py ─────────────

export interface NearbyGroup {
  id: string;
  kind: 'building' | 'crisis_cluster';
  label: string;
  summary: string;
  summary_key: string;
  count: number;
  verified_count: number;
  pending_count: number;
  approx_distance_km: number;
  centroid_lat: number;
  centroid_lng: number;
  latest_at: string;       // ISO 8601
  earliest_at: string;     // ISO 8601
  crisis_types: string[];
  damage_classes: string[];
  severity_max: string;
}

export interface NearbyResponse {
  user_location: { lat: number; lng: number };
  radius_km: number;
  as_of: string;
  groups: NearbyGroup[];
  total_groups: number;
  total_reports: number;
}

// ── Configuration ────────────────────────────────────────────────────

export const DEFAULT_RADIUS_KM = 5;
export const DEFAULT_LIMIT = 20;
export const CACHE_TTL_MS = 5 * 60 * 1000;
const AS_KEY = 'crisp_nearby_cache_v1';
const REQUEST_TIMEOUT_MS = 6_000;

// ── Privacy helper — 3dp rounding before the request leaves the device.
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ── Cache layer (AsyncStorage) ───────────────────────────────────────

export interface CachedNearby {
  payload: NearbyResponse;
  fetchedAt: number;     // epoch ms
  lat: number;
  lng: number;
  radius_km: number;
}

export async function readCache(): Promise<CachedNearby | null> {
  try {
    const raw = await AsyncStorage.getItem(AS_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as CachedNearby;
  } catch { return null; }
}

export async function writeCache(c: CachedNearby): Promise<void> {
  try { await AsyncStorage.setItem(AS_KEY, JSON.stringify(c)); }
  catch { /* best-effort */ }
}

export async function clearCache(): Promise<void> {
  try { await AsyncStorage.removeItem(AS_KEY); } catch { /* ignore */ }
}

// ── Fetch ────────────────────────────────────────────────────────────

export interface NearbyQuery {
  lat: number;
  lng: number;
  radius_km?: number;
  limit?: number;
  /** If true, skip the request and return cache (or null) immediately. */
  offlineOnly?: boolean;
}

export async function fetchNearby(q: NearbyQuery): Promise<NearbyResponse | null> {
  if (q.offlineOnly) return null;
  const url = new URL(`${getApiBase()}/reports/nearby`);
  url.searchParams.set('lat', String(round3(q.lat)));
  url.searchParams.set('lng', String(round3(q.lng)));
  url.searchParams.set('radius_km', String(q.radius_km ?? DEFAULT_RADIUS_KM));
  url.searchParams.set('limit', String(q.limit ?? DEFAULT_LIMIT));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), { signal: ctrl.signal });
    if (!res.ok) return null;
    const json: NearbyResponse = await res.json();
    // Persist on success so the offline path has data later.
    await writeCache({
      payload: json,
      fetchedAt: Date.now(),
      lat: round3(q.lat),
      lng: round3(q.lng),
      radius_km: q.radius_km ?? DEFAULT_RADIUS_KM,
    });
    return json;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/**
 * Composite read path — tries network first (when online), falls
 * back to fresh cache. Returns null when neither path produces a
 * usable payload (the component then hides the module).
 */
export interface LoadResult {
  payload: NearbyResponse | null;
  fromCache: boolean;
  cacheAgeMs: number | null;
}

export async function loadNearby(opts: {
  lat: number;
  lng: number;
  online: boolean;
  radius_km?: number;
  limit?: number;
}): Promise<LoadResult> {
  let payload: NearbyResponse | null = null;
  let fromCache = false;
  let cacheAgeMs: number | null = null;

  if (opts.online) {
    payload = await fetchNearby({
      lat: opts.lat, lng: opts.lng,
      radius_km: opts.radius_km, limit: opts.limit,
    });
  }
  if (!payload) {
    const cached = await readCache();
    if (cached && cached.payload && cached.fetchedAt) {
      const age = Date.now() - cached.fetchedAt;
      if (age <= CACHE_TTL_MS) {
        payload = cached.payload;
        fromCache = true;
        cacheAgeMs = age;
      }
    }
  }
  return { payload, fromCache, cacheAgeMs };
}

// ── Time helper — used by the component to render "5 min ago" etc.
export function humanizeAgo(iso: string, t: (k: string, fb: string) => string): string {
  if (!iso) return '';
  const ts = new Date(iso).getTime();
  if (!isFinite(ts)) return '';
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (mins < 60) {
    return t('nearby_minutes_ago', '{n} min ago').replace('{n}', String(mins));
  }
  const hrs = Math.round(mins / 60);
  return t('nearby_hours_ago', '{n} hr ago').replace('{n}', String(hrs));
}
