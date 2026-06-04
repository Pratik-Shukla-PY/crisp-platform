/**
 * crisisForm.ts — pure assembly of the Dynamic Crisis Forms submit payload.
 *
 * Mirror of the PWA's form_data assembly (mobile-app/src/app.js, _submitReportInner):
 * when a geo-gated crisis pack is active, build form_data by walking the pack
 * schema's fields — each maps_to field (damage/infra/crisis/severity) is sourced
 * from the canonical state the default chips already captured; every other field
 * comes from the user's pack answers. Returns all-null on the default flow (no
 * pack, or no answered fields) so the report is byte-identical to a standard one
 * (UNDP must-have #1). Kept pure (no React / no I/O) so it's unit-testable.
 */

export interface CrisisPack {
  pack_id?: string | null;
  pack_version?: number | null;
  event_id?: string | null;
  crisis_type?: string | null;
  schema?: { sections?: Array<{ fields?: any[] }> } | null;
}

export interface CrisisFormResult {
  form_pack_id: string | null;
  form_pack_version: number | null;
  form_data: Record<string, any> | null;
}

// maps_to values captured by the hardcoded classify chips — sourced from
// canonical state, not the pack answers. Matches the PWA's _DEFAULT_CAPTURED.
const DEFAULT_CAPTURED: Record<string, boolean> = {
  damage_classification: true,
  infrastructure_type: true,
  crisis_type: true,
  severity: true,
};

const EMPTY: CrisisFormResult = { form_pack_id: null, form_pack_version: null, form_data: null };

// Base field types the renderer can draw (special types — photo/audio/location/
// building/severity — are captured elsewhere). Matches the PWA's _CP_BASE_TYPES.
const BASE_TYPES: Record<string, boolean> = {
  yes_no: true, single_select: true, multi_select: true, short_text: true, long_text: true, integer: true,
};

/** The crisis-pack fields the DynamicModuleRenderer should draw: base-type
 *  fields whose maps_to isn't already captured by the hardcoded classify chips.
 *  Mirror of the PWA's _crisisPackFields (mobile-app/src/v4-flow.js). Pure. */
export function crisisPackRenderableFields(crisisPack: CrisisPack | null | undefined): any[] {
  if (!crisisPack || !crisisPack.schema) return [];
  const out: any[] = [];
  (crisisPack.schema.sections || []).forEach((sec) =>
    (sec.fields || []).forEach((f: any) => {
      if (!f || !f.key || !BASE_TYPES[f.type]) return;
      if (f.maps_to && DEFAULT_CAPTURED[f.maps_to]) return;
      out.push(f);
    }),
  );
  return out;
}

// Canonical CrisisTypeEnum values (must-have #5). When the active zone's pack
// carries one of these as crisis_type, the chip 'crisis' sub-step is skipped —
// the event already knows the type. Mirror of the PWA's _classifyOrder gate.
const CANON_CRISIS_TYPES: Record<string, boolean> = {
  EARTHQUAKE: true, FLOOD: true, TSUNAMI: true, CYCLONE: true, WILDFIRE: true,
  EXPLOSION: true, CHEMICAL_INCIDENT: true, CONFLICT: true, CIVIL_UNREST: true,
};

/** The V4 classify sub-step order. Mirror of the PWA's _classifyOrder
 *  (mobile-app/src/v4-flow.js). Default ['damage','infra','crisis']; with an
 *  active pack → drop 'crisis' when the zone auto-set a canonical crisis_type,
 *  and append 'crisispack' when the pack has questions the chips don't already
 *  capture. Pure — drives V4ClassifyScreen's `order`. */
export function crisisPackClassifyOrder(crisisPack: CrisisPack | null | undefined): string[] {
  if (!crisisPack || !crisisPack.schema) return ['damage', 'infra', 'crisis'];
  const order: string[] = ['damage', 'infra'];
  const packType = crisisPack.crisis_type;
  if (!(packType && CANON_CRISIS_TYPES[packType])) order.push('crisis');
  if (crisisPackRenderableFields(crisisPack).length > 0) order.push('crisispack');
  return order;
}

/** True when every REQUIRED renderable field has a usable answer — gates the
 *  crisispack sub-step's Continue. Mirror of the PWA's _canAdvanceFrom('crisispack'). */
export function crisisPackRequiredAnswered(fields: any[], answers: Record<string, any> | null | undefined): boolean {
  const ans = answers || {};
  return (fields || []).every((f: any) => {
    if (!f || !f.required) return true;
    const v = ans[f.key];
    if (f.type === 'multi_select') return Array.isArray(v) && v.length > 0;
    if (f.type === 'yes_no') return v === true || v === false;
    return v !== undefined && v !== null && String(v).trim() !== '';
  });
}

// The V4 classify flow collects damage/infra/crisis but NOT severity (the PWA
// dropped the explicit severity chips in v4). So severity is derived from the
// damage pick. Mirror of the PWA's _V4_DAMAGE_TO_SEVERITY (v4-flow.js): without
// this a v4 report can land with severity null → Pydantic 422 → the offline
// queue retries forever ("stuck at 25%"). Always returns a valid SeverityEnum.
const _V4_DAMAGE_TO_SEVERITY: Record<string, string> = {
  MINIMAL: 'MINOR', PARTIAL: 'MODERATE', COMPLETE: 'SEVERE',
  // Legacy values the schema still accepts (the v4 UI doesn't show them).
  NO_DAMAGE: 'MINOR', DESTROYED: 'SEVERE',
};

/** Derive a non-null SeverityEnum from the user's damage pick. Pure; mirrors
 *  the PWA's _v4ApplyDamage so RN v4 reports carry an accurate severity. */
export function deriveSeverityFromDamage(damage: string | null | undefined): string {
  return (damage && _V4_DAMAGE_TO_SEVERITY[damage]) || 'MODERATE';
}

export function assembleCrisisForm(
  crisisPack: CrisisPack | null | undefined,
  canonical: Record<string, any>,
  stockAnswers: Record<string, any> | null | undefined,
): CrisisFormResult {
  if (!crisisPack || !crisisPack.schema) return EMPTY;
  const ans = stockAnswers || {};
  const payload: Record<string, any> = {};
  (crisisPack.schema.sections || []).forEach((sec) =>
    (sec.fields || []).forEach((f: any) => {
      if (!f || !f.key) return;
      const v = f.maps_to && DEFAULT_CAPTURED[f.maps_to] ? canonical[f.maps_to] : ans[f.key];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) return;
      payload[f.key] = v;
    }),
  );
  if (Object.keys(payload).length === 0) return EMPTY;
  return {
    form_pack_id: crisisPack.pack_id || null,
    form_pack_version: crisisPack.pack_version || null,
    form_data: payload,
  };
}
