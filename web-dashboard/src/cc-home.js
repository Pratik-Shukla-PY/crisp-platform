/* cc-home.js — Crisis Intelligence Center (post-login landing).
 *
 * A humanitarian situation room shown over the dashboard at route '/'. It
 * delivers SITUATIONAL AWARENESS first, navigation second — replacing the old
 * 4-tile launcher. It does NOT redesign the "Monitor & Respond" module; it
 * surfaces a read-only summary and routes INTO that module for action.
 *
 * Hard rule (operator brief): every widget is backed by REAL data — no dummy
 * cards, no fake AI, no hardcoded KPIs. Sources:
 *   • GET /api/v1/analytics/summary   — KPIs, distributions, timings, impact, deltas
 *   • GET /api/v1/analytics/damage-rate-24h — 24h intake sparkline
 *   • GET /api/v1/reports/?limit=…    — map markers + recent activity
 *   • GET /api/v1/reports/nearby      — emerging-hotspot briefing
 *   • router.js                       — deep-links into the operations module
 * Metrics with no backing data (population/displacement/households) are shown
 * as an explicit "data integration required" note, never invented.
 * See web-dashboard/docs/crisis-intelligence-dashboard-spec.md.
 *
 * app.js / styles.css are NOT touched (this file + its injected styles only).
 */
(function () {
  'use strict';
  if (window.__ccHomeLoaded) return;
  window.__ccHomeLoaded = true;

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
  const BACKEND_HOST = _isLocalDev ? `http://${window.location.hostname}:8000` : window.location.origin;
  const API = `${BACKEND_HOST}/api/v1`;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const el = (id) => document.getElementById(id);
  function timeAgo(s) {
    if (!s) return '';
    const t = new Date(s).getTime();
    if (isNaN(t)) return '';
    const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (sec < 60) return 'just now';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
    return Math.floor(sec / 86400) + 'd ago';
  }
  const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
  function fmtDur(sec) {
    if (sec == null) return '—';
    sec = Math.round(sec);
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    if (sec < 86400) return (sec / 3600).toFixed(1) + 'h';
    return (sec / 86400).toFixed(1) + 'd';
  }
  const titleCase = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

  async function jget(path) {
    const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token() || ''}` } });
    if (!res.ok) throw new Error(String(res.status));
    return { body: await res.json(), headers: res.headers };
  }

  const SEV_COLOR = {
    CRITICAL: '#f87171', SEVERE: '#fb923c', MODERATE: '#fbbf24', MINOR: '#4ade80', UNKNOWN: '#64748b',
  };
  const SEV_ORDER = ['CRITICAL', 'SEVERE', 'MODERATE', 'MINOR', 'UNKNOWN'];

  // Module-level handles (single landing instance).
  let _map = null, _cluster = null, _poll = null;

  // ── styles ───────────────────────────────────────────────────────────────
  function injectStyles() {
    if (el('cc-home-styles')) return;
    const css = `
    #cc-home-overlay{position:fixed;inset:0;z-index:99990;display:none;overflow:auto;
      background:radial-gradient(1100px 560px at 78% -12%,rgba(65,143,222,.12),transparent 60%),
        radial-gradient(820px 460px at -5% 108%,rgba(34,211,238,.07),transparent 55%),#0B1220;
      color:#E6EDF7;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    #cc-home-overlay.cc-home-open{display:block}
    .cc-wrap{max-width:1480px;margin:0 auto;padding:18px 22px 40px;min-height:100%}
    .cc-num{font-variant-numeric:tabular-nums}
    /* header */
    .cc-hd{display:flex;align-items:center;gap:13px;margin-bottom:16px}
    .cc-logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#418FDE,#22d3ee);
      display:grid;place-items:center;font-weight:800;color:#fff;flex:none;overflow:hidden}
    .cc-logo img{width:100%;height:100%;object-fit:contain}
    .cc-hd .ti{font-weight:800;font-size:17px;letter-spacing:-.01em;margin:0;line-height:1.2}
    .cc-hd .su{font-size:11.5px;color:#8A99B5}
    .cc-hd .sp{margin-left:auto;display:flex;align-items:center;gap:14px}
    .cc-live{display:flex;align-items:center;gap:7px;font-size:12px;color:#8A99B5}
    .cc-dot{width:8px;height:8px;border-radius:50%}
    .cc-clock{font-size:12px;color:#8A99B5;font-variant-numeric:tabular-nums}
    .cc-avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#418FDE,#22d3ee);
      color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}
    .cc-btn{border:1px solid #2C3A52;background:#1A2740;color:#cdd8ec;border-radius:8px;padding:7px 13px;
      font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}
    .cc-btn:hover{border-color:#418FDE;color:#fff}
    .cc-btn-pri{background:#418FDE;border-color:#418FDE;color:#fff}
    /* section + cards */
    .cc-sec-t{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#8A99B5;margin:22px 2px 10px;display:flex;align-items:center;gap:8px}
    .cc-card{background:#121A2A;border:1px solid #243149;border-radius:12px;padding:15px}
    /* KPI strip */
    .cc-kpis{display:grid;grid-template-columns:repeat(8,1fr);gap:12px}
    @media(max-width:1180px){.cc-kpis{grid-template-columns:repeat(4,1fr)}}
    @media(max-width:560px){.cc-kpis{grid-template-columns:repeat(2,1fr)}}
    .cc-kpi{background:#121A2A;border:1px solid #243149;border-radius:12px;padding:13px 14px;position:relative}
    .cc-kpi.crit{border-color:rgba(248,113,113,.45);background:linear-gradient(180deg,rgba(248,113,113,.08),#121A2A)}
    .cc-kpi .n{font-size:30px;font-weight:800;line-height:1.05;font-variant-numeric:tabular-nums}
    .cc-kpi .l{font-size:11px;color:#8A99B5;margin-top:5px;text-transform:uppercase;letter-spacing:.04em}
    .cc-chip{display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:700;margin-top:6px;padding:1px 6px;border-radius:20px}
    /* body grid */
    .cc-body{display:grid;grid-template-columns:2fr 1fr;gap:14px}
    @media(max-width:1100px){.cc-body{grid-template-columns:1fr}}
    #cc-map{height:430px;border-radius:10px;overflow:hidden;background:#0d1422}
    .cc-map-fallback{height:430px;display:grid;place-items:center;color:#8A99B5;font-size:13px}
    /* attention queue */
    .cc-att-row{display:flex;align-items:center;gap:11px;padding:11px 6px;border-top:1px solid #1d2942;cursor:pointer}
    .cc-att-row:first-of-type{border-top:none}
    .cc-att-row:hover{background:#16213a}
    .cc-att-ic{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;font-size:13px;flex:none}
    .cc-att-row .lab{flex:1;font-size:13px;color:#cdd8ec}
    .cc-att-row .cnt{font-size:18px;font-weight:800;font-variant-numeric:tabular-nums}
    .cc-att-row .ar{color:#5C6B85;font-size:13px}
    .cc-att-row.zero .cnt{color:#34D399}
    /* ops intel grid */
    .cc-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
    @media(max-width:980px){.cc-grid3{grid-template-columns:1fr}}
    .cc-bar-row{display:flex;align-items:center;gap:8px;margin:7px 0;font-size:12px}
    .cc-bar-row .bl{width:78px;color:#aab4c5;flex:none;text-transform:capitalize;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cc-bar-track{flex:1;height:8px;background:#1d2942;border-radius:6px;overflow:hidden}
    .cc-bar-fill{height:100%;border-radius:6px}
    .cc-bar-row .bv{width:34px;text-align:right;color:#cdd8ec;font-variant-numeric:tabular-nums;flex:none}
    .cc-spark{display:flex;align-items:flex-end;gap:2px;height:48px;margin-top:6px}
    .cc-spark i{flex:1;background:#418FDE;border-radius:2px 2px 0 0;min-height:2px;opacity:.85}
    .cc-statline{display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-top:1px solid #1d2942}
    .cc-statline:first-child{border-top:none}
    .cc-statline .v{font-weight:700;font-variant-numeric:tabular-nums}
    /* impact + briefing */
    .cc-grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media(max-width:980px){.cc-grid2{grid-template-columns:1fr}}
    .cc-imp{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
    .cc-imp .b{background:#0f1726;border:1px solid #1d2942;border-radius:10px;padding:11px 13px}
    .cc-imp .b .n{font-size:22px;font-weight:800;font-variant-numeric:tabular-nums}
    .cc-imp .b .l{font-size:11px;color:#8A99B5;margin-top:3px}
    .cc-note{font-size:11.5px;color:#7d89a3;background:#0f1726;border:1px dashed #2C3A52;border-radius:9px;padding:9px 11px;line-height:1.5}
    .cc-brief{padding:10px 11px;border-radius:10px;background:#0f1726;border-left:3px solid #418FDE;margin-bottom:9px}
    .cc-brief .h{font-size:13px;font-weight:700;color:#E6EDF7;margin-bottom:2px}
    .cc-brief .d{font-size:12px;color:#aab4c5;line-height:1.45}
    .cc-brief .s{font-size:10px;color:#5C6B85;margin-top:4px}
    .cc-brief.warn{border-left-color:#fb923c}.cc-brief.crit{border-left-color:#f87171}
    /* activity table */
    .cc-tbl{width:100%;border-collapse:collapse;font-size:12.5px}
    .cc-tbl th{text-align:left;color:#8A99B5;font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;padding:7px 9px;border-bottom:1px solid #243149}
    .cc-tbl td{padding:9px 9px;border-bottom:1px solid #1a2436;color:#cdd8ec;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:190px}
    .cc-tbl tr{cursor:pointer}.cc-tbl tbody tr:hover{background:#16213a}
    .cc-badge{display:inline-block;padding:1px 8px;border-radius:20px;font-size:10.5px;font-weight:700}
    /* quick actions */
    .cc-qa{display:flex;flex-wrap:wrap;gap:10px}
    .cc-qa button{display:flex;align-items:center;gap:8px;background:#121A2A;border:1px solid #243149;border-radius:10px;
      padding:11px 15px;color:#cdd8ec;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
    .cc-qa button:hover{border-color:#418FDE;color:#fff}
    .cc-qa button[disabled]{opacity:.45;cursor:not-allowed}
    .cc-qa .ad{font-size:9px;font-weight:700;color:#5C6B85;text-transform:uppercase;margin-left:2px}
    .cc-empty{color:#5C6B85;font-size:12.5px;padding:14px 4px;text-align:center}
    .cc-stale{font-size:10.5px;color:#7d89a3;margin-left:6px}
    @media(prefers-reduced-motion:no-preference){.cc-kpi .n{transition:none}}
    `;
    const tag = document.createElement('style');
    tag.id = 'cc-home-styles';
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // ── overlay ────────────────────────────────────────────────────────────────
  function ensureOverlay() {
    let ov = el('cc-home-overlay');
    if (ov) return ov;
    injectStyles();
    ov = document.createElement('div');
    ov.id = 'cc-home-overlay';
    // Labelled landmark region (app.js already owns <main id="view-incidents">,
    // so a second `main` would be invalid; `region` + aria-label is correct).
    ov.setAttribute('role', 'region');
    ov.setAttribute('aria-label', 'CRISP Crisis Intelligence Center');
    document.body.appendChild(ov);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ov.classList.contains('cc-home-open')) {
        if (window.__crispRouter) window.__crispRouter.navigate('/incidents'); else closeLanding();
      }
    });
    return ov;
  }
  function closeLanding() {
    const ov = el('cc-home-overlay');
    if (ov) ov.classList.remove('cc-home-open');
    if (_poll) { clearInterval(_poll); _poll = null; }
  }

  const go = (r) => { try { if (window.__crispRouter) window.__crispRouter.navigate(r); } catch (_e) {} };

  // ── layout ───────────────────────────────────────────────────────────────
  async function openLanding() {
    if (!token()) return;
    ensureOverlay();
    const ov = el('cc-home-overlay');
    const user = currentUser();
    const name = (user.full_name || user.email || '').split('@')[0] || 'operator';
    const initial = (name[0] || 'U').toUpperCase();
    const role = String(user.role || 'VIEWER').toUpperCase();
    ov.innerHTML = `
      <div class="cc-wrap">
        <div class="cc-hd">
          <div class="cc-logo" id="cc-home-logo">C</div>
          <div><h1 class="ti" id="cc-home-orgname">Crisis Intelligence Center</h1>
            <div class="su">Crisis Response Intelligence · Situation Room</div></div>
          <div class="sp">
            <span class="cc-live"><span class="cc-dot" id="cc-conn"></span><span id="cc-conn-t">—</span></span>
            <span class="cc-clock" id="cc-clock">—</span>
            <button class="cc-btn cc-btn-pri" id="cc-go-ops">Operations →</button>
            <div class="cc-avatar" title="${esc(user.email || '')} · ${esc(role)}">${esc(initial)}</div>
          </div>
        </div>

        <div class="cc-sec-t">Executive Situation Overview <span class="cc-stale" id="cc-sum-stale"></span></div>
        <div class="cc-kpis" id="cc-kpis">${kpiSkeleton()}</div>

        <div class="cc-body">
          <div>
            <div class="cc-sec-t">Global Crisis Snapshot</div>
            <div class="cc-card" style="padding:8px"><div id="cc-map"></div></div>
          </div>
          <div>
            <div class="cc-sec-t">Immediate Attention Required</div>
            <div class="cc-card" id="cc-att"><div class="cc-empty">Loading…</div></div>
          </div>
        </div>

        <div class="cc-sec-t">Operational Intelligence</div>
        <div class="cc-grid3">
          <div class="cc-card"><div class="cc-sec-t" style="margin:0 0 8px">By severity</div><div id="cc-dist-sev"></div></div>
          <div class="cc-card"><div class="cc-sec-t" style="margin:0 0 8px">By crisis type</div><div id="cc-dist-type"></div></div>
          <div class="cc-card"><div class="cc-sec-t" style="margin:0 0 8px">Efficiency &amp; intake</div><div id="cc-eff"></div></div>
        </div>

        <div class="cc-grid2" style="margin-top:14px">
          <div><div class="cc-sec-t">Operational Impact</div><div class="cc-card" id="cc-impact"></div></div>
          <div><div class="cc-sec-t">Situation Briefing</div><div class="cc-card" id="cc-brief"><div class="cc-empty">Analyzing…</div></div></div>
        </div>

        <div class="cc-sec-t">Recent Operational Activity</div>
        <div class="cc-card" id="cc-activity" style="padding:6px 10px"><div class="cc-empty">Loading…</div></div>

        <div class="cc-sec-t">Quick Actions</div>
        <div class="cc-qa" id="cc-qa">${quickActionsHtml()}</div>
      </div>`;
    ov.classList.add('cc-home-open');

    el('cc-go-ops').addEventListener('click', () => go('/incidents'));
    ov.querySelectorAll('#cc-qa button').forEach((b) => b.addEventListener('click', () => {
      if (b.hasAttribute('disabled')) return;
      go(b.getAttribute('data-route'));
    }));

    startClock();
    loadOrg();
    refreshAll();
    if (_poll) clearInterval(_poll);
    _poll = setInterval(() => { if (el('cc-home-overlay') && el('cc-home-overlay').classList.contains('cc-home-open')) refreshAll(); }, 30000);
  }

  function refreshAll() {
    setConn();
    loadSummary();
    loadFeed();
    loadSparkline();
    loadBriefing();
  }

  function kpiSkeleton() {
    return Array.from({ length: 8 }).map(() => `<div class="cc-kpi"><div class="n">—</div><div class="l">…</div></div>`).join('');
  }

  function quickActionsHtml() {
    const admin = isAdmin();
    const b = (route, glyph, label, adminOnly) =>
      `<button data-route="${route}" ${adminOnly && !admin ? 'disabled aria-disabled="true"' : ''}>
         <span>${glyph}</span> ${esc(label)}${adminOnly ? `<span class="ad">${admin ? '' : 'admin'}</span>` : ''}</button>`;
    return [
      b('/incidents', '🛰', 'Operations Center', false),
      b('/reporting', '🧩', 'Crisis Forms', true),
      b('/org', '🏛', 'Organisation', true),
      b('/users', '👤', 'Account', false),
      b('/users', '👥', 'User Management', true),
      b('/incidents', '⬇', 'Exports', false),
    ].join('');
  }

  // ── data: org branding ──
  async function loadOrg() {
    try {
      const { body } = await jget('/config/');
      const org = body && body.org;
      if (!org) return;
      const nm = el('cc-home-orgname');
      if (nm && org.org_public_name) nm.textContent = org.org_public_name + ' · Crisis Intelligence';
      if (org.org_logo_url) {
        const lg = el('cc-home-logo');
        if (lg) lg.innerHTML = `<img src="${esc(BACKEND_HOST + org.org_logo_url)}" alt="logo">`;
      }
    } catch (_) { /* defaults stand */ }
  }

  // ── data: summary (KPIs, distributions, impact) ──
  let _lastSummary = null;
  async function loadSummary() {
    try {
      const { body } = await jget('/analytics/summary');
      _lastSummary = body;
      renderKpis(body);
      renderAttention(body);
      renderDistributions(body);
      renderEfficiency(body);
      renderImpact(body);
      const st = el('cc-sum-stale');
      if (st) st.textContent = 'updated ' + timeAgo(body.generated_at);
    } catch (e) {
      const st = el('cc-sum-stale');
      if (st) st.textContent = (String(e.message) === '401' || String(e.message) === '403')
        ? 'sign-in required' : 'data unavailable';
    }
  }

  function deltaChip(curr, prev) {
    const d = (curr || 0) - (prev || 0);
    if (!d) return `<div class="cc-chip" style="color:#5C6B85;background:#1d2942">— vs prev 24h</div>`;
    const up = d > 0;
    const col = up ? '#fb923c' : '#34D399';
    const bg = up ? 'rgba(251,146,60,.14)' : 'rgba(52,211,153,.14)';
    return `<div class="cc-chip" style="color:${col};background:${bg}">${up ? '▲' : '▼'} ${Math.abs(d)} vs prev 24h</div>`;
  }

  function renderKpis(b) {
    const c = b.counts || {};
    const d = b.deltas || {};
    const t = b.timings || {};
    const kpi = (n, l, opts) => `<div class="cc-kpi ${opts && opts.crit ? 'crit' : ''}">
      <div class="n cc-num" ${opts && opts.color ? `style="color:${opts.color}"` : ''}>${n}</div>
      <div class="l">${esc(l)}</div>${opts && opts.chip ? opts.chip : ''}</div>`;
    const tiles = [
      kpi(fmtNum(c.active), 'Active incidents'),
      kpi(fmtNum(c.critical), 'Critical', { crit: c.critical > 0, color: c.critical > 0 ? SEV_COLOR.CRITICAL : '' }),
      kpi(fmtNum(c.pending_verification), 'Pending verification'),
      kpi(fmtNum(c.awaiting_triage), 'Awaiting triage'),
      kpi(fmtNum(c.open_dispatch), 'Open dispatch'),
      kpi(fmtNum(c.active_ops), 'Active operations'),
      kpi(fmtNum(d.reports_24h), 'New (24h)', { chip: deltaChip(d.reports_24h, d.reports_prev_24h) }),
      kpi(fmtNum(c.resolved_in_window), 'Resolved (24h)', { color: '#34D399' }),
    ];
    const box = el('cc-kpis');
    if (box) box.innerHTML = tiles.join('');
  }

  function renderAttention(b) {
    const c = b.counts || {};
    const row = (glyph, color, label, n, route) => {
      const zero = !n;
      return `<div class="cc-att-row ${zero ? 'zero' : ''}" data-route="${route}">
        <div class="cc-att-ic" style="background:${color}22;color:${color}">${glyph}</div>
        <div class="lab">${esc(label)}</div>
        <div class="cnt cc-num" ${!zero ? `style="color:${color}"` : ''}>${fmtNum(n)}</div>
        <div class="ar">›</div></div>`;
    };
    const rows = [
      row('🔴', SEV_COLOR.CRITICAL, 'Critical incidents', c.critical, '/incidents'),
      row('⬆', '#fb923c', 'Escalating (risk ≥ 70)', c.escalating, '/incidents'),
      row('🔍', '#418FDE', 'Pending verification', c.pending_verification, '/incidents'),
      row('📋', '#22d3ee', 'Awaiting triage', c.awaiting_triage, '/incidents'),
      row('🚑', '#2DD4BF', 'Dispatched, no arrival', c.open_dispatch, '/incidents'),
      row('⏱', '#a78bfa', 'Stale (open & unreviewed)', c.stale, '/incidents'),
    ];
    const box = el('cc-att');
    if (box) {
      box.innerHTML = rows.join('');
      box.querySelectorAll('.cc-att-row').forEach((r) => r.addEventListener('click', () => go(r.getAttribute('data-route'))));
    }
  }

  function barRows(obj, colorFn, max) {
    const entries = Object.entries(obj || {});
    if (!entries.length) return `<div class="cc-empty">No data</div>`;
    entries.sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, max || 6);
    const peak = Math.max(1, ...top.map((e) => e[1]));
    return top.map(([k, v]) => {
      const col = colorFn ? colorFn(k) : '#418FDE';
      const w = Math.round((v / peak) * 100);
      return `<div class="cc-bar-row"><span class="bl" title="${esc(titleCase(k))}">${esc(titleCase(k))}</span>
        <span class="cc-bar-track"><span class="cc-bar-fill" style="width:${w}%;background:${col}"></span></span>
        <span class="bv cc-num">${fmtNum(v)}</span></div>`;
    }).join('');
  }

  function renderDistributions(b) {
    const dist = b.distributions || {};
    const sevBox = el('cc-dist-sev');
    if (sevBox) {
      // Render severities in canonical order for scannability.
      const ordered = {};
      SEV_ORDER.forEach((s) => { if (dist.by_severity && dist.by_severity[s] != null) ordered[s] = dist.by_severity[s]; });
      Object.keys(dist.by_severity || {}).forEach((k) => { if (ordered[k] == null) ordered[k] = dist.by_severity[k]; });
      sevBox.innerHTML = barRows(ordered, (k) => SEV_COLOR[k] || '#64748b', 5);
    }
    const typeBox = el('cc-dist-type');
    if (typeBox) typeBox.innerHTML = barRows(dist.by_crisis_type, () => '#418FDE', 6);
  }

  function renderEfficiency(b) {
    const t = b.timings || {}, dist = b.distributions || {};
    const ver = dist.verified || 0, unver = dist.unverified || 0;
    const tot = ver + unver;
    const pct = tot ? Math.round((ver / tot) * 100) : 0;
    const box = el('cc-eff');
    if (box) box.innerHTML = `
      <div class="cc-statline"><span>Avg verification time</span><span class="v">${fmtDur(t.avg_verification_seconds)}</span></div>
      <div class="cc-statline"><span>Avg response time</span><span class="v">${fmtDur(t.avg_response_seconds)}</span></div>
      <div class="cc-statline"><span>Verified reports</span><span class="v">${fmtNum(ver)} (${pct}%)</span></div>
      <div class="cc-statline"><span>Unverified / rejected</span><span class="v">${fmtNum(unver)}</span></div>
      <div style="margin-top:10px"><div class="cc-sec-t" style="margin:0 0 4px">Intake · last 24h</div>
        <div class="cc-spark" id="cc-spark"><div class="cc-empty" style="padding:0">—</div></div></div>`;
  }

  function renderImpact(b) {
    const im = b.impact || {};
    const cell = (n, l) => `<div class="b"><div class="n cc-num">${n}</div><div class="l">${esc(l)}</div></div>`;
    const box = el('cc-impact');
    if (box) box.innerHTML = `
      <div class="cc-imp">
        ${cell(fmtNum(im.critical_infrastructure), 'Critical infrastructure hit')}
        ${cell(im.service_disruptions == null ? '—' : fmtNum(im.service_disruptions), 'Service disruptions')}
        ${cell(fmtNum(im.lives_impacted_sum), 'Lives impacted (reported)')}
        ${cell(fmtNum(im.responders_active), 'Responders active')}
      </div>
      <div class="cc-note"><strong>Population exposure &amp; displacement</strong> — not shown.
        CRISP records citizen damage reports, not census/displacement data. These require an external
        data integration (WorldPop/GHSL for population, IOM DTM/UNHCR for displacement) joined by
        geography. Surfacing fabricated figures would mislead operations.</div>`;
  }

  // ── data: 24h intake sparkline ──
  async function loadSparkline() {
    try {
      const { body } = await jget('/analytics/damage-rate-24h');
      const buckets = (body && body.buckets) || [];
      const spark = el('cc-spark');
      if (!spark) return;
      if (!buckets.length) { spark.innerHTML = `<div class="cc-empty" style="padding:0">No intake</div>`; return; }
      const peak = Math.max(1, ...buckets.map((x) => x.report_count || 0));
      spark.innerHTML = buckets.map((x) => {
        const h = Math.round(((x.report_count || 0) / peak) * 100);
        return `<i style="height:${Math.max(3, h)}%" title="${esc(x.bucket_start)}: ${x.report_count}"></i>`;
      }).join('');
    } catch (_) { /* sparkline optional */ }
  }

  // ── data: map + recent activity (one reports fetch) ──
  async function loadFeed() {
    try {
      const { body } = await jget('/reports/?limit=200');
      const reports = Array.isArray(body) ? body : (body && (body.items || body.reports)) || [];
      renderMap(reports);
      renderActivity(reports);
    } catch (_) {
      const a = el('cc-activity'); if (a) a.innerHTML = `<div class="cc-empty">Activity unavailable</div>`;
      mapFallback('Map data unavailable');
    }
  }

  function rLatLng(r) {
    const loc = r.location || r;
    const lat = loc.latitude != null ? loc.latitude : loc.lat;
    const lng = loc.longitude != null ? loc.longitude : loc.lng;
    if (lat == null || lng == null) return null;
    if (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) return null;  // null-island
    return [Number(lat), Number(lng)];
  }

  function mapFallback(msg) {
    const m = el('cc-map');
    if (m) m.outerHTML = `<div class="cc-map-fallback" id="cc-map">${esc(msg)}</div>`;
  }

  function renderMap(reports) {
    const cont = el('cc-map');
    if (!cont) return;
    if (typeof window.L === 'undefined' || !window.L.map) { mapFallback('Map library not loaded'); return; }
    try {
      if (!_map) {
        _map = window.L.map('cc-map', { zoomControl: true, attributionControl: false, worldCopyJump: true })
          .setView([15, 30], 2);
        window.L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 18 }).addTo(_map);
        setTimeout(() => { try { _map.invalidateSize(); } catch (_) {} }, 120);
      }
      if (_cluster) { try { _map.removeLayer(_cluster); } catch (_) {} _cluster = null; }
      const useCluster = window.L.markerClusterGroup;
      _cluster = useCluster ? window.L.markerClusterGroup({ maxClusterRadius: 40, showCoverageOnHover: false }) : window.L.layerGroup();
      const pts = [];
      reports.forEach((r) => {
        const ll = rLatLng(r);
        if (!ll) return;
        pts.push(ll);
        const sev = String(r.severity || 'UNKNOWN').toUpperCase();
        const col = SEV_COLOR[sev] || '#64748b';
        const mk = window.L.circleMarker(ll, { radius: 6, color: col, weight: 1.5, fillColor: col, fillOpacity: .65 });
        const what = [r.crisis_type, r.infrastructure_type].filter(Boolean).map(titleCase).join(' · ') || 'Report';
        mk.bindPopup(`<b>${esc(what)}</b><br>${esc(titleCase(sev))} · ${esc(String(r.status || ''))}<br><small>${esc(timeAgo(r.server_created_at))}</small>`);
        _cluster.addLayer(mk);
      });
      _map.addLayer(_cluster);
      if (pts.length) { try { _map.fitBounds(pts, { padding: [30, 30], maxZoom: 8 }); } catch (_) {} }
    } catch (e) { mapFallback('Map render failed'); }
  }

  const STATUS_COLOR = {
    PENDING: '#fbbf24', RESPONDING: '#2DD4BF', RESOLVED: '#34D399',
    REJECTED: '#6B7280', FALSE_ALARM: '#6B7280', VERIFIED: '#418FDE',
  };
  function verdictLabel(v) {
    const s = String(v || 'NOT_REVIEWED').toUpperCase();
    if (s === 'ACCEPTED') return '<span style="color:#34D399">✓ verified</span>';
    if (s === 'REJECTED') return '<span style="color:#f87171">✗ rejected</span>';
    return '<span style="color:#8A99B5">unreviewed</span>';
  }

  function renderActivity(reports) {
    const box = el('cc-activity');
    if (!box) return;
    if (!reports.length) { box.innerHTML = `<div class="cc-empty">No recent activity</div>`; return; }
    const rows = reports.slice(0, 10).map((r) => {
      const sev = String(r.severity || 'UNKNOWN').toUpperCase();
      const col = SEV_COLOR[sev] || '#64748b';
      const status = String(r.status || '').toUpperCase();
      const sc = STATUS_COLOR[status] || '#6B7280';
      const place = (r.location && (r.location.user_location_name || r.location.device_location_name)) || '—';
      const what = [r.crisis_type, r.infrastructure_type].filter(Boolean).map(titleCase).join(' · ') || 'Report';
      return `<tr data-id="${esc(r.id || '')}">
        <td title="${esc(what)}">${esc(what)}</td>
        <td title="${esc(place)}">${esc(place)}</td>
        <td><span class="cc-badge" style="background:${col}22;color:${col}">${esc(titleCase(sev))}</span></td>
        <td>${verdictLabel(r.reviewer_verdict)}</td>
        <td><span class="cc-badge" style="background:${sc}22;color:${sc}">${esc(titleCase(status))}</span></td>
        <td style="color:#8A99B5">${esc(timeAgo(r.server_created_at))}</td></tr>`;
    }).join('');
    box.innerHTML = `<table class="cc-tbl"><thead><tr>
      <th>Type</th><th>Location</th><th>Severity</th><th>Verification</th><th>Status</th><th>Updated</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
    box.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => go('/incidents')));
  }

  // ── data: rule-based situation briefing (real aggregates, no LLM) ──
  async function loadBriefing() {
    const box = el('cc-brief');
    if (!box) return;
    const cards = [];
    const s = _lastSummary;
    // Emerging hotspot — from the live nearby aggregator (burst/acute tiers).
    try {
      const { body } = await jget('/reports/nearby');
      const groups = (body && (body.groups || body.items)) || (Array.isArray(body) ? body : []);
      const acute = groups.filter((g) => g.is_acute || g.is_burst)
        .sort((a, b) => (b.report_count || 0) - (a.report_count || 0));
      if (acute.length) {
        const g = acute[0];
        cards.push({ cls: 'crit', h: 'Emerging hotspot',
          d: `${fmtNum(g.report_count)} reports clustering${g.label ? ' near ' + esc(g.label) : ''}${g.is_acute ? ' (acute)' : ' (burst)'}. ${acute.length} active cluster${acute.length > 1 ? 's' : ''}.`,
          s: 'source: /reports/nearby' });
      }
    } catch (_) { /* nearby optional */ }
    if (s && s.counts) {
      const c = s.counts, t = s.timings || {};
      if (c.pending_verification > 0) cards.push({ cls: 'warn', h: 'Verification backlog',
        d: `${fmtNum(c.pending_verification)} report(s) awaiting human review; ${fmtNum(c.awaiting_triage)} still in triage.`,
        s: 'source: /analytics/summary' });
      if (c.escalating > 0) cards.push({ cls: 'crit', h: 'Escalating incidents',
        d: `${fmtNum(c.escalating)} incident(s) at high escalation risk (score ≥ 70). Prioritize review.`,
        s: 'source: building escalation_risk' });
      if (t.avg_response_seconds != null) cards.push({ cls: '', h: 'Response performance',
        d: `Average response time is ${fmtDur(t.avg_response_seconds)} (dispatch→arrival from reviewed reports).`,
        s: 'source: /analytics/summary' });
      const d = s.deltas || {};
      if ((d.reports_24h || 0) > (d.reports_prev_24h || 0)) cards.push({ cls: 'warn', h: 'Intake rising',
        d: `${fmtNum(d.reports_24h)} new reports in 24h vs ${fmtNum(d.reports_prev_24h)} the prior day — incident inflow is increasing.`,
        s: 'source: /analytics/summary deltas' });
    }
    if (!cards.length) { box.innerHTML = `<div class="cc-empty">No notable operational patterns in the current window.</div>`; return; }
    const stamp = s && s.generated_at ? ' · ' + timeAgo(s.generated_at) : '';
    box.innerHTML = cards.slice(0, 5).map((c) => `<div class="cc-brief ${c.cls}">
      <div class="h">${c.h}</div><div class="d">${c.d}</div><div class="s">${c.s}${stamp}</div></div>`).join('');
  }

  // ── header live bits ──
  function setConn() {
    const dot = el('cc-conn'), t = el('cc-conn-t');
    const on = navigator.onLine;
    if (dot) dot.style.background = on ? '#34D399' : '#f87171';
    if (t) t.textContent = on ? 'Live' : 'Offline';
  }
  function startClock() {
    const tick = () => {
      const c = el('cc-clock');
      if (!c) return;
      const d = new Date();
      const utc = d.toISOString().slice(11, 16);
      c.textContent = `${utc} UTC · ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    };
    tick();
    if (window.__ccClock) clearInterval(window.__ccClock);
    window.__ccClock = setInterval(tick, 30000);
  }

  // ── launcher (user-menu item) + boot ──
  function injectLauncher() {
    try {
      const dropdown = el('user-menu-dropdown');
      if (!dropdown || el('cc-home-launch')) return;
      const btn = document.createElement('button');
      btn.id = 'cc-home-launch'; btn.className = 'user-menu-item';
      btn.innerHTML = `<i class="fa-solid fa-grip"></i> Crisis Intelligence`;
      btn.addEventListener('click', () => {
        try { dropdown.classList.remove('open'); dropdown.style.display = ''; } catch (_) {}
        try { (window.__crispRouter ? window.__crispRouter.navigate('/') : openLanding()); } catch (_e) { openLanding(); }
      });
      dropdown.insertBefore(btn, dropdown.firstChild);
    } catch (_e) { /* never break the dashboard */ }
  }

  function boot() {
    injectStyles();
    injectLauncher();
    let tries = 0;
    const iv = setInterval(() => { injectLauncher(); if (el('cc-home-launch') || ++tries > 20) clearInterval(iv); }, 400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // public API (reachable from the menu + tests + router)
  window.openControlCenter = openLanding;
  window.__ccHome = { openLanding, closeLanding };
})();
