/**
 * crisp-nav.js - the ONE incident-navigation helper for the whole dashboard.
 *
 * THE BUG it fixes: clicking an incident from any surface (home, map, cards,
 * recent activity, notifications, operations lists/dashboards, search, …) used
 * to route to a list but NOT open the incident, losing the operator's context.
 *
 * THE CONTRACT: window.CrispNav.openIncident(incidentId, { operationId }) always
 *   1. routes to the correct context (the incident's OPERATION if it has one,
 *      else GLOBAL),
 *   2. writes a deep-linkable URL - #/operations/{opId}?incident={id} (operation)
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

  // ── THE entry point - every incident click anywhere calls this ───────────────
  // Routing is CALLER-CONTEXT aware so the operator is never ejected off the page
  // they're on:
  //   • On the Incidents page (#/incidents, global OR op-scoped) → STAY there. If
  //     the incident belongs to an operation, op-scope the feed IN PLACE
  //     (#/incidents;op={opId}?incident={id}) so the feed header names that
  //     operation - never navigate away to the operation dashboard.
  //   • On THIS incident's operation dashboard (#/operations/{id}) → open in place
  //     (keep the op-dashboard context).
  //   • Elsewhere (home / notification / pre-boot) → open in the incident's
  //     operation context if it has one, else global.
  // (Supersedes the old route-by-incident's-op logic, which ejected an op-owned
  // incident clicked on the GLOBAL feed to /operations/{opId}. Cf. ROUTE-01.)
  function openIncident(incidentId, opts) {
    if (!incidentId) return;
    opts = opts || {};
    const opId = _resolveOperationId(incidentId, opts.operationId);
    const router = window.__crispRouter;
    if (!router || typeof router.navigateWithIncident !== 'function') {
      if (typeof window.selectReport === 'function') window.selectReport(incidentId);  // pre-boot
      return;
    }
    const p = router.parseHash ? router.parseHash() : null;
    const _curOpSeg = p && (p.stateSegs || []).find((s) => s.startsWith('op='));
    const _curOp = _curOpSeg ? decodeURIComponent(_curOpSeg.slice(3)) : null;

    // Open the detail WITHOUT a re-dispatch (no overlay teardown / re-fetch /
    // flicker). C1-d: the report may be outside the newest-N working set - ensure
    // it's loaded BEFORE selectReport, else the detail can't render.
    const _openInPlace = () => {
      const _open = () => {
        if (typeof window.selectReport === 'function') window.selectReport(incidentId);
        markSelected(incidentId);
      };
      if (_getReport(incidentId) || typeof window.__crispEnsureReport !== 'function') _open();
      else window.__crispEnsureReport(incidentId).then(_open).catch(_open);
    };

    // ── On the Incidents page → STAY on the Incidents page. ──────────────────
    if (p && p.route === '/incidents') {
      const targetOp = opId || null;
      if (targetOp === (_curOp || null)) {
        // Scope already matches (incl. global→global) → just open in place.
        if (typeof router.setIncidentSeg === 'function') router.setIncidentSeg(incidentId);
        _openInPlace();
      } else {
        // Re-scope the feed IN PLACE to the incident's operation (or back to
        // global), preserving any other state segs (e.g. queue=). The dispatch
        // then applies setOperationScope + opens the detail via restoreFromHash -
        // the header names the operation, no eject to /operations.
        const segs = (p.stateSegs || []).filter((s) => !s.startsWith('op='));
        if (targetOp) segs.push('op=' + encodeURIComponent(targetOp));
        const nextHash = (typeof router.buildHash === 'function')
          ? router.buildHash('/incidents', segs, { incident: incidentId })
          : '#/incidents' + (segs.length ? ';' + segs.join(';') : '') + '?incident=' + encodeURIComponent(incidentId);
        if (location.hash !== nextHash) location.hash = nextHash; else _openInPlace();
      }
      return;
    }

    // ── On THIS incident's operation dashboard → open in place. ──────────────
    if (p && p.route === '/operations' && p.params && opId && p.params.id === opId
        && typeof router.setIncidentSeg === 'function') {
      router.setIncidentSeg(incidentId);
      _openInPlace();
      return;
    }

    // ── Elsewhere (home / notification / pre-boot) → navigate to the incident's
    // own context (its operation dashboard if it has one, else global). ───────
    router.navigateWithIncident(opId ? ('/operations/' + opId) : '/incidents', incidentId);
  }

  // Poll the report cache until the incident lands (or timeout). Resolves report|null.
  function _whenReportLoaded(id) {
    // C1-d: the report may be outside the newest-N working set (deep-link / older
    // marker at scale). Kick a lazy by-id fetch; the poll below resolves as soon
    // as it merges into the cache (or on timeout → "not in this view").
    try { if (window.__crispEnsureReport) window.__crispEnsureReport(id); } catch (_e) {}
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
  // Called by router.dispatch() AFTER the route's context renders - the single
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
    try { window.__crispRouteTrace && window.__crispRouteTrace('incident auto-opened', { incidentId: incidentId, scope: (window.getOperationScope && window.getOperationScope()) || 'GLOBAL' }); } catch (_e) {}
  }

  function _cssEsc(s) {
    try { return (window.CSS && CSS.escape) ? CSS.escape(String(s)) : String(s).replace(/["\\]/g, '\\$&'); }
    catch (_e) { return String(s); }
  }
  function _findRow(id) {
    const e = _cssEsc(id);
    return document.querySelector(
      `.cco-wl-row[data-id="${e}"],.tree-incident[data-id="${e}"],.qrt-card[data-id="${e}"]`);
  }
  function _feedHost() { return document.getElementById('report-feed-list'); }
  // Is the row already comfortably inside its scroll viewport?
  function _rowInView(row) {
    try {
      const host = _feedHost();
      const rr = row.getBoundingClientRect();
      if (rr.height <= 0) return false;
      const hr = host ? host.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      return rr.top >= hr.top && rr.bottom <= hr.bottom;
    } catch (_e) { return false; }
  }
  // Make the selected row VISIBLE + scrolled-to. Returns true once it is laid out
  // (so the retry loop can stop). `reassert` = called from the re-render observer.
  function _doReveal(id, reassert) {
    const row = _findRow(id);
    if (!row) return false;
    if (!row.classList.contains('is-selected')) row.classList.add('is-selected');
    // Defensive: if it sits in a collapsed queue section, open it (the renderer
    // already expands the selected section, but inline/legacy paths may not).
    try { const sec = row.closest('.qrt-section.collapsed'); if (sec) sec.classList.remove('collapsed'); } catch (_e) {}
    if (row.offsetParent === null) return false;          // still display:none → retry next frame
    if (!_rowInView(row)) {
      // A re-render rebuilds #report-feed-list and resets scrollTop to 0; re-assert
      // the scroll then. But never yank the operator back if THEY scrolled away
      // (scrollTop well past 0 ⇒ a deliberate scroll, not a render reset).
      const host = _feedHost();
      if (reassert && host && host.scrollTop > 8) return true;
      // Initial reveal animates (smooth); re-asserts after a re-render snap
      // instantly so a repeated render can't leave the scroll mid-animation.
      try { row.scrollIntoView({ block: 'center', behavior: reassert ? 'auto' : 'smooth' }); } catch (_e) {}
    }
    return true;
  }

  let _revealId = null, _revealObs = null, _revealRAF = 0, _revealStop = 0;
  function _stopReveal() {
    _revealId = null;
    if (_revealObs) { try { _revealObs.disconnect(); } catch (_e) {} _revealObs = null; }
    if (_revealRAF) { try { cancelAnimationFrame(_revealRAF); } catch (_e) {} _revealRAF = 0; }
    if (_revealStop) { try { clearTimeout(_revealStop); } catch (_e) {} _revealStop = 0; }
  }
  // Robustly auto-scroll the selected incident into view ON NAVIGATION. The feed
  // re-renders several times during the nav cascade (scoped fetch → selectReport)
  // and each renderFeed rebuilds #report-feed-list (resetting scrollTop), so a
  // one-shot scroll gets undone. We (1) retry per-frame until the card is laid out
  // (it may be display:none / collapsed for a tick), then (2) re-assert the scroll
  // across re-renders for a short settling window, then stop so we never fight the
  // operator's own scrolling or the steady-state poll.
  function revealSelected(id) {
    _stopReveal();
    if (!id) return;
    _revealId = id;
    const t0 = performance.now();
    const poll = () => {
      if (_revealId !== id) return;
      if (_doReveal(id, false)) return;                   // laid out → observer takes over
      if (performance.now() - t0 < 2000) _revealRAF = requestAnimationFrame(poll);
    };
    _revealRAF = requestAnimationFrame(poll);
    const host = _feedHost();
    if (host && typeof MutationObserver === 'function') {
      _revealObs = new MutationObserver(() => { if (_revealId === id) _doReveal(id, true); });
      try { _revealObs.observe(host, { childList: true, subtree: true }); } catch (_e) {}
    }
    _revealStop = setTimeout(() => { if (_revealId === id) _stopReveal(); }, 2500);
  }

  // Highlight + scroll the selected incident's row, across EVERY list renderer
  // (op worklist, global tree, queue/triage cards). One implementation replaces
  // the per-renderer bespoke `selected` className logic.
  function markSelected(id) {
    try {
      document.querySelectorAll('.is-selected').forEach((n) => n.classList.remove('is-selected'));
      if (!id) { _stopReveal(); return; }
      const row = _findRow(id);
      if (row) row.classList.add('is-selected');
      revealSelected(id);
    } catch (_e) {}
  }

  // Strip ?incident= WITHOUT a new history entry - the ✕-close → clean URL path.
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
