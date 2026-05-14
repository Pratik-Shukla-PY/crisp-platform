/**
 * HomeScreen.test.ts — Phase 2 RN ↔ PWA parity smoke tests.
 *
 * Static module + i18n smoke tests for screens/HomeScreen.tsx.
 * Deliberately avoids JSX-rendering tests (jest-expo doesn't ship
 * @babel/preset-react so .tsx files with JSX don't transform; the
 * existing test suite is all `.ts` for this reason). Rendering
 * coverage is via Maestro / Detox / manual smoke instead.
 *
 * What this guards:
 *   · HomeScreen default export is a function (renderable component)
 *   · Required i18n keys all resolve to non-empty strings in en
 *   · Required i18n keys are present in every shipped locale (no
 *     gaps in the user-visible string set across the 22-locale matrix)
 *
 * These are CONTRACT tests, not visual tests: if any required key
 * disappears or any locale loses its translation, this fails fast.
 */

// Mock react-native-svg + safe-area context so importing HomeScreen
// doesn't try to require platform-native modules in Node.
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: () => null,
  Svg: () => null,
  Rect: () => null,
  Circle: () => null,
  Defs: () => null,
  LinearGradient: () => null,
  RadialGradient: () => null,   // v5 Phase 2 — BgRadial + HeroGlowBlob
  Stop: () => null,
  Path: () => null,
  G: () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('HomeScreen — module shape + i18n contract', () => {
  it('default export is a function (renderable component)', () => {
    const mod = require('../screens/HomeScreen');
    expect(typeof mod.default).toBe('function');
  });

  it('exports the HomeScreenProps type (compile-time check)', () => {
    // If HomeScreenProps is removed or renamed, the import below would
    // fail TS compilation at the test author's site too. We can't
    // assert it at runtime (types erase), but requiring the module
    // proves the .tsx compiles.
    const mod = require('../screens/HomeScreen');
    expect(mod.default).toBeDefined();
  });

  // ── Required keys the HomeScreen component reads via t(...) ──
  const REQUIRED_KEYS = [
    'home_cta_primary',
    'home_cta_sub',
    'home_cta_helper',                  // v5 Phase 1 — reassurance helper
    'home_consent_v2',
    'action_tile_login',
    'home_login_icon_signed_in',
    'my_reports',
    'rewards_btn',
    'action_tile_audio',
    'action_tile_download',
    'home_channels_title',
    'home_footer_privacy',
    'home_footer_opensrc',
    'home_footer_help',
    'sync_queued',
    'aria_tap_change_language',
    'badge_chip_lives_stat',
    'tier_t1_scout_label',
    'tier_t2_signal_label',
    'tier_t3_changemaker_label',
    'tier_t4_lifekeeper_label',
    'tier_progress_first_report',
    'tier_progress_verified_1',
    'tier_progress_lives_1',
    'tier_progress_top_share',
    // v5 Phase 3 — pulse stat block
    'home_metric_lives',
    'home_pulse_label',
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

  it('en has at least 688 keys (matches PWA canonical pack)', () => {
    const en = require('../services/i18n/en.json');
    expect(Object.keys(en).length).toBeGreaterThanOrEqual(688);
  });

  // ── v5 redesign — Phase 1 + 3 i18n contract for new keys ─────────
  describe('v5 home redesign — new key contract', () => {
    it('home_cta_helper carries an offline-related English string', () => {
      const en = require('../services/i18n/en.json');
      const v = (en.home_cta_helper || '').toLowerCase();
      expect(v).toContain('offline');
    });

    it('home_pulse_label carries verification language in English', () => {
      const en = require('../services/i18n/en.json');
      const v = (en.home_pulse_label || '').toLowerCase();
      expect(v).toMatch(/verified|reports/);
    });
  });
});
