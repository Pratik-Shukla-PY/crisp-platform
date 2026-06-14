/**
 * crisp-nav.js — the ONE incident-navigation helper for the whole dashboard.
 *
 * THE BUG it fixes: clicking an incident from any surface (home, map, cards,
 * recent activity, notifications, operations lists/dashboards, search, …) used
 * to route to a list but NOT open the incident, losing the operator's context.
 *
 * THE CONTRACT: window.CrispNav.openIncident(incidentId, { operationId }) always
 *   1. routes to the correct context (the incident's OPERATION if it has one,
 *      else GLOBAL),
 *   2. writes a deep-linkable URL — #/operations/{opId}?incident={id} (operation)
 *      or #/incidents?incident={id} (global),
 *   3. auto-opens the incident detail panel,
 *   4. highlights + scrolls the incident's row in the list,
 *   5. survives refresh + Back + Forward (the router calls restoreFromHash on
 *      every dispatch, so click / refresh / history all share ONE code path).
 *
 * Loaded AFTER app.js + cc-*.js (so selectReport / __crispGetReport exist) and
 * BEFORE router.js (so router.dispatch() can call restoreFromHash).
 */
(function () {
  'use strict';
  if (window.CrispNav) return;

  // The data precondition for selectReport() is the report being in allReports.
  // Operation scope re-fetches async; the global feed polls. Wait on the cache.
  const READY_TIMEOUT_MS = 4500;

  function _getReport(id) {
    try { return (window.__crispGetReport && window.__crispGetReport(id)) || null; } catch (_e) { return null; }
  }
  function _toast(msg, kind) {
    try { if (typeof window.showToast === 'function') window.showToast(msg, kind || ''); } catch (_e) {}
  }
  // Resolve an incident's operation: explicit caller value > the report's own
  // crisis_event_id > null (global). This is why a notification from operation X
  // opens inside X even while the operator is looking at operation Y.
  function _resolveOperationId(incidentId, explicit) {
    if (explicit) return explicit;
    const r = _getReport(incidentId);
    return (r && r.crisis_event_id) || null;
  }

  // ── THE entry point — every incident click anywhere calls this ───────────────
  function openIncident(incidentId, opts) {
    if (!incidentId) return;
    opts = opts || {};
    const opId = _resolveOperationId(incidentId, opts.operationId);
    const route = opId ? ('/operations/' + opId) : '/incidents';
    const router = window.__crispRouter;
    if (!router || typeof router.navigateWithIncident !== 'function') {
      if (typeof window.selectReport === 'function') window.selectReport(incidentId);  // pre-boot
      return;
    }
    // Already in the target context? Open WITHOUT a full re-dispatch (no overlay
    // teardown / re-fetch / flicker) — set the deep-link seg + open + highlight
    // directly. Otherwise switch context via navigate → dispatch → restoreFromHash.
    const p = router.parseHash ? router.parseHash() : null;
    const onTarget = !!p && (
      (opId && p.route === '/operations' && p.params && p.params.id === opId) ||
      (!opId && p.route === '/incidents'));
    if (onTarget && typeof router.setIncidentSeg === 'function') {
      router.setIncidentSeg(incidentId);
      if (typeof window.selectReport === 'function') window.selectReport(incidentId);
      markSelected(incidentId);
    } else {
      router.navigateWithIncident(route, incidentId);
    }
  }

  // Poll the report cache until the incident lands (or timeout). Resolves report|null.
  function _whenReportLoaded(id) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const tick = () => {
        const r = _getReport(id);
        if (r) return resolve(r);
        if (performance.now() - t0 > READY_TIMEOUT_MS) return resolve(null);
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  function _detailOpen() {
    const p = document.getElementById('detail-panel');
    return !!(p && p.style.display && p.style.display !== 'none');
  }

  let _restoreToken = 0;
  // Called by router.dispatch() AFTER the route's context renders — the single
  // path for click + refresh + Back/Forward.
  async function restoreFromHash(parsed) {
    const incidentId = parsed && parsed.query && parsed.query.incident;
    const token = ++_restoreToken;     // supersede any in-flight restore
    if (!incidentId) {
      // No selection in the URL → close any open detail (the Back contract) and
      // clear the row highlight. __crispNavSuppressHistory tells closeDetail not
      // to touch history (the browser already changed the hash on Back).
      markSelected(null);
      if (_detailOpen() && typeof window.closeDetail === 'function') {
        try { window.__crispNavSuppressHistory = true; window.closeDetail(); }
        finally { window.__crispNavSuppressHistory = false; }
      }
      return;
    }
    const r = await _whenReportLoaded(incidentId);
    if (token !== _restoreToken) return;   // a newer navigation superseded us
    if (!r) { _toast('That incident is not in this view.', 'warn'); return; }
    try { if (typeof window.selectReport === 'function') window.selectReport(incidentId); } catch (_e) {}
    markSelected(incidentId);
  }

  function _cssEsc(s) {
    try { return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'); }
    catch (_e) { return String(s); }
  }
  // Highlight + scroll the selected incident's row, across EVERY list renderer
  // (op worklist, global tree, queue/triage cards). One implementation replaces
  // the per-renderer bespoke `selected` className logic.
  function markSelected(id) {
    try {
      document.querySelectorAll('.is-selected').forEach((n) => n.classList.remove('is-selected'));
      if (!id) return;
      const e = _cssEsc(id);
      const row = document.querySelector(
        `.cco-wl-row[data-id="${e}"],.tree-incident[data-id="${e}"],.qrt-card[data-id="${e}"]`);
      if (row) {
        row.classList.add('is-selected');
        try { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_e) {}
      }
    } catch (_e) {}
  }

  // Strip ?incident= WITHOUT a new history entry — the ✕-close → clean URL path.
  function clearIncidentSeg() {
    try {
      const h = (location.hash || '');
      if (h.indexOf('?') < 0) return;
      const clean = h.split('?')[0];
      history.replaceState(null, '', location.pathname + location.search + clean);
      markSelected(null);
    } catch (_e) {}
  }

  window.CrispNav = { openIncident, restoreFromHash, markSelected, clearIncidentSeg, _resolveOperationId };
})();
