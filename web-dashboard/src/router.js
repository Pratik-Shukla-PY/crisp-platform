/* router.js - CRISP dashboard navigation hub (mandatory Control Center root).
 *
 * The dashboard is the operator's whole platform; after login the user lands on
 * the Control Center (`#/`) - NOT the incident feed - and every workflow opens
 * from there. This is a thin hash router over the existing monolith:
 *
 *   #/            → Control Center root (cc-home overlay, the 4-card hub)
 *   #/incidents   → Incident Monitoring (the existing <main> dashboard view)
 *   #/users       → Account & User management (cc-settings, account mode)
 *   #/org         → Organisation settings   (cc-settings, org mode)        [admin]
 *   #/reporting   → Reporting / PWA config  (cc-crisis crisis-forms builder) [admin]
 *
 * Design notes:
 *  - The route is the FIRST `;`-segment that starts with `/`. All existing hash
 *    state (`building=…`, `chips=…`, transient `full-report`) lives in the other
 *    `;`-segments and is preserved untouched - `parseHash` finds the route
 *    positionally, so the chip/building writers (which already preserve "other"
 *    segments) keep working without edits.
 *  - A routeless hash change (e.g. the full-report modal pushing `#full-report`)
 *    retains the current route instead of bouncing to root.
 *  - Under automation (`navigator.webdriver`) the initial empty-hash load defaults
 *    to `#/incidents` so the feed-driven dashboard e2e specs aren't blocked by the
 *    root overlay; a `crisp_router_force_root` flag opts a spec into the root.
 *  - Role-gated: `ROUTE_ROLES` is the single allowlist; the backend 403 remains
 *    the real security boundary.
 *  - Loaded LAST (after app.js + cc-*.js) so every `window.openX` exists.
 */
(function () {
  'use strict';
  if (window.__crispRouter) return;

  // ── role allowlist (single source of truth) ────────────────────────────────
  const ROUTE_ROLES = {
    '/':           ['SUPER_ADMIN', 'ADMIN', 'ANALYST', 'VIEWER'],
    '/incidents':  ['SUPER_ADMIN', 'ADMIN', 'ANALYST', 'VIEWER'],
    '/operations': ['SUPER_ADMIN', 'ADMIN', 'ANALYST', 'VIEWER'],  // list + #/operations/{id}
    '/users':      ['SUPER_ADMIN', 'ADMIN', 'ANALYST', 'VIEWER'],  // account self-service; Users-mgmt tab gated inside cc-settings
    '/org':        ['SUPER_ADMIN', 'ADMIN'],
    '/reporting':  ['SUPER_ADMIN', 'ADMIN'],
    '/exports':    ['SUPER_ADMIN', 'ADMIN', 'ANALYST', 'VIEWER'],
  };

  function role() {
    try {
      const u = JSON.parse(localStorage.getItem('crisp_user') || '{}') || {};
      return String(u.role || '').toUpperCase();
    } catch (_e) { return ''; }
  }
  function canRoute(r) {
    const allow = ROUTE_ROLES[r];
    if (!allow) return false;
    const ro = role();
    return ro ? allow.includes(ro) : false;
  }

  // ── hash parsing (route owns segment 0; state segments untouched) ───────────
  function parseHash() {
    let raw = (location.hash || '').replace(/^#/, '');
    // Deep-link query (e.g. ?incident=<id>) rides at the END of the hash
    // fragment. The router stays ;-segment based for the path; the trailing
    // ?key=val is parsed into `query` so a click/refresh can reopen a detail.
    const query = {};
    const qIdx = raw.indexOf('?');
    if (qIdx >= 0) {
      raw.slice(qIdx + 1).split('&').forEach((kv) => {
        if (!kv) return;
        const eq = kv.indexOf('=');
        const k = eq >= 0 ? kv.slice(0, eq) : kv;
        const v = eq >= 0 ? kv.slice(eq + 1) : '';
        try { query[decodeURIComponent(k)] = decodeURIComponent(v); } catch (_e) { query[k] = v; }
      });
      raw = raw.slice(0, qIdx);
    }
    const segs = raw.split(';').filter(Boolean);
    let routeSeg = segs.find((s) => s.startsWith('/')) || '';
    if (routeSeg === '/home') routeSeg = '/';
    // Positional param: `/operations/<id>` resolves to the base route
    // `/operations` (for role-gating + dispatch) with the id captured in
    // params. Only /operations gets positional parsing - every other route is
    // unchanged, so the chip/building/queue state-segment writers keep working.
    const params = {};
    let baseSeg = routeSeg;
    const m = routeSeg.match(/^\/operations\/(.+)$/);
    if (m) { baseSeg = '/operations'; params.id = decodeURIComponent(m[1]); }
    const route = ROUTE_ROLES[baseSeg] ? baseSeg : (routeSeg ? '__unknown__' : '');
    const stateSegs = segs.filter((s) => !s.startsWith('/'));
    return { route, params, stateSegs, query, hasRoute: !!routeSeg };
  }
  function buildHash(route, stateSegs, query) {
    let h = '#' + [route].concat(stateSegs || []).join(';');
    const keys = query ? Object.keys(query).filter((k) => query[k] != null && query[k] !== '') : [];
    if (keys.length) {
      h += '?' + keys.map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(query[k])).join('&');
    }
    return h;
  }
  function navigate(route) {
    let { stateSegs } = parseHash();
    // Queue state segments are operations-view state (Jun 2026 attention
    // queues). Leaving /incidents drops them so the landing/settings URLs
    // stay clean and a stale queue can't silently re-apply later.
    if (route !== '/incidents') stateSegs = stateSegs.filter((s) => !s.startsWith('queue=') && !s.startsWith('op='));
    // navigate() builds with NO query → any ?incident= selection is cleared
    // when moving to a fresh route (the intuitive "leave the detail" behaviour).
    const next = buildHash(route, stateSegs);
    if (location.hash !== next) location.hash = next;   // fires hashchange → dispatch
    else dispatch();                                     // same hash → force a re-render
  }
  // Navigate to `route` carrying a deep-linkable ?incident=<id> selection.
  // Used by the unified CrispNav helper so every incident click is deep-linkable
  // + survives refresh / Back / Forward. queue= preserve policy matches navigate().
  function navigateWithIncident(route, incidentId) {
    let { stateSegs } = parseHash();
    if (route !== '/incidents') stateSegs = stateSegs.filter((s) => !s.startsWith('queue=') && !s.startsWith('op='));
    const next = buildHash(route, stateSegs, incidentId ? { incident: incidentId } : null);
    if (location.hash !== next) location.hash = next;   // → hashchange → dispatch → restore
    else dispatch();                                     // same hash → re-dispatch (re-open)
  }
  // Set ?incident=<id> on the CURRENT route WITHOUT re-dispatching - used when the
  // operator is already in the right context (e.g. clicking a worklist row inside
  // the operation they're viewing), so opening a detail doesn't tear down +
  // re-fetch the whole view. pushState adds a history entry so Back still closes
  // the detail (a hash change on Back fires hashchange → dispatch → restore).
  function setIncidentSeg(incidentId) {
    const { route, stateSegs } = parseHash();
    const next = buildHash(route, stateSegs, incidentId ? { incident: incidentId } : null);
    if (('#' + (location.hash || '').replace(/^#/, '')) === next) return;
    try { history.pushState(null, '', location.pathname + location.search + next); }
    catch (_e) { location.hash = next; }
  }

  // ── view show/hide ──────────────────────────────────────────────────────────
  const incidentsEl = () => document.getElementById('view-incidents')
    || document.querySelector('.dashboard-container');
  let _currentRoute = null;

  function hideAll() {
    const inc = incidentsEl();
    if (inc) inc.style.display = 'none';
    try { window.__ccHome && window.__ccHome.closeLanding && window.__ccHome.closeLanding(); } catch (_e) {}
    try { window.__ccSettings && window.__ccSettings.closeOverlay && window.__ccSettings.closeOverlay(); } catch (_e) {}
    try { window.__ccCrisis && window.__ccCrisis.closeOverlay && window.__ccCrisis.closeOverlay(); } catch (_e) {}
    try { window.__ccExports && window.__ccExports.closeOverlay && window.__ccExports.closeOverlay(); } catch (_e) {}
    // Tearing down the operations overlay also resets the app's operation
    // scope (_activeCrisisEventId) to global - so any non-/operations route
    // dispatched after this never inherits a stale crisis_event_id filter.
    try { window.__ccOperations && window.__ccOperations.closeOverlay && window.__ccOperations.closeOverlay(); } catch (_e) {}
  }
  function showIncidents() {
    const inc = incidentsEl();
    if (inc) inc.style.display = '';
    // The map may have been created while its container was hidden → recompute.
    try {
      if (window.map && typeof window.map.invalidateSize === 'function') {
        requestAnimationFrame(() => { try { window.map.invalidateSize(); } catch (_e) {} });
      }
    } catch (_e) {}
  }

  // ── dispatch ─────────────────────────────────────────────────────────────────
  function dispatch() {
    const parsed = parseHash();
    let route = parsed.route;

    // Routeless hash change (e.g. #full-report from the report modal) → keep the
    // current route; never bounce an in-flight incidents sub-state to root.
    if (!parsed.hasRoute) route = _currentRoute || '/';
    // Unknown route → root.
    if (route === '__unknown__') { navigate('/'); return; }

    // Role gate. '/' is always allowed; a disallowed module bounces to root.
    if (route !== '/' && !canRoute(route)) {
      try { if (typeof window.showToast === 'function') window.showToast('Not available for your role.', 'warn'); } catch (_e) {}
      navigate('/');
      return;
    }

    hideAll();
    if (route === '/incidents') {
      showIncidents();
      // ROUTE-08 (Phase-3): apply the ;queue= state seg HERE, inside the ordered
      // dispatch - it used to be a SEPARATE hashchange listener racing this one
      // (double render, no ordering). Queue first, then op scope, so the scoped
      // fetch renders with the queue already applied.
      try { if (window._syncQueueFromHash) window._syncQueueFromHash(); } catch (_e) {}
      // Operation scope from the hash (#/incidents;op={id}) - applied AFTER
      // hideAll() cleared it, so a scoped feed (e.g. arriving from an operation
      // dashboard) survives and the context banner can name the operation.
      try {
        const opSeg = (parsed.stateSegs || []).find((s) => s.startsWith('op='));
        const opId = opSeg ? decodeURIComponent(opSeg.slice(3)) : null;
        if (window.setOperationScope) window.setOperationScope(opId);
        if (window.__crispOnIncidentOpScope) window.__crispOnIncidentOpScope(opId);
      } catch (_e) {}
    } else if (route === '/users') {
      try { (window.openAccountSettings || function () {})(); } catch (_e) {}
    } else if (route === '/org') {
      try { (window.openOrgSettings || function () {})(); } catch (_e) {}
    } else if (route === '/reporting') {
      try { (window.openCrisisForms || function () {})(); } catch (_e) {}
    } else if (route === '/exports') {
      // Pass the PREVIOUS route so closing the center returns the user to
      // exactly where they came from (landing or ops). The ops view stays
      // visible underneath when arriving from /incidents.
      if (_currentRoute === '/incidents') showIncidents();
      try { (window.openExportCenter || function () {})(_currentRoute || '/'); } catch (_e) {}
    } else if (route === '/operations') {
      // id present → one operation's worklist dashboard; null → operations list.
      try { (window.openOperations || function () {})(parsed.params.id || null); } catch (_e) {}
    } else {
      try { (window.openControlCenter || function () {})(); } catch (_e) {}
      route = '/';
    }
    _currentRoute = route;
    try { document.body.setAttribute('data-route', route); } catch (_e) {}
    // Deep-link restoration: ONE code path for click + refresh + Back/Forward.
    // If the hash carries ?incident=<id>, reopen that detail once the context's
    // report list has loaded; if absent, close any open detail (Back contract).
    try { window.CrispNav && window.CrispNav.restoreFromHash && window.CrispNav.restoreFromHash(parsed); } catch (_e) {}
  }

  // ── init: migration shim + mandatory-root (automation-aware) ────────────────
  function init() {
    const raw = (location.hash || '').replace(/^#/, '');
    const hasRouteSeg = raw.split(';').some((s) => s.startsWith('/'));
    if (raw && !hasRouteSeg) {
      // Legacy bare-hash deep-link (e.g. #building=osm:way:123;chips=debris) →
      // it's incident state; prefix the incidents route so it still resolves.
      history.replaceState(null, '', location.pathname + location.search + '#/incidents;' + raw);
    } else if (!raw) {
      let forceRoot = false;
      try { forceRoot = localStorage.getItem('crisp_router_force_root') === '1'; } catch (_e) {}
      const automation = (typeof navigator !== 'undefined' && navigator.webdriver) && !forceRoot;
      // Mandatory Control Center root for real users; feed for automation so the
      // existing feed-driven dashboard specs are unaffected.
      history.replaceState(null, '', location.pathname + location.search + (automation ? '#/incidents' : '#/'));
    }
    window.addEventListener('hashchange', dispatch);
    dispatch();
  }

  function boot() {
    // Only the authed dashboard; app.js already redirects to login when no token.
    try { if (!localStorage.getItem('crisp_token')) return; } catch (_e) { return; }
    init();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__crispRouter = { navigate, navigateWithIncident, setIncidentSeg, dispatch, parseHash, canRoute, ROUTE_ROLES };
  if (typeof window.navigate !== 'function') window.navigate = navigate;
})();
