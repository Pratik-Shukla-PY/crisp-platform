/**
 * V4ReviewScreen.test.ts — Phase 5 RN ↔ PWA parity smoke tests.
 *
 * Static module + i18n contract tests for screens/V4ReviewScreen.tsx.
 * Same pattern as HomeScreen + V4CaptureScreen + V4ClassifyScreen —
 * pins module-level exports + every key the component touches via t(...).
 *
 * Phase 5 is the App Store-submission gate. The review screen
 * surfaces every captured field + every UNDP-rubric follow-up
 * detail before Send, so the key set is the broadest in the
 * RN parity test suite.
 */

jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: () => null,
  Svg: () => null,
  Path: () => null,
  Circle: () => null,
  Polyline: () => null,
  Line: () => null,
  Polygon: () => null,
  Rect: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Stop: () => null,
  G: () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('V4ReviewScreen — module shape + i18n contract', () => {
  it('default export is a function (renderable component)', () => {
    const mod = require('../screens/V4ReviewScreen');
    expect(typeof mod.default).toBe('function');
  });

  // Required keys the V4ReviewScreen reads via t(...).
  const REQUIRED_KEYS = [
    // Header + progress
    'aria_back',
    'v4_step_3_of_3',

    // Captured strip
    'v4_cap_photo',
    'v4_cap_voice',
    'v4_cap_text',
    'v4_locating',

    // Voice/text drawer
    'v4_add_voice_text',
    'v4_record',
    'audio_recorded',
    'placeholder_short_description',

    // UNDP details — debris + service status
    'v4_undp_modules',
    'v4_debris',
    'v4_yes',
    'v4_no',
    'v4_electricity',
    'water_svc',
    'v4_health',
    'v4_working',
    'v4_intermittent',
    'v4_not_op',
    'v4_unknown',

    // Pressing needs
    'v4_needs',
    'need_food_water',
    'need_cash',
    'need_health',
    'need_shelter',
    'need_livelihoods',
    'need_wash',
    'need_basic_services',
    'need_protection',
    'need_local_support',
    'need_other',

    // Send + sending state
    'v4_send',
    'upload_sending',
  ];

  it('every required key resolves to a non-empty string in en', () => {
    const en = require('../services/i18n/en.json');
    for (const key of REQUIRED_KEYS) {
      expect(typeof en[key]).toBe('string');
      expect(en[key].length).toBeGreaterThan(0);
    }
  });

  it.each([
    ['ar'], ['zh'], ['fr'], ['ru'], ['es'],            // UN tier-1
    ['hi'], ['pt'], ['bn'], ['ja'], ['tr'],            // tier-2
    ['vi'], ['ko'], ['id'], ['ur'],
    ['kn'], ['ta'], ['te'], ['ml'], ['gu'],            // tier-3
    ['mr'], ['pa'],
  ])('every required key is present in %s locale (parity check)', (code) => {
    const pack = require(`../services/i18n/${code}.json`);
    for (const key of REQUIRED_KEYS) {
      expect(typeof pack[key]).toBe('string');
      expect(pack[key].length).toBeGreaterThan(0);
    }
  });
});
