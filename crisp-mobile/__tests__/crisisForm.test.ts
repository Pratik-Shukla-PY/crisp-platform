/**
 * assembleCrisisForm — RN→PWA V4 parity (RNV4-P2). Pins the Dynamic Crisis Forms
 * submit payload to the PWA's behaviour: form_data = maps_to fields sourced from
 * canonical state ∪ the user's pack answers; all three fields null on the default
 * flow so a standard report is byte-identical (UNDP must-have #1).
 */
import {
  assembleCrisisForm,
  crisisPackRenderableFields,
  crisisPackRequiredAnswered,
  crisisPackClassifyOrder,
} from '../services/crisisForm';

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

describe('crisisPackRenderableFields (RNV4-P3 — which fields the renderer draws)', () => {
  const pack = {
    schema: {
      sections: [
        {
          fields: [
            // chip-captured maps_to → excluded (the hardcoded chips own these)
            { key: 'crisis_type', type: 'single_select', maps_to: 'crisis_type' },
            { key: 'damage_classification', type: 'single_select', maps_to: 'damage_classification' },
            { key: 'severity', type: 'severity', maps_to: 'severity' },
            // special non-base types → excluded (captured elsewhere)
            { key: 'photo', type: 'photo' },
            { key: 'where', type: 'location' },
            { key: 'bldg', type: 'building' },
            // base-type, no maps_to → KEPT
            { key: 'flames_visible', type: 'yes_no' },
            { key: 'smoke_density', type: 'single_select', options: [{ value: 'LIGHT' }] },
            { key: 'notes', type: 'long_text' },
            { key: 'people', type: 'integer' },
            // base-type, maps_to OUTSIDE the captured set → KEPT
            { key: 'debris_clearing_needed', type: 'yes_no', maps_to: 'debris_clearing_needed' },
            // junk → ignored
            { type: 'yes_no' },          // no key
            null,
          ],
        },
      ],
    },
  };

  test('keeps base-type fields whose maps_to is not chip-captured; drops the rest', () => {
    const keys = crisisPackRenderableFields(pack as any).map((f) => f.key);
    expect(keys).toEqual([
      'flames_visible', 'smoke_density', 'notes', 'people', 'debris_clearing_needed',
    ]);
  });

  test('null/empty pack → empty array', () => {
    expect(crisisPackRenderableFields(null)).toEqual([]);
    expect(crisisPackRenderableFields({} as any)).toEqual([]);
    expect(crisisPackRenderableFields({ schema: {} } as any)).toEqual([]);
  });
});

describe('crisisPackRequiredAnswered (RNV4-P3 — Continue gate)', () => {
  const fields = [
    { key: 'opt', type: 'short_text' },                         // not required
    { key: 'yn', type: 'yes_no', required: true },
    { key: 'ms', type: 'multi_select', required: true },
    { key: 'txt', type: 'short_text', required: true },
    { key: 'n', type: 'integer', required: true },
  ];

  test('all required answered (yes_no=false counts) → true', () => {
    expect(crisisPackRequiredAnswered(fields, {
      yn: false, ms: ['A'], txt: 'hi', n: 0,
    })).toBe(true);
  });

  test('missing yes_no → false', () => {
    expect(crisisPackRequiredAnswered(fields, { ms: ['A'], txt: 'hi', n: 0 })).toBe(false);
  });

  test('empty multi_select array → false; empty/whitespace text → false', () => {
    expect(crisisPackRequiredAnswered(fields, { yn: true, ms: [], txt: 'hi', n: 1 })).toBe(false);
    expect(crisisPackRequiredAnswered(fields, { yn: true, ms: ['A'], txt: '   ', n: 1 })).toBe(false);
  });

  test('no fields / no required fields → true', () => {
    expect(crisisPackRequiredAnswered([], {})).toBe(true);
    expect(crisisPackRequiredAnswered([{ key: 'x', type: 'short_text' }], {})).toBe(true);
  });
});

describe('crisisPackClassifyOrder (RNV4-P3 — dynamic sub-step order)', () => {
  const extraFields = [{ fields: [{ key: 'flames_visible', type: 'yes_no' }] }];

  test('no pack → default 3-step chip order', () => {
    expect(crisisPackClassifyOrder(null)).toEqual(['damage', 'infra', 'crisis']);
    expect(crisisPackClassifyOrder({} as any)).toEqual(['damage', 'infra', 'crisis']);
  });

  test('canonical pack type + extra fields → skip crisis, append crisispack', () => {
    expect(crisisPackClassifyOrder({
      crisis_type: 'WILDFIRE', schema: { sections: extraFields },
    } as any)).toEqual(['damage', 'infra', 'crisispack']);
  });

  test('non-canonical/absent pack type → keep crisis chip step', () => {
    expect(crisisPackClassifyOrder({
      crisis_type: null, schema: { sections: extraFields },
    } as any)).toEqual(['damage', 'infra', 'crisis', 'crisispack']);
  });

  test('active pack but no renderable fields → no crisispack step', () => {
    expect(crisisPackClassifyOrder({
      crisis_type: 'FLOOD',
      schema: { sections: [{ fields: [{ key: 'crisis_type', type: 'single_select', maps_to: 'crisis_type' }] }] },
    } as any)).toEqual(['damage', 'infra']);
  });
});
