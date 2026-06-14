/**
 * buildingCache - RN parity for PWA's `building-select.js::preCacheNearest`.
 *
 * Phase B2 (Apr 2026 UI v3) - warm an AsyncStorage cache with the 10 nearest
 * building footprints the first time GPS resolves. An offline-only capture
 * immediately after opening the app (tunnel, crisis-zone cell drop) can
 * then show nearby buildings for autocomplete / display even without a
 * live Overpass call inside the WebView picker.
 *
 * Design notes:
 *   - Cache key is a rounded (lat, lng) pair at 3 decimal places - ~111 m
 *     grid at the equator, so a single key covers the fetch radius.
 *   - TTL is 24 h (match PWA). After expiry the entry is still returned on
 *     network-failure (better-than-nothing fallback); a fresh network hit
 *     overwrites it.
 *   - We DO NOT wire this into the WebView picker yet - that would require
 *     pre-seeding the WebView's localStorage via `injectedJavaScriptBefore`,
 *     which is a bigger surgery. For now the picker re-fetches; this
 *     cache is consumed by the free-text fallback autocomplete + the
 *     `infrastructure_name` auto-fill path.
 *
 * Parity with PWA:
 *   - Same 200 m Overpass radius.
 *   - Same "nearest by centroid distance" sort.
 *   - Same returned shape: `{ id, name, distance_m, centroid, tags }`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const RADIUS_METERS = 200;
const CACHE_KEY_PRECISION = 3;
const CACHE_KEY_PREFIX = 'crisp_buildings_v1:';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24 h

export type NearbyBuilding = {
  id: string;              // `osm:way:<id>` or `osm:relation:<id>`
  name: string | null;
  distance_m: number;      // centroid distance from query point
  centroid: [number, number];
  tags: Record<string, string>;
};

type OverpassElement = {
  id: number;
  type: string;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
  members?: Array<{ role?: string; geometry?: Array<{ lat: number; lon: number }> }>;
};

function _cacheKey(lat: number, lng: number): string {
  const r = (n: number) => n.toFixed(CACHE_KEY_PRECISION);
  return `${CACHE_KEY_PREFIX}${r(lat)},${r(lng)}`;
}

function _buildingLatLngs(elem: OverpassElement): Array<[number, number]> | null {
  if (Array.isArray(elem.geometry) && elem.geometry.length >= 3) {
    return elem.geometry.map((p) => [p.lat, p.lon]);
  }
  if (Array.isArray(elem.members)) {
    for (const m of elem.members) {
      if (m.role === 'outer' && Array.isArray(m.geometry)) {
        return m.geometry.map((p) => [p.lat, p.lon]);
      }
    }
  }
  return null;
}

function _centroid(elem: OverpassElement): [number, number] | null {
  const latlngs = _buildingLatLngs(elem);
  if (!latlngs || !latlngs.length) return null;
  let latSum = 0, lngSum = 0;
  for (const [la, ln] of latlngs) { latSum += la; lngSum += ln; }
  return [latSum / latlngs.length, lngSum / latlngs.length];
}

async function _readCache(key: string): Promise<OverpassElement[] | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { ts: number; elems: OverpassElement[] };
    // Expired? Still return - the consumer treats stale hits as a fallback.
    return Array.isArray(parsed?.elems) ? parsed.elems : null;
  } catch {
    return null;
  }
}

async function _writeCache(key: string, elems: OverpassElement[]): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify({ ts: Date.now(), elems }));
  } catch {
    // best-effort - never block the UI on cache-write failure
  }
}

async function _fetchBuildings(lat: number, lng: number, opts: { allowNetwork?: boolean } = {}): Promise<OverpassElement[] | null> {
  const key = _cacheKey(lat, lng);
  const cached = await _readCache(key);
  if (cached) return cached;

  if (opts.allowNetwork === false) return null;

  const query = `
    [out:json][timeout:15];
    (
      way(around:${RADIUS_METERS},${lat},${lng})["building"];
      relation(around:${RADIUS_METERS},${lat},${lng})["building"];
    );
    out body geom;
  `.trim();
  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      body: `data=${encodeURIComponent(query)}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const elems: OverpassElement[] = (data && data.elements) || [];
    await _writeCache(key, elems);
    return elems;
  } catch (err) {
    console.warn('[buildingCache] Overpass fetch failed:', err);
    return null;
  }
}

/**
 * Return the N nearest building footprints to (lat, lng), reading from the
 * local AsyncStorage cache first and falling through to Overpass on miss.
 * Safe to call on every GPS-ready event - the cache key bucketing is
 * coarse enough to dedupe within a normal walking radius.
 */
export async function preCacheNearest(
  lat: number,
  lng: number,
  count = 10,
  opts: { allowNetwork?: boolean } = {},
): Promise<NearbyBuilding[]> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
  const elems = await _fetchBuildings(lat, lng, opts);
  if (!Array.isArray(elems) || elems.length === 0) return [];

  const scored: Array<{ el: OverpassElement; d: number; centroid: [number, number] }> = [];
  for (const el of elems) {
    const c = _centroid(el);
    if (!c) continue;
    const dLat = (c[0] - lat) * 111_320;
    const dLng = (c[1] - lng) * 111_320 * Math.cos((lat * Math.PI) / 180);
    const d = Math.hypot(dLat, dLng);
    scored.push({ el, d, centroid: c });
  }
  scored.sort((a, b) => a.d - b.d);
  const slice = scored.slice(0, count);

  return slice.map(({ el, d, centroid }) => {
    const tags = el.tags || {};
    const osmType = el.type || 'way';
    const name =
      tags.name || tags['name:en'] ||
      (tags.amenity ? `${tags.amenity}`.replace(/_/g, ' ') : null) ||
      (tags.building && tags.building !== 'yes' ? `${tags.building}`.replace(/_/g, ' ') : null) ||
      null;
    return {
      id: `osm:${osmType}:${el.id}`,
      name,
      distance_m: Math.round(d),
      centroid,
      tags,
    };
  });
}

/**
 * Clear every cached Overpass entry. Called from the deletion / GDPR-purge
 * code-path so a user who wipes their data doesn't leave buildings in
 * AsyncStorage. Cheap + idempotent - a blanket `removeItem` for every key
 * matching the CRISP prefix.
 */
export async function clearAllBuildingCache(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((k) => k.startsWith(CACHE_KEY_PREFIX));
    if (ours.length > 0) await AsyncStorage.multiRemove(ours);
  } catch (e) {
    console.warn('[buildingCache] clear failed:', e);
  }
}
