/**
 * V4ClassifyScreen.test.ts — Phase 4 RN ↔ PWA parity smoke tests.
 *
 * Static module + i18n contract tests for screens/V4ClassifyScreen.tsx.
 * Doesn't render the JSX tree (jest-expo's babel transform lacks
 * preset-react for full renderering) — instead pins:
 *   · default export is a function
 *   · all required i18n keys resolve to non-empty strings in en
 *   · same keys present in every shipped locale (parity drift guard)
 *
 * Auto-progress timing + race-guard behaviour are covered by Maestro
 * E2E in Phase 7; this layer is the contract test.
 */

jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: () => null,
  Svg: () => null,
  Path: () => null,
  Circle: () => null,
  Line: () => null,
  Polygon: () => null,
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

describe('V4ClassifyScreen — module shape + i18n contract', () => {
  it('default export is a function (renderable component)', () => {
    const mod = require('../screens/V4ClassifyScreen');
    expect(typeof mod.default).toBe('function');
  });

  // Required keys the V4ClassifyScreen component reads via t(...)
  const REQUIRED_KEYS = [
    // Header + progress
    'aria_back',
    'v4_step_2_of_3',
    'v4_substep_how_bad',
    'v4_substep_what_hit',
    'v4_substep_what_caused',

    // Damage sub-view
    'v4_q_damage',
    'damage_minimal',
    'damage_partial',
    'damage_complete',
    'v4_damage_minimal_sub',
    'v4_damage_partial_sub',
    'v4_damage_complete_sub',

    // Infra sub-view
    'v4_q_infra',
    'v4_infra_res_label',
    'v4_infra_res_sub',
    'v4_infra_com_label',
    'v4_infra_com_sub',
    'v4_infra_gov_label',
    'v4_infra_gov_sub',
    'v4_infra_util_label',
    'v4_infra_util_sub',
    'v4_infra_trans_label',
    'v4_infra_trans_sub',
    'v4_infra_comm_label',
    'v4_infra_comm_sub',
    'v4_infra_pub_label',
    'v4_infra_pub_sub',
    'v4_infra_other_label',
    'v4_infra_other_sub',
    'v4_infra_other_prompt',
    'v4_infra_other_placeholder',

    // Crisis sub-view
    'v4_q_crisis',
    'v4_cause_natural',
    'v4_cause_tech',
    'v4_cause_human',
    'crisis_earthquake',
    'crisis_flood',
    'crisis_tsunami',
    'crisis_hurricane',
    'crisis_wildfire',
    'crisis_explosion',
    'crisis_chemical',
    'crisis_conflict',
    'crisis_unrest',
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
