/**
 * assembleCrisisForm — RN→PWA V4 parity (RNV4-P2). Pins the Dynamic Crisis Forms
 * submit payload to the PWA's behaviour: form_data = maps_to fields sourced from
 * canonical state ∪ the user's pack answers; all three fields null on the default
 * flow so a standard report is byte-identical (UNDP must-have #1).
 */
import { assembleCrisisForm } from '../services/crisisForm';

describe('assembleCrisisForm (RNV4-P2 crisis-pack submit parity)', () => {
  const canonical = {
    damage_classification: 'COMPLETE',
    infrastructure_type: 'RESIDENTIAL',
    crisis_type: 'WILDFIRE',
    severity: 'SEVERE',
  };
  const pack = {
    pack_id: 'pk-wildfire',
    pack_version: 3,
    schema: {
      sections: [
        {
          fields: [
            { key: 'crisis_type', type: 'single_select', maps_to: 'crisis_type' },
            { key: 'damage_classification', type: 'single_select', maps_to: 'damage_classification' },
            { key: 'flames_visible', type: 'yes_no' },
            { key: 'smoke_density', type: 'single_select' },
            // maps_to NOT in the chip-captured set → sourced from the pack answer.
            { key: 'debris_clearing_needed', type: 'yes_no', maps_to: 'debris_clearing_needed' },
          ],
        },
      ],
    },
  };

  test('default flow (no pack) → all three null', () => {
    expect(assembleCrisisForm(null, canonical, {})).toEqual({
      form_pack_id: null, form_pack_version: null, form_data: null,
    });
  });

  test('active pack → maps_to from canonical ∪ stock answers + pack id/version', () => {
    const r = assembleCrisisForm(pack as any, canonical, {
      flames_visible: true, smoke_density: 'HEAVY', debris_clearing_needed: false,
    });
    expect(r.form_pack_id).toBe('pk-wildfire');
    expect(r.form_pack_version).toBe(3);
    // chip-captured maps_to → from canonical state (NOT the pack answers)
    expect(r.form_data!.crisis_type).toBe('WILDFIRE');
    expect(r.form_data!.damage_classification).toBe('COMPLETE');
    // stock questions → from the pack answers
    expect(r.form_data!.flames_visible).toBe(true);
    expect(r.form_data!.smoke_density).toBe('HEAVY');
    // maps_to outside the chip-captured set → from the pack answer (false kept)
    expect(r.form_data!.debris_clearing_needed).toBe(false);
  });

  test('pack present but no answered fields → all null (never an empty form_data)', () => {
    const emptyPack = { pack_id: 'p', pack_version: 1, schema: { sections: [{ fields: [{ key: 'flames_visible', type: 'yes_no' }] }] } };
    expect(assembleCrisisForm(emptyPack as any, {}, {})).toEqual({
      form_pack_id: null, form_pack_version: null, form_data: null,
    });
  });

  test('skips empty string + empty array, keeps boolean false', () => {
    const p = { pack_id: 'p', pack_version: 1, schema: { sections: [{ fields: [
      { key: 'a', type: 'short_text' }, { key: 'b', type: 'multi_select' }, { key: 'c', type: 'yes_no' },
    ] }] } };
    const r = assembleCrisisForm(p as any, {}, { a: '', b: [], c: false });
    expect(r.form_data).toEqual({ c: false });   // a='' + b=[] dropped; c=false kept
    expect(r.form_pack_id).toBe('p');
  });
});
