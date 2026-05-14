/**
 * V4CaptureScreen.test.ts — Phase 3 RN ↔ PWA parity smoke tests.
 *
 * Static module + i18n contract tests for screens/V4CaptureScreen.tsx.
 * Same approach as HomeScreen.test.ts — doesn't render the component
 * (jest-expo's babel transform doesn't ship preset-react), but pins:
 *   · default export is a function (renderable component)
 *   · required i18n keys all resolve to non-empty strings in en
 *   · same keys are present in every shipped locale (parity-drift guard)
 *
 * Live rendering coverage is via Maestro / manual smoke.
 */

// Mock platform-native modules that V4CaptureScreen imports.
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: () => null,
  Svg: () => null,
  Path: () => null,
  Circle: () => null,
  Polyline: () => null,
  Rect: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  Stop: () => null,
  G: () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('V4CaptureScreen — module shape + i18n contract', () => {
  it('default export is a function (renderable component)', () => {
    const mod = require('../screens/V4CaptureScreen');
    expect(typeof mod.default).toBe('function');
  });

  // Required keys the V4CaptureScreen component reads via t(...)
  const REQUIRED_KEYS = [
    // Header
    'aria_back',
    'v4_step_1_of_3',
    // Meta
    'v4_locating',
    // Title
    'v4_cap_show_what_you_see',
    // Photo section
    'v4_cap_photo',
    'v4_cap_photo_sub',
    'chooser_camera',
    'chooser_gallery',
    // Extras
    'v4_cap_extras_label',
    'v4_cap_voice',
    'v4_cap_text',
    'v4_record',
    'v4_cap_voice_hint',
    'placeholder_describe_short',
    // Tips card
    'v4_cap_tips_eyebrow',
    'v4_cap_tip_photo',
    'v4_cap_tip_voice',
    'v4_cap_tip_text',
    'v4_cap_tip_impact',
    // Footer
    'v4_continue',
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
