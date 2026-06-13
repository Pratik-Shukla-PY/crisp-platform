/* cc-operations.js — Operations workspace (CRISP dashboard, Phase 2d).
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
  const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString());
  function timeAgo(s) {
    if (!s) return '—';
    const norm = (window.__ccEnsureUTC || ((x) => x))(s);
    const t = new Date(norm).getTime();
    if (isNaN(t)) return '—';
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

  function go(hash) { try { window.location.hash = hash; } catch (_e) {} }
  function navTo(route) {
    try { if (window.__crispRouter) { window.__crispRouter.navigate(route); return; } } catch (_e) {}
    go('#' + route);
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
  const STATUS_STYLE = {
    LIVE: ['LIVE', '#34D399'], DRAFT: ['DRAFT', '#9fb3d1'],
    PAUSED: ['PAUSED', '#fbbf24'], ENDED: ['ENDED', '#7d89a3'],
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
      .opc{display:flex;align-items:center;gap:13px;padding:12px 14px;background:#101a2e;
        border:1px solid #233149;border-radius:12px;cursor:pointer;transition:border-color .12s,background .12s}
      .opc:hover{border-color:#418FDE;background:#13203a}
      .opc:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
      .opc-mm{width:58px;height:58px;flex:0 0 auto;display:block}
      .opc-mm-alert{width:58px;height:58px;flex:0 0 auto;display:grid;place-items:center;font-size:24px;
        border-radius:9px;background:#1b1113;border:1px solid #7f1d1d}
      .opc-main{flex:1;min-width:0}
      .opc-hd{display:flex;align-items:center;gap:8px;min-width:0}
      .opc-ic{font-size:15px;flex:0 0 auto}
      .opc-name{font-size:14.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
      .opc-badge{font-size:9.5px;font-weight:800;letter-spacing:.05em;padding:1px 7px;border-radius:999px;
        border:1px solid #33476a;background:rgba(255,255,255,.03);flex:0 0 auto}
      .opc-health{width:10px;height:10px;border-radius:50%;flex:0 0 auto;margin-left:auto;
        box-shadow:0 0 0 3px rgba(255,255,255,.05)}
      .opc-meta{font-size:11.5px;color:#8aa0bf;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .opc-stats{display:flex;flex-wrap:wrap;gap:13px;margin-top:7px}
      .opc-st{font-size:11px;color:#8aa0bf;font-variant-numeric:tabular-nums}
      .opc-st b{font-size:13.5px;font-weight:800;color:#dce6f5;margin-right:3px}
      .opc-st.crit b{color:#f87171}
      .opc-ar{color:#5b6b86;font-size:18px;flex:0 0 auto}
      .opc-cluster{border-style:dashed;border-color:#7f1d1d;background:#1b1113}
      .opc-cluster:hover{border-color:#f87171;background:#241416}
      .opc-cluster .opc-name{color:#fca5a5}
      `;
      const st = document.createElement('style');
      st.id = 'crisp-opcard-styles';
      st.textContent = css;
      document.head.appendChild(st);
    },
    typeIcon(o) { return TYPE_ICON[String(o && o.crisis_type || '').toUpperCase()] || '⚠'; },
    statusBadge(o) {
      const s = String(o && o.status || '').toUpperCase();
      const sty = STATUS_STYLE[s] || [s || '—', '#9fb3d1'];
      const inactive = (s === 'LIVE' && o && o.is_active === false) ? ' title="inactive"' : '';
      return `<span class="opc-badge" style="color:${sty[1]};border-color:${sty[1]}66"${inactive}>${esc(sty[0])}</span>`;
    },
    // Inline-SVG schematic: centre dot + radius ring (sized by radius_km), in the
    // crisis-type colour, over a faint graticule. Honest + cheap; the human "where"
    // is the place_name line. No tiles, no Leaflet — safe at 100 cards.
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
      const dates = (st || en) ? ('Started ' + (st || '—') + (en ? ' · Ended ' + en : ' · Open')) : '';
      return [form, place ? '📍 ' + place : '', dates].filter(Boolean).join('  ·  ');
    },
    card(o) {
      if (o.is_cluster) {
        return `<div class="opc opc-cluster" data-cluster="1" role="link" tabindex="0"
            aria-label="Launch an operation for ${fmtNum(o.critical)} unassigned critical reports">
          <div class="opc-mm-alert">🚨</div>
          <div class="opc-main">
            <div class="opc-hd"><span class="opc-name">${fmtNum(o.critical)} critical reports, no operation</span></div>
            <div class="opc-meta">Launch an operation here to coordinate response →</div>
            <div class="opc-stats"><span class="opc-st crit"><b>${fmtNum(o.critical)}</b> Critical</span></div>
          </div>
          <div class="opc-ar">›</div></div>`;
      }
      const hc = healthColor(o);
      return `<div class="opc" data-op="${esc(o.id)}" role="link" tabindex="0" aria-label="${esc(o.name)} — open operation">
        ${this.miniMap(o)}
        <div class="opc-main">
          <div class="opc-hd">
            <span class="opc-ic">${this.typeIcon(o)}</span>
            <span class="opc-name">${esc(o.name)}</span>
            ${this.statusBadge(o)}
            <span class="opc-health" style="background:${hc}" title="${esc(o.health_reason || o.health || '')}"></span>
          </div>
          <div class="opc-meta">${this._placeLine(o) || '—'}</div>
          <div class="opc-stats">
            <span class="opc-st crit"><b>${fmtNum(o.critical)}</b> Critical</span>
            <span class="opc-st"><b>${fmtNum(o.new_24h)}</b> New 24h</span>
            <span class="opc-st"><b>${fmtNum(o.total)}</b> Total</span>
            <span class="opc-st"><b>${fmtNum(o.verified)}</b> Verified</span>
            <span class="opc-st"><b>${fmtNum(o.responders_active)}</b> Responders</span>
          </div>
        </div>
        <div class="opc-ar">›</div></div>`;
    },
    // Render + wire a whole list/rail into `host`. Shared by both surfaces.
    renderInto(host, ops, opts) {
      if (!host) return;
      this._injectCss();
      const sorted = (ops || []).slice().sort(worstFirst);
      if (!sorted.length) {
        host.innerHTML = `<div class="cco-empty">${esc((opts && opts.empty) || 'No operations yet. Active crisis events appear here.')}</div>`;
        return;
      }
      host.innerHTML = sorted.map((o) => this.card(o)).join('');
      host.querySelectorAll('[data-op]').forEach((row) => {
        const open = () => go('#/operations/' + encodeURIComponent(row.getAttribute('data-op')));
        row.addEventListener('click', open);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      });
      host.querySelectorAll('[data-cluster]').forEach((row) => {
        const launch = () => { try { (window.launchOperationFromCluster || function () {})(); } catch (_e) {} };
        row.addEventListener('click', launch);
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); launch(); } });
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
    /* detail — banner */
    .cco-banner{display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:12px;margin-bottom:14px;
      border:1px solid #233149;background:#101a2e;border-left:5px solid var(--op-accent,#418FDE)}
    .cco-bc{font-size:11.5px;color:#8aa0bf}
    .cco-bc b{color:#E6EDF7;font-weight:700}
    .cco-exit{margin-left:auto;background:#1b2942;border:1px solid #33476a;border-radius:999px;
      padding:6px 14px;color:#cdd8ec;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
    .cco-exit:hover{border-color:#418FDE;color:#fff}
    .cco-status{font-size:11px;font-weight:700;padding:2px 9px;border-radius:999px;background:#1b2942;color:#9fb3d1}
    .cco-health{width:11px;height:11px;border-radius:50%;flex:none;box-shadow:0 0 0 3px rgba(255,255,255,.06)}
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
    /* detail grid: map | worklist */
    .cco-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media(max-width:1000px){.cco-grid{grid-template-columns:1fr}.cco-vitals{grid-template-columns:repeat(2,1fr)}}
    #cco-map{height:360px;border-radius:10px;overflow:hidden;background:#0d1422;isolation:isolate}
    .cco-wl{max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px}
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
    .cco-empty{padding:26px;text-align:center;color:#8aa0bf;font-size:13px}
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

  // ── LIST view ──────────────────────────────────────────────────────────────
  async function renderList() {
    const wrap = el('cco-wrap');
    if (!wrap) return;
    wrap.innerHTML = '<h1 class="cco-h">Active Operations</h1>'
      + '<p class="cco-sub">Every operation, worst-first. Select one to open its worklist.</p>'
      + '<div class="cco-list" id="cco-list"><div class="cco-empty">Loading operations…</div></div>';
    let ops = [];
    try { ops = await jget('/operations'); } catch (_e) {
      el('cco-list').innerHTML = '<div class="cco-empty">Could not load operations.</div>';
      return;
    }
    renderRows(el('cco-list'), ops);
  }

  // Thin wrapper over the shared card (CrispOpCard) — the list + the home rail
  // render the SAME card now (was a separate, drifted implementation).
  function renderRows(host, ops) {
    CrispOpCard.renderInto(host, ops, { empty: 'No operations yet. Active crisis events appear here.' });
  }

  // ── DETAIL view ──────────────────────────────────────────────────────────────
  async function renderDetail(id) {
    const wrap = el('cco-wrap');
    if (!wrap) return;
    wrap.innerHTML = '<div class="cco-empty">Loading operation…</div>';

    let ops = [], summary = null, reports = [];
    try {
      [ops, summary, reports] = await Promise.all([
        jget('/operations').catch(() => []),
        jget('/analytics/summary?crisis_event_id=' + encodeURIComponent(id)).catch(() => null),
        jget('/reports/?limit=200&crisis_event_id=' + encodeURIComponent(id)).catch(() => []),
      ]);
    } catch (_e) { /* fall through to whatever resolved */ }

    const op = (ops || []).find((o) => o.id === id) || { id, name: 'Operation', crisis_type: null };
    const accent = opColor(op);
    const c = (summary && summary.counts) || {};
    // 2e — drive the shell's operation context (colored chrome + banner).
    try { window.__crispShell && window.__crispShell.setOpContext &&
          window.__crispShell.setOpContext(id, op.name, accent); } catch (_e) {}

    const vitals = [
      { n: c.critical, l: 'Critical', q: 'critical', crit: true },
      { n: c.needs_review, l: 'Needs review', q: 'needs-review' },
      { n: c.needs_response, l: 'Needs response', q: 'needs-response' },
      { n: c.active_operations, l: 'In response', q: 'active-ops' },
    ];

    wrap.innerHTML = `
      <div class="cco-banner" style="--op-accent:${accent}">
        <span class="cco-health" style="background:${healthColor(op)}" title="${esc(op.health_reason || op.health || '')}"></span>
        <div class="cco-bc">CRISP / Operations / <b>${esc(op.name)}</b></div>
        <span class="cco-status">${esc(op.status || (op.is_active ? 'ACTIVE' : '—'))}</span>
        <span class="cco-resp">🚑 ${fmtNum(op.responders_active || 0)} responder${(op.responders_active || 0) === 1 ? '' : 's'}</span>
        <button class="cco-exit" id="cco-exit">← Exit to global</button>
      </div>
      <div class="cco-vitals" id="cco-vitals">
        ${vitals.map((v) => `<div class="cco-vital ${v.crit ? 'crit' : ''}" data-q="${v.q}">
            <div class="n cco-num">${fmtNum(v.n)}</div><div class="l">${esc(v.l)}</div></div>`).join('')}
      </div>
      <div class="cco-grid">
        <div>
          <div class="cco-sec-t">Operation map</div>
          <div class="cco-card" style="padding:8px"><div id="cco-map"></div></div>
        </div>
        <div>
          <div class="cco-sec-t">Critical worklist</div>
          <div class="cco-wl" id="cco-wl"></div>
        </div>
      </div>
      <div class="cco-actions">
        <button class="cco-btn primary" id="cco-act-feed">Open full incident feed</button>
        <button class="cco-btn" id="cco-act-export">Export</button>
        <button class="cco-btn" id="cco-act-forms">Deploy form pack</button>
        <button class="cco-btn cco-undo" id="cco-act-undo" title="Reverse the most recent cluster claim on this operation">↩ Undo claim</button>
      </div>`;

    const exit = () => navTo('/');
    el('cco-exit').addEventListener('click', exit);
    el('cco-vitals').querySelectorAll('[data-q]').forEach((v) => {
      v.addEventListener('click', () => go('#/incidents;queue=' + v.getAttribute('data-q')));
    });
    el('cco-act-feed').addEventListener('click', () => go('#/incidents'));
    el('cco-act-export').addEventListener('click', () => navTo('/exports'));
    el('cco-act-forms').addEventListener('click', () => navTo('/reporting'));
    el('cco-act-undo').addEventListener('click', () => { (window.unclaimOperation || function () {})(id); });

    renderWorklist(reports);
    renderOpMap(reports);
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
      const open = () => { try { (window.openIncident || function () {})(row.getAttribute('data-id')); } catch (_e) {} };
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
          .on('click', () => { try { (window.openIncident || function () {})(r.id); } catch (_e) {} })
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
  window.__ccOperations = { openOperations, closeOverlay };
})();
