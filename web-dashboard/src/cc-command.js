/* Command Center — the shared Command Panel (Global · Operation · Building).
 *
 * ONE consistent decision+action surface at every hierarchy level:
 *   breadcrumb · AI Analyze card · key-metric chips · a SCOPED ACTION BAR.
 * The action bar is the point: each action is a set-based cascade that PERCOLATES
 * to every incident + report in scope (Operation/Global), with a blast-radius
 * confirm (dry-run counts), a reason for destructive actions, a double-submit guard,
 * and an Undo. The Analyze card's recommended actions are pre-filled cascades, so
 * "AI says → operator does" is one click. Loaded after app.js (reuses its globals).
 */
(function () {
  'use strict';

  function host() { try { return (typeof BACKEND_HOST !== 'undefined' && BACKEND_HOST) || ''; } catch (_) { return ''; } }
  function api(p) { return host() + '/api/v1' + p; }
  function hdrs() {
    var t = null; try { t = localStorage.getItem('crisp_token'); } catch (_) {}
    return t ? { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' }
             : { 'Content-Type': 'application/json' };
  }
  function toast(m, t) { try { (window.showToast || function () {})(m, t); } catch (_) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]; }); }
  function nfmt(n) { n = Number(n) || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n); }

  var BAND_COLOR = { VERIFIED: '#34D399', LIKELY: '#7db8ef', MIXED: '#fbbf24', WEAK: '#f87171', UNVERIFIED: '#8aa0bf' };

  // assess + cascade endpoints per scope level
  function assessUrl(scope) {
    return scope.level === 'global' ? api('/analytics/assess')
         : api('/operations/' + encodeURIComponent(scope.id) + '/assess');
  }
  function cascadeUrl(scope, action) {
    return scope.level === 'global' ? api('/reports/cascade')
         : api('/operations/' + encodeURIComponent(scope.id) + '/cascade/' + action);
  }
  function cascadeBody(scope, action, filters, dryRun) {
    if (scope.level === 'global') return { action: action, filters: filters || {}, dry_run: !!dryRun };
    return { filters: filters || null, dry_run: !!dryRun };
  }

  // ── styles ────────────────────────────────────────────────────────────────
  function ensureStyles() {
    if (document.getElementById('cc-command-styles')) return;
    var s = document.createElement('style');
    s.id = 'cc-command-styles';
    s.textContent = [
      '.cc-cmd{border:1px solid #233149;border-radius:12px;background:linear-gradient(180deg,#0e1626,#0c1320);padding:12px 14px;margin:0 0 14px}',
      '.cc-cmd-bc{font-size:11px;color:#8aa0bf;margin-bottom:8px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.cc-cmd-bc b{color:#dce8fb;font-weight:700}',
      '.cc-cmd-top{display:flex;gap:14px;align-items:stretch;flex-wrap:wrap}',
      '.cc-cmd-analyze{flex:1 1 320px;min-width:280px;border:1px solid #2a3a55;border-radius:10px;padding:10px 12px;background:#0d1626}',
      '.cc-cmd-az-head{display:flex;align-items:center;gap:10px}',
      '.cc-cmd-dial{font-size:26px;font-weight:800;line-height:1;min-width:62px}',
      '.cc-cmd-dial small{font-size:12px;color:#7d8ba3;font-weight:700}',
      '.cc-cmd-az-meta{min-width:0}',
      '.cc-cmd-az-title{font-size:12px;font-weight:800;color:#e6edf7;display:flex;align-items:center;gap:8px}',
      '.cc-cmd-band{font-size:9.5px;font-weight:800;padding:2px 7px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em}',
      '.cc-cmd-az-sum{font-size:12px;color:#b7c6e0;margin-top:6px;line-height:1.5}',
      '.cc-cmd-az-cta{cursor:pointer;border-radius:8px;font-weight:700;font-size:12px;margin-top:8px;background:linear-gradient(90deg,#6d5bd0,#4f7fe0);color:#fff;border:none;padding:8px 12px;display:inline-flex;align-items:center;gap:8px}',
      '.cc-cmd-az-cta:hover{filter:brightness(1.08)}',
      '.cc-cmd-az-link{margin-top:7px;font-size:11px;color:#7db8ef;cursor:pointer;display:inline-block}',
      '.cc-cmd-az-link:hover{text-decoration:underline}',
      '.cc-cmd-metrics{flex:1 1 200px;display:flex;flex-wrap:wrap;gap:8px;align-content:flex-start}',
      '.cc-cmd-chip{flex:0 0 auto;background:#0d1626;border:1px solid #233149;border-radius:9px;padding:7px 11px;min-width:74px}',
      '.cc-cmd-chip b{display:block;font-size:16px;font-weight:800;color:#dce6f5;line-height:1}',
      '.cc-cmd-chip span{font-size:8.5px;letter-spacing:.04em;text-transform:uppercase;color:#7d8ba3}',
      '.cc-cmd-chip.crit b{color:#f87171}.cc-cmd-chip.warn b{color:#fbbf24}',
      '.cc-cmd-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;padding-top:11px;border-top:1px solid #1f2c44}',
      '.cc-cmd-btn{cursor:pointer;border-radius:8px;font-weight:700;font-size:12px;background:#13203a;color:#cfe0f5;border:1px solid #2a3a55;padding:8px 12px;display:inline-flex;align-items:center;gap:7px}',
      '.cc-cmd-btn:hover{border-color:#418FDE;color:#fff}',
      '.cc-cmd-btn.primary{background:linear-gradient(90deg,#7c3aed,#4f7fe0);border:none;color:#fff}',
      '.cc-cmd-btn.danger{border-color:#7f1d1d;color:#f4a8a8}.cc-cmd-btn.danger:hover{background:#1d1113;color:#fff}',
      '.cc-cmd-btn.go{border-color:#14532d;color:#86efac}',
      '.cc-cmd-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.cc-cmd-recs{margin-top:10px}',
      '.cc-cmd-recs-h{font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#8aa0bf;margin-bottom:6px}',
      '.cc-cmd-rec{display:flex;align-items:center;gap:8px;background:#101d33;border:1px solid #233149;border-radius:8px;padding:7px 10px;margin-bottom:6px;font-size:12.5px;color:#cfe0f5}',
      '.cc-cmd-rec-go{margin-left:auto;background:#1c2b46;border:1px solid #2f4466;color:#9fd0ff;border-radius:7px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer}',
      '.cc-cmd-rec-go:hover{background:#243a5c}',
      '.cc-ov{position:fixed;inset:0;background:rgba(2,8,20,.66);backdrop-filter:blur(3px);z-index:100050;display:grid;place-items:center;padding:20px}',
      '.cc-ov-card{width:min(440px,94vw);background:#0e1626;border:1px solid #2a3a55;border-radius:14px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.6)}',
      '.cc-ov-card h3{margin:0 0 10px;font-size:15px;color:#e6edf7;display:flex;align-items:center;gap:9px}',
      '.cc-ov-blast{display:flex;gap:8px;margin:12px 0;flex-wrap:wrap}',
      '.cc-ov-bchip{background:#101d33;border:1px solid #233149;border-radius:9px;padding:8px 12px;text-align:center}',
      '.cc-ov-bchip b{display:block;font-size:18px;font-weight:800;color:#fbbf24}',
      '.cc-ov-bchip span{font-size:9px;text-transform:uppercase;color:#8aa0bf;letter-spacing:.04em}',
      '.cc-ov-msg{font-size:12.5px;color:#b7c6e0;line-height:1.5}',
      '.cc-ov-rsn{width:100%;margin-top:10px;background:#0b1422;border:1px solid #2a3a55;border-radius:8px;color:#e6edf7;padding:8px;font-size:13px;box-sizing:border-box}',
      '.cc-ov-row{display:flex;gap:9px;justify-content:flex-end;margin-top:14px}',
      '.cc-ov-row button{cursor:pointer;border-radius:8px;font-weight:700;font-size:12.5px;padding:8px 14px;border:1px solid #2a3a55;background:#13203a;color:#cfe0f5}',
      '.cc-ov-row button.go{background:linear-gradient(90deg,#7c3aed,#4f7fe0);border:none;color:#fff}',
      '.cc-ov-row button.danger{background:#7f1d1d;border:none;color:#fff}',
      '.cc-cmd-list{margin:6px 0 0;padding-left:18px;color:#b7c6e0;font-size:12.5px;line-height:1.6}',
    ].join('\n');
    document.head.appendChild(s);
  }

  // ── public: render the panel ────────────────────────────────────────────────
  function render(scope) {
    if (!scope || !scope.mountEl) return;
    ensureStyles();
    var el = scope.mountEl;
    el.classList.add('cc-cmd');
    el.innerHTML =
      '<div class="cc-cmd-bc">' + breadcrumb(scope) + '</div>' +
      '<div class="cc-cmd-top">' +
        '<div class="cc-cmd-analyze" data-cc-analyze><div class="cc-empty">Loading assessment…</div></div>' +
        '<div class="cc-cmd-metrics" data-cc-metrics></div>' +
      '</div>' +
      '<div class="cc-cmd-recs" data-cc-recs></div>' +
      '<div class="cc-cmd-actions" data-cc-actions>' + actionBar(scope) + '</div>';
    wireActions(el, scope);
    loadAssessment(scope, el);
  }

  function breadcrumb(scope) {
    if (scope.level === 'global') return '<b>Global</b> Command Center';
    if (scope.level === 'operation') {
      var n = (scope.data && (scope.data.name || scope.data.operation_name)) || 'Operation';
      return 'Global › <b>' + esc(n) + '</b> Command Center';
    }
    var bn = (scope.data && (scope.data.osm_name || scope.data.name)) || 'Building';
    return 'Global › Operation › <b>' + esc(bn) + '</b> Command Center';
  }

  // ── Analyze card + metrics ──────────────────────────────────────────────────
  function loadAssessment(scope, el) {
    if (scope.level === 'building') {   // building keeps its own console assessment
      var az = el.querySelector('[data-cc-analyze]');
      if (az) az.innerHTML = '<div class="cc-cmd-az-title"><i class="fa-solid fa-wand-magic-sparkles"></i> Building Assessment</div>'
        + '<div class="cc-cmd-az-sum">Run the consolidated AI assessment in the console below.</div>';
      renderMetrics(scope, el, scope.data || {});
      return;
    }
    fetch(assessUrl(scope), { headers: hdrs() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (a) { renderAnalyze(scope, el, a || {}); renderMetrics(scope, el, (a && a.counts) || {}); renderRecs(scope, el, a || {}); })
      .catch(function () { renderAnalyze(scope, el, {}); });
  }

  function renderAnalyze(scope, el, a) {
    var az = el.querySelector('[data-cc-analyze]'); if (!az) return;
    var label = scope.level === 'global' ? 'Global' : 'Operation';
    if (!a.assessed) {
      az.innerHTML =
        '<div class="cc-cmd-az-title"><i class="fa-solid fa-wand-magic-sparkles"></i> AI Situation Assessment</div>' +
        '<div class="cc-cmd-az-sum">One click synthesises the situation, key risks, escalation likelihood and the recommended actions for this ' + label.toLowerCase() + '.</div>' +
        '<button class="cc-cmd-az-cta" data-cc-run><i class="fa-solid fa-wand-magic-sparkles"></i> Analyze ' + label + '</button>';
    } else {
      var band = a.band || 'UNVERIFIED', col = BAND_COLOR[band] || '#8aa0bf';
      var cov = a.coverage || {};
      az.innerHTML =
        '<div class="cc-cmd-az-head">' +
          '<div class="cc-cmd-dial" style="color:' + col + '">' + (a.score == null ? '—' : a.score) + '<small>/100</small></div>' +
          '<div class="cc-cmd-az-meta">' +
            '<div class="cc-cmd-az-title">Situation Confidence <span class="cc-cmd-band" style="background:' + col + '22;color:' + col + '">' + esc(band) + '</span></div>' +
            '<div class="cc-cmd-az-sum">' + esc((a.situation_summary || '').slice(0, 220)) + '</div>' +
            '<span class="cc-cmd-az-link" data-cc-view>View full assessment →</span>' +
            (cov.total != null ? ' <span style="font-size:10.5px;color:#7d8ba3"> · ' + (cov.assessed || 0) + '/' + cov.total + ' assessed</span>' : '') +
          '</div>' +
        '</div>' +
        '<button class="cc-cmd-az-cta" data-cc-run style="margin-top:9px;background:#13203a;border:1px solid #2a3a55;color:#cfe0f5"><i class="fa-solid fa-rotate"></i> Re-analyze</button>';
    }
    var run = az.querySelector('[data-cc-run]'); if (run) run.onclick = function () { runAnalyze(scope, el, run); };
    var view = az.querySelector('[data-cc-view]'); if (view) view.onclick = function () { showAssessmentModal(scope); };
  }

  function renderMetrics(scope, el, c) {
    var m = el.querySelector('[data-cc-metrics]'); if (!m) return;
    // GLOBAL (the home): the Command Centre tiles already carry the authoritative
    // portfolio numbers, so the AI panel does NOT repeat them here (they used a
    // different aggregate => looked mismatched). Operation/Building panels keep
    // their own metric chips (no separate Command Centre tiles on those surfaces).
    if (scope.level === 'global') { m.innerHTML = ''; m.style.display = 'none'; return; }
    var chips = [];
    function chip(val, label, cls) { chips.push('<div class="cc-cmd-chip ' + (cls || '') + '"><b>' + nfmt(val) + '</b><span>' + label + '</span></div>'); }
    if (scope.level === 'operation') {
      chip(c.critical || 0, 'Critical', 'crit'); chip(c.unattended_critical || 0, 'Unattended', 'warn');
      chip(c.buildings || 0, 'Buildings'); chip(c.incidents || 0, 'Incidents');
      chip(c.reports || 0, 'Reports'); chip(c.responders || 0, 'Responders');
    } else {
      chip(c.report_count || 0, 'Reports'); chip(c.verified_report_count || 0, 'Verified');
      chip(c.responding_report_count || 0, 'Responding');
    }
    m.innerHTML = chips.join('');
  }

  function renderRecs(scope, el, a) {
    var box = el.querySelector('[data-cc-recs]'); if (!box) return;
    var recs = (a && a.recommended_actions) || [];
    if (!recs.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="cc-cmd-recs-h">⚡ Recommended actions</div>' + recs.map(function (r, i) {
      return '<div class="cc-cmd-rec"><i class="fa-solid fa-bolt" style="color:#fbbf24"></i> ' + esc(r.label) +
             '<button class="cc-cmd-rec-go" data-cc-rec="' + i + '">' + esc((r.action || '').toUpperCase()) + ' →</button></div>';
    }).join('');
    box.querySelectorAll('[data-cc-rec]').forEach(function (btn) {
      btn.onclick = function () {
        var r = recs[Number(btn.getAttribute('data-cc-rec'))]; if (!r) return;
        cascade(scope, r.action, r.filters || {}, r.label, r.scope);
      };
    });
  }

  // AI assessment runs ONLY on an explicit click (operator preference: no auto-run
  // on page load/refresh). A click analyses + opens the full assessment modal.
  function runAnalyze(scope, el, btn) {
    var fn = window.withBusy || function (b, f) { return f(); };
    fn(btn, function () {
      return fetch(assessUrl(scope), { method: 'POST', headers: hdrs() }).then(function (r) {
        if (r.status === 503) { toast('AI assessment unavailable (ANTHROPIC_API_KEY not set)', 'error'); return null; }
        if (!r.ok) { toast('Assessment failed', 'error'); return null; }
        return r.json();
      }).then(function (a) {
        if (!a) return;
        renderAnalyze(scope, el, a); renderMetrics(scope, el, a.counts || {}); renderRecs(scope, el, a);
        showAssessmentModal(scope, a);
      });
    });
  }

  function showAssessmentModal(scope, cached) {
    var go = function (a) {
      var band = a.band || 'UNVERIFIED', col = BAND_COLOR[band] || '#8aa0bf';
      var esc2 = function (x) { return esc(x); };
      var lst = function (arr) { return (arr && arr.length) ? '<ul class="cc-cmd-list">' + arr.map(function (x) { return '<li>' + esc2(x) + '</li>'; }).join('') + '</ul>' : '<div class="cc-cmd-az-sum">None noted.</div>'; };
      var el2 = a.escalation_likelihood || {};
      var html =
        '<div class="cc-cmd-az-head"><div class="cc-cmd-dial" style="color:' + col + '">' + (a.score == null ? '—' : a.score) + '<small>/100</small></div>' +
          '<div class="cc-cmd-az-meta"><div class="cc-cmd-az-title">Situation Confidence <span class="cc-cmd-band" style="background:' + col + '22;color:' + col + '">' + esc(band) + '</span></div>' +
          '<div class="cc-cmd-az-sum">' + esc(a.situation_summary || '') + '</div></div></div>' +
        '<div class="cc-cmd-recs-h" style="margin-top:12px">Key risks</div>' + lst(a.key_risks) +
        '<div class="cc-cmd-recs-h" style="margin-top:12px">Escalation likelihood</div>' +
          '<div class="cc-cmd-az-sum"><b style="color:#fbbf24">' + esc(el2.level || 'UNKNOWN') + '</b> — ' + esc(el2.rationale || '') + '</div>' +
        '<div class="cc-cmd-recs-h" style="margin-top:12px">Resource recommendations</div>' + lst(a.resource_recommendations) +
        (a.priority_score != null ? '<div class="cc-cmd-az-sum" style="margin-top:10px">Priority score: <b style="color:#e6edf7">' + a.priority_score + '/100</b></div>' : '');
      modal({ title: '<i class="fa-solid fa-wand-magic-sparkles"></i> ' + (scope.level === 'global' ? 'Global' : 'Operation') + ' Assessment', html: html, confirmLabel: 'Close', plain: true });
    };
    if (cached) return go(cached);
    fetch(assessUrl(scope), { headers: hdrs() }).then(function (r) { return r.ok ? r.json() : null; }).then(function (a) { if (a) go(a); });
  }

  // ── action bar (scoped cascades + nav) ──────────────────────────────────────
  function actionBar(scope) {
    if (scope.level === 'operation') {
      return btn('dispatch-uc', 'fa-truck-medical', 'Dispatch unattended-critical', 'primary')
           + btn('resolve-all', 'fa-circle-check', 'Resolve all', 'go')
           + btn('reject-noise', 'fa-ban', 'Reject noise', 'danger')
           + btn('open-feed', 'fa-list', 'Open Incident Feed', '');
    }
    if (scope.level === 'global') {
      return btn('dispatch-uc', 'fa-truck-medical', 'Dispatch all unattended-critical', 'primary')
           + btn('resolve-needs', 'fa-circle-check', 'Resolve a slice…', 'go')
           + btn('sitrep', 'fa-file-pdf', 'Export SITREP', '')
           + btn('worst-op', 'fa-bullseye', 'Open worst operation', '');
    }
    return '';   // building keeps its console actions
  }
  function btn(act, icon, label, cls) {
    return '<button class="cc-cmd-btn ' + (cls || '') + '" data-cc-act="' + act + '"><i class="fa-solid ' + icon + '"></i> ' + label + '</button>';
  }

  function wireActions(el, scope) {
    el.querySelectorAll('[data-cc-act]').forEach(function (b) {
      b.onclick = function () { handleAction(scope, b.getAttribute('data-cc-act')); };
    });
  }

  function handleAction(scope, act) {
    if (act === 'open-feed') { window.location.hash = '#/incidents;op=' + encodeURIComponent(scope.id); return; }
    if (act === 'worst-op') { return openWorstOp(); }
    if (act === 'sitrep') {
      try { window.__crispExportCtx = {}; } catch (_) {}
      window.location.hash = '#/exports'; toast('Open the SITREP export in the Export Center', 'info'); return;
    }
    if (act === 'dispatch-uc') return cascade(scope, 'dispatch', { queue: 'unattended_critical' }, 'Dispatch responders to all unattended-critical');
    if (act === 'resolve-all') return cascade(scope, 'resolve', {}, 'Resolve every open incident in this operation');
    if (act === 'resolve-needs') return cascade(scope, 'resolve', { queue: 'needs_response' }, 'Resolve the needs-response slice');
    if (act === 'reject-noise') return cascade(scope, 'reject', { queue: 'needs_review' }, 'Reject the needs-review slice as noise');
  }

  function openWorstOp() {
    fetch(api('/operations'), { headers: hdrs() }).then(function (r) { return r.ok ? r.json() : []; }).then(function (ops) {
      var live = (ops || []).filter(function (o) { return o && o.id && String(o.status || '').toUpperCase() !== 'ENDED'; });
      live.sort(function (a, b) { return (Number(b.critical) || 0) - (Number(a.critical) || 0); });
      if (live[0]) window.location.hash = '#/operations/' + encodeURIComponent(live[0].id);
      else toast('No active operations', 'info');
    });
  }

  // dry-run → blast-radius confirm → execute → toast + Undo
  function cascade(scope, action, filters, label, overrideScope) {
    var sc = overrideScope && overrideScope.scope_type
      ? { level: overrideScope.scope_type, id: overrideScope.scope_id } : scope;
    var needsReason = (action === 'reject' || action === 'false_alarm');
    fetch(cascadeUrl(sc, action), { method: 'POST', headers: hdrs(), body: JSON.stringify(cascadeBody(sc, action, filters, true)) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { toast(res.j && res.j.detail ? res.j.detail : 'Action not available', 'error'); return; }
        var c = (res.j && res.j.counts) || {};
        if (!c.reports) { toast('Nothing matches this action right now.', 'info'); return; }
        var blast =
          '<div class="cc-ov-blast">' +
            bchip(c.reports, 'Reports') + bchip(c.incidents, 'Incidents') +
            bchip(c.buildings, 'Buildings') + (c.responders ? bchip(c.responders, 'Responders') : '') +
          '</div>' +
          '<div class="cc-ov-msg">' + esc(label) + '. This percolates to every incident + report in the slice, in one transaction. Reversible via Undo.</div>';
        modal({
          title: '<i class="fa-solid fa-bolt" style="color:#fbbf24"></i> Confirm cascade',
          html: blast, confirmLabel: 'Apply to ' + nfmt(c.reports) + ' report' + (c.reports === 1 ? '' : 's'),
          danger: action === 'reject', needsReason: needsReason,
          onConfirm: function (reason, close, setBusy) {
            setBusy(true);
            var body = cascadeBody(sc, action, filters, false); if (reason) body.reason = reason;
            fetch(cascadeUrl(sc, action), { method: 'POST', headers: hdrs(), body: JSON.stringify(body) })
              .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
              .then(function (out) {
                close();
                if (!out.ok) { toast(out.j && out.j.detail ? out.j.detail : 'Action failed', 'error'); return; }
                var cc = (out.j && out.j.counts) || {};
                toastWithUndo(action + ': ' + nfmt(cc.reports) + ' report(s), ' + nfmt(cc.incidents) + ' incident(s)', out.j && out.j.log_id);
                try { if (typeof window.refreshAll === 'function') window.refreshAll(); else if (typeof window.renderFeed === 'function') window.renderFeed(); } catch (_) {}
              });
          },
        });
      })
      .catch(function () { toast('Action not available', 'error'); });
  }
  function bchip(n, label) { return '<div class="cc-ov-bchip"><b>' + nfmt(n || 0) + '</b><span>' + label + '</span></div>'; }

  function toastWithUndo(msg, logId) {
    toast(msg + (logId ? ' · click to Undo' : ''), 'success');
    if (!logId) return;
    // a lightweight undo affordance: a second confirm
    setTimeout(function () {
      var u = document.createElement('div'); u.className = 'cc-ov'; u.style.alignItems = 'flex-end'; u.style.background = 'transparent'; u.style.pointerEvents = 'none';
      u.innerHTML = '<div style="pointer-events:auto;margin:0 auto 22px;background:#13203a;border:1px solid #2a3a55;border-radius:10px;padding:8px 12px;display:flex;gap:10px;align-items:center;color:#cfe0f5;font-size:12.5px"><i class="fa-solid fa-clock-rotate-left"></i> Cascade applied <button class="go" style="cursor:pointer;border:none;border-radius:7px;background:#7c3aed;color:#fff;font-weight:700;padding:6px 11px">Undo</button></div>';
      document.body.appendChild(u);
      var kill = function () { try { u.remove(); } catch (_) {} };
      u.querySelector('button').onclick = function () {
        fetch(api('/reports/cascade-revert'), { method: 'POST', headers: hdrs(), body: JSON.stringify({ log_id: logId }) })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
          .then(function (out) { kill(); toast(out.ok ? ('Reverted ' + nfmt(out.j.reports_reverted) + ' report(s)') : 'Undo failed', out.ok ? 'success' : 'error');
            try { if (typeof window.refreshAll === 'function') window.refreshAll(); } catch (_) {} });
      };
      setTimeout(kill, 8000);
    }, 100);
  }

  // ── generic confirm/info modal ──────────────────────────────────────────────
  function modal(opts) {
    var ov = document.createElement('div'); ov.className = 'cc-ov';
    var reasonHtml = opts.needsReason ? '<textarea class="cc-ov-rsn" rows="2" placeholder="Reason (required)…"></textarea>' : '';
    var buttons = opts.plain
      ? '<button class="go" data-cc-ok>' + (opts.confirmLabel || 'OK') + '</button>'
      : '<button data-cc-cancel>Cancel</button><button class="' + (opts.danger ? 'danger' : 'go') + '" data-cc-ok>' + esc(opts.confirmLabel || 'Confirm') + '</button>';
    ov.innerHTML = '<div class="cc-ov-card"><h3>' + opts.title + '</h3>' + opts.html + reasonHtml +
      '<div class="cc-ov-row">' + buttons + '</div></div>';
    document.body.appendChild(ov);
    var close = function () { try { ov.remove(); } catch (_) {} document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    var cancel = ov.querySelector('[data-cc-cancel]'); if (cancel) cancel.onclick = close;
    var ok = ov.querySelector('[data-cc-ok]');
    ok.onclick = function () {
      if (opts.plain || !opts.onConfirm) return close();
      var reason = '';
      if (opts.needsReason) {
        var ta = ov.querySelector('.cc-ov-rsn'); reason = (ta && ta.value || '').trim();
        if (!reason) { if (ta) ta.style.borderColor = '#f87171'; return; }
      }
      opts.onConfirm(reason, close, function (busy) { ok.disabled = !!busy; ok.textContent = busy ? 'Working…' : (opts.confirmLabel || 'Confirm'); });
    };
  }

  window.CrispCommandPanel = { render: render };
})();
