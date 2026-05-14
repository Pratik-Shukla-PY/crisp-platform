/**
 * NearbyReports.test.ts — RN module + i18n contract smoke tests.
 *
 * Same pattern as HomeScreen.test.ts: module-shape + i18n key
 * presence across 22 locales. JSX rendering is covered by manual
 * smoke + Phase 2 Maestro flows.
 */
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: () => null,
  Svg: () => null, Rect: () => null, Circle: () => null,
  Defs: () => null, LinearGradient: () => null, RadialGradient: () => null,
  Stop: () => null, Path: () => null, G: () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => undefined),
    removeItem: jest.fn(async () => undefined),
  },
}));

describe('NearbyReports — module shape', () => {
  it('default export is a function (renderable component)', () => {
    const mod = require('../components/NearbyReports');
    expect(typeof mod.default).toBe('function');
  });
});

describe('NearbyReports — i18n contract', () => {
  // The keys NearbyReports + nearbyApi reach for. Must be present
  // (non-empty string) in every shipped locale.
  const REQUIRED_KEYS = [
    'nearby_eyebrow',
    'nearby_view_more',
    'nearby_all_clear',
    'nearby_no_reports',
    'nearby_count_reports',
    'nearby_verified_badge',
    'nearby_pending_badge',
    'nearby_distance_km',
    'nearby_minutes_ago',
    'nearby_hours_ago',
    'nearby_last_seen',
    // Summary matrix
    'nearby_summary_flood_partial',
    'nearby_summary_quake_complete',
    'nearby_summary_fire_partial',
    'nearby_summary_blast_partial',
    'nearby_summary_unrest_partial',
    'nearby_summary_generic_partial',
    'nearby_summary_unknown',
  ];

  it('every required key resolves to a non-empty string in en', () => {
    const en = require('../services/i18n/en.json');
    for (const key of REQUIRED_KEYS) {
      expect(typeof en[key]).toBe('string');
      expect(en[key].length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['ar'], ['zh'], ['fr'], ['ru'], ['es'],
    ['hi'], ['pt'], ['bn'], ['ja'], ['tr'],
    ['vi'], ['ko'], ['id'], ['ur'],
    ['kn'], ['ta'], ['te'], ['ml'], ['gu'],
    ['mr'], ['pa'],
  ])('every required key is present in %s locale (parity check)', (code) => {
    const pack = require(`../services/i18n/${code}.json`);
    for (const key of REQUIRED_KEYS) {
      expect(typeof pack[key]).toBe('string');
      expect(pack[key].length).toBeGreaterThan(0);
    }
  });
});
