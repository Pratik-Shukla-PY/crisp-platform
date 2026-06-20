/* Shared Building Intelligence card — ONE card used verbatim in the Global home
 * "Building Intelligence" section AND the Operation "Buildings" worklist, so the
 * building is a single consistent operational object everywhere. Reads only
 * BuildingSummary fields from GET /buildings (incl. the per-page critical /
 * responder / duplicate-group counts). Click → window.openBuildingConsole(id).
 * Modeled on the existing shared CrispOpCard (cc-operations.js). */
(function () {
  'use strict';

  function _injectCss() {
    if (document.getElementById('crisp-bic-styles')) return;
    const s = document.createElement('style');
    s.id = 'crisp-bic-styles';
    s.textContent = `
      .bic{display:grid;grid-template-columns:minmax(170px,1.1fr) minmax(0,2.2fr) auto;align-items:center;
        gap:14px;padding:10px 13px;background:#101a2e;border:1px solid #233149;border-radius:12px;
        cursor:pointer;position:relative;overflow:hidden;transition:border-color .12s,background .12s}
      .bic:hover{border-color:#418FDE;background:#13203a}
      .bic:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
      .bic-unatt{box-shadow:inset 3px 0 0 0 #f87171}   /* critical reports, no team */
      .bic-id{min-width:0;display:flex;flex-direction:column;gap:3px}
      .bic-id-r1{display:flex;align-items:center;gap:7px;min-width:0}
      .bic-ic{font-size:15px;flex:0 0 auto}
      .bic-name{font-size:14px;font-weight:700;color:#e6edf7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
      .bic-badge{font-size:9px;font-weight:800;letter-spacing:.05em;padding:1px 7px;border-radius:999px;
        border:1px solid #33476a;background:rgba(255,255,255,.03);flex:0 0 auto;color:#9fb3d1}
      .bic-meta{font-size:10.5px;color:#8aa0bf;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .bic-kpis{display:flex;gap:6px;min-width:0;flex-wrap:wrap}
      .bic-chip{display:flex;flex-direction:column;align-items:center;padding:4px 9px;background:#0d1626;
        border:1px solid #1f2c44;border-radius:9px;font-variant-numeric:tabular-nums;min-width:46px}
      .bic-chip b{font-size:14px;font-weight:800;line-height:1;color:#dce6f5}
      .bic-chip span{font-size:8px;letter-spacing:.03em;text-transform:uppercase;color:#7d8ba3;margin-top:3px;white-space:nowrap}
      .bic-chip.crit b{color:#f87171}
      .bic-chip.dup b{color:#7dd3fc}
      .bic-chip.team b{color:#34D399}
      .bic-chip.noteam{background:#1d1113;border-color:#7f1d1d}
      .bic-chip.noteam b{color:#f87171;font-size:11px}
      .bic-sit{display:flex;align-items:center;gap:10px;flex:0 0 auto}
      .bic-pri{display:inline-flex;flex-direction:column;align-items:center;gap:1px;font-variant-numeric:tabular-nums}
      .bic-pri b{font-size:17px;font-weight:800;line-height:1;color:var(--bhc,#4ade80)}
      .bic-pri span{font-size:8px;letter-spacing:.04em;text-transform:uppercase;color:#7d8ba3}
      .bic-ar{color:#5b6b86;font-size:17px;flex:0 0 auto}
      .bic-empty{padding:14px;text-align:center;color:#7d8ba3;font-size:12px}`;
    document.head.appendChild(s);
  }

  function _escColor(esc) {
    const e = Number(esc) || 0;
    return e >= 70 ? '#f87171' : e >= 40 ? '#fbbf24' : '#4ade80';
  }
  function _name(b) {
    return (b.osm_name && String(b.osm_name).trim())
      || (b.osm_addr_full && String(b.osm_addr_full).split(',')[0])
      || ('Building ' + String(b.id || '').slice(0, 8));
  }
  function _timeAgo(iso) {
    try { return (typeof window.timeAgo === 'function') ? window.timeAgo(iso) : ''; } catch (_e) { return ''; }
  }
  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  // One card's HTML for a BuildingSummary `b`.
  function cardHtml(b) {
    const crit = b.critical_report_count || 0;
    const dups = b.duplicate_group_count || 0;
    const team = b.responder_count || 0;
    const pri = Math.round(b.humanitarian_priority || 0);
    const col = _escColor(b.escalation_risk);
    const noTeam = team === 0;
    const crisis = (b.crisis_types_top3 || []).slice(0, 2).map((c) => _esc(String(c).replace(/_/g, ' '))).join(' · ');
    const meta = [crisis, b.latest_report_at ? _timeAgo(b.latest_report_at) : ''].filter(Boolean).join(' · ');
    const teamChip = noTeam
      ? `<div class="bic-chip noteam" title="No responder team assigned"><b>No team ⚠</b><span>responders</span></div>`
      : `<div class="bic-chip team"><b>${team}</b><span>team${team > 1 ? 's' : ''}</span></div>`;
    return `<div class="bic ${noTeam && crit > 0 ? 'bic-unatt' : ''}" role="button" tabindex="0"
        data-building-id="${_esc(b.id)}" title="Open Building Details">
      <div class="bic-id">
        <div class="bic-id-r1"><span class="bic-ic">🏢</span>
          <span class="bic-name">${_esc(_name(b))}</span>
          <span class="bic-badge">${_esc(b.state || 'ACTIVE')}</span></div>
        ${meta ? `<div class="bic-meta">${meta}</div>` : ''}
      </div>
      <div class="bic-kpis">
        <div class="bic-chip"><b>${b.report_count || 0}</b><span>reports</span></div>
        <div class="bic-chip crit"><b>${crit}</b><span>critical</span></div>
        ${dups > 0 ? `<div class="bic-chip dup"><b>${dups}</b><span>dup group${dups > 1 ? 's' : ''}</span></div>` : ''}
        ${teamChip}
      </div>
      <div class="bic-sit">
        <div class="bic-pri" style="--bhc:${col}"><b>${pri}</b><span>priority</span></div>
        <span class="bic-ar">›</span>
      </div>
    </div>`;
  }

  function _wireCard(node, onOpen) {
    const open = () => {
      const id = node.getAttribute('data-building-id');
      try {
        // opts.onOpen lets a host (e.g. the operation dashboard, where the
        // building console's #detail-panel is hidden behind the ops overlay)
        // route to the right place instead of opening the console in place.
        if (typeof onOpen === 'function') onOpen(id);
        else if (window.openBuildingConsole) window.openBuildingConsole(id);
      } catch (_e) {}
    };
    node.addEventListener('click', open);
    node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  }

  // Render an array of BuildingSummary into `host`. opts.emptyText overrides the
  // empty-state copy. opts.pageSize (>0) turns on LAZY-LOAD: only the first page is
  // rendered, and the next page is appended as the host scrolls near its bottom -
  // so a scroll-capped container (e.g. the operation worklist, matched to the map
  // height) shows a handful of buildings and streams the rest on demand. Click /
  // Enter on a card → window.openBuildingConsole(id).
  function renderInto(host, buildings, opts) {
    if (!host) return;
    _injectCss();
    opts = opts || {};
    const onOpen = typeof opts.onOpen === 'function' ? opts.onOpen : null;
    const arr = Array.isArray(buildings) ? buildings : [];
    // Drop any prior lazy-scroll listener from a previous render of this host.
    if (host._bicScroll) { host.removeEventListener('scroll', host._bicScroll); host._bicScroll = null; }
    if (!arr.length) {
      host.innerHTML = `<div class="bic-empty">${_esc(opts.emptyText || 'No buildings to show.')}</div>`;
      return;
    }
    const pageSize = Number(opts.pageSize) || 0;
    if (!pageSize || arr.length <= pageSize) {
      host.innerHTML = arr.map(cardHtml).join('');
      host.querySelectorAll('.bic[data-building-id]').forEach((n) => _wireCard(n, onOpen));
      return;
    }
    // Lazy: render the first page, append the next as the host scrolls near bottom.
    let shown = 0;
    const renderMore = () => {
      const slice = arr.slice(shown, shown + pageSize);
      if (!slice.length) return;
      host.insertAdjacentHTML('beforeend', slice.map(cardHtml).join(''));
      Array.prototype.slice.call(host.querySelectorAll('.bic[data-building-id]'), shown).forEach((n) => _wireCard(n, onOpen));
      shown += slice.length;
    };
    host.innerHTML = '';
    renderMore();
    host._bicScroll = () => {
      if (shown >= arr.length) return;
      if (host.scrollTop + host.clientHeight >= host.scrollHeight - 80) renderMore();
    };
    host.addEventListener('scroll', host._bicScroll);
  }

  window.CrispBuildingCard = { renderInto, cardHtml, _escColor };
})();
