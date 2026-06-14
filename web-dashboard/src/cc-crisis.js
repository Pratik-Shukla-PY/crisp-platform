/* cc-crisis.js — Dynamic Crisis Forms admin panel (self-contained).
 *
 * Productionises the approved /tmp/crisis-forms-admin-mockup.html into real
 * CRUD against the backend's crisis-forms API. Deliberately self-contained:
 *   • app.js and styles.css are NOT touched (this file + ONE <script> tag).
 *   • All DOM ids / classes are cc-cf- prefixed; CSS is injected once.
 *   • Auth + backend-host derivation mirror app.js exactly.
 *   • Boots defensively — any failure here must never break the dashboard.
 *
 * Feature model (operator-refined): the default report flow stays UNCHANGED
 * everywhere. Admins activate a crisis-specific Stage 2/3 question pack for a
 * geographic zone (center + radius) within a time window. Reporters inside an
 * active zone get the curated pack; everyone else (and expired zones) get the
 * default flow. Stage 1 (photo / audio / location) is never touched.
 *
 * Endpoints (see backend/app/api/endpoints/crisis_forms.py):
 *   GET/POST/PATCH/DELETE  /api/v1/admin/crisis-forms/events[/{id}]
 *   GET/POST/PATCH         /api/v1/admin/crisis-forms/packs[/{id}]
 *   GET/POST               /api/v1/admin/crisis-forms/packs/{id}/versions
 *   POST                   /api/v1/admin/crisis-forms/packs/{id}/publish      {version}
 *   POST                   /api/v1/admin/crisis-forms/packs/{id}/rollback     {version}
 *   POST                   /api/v1/admin/crisis-forms/packs/validate          {schema_json}
 *   GET (public)           /api/v1/crisis-forms/active?lat=&lng=
 */
(function () {
  'use strict';
  if (window.__ccCrisisLoaded) return;
  window.__ccCrisisLoaded = true;

  // ── auth + API base (mirror web-dashboard/src/app.js) ──────────────────────
  const token = () => localStorage.getItem('crisp_token');
  function currentUser() {
    try { return JSON.parse(localStorage.getItem('crisp_user') || '{}') || {}; }
    catch (_e) { return {}; }
  }
  function isAdmin() {
    const role = String(currentUser().role || '').toUpperCase();
    return role === 'ADMIN' || role === 'SUPER_ADMIN';
  }
  const _LAN_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
  const _isLocalDev = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname)
    || _LAN_RE.test(window.location.hostname);
  const BACKEND_HOST = _isLocalDev
    ? `http://${window.location.hostname}:8000`
    : window.location.origin;
  const ADMIN_API = `${BACKEND_HOST}/api/v1/admin/crisis-forms`;
  const PUBLIC_API = `${BACKEND_HOST}/api/v1/crisis-forms`;

  // ── canonical enum allowlists (MUST mirror crisis_form_schema.FIRST_CLASS_FIELDS).
  //    The builder only ever emits maps_to options from these sets, so a published
  //    pack can never smuggle a non-canonical value into a first-class column. ───
  const ENUM = {
    crisis_type: [
      ['EARTHQUAKE', 'Earthquake'], ['FLOOD', 'Flood'], ['TSUNAMI', 'Tsunami'],
      ['CYCLONE', 'Cyclone'], ['WILDFIRE', 'Wildfire'], ['EXPLOSION', 'Explosion'],
      ['CHEMICAL_INCIDENT', 'Chemical incident'], ['CONFLICT', 'Conflict'],
      ['CIVIL_UNREST', 'Civil unrest'], ['OTHER', 'Other'],
    ],
    infrastructure_type: [
      ['RESIDENTIAL', 'Residential'], ['COMMERCIAL', 'Commercial'], ['GOVERNMENT', 'Government'],
      ['UTILITY', 'Utility'], ['TRANSPORT_COMMUNICATION', 'Transport / Communication'],
      ['COMMUNITY', 'Community'], ['PUBLIC_SPACES', 'Public spaces'], ['OTHER', 'Other'],
    ],
    damage_classification: [['MINIMAL', 'Minimal'], ['PARTIAL', 'Partial'], ['COMPLETE', 'Complete']],
    severity: [['MINOR', 'Minor'], ['MODERATE', 'Moderate'], ['SEVERE', 'Severe'],
    ['CRITICAL', 'Critical'], ['UNKNOWN', 'Unknown']],
  };
  const opt = (pairs) => pairs.map(([value, label]) => ({ value, label }));
  // crisis types offered when creating an EVENT (free-form display/analytics on the
  // event row — NOT enum-guarded; LANDSLIDE is intentionally available here only).
  const EVENT_CRISIS_TYPES = [
    ['WILDFIRE', '🔥 Wildfire / Forest fire'], ['FLOOD', '🌊 Flood'], ['EARTHQUAKE', '🏚 Earthquake'],
    ['CYCLONE', '🌀 Cyclone'], ['TSUNAMI', '🌊 Tsunami'], ['LANDSLIDE', '⛰ Landslide'],
    ['EXPLOSION', '💥 Explosion'], ['CHEMICAL_INCIDENT', '☣ Chemical incident'],
    ['CONFLICT', '🛡 Conflict / Humanitarian'], ['CIVIL_UNREST', '✊ Civil unrest'], ['OTHER', 'Other'],
  ];

  // ── curated block library (faithful to the approved mockup; each block carries
  //    a full, VALID schema field). `stage` (2 = classify, 3 = details) groups the
  //    field into the published schema's sections. `locked` blocks can't be toggled
  //    off (taxonomy anchors). Photo / audio are NOT here — they are Stage-1 capture,
  //    which the crisis feature never touches (shown as the green lock banner). ────
  function mkBlock(id, icon, title, tyLabel, stage, field, extra) {
    return Object.assign({ id, icon, title, ty: tyLabel, stage, field, on: true, desc: '', locked: false }, extra || {});
  }
  const CORE_BLOCKS = [
    mkBlock('crisis_type', '🌀', 'What caused it', 'choice', 2,
      { key: 'crisis_type', type: 'single_select', label: 'What caused it?', required: true, maps_to: 'crisis_type', options: opt(ENUM.crisis_type) },
      { desc: 'Crisis type (10 options) · taxonomy', locked: true, on: true }),
    mkBlock('infrastructure_type', '🏢', 'What was hit', 'choice', 2,
      { key: 'infrastructure_type', type: 'single_select', label: 'What was hit?', required: true, maps_to: 'infrastructure_type', options: opt(ENUM.infrastructure_type) },
      { desc: 'Infrastructure type (8)', on: true }),
    mkBlock('damage', '🏚', 'Extent of damage', 'choice', 2,
      { key: 'damage_classification', type: 'single_select', label: 'Extent of damage?', required: true, maps_to: 'damage_classification', options: opt(ENUM.damage_classification) },
      { desc: 'Minimal / Partial / Complete', on: true }),
    mkBlock('severity', '📊', 'Severity', 'choice', 2,
      { key: 'severity', type: 'single_select', label: 'Severity', required: false, maps_to: 'severity', options: opt(ENUM.severity) },
      { desc: 'Minor → Critical', on: false }),
    mkBlock('building', '🏗', 'Building selection', 'special', 3,
      { key: 'building', type: 'building', label: 'Building selection', required: false },
      { desc: 'OSM footprint or free-text name', on: false }),
    mkBlock('debris', '🚜', 'Debris clearing needed', 'yes/no', 3,
      { key: 'debris_clearing_needed', type: 'yes_no', label: 'Debris clearing needed?', required: false, maps_to: 'debris_clearing_needed' },
      { desc: 'Yes / No (multi-channel parity field)', on: true }),
    mkBlock('notes', '📝', 'Additional notes', 'text', 3,
      { key: 'notes', type: 'long_text', label: 'Additional notes', required: false, validation: { max_length: 2000 } },
      { desc: 'Free text (optional)', on: false }),
  ];
  // crisis-specific stock questions (go to form_data; no first-class mapping)
  const ynStage = (k, label, stage, icon) => mkBlock(k, icon, label.replace(/\?$/, ''), 'yes/no', stage,
    { key: k, type: 'yes_no', label, required: false });
  const STOCK_PACKS = {
    WILDFIRE: [
      ynStage('flames_visible', 'Flames visible?', 2, '🔥'),
      mkBlock('smoke_density', '💨', 'Smoke density', 'choice', 2,
        { key: 'smoke_density', type: 'single_select', label: 'Smoke density?', required: false, options: opt([['LIGHT', 'Light'], ['MODERATE', 'Moderate'], ['HEAVY', 'Heavy']]) }),
      ynStage('fire_spreading', 'Is the fire spreading?', 2, '↗'),
      ynStage('homes_threatened', 'Residential structures threatened?', 2, '🏠'),
      ynStage('road_blocked', 'Road access blocked?', 3, '🚧'),
      ynStage('people_trapped', 'People trapped?', 2, '🆘'),
      ynStage('evac_needed', 'Evacuation required?', 3, '🏃', { on: false }),
    ],
    FLOOD: [
      mkBlock('water_level', '🌊', 'Water level', 'choice', 2,
        { key: 'water_level', type: 'single_select', label: 'Water level?', required: false, options: opt([['ANKLE', 'Ankle'], ['KNEE', 'Knee'], ['WAIST', 'Waist'], ['ABOVE_HEAD', 'Above head']]) }),
      ynStage('water_rising', 'Is the water still rising?', 2, '📈'),
      ynStage('people_stranded', 'People stranded?', 2, '🆘'),
      ynStage('drinking_water_safe', 'Is drinking water still safe?', 3, '🚰'),
      ynStage('road_blocked', 'Road access blocked?', 3, '🚧'),
      ynStage('power_out', 'Is power out?', 3, '🔌', { on: false }),
    ],
    EARTHQUAKE: [
      ynStage('aftershocks', 'Aftershocks still happening?', 2, '📳'),
      mkBlock('building_lean', '🏚', 'Visible structural damage', 'choice', 2,
        { key: 'building_lean', type: 'single_select', label: 'Visible structural damage?', required: false, options: opt([['CRACKS', 'Cracks'], ['LEANING', 'Leaning'], ['COLLAPSED', 'Collapsed']]) }),
      ynStage('people_trapped', 'People trapped under rubble?', 2, '🆘'),
      ynStage('gas_leak', 'Smell of gas / suspected leak?', 2, '⛽'),
      ynStage('road_blocked', 'Road access blocked?', 3, '🚧'),
      ynStage('fire_started', 'Any fire started?', 3, '🔥', { on: false }),
    ],
    CYCLONE: [
      mkBlock('wind_strength', '🌬', 'Wind strength', 'choice', 2,
        { key: 'wind_strength', type: 'single_select', label: 'Wind strength?', required: false, options: opt([['BREEZY', 'Breezy'], ['STRONG', 'Strong'], ['DESTRUCTIVE', 'Destructive']]) }),
      ynStage('roof_damage', 'Roof / structural damage?', 2, '🏠'),
      ynStage('flooding', 'Flooding alongside the storm?', 2, '🌊'),
      ynStage('power_out', 'Is power out?', 3, '🔌'),
      ynStage('road_blocked', 'Road access blocked?', 3, '🚧'),
    ],
    LANDSLIDE: [
      ynStage('still_moving', 'Is the ground still moving?', 2, '⛰'),
      ynStage('homes_buried', 'Homes buried or hit?', 2, '🏠'),
      ynStage('people_trapped', 'People trapped?', 2, '🆘'),
      ynStage('road_blocked', 'Road access blocked?', 3, '🚧'),
      ynStage('river_blocked', 'Is a river / stream blocked?', 3, '🏞', { on: false }),
    ],
    CONFLICT: [
      ynStage('area_safe_now', 'Is the area safe right now?', 2, '🕊'),
      ynStage('people_injured', 'People injured?', 2, '🩹'),
      ynStage('displacement', 'People displaced from homes?', 2, '🏃'),
      ynStage('medical_needed', 'Urgent medical help needed?', 3, '🚑'),
      ynStage('road_blocked', 'Road access blocked?', 3, '🚧'),
    ],
  };
  const CRISIS_TO_STOCK = {
    WILDFIRE: 'WILDFIRE', FLOOD: 'FLOOD', EARTHQUAKE: 'EARTHQUAKE',
    CYCLONE: 'CYCLONE', TSUNAMI: 'CYCLONE', LANDSLIDE: 'LANDSLIDE',
    CONFLICT: 'CONFLICT', CIVIL_UNREST: 'CONFLICT',
  };

  // Expose the curated form-kit DATA (read-only constants; consumers clone before
  // mutating) so the Start-New-Operation wizard (cc-wizard.js) reuses the SAME
  // block library + stock packs instead of duplicating them. Pure data — no
  // behaviour change to this module.
  window.CrispFormKit = { ENUM, CORE_BLOCKS, STOCK_PACKS, CRISIS_TO_STOCK, EVENT_CRISIS_TYPES };

  // ── tiny DOM + format helpers ──────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const el = (id) => document.getElementById(id);
  const _pad2 = (n) => String(n).padStart(2, '0');
  function isoToLocalDate(iso) { // aware ISO → "YYYY-MM-DD" in the operator's TZ
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${_pad2(d.getMonth() + 1)}-${_pad2(d.getDate())}`;
  }
  function isoToLocalTime(iso) { // aware ISO → "HH:MM" in the operator's TZ
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return `${_pad2(d.getHours())}:${_pad2(d.getMinutes())}`;
  }
  function dateTimeToISO(dateVal, timeVal) { // calendar date + clock dropdown → aware ISO (UTC Z)
    if (!dateVal) return null;             // blank date = open-ended bound
    const t = /^\d{2}:\d{2}$/.test(timeVal || '') ? timeVal : '00:00';
    const d = new Date(`${dateVal}T${t}`);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // 30-min clock options "00:00".."23:30"; if `cur` (HH:MM) is off-grid (a value
  // saved before this picker existed), inject it so the saved time is preserved.
  function timeOptions(cur) {
    const set = [];
    for (let h = 0; h < 24; h++) for (const m of [0, 30]) set.push(`${_pad2(h)}:${_pad2(m)}`);
    if (/^\d{2}:\d{2}$/.test(cur || '') && set.indexOf(cur) === -1) set.push(cur);
    set.sort();
    return set.map((t) => `<option value="${t}" ${t === cur ? 'selected' : ''}>${t}</option>`).join('');
  }
  // Public geocode proxy (no auth): "describe" (text→coords+name) + "reverse" (coords→name).
  async function geocode(path, body) {
    const res = await fetch(`${BACKEND_HOST}/api/v1/reports/geocode/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const det = data && data.detail;
      const msg = (det && (det.message || (typeof det === 'string' ? det : null))) || res.statusText;
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return data;
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function eventStatus(ev) {
    const now = Date.now();
    const st = ev.started_at ? Date.parse(ev.started_at) : null;
    const en = ev.ended_at ? Date.parse(ev.ended_at) : null;
    if (!ev.is_active) return { k: 'inactive', label: 'Inactive' };
    if (en && en < now) return { k: 'exp', label: 'Expired' };
    if (st && st > now) return { k: 'sched', label: 'Scheduled' };
    return { k: 'live', label: 'Live' };
  }
  function creatorName(e) { // event.created_by (user id) → full_name via S.userMap
    if (!e || !e.created_by) return '';
    return S.userMap[e.created_by] || 'Unknown user';
  }

  // ── API ────────────────────────────────────────────────────────────────────
  async function api(method, path, body, base) {
    const opts = { method, headers: { Authorization: `Bearer ${token() || ''}` } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch((base || ADMIN_API) + path, opts);
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_e) { data = text; }
    if (!res.ok) {
      let msg = res.statusText;
      if (data && typeof data === 'object' && 'detail' in data) {
        msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
      } else if (typeof data === 'string' && data) { msg = data; }
      const err = new Error(msg); err.status = res.status; err.data = data; throw err;
    }
    return data;
  }

  // ── toast (cc-scoped; does not depend on app.js) ─────────────────────────────
  let _toastTimer = null;
  function toast(msg, kind) {
    let t = el('cc-cf-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'cc-cf-toast';
      document.body.appendChild(t);
    }
    t.className = 'cc-cf-toast cc-cf-toast--' + (kind || 'ok');
    t.textContent = msg;
    t.classList.add('cc-cf-show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('cc-cf-show'), 3600);
  }

  // ── state ────────────────────────────────────────────────────────────────────
  const S = {
    tab: 'events',
    events: [], packs: [],
    users: [], userMap: {},    // admin user list → id→full_name for "Created by"
    editingEvent: undefined,   // undefined = not editing, {} = new, {…} = edit
    builderPackId: null, builderPack: null, builderVersions: [],
    builderBlocks: null,       // working copy of {core:[…], stock:[…]} with .on flags
    builderStockKey: 'WILDFIRE',
    builderUnknownFields: [],  // field keys in the loaded version this curated UI can't edit
    previewCh: 'pwa',
    busy: false,
  };

  // ── styles (injected once; cc-cf- prefixed; reuses dashboard :root tokens) ────
  function injectStyles() {
    if (el('cc-cf-styles')) return;
    const css = `
    #cc-cf-overlay{position:fixed;inset:0;z-index:99999;display:none;background:rgba(4,7,12,.72);
      backdrop-filter:blur(3px);overflow:auto;padding:24px 16px}
    #cc-cf-overlay.cc-cf-open{display:block}
    .cc-cf-shell{max-width:1320px;margin:0 auto;background:var(--bg,#080c14);border:1px solid var(--border,rgba(255,255,255,.09));
      border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden;font-size:14px;color:var(--text,#f1f5f9)}
    .cc-cf-top{display:flex;align-items:center;gap:14px;padding:16px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,.09))}
    .cc-cf-logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#7c5cff,#22d3ee);
      display:grid;place-items:center;font-weight:800;color:#fff;flex:none}
    .cc-cf-top h2{font-size:17px;margin:0;font-weight:700}
    .cc-cf-top .cc-cf-sub{color:var(--text-dim,#6b7689);font-size:12.5px;margin-top:2px}
    .cc-cf-x{margin-left:auto;background:transparent;border:1px solid var(--border-2,rgba(255,255,255,.14));color:var(--text-sub,#aab4c5);
      width:34px;height:34px;border-radius:9px;cursor:pointer;font-size:16px;line-height:1}
    .cc-cf-x:hover{color:#fff;border-color:var(--accent,#7c5cff)}
    .cc-cf-tabs{display:flex;gap:6px;padding:12px 20px 0}
    .cc-cf-tab{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--text-sub,#aab4c5);
      padding:8px 14px;font-size:13.5px;font-weight:600;cursor:pointer}
    .cc-cf-tab.on{color:#fff;border-bottom-color:var(--accent,#7c5cff)}
    .cc-cf-body{padding:18px 20px 24px}
    .cc-cf-card{background:var(--surface,#0e1420);border:1px solid var(--border,rgba(255,255,255,.09));border-radius:14px;padding:15px 16px;margin-bottom:14px}
    .cc-cf-card h3{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-sub,#aab4c5);margin:0 0 12px;font-weight:700}
    .cc-cf-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .cc-cf-spacer{flex:1}
    .cc-cf-btn{border:1px solid var(--border-2,rgba(255,255,255,.14));background:var(--surface-2,#141c2b);color:var(--text,#f1f5f9);
      border-radius:9px;padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer}
    .cc-cf-btn:hover{border-color:var(--accent,#7c5cff)}
    .cc-cf-btn.primary{background:linear-gradient(135deg,#7c5cff,#22d3ee);border:0;color:#fff}
    .cc-cf-btn.ghost{background:transparent;color:var(--text-sub,#aab4c5)}
    .cc-cf-btn.danger{border-color:rgba(239,68,68,.5);color:#ffb4b4}
    .cc-cf-btn[disabled]{opacity:.5;cursor:not-allowed}
    .cc-cf-btn.sm{padding:6px 11px;font-size:12px}
    .cc-cf-table{width:100%;border-collapse:collapse;font-size:13px}
    .cc-cf-table th{text-align:left;color:var(--text-dim,#6b7689);font-weight:600;font-size:11px;text-transform:uppercase;
      letter-spacing:.05em;padding:0 10px 9px;border-bottom:1px solid var(--border,rgba(255,255,255,.09))}
    .cc-cf-table td{padding:11px 10px;border-bottom:1px solid var(--border,rgba(255,255,255,.09));vertical-align:middle}
    .cc-cf-pill{font-size:11px;padding:3px 9px;border-radius:999px;font-weight:600;white-space:nowrap}
    .cc-cf-pill.live{background:rgba(16,185,129,.15);color:#5ee9b5}
    .cc-cf-pill.sched{background:rgba(245,158,11,.15);color:#fbd38d}
    .cc-cf-pill.exp{background:rgba(107,118,137,.18);color:#9aa6b8}
    .cc-cf-pill.inactive{background:rgba(107,118,137,.14);color:#8b97a9}
    .cc-cf-pill.published{background:rgba(16,185,129,.15);color:#5ee9b5}
    .cc-cf-pill.draft{background:rgba(56,189,248,.15);color:#8fd6fb}
    .cc-cf-pill.archived{background:rgba(107,118,137,.18);color:#9aa6b8}
    .cc-cf-lbl{display:block;font-size:12px;color:var(--text-sub,#aab4c5);margin:0 0 5px}
    .cc-cf-fld{margin:0 0 12px}
    .cc-cf-input,.cc-cf-select,.cc-cf-textarea{width:100%;background:var(--surface-2,#141c2b);border:1px solid var(--border-2,rgba(255,255,255,.14));
      color:var(--text,#f1f5f9);border-radius:9px;padding:9px 10px;font-size:13.5px;font-family:inherit}
    .cc-cf-input:focus,.cc-cf-select:focus,.cc-cf-textarea:focus{outline:none;border-color:var(--accent,#7c5cff)}
    .cc-cf-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .cc-cf-dt{display:grid;grid-template-columns:1fr 116px;gap:8px}
    .cc-cf-geo{display:flex;gap:8px;align-items:stretch}
    .cc-cf-geo .cc-cf-input{flex:1;min-width:0}
    .cc-cf-geo .cc-cf-btn{flex:none;white-space:nowrap}
    .cc-cf-geo-res{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin:-4px 0 12px;font-size:12px;color:var(--text-sub,#aab4c5)}
    .cc-cf-geo-pin{flex:none}
    .cc-cf-geo-name{color:var(--text,#f1f5f9)}
    .cc-cf-geo-chip{font-size:10px;padding:2px 7px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em;font-weight:700}
    .cc-cf-geo-chip.high{background:rgba(16,185,129,.16);color:#5ee9b5}
    .cc-cf-geo-chip.medium{background:rgba(245,158,11,.16);color:#fbd38d}
    .cc-cf-geo-chip.low,.cc-cf-geo-chip.none{background:rgba(239,68,68,.14);color:#ffb4b4}
    .cc-cf-geo-chip.src{background:var(--surface-3,#1b2538);color:var(--text-dim,#6b7689)}
    .cc-cf-build{display:grid;grid-template-columns:1fr 372px;gap:16px;align-items:start}
    @media(max-width:900px){.cc-cf-build{grid-template-columns:1fr}}
    .cc-cf-chips{display:flex;gap:6px;flex-wrap:wrap}
    .cc-cf-chip{background:var(--surface-2,#141c2b);border:1px solid var(--border-2,rgba(255,255,255,.14));color:var(--text-sub,#aab4c5);
      border-radius:999px;padding:7px 13px;font-size:12.5px;cursor:pointer}
    .cc-cf-chip.on{background:rgba(124,92,255,.16);border-color:var(--accent,#7c5cff);color:#fff}
    .cc-cf-blk{display:flex;align-items:center;gap:11px;padding:10px 12px;border:1px solid var(--border,rgba(255,255,255,.09));
      border-radius:9px;margin-bottom:8px;background:var(--surface-2,#141c2b);cursor:pointer}
    .cc-cf-blk.on{border-color:rgba(124,92,255,.5);background:rgba(124,92,255,.08)}
    .cc-cf-blk.locked{cursor:default}
    .cc-cf-blk .gi{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;background:var(--surface-3,#1b2538);font-size:15px;flex:none}
    .cc-cf-blk .meta{flex:1;min-width:0}
    .cc-cf-blk .meta .t{font-weight:600;font-size:13.5px}
    .cc-cf-blk .meta .d{color:var(--text-dim,#6b7689);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cc-cf-blk .ty{font-size:10.5px;color:var(--text-dim,#6b7689);border:1px solid var(--border-2,rgba(255,255,255,.14));padding:2px 7px;border-radius:999px;flex:none}
    .cc-cf-sw{position:relative;width:38px;height:22px;border-radius:999px;background:var(--surface-3,#1b2538);
      border:1px solid var(--border-2,rgba(255,255,255,.14));flex:none;transition:.15s}
    .cc-cf-sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#5b6677;transition:.15s}
    .cc-cf-blk.on .cc-cf-sw{background:var(--accent,#7c5cff)}
    .cc-cf-blk.on .cc-cf-sw::after{left:18px;background:#fff}
    .cc-cf-blk.locked .cc-cf-sw{opacity:.6}
    .cc-cf-blocks h4{font-size:11.5px;color:var(--text-dim,#6b7689);text-transform:uppercase;letter-spacing:.05em;margin:14px 0 8px;font-weight:700}
    .cc-cf-phone{border:1px solid var(--border-2,rgba(255,255,255,.14));border-radius:18px;background:#0a0f18;padding:12px 11px;min-height:380px}
    .cc-cf-pv-head{font-size:11px;color:var(--text-dim,#6b7689);text-align:center;margin-bottom:9px}
    .cc-cf-lock{display:flex;gap:8px;align-items:center;background:rgba(16,185,129,.08);border:1px solid rgba(16,185,129,.3);
      border-radius:8px;padding:8px 10px;font-size:11.5px;color:#9ff0d0;margin-bottom:11px}
    .cc-cf-stage-lbl{font-size:11px;color:#22d3ee;font-weight:700;letter-spacing:.04em;margin:6px 0 9px}
    .cc-cf-q{margin-bottom:13px}
    .cc-cf-q .qt{font-weight:650;font-size:13.5px;margin-bottom:7px}
    .cc-cf-opt{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--border-2,rgba(255,255,255,.14));border-radius:8px;
      padding:7px 10px;margin:0 6px 6px 0;font-size:12.5px;color:var(--text-sub,#aab4c5);background:var(--surface-2,#141c2b)}
    .cc-cf-opt.sel{border-color:var(--accent,#7c5cff);color:#fff;background:rgba(124,92,255,.14)}
    .cc-cf-stub{background:var(--surface-2,#141c2b);border:1px dashed var(--border-2,rgba(255,255,255,.14));border-radius:8px;padding:9px;color:var(--text-dim,#6b7689);font-size:12px}
    .cc-cf-tg .bub{background:#17212b;border-radius:10px;padding:9px 11px;margin-bottom:7px;color:#e8eef5;font-size:12.5px}
    .cc-cf-tg .tgbtn{display:block;width:100%;text-align:center;background:#202b38;border:0;color:#7fd0ff;border-radius:7px;padding:8px;margin-bottom:5px;font-size:12.5px;cursor:default}
    .cc-cf-chtabs{display:flex;gap:6px;margin-bottom:12px}
    .cc-cf-chtabs button{flex:1;background:var(--surface-2,#141c2b);border:1px solid var(--border-2,rgba(255,255,255,.14));color:var(--text-sub,#aab4c5);
      border-radius:999px;padding:7px;font-size:12px;cursor:pointer}
    .cc-cf-chtabs button.on{color:#fff;background:rgba(124,92,255,.16);border-color:var(--accent,#7c5cff)}
    .cc-cf-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
    @media(max-width:760px){.cc-cf-kpis{grid-template-columns:1fr 1fr}}
    .cc-cf-kpi{background:var(--surface-2,#141c2b);border:1px solid var(--border,rgba(255,255,255,.09));border-radius:9px;padding:14px}
    .cc-cf-kpi .n{font-size:26px;font-weight:800}
    .cc-cf-kpi .l{font-size:11.5px;color:var(--text-dim,#6b7689);margin-top:3px}
    .cc-cf-hint{font-size:11.5px;color:var(--text-dim,#6b7689);margin:6px 0 0}
    .cc-cf-empty{color:var(--text-dim,#6b7689);font-size:13px;text-align:center;padding:22px;border:1px dashed var(--border-2,rgba(255,255,255,.14));border-radius:9px}
    .cc-cf-warn{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.4);color:#fbd38d;border-radius:9px;padding:10px 12px;font-size:12.5px;margin-bottom:12px}
    .cc-cf-errs{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.4);color:#ffb4b4;border-radius:9px;padding:10px 12px;font-size:12.5px;margin-bottom:12px}
    .cc-cf-errs ul{margin:6px 0 0;padding-left:18px}
    #cc-cf-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);z-index:100001;
      background:var(--surface-3,#1b2538);border:1px solid var(--border-2,rgba(255,255,255,.14));color:var(--text,#f1f5f9);
      padding:11px 18px;border-radius:10px;font-size:13px;font-weight:600;opacity:0;pointer-events:none;transition:.22s;max-width:80vw}
    #cc-cf-toast.cc-cf-show{opacity:1;transform:translateX(-50%) translateY(0)}
    #cc-cf-toast.cc-cf-toast--err{border-color:rgba(239,68,68,.6);color:#ffd2d2}
    #cc-cf-toast.cc-cf-toast--ok{border-color:rgba(16,185,129,.5)}
    `;
    const tag = document.createElement('style');
    tag.id = 'cc-cf-styles';
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // Focus-trap: keep Tab/Shift+Tab within the open overlay (a11y, WCAG 2.4.3).
  // Also pulls focus back in if it ever escaped behind the modal.
  function trapTab(e, ov) {
    const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const nodes = Array.from(ov.querySelectorAll(sel)).filter((n) => n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1], a = document.activeElement;
    if (e.shiftKey) { if (a === first || !ov.contains(a)) { e.preventDefault(); last.focus(); } }
    else if (a === last || !ov.contains(a)) { e.preventDefault(); first.focus(); }
  }

  // ── overlay shell ──────────────────────────────────────────────────────────
  function ensureOverlay() {
    let ov = el('cc-cf-overlay');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'cc-cf-overlay';
    ov.innerHTML = `
      <div class="cc-cf-shell" role="dialog" aria-label="Crisis Forms" aria-modal="true">
        <div class="cc-cf-top">
          <div class="cc-cf-logo">C</div>
          <div>
            <h2>Crisis Forms</h2>
            <div class="cc-cf-sub">Activate a crisis-specific Stage 2 / 3 question pack for a geographic zone — the default flow stays everywhere else.</div>
          </div>
          <button class="cc-cf-x" id="cc-cf-close" title="Close" aria-label="Close">✕</button>
        </div>
        <div class="cc-cf-tabs">
          <button class="cc-cf-tab" data-tab="events">Crisis events</button>
          <button class="cc-cf-tab" data-tab="packs">Question packs</button>
        </div>
        <div class="cc-cf-body" id="cc-cf-body"></div>
      </div>`;
    document.body.appendChild(ov);
    // close affordances
    // Close → return to the Control Center root when routed; else just hide.
    const _exit = () => { if (window.__crispRouter) window.__crispRouter.navigate('/'); else closeOverlay(); };
    el('cc-cf-close').addEventListener('click', _exit);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) _exit(); });
    document.addEventListener('keydown', (e) => {
      if (!ov.classList.contains('cc-cf-open')) return;
      if (e.key === 'Escape' && !S.editingEvent && !S.builderPackId) { _exit(); return; }
      if (e.key === 'Tab') trapTab(e, ov);
    });
    ov.querySelectorAll('.cc-cf-tab').forEach((b) => b.addEventListener('click', () => {
      S.tab = b.getAttribute('data-tab');
      S.editingEvent = undefined; S.builderPackId = null;
      render();
    }));
    return ov;
  }

  async function openOverlay() {
    if (!isAdmin()) { toast('Crisis Forms is available to admins only.', 'err'); return; }
    injectStyles();
    ensureOverlay();
    el('cc-cf-overlay').classList.add('cc-cf-open');
    S.tab = 'events'; S.editingEvent = undefined; S.builderPackId = null;
    render();
    refreshAll();
    try { const x = el('cc-cf-close'); if (x) x.focus(); } catch (_e) {}   // move focus into the modal (a11y)
  }
  function closeOverlay() {
    const ov = el('cc-cf-overlay');
    if (ov) ov.classList.remove('cc-cf-open');
  }

  async function refreshAll() {
    try {
      const [events, packs, users] = await Promise.all([
        api('GET', '/events').catch(() => []),
        api('GET', '/packs').catch(() => []),
        // admin-only; resolves event.created_by → full_name. Non-fatal on 403.
        api('GET', '/users', undefined, `${BACKEND_HOST}/api/v1/auth`).catch(() => []),
      ]);
      S.events = Array.isArray(events) ? events : [];
      S.packs = Array.isArray(packs) ? packs : [];
      S.users = Array.isArray(users) ? users : [];
      S.userMap = {};
      S.users.forEach((u) => { if (u && u.id) S.userMap[u.id] = u.full_name || u.email || u.id; });
      render();
    } catch (e) { toast('Could not load crisis data: ' + e.message, 'err'); }
  }

  // ── render dispatch ──────────────────────────────────────────────────────────
  function render() {
    const ov = el('cc-cf-overlay');
    if (!ov) return;
    ov.querySelectorAll('.cc-cf-tab').forEach((b) => b.classList.toggle('on', b.getAttribute('data-tab') === S.tab));
    const body = el('cc-cf-body');
    if (!body) return;
    if (S.builderPackId) { renderBuilder(body); return; }
    if (S.editingEvent !== undefined) { renderEventEditor(body); return; }
    if (S.tab === 'events') renderEvents(body);
    else renderPacks(body);
  }

  // ── EVENTS tab ────────────────────────────────────────────────────────────────
  function renderEvents(body) {
    const ev = S.events;
    const now = Date.now();
    const live = ev.filter((e) => eventStatus(e).k === 'live').length;
    const sched = ev.filter((e) => eventStatus(e).k === 'sched').length;
    const exp = ev.filter((e) => eventStatus(e).k === 'exp').length;
    const packTitle = (id) => { const p = S.packs.find((x) => x.id === id); return p ? p.title : (id ? '— missing —' : '— none —'); };
    let rows = '';
    if (!ev.length) {
      rows = `<tr><td colspan="6"><div class="cc-cf-empty">No crisis events yet. Create one to activate a curated pack for a zone.</div></td></tr>`;
    } else {
      rows = ev.map((e) => {
        const st = eventStatus(e);
        const zone = `${(e.radius_km || 0)} km · ${Number(e.center_lat).toFixed(2)}, ${Number(e.center_lng).toFixed(2)}`;
        const win = `${fmtDate(e.started_at)} – ${fmtDate(e.ended_at)}`;
        const creator = creatorName(e);
        return `<tr>
          <td><div style="font-weight:600">${esc(e.name)}</div><div style="color:var(--text-dim,#6b7689);font-size:11.5px">${esc(packTitle(e.form_pack_id))}</div>${creator ? `<div style="color:var(--text-dim,#6b7689);font-size:11px;margin-top:1px">Created by ${esc(creator)}</div>` : ''}</td>
          <td>${esc(e.crisis_type || '—')}</td>
          <td>${esc(zone)}</td>
          <td>${esc(win)}</td>
          <td><span class="cc-cf-pill ${st.k}">${st.label}</span></td>
          <td><div class="cc-cf-row" style="gap:6px;flex-wrap:nowrap">
            <button class="cc-cf-btn sm" data-act="edit" data-id="${esc(e.id)}">Edit</button>
            <button class="cc-cf-btn sm" data-act="toggle" data-id="${esc(e.id)}">${e.is_active ? 'Deactivate' : 'Activate'}</button>
            <button class="cc-cf-btn sm danger" data-act="del" data-id="${esc(e.id)}">Delete</button>
          </div></td>
        </tr>`;
      }).join('');
    }
    body.innerHTML = `
      <div class="cc-cf-card">
        <div class="cc-cf-row"><h3 style="margin:0">Active &amp; scheduled crisis forms</h3><div class="cc-cf-spacer"></div>
          <button class="cc-cf-btn primary" id="cc-cf-new-event">+ New crisis event</button></div>
        <p class="cc-cf-hint" style="margin:8px 0 12px">Rollback = deactivate the event → every reporter in the zone instantly reverts to the default flow. Match runs server-side (haversine).</p>
        <table class="cc-cf-table">
          <thead><tr><th>Name / pack</th><th>Type</th><th>Zone</th><th>Window</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="cc-cf-card">
        <h3>Overview</h3>
        <div class="cc-cf-kpis">
          <div class="cc-cf-kpi"><div class="n">${live}</div><div class="l">live now</div></div>
          <div class="cc-cf-kpi"><div class="n">${sched}</div><div class="l">scheduled</div></div>
          <div class="cc-cf-kpi"><div class="n">${exp}</div><div class="l">expired</div></div>
          <div class="cc-cf-kpi"><div class="n">${S.packs.filter((p) => p.active_version).length}</div><div class="l">published packs</div></div>
        </div>
        <p class="cc-cf-hint">Per-report analytics (reports-in-zone · completion) activate once the per-channel renderers begin tagging reports with a <code>form_pack_id</code>. Structural coverage shown here.</p>
      </div>`;
    el('cc-cf-new-event').addEventListener('click', () => { S.editingEvent = {}; render(); });
    body.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => onEventAction(b.getAttribute('data-act'), b.getAttribute('data-id'))));
  }

  async function onEventAction(act, id) {
    const e = S.events.find((x) => x.id === id);
    if (!e) return;
    if (act === 'edit') { S.editingEvent = Object.assign({}, e); render(); return; }
    if (act === 'toggle') {
      try {
        await api('PATCH', `/events/${id}`, { is_active: !e.is_active });
        toast(e.is_active ? 'Event deactivated — zone reverted to default flow.' : 'Event activated.', 'ok');
        refreshAll();
      } catch (err) { toast('Update failed: ' + err.message, 'err'); }
      return;
    }
    if (act === 'del') {
      if (!window.confirm(`Delete crisis event “${e.name}”? This removes the zone configuration (reports already submitted are untouched).`)) return;
      try { await api('DELETE', `/events/${id}`); toast('Event deleted.', 'ok'); refreshAll(); }
      catch (err) { toast('Delete failed: ' + err.message, 'err'); }
    }
  }

  // ── EVENT editor ──────────────────────────────────────────────────────────────
  function renderEventEditor(body) {
    const e = S.editingEvent || {};
    const isNew = !e.id;
    const radius = e.radius_km != null ? e.radius_km : 30;
    const typeOpts = EVENT_CRISIS_TYPES.map(([v, l]) => `<option value="${v}" ${e.crisis_type === v ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const packOpts = ['<option value="">— none (configure later) —</option>']
      .concat(S.packs.map((p) => `<option value="${esc(p.id)}" ${e.form_pack_id === p.id ? 'selected' : ''}>${esc(p.title)} ${p.active_version ? '(v' + p.active_version + ')' : '(no published version)'}</option>`)).join('');
    const radii = [5, 10, 30, 50, 100].map((r) => `<button type="button" class="cc-cf-chip ${r === radius ? 'on' : ''}" data-r="${r}">${r}</button>`).join('');
    body.innerHTML = `
      <div class="cc-cf-card">
        <div class="cc-cf-row"><h3 style="margin:0">${isNew ? 'New crisis event' : 'Edit crisis event'}</h3>
          <div class="cc-cf-spacer"></div><button class="cc-cf-btn ghost sm" id="cc-cf-ev-back">← Back</button></div>
        <div class="cc-cf-grid2" style="margin-top:12px">
          <div>
            <div class="cc-cf-fld"><label class="cc-cf-lbl">Crisis name</label><input class="cc-cf-input" id="cc-ev-name" value="${esc(e.name || '')}" placeholder="Forest Fire — Bandipur"></div>
            <div class="cc-cf-fld"><label class="cc-cf-lbl">Crisis type</label><select class="cc-cf-select" id="cc-ev-type">${typeOpts}</select></div>
            <div class="cc-cf-fld"><label class="cc-cf-lbl">Starts</label>
              <div class="cc-cf-dt">
                <input class="cc-cf-input" type="date" id="cc-ev-start-date" value="${isoToLocalDate(e.started_at)}" aria-label="Start date">
                <select class="cc-cf-select" id="cc-ev-start-time" aria-label="Start time">${timeOptions(isoToLocalTime(e.started_at))}</select>
              </div></div>
            <div class="cc-cf-fld"><label class="cc-cf-lbl">Ends</label>
              <div class="cc-cf-dt">
                <input class="cc-cf-input" type="date" id="cc-ev-end-date" value="${isoToLocalDate(e.ended_at)}" aria-label="End date">
                <select class="cc-cf-select" id="cc-ev-end-time" aria-label="End time">${timeOptions(isoToLocalTime(e.ended_at))}</select>
              </div></div>
            <p class="cc-cf-hint">Leave the start/end <em>date</em> blank for an open-ended window. When the window closes (or you deactivate), the zone auto-reverts to the default flow.</p>
          </div>
          <div>
            <div class="cc-cf-fld"><label class="cc-cf-lbl">Find a place</label>
              <div class="cc-cf-geo">
                <input class="cc-cf-input" id="cc-ev-geo-q" placeholder="Type a place name → fills coordinates" autocomplete="off">
                <button type="button" class="cc-cf-btn sm" id="cc-ev-geo-go">Search</button>
              </div></div>
            <div class="cc-cf-grid2">
              <div class="cc-cf-fld"><label class="cc-cf-lbl">Center latitude</label><input class="cc-cf-input" id="cc-ev-lat" value="${e.center_lat != null ? esc(e.center_lat) : ''}" placeholder="11.6680"></div>
              <div class="cc-cf-fld"><label class="cc-cf-lbl">Center longitude</label><input class="cc-cf-input" id="cc-ev-lng" value="${e.center_lng != null ? esc(e.center_lng) : ''}" placeholder="76.6340"></div>
            </div>
            <div class="cc-cf-geo-res" id="cc-ev-geo-res" hidden></div>
            <div class="cc-cf-fld"><label class="cc-cf-lbl">Radius (km)</label><div class="cc-cf-chips" id="cc-ev-radius">${radii}</div></div>
            <div class="cc-cf-fld"><label class="cc-cf-lbl">Question pack</label><select class="cc-cf-select" id="cc-ev-pack">${packOpts}</select></div>
            <div class="cc-cf-fld"><label class="cc-cf-lbl"><input type="checkbox" id="cc-ev-active" ${e.is_active ? 'checked' : ''} style="width:auto;margin-right:7px;vertical-align:middle">Active (matches reporters once published &amp; in-window)</label></div>
            ${(!isNew && creatorName(e)) ? `<p class="cc-cf-hint" style="margin-top:0">Created by ${esc(creatorName(e))}${e.created_at ? ` · ${fmtDate(e.created_at)}` : ''}</p>` : ''}
          </div>
        </div>
        <div class="cc-cf-row" style="margin-top:6px">
          <div class="cc-cf-spacer"></div>
          <button class="cc-cf-btn ghost" id="cc-cf-ev-cancel">Cancel</button>
          <button class="cc-cf-btn primary" id="cc-cf-ev-save">${isNew ? 'Create event' : 'Save changes'}</button>
        </div>
      </div>`;
    // radius chip toggle
    let selRadius = radius;
    body.querySelectorAll('#cc-ev-radius .cc-cf-chip').forEach((c) => c.addEventListener('click', () => {
      selRadius = Number(c.getAttribute('data-r'));
      body.querySelectorAll('#cc-ev-radius .cc-cf-chip').forEach((x) => x.classList.toggle('on', x === c));
    }));
    // ── bi-directional geocoding ──────────────────────────────────────────────
    const geoRes = el('cc-ev-geo-res');
    function showGeoRes(r) {
      if (!geoRes) return;
      if (!r || !r.location_name) { geoRes.hidden = true; geoRes.innerHTML = ''; return; }
      const conf = r.confidence ? `<span class="cc-cf-geo-chip ${esc(r.confidence)}">${esc(r.confidence)}</span>` : '';
      const src = r.source ? `<span class="cc-cf-geo-chip src">${esc(r.source)}</span>` : '';
      geoRes.hidden = false;
      geoRes.innerHTML = `<span class="cc-cf-geo-pin">📍</span><span class="cc-cf-geo-name">${esc(r.location_name)}</span>${conf}${src}`;
    }
    async function doForward() {
      const q = (el('cc-ev-geo-q').value || '').trim();
      if (q.length < 3) { toast('Type at least 3 characters of a place name.', 'err'); return; }
      const btn = el('cc-ev-geo-go'); const old = btn.textContent; btn.textContent = '…'; btn.disabled = true;
      try {
        const r = await geocode('describe', { text: q });
        if (r && typeof r.latitude === 'number' && typeof r.longitude === 'number') {
          el('cc-ev-lat').value = Number(r.latitude).toFixed(6);
          el('cc-ev-lng').value = Number(r.longitude).toFixed(6);
          showGeoRes(r);
        } else { toast('Could not resolve that place — enter coordinates manually.', 'err'); }
      } catch (err) { toast('Lookup failed: ' + err.message, 'err'); }
      finally { btn.textContent = old; btn.disabled = false; }
    }
    async function doReverse() {
      const lat = parseFloat(el('cc-ev-lat').value), lng = parseFloat(el('cc-ev-lng').value);
      if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) return;
      try { showGeoRes(await geocode('reverse', { lat, lng })); } catch (_e) { /* non-fatal */ }
    }
    el('cc-ev-geo-go').addEventListener('click', doForward);
    el('cc-ev-geo-q').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); doForward(); } });
    el('cc-ev-lat').addEventListener('change', doReverse);
    el('cc-ev-lng').addEventListener('change', doReverse);
    if (!isNew && e.center_lat != null && e.center_lng != null) doReverse(); // show the saved zone's name

    el('cc-cf-ev-back').addEventListener('click', () => { S.editingEvent = undefined; render(); });
    el('cc-cf-ev-cancel').addEventListener('click', () => { S.editingEvent = undefined; render(); });
    el('cc-cf-ev-save').addEventListener('click', () => saveEvent(e, () => selRadius));
  }

  async function saveEvent(orig, getRadius) {
    const name = el('cc-ev-name').value.trim();
    const lat = parseFloat(el('cc-ev-lat').value);
    const lng = parseFloat(el('cc-ev-lng').value);
    if (!name) { toast('Crisis name is required.', 'err'); return; }
    if (isNaN(lat) || lat < -90 || lat > 90) { toast('Center latitude must be between -90 and 90.', 'err'); return; }
    if (isNaN(lng) || lng < -180 || lng > 180) { toast('Center longitude must be between -180 and 180.', 'err'); return; }
    const startISO = dateTimeToISO(el('cc-ev-start-date').value, el('cc-ev-start-time').value);
    const endISO = dateTimeToISO(el('cc-ev-end-date').value, el('cc-ev-end-time').value);
    if (startISO && endISO && Date.parse(endISO) <= Date.parse(startISO)) { toast('End must be after start.', 'err'); return; }
    const packId = el('cc-ev-pack').value || null;
    const payload = {
      name, crisis_type: el('cc-ev-type').value || null,
      center_lat: lat, center_lng: lng, radius_km: getRadius(),
      started_at: startISO, ended_at: endISO,
      form_pack_id: packId, is_active: el('cc-ev-active').checked,
    };
    if (payload.is_active && !packId) {
      toast('Bind a question pack before activating (an active event with no pack matches nothing).', 'err');
      return;
    }
    try {
      if (orig && orig.id) {
        await api('PATCH', `/events/${orig.id}`, payload);
        toast('Event saved.', 'ok');
      } else {
        await api('POST', '/events', payload);
        toast('Event created.', 'ok');
      }
      S.editingEvent = undefined;
      refreshAll();
    } catch (err) { toast('Save failed: ' + err.message, 'err'); }
  }

  // ── PACKS tab ────────────────────────────────────────────────────────────────
  function renderPacks(body) {
    let rows = '';
    if (!S.packs.length) {
      rows = `<tr><td colspan="5"><div class="cc-cf-empty">No question packs yet. Create one, curate its blocks, then publish — and bind it to a crisis event.</div></td></tr>`;
    } else {
      rows = S.packs.map((p) => `<tr>
        <td><div style="font-weight:600">${esc(p.title)}</div><div style="color:var(--text-dim,#6b7689);font-size:11.5px">${esc(p.key)}</div></td>
        <td>${esc(p.crisis_type || '—')}</td>
        <td>${p.active_version ? 'v' + p.active_version : '—'}</td>
        <td>${p.is_archived ? '<span class="cc-cf-pill archived">Archived</span>' : (p.active_version ? '<span class="cc-cf-pill published">Published</span>' : '<span class="cc-cf-pill draft">Draft</span>')}</td>
        <td><div class="cc-cf-row" style="gap:6px;flex-wrap:nowrap">
          <button class="cc-cf-btn sm" data-pact="build" data-id="${esc(p.id)}">Build &amp; publish</button>
          <button class="cc-cf-btn sm ghost" data-pact="archive" data-id="${esc(p.id)}">${p.is_archived ? 'Unarchive' : 'Archive'}</button>
        </div></td>
      </tr>`).join('');
    }
    body.innerHTML = `
      <div class="cc-cf-card">
        <div class="cc-cf-row"><h3 style="margin:0">Question packs</h3><div class="cc-cf-spacer"></div>
          <button class="cc-cf-btn primary" id="cc-cf-new-pack">+ New pack</button></div>
        <p class="cc-cf-hint" style="margin:8px 0 12px">Packs are curated from approved question blocks + crisis stock questions. Stage 1 (photo · audio · location) is never part of a pack.</p>
        <table class="cc-cf-table">
          <thead><tr><th>Title / key</th><th>Type</th><th>Active</th><th>Status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    el('cc-cf-new-pack').addEventListener('click', newPack);
    body.querySelectorAll('[data-pact]').forEach((b) => b.addEventListener('click', () => onPackAction(b.getAttribute('data-pact'), b.getAttribute('data-id'))));
  }

  async function newPack() {
    const title = window.prompt('Pack title (e.g. "Forest Fire — rapid assessment"):');
    if (!title || !title.trim()) return;
    // derive a stable key from the title; ensure uniqueness with a short suffix
    const base = title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'pack';
    const key = `${base}-${Math.abs(hashStr(base + S.packs.length + title)).toString(36).slice(0, 4)}`;
    try {
      const pack = await api('POST', '/packs', { key, title: title.trim() });
      toast('Pack created — curate its blocks below.', 'ok');
      S.packs.unshift(pack);
      openBuilder(pack.id);
    } catch (err) { toast('Create failed: ' + err.message, 'err'); }
  }
  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; } return h; }

  async function onPackAction(act, id) {
    const p = S.packs.find((x) => x.id === id);
    if (!p) return;
    if (act === 'build') { openBuilder(id); return; }
    if (act === 'archive') {
      try {
        await api('PATCH', `/packs/${id}`, { is_archived: !p.is_archived });
        toast(p.is_archived ? 'Pack unarchived.' : 'Pack archived (no longer matched).', 'ok');
        refreshAll();
      } catch (err) { toast('Update failed: ' + err.message, 'err'); }
    }
  }

  // ── BUILDER ────────────────────────────────────────────────────────────────────
  async function openBuilder(packId) {
    S.builderPackId = packId;
    S.builderPack = S.packs.find((x) => x.id === packId) || null;
    S.builderUnknownFields = [];
    // default the stock set from the pack's crisis_type if any
    const ct = (S.builderPack && S.builderPack.crisis_type) || '';
    S.builderStockKey = CRISIS_TO_STOCK[ct] || 'WILDFIRE';
    // fresh working copy of the block library
    S.builderBlocks = {
      core: CORE_BLOCKS.map((b) => Object.assign({}, b, { field: clone(b.field) })),
      stock: stockCopy(S.builderStockKey),
    };
    render();
    // load existing versions and pre-toggle from the latest schema
    try {
      const versions = await api('GET', `/packs/${packId}/versions`);
      S.builderVersions = Array.isArray(versions) ? versions : [];
      const latest = S.builderVersions[0]; // endpoint returns version desc
      if (latest && latest.schema_json) preloadFromSchema(latest.schema_json);
    } catch (_e) { S.builderVersions = []; }
    render();
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function stockCopy(key) {
    return (STOCK_PACKS[key] || []).map((b) => Object.assign({}, b, { field: clone(b.field) }));
  }
  function preloadFromSchema(schema) {
    const keys = new Set();
    (schema.sections || []).forEach((sec) => (sec.fields || []).forEach((f) => f && f.key && keys.add(f.key)));
    const known = new Set();
    S.builderBlocks.core.forEach((b) => { known.add(b.field.key); if (!b.locked) b.on = keys.has(b.field.key); });
    S.builderBlocks.stock.forEach((b) => { known.add(b.field.key); b.on = keys.has(b.field.key); });
    // any field key the curated UI doesn't recognise (hand-authored) — flag, don't clobber
    S.builderUnknownFields = [...keys].filter((k) => !known.has(k));
  }

  function selectedBlocks() {
    return S.builderBlocks.core.filter((b) => b.on).concat(S.builderBlocks.stock.filter((b) => b.on));
  }
  function buildSchema() {
    const pack = S.builderPack || {};
    const sel = selectedBlocks();
    const stage2 = sel.filter((b) => b.stage === 2).map((b) => clone(b.field));
    const stage3 = sel.filter((b) => b.stage === 3).map((b) => clone(b.field));
    const sections = [];
    if (stage2.length) sections.push({ id: 'classify', stage: 2, title: 'Assessment', fields: stage2 });
    if (stage3.length) sections.push({ id: 'details', stage: 3, title: 'Details', fields: stage3 });
    return { schema_version: 1, key: pack.key, title: pack.title, sections };
  }

  function renderBuilder(body) {
    const pack = S.builderPack || {};
    const stockSel = Object.keys(STOCK_PACKS).map((k) => `<option value="${k}" ${k === S.builderStockKey ? 'selected' : ''}>${esc(k.charAt(0) + k.slice(1).toLowerCase())} stock pack</option>`).join('');
    const versionsHTML = S.builderVersions.length ? S.builderVersions.map((v) => {
      const isActive = pack.active_version === v.version;
      // Publish a draft/archived version (demotes the prior published one).
      const showPublish = v.status !== 'published';
      // Re-activate an EARLIER published version (rollback repoints active_version
      // without re-linting) — only valid on an already-published, non-active version.
      const showRollback = v.status === 'published' && !isActive;
      return `<tr>
        <td>v${v.version}</td>
        <td><span class="cc-cf-pill ${v.status}">${esc(v.status)}</span>${isActive ? ' <span class="cc-cf-pill live" style="margin-left:6px">active</span>' : ''}</td>
        <td>${v.published_at ? fmtDate(v.published_at) : (v.created_at ? fmtDate(v.created_at) : '—')}</td>
        <td><div class="cc-cf-row" style="gap:6px;flex-wrap:nowrap">
          ${showPublish ? `<button class="cc-cf-btn sm primary" data-vact="publish" data-v="${v.version}">Publish</button>` : ''}
          ${showRollback ? `<button class="cc-cf-btn sm" data-vact="rollback" data-v="${v.version}">Make active</button>` : ''}
        </div></td>
      </tr>`;
    }).join('') : `<tr><td colspan="4"><div class="cc-cf-empty" style="padding:14px">No versions saved yet.</div></td></tr>`;

    body.innerHTML = `
      <div class="cc-cf-card">
        <div class="cc-cf-row"><h3 style="margin:0">Build pack — ${esc(pack.title || '')}</h3>
          <span style="color:var(--text-dim,#6b7689);font-size:12px">${esc(pack.key || '')}</span>
          <div class="cc-cf-spacer"></div><button class="cc-cf-btn ghost sm" id="cc-cf-b-back">← Back to packs</button></div>
        ${S.builderUnknownFields.length ? `<div class="cc-cf-warn">⚠ The latest version has ${S.builderUnknownFields.length} field(s) this curated builder doesn't manage (${esc(S.builderUnknownFields.join(', '))}). Saving a new version here will replace them with the curated selection below.</div>` : ''}
        <div id="cc-cf-errbox"></div>
        <div class="cc-cf-build">
          <div>
            <div class="cc-cf-lock">🔒 Stage 1 (photo · audio · location) — unchanged, shared by every crisis. Packs only curate Stage 2 / 3.</div>
            <div class="cc-cf-fld"><label class="cc-cf-lbl">Crisis stock questions</label>
              <select class="cc-cf-select" id="cc-cf-stock">${stockSel}</select></div>
            <div class="cc-cf-blocks">
              <h4>Crisis-specific questions (stock)</h4><div id="cc-cf-stock-blocks"></div>
              <h4>Reusable question blocks (always available)</h4><div id="cc-cf-core-blocks"></div>
            </div>
          </div>
          <div>
            <h3>Preview — as the reporter sees it</h3>
            <div class="cc-cf-chtabs">
              <button data-ch="pwa" class="${S.previewCh === 'pwa' ? 'on' : ''}">📱 PWA</button>
              <button data-ch="rn" class="${S.previewCh === 'rn' ? 'on' : ''}">🤖 RN</button>
              <button data-ch="tg" class="${S.previewCh === 'tg' ? 'on' : ''}">✈️ Telegram</button>
            </div>
            <div class="cc-cf-phone" id="cc-cf-preview"></div>
          </div>
        </div>
        <div class="cc-cf-row" style="margin-top:14px">
          <button class="cc-cf-btn ghost" id="cc-cf-validate">Validate schema</button>
          <div class="cc-cf-spacer"></div>
          <button class="cc-cf-btn" id="cc-cf-savedraft">Save as draft version</button>
          <button class="cc-cf-btn primary" id="cc-cf-savepublish">Save &amp; publish</button>
        </div>
        <p class="cc-cf-hint">One common schema → rendered per channel. Publish is explicit; a published pack only matches reporters once it's bound to an <strong>active, in-window</strong> crisis event.</p>
      </div>
      <div class="cc-cf-card">
        <h3>Versions</h3>
        <table class="cc-cf-table"><thead><tr><th>Version</th><th>Status</th><th>Date</th><th></th></tr></thead><tbody>${versionsHTML}</tbody></table>
      </div>`;

    renderBlockList('cc-cf-stock-blocks', S.builderBlocks.stock);
    renderBlockList('cc-cf-core-blocks', S.builderBlocks.core);
    renderPreview();

    el('cc-cf-b-back').addEventListener('click', () => { S.builderPackId = null; S.builderPack = null; render(); refreshAll(); });
    el('cc-cf-stock').addEventListener('change', (e) => {
      S.builderStockKey = e.target.value;
      S.builderBlocks.stock = stockCopy(S.builderStockKey);
      render();
    });
    body.querySelectorAll('.cc-cf-chtabs button').forEach((b) => b.addEventListener('click', () => { S.previewCh = b.getAttribute('data-ch'); renderPreview(); body.querySelectorAll('.cc-cf-chtabs button').forEach((x) => x.classList.toggle('on', x === b)); }));
    el('cc-cf-validate').addEventListener('click', validateSchema);
    el('cc-cf-savedraft').addEventListener('click', () => saveDraft(false));
    el('cc-cf-savepublish').addEventListener('click', () => saveDraft(true));
    body.querySelectorAll('[data-vact]').forEach((b) => b.addEventListener('click', () => onVersionAction(b.getAttribute('data-vact'), Number(b.getAttribute('data-v')))));
  }

  function renderBlockList(mountId, blocks) {
    const mount = el(mountId);
    if (!mount) return;
    mount.innerHTML = blocks.map((b, i) => `
      <div class="cc-cf-blk ${b.on ? 'on' : ''} ${b.locked ? 'locked' : ''}" data-i="${i}" title="${b.locked ? 'Kept on for taxonomy' : ''}">
        <div class="gi">${b.icon}</div>
        <div class="meta"><div class="t">${esc(b.title)}</div><div class="d">${esc(b.desc || '')}</div></div>
        <span class="ty">${esc(b.ty)}</span>
        <div class="cc-cf-sw"></div>
      </div>`).join('');
    mount.querySelectorAll('.cc-cf-blk').forEach((node) => node.addEventListener('click', () => {
      const b = blocks[Number(node.getAttribute('data-i'))];
      if (!b || b.locked) return;
      b.on = !b.on;
      node.classList.toggle('on', b.on);
      renderPreview();
    }));
  }

  // ── per-channel preview (renders from the assembled schema) ───────────────────
  function renderPreview() {
    const mount = el('cc-cf-preview');
    if (!mount) return;
    const schema = buildSchema();
    const ch = S.previewCh;
    const allFields = (schema.sections || []).reduce((acc, sec) => acc.concat(sec.fields.map((f) => ({ f, stage: sec.stage }))), []);
    if (!allFields.length) { mount.innerHTML = `<div class="cc-cf-pv-head">▾ inside the active crisis zone ▾</div><div class="cc-cf-empty" style="padding:30px">No questions selected.</div>`; return; }
    let html = `<div class="cc-cf-pv-head">▾ inside the active crisis zone ▾</div>`;
    if (ch === 'tg') {
      html += `<div class="cc-cf-stage-lbl">TELEGRAM — crisis pack as button steps</div><div class="cc-cf-tg">`;
      allFields.slice(0, 6).forEach(({ f }) => {
        html += `<div class="bub">${esc(f.label || f.key)}</div>`;
        html += tgControl(f);
      });
      html += `</div>`;
    } else {
      html += `<div class="cc-cf-stage-lbl">STAGE 2 · 3 — ${ch === 'pwa' ? 'PWA' : 'React Native'} (crisis pack)</div>`;
      allFields.forEach(({ f }) => {
        html += `<div class="cc-cf-q"><div class="qt">${esc(f.label || f.key)}</div>${appControl(f)}</div>`;
      });
    }
    mount.innerHTML = html;
  }
  function appControl(f) {
    if (f.type === 'yes_no') return `<span class="cc-cf-opt sel">Yes</span><span class="cc-cf-opt">No</span>`;
    if (f.type === 'single_select' || f.type === 'multi_select') {
      return (f.options || []).slice(0, 6).map((o, i) => `<span class="cc-cf-opt ${i === 0 ? 'sel' : ''}">${esc(o.label || o.value)}</span>`).join('');
    }
    if (f.type === 'integer') return `<div class="cc-cf-stub">Enter a number…</div>`;
    if (f.type === 'short_text' || f.type === 'long_text') return `<div class="cc-cf-stub">${f.type === 'long_text' ? 'Describe what you see…' : 'Short answer…'}</div>`;
    if (f.type === 'building') return `<div class="cc-cf-stub">🏗 Tap a building footprint or type a name</div>`;
    if (f.type === 'location') return `<div class="cc-cf-stub">📍 Confirm location on the map</div>`;
    if (f.type === 'photo') return `<div class="cc-cf-stub">📸 Add a photo</div>`;
    if (f.type === 'audio') return `<div class="cc-cf-stub">🎤 Voice note</div>`;
    if (f.type === 'severity') return `<span class="cc-cf-opt">Minor</span><span class="cc-cf-opt sel">Moderate</span><span class="cc-cf-opt">Severe</span>`;
    return `<div class="cc-cf-stub">—</div>`;
  }
  function tgControl(f) {
    if (f.type === 'yes_no') return `<button class="tgbtn">✅ Yes</button><button class="tgbtn">❌ No</button>`;
    if (f.type === 'single_select' || f.type === 'multi_select') {
      return (f.options || []).slice(0, 6).map((o) => `<button class="tgbtn">${esc(o.label || o.value)}</button>`).join('');
    }
    if (f.type === 'building') return `<div class="bub" style="color:#9aa6b8">Type a building name or send your location</div>`;
    if (f.type === 'photo' || f.type === 'audio') return `<div class="bub" style="color:#9aa6b8">📸 Send a photo or 🎤 voice note</div>`;
    return `<div class="bub" style="color:#9aa6b8">Type your answer…</div>`;
  }

  // ── validate / save / publish / rollback ──────────────────────────────────────
  function showErrs(errs) {
    const box = el('cc-cf-errbox');
    if (!box) return;
    if (!errs || !errs.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="cc-cf-errs"><strong>Schema has ${errs.length} problem(s):</strong><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
  }
  async function validateSchema() {
    const schema = buildSchema();
    if (!schema.sections.length) { showErrs(['Select at least one question.']); return null; }
    try {
      const res = await api('POST', '/packs/validate', { schema_json: schema });
      if (res && res.valid) { showErrs([]); toast('Schema is valid.', 'ok'); return true; }
      showErrs((res && res.errors) || ['Unknown validation error']);
      return false;
    } catch (err) { showErrs([err.message]); return false; }
  }
  async function saveDraft(thenPublish) {
    if (S.busy) return;
    const schema = buildSchema();
    if (!schema.sections.length) { showErrs(['Select at least one question before saving.']); return; }
    S.busy = true;
    try {
      let ver;
      try {
        ver = await api('POST', `/packs/${S.builderPackId}/versions`, { schema_json: schema });
      } catch (err) {
        if (err.status === 400 && err.data && err.data.detail && err.data.detail.schema_errors) {
          showErrs(err.data.detail.schema_errors);
        } else { showErrs([err.message]); }
        return;
      }
      showErrs([]);
      if (thenPublish) {
        const pack = await api('POST', `/packs/${S.builderPackId}/publish`, { version: ver.version });
        S.builderPack = pack;
        const idx = S.packs.findIndex((p) => p.id === pack.id);
        if (idx >= 0) S.packs[idx] = pack;
        toast(`Published v${ver.version}. Bind it to an active crisis event to go live.`, 'ok');
      } else {
        toast(`Saved draft v${ver.version}.`, 'ok');
      }
      // refresh versions
      const versions = await api('GET', `/packs/${S.builderPackId}/versions`).catch(() => S.builderVersions);
      S.builderVersions = Array.isArray(versions) ? versions : S.builderVersions;
      render();
    } catch (err) { toast('Save failed: ' + err.message, 'err'); }
    finally { S.busy = false; }
  }
  async function onVersionAction(act, version) {
    try {
      const pack = await api('POST', `/packs/${S.builderPackId}/${act}`, { version });
      S.builderPack = pack;
      const idx = S.packs.findIndex((p) => p.id === pack.id);
      if (idx >= 0) S.packs[idx] = pack;
      toast(act === 'publish' ? `Published v${version}.` : `Active version is now v${version}.`, 'ok');
      const versions = await api('GET', `/packs/${S.builderPackId}/versions`).catch(() => S.builderVersions);
      S.builderVersions = Array.isArray(versions) ? versions : S.builderVersions;
      render();
    } catch (err) { toast('Action failed: ' + err.message, 'err'); }
  }

  // ── launcher (injects an admin-only item into the existing user-menu) ──────────
  function mountLauncher() {
    try {
      const dropdown = el('user-menu-dropdown');
      if (!dropdown || el('btn-crisis-forms')) return;
      const btn = document.createElement('button');
      btn.className = 'user-menu-item';
      btn.id = 'btn-crisis-forms';
      btn.type = 'button';
      btn.innerHTML = `<i class="fa-solid fa-clipboard-list"></i><span>Crisis Forms</span>`;
      btn.addEventListener('click', () => {
        if (window._toggleUserMenu) { try { window._toggleUserMenu(false); } catch (_e) { } }
        openOverlay();
      });
      // gate to admins (app.js toggles the sibling admin items by id; ours we gate ourselves)
      btn.style.display = isAdmin() ? '' : 'none';
      const divider = el('user-menu-admin-divider');
      if (divider && divider.parentNode === dropdown) dropdown.insertBefore(btn, divider);
      else dropdown.insertBefore(btn, dropdown.firstChild);
    } catch (_e) { /* never break the dashboard */ }
  }

  function boot() {
    try {
      mountLauncher();
      // re-check after a short delay in case the user chip renders late post-auth
      setTimeout(() => {
        const b = el('btn-crisis-forms');
        if (b) b.style.display = isAdmin() ? '' : 'none';
        else mountLauncher();
      }, 1500);
    } catch (_e) { /* swallow — additive module must not break boot */ }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }

  // expose a tiny hook for manual open (debug / future deep-link)
  window.openCrisisForms = openOverlay;

  // Debug/test hook (mirrors the app.js window.__crisp* convention) — lets the
  // schema contract be verified headlessly without a browser session. Pure: it
  // assembles a schema from the block library exactly as the builder would.
  window.__ccCrisis = {
    // REQUIRED by router.js hideAll(): every close path (✕ button, ESC, backdrop)
    // routes to '/', and the router dismisses this overlay via
    // window.__ccCrisis.closeOverlay(). Omitting it (the original bug) left the
    // crisis-forms modal pinned on top of the Control Center on every close.
    // openOverlay is exported for parity with __ccSettings / __ccHome.
    openOverlay, closeOverlay,
    buildSchemaFor: function (stockKey, packMeta) {
      S.builderPack = packMeta || { key: 'test-pack', title: 'Test pack' };
      S.builderBlocks = {
        core: CORE_BLOCKS.map((b) => Object.assign({}, b, { field: clone(b.field), on: true })),
        stock: stockCopy(stockKey || 'WILDFIRE').map((b) => Object.assign({}, b, { on: true })),
      };
      return buildSchema();
    },
    stockKeys: function () { return Object.keys(STOCK_PACKS); },
  };
})();
