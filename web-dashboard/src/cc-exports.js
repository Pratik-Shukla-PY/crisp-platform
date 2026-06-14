/* cc-exports.js - CRISP Export Center (route: #/exports).
 *
 * Jun 2026 export-audit IA rework (docs/export-audit-2026-06.md §5):
 * exports are a first-class capability with ONE discoverable home, not a
 * hover submenu buried in the operations toolbar. The center opens as a
 * route-level overlay (same module pattern as cc-settings / cc-crisis);
 * closing navigates back to wherever the user came from (landing or ops),
 * so there is no context loss in either direction.
 *
 * Everything downloads through the BACKEND export endpoints via
 * authenticated fetch → blob (auth-correct, satellite columns, HXL row,
 * server-side filters). Scope panel + live record count let the user see
 * exactly what they are about to download before any bytes move.
 *
 * Exposed:
 *   window.openExportCenter(fromRoute?)   - router dispatch entry
 *   window.__ccExports = { openOverlay, closeOverlay }
 */
(function () {
  'use strict';
  if (window.__ccExportsLoaded) return;
  window.__ccExportsLoaded = true;

  const _isLocalDev = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  const BACKEND_HOST = _isLocalDev ? `http://${window.location.hostname}:8000` : window.location.origin;
  const EXPORTS_API = `${BACKEND_HOST}/api/v1/exports`;

  const el = (id) => document.getElementById(id);
  const token = () => localStorage.getItem('crisp_token');
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const go = (r) => { try { if (window.__crispRouter) window.__crispRouter.navigate(r); } catch (_e) {} };

  // ── state ──────────────────────────────────────────────────────────────────
  const S = {
    from: '/',            // route to return to on close
    scope: 'all',         // all | current | 24h | 7d | custom
    since: '', until: '',
    count: null,
    counting: false,
  };

  // ── styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (el('cc-ex-styles')) return;
    const css = `
    #cc-ex-overlay{position:fixed;inset:0;z-index:99992;display:none;overflow:auto;background:rgba(7,12,22,.78);
      backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);color:#E6EDF7;
      font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    #cc-ex-overlay.cc-ex-open{display:block}
    .cc-ex-wrap{max-width:980px;margin:5vh auto;background:#0d1526;border:1px solid #243149;border-radius:16px;
      overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.5)}
    .cc-ex-hd{display:flex;align-items:center;gap:11px;padding:15px 20px;border-bottom:1px solid rgba(255,255,255,.08)}
    .cc-ex-hd .ic{width:34px;height:34px;border-radius:9px;background:rgba(65,143,222,.16);color:#418FDE;
      display:grid;place-items:center;font-size:15px;flex:none}
    .cc-ex-hd h2{margin:0;font-size:15.5px;font-weight:800;letter-spacing:-.01em}
    .cc-ex-hd .su{font-size:11px;color:#8A99B5}
    .cc-ex-close{margin-left:auto;background:none;border:1px solid #2C3A52;border-radius:8px;color:#8A99B5;
      width:30px;height:30px;cursor:pointer;font-size:13px}
    .cc-ex-close:hover{color:#fff;border-color:#418FDE}
    .cc-ex-body{display:grid;grid-template-columns:250px minmax(0,1fr);gap:0}
    @media(max-width:760px){.cc-ex-body{grid-template-columns:1fr}}
    .cc-ex-scope{padding:16px 18px;border-right:1px solid rgba(255,255,255,.07)}
    .cc-ex-sec{font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#5C6B85;margin:0 0 8px}
    .cc-ex-opscope{font-size:11.5px;font-weight:600;color:#7db8ef;background:rgba(65,143,222,.12);
      border:1px solid rgba(65,143,222,.3);border-radius:8px;padding:6px 10px;margin:0 0 10px}
    .cc-ex-radio{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid #2C3A52;border-radius:9px;
      margin-bottom:6px;font-size:12.5px;color:#cdd8ec;cursor:pointer}
    .cc-ex-radio:hover{border-color:#418FDE}
    .cc-ex-radio.on{border-color:#418FDE;background:rgba(65,143,222,.10);color:#9fc7f2}
    .cc-ex-radio input{accent-color:#418FDE;margin:0}
    .cc-ex-dates{display:none;flex-direction:column;gap:6px;margin:4px 0 8px}
    .cc-ex-dates.show{display:flex}
    .cc-ex-dates input{background:#10192d;border:1px solid #2C3A52;border-radius:8px;color:#cdd8ec;
      padding:6px 8px;font-size:11.5px;font-family:inherit}
    .cc-ex-count{margin-top:12px;padding:10px 12px;border-radius:10px;background:rgba(52,211,153,.08);
      border:1px solid rgba(52,211,153,.25)}
    .cc-ex-count .n{color:#34D399;font-size:15px;font-weight:800;font-variant-numeric:tabular-nums}
    .cc-ex-count .l{color:#8A99B5;font-size:10.5px}
    .cc-ex-main{padding:16px 18px}
    .cc-ex-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:9px}
    .cc-ex-card{text-align:start;background:#121b2f;border:1px solid #2C3A52;border-radius:11px;padding:11px 12px;
      color:#e8eefb;cursor:pointer;font-family:inherit;transition:border-color .15s}
    .cc-ex-card:hover{border-color:#418FDE}
    .cc-ex-card:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
    .cc-ex-card[disabled]{opacity:.5;cursor:wait}
    .cc-ex-card .t{font-size:13px;font-weight:700;display:flex;align-items:center;gap:7px;margin:0 0 3px}
    .cc-ex-card .d{font-size:10.5px;color:#8A99B5;line-height:1.45;margin:0}
    .cc-ex-note{margin-top:12px;font-size:11px;color:#7d89a3;background:rgba(255,255,255,.03);
      border:1px solid rgba(255,255,255,.07);border-radius:9px;padding:9px 11px;line-height:1.5}
    .cc-ex-recent{padding:12px 20px 16px;border-top:1px solid rgba(255,255,255,.08)}
    .cc-ex-recent table{width:100%;border-collapse:collapse;font-size:11.5px}
    .cc-ex-recent td{padding:4px 6px;color:#aab8d0;border-bottom:1px solid rgba(255,255,255,.05)}
    .cc-ex-recent .fmt{color:#7db8ef;font-weight:700;text-transform:uppercase}
    .cc-ex-empty{color:#5C6B85;font-size:11.5px;padding:6px}
    `;
    const s = document.createElement('style');
    s.id = 'cc-ex-styles';
    s.textContent = css;
    document.head.appendChild(s);
  }

  // ── scope → query params ───────────────────────────────────────────────────
  function scopeParams() {
    let p;
    if (S.scope === 'current' && typeof window._exportFilterParams === 'function') {
      // The ops view's live status+time filters (shared helper in app.js).
      p = window._exportFilterParams();
    } else {
      p = new URLSearchParams();
      if (S.scope === '24h') p.set('since', new Date(Date.now() - 24 * 3600e3).toISOString());
      if (S.scope === '7d') p.set('since', new Date(Date.now() - 7 * 24 * 3600e3).toISOString());
      if (S.scope === 'custom') {
        if (S.since) p.set('since', new Date(S.since).toISOString());
        if (S.until) p.set('until', new Date(S.until).toISOString());
      }
    }
    // Operation scope rides ALONG with the time scope: an export opened from an
    // operation downloads THAT operation's reports (was missing → exported all).
    if (S.crisisEventId && !p.has('crisis_event_id')) p.set('crisis_event_id', S.crisisEventId);
    return p;
  }
  function scopeLabel() {
    const base = {
      all: 'all data', current: 'current operations filters',
      '24h': 'last 24 hours', '7d': 'last 7 days', custom: 'custom range',
    }[S.scope] || S.scope;
    return S.crisisEventId ? base + ' · this operation' : base;
  }

  // ── live record count ──────────────────────────────────────────────────────
  let _countTimer = null;
  function refreshCount() {
    clearTimeout(_countTimer);
    _countTimer = setTimeout(async () => {
      const box = el('cc-ex-count');
      if (!box) return;
      S.counting = true;
      box.querySelector('.n').textContent = '…';
      try {
        const qs = scopeParams().toString();
        const res = await fetch(`${EXPORTS_API}/count${qs ? '?' + qs : ''}`,
          { headers: { Authorization: `Bearer ${token() || ''}` } });
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        S.count = data.count;
        box.querySelector('.n').textContent = Number(data.count).toLocaleString();
        box.querySelector('.l').textContent = `report(s) match · ${scopeLabel()}`;
      } catch (_e) {
        S.count = null;
        box.querySelector('.n').textContent = '-';
        box.querySelector('.l').textContent = 'count unavailable';
      } finally {
        S.counting = false;
      }
    }, 250);
  }

  // ── download helper (authenticated fetch → blob) ───────────────────────────
  async function download(btn, path, params) {
    const old = btn.innerHTML;
    btn.setAttribute('disabled', '');
    btn.querySelector('.d').textContent = 'Preparing download…';
    try {
      const qs = (params || new URLSearchParams()).toString();
      const res = await fetch(`${EXPORTS_API}/${path}${qs ? '?' + qs : ''}`,
        { headers: { Authorization: `Bearer ${token() || ''}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const cd = res.headers.get('content-disposition') || '';
      const m = /filename=([^;]+)/.exec(cd);
      const name = m ? m[1].trim().replace(/^"|"$/g, '') : `crisp_export_${path.replace(/\//g, '_')}`;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1500);
      loadRecent();   // the new export shows up in the audit list immediately
    } catch (e) {
      btn.innerHTML = old;
      const d = btn.querySelector('.d');
      if (d) d.textContent = `Failed (${e.message}) - try again`;
      btn.removeAttribute('disabled');
      return;
    }
    btn.innerHTML = old;
    btn.removeAttribute('disabled');
  }

  // ── recent exports (audit trail) ───────────────────────────────────────────
  async function loadRecent() {
    const box = el('cc-ex-recent-body');
    if (!box) return;
    try {
      const res = await fetch(`${EXPORTS_API}/recent?limit=8`,
        { headers: { Authorization: `Bearer ${token() || ''}` } });
      if (!res.ok) throw new Error(String(res.status));
      const rows = await res.json();
      if (!rows.length) {
        box.innerHTML = `<div class="cc-ex-empty">No exports recorded yet.</div>`;
        return;
      }
      const fmtTime = window.__ccFmtDateTime || ((x) => x || '');
      box.innerHTML = `<table><tbody>${rows.map((r) => `
        <tr>
          <td>${esc(r.user_email || '-')}</td>
          <td class="fmt">${esc(r.format || '?')}</td>
          <td>${r.row_count != null ? esc(String(r.row_count)) + ' rows' : ''}</td>
          <td>${esc(Object.entries(r.filters || {}).map(([k, v]) => `${k}=${v}`).join(' ') || 'all data')}</td>
          <td>${esc(fmtTime(r.created_at))}</td>
        </tr>`).join('')}</tbody></table>`;
    } catch (_e) {
      box.innerHTML = `<div class="cc-ex-empty">Export history unavailable.</div>`;
    }
  }

  // ── layout ─────────────────────────────────────────────────────────────────
  const DATASET_CARDS = [
    ['csv', '📊', 'CSV', 'Excel & analysis · 43 columns incl. satellite verification + HXL hashtag row'],
    ['geojson', '🌐', 'GeoJSON', 'QGIS / ArcGIS · point features, WGS84 decimal degrees, self-describing metadata'],
    ['shapefile', '🗺', 'Shapefile', 'Legacy GIS · zipped .shp/.dbf/.prj, satellite columns included'],
    ['kml', '🌍', 'KML', 'Google Earth · damage-colored placemarks with queryable attributes'],
    ['pdf', '📄', 'PDF dossier', 'Briefings · one page per report, photos embedded (max 1000 reports)'],
  ];
  const BRIEFING_CARDS = [
    ['sitrep', '📋', 'Situation report (PDF)', 'One-page operational sitrep: counts, intake, response performance, distributions'],
    ['analytics-summary', '📈', 'Analytics summary (CSV)', 'The landing-page metrics as section/metric/value rows'],
    ['data-dictionary', '📖', 'Data dictionary (CSV)', 'Column · HXL tag · description for every export field'],
  ];

  function ensureOverlay() {
    let ov = el('cc-ex-overlay');
    if (ov) return ov;
    injectStyles();
    ov = document.createElement('div');
    ov.id = 'cc-ex-overlay';
    ov.setAttribute('role', 'region');
    ov.setAttribute('aria-label', 'CRISP Export Center');
    document.body.appendChild(ov);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ov.classList.contains('cc-ex-open')) closeToOrigin();
    });
    return ov;
  }

  function card([path, glyph, title, desc]) {
    return `<button class="cc-ex-card" data-path="${esc(path)}">
      <p class="t"><span aria-hidden="true">${glyph}</span> ${esc(title)}</p>
      <p class="d">${esc(desc)}</p></button>`;
  }
  function radio(value, label2) {
    const on = S.scope === value;
    return `<label class="cc-ex-radio ${on ? 'on' : ''}" data-scope="${value}">
      <input type="radio" name="cc-ex-scope" value="${value}" ${on ? 'checked' : ''}> ${esc(label2)}</label>`;
  }

  function openOverlay(fromRoute) {
    if (!token()) return;
    S.from = fromRoute || S.from || '/';
    // Operation-scoped export: when opened from an operation dashboard, scope the
    // download to that operation. The op id was stashed by cc-operations at click
    // time (the global teardown clears the live op scope before we get here).
    S.crisisEventId = null;
    try {
      if (S.from === '/operations' && window.__crispExportCtx && window.__crispExportCtx.crisis_event_id) {
        S.crisisEventId = window.__crispExportCtx.crisis_event_id;
      }
    } catch (_e) {}
    try { window.__crispExportCtx = null; } catch (_e) {}
    // "Current filters" only makes sense coming from the ops view.
    if (S.scope === 'current' && S.from !== '/incidents') S.scope = 'all';
    const ov = ensureOverlay();
    ov.innerHTML = `
      <div class="cc-ex-wrap">
        <div class="cc-ex-hd">
          <div class="ic">⬇</div>
          <div><h2>Export Center</h2>
            <div class="su">Authenticated downloads · satellite columns always included · every export is audit-logged</div></div>
          <button class="cc-ex-close" id="cc-ex-close" aria-label="Close Export Center">✕</button>
        </div>
        <div class="cc-ex-body">
          <div class="cc-ex-scope">
            <p class="cc-ex-sec">Scope</p>
            ${S.crisisEventId ? '<div class="cc-ex-opscope">📍 This operation only - the scope below filters within it.</div>' : ''}
            ${radio('all', S.crisisEventId ? 'All of this operation' : 'All data')}
            ${S.from === '/incidents' ? radio('current', 'Current filters (what I see)') : ''}
            ${radio('24h', 'Last 24 hours')}
            ${radio('7d', 'Last 7 days')}
            ${radio('custom', 'Custom range…')}
            <div class="cc-ex-dates ${S.scope === 'custom' ? 'show' : ''}" id="cc-ex-dates">
              <input type="datetime-local" id="cc-ex-since" value="${esc(S.since)}" aria-label="From">
              <input type="datetime-local" id="cc-ex-until" value="${esc(S.until)}" aria-label="Until">
            </div>
            <div class="cc-ex-count" id="cc-ex-count"><div class="n">…</div><div class="l">counting…</div></div>
          </div>
          <div class="cc-ex-main">
            <p class="cc-ex-sec">Dataset exports</p>
            <div class="cc-ex-cards" id="cc-ex-dataset">${DATASET_CARDS.map(card).join('')}</div>
            <p class="cc-ex-sec" style="margin-top:14px">Reports &amp; reference</p>
            <div class="cc-ex-cards" id="cc-ex-briefing">${BRIEFING_CARDS.map(card).join('')}</div>
            <div class="cc-ex-note">
              <strong>Per-incident packages:</strong> every report's detail panel has an
              <em>Evidence bundle (ZIP)</em> - photos, audio, satellite snapshots and the
              verification JSON for offline review. Building consoles export per-building
              dossiers (PDF / GeoJSON / CSV).
            </div>
          </div>
        </div>
        <div class="cc-ex-recent">
          <p class="cc-ex-sec">Recent exports</p>
          <div id="cc-ex-recent-body"><div class="cc-ex-empty">Loading…</div></div>
        </div>
      </div>`;
    ov.classList.add('cc-ex-open');

    el('cc-ex-close').addEventListener('click', closeToOrigin);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeToOrigin(); });
    ov.querySelectorAll('.cc-ex-radio input').forEach((r) => r.addEventListener('change', () => {
      S.scope = r.value;
      ov.querySelectorAll('.cc-ex-radio').forEach((lb) =>
        lb.classList.toggle('on', lb.getAttribute('data-scope') === S.scope));
      el('cc-ex-dates').classList.toggle('show', S.scope === 'custom');
      refreshCount();
    }));
    el('cc-ex-since').addEventListener('change', (e) => { S.since = e.target.value; refreshCount(); });
    el('cc-ex-until').addEventListener('change', (e) => { S.until = e.target.value; refreshCount(); });
    ov.querySelectorAll('#cc-ex-dataset .cc-ex-card').forEach((b) =>
      b.addEventListener('click', () => download(b, b.getAttribute('data-path'), scopeParams())));
    ov.querySelectorAll('#cc-ex-briefing .cc-ex-card').forEach((b) =>
      b.addEventListener('click', () => download(b, b.getAttribute('data-path'), new URLSearchParams())));

    try { el('cc-ex-close').focus(); } catch (_e) {}
    refreshCount();
    loadRecent();
  }

  function closeOverlay() {
    const ov = el('cc-ex-overlay');
    if (ov) ov.classList.remove('cc-ex-open');
  }
  function closeToOrigin() {
    // Navigate back to wherever the center was opened from - the router's
    // dispatch will close this overlay via hideAll() and restore the origin
    // surface (landing or ops). No context loss in either direction.
    go(S.from || '/');
  }

  window.openExportCenter = (fromRoute) => openOverlay(fromRoute);
  window.__ccExports = { openOverlay, closeOverlay };
})();
