/* cc-home.js - Crisis Intelligence Center (post-login landing).
 *
 * A humanitarian situation room shown over the dashboard at route '/'. It
 * delivers SITUATIONAL AWARENESS first, navigation second - replacing the old
 * 4-tile launcher. It does NOT redesign the "Monitor & Respond" module; it
 * surfaces a read-only summary and routes INTO that module for action.
 *
 * Hard rule (operator brief): every widget is backed by REAL data - no dummy
 * cards, no fake AI, no hardcoded KPIs. Sources:
 *   • GET /api/v1/analytics/summary   - KPIs, distributions, timings, impact, deltas
 *   • GET /api/v1/analytics/damage-rate-24h - 24h intake sparkline
 *   • GET /api/v1/reports/?limit=…    - map markers + recent activity
 *   • GET /api/v1/reports/nearby      - emerging-hotspot briefing
 *   • router.js                       - deep-links into the operations module
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
  const fmtNum = (n) => (n == null ? '-' : Number(n).toLocaleString());
  function fmtDur(sec) {
    if (sec == null) return '-';
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
  // Active-Operations hotspot map (Jun 2026 home redesign) - one marker per
  // operation (number tag = critical count), beside the recent-ops cards.
  let _opsMap = null, _opsMapRO = null, _opsLayer = null;
  // Live operations from the last /operations load - reused by the Situational
  // Awareness "Where" facet (the assess payload carries no top_operations, so we
  // derive the geographic concentration from the same ops the rail already has).
  let _lastOps = [];

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
    /* sticky header block - identity row + primary nav stay pinned while the
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
    #cc-ops-rail{display:flex;flex-direction:column;gap:9px;max-height:560px;overflow-y:auto}
    #cc-ops-rail-list{display:flex;flex-direction:column;gap:8px}
    /* portfolio summary - scales the rail to 50+ ops (top-N shortlist + summary) */
    .cc-ops-sum{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
    .cc-ops-chip{font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;border:1px solid #233149;
      background:#0d1626;color:#9fb3d1;cursor:pointer;font-family:inherit;font-variant-numeric:tabular-nums}
    .cc-ops-chip:hover{border-color:#418FDE}
    .cc-ops-chip b{font-weight:800}
    .cc-ops-chip.red{color:#f87171;border-color:#7f1d1d;background:#1d1113}
    .cc-ops-chip.amber{color:#fbbf24;border-color:#5a4410;background:#181206}
    .cc-ops-chip.green{color:#34D399;border-color:#14532d;background:#0c1f16}
    .cc-ops-chip.muted{cursor:default;color:#8aa0bf}
    .cc-ops-chip.muted:hover{border-color:#233149}
    .cc-ops-alert{display:flex;align-items:center;gap:9px;padding:7px 11px;border-radius:9px;background:#1b1113;
      border:1px solid #7f1d1d;color:#fca5a5;font-size:12.5px;cursor:pointer}
    .cc-ops-alert:hover{border-color:#f87171}
    .cc-ops-alert b{color:#f87171;font-weight:800}
    .cc-ops-alert .cta{margin-left:auto;font-size:11.5px;color:#fca5a5;text-decoration:underline;white-space:nowrap}
    .cc-ops-more{display:flex;align-items:center;justify-content:center;gap:6px;padding:7px;font-size:12px;
      color:#8aa0bf;cursor:pointer;border:1px dashed #233149;border-radius:9px;background:#0d1626}
    .cc-ops-more:hover{color:#cdd8ec;border-color:#418FDE}
    .cc-ops-more a{color:#7db8ef;text-decoration:underline}
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
    /* ── Home redesign (Jun 2026): Active Operations split + ops hotspot map ── */
    .cc-zone-top{margin-top:2px}
    /* The ops split reuses .cc-split (1.6fr 1fr) so its columns line up exactly
       with Global Monitoring above; align-items:start lets each column own its
       height (the comfortable cards can run taller than the summary + map). */
    .cc-split-ops{align-items:start}
    .cc-split-opslist #cc-ops-rail{max-height:none;overflow:visible;display:flex;flex-direction:column;gap:10px}
    .cc-ops-side{display:flex;flex-direction:column;gap:10px;min-width:0}
    #cc-ops-summary .cc-ops-sum{margin:0}
    #cc-ops-summary .cc-ops-alert{margin-top:8px}
    #cc-ops-map{height:340px;border-radius:10px;overflow:hidden;background:#0d1422;isolation:isolate}
    .cc-ops-mk{background:none;border:none}
    .cc-ops-mk-dot{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;
      font-size:11px;font-weight:800;color:#0b1220;box-shadow:0 0 0 2px rgba(2,8,20,.7),0 2px 6px rgba(0,0,0,.5)}
    .cc-geo{font-size:11.5px;color:#8A99B5;padding:8px 6px 2px}
    .cc-geo strong{color:#cdd8ec;font-variant-numeric:tabular-nums}
    /* Geo caption OVERLAYS the map's bottom instead of adding column height -
       keeps the map card the same height as #cc-att (height-mismatch fix). */
    #cc-map-card{position:relative}
    #cc-map-card #cc-map-geo{position:absolute;left:16px;right:16px;bottom:16px;z-index:500;margin:0;
      padding:5px 10px;background:rgba(11,18,32,.82);border:1px solid rgba(255,255,255,.08);border-radius:8px;
      backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);pointer-events:none}
    #cc-map-card #cc-map-geo:empty{display:none}
    /* ── SPLIT DECISION SURFACE - map (left) + Global Attention panel (right) ──
       Equal-height: the LEFT map card's fixed #cc-map (430px → 448px border-box)
       is the tallest item in the single grid row, so the row resolves to ~448px.
       grid default align-items:stretch forces the RIGHT panel to that exact
       height; its 5 cards (flex:1 1 0) then divide it into equal slices with one
       uniform gap - no blank tail, no uneven gutters, regardless of count strings.
       The map height is content-independent → it never re-tiles/jumps on poll. */
    .cc-split{display:grid;grid-template-columns:1.6fr 1fr;gap:14px;align-items:stretch;margin-bottom:6px}
    .cc-split-map{min-width:0}
    .cc-split-att{min-width:0;display:flex;flex-direction:column}
    .cc-att-hd{margin:0 0 10px}
    .cc-att-col{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:8px}
    /* attention CARD - .opc parity: 12px radius, #101a2e bg, #233149 border, hover #418FDE */
    .cc-att-card{flex:1 1 0;min-height:0;display:flex;flex-direction:column;justify-content:center;
      background:#101a2e;border:1px solid #233149;border-radius:12px;cursor:pointer;
      overflow:hidden;position:relative;transition:border-color .12s,background .12s}
    .cc-att-card:hover{border-color:#418FDE;background:#13203a}
    .cc-att-card:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
    .cc-att-card.zero{opacity:.88}
    .cc-att-main{display:flex;align-items:center;gap:12px;padding:0 14px}
    .cc-att-ic{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;font-size:15px;flex:none}
    .cc-att-row .lab{flex:1;min-width:0;display:flex;flex-direction:column;line-height:1.2}
    .cc-att-row .lab .l1{font-size:14px;font-weight:700;color:#E6EDF7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cc-att-row .lab .l2{font-size:11.5px;color:#8A99B5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cc-att-row .cnt-wrap{flex:none;text-align:right;display:flex;flex-direction:column;line-height:1.1;min-width:48px}
    .cc-att-row .cnt{font-size:21px;font-weight:800;font-variant-numeric:tabular-nums}
    .cc-att-row .cnt.ok{color:#34D399;font-size:19px}
    .cc-att-row .cnt2{font-size:10.5px;color:#7d89a3;margin-top:1px}
    .cc-att-row .ar{color:#5C6B85;font-size:15px;flex:none}
    .cc-att-card:hover .ar{color:#418FDE}
    /* CRITICAL emphasis - filled-red command strip (absolute → adds no height) +
       red border accent + larger count, so the 5 cards stay equal-height. */
    .cc-att-crit{border-color:#5a1f1f}
    .cc-att-crit:hover{border-color:#f87171;background:#16100f}
    .cc-att-crit:hover .ar{color:#f87171}
    .cc-att-crit .cc-att-main{padding-top:20px}
    .cc-att-crit .cnt{font-size:24px}
    .cc-att-strip{position:absolute;top:0;left:0;right:0;height:18px;
      background:linear-gradient(90deg,#dc2626,#ef4444);color:#fff;
      font-size:9px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;
      display:flex;align-items:center;gap:6px;padding:0 14px}
    .cc-att-strip::before{content:"";width:5px;height:5px;border-radius:50%;background:#fff;
      box-shadow:0 0 0 3px rgba(255,255,255,.28);flex:none}
    /* responsive: desktop side-by-side · laptop narrower panel · tablet stack · mobile */
    @media(max-width:1280px){
      .cc-split{grid-template-columns:1.75fr 1fr;gap:12px}
      .cc-att-main{padding:0 12px;gap:11px}
      .cc-att-row .lab .l2{font-size:11px}
    }
    @media(max-width:900px){
      .cc-split{grid-template-columns:1fr;gap:12px;align-items:start}
      .cc-att-col{flex:none}
      .cc-att-card{flex:none;min-height:60px}
    }
    @media(max-width:560px){
      .cc-att-card{flex:none;min-height:56px}
      .cc-att-main{padding:0 12px;gap:10px}
      .cc-att-crit .cnt{font-size:22px}
    }
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
    /* Expand control on the Active Operations band - right-aligned (margin-left:auto)
       opener for the full #/operations management view. */
    .cc-expand-btn{margin-left:auto;display:inline-flex;align-items:center;gap:4px;font-size:11px;
      font-weight:600;color:#9fb2d4;background:rgba(65,143,222,.08);border:1px solid #2a3a55;
      border-radius:8px;padding:3px 9px;cursor:pointer;letter-spacing:.02em;text-transform:none;
      line-height:1.4;transition:border-color .12s,background .12s,color .12s}
    .cc-expand-btn:hover{border-color:#418FDE;background:rgba(65,143,222,.16);color:#E6EDF7}
    .cc-expand-btn:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
    @media (max-width:560px){.cc-expand-btn .cc-expand-l{display:none}.cc-expand-btn{padding:3px 7px}}

    /* ── Section 1 · Global Overview: map | command-centre tiles | AI panel ── */
    .cc-sec1{display:grid;grid-template-columns:1.5fr 1.1fr 1.15fr;gap:14px;align-items:stretch;margin-bottom:6px}
    .cc-sec1-map{min-width:0;position:relative}
    .cc-cmdc{min-width:0;display:flex;flex-direction:column}
    .cc-sec1-ai{min-width:0;display:flex;flex-direction:column}
    @media(max-width:1180px){.cc-sec1{grid-template-columns:1fr 1fr}.cc-sec1-ai{grid-column:1 / -1}}
    @media(max-width:760px){.cc-sec1{grid-template-columns:1fr}}
    /* Command-centre metric tiles (deep-link into the incident feed) */
    .cc-tiles{display:grid;grid-template-columns:1fr 1fr;gap:8px;flex:1 1 auto;align-content:start}
    .cc-tile{appearance:none;text-align:left;display:flex;flex-direction:column;gap:2px;
      background:#0f1726;border:1px solid #1d2942;border-radius:11px;padding:11px 12px;cursor:pointer;
      transition:border-color .12s,background .12s;min-width:0;font:inherit;color:inherit}
    .cc-tile:hover{border-color:#418FDE;background:#13203a}
    .cc-tile:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
    .cc-tile-info{cursor:default}.cc-tile-info:hover{border-color:#1d2942;background:#0f1726}
    .cc-tile-ic{width:30px;height:30px;border-radius:8px;display:grid;place-items:center;font-size:14px;margin-bottom:2px}
    .cc-tile-n{font-size:24px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.05}
    .cc-tile-l{font-size:12px;color:#cdd8ec;font-weight:600}
    .cc-tile-cta{font-size:10.5px;color:#7d89a3}
    .cc-tile:hover .cc-tile-cta{color:#9fb2d4}
    @media(max-width:420px){.cc-tiles{grid-template-columns:1fr}}

    /* ── Situational Awareness: four AI facets ── */
    .cc-sa-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    @media(max-width:860px){.cc-sa-grid{grid-template-columns:1fr}}
    .cc-sa-facet{background:#0f1726;border:1px solid #1d2942;border-radius:11px;padding:12px 14px;min-width:0}
    .cc-sa-wide{grid-column:1 / -1}
    .cc-sa-h{font-size:12px;font-weight:700;color:#E6EDF7;margin-bottom:7px;letter-spacing:.01em}
    .cc-sa-sum{font-size:13px;color:#cdd8ec;line-height:1.5}
    .cc-sa-meta{font-size:11px;color:#8A99B5;margin-top:7px}
    .cc-sa-list{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:5px}
    .cc-sa-list li{font-size:12.5px;color:#cdd8ec;line-height:1.4}
    .cc-sa-where{font-size:13px;color:#cdd8ec}
    .cc-sa-empty{font-size:12px;color:#7d89a3}
    .cc-sa-foot{font-size:10.5px;color:#7d89a3;margin-top:8px;border-top:1px solid #1a2436;padding-top:7px}

    /* ── Executive summary (Section 3, right) ── */
    .cc-exec-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    .cc-exec-stat{background:#0f1726;border:1px solid #1d2942;border-radius:11px;padding:13px 14px}
    .cc-exec-n{font-size:26px;font-weight:800;font-variant-numeric:tabular-nums;line-height:1.05;color:#E6EDF7}
    .cc-exec-l{font-size:12.5px;color:#cdd8ec;font-weight:600;margin-top:3px}
    .cc-exec-s{font-size:10.5px;color:#7d89a3;margin-top:2px}
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
             Command Center shell (crisp-shell.js) now - there is no separate
             situational banner here (it used to float over the KPI cards). This
             visually-hidden heading is the labelled region's H1 for a11y. -->
        <h1 id="cc-home-heading" class="cc-vh">Crisis Intelligence Center</h1>

        <!-- ═════ SECTION 1 · GLOBAL OVERVIEW ═════
             map (WHERE) | command-centre metric tiles (HOW MANY - each deep-links
             into the incident feed at the right scope/filter) | AI Assessment &
             Actions (CrispCommandPanel, auto-runs on load). One decision-first row. -->
        <div class="cc-sec-t cc-band">🌐 Section 1 · Global Overview <span class="cc-band-sub">- map · command centre · AI assessment &amp; actions</span></div>
        <div class="cc-sec1">
          <div class="cc-card cc-split-map cc-sec1-map" id="cc-map-card" style="padding:8px">
            <div id="cc-map"></div><div id="cc-map-geo" class="cc-geo"></div>
          </div>
          <div class="cc-card cc-cmdc">
            <div class="cc-sec-t cc-att-hd" style="margin:0 0 8px">Command centre</div>
            <div id="cc-att"><div class="cc-empty">Loading…</div></div>
          </div>
          <div class="cc-sec1-ai" id="cc-command"></div>
        </div>

        <!-- ═════ SITUATIONAL AWARENESS (AI · auto-generated) ═════
             Re-skins the SAME /analytics/assess payload into four operator facets
             (what's happening · where · what needs attention · recommended actions).
             Replaces the old rule-based "Situation Briefing". -->
        <div class="cc-sec-t cc-band">📡 Situational Awareness <span class="cc-band-sub">- AI · what's happening · where · what needs attention · recommended actions</span></div>
        <div class="cc-card" id="cc-sitaware"><div class="cc-empty">Generating situational summary…</div></div>

        <div class="cc-zone cc-zone-monitor">
          <!-- ═════ SECTION 2 · ACTIVE OPERATIONS ═════
               recent operations (the rail leads with a "+ New Operation" card) |
               operations summary + a single all-operations hotspot map. -->
          <div class="cc-sec-t cc-band">🎯 Section 2 · Active Operations <span class="cc-band-sub">- operations you are running</span> <span class="cc-stale" id="cc-sum-stale"></span><button type="button" id="cc-ops-expand" class="cc-expand-btn" title="Open the full operations view" aria-label="Expand to the full operations management view">⤢ <span class="cc-expand-l">View all</span></button></div>
          <div class="cc-split cc-split-ops">
            <div class="cc-split-opslist">
              <div id="cc-ops-rail"><div class="cc-empty">Loading operations…</div></div>
            </div>
            <div class="cc-split-att cc-ops-side">
              <div class="cc-sec-t cc-att-hd">Operations Summary</div>
              <div id="cc-ops-summary"><div class="cc-empty">Loading…</div></div>
              <div class="cc-card cc-ops-map-card" id="cc-ops-map-card" style="padding:8px">
                <div id="cc-ops-map"></div>
              </div>
            </div>
          </div>

          <!-- Building Intelligence: buildings ranked by operational priority - the
               real places help is sent. Same shared card used in the Operation
               worklist (no second mental model). Report volume stays visible. -->
          <div class="cc-sec-t cc-band">🏢 Building Intelligence <span class="cc-band-sub">- buildings ranked by priority · where to send help next</span> <button type="button" id="cc-bld-expand" class="cc-expand-btn" title="See all buildings in the incident feed">⤢ <span class="cc-expand-l">View all</span></button></div>
          <div id="cc-buildings"><div class="cc-empty">Loading buildings…</div></div>

          <!-- ═════ SECTION 3 · GLOBAL SUMMARY ═════
               left = the existing distribution cards (kept); the grid below pairs
               Operational Impact with the new portfolio Executive summary. -->
          <div class="cc-sec-t cc-band">📊 Section 3 · Global Summary <span class="cc-band-sub">- distributions · executive summary</span></div>
          <div class="cc-grid3">
            <div class="cc-card"><div class="cc-sec-t" style="margin:0 0 8px">By severity</div><div id="cc-dist-sev"></div></div>
            <div class="cc-card"><div class="cc-sec-t" style="margin:0 0 8px">By crisis type</div><div id="cc-dist-type"></div></div>
            <div class="cc-card"><div class="cc-sec-t" style="margin:0 0 8px">Efficiency &amp; intake</div><div id="cc-eff"></div></div>
          </div>

          <div class="cc-grid2" style="margin-top:14px">
            <div><div class="cc-sec-t">Operational Impact</div><div class="cc-card" id="cc-impact"></div></div>
            <div><div class="cc-sec-t">Executive summary</div><div class="cc-card" id="cc-exec"><div class="cc-empty">Loading…</div></div></div>
          </div>

          <div class="cc-sec-t">Recent Operational Activity</div>
          <div class="cc-card" id="cc-activity" style="padding:6px 10px"><div class="cc-empty">Loading…</div></div>
        </div>
      </div>`;
    ov.classList.add('cc-home-open');

    // Command Center: the shared GLOBAL Analyze + scoped cascade-action panel at the
    // top (loads its own /analytics/assess; acts on filtered global slices).
    try {
      if (window.CrispCommandPanel && el('cc-command')) {
        window.CrispCommandPanel.render({ level: 'global', mountEl: el('cc-command') });
      }
    } catch (_e) {}

    // Expand → the full operations management view (#/operations). The home rail
    // is the concise summary; /operations is the detailed list. Route + deep-
    // linking are unchanged - this is just a discoverable entry point (it also
    // replaces the removed standalone "Operations" nav button).
    const expand = el('cc-ops-expand');
    if (expand) expand.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); go('/operations'); });
    // "+ New" → the Start-New-Operation wizard (moved off a full-width rail card
    // into the band header so the rail is pure triage at 50+ ops).
    const opsNew = el('cc-ops-new');
    if (opsNew) opsNew.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      try { (window.openOperationWizard || function () { go('/operations'); })(); } catch (_e) { go('/operations'); }
    });
    // "View all" buildings → the incident feed, where the Buildings grouping view
    // lists every building (no separate buildings route by design).
    const bldExp = el('cc-bld-expand');
    if (bldExp) bldExp.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); go('/incidents'); });

    // Org branding + clock are rendered by the shell (crisp-shell.js) now.
    refreshAll();
    if (_poll) clearInterval(_poll);
    _poll = setInterval(() => { if (el('cc-home-overlay') && el('cc-home-overlay').classList.contains('cc-home-open')) refreshAll(); }, 30000);
  }

  function refreshAll() {
    loadSummary();
    loadOperations();
    loadBuildings();
    loadFeed();
    loadSparkline();
    loadSitAware();   // AI Situational Awareness (replaced the rule-based Situation Briefing)
  }

  // ── data: Building Intelligence (top buildings by humanitarian_priority) ──
  async function loadBuildings() {
    const box = el('cc-buildings');
    if (!box) return;
    try {
      const { body } = await jget('/buildings?order_by=humanitarian_priority&order_dir=desc&limit=8');
      const items = (body && body.items) || [];
      if (window.CrispBuildingCard) {
        window.CrispBuildingCard.renderInto(box, items, { emptyText: 'No buildings with reports yet.' });
      }
    } catch (e) {
      box.innerHTML = (String(e.message) === '401' || String(e.message) === '403')
        ? '<div class="cc-empty">Sign in to view buildings.</div>'
        : '<div class="cc-empty">Buildings unavailable.</div>';
    }
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
      renderExec(body);
      const st = el('cc-sum-stale');
      if (st) st.textContent = 'updated ' + timeAgo(body.generated_at);
    } catch (e) {
      const st = el('cc-sum-stale');
      if (st) st.textContent = (String(e.message) === '401' || String(e.message) === '403')
        ? 'sign-in required' : 'data unavailable';
    }
  }

  // Command Centre (Section 1) - six portfolio metric tiles. Each tile is a
  // deep-link into the incident feed at the right scope/filter (the CTA helpers
  // the audit located). Colour discipline: Critical = red, Resolved = green,
  // everything else a single neutral. Counts come from /analytics/summary
  // (Phase-2 added counts.rejected + counts.affected_buildings); "affected
  // countries" is the honest "current view" Turf estimate, filled in by
  // renderGeoCaption once the map markers load.
  function goStatus(tab) {
    go('/incidents');
    try { setTimeout(() => { if (window.setStatusTab) window.setStatusTab(tab); }, 350); } catch (_e) {}
  }
  function renderAttention(b) {
    const c = b.counts || {};
    const num = (v) => (v == null ? 0 : Number(v));
    const RED = '#f87171', GREEN = '#34D399', NEU = '#418FDE';
    // Unit coherence (operator note: "total incidents < rejected"): the verdict/status
    // buckets (Critical/Resolved/Rejected/Review-pending) are REPORT counts, so the
    // headline is the report SUPERSET (counts.reports), not the deduped incident-entity
    // count — otherwise the total reads smaller than its own parts. Affected buildings
    // is a distinct-building count (its own unit, clearly labelled).
    const tiles = [
      { k: 'total',     ic: '🗂️', label: 'Total reports',      n: num(c.reports != null ? c.reports : (c.incidents != null ? c.incidents : c.total)), col: NEU, nav: () => go('/incidents') },
      { k: 'critical',  ic: '🔴', label: 'Critical',           n: num(c.critical),          col: RED,   nav: () => { window.location.hash = '#/incidents;queue=critical'; } },
      { k: 'resolved',  ic: '✅', label: 'Resolved',           n: num(c.resolved),          col: GREEN, nav: () => goStatus('resolved') },
      { k: 'rejected',  ic: '🚫', label: 'Rejected',           n: num(c.rejected),          col: NEU,   nav: () => { window.location.hash = '#/incidents;queue=rejected'; } },
      { k: 'pending',   ic: '🕓', label: 'Review pending',     n: num(c.pending != null ? c.pending : c.needs_review), col: NEU, nav: () => goStatus('pending') },
      { k: 'buildings', ic: '🏢', label: 'Affected buildings', n: num(c.affected_buildings), col: NEU,  nav: () => go('/incidents') },
    ];
    const tag = (t) => (t.nav ? 'button' : 'div');
    const tile = (t) => `<${tag(t)} type="button" class="cc-tile${t.nav ? '' : ' cc-tile-info'}" data-tile="${t.k}"${t.nav ? ' role="link" aria-label="' + esc(t.label) + ', open"' : ''}>
        <span class="cc-tile-ic" style="background:${t.col}22;color:${t.col}">${t.ic}</span>
        <span class="cc-tile-n" id="cc-tile-${t.k}" style="color:${t.col}">${fmtNum(t.n)}</span>
        <span class="cc-tile-l">${esc(t.label)}</span>
        <span class="cc-tile-cta">${t.sub ? esc(t.sub) : (t.nav ? 'view ›' : '')}</span>
      </${tag(t)}>`;
    const box = el('cc-att');
    if (!box) return;
    box.className = 'cc-tiles';
    box.innerHTML = tiles.map(tile).join('');
    tiles.forEach((t) => {
      if (!t.nav) return;
      const node = box.querySelector(`[data-tile="${t.k}"]`);
      if (node) node.addEventListener('click', (e) => { e.preventDefault(); t.nav(); });
    });
  }

  // ── operations rail (Phase 2 - operations-first home) ──────────────────────
  async function loadOperations() {
    try {
      const { body } = await jget('/operations');
      _lastOps = (body || []).filter((o) => o && !o.is_cluster
        && String((o.status || '')).toUpperCase() !== 'ENDED');
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
  // The home rail is a TRIAGE SHORTLIST, not the registry: it shows only the
  // worst-first top-N operations + a portfolio summary, and routes the long tail
  // to #/operations. This is what keeps the rail scannable at 50+ operations.
  const RAIL_TOP_N = 6;
  const _opUnattended = (o) => (o && o.unattended_critical != null)
    ? Number(o.unattended_critical) > 0
    : ((Number(o && o.critical) || 0) > 0 && (Number(o && o.responders_active) || 0) === 0);
  // Open the full registry, optionally pre-applying a filter the /operations page
  // reads once from sessionStorage (avoids a router/query change for P0).
  function _openOpsFiltered(filter) {
    try { if (filter) sessionStorage.setItem('crisp_ops_filter', filter); else sessionStorage.removeItem('crisp_ops_filter'); } catch (_e) {}
    go('/operations');
  }

  function renderOpsRail(ops) {
    const box = el('cc-ops-rail');
    if (!box) return;
    // Shared card (cc-operations.js CrispOpCard) - the rail + the /operations list
    // render the SAME card. Fallback to a minimal inline row if that module hasn't
    // loaded (defensive; both ship in index.html).
    if (window.CrispOpCard && typeof window.CrispOpCard.renderInto === 'function') {
      const all = (ops || []).slice();
      const cluster = all.find((o) => o.is_cluster) || null;
      const real = all.filter((o) => !o.is_cluster);
      const isEnded = (o) => String(o && o.status || '').toUpperCase() === 'ENDED';
      const live = real.filter((o) => !isEnded(o));

      // Portfolio summary - the one-line "do I need to act?" answer at any scale,
      // each chip click-throughs into the filtered registry.
      const red = live.filter((o) => o.health === 'RED').length;
      const amber = live.filter((o) => o.health === 'AMBER').length;
      const green = Math.max(0, live.length - red - amber);
      const unatt = live.filter(_opUnattended).length;
      const critTotal = live.reduce((s, o) => s + (Number(o.critical) || 0), 0);
      const chip = (cls, n, label, f) => (n > 0)
        ? `<button type="button" class="cc-ops-chip ${cls}"${f ? ` data-opf="${f}"` : ''}><b>${fmtNum(n)}</b> ${label}</button>` : '';
      const summary = `<div class="cc-ops-sum">`
        + `<button type="button" class="cc-ops-chip muted" data-opf="all"><b>${fmtNum(live.length)}</b> live</button>`
        + chip('red', red, 'critical state', 'red')
        + chip('amber', amber, 'rising', 'amber')
        + chip('green', green, 'stable', 'green')
        + chip('', unatt, 'unattended', 'unattended')
        // A4: removed the muted "N critical reports" chip - it duplicated the
        // per-card critical counts + the red-health chip with no distinct action;
        // the red chip filters to the critical ops and the orphan alert below
        // surfaces the unassigned critical reports (the actionable path).
        + `</div>`;

      // Orphan-critical: a slim one-line alert (was a full-width card).
      let alert = '';
      if (cluster && Number(cluster.critical) > 0) {
        alert = `<div class="cc-ops-alert" id="cc-ops-alert" data-critical="${Number(cluster.critical) || 0}" role="button" tabindex="0">`
          + `<span>🚨 <b>${fmtNum(cluster.critical)}</b> critical reports not yet in an operation</span>`
          + `<span class="cta">Triage →</span></div>`;
      }

      // RIGHT column: portfolio summary + orphan-critical alert (#cc-ops-summary).
      const sumBox = el('cc-ops-summary');
      if (sumBox) sumBox.innerHTML = summary + alert;

      // LEFT column: the most-recent 5 operations as COMFORTABLE cards (the same
      // card the dedicated /operations page renders). presorted keeps our recency
      // order; compact:false = the full card.
      const recent = live.slice().sort((a, b) => _opRecency(b) - _opRecency(a)).slice(0, 5);
      const moreN = real.length - recent.length;   // remaining live + all ended
      const more = moreN > 0
        ? `<div class="cc-ops-more" id="cc-ops-more" role="button" tabindex="0">+ ${fmtNum(moreN)} more operation${moreN === 1 ? '' : 's'} · <a>View all ${fmtNum(real.length)} →</a></div>`
        : '';
      box.innerHTML = '<div id="cc-ops-rail-list"></div>' + more;
      // "+ New Operation" leads the rail as the first card (styled like an op card),
      // then the most-recent live operations.
      window.CrispOpCard.renderInto(el('cc-ops-rail-list'), recent, {
        empty: 'No active operations yet.',
        grouped: false, presorted: true, compact: false, startNew: true,
      });

      // RIGHT column: a single hotspot map of ALL live operations (number tag =
      // critical count), beside the summary.
      try { renderOpsMap(live); } catch (_e) {}

      // Reflect the real op count on the band's "View all" affordance.
      try {
        const l = el('cc-ops-expand') && el('cc-ops-expand').querySelector('.cc-expand-l');
        if (l) l.textContent = 'View all' + (real.length ? ' ' + real.length : '');
      } catch (_e) {}

      (sumBox || box).querySelectorAll('[data-opf]').forEach((b) => b.addEventListener('click',
        () => _openOpsFiltered(b.getAttribute('data-opf') === 'all' ? null : b.getAttribute('data-opf'))));
      const al = el('cc-ops-alert');
      if (al) {
        const critical = Number(al.getAttribute('data-critical')) || 0;
        const choose = () => { try { (window.openClusterChooser || function () {})({ critical }); } catch (_e) {} };
        al.addEventListener('click', choose);
        al.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
      }
      const mo = el('cc-ops-more');
      if (mo) {
        const open = () => _openOpsFiltered(null);
        mo.addEventListener('click', open);
        mo.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      }
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
      const attr = o.is_cluster ? `data-cluster="1" data-critical="${Number(o.critical) || 0}"` : `data-op="${esc(o.id)}"`;
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
      const critical = Number(r.getAttribute('data-critical')) || 0;
      const choose = () => { try { (window.openClusterChooser || function () {})({ critical }); } catch (_e) {} };
      r.addEventListener('click', choose);
      r.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
    });
  }

  // Operation recency (last activity, fallback start date) - drives the home's
  // "most recent 5" comfortable cards.
  function _opRecency(o) {
    const t = o && (o.last_activity || o.started_at);
    const ms = t ? Date.parse(t) : NaN;
    return isFinite(ms) ? ms : 0;
  }

  // A single hotspot map of ALL live operations (right of the recent-ops cards).
  // One number-tagged marker per operation at its centre (tag = critical count,
  // colour = health). Mirrors renderMap's re-init/teardown discipline because
  // openLanding rebuilds the overlay each Home visit (stale detached container).
  function renderOpsMap(ops) {
    const cont = el('cc-ops-map');
    if (!cont) return;
    if (typeof window.L === 'undefined' || !window.L.map) {
      cont.innerHTML = '<div class="cc-map-fallback" style="height:340px">Map library not loaded</div>'; return;
    }
    try {
      if (_opsMap) {
        let liveM = false;
        try { liveM = !!(_opsMap.getContainer && _opsMap.getContainer() === cont); } catch (_) { liveM = false; }
        if (!liveM) {
          try { _opsMap.remove(); } catch (_) {}
          _opsMap = null; _opsLayer = null;
          if (_opsMapRO) { try { _opsMapRO.disconnect(); } catch (_) {} _opsMapRO = null; }
        }
      }
      if (!_opsMap) {
        _opsMap = window.L.map('cc-ops-map', { zoomControl: true, attributionControl: false, worldCopyJump: true }).setView([15, 30], 2);
        window.L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 18 }).addTo(_opsMap);
        try { _opsMap.whenReady(() => { try { _opsMap.invalidateSize(); } catch (_) {} }); } catch (_) {}
        try {
          if (window.ResizeObserver) {
            _opsMapRO = new ResizeObserver(() => { if (cont.clientHeight > 0) { try { _opsMap.invalidateSize(); } catch (_) {} } });
            _opsMapRO.observe(cont);
          }
        } catch (_) {}
      }
      if (_opsLayer) { try { _opsMap.removeLayer(_opsLayer); } catch (_) {} _opsLayer = null; }
      _opsLayer = window.L.layerGroup();
      const pts = [];
      (ops || []).forEach((o) => {
        const lat = Number(o.center_lat), lng = Number(o.center_lng);
        if (!isFinite(lat) || !isFinite(lng) || (lat === 0 && lng === 0)) return;
        const ll = [lat, lng]; pts.push(ll);
        const crit = Number(o.critical) || 0;
        const health = String(o.health || '').toUpperCase();
        const col = health === 'RED' ? '#f87171' : health === 'AMBER' ? '#fbbf24' : '#34D399';
        const icon = window.L.divIcon({
          className: 'cc-ops-mk',
          html: `<span class="cc-ops-mk-dot" style="background:${col}">${crit > 0 ? crit : ''}</span>`,
          iconSize: [26, 26], iconAnchor: [13, 13],
        });
        const mk = window.L.marker(ll, { icon });
        const place = o.place_name ? esc(o.place_name) : '';
        mk.bindPopup(`<b>${esc(o.name || 'Operation')}</b>${place ? '<br>' + place : ''}<br><small>${crit} critical · ${fmtNum(o.total || 0)} reports</small>`);
        mk.on('mouseover', () => { try { mk.openPopup(); } catch (_e) {} });
        mk.on('mouseout', () => { try { mk.closePopup(); } catch (_e) {} });
        mk.on('click', () => { try { window.__crispRouter && window.__crispRouter.navigate('/operations/' + encodeURIComponent(o.id)); } catch (_e) {} });
        _opsLayer.addLayer(mk);
      });
      _opsMap.addLayer(_opsLayer);
      const _fit = () => { try { _opsMap.invalidateSize(); if (pts.length) _opsMap.fitBounds(pts, { padding: [40, 40], maxZoom: 6 }); } catch (_) {} };
      _fit();
      requestAnimationFrame(() => requestAnimationFrame(_fit));
    } catch (e) { cont.innerHTML = '<div class="cc-map-fallback" style="height:340px">Map unavailable</div>'; }
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
        <div class="cc-spark" id="cc-spark"><div class="cc-empty" style="padding:0">-</div></div></div>`;
    _renderSpark();   // repaint from cache - the card rebuild just wiped #cc-spark
  }

  function renderImpact(b) {
    const im = b.impact || {};
    const cell = (n, l) => `<div class="b"><div class="n cc-num">${n}</div><div class="l">${esc(l)}</div></div>`;
    const box = el('cc-impact');
    if (box) box.innerHTML = `
      <div class="cc-imp">
        ${cell(fmtNum(im.critical_infrastructure), 'Critical infrastructure hit')}
        ${cell(im.service_disruptions == null ? '-' : fmtNum(im.service_disruptions), 'Service disruptions')}
        ${cell(fmtNum(im.lives_impacted_sum), 'Lives impacted (reported)')}
        ${cell(fmtNum(im.responders_active), 'Responders active')}
      </div>
      <div class="cc-note"><strong>Population exposure &amp; displacement</strong> - not shown.
        CRISP records citizen damage reports, not census/displacement data. These require an external
        data integration (WorldPop/GHSL for population, IOM DTM/UNHCR for displacement) joined by
        geography. Surfacing fabricated figures would mislead operations.</div>`;
  }

  // ── data: 24h intake sparkline ──────────────────────────────────────────
  // RACE FIX (Jun 2026): #cc-spark is CREATED by renderEfficiency (summary
  // completion), but this fetch usually resolves first - it used to find no
  // container, bail, and the summary then painted a permanent "-" over it.
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
  // (id/coords/severity/status/type - GET /reports/markers) so it stays
  // representative at 100k/500k instead of the old heavy newest-200 slice; the
  // Recent-Activity table pulls only the newest ~20 RICH rows (it shows 10).
  function loadFeed() {
    // MAP - many lean points.
    jget('/reports/markers?limit=5000').then(({ body }) => {
      const markers = Array.isArray(body) ? body : (body && (body.items || body.reports)) || [];
      renderMap(markers);
      // Geo caption (client Turf point-in-polygon) is O(points × countries) - sample
      // down so 5k markers don't stall the caption while the map still plots them all.
      const stride = markers.length > 800 ? Math.ceil(markers.length / 800) : 1;
      const geoSample = stride > 1 ? markers.filter((_, i) => i % stride === 0) : markers;
      loadWorldGeo().then(() => renderGeoCaption(geoSample)).catch(() => {});
    }).catch(() => { mapFallback('Map data unavailable'); });
    // RECENT ACTIVITY - newest rich rows.
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

  // ── client-side country derivation (interim) - Turf point-in-polygon over the
  // bundled world.json, scoped to the LOADED report window. A proper at-scale
  // country breakdown needs a Location.country column + backfill (spec §4-A);
  // until then this honestly labels itself "current view".
  let _world = null, _worldPromise = null;
  let _countryCount = 0;   // "current view" affected-countries estimate (Command Centre tile)
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
    // Feed the derived count into the Command Centre "Affected countries" tile.
    _countryCount = entries.length;
    const tv = el('cc-tile-countries'); if (tv) tv.textContent = fmtNum(entries.length);
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
      // down and re-init against the live container - otherwise the singleton
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
        // padding · window resize). invalidateSize only here - never re-fit on
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
        // Popup on hover (preview); CLICK opens the incident detail (deep-link +
        // operation-aware) - previously a dead-end (popup-only, no click handler).
        mk.on('mouseover', () => { try { mk.openPopup(); } catch (_e) {} });
        mk.on('mouseout', () => { try { mk.closePopup(); } catch (_e) {} });
        mk.on('click', () => { try { window.openIncident && window.openIncident(r.id, { operationId: r.crisis_event_id || null }); } catch (_e) {} });   // ROUTE-04: open op-owned incidents in their op context
        _cluster.addLayer(mk);
      });
      _map.addLayer(_cluster);
      const _fit = () => { try { _map.invalidateSize(); if (pts.length) _map.fitBounds(pts, { padding: [30, 30], maxZoom: 8 }); } catch (_) {} };
      _fit();
      // Re-run after the browser has laid out the (possibly just-revealed)
      // container - two frames guarantees layout is settled on a cold load.
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
      const place = (r.location && (r.location.user_location_name || r.location.device_location_name)) || '-';
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
    // opens that incident's detail) - not the old generic '/incidents' feed.
    box.querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => {
      const id = tr.getAttribute('data-id');
      if (id && typeof window.openIncident === 'function') window.openIncident(id);
      else go('/incidents');
    }));
  }

  // ── data: rule-based situation briefing (real aggregates, no LLM) ──
  // ── AI Situational Awareness — re-skins the SAME /analytics/assess payload ──
  // The Command Centre AI panel (cc-command.js) auto-runs the assessment on load
  // (one POST); this GET reads the cached result and presents the four operator
  // facets. While the synthesis is still running we show a calm placeholder and
  // retry a few times (the result is cached server-side once ready) — no second
  // Claude call from here.
  async function loadSitAware() {
    const box = el('cc-sitaware');
    if (!box) return;
    let a = null;
    try { const { body } = await jget('/analytics/assess'); a = body; } catch (_e) { /* fall through */ }
    if (!a || !a.assessed) {
      // The AI assessment runs ONLY on an explicit click (no auto-run on load).
      // Until the operator runs it from the Command Centre panel, show a call-to-
      // action, not a spinner. refreshAll re-checks every 30s, so this fills in
      // automatically once the assessment has been run + cached.
      box.innerHTML = `<div class="cc-empty">🛰️ Click <b>Analyze Global</b> in the AI Assessment panel above to generate the situational summary, key risks and recommended actions.</div>`;
      return;
    }
    renderSitAware(box, a);
  }
  function renderSitAware(box, a) {
    const band = a.band || 'UNVERIFIED';
    const score = (a.score == null ? '—' : a.score);
    const risks = (a.key_risks || []).slice(0, 5);
    const actions = (a.recommended_actions || []).slice(0, 5).map((x) =>
      (x && typeof x === 'object') ? (x.label || x.action || '') : x).filter(Boolean);
    // "Where" = the operations carrying the load. The /analytics/assess payload
    // carries NO top_operations, so derive it from the live ops the rail already
    // loaded (worst-first). a.top_operations is still honoured if a future backend
    // ever adds it, so this stays forward-compatible.
    const ops = (a.top_operations && a.top_operations.length
      ? a.top_operations
      : _lastOps.slice().sort((x, y) => (Number(y.critical) || 0) - (Number(x.critical) || 0))
    ).slice(0, 5);
    const li = (arr, empty) => arr.length
      ? `<ul class="cc-sa-list">${arr.map((x) => `<li>${esc(String(x))}</li>`).join('')}</ul>`
      : `<div class="cc-sa-empty">${esc(empty)}</div>`;
    const where = ops.length
      ? `<ul class="cc-sa-list">${ops.map((o) => { const pl = o.place || o.place_name; return `<li><b>${esc(o.name || 'Operation')}</b>${pl ? ' · ' + esc(pl) : ''}${o.critical ? ` · <span style="color:#f87171">${fmtNum(o.critical)} critical</span>` : ''}</li>`; }).join('')}</ul>`
      : (_countryCount ? `<div class="cc-sa-where">${fmtNum(_countryCount)} countries in the current view</div>`
                       : `<div class="cc-sa-empty">No geographic concentration yet.</div>`);
    // escalation_likelihood is {level, rationale} (or a legacy plain string) — never
    // stringify the object directly, which renders the literal "[object Object]".
    const _el = a.escalation_likelihood;
    const escalTxt = !_el ? '' : (typeof _el === 'object' ? (_el.level || _el.likelihood || '') : String(_el));
    const escalTitle = (_el && typeof _el === 'object' && _el.rationale) ? _el.rationale : '';
    box.className = 'cc-card';
    box.innerHTML =
      `<div class="cc-sa-grid">
         <div class="cc-sa-facet cc-sa-wide">
           <div class="cc-sa-h">🛰️ What's happening</div>
           <div class="cc-sa-sum">${esc(a.situation_summary || 'No summary available.')}</div>
           <div class="cc-sa-meta">Situation confidence <b>${score}</b>/100 · ${esc(band)}${escalTxt ? ` · <span${escalTitle ? ` title="${esc(escalTitle)}"` : ''}>escalation ${esc(escalTxt)}</span>` : ''}</div>
         </div>
         <div class="cc-sa-facet">
           <div class="cc-sa-h">📍 Where</div>${where}
         </div>
         <div class="cc-sa-facet">
           <div class="cc-sa-h">⚠️ Needs attention</div>${li(risks, 'No elevated risks flagged.')}
         </div>
         <div class="cc-sa-facet cc-sa-wide">
           <div class="cc-sa-h">✅ Recommended actions</div>${li(actions, 'No actions recommended right now.')}
           <div class="cc-sa-foot">Run these from the AI Assessment &amp; Actions panel above.</div>
         </div>
       </div>`;
  }

  // ── Executive summary (Section 3, right) — portfolio totals from /analytics/summary.
  function renderExec(b) {
    const box = el('cc-exec');
    if (!box) return;
    const c = (b && b.counts) || {};
    const num = (v) => (v == null ? 0 : Number(v));
    const stat = (label, n, sub, col) =>
      `<div class="cc-exec-stat">
         <div class="cc-exec-n" style="${col ? 'color:' + col : ''}">${fmtNum(num(n))}</div>
         <div class="cc-exec-l">${esc(label)}</div>${sub ? `<div class="cc-exec-s">${esc(sub)}</div>` : ''}
       </div>`;
    box.className = 'cc-card';
    box.innerHTML =
      `<div class="cc-exec-grid">
         ${stat('Total buildings', c.total_buildings, 'mapped across all operations')}
         ${stat('Duplicate reports', c.duplicate_reports, 'merged into incidents')}
         ${stat('Total resolved', c.resolved, 'incidents closed', '#34D399')}
         ${stat('Buildings at risk', c.buildings_critical_risk, 'risk score > 90', '#f87171')}
       </div>`;
  }

  // ── launcher (user-menu item) + boot ──
  // The "Crisis Intelligence" launcher takes you back to the home landing, so it
  // is only useful FROM another page. Hide it when you are already ON the Crisis
  // Intelligence page (route '/'); re-evaluated on every route change.
  function _onHomeRoute() {
    try {
      const p = window.__crispRouter && window.__crispRouter.parseHash && window.__crispRouter.parseHash();
      if (p && p.route) return p.route === '/';
    } catch (_e) {}
    const h = (location.hash || '').split('?')[0].split(';')[0].replace(/^#/, '');
    return h === '' || h === '/';
  }
  function _syncLauncherVisibility() {
    const btn = el('cc-home-launch');
    if (btn) btn.style.display = _onHomeRoute() ? 'none' : '';
  }

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
      _syncLauncherVisibility();
    } catch (_e) { /* never break the dashboard */ }
  }

  function boot() {
    injectStyles();
    injectLauncher();
    let tries = 0;
    const iv = setInterval(() => { injectLauncher(); if (el('cc-home-launch') || ++tries > 20) clearInterval(iv); }, 400);
    try { window.addEventListener('hashchange', _syncLauncherVisibility); } catch (_e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // public API (reachable from the menu + tests + router)
  window.openControlCenter = openLanding;
  window.__ccHome = { openLanding, closeLanding };
})();
