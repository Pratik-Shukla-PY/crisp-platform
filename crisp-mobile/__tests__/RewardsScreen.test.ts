/**
 * RewardsScreen.test.ts — Phase 6 RN ↔ PWA parity smoke tests.
 * Static module + i18n contract for the Rewards / Badge Studio
 * surface. Renders not asserted (consistent with the other
 * parity screens' contract tests).
 */
jest.mock('react-native-svg', () => ({
  __esModule: true, default: () => null,
  Svg: () => null, Path: () => null, Circle: () => null,
  Polyline: () => null, Line: () => null, Polygon: () => null,
  Rect: () => null, Defs: () => null, LinearGradient: () => null,
  Stop: () => null, G: () => null,
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('RewardsScreen — module shape + i18n contract', () => {
  it('default export is a function', () => {
    const mod = require('../screens/RewardsScreen');
    expect(typeof mod.default).toBe('function');
  });

  const REQUIRED_KEYS = [
    'aria_back',
    'rewards_btn',
    // Tier labels + descriptions
    'tier_t1_scout_label',  'tier_t1_scout_desc',
    'tier_t2_signal_label', 'tier_t2_signal_desc',
    'tier_t3_changemaker_label', 'tier_t3_changemaker_desc',
    'tier_t4_lifekeeper_label',  'tier_t4_lifekeeper_desc',
    // Tier progress + stats
    'tier_progress_first_report',
    'tier_progress_verified_1',
    'tier_progress_lives_1',
    'tier_progress_top_share',
    'badge_chip_lives_stat',
    // Badge Studio: share-message picker (8 + surprise)
    'badge_studio_pick_message',
    'bs_message_surprise',
    'bs_message_1', 'bs_message_2', 'bs_message_3', 'bs_message_4',
    'bs_message_5', 'bs_message_6', 'bs_message_7', 'bs_message_8',
    // Share buttons + preview + lock
    'badge_studio_share_wa',
    'badge_studio_share_li',
    'badge_studio_share_more',
    'badge_studio_preview_label',
    'badge_studio_lock_t1_t2',
    'badge_studio_lock_t1_t2_desc',
    // Footer stats
    'rewards_stats_reports',
    'rewards_stats_dispatched',
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
  ])('every required key is present in %s locale', (code) => {
    const pack = require(`../services/i18n/${code}.json`);
    for (const key of REQUIRED_KEYS) {
      expect(typeof pack[key]).toBe('string');
      expect(pack[key].length).toBeGreaterThan(0);
    }
  });
});
