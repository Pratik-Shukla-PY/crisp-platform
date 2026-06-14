/**
 * cc-wizard.js - "Start New Operation" wizard (Operations redesign v2, P2).
 *
 * A 4-step modal that creates and launches an operation:
 *   1. Select Form    - pick a curated template (published pack) OR start a new form
 *   2. Create / Edit  - toggle question blocks (reuses window.CrispFormKit data)
 *   3. Preview        - mobile-style phone frame: exactly what the reporter sees
 *   4. Launch         - name / region / dates / crisis type → publish
 *
 * NO DRAFT PERSISTENCE: every step's state lives in the in-memory `wiz` object;
 * nothing is written to the DB until Step 4's single atomic call
 * (POST /operations/launch-with-form). Closing the modal (Escape / click-outside
 * / ✕) discards `wiz` entirely. The modal lives inside its own overlay (not a
 * hash route), so any route change also tears it down.
 */
(function () {
  'use strict';
  if (window.__ccWizardLoaded) return;
  window.__ccWizardLoaded = true;

  // ── env / api ──────────────────────────────────────────────────────────────
  const el = (id) => document.getElementById(id);
  const _LAN_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
  const _isLocalDev = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname)
    || _LAN_RE.test(window.location.hostname);
  const BACKEND_HOST = _isLocalDev ? `http://${window.location.hostname}:8000` : window.location.origin;
  const API = `${BACKEND_HOST}/api/v1`;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  async function api(method, path, body) {
    const token = localStorage.getItem('crisp_token') || '';
    const res = await fetch(`${API}${path}`, {
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
      body: body != null ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const det = data && data.detail;
      const msg = (det && (det.message || (typeof det === 'string' ? det : null)))
        || (det && det.schema_errors && det.schema_errors.join('; ')) || res.statusText;
      const err = new Error(msg); err.status = res.status; err.data = data; throw err;
    }
    return data;
  }
  function toast(msg, kind) {
    if (typeof window.ccToast === 'function') { window.ccToast(msg, kind); return; }
    let t = el('cc-wiz-toast');
    if (!t) { t = document.createElement('div'); t.id = 'cc-wiz-toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = `cc-wiz-toast ${kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : ''} show`;
    clearTimeout(t._h); t._h = setTimeout(() => { t.className = 'cc-wiz-toast'; }, 3200);
  }

  // ── form kit (shared with cc-crisis.js) ──────────────────────────────────────
  const KIT = () => window.CrispFormKit || { CORE_BLOCKS: [], STOCK_PACKS: {}, CRISIS_TO_STOCK: {}, EVENT_CRISIS_TYPES: [] };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const CRISIS_ICON = {
    WILDFIRE: '🔥', FLOOD: '🌊', EARTHQUAKE: '🏚', CYCLONE: '🌀', TSUNAMI: '🌊',
    LANDSLIDE: '⛰', EXPLOSION: '💥', CHEMICAL_INCIDENT: '☣', CONFLICT: '🛡', CIVIL_UNREST: '✊',
  };
  const ctIcon = (ct) => CRISIS_ICON[String(ct || '').toUpperCase()] || '⚠';

  function freshBlocks(stockKey) {
    const k = KIT();
    return {
      core: (k.CORE_BLOCKS || []).map((b) => Object.assign({}, b, { field: clone(b.field) })),
      stock: (k.STOCK_PACKS[stockKey] || []).map((b) => Object.assign({}, b, { field: clone(b.field) })),
    };
  }
  function preloadFromSchema(schema) {
    const byKey = {};
    (schema.sections || []).forEach((sec) => (sec.fields || []).forEach((f) => { if (f && f.key) byKey[f.key] = { field: f, stage: sec.stage }; }));
    const keys = new Set(Object.keys(byKey));
    const known = new Set();
    wiz.blocks.core.forEach((b) => { known.add(b.field.key); if (!b.locked) b.on = keys.has(b.field.key); });
    wiz.blocks.stock.forEach((b) => { known.add(b.field.key); b.on = keys.has(b.field.key); });
    // hand-authored fields the curated kit doesn't manage - carried through verbatim
    wiz.extraFields = [...keys].filter((kk) => !known.has(kk)).map((kk) => ({ field: byKey[kk].field, stage: byKey[kk].stage || 2 }));
  }
  function selectedBlocks() {
    if (!wiz.blocks) return [];
    return wiz.blocks.core.filter((b) => b.on).concat(wiz.blocks.stock.filter((b) => b.on));
  }
  function buildSchema() {
    const sel = selectedBlocks().map((b) => ({ field: clone(b.field), stage: b.stage }))
      .concat((wiz.extraFields || []).map((e) => ({ field: clone(e.field), stage: e.stage })));
    const stage2 = sel.filter((x) => x.stage === 2).map((x) => x.field);
    const stage3 = sel.filter((x) => x.stage !== 2).map((x) => x.field);
    const sections = [];
    if (stage2.length) sections.push({ id: 'classify', stage: 2, title: 'Assessment', fields: stage2 });
    if (stage3.length) sections.push({ id: 'details', stage: 3, title: 'Details', fields: stage3 });
    return { schema_version: 1, sections };
  }

  // ── wizard state (in-memory only) ────────────────────────────────────────────
  let wiz = null;
  function freshWiz() {
    return {
      step: 1, source: null, templateId: null, formTitle: '',
      stockKey: 'WILDFIRE', blocks: null, extraFields: [], templates: [],
      launch: { name: '', crisis_type: '', center_lat: '', center_lng: '', radius_km: 30, place_name: '', started_at: '', ended_at: '' },
      busy: false, fromCluster: false,
    };
  }

  // ── styles ───────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (el('cc-wiz-styles')) return;
    const css = `
    #cc-wiz-overlay{position:fixed;inset:0;z-index:99995;display:none;align-items:center;justify-content:center;
      background:rgba(6,11,20,.74);backdrop-filter:blur(3px);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    #cc-wiz-overlay.open{display:flex}
    .cc-wiz{width:min(960px,94vw);max-height:92vh;display:flex;flex-direction:column;background:#0e1726;
      border:1px solid #233149;border-radius:16px;color:#E6EDF7;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.5)}
    .cc-wiz-hd{display:flex;align-items:center;gap:14px;padding:15px 18px;border-bottom:1px solid #1c2740;background:#101a2e}
    .cc-wiz-hd h2{font-size:16px;font-weight:800;margin:0;flex:0 0 auto}
    .cc-wiz-x{margin-left:auto;background:transparent;border:0;color:#8aa0bf;font-size:22px;cursor:pointer;line-height:1;padding:2px 6px;border-radius:8px}
    .cc-wiz-x:hover{background:#1b2942;color:#fff}
    .cc-wiz-steps{display:flex;gap:7px;flex-wrap:wrap}
    .cc-wiz-step{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;color:#6b7d99}
    .cc-wiz-step .n{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:800;
      background:#1b2942;color:#8aa0bf;border:1px solid #33476a}
    .cc-wiz-step.on{color:#cfe0f5}.cc-wiz-step.on .n{background:#418FDE;color:#fff;border-color:#418FDE}
    .cc-wiz-step.done .n{background:#1f7a4d;color:#bff3d6;border-color:#1f7a4d}
    .cc-wiz-step .sep{color:#33476a;margin:0 2px}
    .cc-wiz-body{padding:18px;overflow:auto;flex:1}
    .cc-wiz-ft{display:flex;align-items:center;gap:10px;padding:13px 18px;border-top:1px solid #1c2740;background:#101a2e}
    .cc-wiz-sp{flex:1}
    .cc-wiz-btn{background:#1b2942;border:1px solid #33476a;border-radius:9px;padding:8px 16px;color:#cdd8ec;
      font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
    .cc-wiz-btn:hover{border-color:#418FDE;color:#fff}
    .cc-wiz-btn.primary{background:#2563eb;border-color:#2563eb;color:#fff}
    .cc-wiz-btn.primary:hover{background:#1d4ed8}
    .cc-wiz-btn.go{background:#16a34a;border-color:#16a34a;color:#fff}.cc-wiz-btn.go:hover{background:#15803d}
    .cc-wiz-btn:disabled{opacity:.5;cursor:not-allowed}
    .cc-wiz-btn.ghost{background:transparent}
    .cc-wiz-h3{font-size:13px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#8aa0bf;margin:0 0 10px}
    .cc-wiz-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
    .cc-wiz-tpl{display:flex;align-items:center;gap:11px;padding:13px;background:#101a2e;border:1px solid #233149;
      border-radius:11px;cursor:pointer;transition:border-color .12s,background .12s}
    .cc-wiz-tpl:hover{border-color:#418FDE;background:#13203a}
    .cc-wiz-tpl.new{border-style:dashed;border-color:#33476a}
    .cc-wiz-tpl .ic{font-size:22px;width:40px;height:40px;flex:0 0 auto;display:grid;place-items:center;
      background:#13203a;border-radius:9px;border:1px solid #233149}
    .cc-wiz-tpl .t{font-size:13.5px;font-weight:700}
    .cc-wiz-tpl .d{font-size:11px;color:#8aa0bf;margin-top:2px}
    .cc-wiz-sub{font-size:12px;color:#8aa0bf;margin:0 0 14px}
    .cc-wiz-build{display:grid;grid-template-columns:1fr 360px;gap:18px}
    @media(max-width:780px){.cc-wiz-build{grid-template-columns:1fr}}
    .cc-wiz-row{display:flex;align-items:center;gap:9px;margin-bottom:9px}
    .cc-wiz-lbl{font-size:11.5px;font-weight:700;color:#9fb3d1;display:block;margin-bottom:5px}
    .cc-wiz-sel,.cc-wiz-in{width:100%;background:#0b1322;border:1px solid #33476a;border-radius:8px;color:#E6EDF7;
      padding:8px 10px;font-size:13px;font-family:inherit;box-sizing:border-box}
    .cc-wiz-blk{display:flex;align-items:center;gap:10px;padding:9px 11px;background:#101a2e;border:1px solid #233149;
      border-radius:9px;margin-bottom:7px;cursor:pointer}
    .cc-wiz-blk.on{border-color:#2f6f48;background:#0f1d18}
    .cc-wiz-blk.locked{opacity:.85;cursor:default}
    .cc-wiz-blk .gi{font-size:17px;width:26px;text-align:center;flex:0 0 auto}
    .cc-wiz-blk .meta{flex:1;min-width:0}
    .cc-wiz-blk .meta .t{font-size:12.5px;font-weight:600}
    .cc-wiz-blk .meta .d{font-size:10.5px;color:#7d8ea8}
    .cc-wiz-sw{width:34px;height:19px;border-radius:999px;background:#33476a;position:relative;flex:0 0 auto;transition:background .12s}
    .cc-wiz-sw::after{content:'';position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#cdd8ec;transition:transform .12s}
    .cc-wiz-blk.on .cc-wiz-sw{background:#16a34a}.cc-wiz-blk.on .cc-wiz-sw::after{transform:translateX(15px)}
    .cc-wiz-h4{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:#6b7d99;margin:12px 0 7px}
    .cc-wiz-errs{background:rgba(248,113,113,.1);border:1px solid #7f1d1d;border-radius:8px;padding:9px 12px;color:#fca5a5;font-size:12px;margin-bottom:10px}
    .cc-wiz-errs ul{margin:5px 0 0;padding-left:18px}
    /* phone preview */
    .cc-wiz-phone{border:1px solid #243349;border-radius:20px;background:#0a0f18;padding:14px 12px;min-height:420px;max-height:64vh;overflow:auto}
    .cc-wiz-pv-head{text-align:center;font-size:10.5px;color:#5ee9b5;letter-spacing:.05em;margin-bottom:10px}
    .cc-wiz-stage{font-size:10px;font-weight:800;letter-spacing:.06em;color:#6b7d99;text-transform:uppercase;margin:4px 0 10px}
    .cc-wiz-q{margin-bottom:14px}
    .cc-wiz-qt{font-size:13px;font-weight:600;margin-bottom:7px}
    .cc-wiz-opt{display:inline-block;font-size:11.5px;padding:5px 11px;border-radius:999px;border:1px solid #33476a;color:#b6c5dc;margin:0 6px 6px 0}
    .cc-wiz-opt.sel{background:#13314e;border-color:#418FDE;color:#dbeafe}
    .cc-wiz-stub{font-size:11.5px;color:#7d8ea8;padding:8px 11px;border:1px dashed #33476a;border-radius:8px}
    .cc-wiz-empty{color:#7d8ea8;font-size:12px;padding:24px;text-align:center}
    .cc-wiz-geo{display:flex;gap:7px}
    .cc-wiz-geo .cc-wiz-in{flex:1}
    .cc-wiz-2col{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .cc-wiz-3col{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
    .cc-wiz-fld{margin-bottom:13px}
    .cc-wiz-pin{font-size:11.5px;color:#5ee9b5;margin-top:6px}
    .cc-wiz-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(20px);z-index:100000;
      background:#1b2942;border:1px solid #33476a;border-radius:10px;padding:10px 16px;color:#E6EDF7;font-size:13px;
      opacity:0;pointer-events:none;transition:opacity .15s,transform .15s;font-family:Inter,system-ui,sans-serif;max-width:80vw}
    .cc-wiz-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
    .cc-wiz-toast.err{border-color:#7f1d1d;color:#fca5a5}.cc-wiz-toast.ok{border-color:#1f7a4d;color:#bff3d6}
    `;
    const st = document.createElement('style'); st.id = 'cc-wiz-styles'; st.textContent = css; document.head.appendChild(st);
  }

  // ── overlay shell ─────────────────────────────────────────────────────────────
  function ensureOverlay() {
    injectStyles();
    let ov = el('cc-wiz-overlay');
    if (ov) return ov;
    ov = document.createElement('div');
    ov.id = 'cc-wiz-overlay';
    ov.innerHTML = `
      <div class="cc-wiz" role="dialog" aria-modal="true" aria-label="Start a new operation">
        <div class="cc-wiz-hd">
          <h2>Start New Operation</h2>
          <div class="cc-wiz-steps" id="cc-wiz-steps"></div>
          <button class="cc-wiz-x" id="cc-wiz-x" aria-label="Close">✕</button>
        </div>
        <div class="cc-wiz-body" id="cc-wiz-body"></div>
        <div class="cc-wiz-ft" id="cc-wiz-ft"></div>
      </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    el('cc-wiz-x').addEventListener('click', close);
    document.addEventListener('keydown', onKeydown);
    return ov;
  }
  function onKeydown(e) {
    if (!wiz) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'Tab') trapTab(e);
  }
  function trapTab(e) {
    const ov = el('cc-wiz-overlay'); if (!ov) return;
    const f = ov.querySelectorAll('button,input,select,textarea,[tabindex]:not([tabindex="-1"])');
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function open(opts) {
    wiz = freshWiz();
    if (opts && opts.fromCluster) wiz.fromCluster = true;
    ensureOverlay().classList.add('open');
    render();
    loadTemplates();
  }
  function close() {
    wiz = null;                       // discard everything - no DB writes happened
    const ov = el('cc-wiz-overlay');
    if (ov) ov.classList.remove('open');
  }
  async function loadTemplates() {
    try { wiz.templates = await api('GET', '/operations/form-templates') || []; }
    catch (_e) { wiz.templates = []; }
    if (wiz && wiz.step === 1) renderBody();
  }

  // ── render ─────────────────────────────────────────────────────────────────
  function render() { renderSteps(); renderBody(); renderFooter(); }
  function renderSteps() {
    const labels = ['Select form', 'Build form', 'Preview', 'Launch'];
    el('cc-wiz-steps').innerHTML = labels.map((l, i) => {
      const n = i + 1;
      const cls = n === wiz.step ? 'on' : (n < wiz.step ? 'done' : '');
      return `<span class="cc-wiz-step ${cls}"><span class="n">${n < wiz.step ? '✓' : n}</span>${esc(l)}</span>${i < 3 ? '<span class="sep">›</span>' : ''}`;
    }).join('');
  }
  function renderBody() {
    const b = el('cc-wiz-body'); if (!b) return;
    if (wiz.step === 1) renderStep1(b);
    else if (wiz.step === 2) renderStep2(b);
    else if (wiz.step === 3) renderStep3(b);
    else renderStep4(b);
  }
  function renderFooter() {
    const f = el('cc-wiz-ft'); if (!f) return;
    const back = wiz.step > 1 ? `<button class="cc-wiz-btn ghost" id="cc-wiz-back">← Back</button>` : '';
    let next = '';
    if (wiz.step === 1) next = '';                                   // Step 1 advances on selection
    else if (wiz.step === 2) next = `<button class="cc-wiz-btn primary" id="cc-wiz-next">Preview →</button>`;
    else if (wiz.step === 3) next = `<button class="cc-wiz-btn primary" id="cc-wiz-next">Continue →</button>`;
    else next = `<button class="cc-wiz-btn go" id="cc-wiz-launch">${wiz.busy ? 'Launching…' : '🚀 Launch operation'}</button>`;
    f.innerHTML = `${back}<div class="cc-wiz-sp"></div>${next}`;
    if (el('cc-wiz-back')) el('cc-wiz-back').addEventListener('click', goBack);
    if (el('cc-wiz-next')) el('cc-wiz-next').addEventListener('click', goNext);
    if (el('cc-wiz-launch')) el('cc-wiz-launch').addEventListener('click', publish);
  }
  function goBack() {
    if (wiz.step === 2) { wiz.step = 1; wiz.blocks = null; }   // back to template choice
    else wiz.step -= 1;
    render();
  }
  function goNext() {
    if (wiz.step === 2) {
      if (!selectedBlocks().length && !(wiz.extraFields || []).length) { toast('Select at least one question.', 'err'); return; }
    }
    wiz.step += 1; render();
  }

  // ── Step 1 - Select form ─────────────────────────────────────────────────────
  function renderStep1(b) {
    const kit = KIT();
    const starters = Object.keys(kit.STOCK_PACKS || {});
    const tpls = wiz.templates || [];
    b.innerHTML = `
      <p class="cc-wiz-sub">Pick a curated template to start from, or build a new form. You'll be able to edit it in the next step.</p>
      <div class="cc-wiz-h3">Curated templates</div>
      <div class="cc-wiz-grid" id="cc-wiz-tpls">
        <div class="cc-wiz-tpl new" data-new="1"><div class="ic">＋</div><div><div class="t">Create a new form</div><div class="d">Start from the standard question blocks</div></div></div>
        ${starters.map((s) => `<div class="cc-wiz-tpl" data-stock="${esc(s)}"><div class="ic">${ctIcon(s)}</div><div><div class="t">${esc(s.charAt(0) + s.slice(1).toLowerCase())} starter</div><div class="d">${(kit.STOCK_PACKS[s] || []).length} crisis questions + core</div></div></div>`).join('')}
      </div>
      ${tpls.length ? `<div class="cc-wiz-h3" style="margin-top:18px">Your published packs</div>
      <div class="cc-wiz-grid">
        ${tpls.map((t) => {
          const nf = (t.schema_json && t.schema_json.sections || []).reduce((a, s) => a + (s.fields || []).length, 0);
          return `<div class="cc-wiz-tpl" data-tpl="${esc(t.id)}"><div class="ic">${ctIcon(t.crisis_type)}</div><div><div class="t">${esc(t.title)}</div><div class="d">${nf} question${nf === 1 ? '' : 's'} · reuse &amp; edit</div></div></div>`;
        }).join('')}
      </div>` : ''}`;
    b.querySelectorAll('[data-new]').forEach((n) => n.addEventListener('click', () => pickNew()));
    b.querySelectorAll('[data-stock]').forEach((n) => n.addEventListener('click', () => pickStarter(n.getAttribute('data-stock'))));
    b.querySelectorAll('[data-tpl]').forEach((n) => n.addEventListener('click', () => pickTemplate(n.getAttribute('data-tpl'))));
  }
  function pickNew() {
    wiz.source = 'new'; wiz.templateId = null; wiz.stockKey = 'WILDFIRE';
    wiz.blocks = freshBlocks(wiz.stockKey); wiz.extraFields = [];
    wiz.step = 2; render();
  }
  function pickStarter(stockKey) {
    wiz.source = 'new'; wiz.templateId = null; wiz.stockKey = stockKey;
    wiz.blocks = freshBlocks(stockKey); wiz.extraFields = [];
    if (!wiz.launch.crisis_type && KIT().STOCK_PACKS[stockKey]) wiz.launch.crisis_type = stockKey;
    wiz.step = 2; render();
  }
  function pickTemplate(id) {
    const t = (wiz.templates || []).find((x) => x.id === id);
    if (!t) return;
    wiz.source = 'template'; wiz.templateId = id;
    wiz.formTitle = t.title || '';
    wiz.stockKey = KIT().CRISIS_TO_STOCK[String(t.crisis_type || '').toUpperCase()] || 'WILDFIRE';
    wiz.blocks = freshBlocks(wiz.stockKey); wiz.extraFields = [];
    if (t.schema_json) preloadFromSchema(t.schema_json);
    if (!wiz.launch.crisis_type && t.crisis_type) wiz.launch.crisis_type = t.crisis_type;
    wiz.step = 2; render();
  }

  // ── Step 2 - Build / edit ────────────────────────────────────────────────────
  function renderStep2(b) {
    const kit = KIT();
    const stockSel = Object.keys(kit.STOCK_PACKS || {}).map((k) =>
      `<option value="${esc(k)}" ${k === wiz.stockKey ? 'selected' : ''}>${esc(k.charAt(0) + k.slice(1).toLowerCase())} questions</option>`).join('');
    b.innerHTML = `
      <div id="cc-wiz-errbox"></div>
      <div class="cc-wiz-build">
        <div>
          <p class="cc-wiz-sub">Toggle the questions reporters answer inside this operation's zone. Stage 1 (photo · audio · location) is always captured.</p>
          <div class="cc-wiz-fld"><label class="cc-wiz-lbl">Crisis-specific question set</label>
            <select class="cc-wiz-sel" id="cc-wiz-stock">${stockSel}</select></div>
          <div class="cc-wiz-h4">Crisis-specific questions</div><div id="cc-wiz-stock-blocks"></div>
          <div class="cc-wiz-h4">Reusable question blocks</div><div id="cc-wiz-core-blocks"></div>
          ${(wiz.extraFields || []).length ? `<div class="cc-wiz-h4">Carried from the template</div><div class="cc-wiz-sub">${wiz.extraFields.map((e) => esc(e.field.label || e.field.key)).join(', ')}</div>` : ''}
        </div>
        <div>
          <div class="cc-wiz-h3">Live preview</div>
          <div class="cc-wiz-phone" id="cc-wiz-prev2"></div>
          <button class="cc-wiz-btn ghost" id="cc-wiz-validate" style="margin-top:10px;width:100%">Validate schema</button>
        </div>
      </div>`;
    renderBlockList('cc-wiz-stock-blocks', wiz.blocks.stock);
    renderBlockList('cc-wiz-core-blocks', wiz.blocks.core);
    renderPreview('cc-wiz-prev2');
    el('cc-wiz-stock').addEventListener('change', (e) => {
      wiz.stockKey = e.target.value;
      wiz.blocks.stock = freshBlocks(wiz.stockKey).stock;
      renderStep2(b);
    });
    el('cc-wiz-validate').addEventListener('click', validate);
  }
  function renderBlockList(mountId, blocks) {
    const m = el(mountId); if (!m) return;
    m.innerHTML = blocks.map((blk, i) => `
      <div class="cc-wiz-blk ${blk.on ? 'on' : ''} ${blk.locked ? 'locked' : ''}" data-i="${i}" title="${blk.locked ? 'Required taxonomy' : ''}">
        <div class="gi">${blk.icon || '•'}</div>
        <div class="meta"><div class="t">${esc(blk.title)}</div><div class="d">${esc(blk.desc || '')}</div></div>
        <div class="cc-wiz-sw"></div>
      </div>`).join('');
    m.querySelectorAll('.cc-wiz-blk').forEach((node) => node.addEventListener('click', () => {
      const blk = blocks[Number(node.getAttribute('data-i'))];
      if (!blk || blk.locked) return;
      blk.on = !blk.on;
      node.classList.toggle('on', blk.on);
      renderPreview('cc-wiz-prev2');
    }));
  }
  async function validate() {
    const schema = Object.assign(buildSchema(), { key: 'preview-check', title: wiz.formTitle || wiz.launch.name || 'Operation form' });
    if (!schema.sections.length) { showErrs(['Select at least one question.']); return; }
    try {
      const res = await api('POST', '/admin/crisis-forms/packs/validate', { schema_json: schema });
      if (res && res.valid) { showErrs([]); toast('Schema is valid.', 'ok'); }
      else showErrs((res && res.errors) || ['Unknown validation error']);
    } catch (err) {
      if (err.status === 403) { showErrs([]); toast('Validation needs admin - it will be checked on launch.', ''); }
      else showErrs([err.message]);
    }
  }
  function showErrs(errs) {
    const box = el('cc-wiz-errbox'); if (!box) return;
    box.innerHTML = (!errs || !errs.length) ? '' :
      `<div class="cc-wiz-errs"><strong>${errs.length} problem(s):</strong><ul>${errs.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`;
  }

  // ── Step 3 - Preview ─────────────────────────────────────────────────────────
  function renderStep3(b) {
    b.innerHTML = `
      <p class="cc-wiz-sub">This is exactly how the form appears to field reporters in the mobile app, inside this operation's zone.</p>
      <div style="display:flex;justify-content:center"><div style="width:360px;max-width:100%"><div class="cc-wiz-phone" id="cc-wiz-prev3"></div></div></div>`;
    renderPreview('cc-wiz-prev3');
  }
  function renderPreview(mountId) {
    const m = el(mountId); if (!m) return;
    const schema = buildSchema();
    const fields = (schema.sections || []).reduce((acc, sec) => acc.concat(sec.fields || []), []);
    if (!fields.length) { m.innerHTML = `<div class="cc-wiz-pv-head">▾ inside the operation zone ▾</div><div class="cc-wiz-empty">No questions selected yet.</div>`; return; }
    m.innerHTML = `<div class="cc-wiz-pv-head">▾ inside the operation zone ▾</div>`
      + `<div class="cc-wiz-stage">Stage 2 · 3 - crisis pack</div>`
      + fields.map((f) => `<div class="cc-wiz-q"><div class="cc-wiz-qt">${esc(f.label || f.key)}${f.required ? ' <span style="color:#f87171">*</span>' : ''}</div>${appControl(f)}</div>`).join('');
  }
  function appControl(f) {
    if (f.type === 'yes_no') return `<span class="cc-wiz-opt sel">Yes</span><span class="cc-wiz-opt">No</span>`;
    if (f.type === 'single_select' || f.type === 'multi_select') {
      return (f.options || []).slice(0, 8).map((o, i) => `<span class="cc-wiz-opt ${i === 0 ? 'sel' : ''}">${esc(o.label || o.value)}</span>`).join('');
    }
    if (f.type === 'integer') return `<div class="cc-wiz-stub">Enter a number…</div>`;
    if (f.type === 'short_text') return `<div class="cc-wiz-stub">Short answer…</div>`;
    if (f.type === 'long_text') return `<div class="cc-wiz-stub">Describe what you see…</div>`;
    if (f.type === 'building') return `<div class="cc-wiz-stub">🏗 Tap a building footprint or type a name</div>`;
    if (f.type === 'location') return `<div class="cc-wiz-stub">📍 Confirm location on the map</div>`;
    if (f.type === 'severity') return `<span class="cc-wiz-opt">Minor</span><span class="cc-wiz-opt sel">Moderate</span><span class="cc-wiz-opt">Severe</span>`;
    return `<div class="cc-wiz-stub">-</div>`;
  }

  // ── Step 4 - Launch ──────────────────────────────────────────────────────────
  function renderStep4(b) {
    const L = wiz.launch;
    const ctOpts = (KIT().EVENT_CRISIS_TYPES || []).map(([v, lbl]) =>
      `<option value="${esc(v)}" ${v === L.crisis_type ? 'selected' : ''}>${esc(lbl)}</option>`).join('');
    b.innerHTML = `
      <p class="cc-wiz-sub">Where and when is this operation active? It goes live immediately once you launch.</p>
      <div class="cc-wiz-fld"><label class="cc-wiz-lbl">Operation name *</label>
        <input class="cc-wiz-in" id="cc-wiz-name" placeholder="e.g. Bandipur Wildfire Response" value="${esc(L.name)}"></div>
      <div class="cc-wiz-fld"><label class="cc-wiz-lbl">Crisis type</label>
        <select class="cc-wiz-sel" id="cc-wiz-ct"><option value="">- select -</option>${ctOpts}</select></div>
      <div class="cc-wiz-fld"><label class="cc-wiz-lbl">Region / place</label>
        <div class="cc-wiz-geo"><input class="cc-wiz-in" id="cc-wiz-place" placeholder="Type a place name, then Find" value="${esc(L.place_name)}">
          <button class="cc-wiz-btn" id="cc-wiz-find">Find</button></div>
        <div class="cc-wiz-pin" id="cc-wiz-geopin" ${L.center_lat === '' ? 'hidden' : ''}>📍 ${L.center_lat}, ${L.center_lng}</div></div>
      <div class="cc-wiz-3col">
        <div class="cc-wiz-fld"><label class="cc-wiz-lbl">Latitude *</label><input class="cc-wiz-in" id="cc-wiz-lat" inputmode="decimal" value="${esc(L.center_lat)}"></div>
        <div class="cc-wiz-fld"><label class="cc-wiz-lbl">Longitude *</label><input class="cc-wiz-in" id="cc-wiz-lng" inputmode="decimal" value="${esc(L.center_lng)}"></div>
        <div class="cc-wiz-fld"><label class="cc-wiz-lbl">Radius (km) *</label><input class="cc-wiz-in" id="cc-wiz-rad" inputmode="decimal" value="${esc(L.radius_km)}"></div>
      </div>
      <div class="cc-wiz-2col">
        <div class="cc-wiz-fld"><label class="cc-wiz-lbl">Start date</label><input class="cc-wiz-in" id="cc-wiz-start" type="date" value="${esc(L.started_at)}"></div>
        <div class="cc-wiz-fld"><label class="cc-wiz-lbl">End date</label><input class="cc-wiz-in" id="cc-wiz-end" type="date" value="${esc(L.ended_at)}"></div>
      </div>
      <p class="cc-wiz-sub">Leave dates blank for an open-ended window.</p>`;
    const bind = (id, key) => { const n = el(id); if (n) n.addEventListener('input', () => { wiz.launch[key] = n.value; }); };
    bind('cc-wiz-name', 'name'); bind('cc-wiz-place', 'place_name');
    bind('cc-wiz-lat', 'center_lat'); bind('cc-wiz-lng', 'center_lng'); bind('cc-wiz-rad', 'radius_km');
    bind('cc-wiz-start', 'started_at'); bind('cc-wiz-end', 'ended_at');
    el('cc-wiz-ct').addEventListener('change', (e) => { wiz.launch.crisis_type = e.target.value; });
    el('cc-wiz-find').addEventListener('click', doGeocode);
  }
  async function doGeocode() {
    const q = (el('cc-wiz-place').value || '').trim();
    if (q.length < 3) { toast('Type at least 3 characters of a place name.', 'err'); return; }
    const btn = el('cc-wiz-find'); const old = btn.textContent; btn.textContent = '…'; btn.disabled = true;
    try {
      const res = await fetch(`${API}/reports/geocode/describe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: q }),
      });
      const r = await res.json().catch(() => null);
      if (r && typeof r.latitude === 'number' && typeof r.longitude === 'number') {
        wiz.launch.center_lat = Number(r.latitude).toFixed(6);
        wiz.launch.center_lng = Number(r.longitude).toFixed(6);
        if (r.location_name) wiz.launch.place_name = r.location_name;
        renderStep4(el('cc-wiz-body'));
      } else { toast('Could not resolve that place - enter coordinates manually.', 'err'); }
    } catch (err) { toast('Lookup failed.', 'err'); }
    finally { btn.textContent = old; btn.disabled = false; }
  }

  function _dateToIso(d, end) {
    if (!d) return null;
    return `${d}T${end ? '23:59:59' : '00:00:00'}Z`;
  }
  async function publish() {
    if (wiz.busy) return;
    const L = wiz.launch;
    const lat = parseFloat(L.center_lat), lng = parseFloat(L.center_lng), rad = parseFloat(L.radius_km);
    if (!String(L.name || '').trim()) { toast('Enter an operation name.', 'err'); return; }
    if (isNaN(lat) || lat < -90 || lat > 90 || isNaN(lng) || lng < -180 || lng > 180) { toast('Enter a valid latitude & longitude (use Find).', 'err'); return; }
    if (isNaN(rad) || rad <= 0) { toast('Enter a radius greater than 0.', 'err'); return; }
    const schema = buildSchema();
    if (!schema.sections.length) { toast('Your form has no questions - go back and add some.', 'err'); return; }
    wiz.busy = true; renderFooter();
    try {
      const resp = await api('POST', '/operations/launch-with-form', {
        name: L.name.trim(),
        crisis_type: L.crisis_type || null,
        center_lat: lat, center_lng: lng, radius_km: rad,
        place_name: (L.place_name || '').trim() || null,
        started_at: _dateToIso(L.started_at, false),
        ended_at: _dateToIso(L.ended_at, true),
        form_title: (wiz.formTitle || L.name).trim(),
        schema_json: schema,
        from_cluster: !!wiz.fromCluster,
      });
      const id = resp && resp.operation_id;
      toast('Operation launched.', 'ok');
      close();
      if (id) { try { window.location.hash = '#/operations/' + encodeURIComponent(id); } catch (_e) {} }
      if (typeof window.__crispRefreshOps === 'function') { try { window.__crispRefreshOps(); } catch (_e) {} }
    } catch (err) {
      wiz.busy = false; renderFooter();
      toast('Launch failed: ' + err.message, 'err');
    }
  }

  window.openOperationWizard = open;
})();
