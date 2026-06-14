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
    // Route through app.js's ensureUTC so a naive backend ISO string can't
    // be parsed as local time and shift the "ago" math by the UTC offset.
    const norm = (window.__ccEnsureUTC || ((x) => x))(s);
    const t = new Date(norm).getTime();
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
  let _map = null, _cluster = null, _poll = null, _mapRO = null;

  // ── styles ───────────────────────────────────────────────────────────────
  function injectStyles() {
    if (el('cc-home-styles')) return;
    const css = `
    #cc-home-overlay{position:fixed;inset:0;z-index:99990;display:none;overflow:auto;
      background:radial-gradient(1100px 560px at 78% -12%,rgba(65,143,222,.12),transparent 60%),
        radial-gradient(820px 460px at -5% 108%,rgba(34,211,238,.07),transparent 55%),#0B1220;
      color:#E6EDF7;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    #cc-home-overlay.cc-home-open{display:block}
    .cc-wrap{max-width:1480px;margin:0 auto;padding:0 22px 40px;min-height:100%}
    .cc-num{font-variant-numeric:tabular-nums}
    /* visually-hidden region heading (a11y; the visible identity is in the shell) */
    .cc-vh{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
    /* sticky header block — identity row + primary nav stay pinned while the
       page scrolls. z-index must clear Leaflet's internal panes/controls
       (up to ~1000); the map card is additionally isolated below. Negative
       margins bleed the bar to the wrap edges so content scrolls under a
       full-width surface, not a floating strip. */
    .cc-stick{position:sticky;top:0;z-index:1200;margin:0 -22px 16px;padding:14px 22px 0;
      background:rgba(11,18,32,.88);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
      border-bottom:1px solid rgba(255,255,255,.07)}
    /* primary nav (command bar) */
    .cc-nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 0 12px}
    .cc-nav button{display:inline-flex;align-items:center;gap:7px;background:#141F35;border:1px solid #2C3A52;
      border-radius:999px;padding:6px 13px;color:#cdd8ec;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
    .cc-nav button:hover{border-color:#418FDE;color:#fff}
    .cc-nav button:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
    .cc-nav button[disabled]{opacity:.45;cursor:not-allowed}
    .cc-nav button.on{border-color:#418FDE;color:#7db8ef;background:rgba(65,143,222,.10)}
    .cc-nav .ad{font-size:9px;font-weight:700;color:#fbbf24;background:rgba(251,191,36,.12);
      padding:1px 6px;border-radius:999px;margin-left:2px;text-transform:uppercase}
    /* header */
    .cc-hd{display:flex;align-items:center;gap:13px}
    .cc-logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#418FDE,#22d3ee);
      display:grid;place-items:center;font-weight:800;color:#fff;flex:none;overflow:hidden}
    .cc-logo img{width:100%;height:100%;object-fit:contain}
    .cc-hd .ti{font-weight:800;font-size:17px;letter-spacing:-.01em;margin:0;line-height:1.2}
    .cc-hd .su{font-size:11.5px;color:#8A99B5}
    .cc-hd .sp{margin-left:auto;display:flex;align-items:center;gap:14px}
    .cc-live{display:flex;align-items:center;gap:7px;font-size:12px;color:#8A99B5}
    .cc-dot{width:8px;height:8px;border-radius:50%}
    .cc-avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#418FDE,#22d3ee);
      color:#fff;display:grid;place-items:center;font-weight:700;font-size:13px;flex:none}
    .cc-btn{border:1px solid #2C3A52;background:#1A2740;color:#cdd8ec;border-radius:8px;padding:7px 13px;
      font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}
    .cc-btn:hover{border-color:#418FDE;color:#fff}
    .cc-btn-pri{background:#418FDE;border-color:#418FDE;color:#fff}
    /* section + cards */
    .cc-sec-t{font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:#8A99B5;margin:22px 2px 10px;display:flex;align-items:center;gap:8px}
    .cc-card{background:#121A2A;border:1px solid #243149;border-radius:12px;padding:15px}
    /* ── two-zone bands: RESPONSE (operations) over MONITORING (global) ──
       Each zone gets a band header; a faint rule + extra top-margin separates
       "what I'm running" from "what I'm monitoring" (ICS COP vs IAP). */
    .cc-zone-monitor{margin-top:26px;padding-top:6px;border-top:1px solid rgba(255,255,255,.06)}
    .cc-band{font-size:13px;color:#E6EDF7;letter-spacing:.04em;margin:18px 2px 12px}
    .cc-band .cc-band-sub{font-size:11px;font-weight:600;color:#7d89a3;text-transform:none;letter-spacing:0}
    /* Active-operations rail is now the full-width primary RESPONSE surface;
       the global map drops below into the MONITORING zone (was a side-by-side
       grid that conflated the two). */
    /* active-operations rail */
    #cc-ops-rail{display:flex;flex-direction:column;gap:8px;max-height:540px;overflow-y:auto}
    .cc-op-row{display:flex;align-items:center;gap:11px;padding:11px 13px;background:#121A2A;border:1px solid #243149;border-radius:11px;cursor:pointer}
    .cc-op-row:hover{border-color:#418FDE;background:#16213a}
    .cc-op-row:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
    .cc-op-dot{width:11px;height:11px;border-radius:50%;flex:none;box-shadow:0 0 0 3px rgba(255,255,255,.05)}
    .cc-op-body{flex:1;min-width:0}
    .cc-op-name{font-size:13.5px;font-weight:700;color:#E6EDF7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cc-op-meta{font-size:11px;color:#8A99B5;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cc-op-counts{display:flex;gap:10px;flex:none;text-align:center}
    .cc-op-counts .c{display:flex;flex-direction:column;line-height:1.1}
    .cc-op-counts .c b{font-size:15px;font-weight:800;font-variant-numeric:tabular-nums}
    .cc-op-counts .c span{font-size:9px;letter-spacing:.04em;text-transform:uppercase;color:#8A99B5}
    .cc-op-counts .crit b{color:#f87171}
    .cc-op-row.cluster{border-style:dashed;border-color:#7f1d1d;background:#1b1113}
    .cc-op-row.cluster:hover{border-color:#f87171;background:#241416}
    .cc-op-row.cluster .cc-op-name{color:#fca5a5}
    .cc-op-ar{color:#5C6B85;font-size:15px;flex:none}
    /* isolation contains Leaflet's internal z-indexes (panes 200-700,
       controls 1000) inside the card so they can never paint over the
       sticky nav while scrolling. */
    #cc-map{height:430px;border-radius:10px;overflow:hidden;background:#0d1422;isolation:isolate}
    .cc-map-fallback{height:430px;display:grid;place-items:center;color:#8A99B5;font-size:13px}
    .cc-geo{font-size:11.5px;color:#8A99B5;padding:8px 6px 2px}
    .cc-geo strong{color:#cdd8ec;font-variant-numeric:tabular-nums}
    /* Geo caption OVERLAYS the map's bottom instead of adding column height —
       keeps the map card the same height as #cc-att (height-mismatch fix). */
    #cc-map-card{position:relative}
    #cc-map-card #cc-map-geo{position:absolute;left:16px;right:16px;bottom:16px;z-index:500;margin:0;
      padding:5px 10px;background:rgba(11,18,32,.82);border:1px solid rgba(255,255,255,.08);border-radius:8px;
      backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);pointer-events:none}
    #cc-map-card #cc-map-geo:empty{display:none}
    /* attention — 5 action rows, height-matched to the map card (#cc-map=430px),
       no scroll. On narrow widths the body stacks single-column and rows take
       their natural height. */
    /* 448 = the map card's border-box: #cc-map(430) + 8+8 padding + 1+1 border.
       Matching it makes the two cards align exactly (height-mismatch fix). */
    /* Demoted to a full-width "Global Attention" block — responsive grid of the
       5 action rows (no longer height-matched to the map, which moved columns). */
    #cc-att{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px}
    .cc-att-row{flex:1;min-height:56px;display:flex;align-items:center;gap:11px;padding:0 13px;cursor:pointer;
      background:#121A2A;border:1px solid #243149;border-radius:11px}
    .cc-att-row:hover{border-color:#418FDE;background:#16213a}
    .cc-att-row:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
    .cc-att-ic{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;font-size:15px;flex:none}
    .cc-att-row .lab{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.2}
    .cc-att-row .lab .l1{font-size:14px;font-weight:600;color:#E6EDF7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cc-att-row .lab .l2{font-size:11.5px;color:#8A99B5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cc-att-row .cnt-wrap{flex:none;text-align:right;display:flex;flex-direction:column;line-height:1.1;min-width:48px}
    .cc-att-row .cnt{font-size:21px;font-weight:800;font-variant-numeric:tabular-nums}
    .cc-att-row .cnt.ok{color:#34D399;font-size:19px}
    .cc-att-row .cnt2{font-size:10.5px;color:#7d89a3;margin-top:1px}
    .cc-att-row .ar{color:#5C6B85;font-size:15px;flex:none}
    /* ops intel grid */
    .cc-grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
    @media(max-width:980px){.cc-grid3{grid-template-columns:1fr}}
    .cc-bar-row{display:flex;align-items:center;gap:8px;margin:7px 0;font-size:12px}
    .cc-bar-row .bl{width:78px;color:#aab4c5;flex:none;text-transform:capitalize;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cc-bar-track{flex:1;height:8px;background:#1d2942;border-radius:6px;overflow:hidden}
    .cc-bar-fill{display:block;height:100%;border-radius:6px}
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
    .cc-empty{color:#5C6B85;font-size:12.5px;padding:14px 4px;text-align:center}
    .cc-stale{font-size:10.5px;color:#7d89a3;margin-left:6px}
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
      if (!ov.classList.contains('cc-home-open')) return;
      if (e.key === 'Escape') {
        if (window.__crispRouter) window.__crispRouter.navigate('/incidents'); else closeLanding();
        return;
      }
      if (e.key === 'Tab') trapTab(e, ov);
    });
    return ov;
  }
  function closeLanding() {
    const ov = el('cc-home-overlay');
    if (ov) ov.classList.remove('cc-home-open');
    if (_poll) { clearInterval(_poll); _poll = null; }
  }
  // Focus-trap: keep Tab/Shift+Tab within the open overlay (a11y, WCAG 2.4.3).
  function trapTab(e, ov) {
    const sel = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const nodes = Array.from(ov.querySelectorAll(sel)).filter((n) => n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1], a = document.activeElement;
    if (e.shiftKey) { if (a === first || !ov.contains(a)) { e.preventDefault(); last.focus(); } }
    else if (a === last || !ov.contains(a)) { e.preventDefault(); first.focus(); }
  }

  const go = (r) => { try { if (window.__crispRouter) window.__crispRouter.navigate(r); } catch (_e) {} };

  // ── layout ───────────────────────────────────────────────────────────────
  async function openLanding() {
    if (!token()) return;
    ensureOverlay();
    const ov = el('cc-home-overlay');
    // Identity, live status, profile and the primary nav now live in the
    // global Command Center shell (crisp-shell.js / #crisp-globalnav), shown on
    // every surface. The landing keeps only its situational sub-header (org
    // name + a local clock); the shell sits pinned above it.
    ov.innerHTML = `
      <div class="cc-wrap">
        <!-- Identity (org name) + clock + live + profile all live in the global
             Command Center shell (crisp-shell.js) now — there is no separate
             situational banner here (it used to float over the KPI cards). This
             visually-hidden heading is the labelled region's H1 for a11y. -->
        <h1 id="cc-home-heading" class="cc-vh">Crisis Intelligence Center</h1>

        <!-- TWO-ZONE Global Command Center (ICS COP vs IAP):
             ZONE A — ACTIVE RESPONSE: the operations you are RUNNING (the single
               authoritative active-operations surface; no longer a count echoed
               on the map badge + the attention row).
             ZONE B — GLOBAL MONITORING: everything happening worldwide.
             The old side-by-side ops|map row (which conflated the two) is split:
             the rail is full-width in Zone A, the map drops full-width into Zone B. -->
        <div class="cc-zone cc-zone-response">
          <div class="cc-sec-t cc-band">⚡ Active Response <span class="cc-band-sub">— operations you are running</span> <span class="cc-stale" id="cc-sum-stale"></span></div>
          <div id="cc-ops-rail"><div class="cc-empty">Loading operations…</div></div>
        </div>

        <div class="cc-zone cc-zone-monitor">
          <div class="cc-sec-t cc-band">🌐 Global Monitoring <span class="cc-band-sub">— all incidents worldwide</span></div>
          <div class="cc-card" id="cc-map-card" style="padding:8px">
            <div id="cc-map"></div><div id="cc-map-geo" class="cc-geo"></div>
          </div>

          <div class="cc-sec-t">Global Attention</div>
          <div class="cc-card" id="cc-att" style="padding:8px"><div class="cc-empty">Loading…</div></div>

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
        </div>
      </div>`;
    ov.classList.add('cc-home-open');

    // Org branding + clock are rendered by the shell (crisp-shell.js) now.
    refreshAll();
    if (_poll) clearInterval(_poll);
    _poll = setInterval(() => { if (el('cc-home-overlay') && el('cc-home-overlay').classList.contains('cc-home-open')) refreshAll(); }, 30000);
  }

  function refreshAll() {
    loadSummary();
    loadOperations();
    loadFeed();
    loadSparkline();
    loadBriefing();
  }

  // ── data: summary (KPIs, distributions, impact) ──
  let _lastSummary = null;
  async function loadSummary() {
    try {
      const { body } = await jget('/analytics/summary');
      _lastSummary = body;
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

  // Jun 2026 — action-based Command Center model. FIVE cards, not seven:
  //   • two SITUATIONAL alarms that count their real entity (critical
  //     incidents, escalating hotspots) with the underlying report tally as a
  //     secondary, and
  //   • a three-stage MUTUALLY-EXCLUSIVE pipeline (Needs review → Needs
  //     response → Active operations) where every open report sits in exactly
  //     one stage.
  // Each row still deep-links to its own filtered queue ('#/incidents;queue=…'
  // — see QUEUES in app.js). Counts fall back to legacy fields so the cards
  // still render if a stale backend hasn't shipped the new ones yet.
  function renderAttention(b) {
    const c = b.counts || {};
    const num = (v) => (v == null ? 0 : Number(v));
    // (glyph, color, label, sublabel, primaryCount, secondaryHTML, queueKey)
    const row = (glyph, color, label, sub, n, secondary, queue) => {
      const zero = !n;
      return `<div class="cc-att-row ${zero ? 'zero' : ''}" data-queue="${queue}" role="link" tabindex="0"
        aria-label="${esc(label)} — ${zero ? 'all clear' : fmtNum(n) + ', open queue'}">
        <div class="cc-att-ic" style="background:${color}22;color:${color}">${glyph}</div>
        <div class="lab"><span class="l1">${esc(label)}</span><span class="l2">${esc(sub)}</span></div>
        <div class="cnt-wrap">
          ${zero
            ? `<span class="cnt ok">✓</span><span class="cnt2" style="color:#34D399">all clear</span>`
            : `<span class="cnt cc-num" style="color:${color}">${fmtNum(n)}</span>${secondary ? `<span class="cnt2">${secondary}</span>` : ''}`}
        </div>
        <div class="ar">›</div></div>`;
    };
    const overdue = num(c.sla_at_risk);
    const rows = [
      row('🔴', SEV_COLOR.CRITICAL, 'Critical incidents', 'Command attention',
          num(c.critical_incidents != null ? c.critical_incidents : c.critical),
          `${fmtNum(num(c.critical))} reports`, 'critical'),
      row('🔍', '#418FDE', 'Needs review', 'Triage & verdict',
          num(c.needs_review != null ? c.needs_review : c.awaiting_triage),
          overdue ? `<span style="color:#f87171">${fmtNum(overdue)} overdue</span>` : '', 'needs-review'),
      row('⬆', '#fb923c', 'Escalating hotspots', 'Developing fast',
          num(c.escalating),
          c.escalating_reports != null ? `${fmtNum(num(c.escalating_reports))} reports` : '', 'escalating'),
      row('🚑', '#2DD4BF', 'Needs response', 'Confirmed · dispatch',
          num(c.needs_response), '', 'needs-response'),
      // Terminal pipeline stage = REPORTS currently being responded to (dispatched
      // / RESPONDING). Labeled "In response" — NOT "Active operations", which is a
      // CrisisEvent count and lives solely on the Active Operations rail above. The
      // old label made one number (the rail) look like a different number (this
      // report count) and read as a contradiction.
      row('🚁', '#a78bfa', 'In response', 'Dispatched · on-scene',
          num(c.active_operations != null ? c.active_operations : c.active_ops), '', 'active-ops'),
    ];
    const box = el('cc-att');
    if (box) {
      box.innerHTML = rows.join('');
      const openQueue = (r) => { window.location.hash = '#/incidents;queue=' + r.getAttribute('data-queue'); };
      box.querySelectorAll('.cc-att-row').forEach((r) => {
        r.addEventListener('click', () => openQueue(r));
        r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openQueue(r); } });
      });
    }
  }

  // ── operations rail (Phase 2 — operations-first home) ──────────────────────
  async function loadOperations() {
    try {
      const { body } = await jget('/operations');
      renderOpsRail(body);
    } catch (_e) {
      const box = el('cc-ops-rail');
      if (box) box.innerHTML = `<div class="cc-empty">Could not load operations.</div>`;
    }
  }

  // Backend-authoritative health (Phase 3): the /operations payload carries
  // health = RED | AMBER | GREEN + a health_reason "why". No client heuristic.
  const _OP_HEALTH = { RED: '#f87171', AMBER: '#fbbf24', GREEN: '#34D399' };
  const _opWorst = (a, b) => (b.critical || 0) - (a.critical || 0)
    || (b.new_24h || 0) - (a.new_24h || 0) || (b.total || 0) - (a.total || 0);

  function renderOpsRail(ops) {
    const box = el('cc-ops-rail');
    if (!box) return;
    // Shared card (cc-operations.js CrispOpCard) — the rail + the /operations list
    // render the SAME card. Fallback to a minimal inline row if that module hasn't
    // loaded (defensive; both ship in index.html).
    if (window.CrispOpCard && typeof window.CrispOpCard.renderInto === 'function') {
      // Active Response zone: Start-New card first, LIVE ops, then a collapsed
      // ENDED group. No "LIVE OPERATIONS" sub-header — the zone band already
      // reads "⚡ Active Response".
      window.CrispOpCard.renderInto(box, ops, {
        empty: 'No active operations. Start one to coordinate a response.',
        grouped: true, liveHeader: false, startNew: true,
      });
      return;
    }
    const sorted = (ops || []).slice().sort(_opWorst);
    if (!sorted.length) {
      box.innerHTML = `<div class="cc-empty">No active operations. Active crisis events appear here.</div>`;
      return;
    }
    box.innerHTML = sorted.map((o) => {
      const hc = o.is_cluster ? '#f87171' : (_OP_HEALTH[o.health] || _OP_HEALTH.GREEN);
      const nm = o.is_cluster ? `${fmtNum(o.critical)} critical, no operation` : esc(o.name);
      const attr = o.is_cluster ? 'data-cluster="1"' : `data-op="${esc(o.id)}"`;
      return `<div class="cc-op-row" ${attr} role="link" tabindex="0">
        <span class="cc-op-dot" style="background:${hc}"></span>
        <div class="cc-op-body"><div class="cc-op-name">${nm}</div></div>
        <div class="cc-op-counts"><div class="c crit"><b>${fmtNum(o.critical)}</b><span>Crit</span></div></div>
        <div class="cc-op-ar">›</div></div>`;
    }).join('');
    box.querySelectorAll('[data-op]').forEach((r) => {
      const open = () => { try { window.location.hash = '#/operations/' + encodeURIComponent(r.getAttribute('data-op')); } catch (_e) {} };
      r.addEventListener('click', open);
      r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    box.querySelectorAll('[data-cluster]').forEach((r) => {
      const launch = () => { try { (window.launchOperationFromCluster || function () {})(); } catch (_e) {} };
      r.addEventListener('click', launch);
      r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); launch(); } });
    });
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
    _renderSpark();   // repaint from cache — the card rebuild just wiped #cc-spark
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

  // ── data: 24h intake sparkline ──────────────────────────────────────────
  // RACE FIX (Jun 2026): #cc-spark is CREATED by renderEfficiency (summary
  // completion), but this fetch usually resolves first — it used to find no
  // container, bail, and the summary then painted a permanent "—" over it.
  // Buckets are cached and rendered by whichever side finishes LAST:
  // loadSparkline() on fetch completion, renderEfficiency() right after it
  // rebuilds the card.
  let _sparkBuckets = null;
  function _renderSpark() {
    const spark = el('cc-spark');
    if (!spark || _sparkBuckets == null) return;
    if (!_sparkBuckets.length) {
      spark.innerHTML = `<div class="cc-empty" style="padding:0">No intake</div>`;
      return;
    }
    const peak = Math.max(1, ..._sparkBuckets.map((x) => x.report_count || 0));
    spark.innerHTML = _sparkBuckets.map((x) => {
      const h = Math.round(((x.report_count || 0) / peak) * 100);
      return `<i style="height:${Math.max(3, h)}%" title="${esc(x.bucket_start)}: ${x.report_count}"></i>`;
    }).join('');
  }
  async function loadSparkline() {
    try {
      const { body } = await jget('/analytics/damage-rate-24h');
      _sparkBuckets = (body && body.buckets) || [];
      _renderSpark();
    } catch (_) { /* sparkline optional */ }
  }

  // ── data: map markers + recent activity ──
  // TWO fetches now (decoupled): the global MAP pulls up to 5k LIGHTWEIGHT markers
  // (id/coords/severity/status/type — GET /reports/markers) so it stays
  // representative at 100k/500k instead of the old heavy newest-200 slice; the
  // Recent-Activity table pulls only the newest ~20 RICH rows (it shows 10).
  function loadFeed() {
    // MAP — many lean points.
    jget('/reports/markers?limit=5000').then(({ body }) => {
      const markers = Array.isArray(body) ? body : (body && (body.items || body.reports)) || [];
      renderMap(markers);
      // Geo caption (client Turf point-in-polygon) is O(points × countries) — sample
      // down so 5k markers don't stall the caption while the map still plots them all.
      const stride = markers.length > 800 ? Math.ceil(markers.length / 800) : 1;
      const geoSample = stride > 1 ? markers.filter((_, i) => i % stride === 0) : markers;
      loadWorldGeo().then(() => renderGeoCaption(geoSample)).catch(() => {});
    }).catch(() => { mapFallback('Map data unavailable'); });
    // RECENT ACTIVITY — newest rich rows.
    jget('/reports/?limit=20').then(({ body }) => {
      const reports = Array.isArray(body) ? body : (body && (body.items || body.reports)) || [];
      renderActivity(reports);
    }).catch(() => {
      const a = el('cc-activity'); if (a) a.innerHTML = `<div class="cc-empty">Activity unavailable</div>`;
    });
  }

  function rLatLng(r) {
    const loc = r.location || r;
    const lat = loc.latitude != null ? loc.latitude : loc.lat;
    const lng = loc.longitude != null ? loc.longitude : loc.lng;
    if (lat == null || lng == null) return null;
    if (Math.abs(lat) < 0.001 && Math.abs(lng) < 0.001) return null;  // null-island
    return [Number(lat), Number(lng)];
  }

  // ── client-side country derivation (interim) — Turf point-in-polygon over the
  // bundled world.json, scoped to the LOADED report window. A proper at-scale
  // country breakdown needs a Location.country column + backfill (spec §4-A);
  // until then this honestly labels itself "current view".
  let _world = null, _worldPromise = null;
  const _countryCache = {};
  function loadWorldGeo() {
    if (_world) return Promise.resolve(_world);
    if (!_worldPromise) {
      _worldPromise = fetch('world.json').then((r) => r.json())
        .then((j) => { _world = j; return j; })
        .catch(() => { _world = { features: [] }; return _world; });
    }
    return _worldPromise;
  }
  function countryFor(lat, lng) {
    if (!_world || !window.turf) return null;
    const key = lat.toFixed(1) + ',' + lng.toFixed(1);
    if (key in _countryCache) return _countryCache[key];
    let name = null;
    try {
      const pt = window.turf.point([lng, lat]);
      for (const f of (_world.features || [])) {
        if (window.turf.booleanPointInPolygon(pt, f)) { name = (f.properties && f.properties.name) || null; break; }
      }
    } catch (_) { /* turf hiccup → unknown */ }
    _countryCache[key] = name;
    return name;
  }
  function renderGeoCaption(reports) {
    const box = el('cc-map-geo');
    if (!box) return;
    const tally = {};
    (reports || []).forEach((r) => {
      const ll = rLatLng(r);
      if (!ll) return;
      const c = countryFor(ll[0], ll[1]);
      if (c) tally[c] = (tally[c] || 0) + 1;
    });
    const entries = Object.entries(tally).sort((a, b) => b[1] - a[1]);
    if (!entries.length) { box.textContent = ''; return; }
    const top = entries.slice(0, 4).map(([c, n]) => `${esc(c)} (${n})`).join(' · ');
    box.innerHTML = `🌍 <strong>${entries.length}</strong> countries impacted (current view) · ${top}`;
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
      // openLanding() rebuilds the overlay's innerHTML on every Home visit, so a
      // previously-created _map now points at a DETACHED #cc-map node. Tear it
      // down and re-init against the live container — otherwise the singleton
      // guard below skips initialisation and the new node stays blank. (Fixes
      // "Operations → Home → map doesn't load".)
      if (_map) {
        let live = false;
        try { live = !!(_map.getContainer && _map.getContainer() === cont); } catch (_) { live = false; }
        if (!live) {
          try { _map.remove(); } catch (_) {}
          _map = null; _cluster = null;
          if (_mapRO) { try { _mapRO.disconnect(); } catch (_) {} _mapRO = null; }
        }
      }
      if (!_map) {
        _map = window.L.map('cc-map', { zoomControl: true, attributionControl: false, worldCopyJump: true })
          .setView([15, 30], 2);
        window.L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 18 }).addTo(_map);
        // First-paint hardening (fixes "map blank until refresh"): the overlay
        // can still be mid-reflow when Leaflet samples the container, so it
        // builds a 0-size tile grid. Recompute on ready AND whenever the
        // container gains/changes a real size (overlay reveal · global-shell
        // padding · window resize). invalidateSize only here — never re-fit on
        // resize, so it can't hijack the operator's pan/zoom.
        try { _map.whenReady(() => { try { _map.invalidateSize(); } catch (_) {} }); } catch (_) {}
        try {
          if (window.ResizeObserver) {
            _mapRO = new ResizeObserver(() => { if (cont.clientHeight > 0) { try { _map.invalidateSize(); } catch (_) {} } });
            _mapRO.observe(cont);
          }
        } catch (_) {}
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
      const _fit = () => { try { _map.invalidateSize(); if (pts.length) _map.fitBounds(pts, { padding: [30, 30], maxZoom: 8 }); } catch (_) {} };
      _fit();
      // Re-run after the browser has laid out the (possibly just-revealed)
      // container — two frames guarantees layout is settled on a cold load.
      requestAnimationFrame(() => requestAnimationFrame(_fit));
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
    // Deep-link the clicked report (route-aware: navigates to Operations then
    // opens that incident's detail) — not the old generic '/incidents' feed.
    box.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => {
      const id = tr.getAttribute('data-id');
      if (id && typeof window.openIncident === 'function') window.openIncident(id);
      else go('/incidents');
    }));
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
