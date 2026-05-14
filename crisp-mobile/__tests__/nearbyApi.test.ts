/**
 * nearbyApi.test.ts — RN "Verified Reports Nearby" service unit tests.
 *
 * Pure logic — `round3`, `humanizeAgo`, cache TTL behaviour. The
 * fetch + AsyncStorage paths are best covered with integration tests
 * (Maestro / Detox); these tests pin the helpers that are easy to
 * regress silently.
 */

// Mock AsyncStorage at the module surface so loadCache / writeCache
// resolve without trying to access a native module under jest-node.
jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => store[k] ?? null),
      setItem: jest.fn(async (k: string, v: string) => { store[k] = v; }),
      removeItem: jest.fn(async (k: string) => { delete store[k]; }),
      __reset: () => { store = {}; },
    },
  };
});

import {
  round3, humanizeAgo,
  readCache, writeCache, clearCache,
  type CachedNearby,
} from '../services/nearbyApi';

describe('round3 — privacy rounding on the wire', () => {
  test('rounds to 3 decimals', () => {
    expect(round3(12.971586)).toBe(12.972);
    expect(round3(77.594103)).toBe(77.594);
  });
  test('preserves sign', () => {
    expect(round3(-12.971586)).toBe(-12.972);
  });
  test('integer pass-through', () => {
    expect(round3(45)).toBe(45);
  });
});

describe('humanizeAgo', () => {
  // Provide a deterministic _t that just returns the fallback.
  const _t = (_k: string, fb: string) => fb;

  test('< 60 min → minutes string', () => {
    const isoFive = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(humanizeAgo(isoFive, _t)).toBe('5 min ago');
  });

  test('= 60 min boundary rounds to 1 hr', () => {
    const isoHour = new Date(Date.now() - 60 * 60_000).toISOString();
    expect(humanizeAgo(isoHour, _t)).toBe('1 hr ago');
  });

  test('> 60 min → hours string', () => {
    const iso3h = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    expect(humanizeAgo(iso3h, _t)).toBe('3 hr ago');
  });

  test('empty / invalid input → empty string', () => {
    expect(humanizeAgo('', _t)).toBe('');
    expect(humanizeAgo('not-an-iso', _t)).toBe('');
  });
});

describe('cache layer', () => {
  beforeEach(async () => { await clearCache(); });

  test('round-trip — write then read', async () => {
    const c: CachedNearby = {
      payload: {
        user_location: { lat: 12.972, lng: 77.594 },
        radius_km: 5,
        as_of: new Date().toISOString(),
        groups: [], total_groups: 0, total_reports: 0,
      },
      fetchedAt: Date.now(),
      lat: 12.972, lng: 77.594, radius_km: 5,
    };
    await writeCache(c);
    const back = await readCache();
    expect(back).not.toBeNull();
    expect(back!.lat).toBe(12.972);
    expect(back!.payload.total_groups).toBe(0);
  });

  test('clearCache wipes entry', async () => {
    await writeCache({
      payload: { user_location: { lat: 0, lng: 0 }, radius_km: 1, as_of: '', groups: [], total_groups: 0, total_reports: 0 },
      fetchedAt: 1, lat: 0, lng: 0, radius_km: 1,
    });
    await clearCache();
    expect(await readCache()).toBeNull();
  });
});
