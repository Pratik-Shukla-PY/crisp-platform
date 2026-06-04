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
