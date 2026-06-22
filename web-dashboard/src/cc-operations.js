/* cc-operations.js - Operations workspace (CRISP dashboard, Phase 2d).
 *
 *   #/operations        → operations LIST (all operations, worst-first, + the
 *                          un-operationalised critical "Launch operation here" row)
 *   #/operations/{id}    → one operation's WORKLIST-first dashboard:
 *                          context banner · 4 vitals · operation map ·
 *                          critical worklist · action bar
 *
 * Self-contained overlay (mirrors cc-home/cc-settings): injects its own <style>,
 * owns #cc-ops-overlay, exposes window.openOperations(id|null) +
 * window.__ccOperations.closeOverlay(). Data comes from the Phase 2a backend:
 * GET /operations, /analytics/summary?crisis_event_id, /reports/?crisis_event_id.
 * Opening an operation sets the app-wide operation scope (window.setOperationScope)
 * so the global Incidents feed + queues also scope to it; closing resets to global.
 *
 * Health dot is BACKEND-AUTHORITATIVE (Phase 3): the /operations payload carries
 * health = RED | AMBER | GREEN + a health_reason "why" (SLA breaches + unattended
 * critical + escalation + review backlog + activity). No client heuristic.
 */
(function () {
  'use strict';
  if (window.__ccOperationsLoaded) return;
  window.__ccOperationsLoaded = true;

  const token = () => localStorage.getItem('crisp_token');
  const _LAN_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
  const _isLocalDev = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname)
    || _LAN_RE.test(window.location.hostname);
  const BACKEND_HOST = _isLocalDev ? `http://${window.location.hostname}:8000` : window.location.origin;
  const API = `${BACKEND_HOST}/api/v1`;

  const el = (id) => document.getElementById(id);
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const fmtNum = (n) => (n == null ? '-' : Number(n).toLocaleString());
  function timeAgo(s) {
    if (!s) return '-';
    const norm = (window.__ccEnsureUTC || ((x) => x))(s);
    const t = new Date(norm).getTime();
    if (isNaN(t)) return '-';
    const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 60) return 'just now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    return Math.floor(sec / 86400) + 'd ago';
  }
  const titleCase = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

  async function jget(path) {
    const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token() || ''}` } });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  const SEV_COLOR = { CRITICAL: '#f87171', SEVERE: '#fb923c', MODERATE: '#fbbf24', MINOR: '#4ade80', UNKNOWN: '#64748b' };
  const SEV_RANK = { CRITICAL: 5, SEVERE: 4, MODERATE: 3, MINOR: 2, UNKNOWN: 1 };
  // crisis_type → accent colour for the operation chrome (2e reads this).
  const TYPE_COLOR = {
    EARTHQUAKE: '#f59e0b', FLOOD: '#38bdf8', TSUNAMI: '#22d3ee', HURRICANE: '#818cf8',
    WILDFIRE: '#fb7185', EXPLOSION: '#f97316', CHEMICAL: '#a3e635', CONFLICT: '#f43f5e',
    CIVILUNREST: '#e879f9',
  };
  function opColor(op) { return TYPE_COLOR[String(op && op.crisis_type || '').toUpperCase()] || '#418FDE'; }
  // Backend-authoritative health (Phase 3): the /operations payload carries
  // health = RED | AMBER | GREEN + a health_reason "why".
  const HEALTH_COLOR = { RED: '#f87171', AMBER: '#fbbf24', GREEN: '#4ade80' };
  const healthColor = (o) => HEALTH_COLOR[o && o.health] || HEALTH_COLOR.GREEN;
  // Worst-first: critical desc, then new desc, then total desc.
  function worstFirst(a, b) {
    return (b.critical || 0) - (a.critical || 0)
        || (b.new_24h || 0) - (a.new_24h || 0)
        || (b.total || 0) - (a.total || 0);
  }

  let _map = null, _cluster = null;
  let _detailOpId = null;   // the operation whose worklist/map is showing (for op-scoped incident deep-links)

  function go(hash) { try { window.location.hash = hash; } catch (_e) {} }
  function navTo(route) {
    try { if (window.__crispRouter) { window.__crispRouter.navigate(route); return; } } catch (_e) {}
    go('#' + route);
  }
  const _esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const _toast = (m, t) => { try { (window.showToast || function () {})(m, t); } catch (_e) {} };

  // A5: download the multi-section Operation Summary PDF (mirrors the building
  // assessment-PDF download). Disables the button during the request.
  async function _downloadOperationReportPdf(opId, btn) {
    if (!opId) return;
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    try {
      const res = await fetch(`${API}/operations/${encodeURIComponent(opId)}/report.pdf`,
        { headers: { Authorization: `Bearer ${token() || ''}` } });
      if (!res.ok) { _toast('Operation report download failed.', 'err'); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `operation-report-${String(opId).slice(0, 8)}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
      _toast('Operation Summary PDF downloaded', 'ok');
    } catch (e) {
      _toast('Download failed: ' + (e && e.message || e), 'err');
    } finally {
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    }
  }

  // A5: read-only view of the operation's active crisis-form configuration.
  async function _showFormConfig(packId, packName) {
    if (!packId) { _toast('No crisis-form pack is bound to this operation.', 'err'); return; }
    let schema = null;
    try {
      const res = await fetch(`${API}/admin/crisis-forms/packs/${encodeURIComponent(packId)}/versions`,
        { headers: { Authorization: `Bearer ${token() || ''}` } });
      if (res.ok) {
        const vers = await res.json();
        const list = Array.isArray(vers) ? vers : [];
        const active = list.find((v) => v.status === 'published') || list[0];
        schema = active && active.schema_json;
      }
    } catch (_e) { /* fall through to error state */ }
    const ov = document.createElement('div');
    ov.className = 'cco-cfg-overlay';
    let body;
    if (schema && Array.isArray(schema.sections) && schema.sections.length) {
      body = schema.sections.map((sec) => {
        const fields = (sec.fields || []).map((f) => {
          const opts = (f.options || []).map((o) => _esc((o.label_i18n && o.label_i18n.en) || o.label || o.value)).join(' · ');
          return `<tr><td>${_esc((f.label_i18n && f.label_i18n.en) || f.label || f.key)}</td><td>${_esc(f.type)}</td><td>${f.required ? 'yes' : 'no'}</td><td>${_esc((f.channels || []).join(', ') || 'all')}</td></tr>${opts ? `<tr class="cco-cfg-opts"><td colspan="4">${opts}</td></tr>` : ''}`;
        }).join('');
        return `<div class="cco-cfg-sec"><div class="cco-cfg-sec-t">${_esc(sec.title || sec.id)} <span class="cco-cfg-stage">stage ${_esc(sec.stage)}</span></div>
          <table class="cco-cfg-tbl"><thead><tr><th>Field</th><th>Type</th><th>Req</th><th>Channels</th></tr></thead><tbody>${fields || '<tr><td colspan="4">No fields</td></tr>'}</tbody></table></div>`;
      }).join('');
    } else {
      body = '<div class="cco-cfg-empty">Could not load the form configuration, or no published version exists.</div>';
    }
    ov.innerHTML = `<div class="cco-cfg-card" role="dialog" aria-modal="true" aria-label="Form configuration">
      <div class="cco-cfg-head"><b>Form configuration</b>${packName ? ` · <span class="cco-cfg-name">${_esc(packName)}</span>` : ''}
        <span class="cco-cfg-ro">read-only</span><button class="cco-cfg-x" aria-label="Close">✕</button></div>
      <div class="cco-cfg-body">${body}</div></div>`;
    const close = () => { try { ov.remove(); } catch (_e) {} document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.querySelector('.cco-cfg-x').addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
  }

  // ── shared operation card ──────────────────────────────────────────────────
  // ONE card used by BOTH the home Active-Operations rail (cc-home.js) and the
  // #/operations list. Previously two drifted implementations (different health
  // colours + stat labels). Self-injects its CSS so it styles correctly in either
  // overlay regardless of which loaded first. Cards are pure inline HTML/SVG (no
  // Leaflet per card) so 10/50/100 operations stay cheap.
  const TYPE_ICON = {
    EARTHQUAKE: '⊕', FLOOD: '🌊', TSUNAMI: '🌊', CYCLONE: '🌀', HURRICANE: '🌀',
    WILDFIRE: '🔥', EXPLOSION: '💥', CHEMICAL_INCIDENT: '☣', CHEMICAL: '☣',
    CONFLICT: '⚔', CIVIL_UNREST: '✊', CIVILUNREST: '✊', LANDSLIDE: '⛰',
  };
  // Operations have exactly two states (redesign v2): LIVE (green) / ENDED (gray).
  // The fallback in statusBadge() renders any stray legacy value harmlessly.
  const STATUS_STYLE = {
    LIVE: ['LIVE', '#34D399'], ENDED: ['ENDED', '#7d89a3'],
  };
  function _fmtDate(s) {
    if (!s) return '';
    try {
      const d = new Date((window.__ccEnsureUTC || ((x) => x))(s));
      return isNaN(d.getTime()) ? '' : d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (_e) { return ''; }
  }
  const CrispOpCard = {
    _injectCss() {
      if (el('crisp-opcard-styles')) return;
      const css = `
      /* === Operation card - full-width 3-col grid: identity | KPI strip(grows) | situation === */
      .opc{display:grid;grid-template-columns:minmax(196px,1.05fr) minmax(0,2.4fr) auto;
        align-items:center;gap:16px;padding:11px 14px;background:#101a2e;border:1px solid #233149;
        border-radius:12px;cursor:pointer;position:relative;overflow:hidden;transition:border-color .12s,background .12s}
      .opc:hover{border-color:#418FDE;background:#13203a}
      .opc:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
      /* unattended / inactive accent - inset shadow keeps border-radius valid */
      .opc-attn{box-shadow:inset 3px 0 0 0 #fbbf24}
      .opc-unatt{box-shadow:inset 3px 0 0 0 #f87171;border-color:#5a1f1f}
      .opc-unatt:hover{border-color:#f87171;background:#16100f}
      .opc-inact{border-color:#5a4410}
      .opc-inact:hover{border-color:#fbbf24}
      /* LEFT - identity */
      .opc-id{min-width:0;display:flex;flex-direction:column;gap:3px}
      .opc-id-r1{display:flex;align-items:center;gap:7px;min-width:0}
      .opc-ic{font-size:15px;flex:0 0 auto}
      .opc-name{font-size:14.5px;font-weight:700;color:#e6edf7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
      .opc-badge{font-size:9.5px;font-weight:800;letter-spacing:.05em;padding:1px 7px;border-radius:999px;
        border:1px solid #33476a;background:rgba(255,255,255,.03);flex:0 0 auto}
      .opc-age{font-size:8.5px;font-weight:800;letter-spacing:.04em;padding:1px 6px;border-radius:999px;border:1px solid;flex:0 0 auto;white-space:nowrap}
      .opc-meta{font-size:11px;color:#8aa0bf;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .opc-flag{font-weight:600}
      .opc-flag.flag-att{color:#f87171}
      .opc-flag.flag-idle{color:#fb923c}
      /* CENTER - equal-width KPI chip strip that grows to fill the row */
      .opc-kpis{display:flex;gap:7px;min-width:0;flex-wrap:wrap}
      .opc-kpis-empty{visibility:hidden}
      .opc-chip{flex:1 1 0;min-width:46px;display:flex;flex-direction:column;align-items:center;
        padding:5px 4px;background:#0d1626;border:1px solid #1f2c44;border-radius:9px;font-variant-numeric:tabular-nums}
      .opc-chip b{font-size:15px;font-weight:800;line-height:1;color:#dce6f5}
      .opc-chip span{font-size:8.5px;letter-spacing:.03em;text-transform:uppercase;color:#7d8ba3;margin-top:3px;white-space:nowrap}
      .opc-chip.crit{background:#1d1113;border-color:#7f1d1d}
      .opc-chip.crit b{color:#f87171}
      .opc-chip.crit.zero{background:#0d1626;border-color:#1f2c44}
      .opc-chip.crit.zero b{color:#5b6b86}
      .opc-chip.new b{color:#fbbf24}
      .opc-chip.ver b{color:#34D399}
      .opc-chip.resp b{color:#7db8ef}
      .opc-chip.bld b{color:#7db8ef}
      .opc-chip.rej b{color:#9aa8bf}
      .opc-chip.resp.unattended{background:#1d1113;border-color:#7f1d1d}
      .opc-chip.resp.unattended b{color:#f87171}
      /* RIGHT - situation: health pill · trend · mini-map(desktop) · arrow */
      .opc-sit{display:flex;align-items:center;gap:12px;flex:0 0 auto}
      .opc-pill{display:inline-flex;align-items:center;gap:6px;font-size:10px;font-weight:800;letter-spacing:.05em;
        padding:3px 9px;border-radius:999px;color:var(--hc,#4ade80);background:rgba(255,255,255,.04);border:1px solid var(--hc,#4ade80);white-space:nowrap}
      .opc-pill-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto}
      .opc-trend{display:flex;flex-direction:column;align-items:center;gap:2px;font-size:11px;font-weight:800}
      .opc-trend-l{font-size:8px;letter-spacing:.03em;text-transform:uppercase;font-weight:700}
      .opc-mm{width:50px;height:50px;flex:0 0 auto;display:block}
      .opc-ar{color:#5b6b86;font-size:18px;flex:0 0 auto}
      /* cluster + start-new keep the SAME grid + height */
      .opc-mm-inline{width:34px;height:34px;font-size:18px;border-radius:8px}
      .opc-mm-alert{display:grid;place-items:center;background:#1b1113;border:1px solid #7f1d1d}
      .opc-cluster{border-style:dashed;border-color:#7f1d1d;background:#1b1113}
      .opc-cluster:hover{border-color:#f87171;background:#241416}
      .opc-cluster .opc-name{color:#fca5a5}
      .opc-newop{border-style:dashed;border-color:#33476a;background:#0e1726}
      .opc-newop:hover{border-color:#418FDE;background:#13203a}
      .opc-newop-ic{width:34px;height:34px;flex:0 0 auto;display:grid;place-items:center;font-size:22px;
        font-weight:300;color:#7fa9d8;border-radius:8px;background:#13203a;border:1px dashed #33476a}
      /* ── responsive: desktop 3-col → laptop compress → tablet stack → mobile compact ── */
      @media (max-width:1440px){
        .opc{gap:13px}
        .opc-mm{display:none}
        .opc-kpis{gap:6px}
        .opc-chip{min-width:42px;padding:5px 3px}
        .opc-chip b{font-size:14px}
        .opc-chip span{font-size:8px}
        .opc-trend-l{display:none}
        .opc-pill-l{display:none}
        .opc-pill{padding:4px;gap:0}
        .opc-sit{gap:10px}
      }
      @media (max-width:1100px){
        .opc{grid-template-columns:minmax(150px,.9fr) minmax(0,2.6fr) auto}
        .opc-chip b{font-size:13.5px}
      }
      @media (max-width:900px){
        .opc{grid-template-columns:1fr auto;grid-template-areas:'id sit' 'kpis kpis';row-gap:10px;column-gap:12px}
        .opc-id{grid-area:id}
        .opc-sit{grid-area:sit;gap:10px}
        .opc-kpis{grid-area:kpis;gap:7px}
        .opc-pill-l,.opc-trend-l{display:inline}
        .opc-pill{padding:3px 9px;gap:6px}
        .opc-chip{min-width:0;padding:6px 4px}
        .opc-chip b{font-size:14.5px}
        .opc-chip span{font-size:8.5px}
      }
      @media (max-width:640px){
        .opc{grid-template-columns:1fr auto;grid-template-areas:'id sit';gap:11px;align-items:center}
        .opc-id{grid-area:id}
        .opc-kpis{display:none}
        .opc-sit{grid-area:sit;gap:8px}
        .opc-sit .opc-mm{display:none}
        .opc-pill-l,.opc-trend-l{display:none}
        .opc-trend{font-size:13px}
      }
      /* LIVE / ENDED group headers + collapsed ENDED section */
      .opc-grp-t{font-size:11px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;color:#8aa0bf;margin:14px 2px 8px}
      .opc-grp-sum{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;user-select:none}
      .opc-grp-sum::-webkit-details-marker{display:none}
      .opc-grp-sum::before{content:'▸';font-size:10px;color:#5b6b86;transition:transform .12s}
      details[open] .opc-grp-sum::before{transform:rotate(90deg)}
      .opc-grp-n{font-weight:700;color:#6b7d99;background:#1b2942;border-radius:999px;padding:0 7px;font-size:10px}
      .opc-ended-body{display:flex;flex-direction:column;gap:8px;margin-top:8px}
      /* ── COMPACT density row: one line, health dot + name/place + critical. No
            KPI strip, no SVG map, no trend - used by the home rail shortlist and
            the /operations dense mode so 50+ ops scan without a scroll wall. ── */
      .opc-c{display:flex;align-items:center;gap:9px;padding:8px 11px;background:#101a2e;border:1px solid #233149;
        border-radius:10px;cursor:pointer;transition:border-color .12s,background .12s}
      .opc-c:hover{border-color:#418FDE;background:#13203a}
      .opc-c:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
      .opc-c-unatt{box-shadow:inset 3px 0 0 0 #f87171;border-color:#5a1f1f}
      .opc-c-unatt:hover{border-color:#f87171}
      .opc-c-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
      .opc-c-id{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .opc-c-name{font-size:13.5px;font-weight:700;color:#e6edf7}
      .opc-c-place,.opc-c-age{font-size:11.5px;color:#7d8ba3;font-weight:400}
      .opc-c-warn{color:#fbbf24;font-size:13px;flex:0 0 auto}
      .opc-c-crit{flex:0 0 auto;font-size:11px;font-weight:700;color:#f87171;background:#1d1113;border:1px solid #7f1d1d;
        border-radius:7px;padding:2px 8px;white-space:nowrap;font-variant-numeric:tabular-nums}
      .opc-c-crit b{font-size:12.5px;font-weight:800}
      .opc-c-crit.zero{color:#5b6b86;background:#0d1626;border-color:#1f2c44}
      .opc-c-cluster{border-style:dashed;border-color:#7f1d1d;background:#1b1113}
      .opc-c-cluster .opc-c-name{color:#fca5a5}
      .opc-c-newop{border-style:dashed;border-color:#33476a;background:#0e1726}
      .opc-c-newop:hover{border-color:#418FDE}
      .opc-c-plus{width:20px;height:20px;display:grid;place-items:center;color:#7fa9d8;font-size:16px;flex:0 0 auto;
        border-radius:6px;background:#13203a;border:1px dashed #33476a}
      `;
      const st = document.createElement('style');
      st.id = 'crisp-opcard-styles';
      st.textContent = css;
      document.head.appendChild(st);
    },
    typeIcon(o) { return TYPE_ICON[String(o && o.crisis_type || '').toUpperCase()] || '⚠'; },
    statusBadge(o) {
      const s = String(o && o.status || '').toUpperCase();
      const sty = STATUS_STYLE[s] || [s || '-', '#9fb3d1'];
      if (!STATUS_STYLE[s] && s) console.warn('[ops] unexpected operation status:', s);
      // A LIVE op past its ended_at window is matcher-inactive but not yet ENDED -
      // surface that genuine state without re-introducing a third badge colour.
      const windowClosed = (s === 'LIVE' && o && o.ended_at &&
        new Date((window.__ccEnsureUTC || ((x) => x))(o.ended_at)) < new Date());
      const hint = windowClosed ? ' title="window closed"' : '';
      return `<span class="opc-badge" style="color:${sty[1]};border-color:${sty[1]}66"${hint}>${esc(sty[0])}</span>`;
    },
    // Inline-SVG schematic: centre dot + radius ring (sized by radius_km), in the
    // crisis-type colour, over a faint graticule. Honest + cheap; the human "where"
    // is the place_name line. No tiles, no Leaflet - safe at 100 cards.
    miniMap(o) {
      const col = opColor(o);
      const r = Math.max(8, Math.min(22, (Number(o && o.radius_km) || 30) * 0.55));
      return `<svg viewBox="0 0 58 58" class="opc-mm" aria-hidden="true">
        <rect x="1" y="1" width="56" height="56" rx="9" fill="#0d1626" stroke="#223049"></rect>
        <line x1="29" y1="6" x2="29" y2="52" stroke="#1c2840"></line>
        <line x1="6" y1="29" x2="52" y2="29" stroke="#1c2840"></line>
        <circle cx="29" cy="29" r="${r.toFixed(1)}" fill="${col}22" stroke="${col}" stroke-width="1.4"></circle>
        <circle cx="29" cy="29" r="3" fill="${col}"></circle>
      </svg>`;
    },
    _placeLine(o) {
      const place = o.place_name ? esc(o.place_name)
        : (o.center_lat != null && o.center_lng != null
            ? Number(o.center_lat).toFixed(2) + ', ' + Number(o.center_lng).toFixed(2) : '');
      const form = o.form_name ? '📋 ' + esc(o.form_name) : '';
      const st = _fmtDate(o.started_at), en = _fmtDate(o.ended_at);
      const dates = (st || en) ? ('Started ' + (st || '-') + (en ? ' · Ended ' + en : ' · Open')) : '';
      return [form, place ? '📍 ' + place : '', dates].filter(Boolean).join('  ·  ');
    },
    // ── pure client-side helpers (no network) for the redesigned card ──────────
    _opAge(o) {
      if (!o || !o.started_at) return null;
      const t = new Date((window.__ccEnsureUTC || ((x) => x))(o.started_at)).getTime();
      if (isNaN(t)) return null;
      return 'Day ' + (Math.floor((Date.now() - t) / 86400000) + 1);   // first calendar day = Day 1
    },
    _trend(o) {
      const curr = Number(o && o.new_24h) || 0;
      const prev = o && o.new_prev_24h;                 // absent until the backend field ships
      if (prev == null || !isFinite(Number(prev))) return { gly: '·', col: '#5b6b86', label: '-' };
      const p = Number(prev);
      if (curr === 0 && p === 0) return { gly: '·', col: '#5b6b86', label: '-' };
      if (curr > p * 1.1)        return { gly: '▲', col: '#f87171', label: 'Rising' };
      if (curr < p * 0.9)        return { gly: '▼', col: '#4ade80', label: 'Falling' };
      return { gly: '▬', col: '#9fb3d1', label: 'Stable' };
    },
    _flags(o) {
      // Unattended: backend-authoritative unattended_critical (CRITICAL + open + not
      // yet dispatched), with a client derive as fallback when the field is absent.
      const ua = (o && o.unattended_critical != null)
        ? Number(o.unattended_critical) > 0
        : ((Number(o && o.critical) || 0) > 0 && (Number(o && o.responders_active) || 0) === 0);
      let hrs = null;
      if (o && o.last_activity) {
        const t = new Date((window.__ccEnsureUTC || ((x) => x))(o.last_activity)).getTime();
        if (!isNaN(t)) hrs = (Date.now() - t) / 3600000;
      }
      return { unattended: ua, inactive: hrs != null && hrs >= 4, sinceTxt: (o && o.last_activity) ? timeAgo(o.last_activity) : '' };
    },
    // Redesigned card: LEFT identity | CENTER KPI strip (grows) | RIGHT situation.
    card(o) {
      if (o.is_cluster) {
        return `<div class="opc opc-cluster" data-cluster="1" data-critical="${Number(o.critical) || 0}" role="link" tabindex="0"
            aria-label="${fmtNum(o.critical)} unassigned critical reports, no operation - view reports or create an operation">
          <div class="opc-id"><div class="opc-id-r1"><span class="opc-mm-alert opc-mm-inline">🚨</span>
            <span class="opc-name">${fmtNum(o.critical)} critical reports, no operation</span></div>
            <div class="opc-meta">View reports or create an operation →</div></div>
          <div class="opc-kpis"><span class="opc-chip crit"><b>${fmtNum(o.critical)}</b><span>Critical</span></span></div>
          <div class="opc-sit"><span class="opc-ar">›</span></div></div>`;
      }
      const hc = healthColor(o);
      const tr = this._trend(o);
      const fl = this._flags(o);
      const age = this._opAge(o);
      const isLive = String(o && o.status || '').toUpperCase() === 'LIVE';
      const total = Number(o && o.total) || 0, ver = Number(o && o.verified) || 0;
      const unver = Math.max(0, total - ver);                 // client math - no backend
      const unatt = isLive && fl.unattended;                  // never flag ENDED ops
      const inactive = isLive && fl.inactive;
      const attn = unatt || inactive;
      const ageCol = age === 'Day 1' ? '#fbbf24' : '#8aa0bf';
      // Identity line 3 - unattended > inactive > last-activity (precedence).
      let line3 = '';
      if (unatt) line3 = `<div class="opc-meta opc-flag flag-att">⚠ Unattended${fl.sinceTxt ? ' · ' + esc(fl.sinceTxt) : ''}</div>`;
      else if (inactive) line3 = `<div class="opc-meta opc-flag flag-idle">◷ Inactive · ${esc(fl.sinceTxt)}</div>`;
      else if (fl.sinceTxt) line3 = `<div class="opc-meta">Active ${esc(fl.sinceTxt)}</div>`;
      const ageBadge = age ? `<span class="opc-age" style="color:${ageCol};border-color:${ageCol}40;background:${ageCol}14">${esc(age)}</span>` : '';
      const chip = (cls, val, label) => `<span class="opc-chip ${cls}"><b>${fmtNum(val)}</b><span>${label}</span></span>`;
      const critChip = `<span class="opc-chip crit${(Number(o.critical) || 0) === 0 ? ' zero' : ''}"><b>${fmtNum(o.critical)}</b><span>Critical</span></span>`;
      return `<div class="opc${attn ? ' opc-attn' : ''}${unatt ? ' opc-unatt' : (inactive ? ' opc-inact' : '')}"
          data-op="${esc(o.id)}" role="link" tabindex="0"
          aria-label="${esc(o.name)} - ${esc(o.health || '')} health, ${fmtNum(o.critical)} critical, ${fmtNum(o.responders_active)} responders${unatt ? ', unattended critical' : ''} - open operation">
        <div class="opc-id">
          <div class="opc-id-r1"><span class="opc-ic">${this.typeIcon(o)}</span>
            <span class="opc-name">${esc(o.name)}</span>${this.statusBadge(o)}${ageBadge}</div>
          <div class="opc-meta">${this._placeLine(o) || '-'}</div>
          ${line3}
        </div>
        <div class="opc-kpis" role="group" aria-label="report metrics">
          ${critChip}
          ${chip('', total, 'Total')}
          ${chip('bld', Number(o.affected_buildings) || 0, 'Buildings')}
          ${chip('ver', Number(o.resolved) || 0, 'Resolved')}
          ${chip('rej', Number(o.rejected) || 0, 'Rejected')}
        </div>
        <div class="opc-sit">
          <span class="opc-pill" style="--hc:${hc}" title="${esc(o.health_reason || o.health || '')}"><span class="opc-pill-dot" style="background:${hc}"></span><span class="opc-pill-l">${esc(o.health || 'GREEN')}</span></span>
          <span class="opc-trend" style="color:${tr.col}" title="24h trend vs prior 24h">${tr.gly}<span class="opc-trend-l">${esc(tr.label)}</span></span>
          ${this.miniMap(o)}
          <span class="opc-ar">›</span>
        </div>
      </div>`;
    },
    // The "Start New Operation" entry card (redesign v2) - reskinned onto the grid.
    _startNewCard() {
      return `<div class="opc opc-newop" data-new="1" role="button" tabindex="0" aria-label="Start a new operation">`
        + `<div class="opc-id"><div class="opc-id-r1"><span class="opc-newop-ic" aria-hidden="true">+</span>`
        + `<span class="opc-name">Start New Operation</span></div>`
        + `<div class="opc-meta">Create and launch a new operation</div></div>`
        + `<div class="opc-kpis opc-kpis-empty" aria-hidden="true"></div>`
        + `<div class="opc-sit"><span class="opc-ar">›</span></div></div>`;
    },
    // COMPACT row - the same data + click target as card(), at ~half the height
    // and with NO inline SVG map / KPI strip / trend. Triage signals only:
    // health dot (+ "why" title), name · place · age, an unattended flag, the
    // Critical count, chevron. Used by the home rail shortlist + dense list mode.
    _compactCard(o) {
      if (o.is_cluster) {
        return `<div class="opc-c opc-c-cluster" data-cluster="1" data-critical="${Number(o.critical) || 0}" role="link" tabindex="0"
            aria-label="${fmtNum(o.critical)} unassigned critical reports, no operation - view reports or create an operation">
          <span class="opc-c-dot" style="background:#f87171"></span>
          <span class="opc-c-id"><span class="opc-c-name">${fmtNum(o.critical)} critical, no operation</span></span>
          <span class="opc-c-crit"><b>${fmtNum(o.critical)}</b> crit</span>
          <span class="opc-ar">›</span></div>`;
      }
      const hc = healthColor(o);
      const fl = this._flags(o);
      const isLive = String(o && o.status || '').toUpperCase() === 'LIVE';
      const unatt = isLive && fl.unattended;
      const place = o.place_name ? esc(o.place_name) : '';
      const age = this._opAge(o);
      const critN = Number(o.critical) || 0;
      return `<div class="opc-c${unatt ? ' opc-c-unatt' : ''}" data-op="${esc(o.id)}" role="link" tabindex="0"
          aria-label="${esc(o.name)} - ${esc(o.health || '')} health, ${fmtNum(o.critical)} critical${unatt ? ', unattended critical' : ''} - open operation">
        <span class="opc-c-dot" style="background:${hc}" title="${esc(o.health_reason || o.health || '')}"></span>
        <span class="opc-c-id"><span class="opc-c-name">${esc(o.name)}</span>${place ? `<span class="opc-c-place"> · ${place}</span>` : ''}${age ? `<span class="opc-c-age"> · ${esc(age.toLowerCase())}</span>` : ''}</span>
        ${unatt ? '<span class="opc-c-warn" title="Unattended critical">⚠</span>' : ''}
        <span class="opc-c-crit${critN === 0 ? ' zero' : ''}"><b>${fmtNum(o.critical)}</b> crit</span>
        <span class="opc-ar">›</span></div>`;
    },
    _compactStartNew() {
      return `<div class="opc-c opc-c-newop" data-new="1" role="button" tabindex="0" aria-label="Start a new operation">`
        + `<span class="opc-c-plus" aria-hidden="true">+</span>`
        + `<span class="opc-c-id"><span class="opc-c-name">Start new operation</span></span>`
        + `<span class="opc-ar">›</span></div>`;
    },
    // Render + wire a whole list/rail into `host`. Shared by both surfaces.
    // opts: { empty, grouped (default true), liveHeader, startNew }
    //   grouped   → split LIVE (first) vs ENDED (collapsed <details>)
    //   liveHeader→ show the "LIVE OPERATIONS" header (the /operations page; the
    //               home rail's zone header already says "Active Operations")
    //   startNew  → prepend the "Start New Operation" card
    renderInto(host, ops, opts) {
      if (!host) return;
      this._injectCss();
      opts = opts || {};
      const grouped = opts.grouped !== false;
      const compact = !!opts.compact;                       // dense one-line rows
      const mk = (o) => compact ? this._compactCard(o) : this.card(o);
      const all = (ops || []).slice();
      const _utc = window.__ccEnsureUTC || ((x) => x);
      const isEnded = (o) => !o.is_cluster && String(o && o.status || '').toUpperCase() === 'ENDED';
      const live = all.filter((o) => !isEnded(o)).sort(worstFirst);                 // cluster + LIVE
      const ended = all.filter(isEnded)
        .sort((a, b) => new Date(_utc(b.ended_at || 0)) - new Date(_utc(a.ended_at || 0)));

      if (!all.length && !opts.startNew) {
        host.innerHTML = `<div class="cco-empty">${esc(opts.empty || 'No operations yet. Active crisis events appear here.')}</div>`;
        return;
      }

      let html = '';
      if (opts.startNew) html += compact ? this._compactStartNew() : this._startNewCard();
      if (grouped) {
        if (opts.liveHeader) html += `<div class="opc-grp-t">LIVE OPERATIONS</div>`;
        html += live.map(mk).join('');
        if (!live.length && !opts.startNew) html += `<div class="cco-empty">${esc(opts.empty || 'No live operations.')}</div>`;
        if (ended.length) {
          html += `<details class="opc-ended"><summary class="opc-grp-t opc-grp-sum">ENDED OPERATIONS`
            + ` <span class="opc-grp-n">${ended.length}</span></summary>`
            + `<div class="opc-ended-body">${ended.map(mk).join('')}</div></details>`;
        }
      } else {
        // presorted: caller already filtered + ordered (e.g. the /operations
        // registry's name / recent sort) - render `all` verbatim so we don't
        // override it with the internal worst-first sort.
        const seq = opts.presorted ? all : live.concat(ended);
        html += seq.map(mk).join('');
      }
      host.innerHTML = html;

      host.querySelectorAll('[data-op]').forEach((row) => {
        const open = () => go('#/operations/' + encodeURIComponent(row.getAttribute('data-op')));
        row.addEventListener('click', open);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      });
      host.querySelectorAll('[data-cluster]').forEach((row) => {
        const critical = Number(row.getAttribute('data-critical')) || 0;
        const choose = () => { try { (window.openClusterChooser || function () {})({ critical }); } catch (_e) {} };
        row.addEventListener('click', choose);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
      });
      host.querySelectorAll('[data-new]').forEach((row) => {
        const start = () => { try { (window.openOperationWizard || function () { console.warn('[ops] operation wizard not loaded yet'); })(); } catch (_e) {} };
        row.addEventListener('click', start);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); start(); } });
      });
    },
  };
  window.CrispOpCard = CrispOpCard;

  // ── styles ───────────────────────────────────────────────────────────────
  function injectStyles() {
    if (el('cc-ops-styles')) return;
    const css = `
    #cc-ops-overlay{position:fixed;inset:0;z-index:99990;display:none;overflow:auto;
      background:radial-gradient(1100px 560px at 78% -12%,rgba(65,143,222,.12),transparent 60%),#0B1220;
      color:#E6EDF7;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    #cc-ops-overlay.cc-ops-open{display:block}
    .cco-wrap{max-width:1480px;margin:0 auto;padding:18px 22px 48px;min-height:100%}
    .cco-num{font-variant-numeric:tabular-nums}
    .cco-h{font-size:18px;font-weight:800;margin:0 0 2px}
    .cco-sub{font-size:12px;color:#8aa0bf;margin:0 0 16px}
    .cco-sec-t{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#8aa0bf;margin:18px 0 8px}
    .cco-card{background:#101a2e;border:1px solid #233149;border-radius:12px}
    /* registry controls (search · status segment · health chips · sort · density) */
    .cco-controls{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 14px}
    .cco-search{position:relative;flex:1 1 230px;min-width:190px}
    .cco-search-ic{position:absolute;left:10px;top:50%;transform:translateY(-50%);font-size:12px;opacity:.6;pointer-events:none}
    .cco-search input{width:100%;box-sizing:border-box;padding:8px 12px 8px 30px;background:#0d1626;border:1px solid #233149;
      border-radius:9px;color:#e6edf7;font-size:13px;font-family:inherit}
    .cco-search input:focus{outline:none;border-color:#418FDE}
    .cco-seg-grp{display:inline-flex;border:1px solid #233149;border-radius:9px;overflow:hidden}
    .cco-seg{background:#0d1626;border:none;border-right:1px solid #233149;color:#9fb3d1;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
    .cco-seg:last-child{border-right:none}
    .cco-seg.active{background:#13203a;color:#e6edf7}
    .cco-fchips{display:inline-flex;gap:6px;flex-wrap:wrap}
    .cco-fchip{background:#0d1626;border:1px solid #233149;color:#9fb3d1;border-radius:999px;padding:5px 11px;font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit}
    .cco-fchip:hover{border-color:#418FDE}
    .cco-fchip.red.active{color:#f87171;border-color:#7f1d1d;background:#1d1113}
    .cco-fchip.amber.active,.cco-fchip.unatt.active{color:#fbbf24;border-color:#5a4410;background:#181206}
    .cco-fchip.green.active{color:#34D399;border-color:#14532d;background:#0c1f16}
    .cco-sel{background:#0d1626;border:1px solid #233149;color:#cdd8ec;border-radius:9px;padding:7px 10px;font-size:12px;font-family:inherit;cursor:pointer}
    .cco-dens,.cco-newbtn{background:#1b2942;border:1px solid #33476a;color:#cdd8ec;border-radius:9px;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}
    .cco-dens:hover,.cco-newbtn:hover{border-color:#418FDE;color:#fff}
    .cco-newbtn{background:#1d4ed8;border-color:#2563eb;color:#fff}
    .cco-listfoot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;padding-top:8px}
    .cco-count{font-size:11.5px;color:#7d8ba3}
    .cco-more{background:#1b2942;border:1px solid #33476a;color:#cdd8ec;border-radius:9px;padding:7px 16px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
    .cco-more:hover{border-color:#418FDE;color:#fff}
    /* operation rows (list + rail share this) */
    .cco-list{display:flex;flex-direction:column;gap:8px}
    .cco-op{display:flex;align-items:center;gap:12px;padding:12px 14px;background:#101a2e;
      border:1px solid #233149;border-radius:12px;cursor:pointer;transition:border-color .12s,background .12s}
    .cco-op:hover{border-color:#418FDE;background:#13203a}
    .cco-op:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
    .cco-dot{width:12px;height:12px;border-radius:50%;flex:0 0 auto;box-shadow:0 0 0 3px rgba(255,255,255,.05)}
    .cco-op-main{flex:1;min-width:0}
    .cco-op-name{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cco-op-meta{font-size:11.5px;color:#8aa0bf;margin-top:2px}
    .cco-op-counts{display:flex;gap:14px;flex:0 0 auto;text-align:center}
    .cco-op-counts .c{display:flex;flex-direction:column;line-height:1.1}
    .cco-op-counts .c b{font-size:16px;font-weight:800}
    .cco-op-counts .c span{font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;color:#8aa0bf}
    .cco-op-counts .crit b{color:#f87171}
    .cco-ar{color:#5b6b86;font-size:18px;flex:0 0 auto}
    /* un-operationalised cluster CTA row */
    .cco-cluster{border-style:dashed;border-color:#7f1d1d;background:#1b1113}
    .cco-cluster:hover{border-color:#f87171;background:#241416}
    .cco-cluster .cco-op-name{color:#fca5a5}
    /* detail - banner */
    .cco-banner{display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:12px;margin-bottom:14px;
      border:1px solid #233149;background:#101a2e;border-left:5px solid var(--op-accent,#418FDE)}
    .cco-bc{font-size:11.5px;color:#8aa0bf}
    .cco-bc b{color:#E6EDF7;font-weight:700}
    .cco-bc-region{color:#9fb2d4}
    .cco-exit{margin-left:auto;background:#1b2942;border:1px solid #33476a;border-radius:999px;
      padding:6px 14px;color:#cdd8ec;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
    .cco-exit:hover{border-color:#418FDE;color:#fff}
    .cco-status{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;background:#1b2942;color:#9fb3d1}
    .cco-health{width:11px;height:11px;border-radius:50%;flex:none;box-shadow:0 0 0 3px rgba(255,255,255,.06)}
    /* A4: merged health+status pill + unattended flag on the operation banner */
    .cco-hs-pill{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:700;letter-spacing:.03em;
      padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.04);border:1px solid var(--hc);color:#e6edf7;flex:none}
    .cco-hs-dot{width:9px;height:9px;border-radius:50%;background:var(--hc);box-shadow:0 0 0 3px color-mix(in srgb, var(--hc) 18%, transparent)}
    .cco-unatt-flag{font-size:10.5px;font-weight:700;letter-spacing:.03em;color:#fca5a5;background:#1d1113;border:1px solid #7f1d1d;border-radius:999px;padding:2px 9px;flex:none}
    .cco-resp{font-size:11.5px;color:#9fb3d1;white-space:nowrap}
    .cco-undo{margin-left:auto;border-color:#7f1d1d !important;color:#fca5a5 !important}
    .cco-undo:hover{border-color:#f87171 !important;color:#fff !important}
    /* vitals */
    .cco-vitals{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}
    .cco-vital{background:#101a2e;border:1px solid #233149;border-radius:12px;padding:12px 14px;cursor:pointer}
    .cco-vital:hover{border-color:#418FDE}
    .cco-vital .n{font-size:26px;font-weight:800}
    .cco-vital .l{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:#8aa0bf;margin-top:2px}
    .cco-vital.crit .n{color:#f87171}
    /* operation roll-up: incidents · reports · duplicate-review · unreviewed */
    .cco-rollup{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:-4px 0 14px;font-size:12px;color:#cbd9ef}
    .cco-rollup .cco-ru b{color:#e6eefb}
    .cco-ru-sep{color:#3a4a66}
    .cco-ru-mut{color:#8aa0bf}
    .cco-ru-dup{background:rgba(56,189,248,.08);border:1px solid rgba(56,189,248,.3);color:#7dd3fc;border-radius:7px;padding:3px 10px;font-size:12px;cursor:pointer}
    .cco-ru-dup:hover{background:rgba(56,189,248,.16)}
    /* detail grid: map | worklist */
    .cco-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media(max-width:1000px){.cco-grid{grid-template-columns:1fr}.cco-vitals{grid-template-columns:repeat(2,1fr)}}
    #cco-map{height:360px;border-radius:10px;overflow:hidden;background:#0d1422;isolation:isolate}
    .cco-wl-tabs{display:inline-flex;gap:4px;margin-right:8px}
    .cco-tab{background:#0d1626;border:1px solid #1f2c44;color:#9fb3d1;border-radius:7px;padding:2px 11px;font-size:11px;font-weight:700;cursor:pointer}
    .cco-tab.active{background:#13203a;border-color:#418FDE;color:#e6edf7}
    .cco-wl{max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px}
    /* Operation Buildings worklist: a local scroll height-matched to the map
       (max-height:360px from .cco-wl). De-congest so ~5 buildings show at a time
       (taller cards + a touch more gap); the rest lazy-load on scroll (renderInto
       pageSize). overscroll-behavior keeps the page from scrolling past the list. */
    #cco-bld{gap:8px;overscroll-behavior:contain}
    #cco-bld .bic{min-height:58px}
    .cco-wl-row{display:flex;align-items:center;gap:10px;padding:9px 11px;background:#0d1626;border:1px solid #1f2c44;
      border-radius:10px;cursor:pointer}
    .cco-wl-row:hover{border-color:#418FDE;background:#13203a}
    .cco-wl-sev{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
    .cco-wl-main{flex:1;min-width:0}
    .cco-wl-t{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cco-wl-m{font-size:11px;color:#8aa0bf;margin-top:1px}
    /* action bar */
    .cco-actions{position:sticky;bottom:0;display:flex;gap:10px;flex-wrap:wrap;padding:12px 0 0;margin-top:14px;
      background:linear-gradient(transparent,#0B1220 30%)}
    .cco-btn{background:#1b2942;border:1px solid #33476a;border-radius:10px;padding:9px 16px;color:#dce6f5;
      font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
    .cco-btn:hover{border-color:#418FDE;color:#fff}
    .cco-btn.primary{background:#1d4ed8;border-color:#2563eb;color:#fff}
    .cco-btn:disabled{opacity:.55;cursor:default}
    .cco-empty{padding:26px;text-align:center;color:#8aa0bf;font-size:13px}
    /* A5: read-only form-configuration modal */
    .cco-cfg-overlay{position:fixed;inset:0;z-index:100050;background:rgba(6,11,20,.72);backdrop-filter:blur(3px);
      display:flex;align-items:center;justify-content:center;padding:24px}
    .cco-cfg-card{width:min(720px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#0e1726;
      border:1px solid #233149;border-radius:14px;color:#e6edf7;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.5)}
    .cco-cfg-head{display:flex;align-items:center;gap:8px;padding:13px 16px;border-bottom:1px solid #1c2740;background:#101a2e;font-size:14px}
    .cco-cfg-name{color:#9fb3d1;font-weight:600}
    .cco-cfg-ro{margin-left:auto;font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#94a3b8;background:rgba(148,163,184,.16);border-radius:4px;padding:1px 7px}
    .cco-cfg-x{background:transparent;border:0;color:#8aa0bf;font-size:18px;cursor:pointer;padding:2px 6px;border-radius:8px}
    .cco-cfg-x:hover{background:#1b2942;color:#fff}
    .cco-cfg-body{padding:14px 16px;overflow:auto}
    .cco-cfg-sec{margin-bottom:16px}
    .cco-cfg-sec-t{font-size:12px;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:#cbd5e1;margin-bottom:7px}
    .cco-cfg-stage{font-size:10px;font-weight:600;color:#64748b;text-transform:none;letter-spacing:0;margin-left:6px}
    .cco-cfg-tbl{width:100%;border-collapse:collapse;font-size:12px}
    .cco-cfg-tbl th{text-align:left;color:#8aa0bf;font-weight:700;padding:4px 8px;border-bottom:1px solid #233149}
    .cco-cfg-tbl td{padding:4px 8px;border-bottom:1px solid rgba(35,49,73,.5);color:#dce6f5}
    .cco-cfg-opts td{color:#8aa0bf;font-size:11px;padding-top:0}
    .cco-cfg-empty{padding:24px;text-align:center;color:#8aa0bf;font-size:13px}
    /* local conditions - weather + hazard alerts */
    .cco-src{font-size:10px;font-weight:600;color:#5b6b86;text-transform:none;letter-spacing:0;margin-left:6px}
    #cco-weather{padding:14px 16px}
    .cco-wx{display:flex;align-items:center;gap:22px;flex-wrap:wrap}
    .cco-wx-now{display:flex;flex-direction:column}
    .cco-wx-t{font-size:30px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
    .cco-wx-s{font-size:12px;color:#9fb3d1;margin-top:3px}
    .cco-wx-m{display:flex;gap:16px;font-size:12.5px;color:#cdd8ec}
    .cco-wx-days{display:flex;gap:14px;margin-left:auto;flex-wrap:wrap}
    .cco-wx-day{display:flex;flex-direction:column;align-items:center;gap:1px;font-size:11px;color:#9fb3d1;min-width:54px}
    .cco-wx-day b{font-size:10.5px;color:#7d89a3;text-transform:uppercase;letter-spacing:.04em}
    .cco-wx-day span{font-weight:700;color:#dce6f5;font-variant-numeric:tabular-nums}
    .cco-wx-day small{font-size:9.5px;color:#7d89a3;text-align:center;line-height:1.15}
    .cco-alerts{margin-top:14px;padding-top:12px;border-top:1px solid #1f2c44}
    .cco-alerts-h{font-size:11.5px;font-weight:700;color:#fca5a5;margin-bottom:8px}
    .cco-alert{display:flex;align-items:center;gap:9px;padding:5px 0;font-size:12.5px}
    .cco-alert-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
    .cco-alert-t{font-weight:600;color:#e6edf7}
    .cco-alert-m{color:#8aa0bf;font-size:11px}
    .cco-alert-m a{color:#7db8ef;text-decoration:none}
    .cco-alerts-none{margin-top:12px;font-size:12px;color:#6ee7b7}
    .cco-wx-attr{margin-top:12px;font-size:10px;color:#5b6b86}
    `;
    const st = document.createElement('style');
    st.id = 'cc-ops-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function ensureOverlay() {
    injectStyles();
    let ov = el('cc-ops-overlay');
    if (!ov) {
      ov = document.createElement('div');
      ov.id = 'cc-ops-overlay';
      ov.innerHTML = '<div class="cco-wrap" id="cco-wrap"></div>';
      document.body.appendChild(ov);
    }
    return ov;
  }

  function teardownMap() {
    try { if (_map && _map.remove) _map.remove(); } catch (_e) {}
    _map = null; _cluster = null;
  }

  // ── LIST view (the scalable REGISTRY: search · filter · sort · density ·
  //    windowing). The home rail is the worst-first shortlist; THIS is where the
  //    full 50-500-operation portfolio lives without a scroll wall. ───────────
  const OPS_PAGE = 30;
  let _opsAll = [];
  const _opsView = { q: '', status: 'live', health: '', sort: 'worst', density: 'comfortable', shown: OPS_PAGE };
  try { if (localStorage.getItem('crisp_ops_density') === 'compact') _opsView.density = 'compact'; } catch (_e) {}
  const _unattended = (o) => (o && o.unattended_critical != null)
    ? Number(o.unattended_critical) > 0
    : ((Number(o && o.critical) || 0) > 0 && (Number(o && o.responders_active) || 0) === 0);

  function _opsControlsHtml() {
    const v = _opsView;
    const seg = (val, label) => `<button type="button" class="cco-seg${v.status === val ? ' active' : ''}" data-status="${val}">${label}</button>`;
    const hchip = (val, label, cls) => `<button type="button" class="cco-fchip ${cls}${v.health === val ? ' active' : ''}" data-health="${val}">${label}</button>`;
    return `<div class="cco-controls">
      <div class="cco-search"><span class="cco-search-ic" aria-hidden="true">🔍</span><input id="cco-search" type="search" placeholder="Search by name or place…" value="${esc(v.q)}" autocomplete="off" aria-label="Search operations"></div>
      <div class="cco-seg-grp" role="group" aria-label="Status filter">${seg('live', 'Live')}${seg('ended', 'Ended')}${seg('all', 'All')}</div>
      <div class="cco-fchips" role="group" aria-label="Health filter">${hchip('RED', 'Critical', 'red')}${hchip('AMBER', 'Rising', 'amber')}${hchip('GREEN', 'Stable', 'green')}${hchip('UNATT', 'Unattended', 'unatt')}</div>
      <select id="cco-sort" class="cco-sel" aria-label="Sort operations">
        <option value="worst"${v.sort === 'worst' ? ' selected' : ''}>Worst first</option>
        <option value="new"${v.sort === 'new' ? ' selected' : ''}>Recent activity</option>
        <option value="name"${v.sort === 'name' ? ' selected' : ''}>Name (A-Z)</option>
      </select>
      <button type="button" id="cco-density" class="cco-dens" title="Toggle row density">${v.density === 'compact' ? '☰ Compact' : '▤ Comfortable'}</button>
      <button type="button" id="cco-newop" class="cco-newbtn">+ New operation</button>
    </div>`;
  }

  function _wireOpsControls() {
    const wrap = el('cco-wrap'); if (!wrap) return;
    const s = el('cco-search');
    if (s) s.addEventListener('input', () => { _opsView.q = s.value || ''; _opsView.shown = OPS_PAGE; _applyOpsView(); });
    wrap.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => {
      _opsView.status = b.getAttribute('data-status'); _opsView.shown = OPS_PAGE; _applyOpsView(); _syncOpsControls();
    }));
    wrap.querySelectorAll('[data-health]').forEach((b) => b.addEventListener('click', () => {
      const h = b.getAttribute('data-health'); _opsView.health = (_opsView.health === h) ? '' : h; _opsView.shown = OPS_PAGE; _applyOpsView(); _syncOpsControls();
    }));
    const so = el('cco-sort'); if (so) so.addEventListener('change', () => { _opsView.sort = so.value; _applyOpsView(); });
    const d = el('cco-density');
    if (d) d.addEventListener('click', () => {
      _opsView.density = _opsView.density === 'compact' ? 'comfortable' : 'compact';
      try { localStorage.setItem('crisp_ops_density', _opsView.density); } catch (_e) {}
      d.textContent = _opsView.density === 'compact' ? '☰ Compact' : '▤ Comfortable';
      _applyOpsView();
    });
    const n = el('cco-newop'); if (n) n.addEventListener('click', () => { try { (window.openOperationWizard || function () {})(); } catch (_e) {} });
  }
  function _syncOpsControls() {
    const wrap = el('cco-wrap'); if (!wrap) return;
    wrap.querySelectorAll('[data-status]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-status') === _opsView.status));
    wrap.querySelectorAll('[data-health]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-health') === _opsView.health));
  }

  function _applyOpsView() {
    const host = el('cco-list'); if (!host) return;
    const v = _opsView;
    const _utc = window.__ccEnsureUTC || ((x) => x);
    const isEnded = (o) => String(o && o.status || '').toUpperCase() === 'ENDED';
    const real = (_opsAll || []).filter((o) => !o.is_cluster);
    const cluster = (_opsAll || []).find((o) => o.is_cluster) || null;
    const q = v.q.trim().toLowerCase();
    let list = real.filter((o) => {
      if (v.status === 'live' && isEnded(o)) return false;
      if (v.status === 'ended' && !isEnded(o)) return false;
      if ((v.health === 'RED' || v.health === 'AMBER' || v.health === 'GREEN') && o.health !== v.health) return false;
      if (v.health === 'UNATT' && !(String(o.status || '').toUpperCase() === 'LIVE' && _unattended(o))) return false;
      if (q && !String(o.name || '').toLowerCase().includes(q) && !String(o.place_name || '').toLowerCase().includes(q)) return false;
      return true;
    });
    if (v.sort === 'name') list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    else if (v.sort === 'new') list.sort((a, b) => new Date(_utc(b.last_activity || 0)) - new Date(_utc(a.last_activity || 0)));
    else list.sort(worstFirst);

    const total = list.length;
    // Pin the orphan-critical CTA only in the default, unfiltered live view.
    const showCluster = cluster && Number(cluster.critical) > 0 && v.status !== 'ended' && !v.health && !q;
    const rows = (showCluster ? [cluster] : []).concat(list.slice(0, v.shown));

    if (!rows.length) {
      host.innerHTML = `<div class="cco-empty">No operations match these filters.</div>`;
      return;
    }
    CrispOpCard.renderInto(host, rows, { grouped: false, presorted: true, compact: v.density === 'compact', startNew: false });

    const shownN = Math.min(v.shown, total);
    const foot = document.createElement('div');
    foot.className = 'cco-listfoot';
    foot.innerHTML = `<span class="cco-count">${fmtNum(shownN)} of ${fmtNum(total)} operation${total === 1 ? '' : 's'}</span>`
      + (total > v.shown ? `<button type="button" class="cco-more" id="cco-more">Load more (${fmtNum(total - v.shown)})</button>` : '');
    host.appendChild(foot);
    const more = el('cco-more');
    if (more) more.addEventListener('click', () => { _opsView.shown += OPS_PAGE; _applyOpsView(); });
  }

  async function renderList() {
    const wrap = el('cco-wrap');
    if (!wrap) return;
    // Pre-apply a filter handed over from the home rail's summary chips.
    let handoff = null;
    try { handoff = sessionStorage.getItem('crisp_ops_filter'); sessionStorage.removeItem('crisp_ops_filter'); } catch (_e) {}
    if (handoff === 'red') { _opsView.health = 'RED'; _opsView.status = 'live'; }
    else if (handoff === 'amber') { _opsView.health = 'AMBER'; _opsView.status = 'live'; }
    else if (handoff === 'green') { _opsView.health = 'GREEN'; _opsView.status = 'live'; }
    else if (handoff === 'unattended') { _opsView.health = 'UNATT'; _opsView.status = 'live'; }
    else if (handoff === 'all') { _opsView.health = ''; _opsView.status = 'all'; }
    _opsView.shown = OPS_PAGE;

    wrap.innerHTML = '<h1 class="cco-h">Operations</h1>'
      + '<p class="cco-sub">Search, filter and sort the full portfolio. Worst-first by default.</p>'
      + _opsControlsHtml()
      + '<div class="cco-list" id="cco-list"><div class="cco-empty">Loading operations…</div></div>';
    _wireOpsControls();
    try { _opsAll = await jget('/operations'); } catch (_e) {
      el('cco-list').innerHTML = '<div class="cco-empty">Could not load operations.</div>';
      return;
    }
    _applyOpsView();
  }

  // ── DETAIL view ──────────────────────────────────────────────────────────────
  async function renderDetail(id, mount, inPanel) {
    _detailOpId = id;   // every incident click in this worklist/map deep-links inside this op
    // `mount` lets the SAME operation dashboard render into the global #detail-panel
    // (the right-panel Operations Console) instead of the full-page overlay — the
    // single-page consolidation. inPanel rewires the exit/feed buttons to close the
    // panel (the scoped feed is already behind it) rather than navigate full-page.
    const wrap = mount || el('cco-wrap');
    if (!wrap) return;
    wrap.innerHTML = '<div class="cco-empty">Loading operation…</div>';

    let ops = [], summary = null, reports = [], dupRev = null;
    try {
      [ops, summary, reports, dupRev] = await Promise.all([
        jget('/operations').catch(() => []),
        jget('/analytics/summary?crisis_event_id=' + encodeURIComponent(id)).catch(() => null),
        jget('/reports/?limit=200&crisis_event_id=' + encodeURIComponent(id)).catch(() => []),
        // Building-scoped duplicate-review backlog for THIS operation (never global).
        jget('/reports/buildings-needing-review?crisis_event_id=' + encodeURIComponent(id)).catch(() => null),
      ]);
    } catch (_e) { /* fall through to whatever resolved */ }

    const op = (ops || []).find((o) => o.id === id);
    if (!op) {
      // M4 (Phase-2): a deleted / unknown operation id must NOT render a healthy-
      // looking GREEN, zero-count dashboard - that reads as "all clear for this
      // operation". Show an explicit not-found state and drop the shell op-context.
      try { window.__crispShell && window.__crispShell.clearOpContext && window.__crispShell.clearOpContext(); } catch (_e) {}
      wrap.innerHTML = `
        <div class="cco-empty" style="text-align:center;padding:48px 24px">
          <div style="font-size:34px;margin-bottom:8px">🗺️</div>
          <h3 style="margin:0 0 6px">Operation not found</h3>
          <p style="color:#9fb3d1;max-width:440px;margin:0 auto 16px">This operation no longer exists, has been deleted, or has ended and been archived - it may also be outside your access.</p>
          <button class="cco-exit" id="cco-exit-missing">← Back to operations</button>
        </div>`;
      const back = el('cco-exit-missing');
      if (back) back.addEventListener('click', () => go('#/operations'));
      return;
    }
    const isEnded = String(op.status || '').toUpperCase() === 'ENDED';
    const accent = opColor(op);
    const c = (summary && summary.counts) || {};
    // 2e - drive the shell's operation context (colored chrome + banner).
    try { window.__crispShell && window.__crispShell.setOpContext &&
          window.__crispShell.setOpContext(id, op.name, accent); } catch (_e) {}

    const vitals = [
      { n: c.critical, l: 'Critical', q: 'critical', crit: true },
      { n: c.needs_review, l: 'Needs review', q: 'needs-review' },
      { n: c.needs_response, l: 'Needs response', q: 'needs-response' },
      { n: c.active_operations, l: 'In response', q: 'active-ops' },
    ];

    wrap.innerHTML = `
      <div id="cco-command"></div>
      <div class="cco-banner" style="--op-accent:${accent}">
        <span class="cco-hs-pill" style="--hc:${healthColor(op)}" title="${esc(op.health_reason || op.health || '')}"><span class="cco-hs-dot"></span>${esc(op.status || (op.is_active ? 'LIVE' : 'ENDED'))}</span>
        <div class="cco-bc"><a class="cco-bc-global" style="cursor:pointer;text-decoration:none" onclick="window.__crispRouter&&window.__crispRouter.navigate('/incidents')">Global</a> › <b>${esc(op.name)}</b>${op.place_name ? ' · <span class="cco-bc-region">' + esc(op.place_name) + '</span>' : ''}</div>
        ${isEnded ? '<span class="cco-ended-note" style="font-size:10px;font-weight:700;color:#fbbf24;letter-spacing:.05em" title="This operation has ended - shown for historical reference">READ-ONLY</span>' : ''}
        ${_unattended(op) ? '<span class="cco-unatt-flag" title="This operation has unattended critical reports">🚨 Unattended</span>' : ''}
        <span class="cco-resp">🚑 ${fmtNum(op.responders_active || 0)} responder${(op.responders_active || 0) === 1 ? '' : 's'}</span>
        <button class="cco-exit" id="cco-exit">← Exit to global</button>
      </div>
      <div class="cco-vitals" id="cco-vitals">
        ${vitals.map((v) => `<div class="cco-vital ${v.crit ? 'crit' : ''}" data-q="${v.q}">
            <div class="n cco-num">${fmtNum(v.n)}</div><div class="l">${esc(v.l)}</div></div>`).join('')}
      </div>
      <div class="cco-rollup" id="cco-rollup">
        <span class="cco-ru"><b>${fmtNum(op.incident_count || 0)}</b> incident${(op.incident_count || 0) === 1 ? '' : 's'}</span>
        <span class="cco-ru-sep">·</span>
        <span class="cco-ru"><b>${fmtNum(op.total || 0)}</b> report${(op.total || 0) === 1 ? '' : 's'}</span>
        <span class="cco-ru-sep">·</span>
        <span class="cco-ru"><b>${fmtNum(op.verified || 0)}</b> verified</span>
        <span class="cco-ru-sep">·</span>
        <span class="cco-ru cco-ru-mut"><b>${fmtNum(op.new_24h || 0)}</b> new&nbsp;24h</span>
        ${(dupRev && dupRev.total_buildings) ? `<span class="cco-ru-sep">·</span><button type="button" class="cco-ru-dup" id="cco-ru-dup" title="Review &amp; merge duplicates building-by-building for this operation">🔗 ${fmtNum(dupRev.total_buildings)} building${dupRev.total_buildings === 1 ? '' : 's'} need duplicate review</button>` : ''}
        ${(op.unreviewed_count || 0) ? `<span class="cco-ru-sep">·</span><span class="cco-ru cco-ru-mut">${fmtNum(op.unreviewed_count)} unreviewed</span>` : ''}
      </div>
      <div class="cco-grid">
        <div>
          <div class="cco-sec-t">Operation map</div>
          <div class="cco-card" style="padding:8px"><div id="cco-map"></div></div>
        </div>
        <div>
          <div class="cco-sec-t"><span class="cco-wl-tabs" id="cco-wl-tabs"><button type="button" class="cco-tab active" data-wl="buildings">Buildings</button><button type="button" class="cco-tab" data-wl="reports">Reports</button></span> <span class="cco-src" id="cco-wl-src">affected buildings · priority first</span></div>
          <div class="cco-wl" id="cco-bld"></div>
          <div class="cco-wl" id="cco-wl" style="display:none"></div>
        </div>
      </div>
      <div class="cco-sec-t">Local conditions <span class="cco-src">weather · hazard alerts</span></div>
      <div class="cco-card" id="cco-weather"><div class="cco-empty">Loading local conditions…</div></div>
      <div class="cco-actions">
        <button class="cco-btn primary" id="cco-act-feed">Open Incident Feed</button>
        <button class="cco-btn" id="cco-act-oprep" title="Download a multi-section Operation Summary PDF">📄 Download Summary PDF</button>
        <button class="cco-btn" id="cco-act-export" title="Export this operation's reports (CSV / GeoJSON / Shapefile / KML / PDF)">Export Reports</button>
        ${op.form_pack_id ? `<button class="cco-btn" id="cco-act-editform" title="Edit this operation's crisis-form questions">Edit Operation Form</button>
        <button class="cco-btn" id="cco-act-viewcfg" title="View the active form configuration (read-only)">View Form Configuration</button>` : ''}
        <button class="cco-btn" id="cco-act-forms" title="Activate / deploy a crisis-form pack for a zone">Deploy form pack</button>
        <button class="cco-btn cco-undo" id="cco-act-undo" title="Reverse the most recent cluster claim on this operation">↩ Undo claim</button>
      </div>`;

    // Command Center: the shared Analyze + scoped cascade-action panel at the top
    // of the operation (percolates to every incident + report in scope).
    try {
      if (window.CrispCommandPanel && el('cco-command')) {
        window.CrispCommandPanel.render({ level: 'operation', id, data: op, mountEl: el('cco-command') });
      }
    } catch (_e) {}

    // In the panel the scoped feed is already behind the console, so "Exit to global"
    // closes the panel + drops the op scope; full-page keeps the old home nav.
    const exit = inPanel
      ? () => {
          try { window.setOperationScope && window.setOperationScope(null); } catch (_e) {}
          try { window._writeScopeHash && window._writeScopeHash(); } catch (_e) {}   // drop ;op= from the URL
          try { window.closeDetail && window.closeDetail(); } catch (_e) {}
        }
      : () => navTo('/');
    el('cco-exit').addEventListener('click', exit);
    el('cco-vitals').querySelectorAll('[data-q]').forEach((v) => {
      // Drill into THIS operation's incidents, filtered by the vital's queue -
      // the op scope is carried so the analyst keeps context on the feed.
      v.addEventListener('click', () => go('#/incidents;op=' + encodeURIComponent(_detailOpId) + ';queue=' + v.getAttribute('data-q')));
    });
    // Building-scoped duplicate-review entry: jump to the Buildings worklist (the
    // per-building review surface) - merge happens IN each building's workspace,
    // never globally. The worst-first building cards are already shown there.
    const ruDup = el('cco-ru-dup');
    if (ruDup) ruDup.addEventListener('click', () => {
      const tabs = el('cco-wl-tabs');
      const bTab = tabs && tabs.querySelector('[data-wl="buildings"]');
      if (bTab) bTab.click();
      const bld = el('cco-bld');
      if (bld && bld.scrollIntoView) bld.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    // Open the Incident Feed SCOPED to this operation (context persists). In the panel
    // the scoped feed is already showing behind the console, so this just closes the panel.
    el('cco-act-feed').addEventListener('click', inPanel
      ? () => { try { window.closeDetail && window.closeDetail(); } catch (_e) {} }
      : () => go('#/incidents;op=' + encodeURIComponent(_detailOpId)));
    el('cco-act-export').addEventListener('click', () => {
      // Stash THIS operation's id so the Export Center scopes the download to it.
      // The router's global hideAll() clears the live op scope (setOperationScope
      // null) BEFORE /exports opens, so getOperationScope() is already null there -
      // capture it at click time instead.
      try { window.__crispExportCtx = { crisis_event_id: id }; } catch (_e) {}
      // In the panel, close the console first so the route overlay (z 99992) isn't
      // hidden behind the detail-panel (z 100000).
      if (inPanel) { try { window.closeDetail && window.closeDetail(); } catch (_e) {} }
      navTo('/exports');
    });
    el('cco-act-forms').addEventListener('click', () => { if (inPanel) { try { window.closeDetail && window.closeDetail(); } catch (_e) {} } navTo('/reporting'); });
    // Download the multi-section Operation Summary PDF.
    const opRep = el('cco-act-oprep');
    if (opRep) opRep.addEventListener('click', () => _downloadOperationReportPdf(id, opRep));
    // Edit this operation's crisis-form pack (opens the builder for op.form_pack_id).
    const editForm = el('cco-act-editform');
    if (editForm) editForm.addEventListener('click', () => {
      if (op.form_pack_id && typeof window.openCrisisFormBuilder === 'function') window.openCrisisFormBuilder(op.form_pack_id);
      else navTo('/reporting');
    });
    // View the active form configuration read-only.
    const viewCfg = el('cco-act-viewcfg');
    if (viewCfg) viewCfg.addEventListener('click', () => _showFormConfig(op.form_pack_id, op.form_name));
    el('cco-act-undo').addEventListener('click', (ev) => {
      // D4: confirm the (claim-reversing) action + pass the button so the handler
      // disables it during the request (no spam-click) and defers the redirect.
      const btn = ev.currentTarget;
      if (!window.confirm('Reverse the most recent claim for this operation? The reports it claimed are released back to the global queue.')) return;
      (window.unclaimOperation || function () {})(id, btn);
    });

    renderWorklist(reports);
    renderOpBuildings(reports);
    // Reports | Buildings worklist toggle (Buildings is the default operational
    // worklist - the real places help is sent). Reports stays one click away.
    const tabs = el('cco-wl-tabs');
    if (tabs) tabs.querySelectorAll('[data-wl]').forEach((btn) => btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-wl');
      tabs.querySelectorAll('[data-wl]').forEach((b) => b.classList.toggle('active', b === btn));
      const wl = el('cco-wl'), bld = el('cco-bld'), src = el('cco-wl-src');
      const showReports = mode === 'reports';
      if (wl) wl.style.display = showReports ? '' : 'none';
      if (bld) bld.style.display = showReports ? 'none' : '';
      if (src) src.textContent = showReports ? 'only this operation · critical first' : 'affected buildings · priority first';
    }));
    renderOpMap(reports);
    loadWeather(id);
  }

  // Operation Buildings worklist: the buildings that have a report in THIS operation,
  // ranked by humanitarian_priority, using the SAME shared card as the global view.
  // Scoped by the op's report building-ids (client filter of the priority-ranked list)
  // - zero backend change; the op-scoped /buildings endpoint is a P2 refinement.
  async function renderOpBuildings(reports) {
    const box = el('cco-bld');
    if (!box) return;
    const ids = new Set((reports || []).map((r) => r && r.building_id).filter(Boolean));
    if (!ids.size) { box.innerHTML = '<div class="cco-empty">No building-tagged reports in this operation yet.</div>'; return; }
    box.innerHTML = '<div class="cco-empty">Loading buildings…</div>';
    try {
      const body = await jget('/buildings?order_by=humanitarian_priority&order_dir=desc&limit=300');
      const items = (((body && body.items) || []).filter((b) => ids.has(b.id)));
      if (!box.isConnected) return;
      // Lazy-load: show ~5 buildings (the worklist is height-matched to the map),
      // stream the rest as the operator scrolls - no congested wall at 50+ buildings.
      // openBuildingConsole (the card default) now reparents #detail-panel to <body>,
      // so the console shows as a global overlay over this operations overlay - the
      // same way the incident detail panel already does from the op-map markers.
      if (window.CrispBuildingCard) window.CrispBuildingCard.renderInto(box, items, { emptyText: 'No buildings for this operation.', pageSize: 8 });
    } catch (_e) {
      box.innerHTML = '<div class="cco-empty">Buildings unavailable.</div>';
    }
  }

  // ── local conditions (weather + hazard alerts) - backend-proxied + cached ──
  async function loadWeather(id) {
    const box = el('cco-weather');
    if (!box) return;
    let ctx;
    try { ctx = await jget('/operations/' + encodeURIComponent(id) + '/weather'); }
    catch (_e) { box.innerHTML = '<div class="cco-empty">Local conditions unavailable.</div>'; return; }
    if (!box.isConnected) return;                 // user navigated away mid-fetch
    if (!ctx || !ctx.available) {
      box.innerHTML = '<div class="cco-empty">Local conditions unavailable right now.</div>';
      return;
    }
    const w = ctx.weather, alerts = ctx.alerts || [];
    const r = (n, suf) => (n == null ? '-' : Math.round(n) + suf);
    let html = '';
    if (w) {
      html += `<div class="cco-wx">
        <div class="cco-wx-now"><div class="cco-wx-t">${r(w.temperature_c, '°C')}</div>
          <div class="cco-wx-s">${esc(w.summary || '-')}</div></div>
        <div class="cco-wx-m">
          <span>💧 ${w.humidity_pct != null ? w.humidity_pct + '%' : '-'}</span>
          <span>🌧 ${w.precipitation_mm != null ? w.precipitation_mm + ' mm' : '-'}</span>
          <span>💨 ${r(w.wind_kmh, ' km/h')}</span></div>
        <div class="cco-wx-days">${(w.daily || []).map((d) => `<div class="cco-wx-day">
          <b>${esc(String(d.date || '').slice(5))}</b>
          <span>${d.t_max_c != null ? Math.round(d.t_max_c) : '-'}° / ${d.t_min_c != null ? Math.round(d.t_min_c) : '-'}°</span>
          <small>${esc(d.summary || '')}</small></div>`).join('')}</div>
      </div>`;
    }
    if (alerts.length) {
      html += `<div class="cco-alerts"><div class="cco-alerts-h">⚠ Hazard alerts near this operation</div>`
        + alerts.map((a) => {
          const lvl = String(a.alert_level || '').toLowerCase();
          const col = lvl === 'red' ? '#f87171' : lvl === 'orange' ? '#fb923c' : '#9fb3d1';
          const link = a.url ? ` · <a href="${esc(a.url)}" target="_blank" rel="noopener">details ↗</a>` : '';
          const meta = [a.type, a.distance_km != null ? a.distance_km + ' km' : '', a.country].filter(Boolean).join(' · ');
          return `<div class="cco-alert"><span class="cco-alert-dot" style="background:${col}"></span>
            <span class="cco-alert-t">${esc(a.name || a.type || 'Alert')}</span>
            <span class="cco-alert-m">${esc(meta)}${link}</span></div>`;
        }).join('') + `</div>`;
    } else if (w) {
      html += `<div class="cco-alerts-none">✓ No active hazard alerts near this operation.</div>`;
    }
    html += `<div class="cco-wx-attr">${esc((w && w.attribution) || '')}${w ? ' · ' : ''}Hazard alerts: GDACS (UN OCHA · EC JRC)</div>`;
    box.innerHTML = html;
  }

  function _isOpen(r) {
    return !['RESOLVED', 'REJECTED', 'FALSE_ALARM'].includes(String(r.status || '').toUpperCase());
  }
  function renderWorklist(reports) {
    const host = el('cco-wl');
    if (!host) return;
    // Worklist = open reports, worst severity first, newest within severity.
    const rows = (reports || [])
      .filter(_isOpen)
      .sort((a, b) => (SEV_RANK[String(b.severity).toUpperCase()] || 0) - (SEV_RANK[String(a.severity).toUpperCase()] || 0)
        || String(b.server_created_at || '').localeCompare(String(a.server_created_at || '')))
      .slice(0, 80);
    if (!rows.length) { host.innerHTML = '<div class="cco-empty">No open reports in this operation.</div>'; return; }
    host.innerHTML = rows.map((r) => {
      const sev = String(r.severity || 'UNKNOWN').toUpperCase();
      const loc = (r.location && (r.location.device_location_name || r.location.user_location_name)) || '';
      return `<div class="cco-wl-row" data-id="${esc(r.id)}" role="link" tabindex="0">
        <span class="cco-wl-sev" style="background:${SEV_COLOR[sev] || SEV_COLOR.UNKNOWN}"></span>
        <div class="cco-wl-main">
          <div class="cco-wl-t">${esc(titleCase(r.crisis_type) || 'Report')}${r.infrastructure_type ? ' · ' + esc(titleCase(r.infrastructure_type)) : ''}</div>
          <div class="cco-wl-m">${esc(titleCase(sev))}${loc ? ' · ' + esc(loc) : ''} · ${timeAgo(r.server_created_at)}</div>
        </div>
        <div class="cco-ar">›</div></div>`;
    }).join('');
    host.querySelectorAll('[data-id]').forEach((row) => {
      // Clicking an incident leaves the operation dashboard for the full Incident
      // Feed page, SCOPED to this operation, with the report selected:
      //   #/incidents;op={opId}?incident={id}
      // -> router.dispatch() applies setOperationScope(opId), then
      //    CrispNav.restoreFromHash() runs selectReport + markSelected, so the
      //    feed list shows on the LEFT (this row highlighted + scrolled into view)
      //    and the detail report opens on the RIGHT. Deep-linkable / refresh-safe.
      const open = () => go('#/incidents;op=' + encodeURIComponent(_detailOpId) + '?incident=' + encodeURIComponent(row.getAttribute('data-id')));
      row.addEventListener('click', open);
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  function renderOpMap(reports) {
    teardownMap();
    const cont = el('cco-map');
    if (!cont || typeof window.L === 'undefined') {
      if (cont) cont.innerHTML = '<div class="cco-empty">Map unavailable.</div>';
      return;
    }
    const L = window.L;
    const pts = (reports || [])
      .map((r) => r.location && [r.location.latitude, r.location.longitude, r])
      .filter((p) => p && typeof p[0] === 'number' && typeof p[1] === 'number');
    try {
      _map = L.map(cont, { zoomControl: true, attributionControl: false });
      L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', { maxZoom: 18 }).addTo(_map);
      _cluster = (L.markerClusterGroup ? L.markerClusterGroup() : L.layerGroup()).addTo(_map);
      pts.forEach(([lat, lng, r]) => {
        const sev = String(r.severity || 'UNKNOWN').toUpperCase();
        L.circleMarker([lat, lng], { radius: 7, color: SEV_COLOR[sev] || SEV_COLOR.UNKNOWN, weight: 2, fillOpacity: .65 })
          // Route the SAME way a worklist report row does, so the operation id is
          // retained in the hash (#/incidents;op={id}?incident={rid}) instead of
          // dropping to #/operations?incident=… and losing op context (D3).
          .on('click', () => { try { go('#/incidents;op=' + encodeURIComponent(_detailOpId) + '?incident=' + encodeURIComponent(r.id)); } catch (_e) {} })
          .addTo(_cluster);
      });
      if (pts.length) {
        _map.fitBounds(pts.map((p) => [p[0], p[1]]), { padding: [28, 28], maxZoom: 12 });
      } else {
        _map.setView([20, 0], 2);
        cont.insertAdjacentHTML('beforeend', '<div class="cco-empty" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center">No located reports.</div>');
      }
      _map.whenReady(() => requestAnimationFrame(() => { try { _map.invalidateSize(); } catch (_e) {} }));
    } catch (_e) {
      teardownMap();
      cont.innerHTML = '<div class="cco-empty">Map failed to load.</div>';
    }
  }

  // ── public API ───────────────────────────────────────────────────────────
  function openOperations(id) {
    ensureOverlay();
    const ov = el('cc-ops-overlay');
    ov.classList.add('cc-ops-open');
    if (id) {
      try { window.setOperationScope && window.setOperationScope(id); } catch (_e) {}
      renderDetail(id);
    } else {
      try { window.setOperationScope && window.setOperationScope(null); } catch (_e) {}
      try { window.__crispShell && window.__crispShell.clearOpContext && window.__crispShell.clearOpContext(); } catch (_e) {}
      renderList();
    }
  }

  function closeOverlay() {
    const ov = el('cc-ops-overlay');
    if (ov) ov.classList.remove('cc-ops-open');
    teardownMap();
    // Leaving operations → reset global scope + clear the shell context chrome.
    try { window.setOperationScope && window.setOperationScope(null); } catch (_e) {}
    try { window.__crispShell && window.__crispShell.clearOpContext && window.__crispShell.clearOpContext(); } catch (_e) {}
  }

  window.openOperations = openOperations;
  // renderInto: render the operation dashboard into an arbitrary element (the global
  // #detail-panel) for the single-page Operations Console. Ensures the cco-* styles
  // are present (injectStyles is idempotent); the hidden #cco-wrap overlay stays empty
  // so there is no duplicate-id collision with the panel-mounted cco-* nodes.
  window.__ccOperations = {
    openOperations, closeOverlay,
    renderInto(mount, id) { try { injectStyles(); } catch (_e) {} return renderDetail(id, mount, true); },
  };
})();
