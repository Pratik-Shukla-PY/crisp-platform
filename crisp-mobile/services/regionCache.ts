/**
 * CRISP Mobile — Region auto-submit geofence cache.
 *
 * Phase 4 (Apr 2026). Wraps GET /api/v1/regions/enabled with a 24-hour
 * AsyncStorage cache so the Start Report flow works offline — the user's
 * GPS is checked against the cached enabled-regions list to decide whether
 * to arm the 2-minute auto-submit countdown.
 *
 * Failure modes (all non-throwing — the caller always gets a usable array):
 *   - Network down + cache present → cached list.
 *   - Network down + cache absent  → empty list (timer never arms).
 *   - Cache present but > 24 h old → try network, fall back to stale cache
 *     if the network call also fails (offline deep-crisis scenario).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApiBase } from './api';

const CACHE_KEY = 'crisp_regions_enabled_v1';
const TTL_MS = 24 * 60 * 60 * 1000;   // 24 h

export interface Region {
  id: string;
  name: string;
  center_lat: number;
  center_lng: number;
  radius_meters: number;
}

interface CachedPayload {
  ts: number;
  data: Region[];
}

async function _readCache(): Promise<CachedPayload | null> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedPayload;
    if (!parsed || !Array.isArray(parsed.data) || typeof parsed.ts !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function _writeCache(data: Region[]): Promise<void> {
  try {
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    // AsyncStorage quota/IO errors are non-fatal — the next call will retry.
  }
}

/**
 * Return the list of auto-submit-enabled regions. Fresh network fetch when
 * possible; cached copy when offline; empty list as last resort.
 */
export async function getEnabledRegions(): Promise<Region[]> {
  const cached = await _readCache();
  const fresh = cached && Date.now() - cached.ts < TTL_MS;
  try {
    const res = await fetch(`${getApiBase()}/regions/enabled`);
    if (res.ok) {
      const data = (await res.json()) as Region[];
      await _writeCache(data);
      return data;
    }
  } catch {
    // network error — fall through to cache below
  }
  if (fresh) return cached.data;
  return cached?.data || [];
}

/** Haversine great-circle distance in kilometres. Matches the PWA/backend
 *  impl so client + server agree on "inside" / "outside". */
export function haversineKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number,
): number {
  const toRad = (x: number) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Find the first enabled region whose circle contains the given lat/lng.
 * Returns null when the user is outside every enabled zone or the enabled
 * list is empty.
 */
export function findActiveRegion(
  lat: number, lng: number, regions: Region[],
): Region | null {
  for (const r of regions) {
    const dKm = haversineKm(lat, lng, r.center_lat, r.center_lng);
    if (dKm * 1000 <= r.radius_meters) return r;
  }
  return null;
}
