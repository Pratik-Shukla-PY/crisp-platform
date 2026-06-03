/* cc-home.js — Control Center landing (self-contained, additive).
 *
 * A Vercel/Linear-style post-login landing shown over the dashboard: a clean
 * header (CRISP + org logo/name), a "Good {time}, {name}" hero, exactly four
 * primary action cards, an optional quick-status strip + recent-activity list,
 * and a "skip next time" preference.
 *
 * Design principle (operator brief): "Do NOT remove any existing capability.
 * Only simplify access to it." So this is a pure overlay:
 *   • The existing incident feed / map / analytics render underneath, untouched.
 *   • Card 1 "Monitor & Respond" simply dismisses the landing → the feed is
 *     revealed (already booted by app.js). Cards 2-4 call the existing launchers
 *     (window.openAccountSettings / openOrgSettings / openCrisisForms).
 *   • Reachable again any time via the user-menu "Control Center" item or
 *     window.openControlCenter().
 *   • app.js / styles.css are NOT touched (this file + one <script> tag).
 */
(function () {
  'use strict';
  if (window.__ccHomeLoaded) return;
  window.__ccHomeLoaded = true;

  const SKIP_KEY = 'crisp_cc_skip_landing';
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
  function greeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  }
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
  async function jget(path) {
    const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token() || ''}` } });
    if (!res.ok) throw new Error(String(res.status));
    return { body: await res.json(), headers: res.headers };
  }

  // ── styles ─────────────────────────────────────────────────────────────────
  function injectStyles() {
    if (el('cc-home-styles')) return;
    const css = `
    #cc-home-overlay{position:fixed;inset:0;z-index:99990;display:none;overflow:auto;
      background:radial-gradient(1200px 600px at 70% -10%,rgba(124,92,255,.16),transparent 60%),
        radial-gradient(900px 500px at 0% 110%,rgba(34,211,238,.10),transparent 55%),var(--bg,#080c14)}
    #cc-home-overlay.cc-home-open{display:block}
    .cc-home-wrap{max-width:1080px;margin:0 auto;padding:22px 20px 40px;min-height:100%;display:flex;flex-direction:column}
    .cc-home-head{display:flex;align-items:center;gap:12px;margin-bottom:30px}
    .cc-home-brand{display:flex;align-items:center;gap:11px;min-width:0}
    .cc-home-logo{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,#7c5cff,#22d3ee);
      display:grid;place-items:center;font-weight:800;color:#fff;flex:none;overflow:hidden}
    .cc-home-logo img{width:100%;height:100%;object-fit:contain}
    .cc-home-brand .nm{font-weight:700;font-size:15px;color:var(--text,#f1f5f9);line-height:1.2;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cc-home-brand .sub{font-size:11.5px;color:var(--text-dim,#6b7689)}
    .cc-home-head .cc-home-actions{margin-left:auto;display:flex;align-items:center;gap:8px}
    .cc-home-ico{width:36px;height:36px;border-radius:9px;border:1px solid var(--border-2,rgba(255,255,255,.14));
      background:var(--surface-2,#141c2b);color:var(--text-sub,#aab4c5);cursor:pointer;font-size:14px;display:grid;place-items:center}
    .cc-home-ico:hover{color:#fff;border-color:var(--accent,#7c5cff)}
    .cc-home-avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#7c5cff,#22d3ee);
      color:#fff;display:grid;place-items:center;font-weight:700;font-size:14px;flex:none}
    .cc-home-hero{margin:0 0 4px;font-size:30px;font-weight:800;letter-spacing:-.02em;color:var(--text,#f1f5f9)}
    @media(max-width:560px){.cc-home-hero{font-size:24px}}
    .cc-home-tagline{color:var(--text-sub,#aab4c5);font-size:14px;margin:0 0 22px}
    .cc-home-cards{display:grid;grid-template-columns:1fr 1fr;gap:14px}
    @media(max-width:720px){.cc-home-cards{grid-template-columns:1fr}}
    .cc-home-card{position:relative;text-align:left;background:var(--surface,#0e1420);border:1px solid var(--border,rgba(255,255,255,.10));
      border-radius:16px;padding:20px;cursor:pointer;color:var(--text,#f1f5f9);transition:.16s;display:flex;gap:15px;align-items:flex-start;width:100%;font-family:inherit}
    .cc-home-card:hover{border-color:var(--accent,#7c5cff);transform:translateY(-2px);background:var(--surface-2,#141c2b)}
    .cc-home-card:focus-visible{outline:none;box-shadow:0 0 0 3px rgba(124,58,237,.45)}
    .cc-home-card[disabled]{cursor:not-allowed;opacity:.55}
    .cc-home-card[disabled]:hover{transform:none;border-color:var(--border,rgba(255,255,255,.10));background:var(--surface,#0e1420)}
    .cc-home-card .ci{width:46px;height:46px;border-radius:12px;display:grid;place-items:center;font-size:20px;flex:none}
    .cc-home-card .ct{font-weight:700;font-size:16px;margin:0 0 4px}
    .cc-home-card .cd{font-size:12.5px;color:var(--text-dim,#6b7689);line-height:1.5}
    .cc-home-card .cb{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-dim,#6b7689);margin-top:8px;display:inline-block}
    .cc-home-c1 .ci{background:rgba(239,68,68,.14);color:#fca5a5}
    .cc-home-c2 .ci{background:rgba(34,211,238,.14);color:#67e8f9}
    .cc-home-c3 .ci{background:rgba(124,92,255,.16);color:#c4b5fd}
    .cc-home-c4 .ci{background:rgba(16,185,129,.15);color:#5ee9b5}
    .cc-home-strip{display:flex;gap:10px;flex-wrap:wrap;margin:22px 0 0}
    .cc-home-stat{background:var(--surface,#0e1420);border:1px solid var(--border,rgba(255,255,255,.09));border-radius:11px;padding:11px 15px;min-width:120px}
    .cc-home-stat .n{font-size:20px;font-weight:800}
    .cc-home-stat .l{font-size:11px;color:var(--text-dim,#6b7689);margin-top:2px;text-transform:uppercase;letter-spacing:.04em}
    .cc-home-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}
    .cc-home-act{margin-top:24px;background:var(--surface,#0e1420);border:1px solid var(--border,rgba(255,255,255,.09));border-radius:14px;padding:6px 4px}
    .cc-home-act h3{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-sub,#aab4c5);margin:10px 14px 6px;font-weight:700}
    .cc-home-act-row{display:flex;align-items:center;gap:10px;padding:9px 14px;border-top:1px solid var(--border,rgba(255,255,255,.06));font-size:13px}
    .cc-home-act-row .sv{width:8px;height:8px;border-radius:50%;flex:none}
    .cc-home-act-row .tx{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cc-home-act-row .ag{color:var(--text-dim,#6b7689);font-size:11.5px;flex:none}
    .cc-home-foot{margin-top:auto;padding-top:22px;display:flex;align-items:center;gap:10px;color:var(--text-dim,#6b7689);font-size:12px}
    .cc-home-skip{display:flex;align-items:center;gap:7px;cursor:pointer;user-select:none}
    .cc-home-skip input{width:auto;cursor:pointer}
    `;
    const tag = document.createElement('style');
    tag.id = 'cc-home-styles';
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // ── overlay ──────────────────────────────────────────────────────────────────
  function ensureOverlay() {
    let ov = el('cc-home-overlay');
    if (ov) return ov;
    injectStyles();
    ov = document.createElement('div');
    ov.id = 'cc-home-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'CRISP Control Center');
    document.body.appendChild(ov);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ov.classList.contains('cc-home-open')) { if (window.__crispRouter) window.__crispRouter.navigate('/incidents'); else closeLanding(); }
    });
    return ov;
  }

  function closeLanding() {
    const ov = el('cc-home-overlay');
    if (ov) ov.classList.remove('cc-home-open');
  }

  const SEV_COLOR = {
    CRITICAL: '#f87171', SEVERE: '#fb923c', MODERATE: '#fbbf24', MINOR: '#4ade80', UNKNOWN: '#64748b',
  };

  function cardsHtml() {
    const admin = isAdmin();
    const card = (cls, icon, iconGlyph, title, desc, badge, disabled) => `
      <button class="cc-home-card ${cls}" data-act="${cls}" ${disabled ? 'disabled aria-disabled="true"' : ''}
        aria-label="${esc(title)}">
        <div class="ci">${iconGlyph}</div>
        <div style="min-width:0"><div class="ct">${esc(title)}</div><div class="cd">${esc(desc)}</div>
          ${badge ? `<span class="cb">${esc(badge)}</span>` : ''}</div>
      </button>`;
    return [
      card('cc-home-c1', '', '🛰', 'Monitor & Respond to Incidents',
        'Live incident feed, map, triage, dispatch & satellite verification.', 'Open the operations feed', false),
      card('cc-home-c2', '', '👤', 'Account Settings',
        'Your profile, password, two-factor, active sessions & audit log.', '', false),
      card('cc-home-c3', '', '🏛', 'Organisation Settings',
        'Identity, branding, logo, contact & channel overview.', admin ? '' : 'Admin only',
        !admin),
      card('cc-home-c4', '', '🧩', 'Crisis Forms & PWA Templates',
        'Geo-scoped crisis question packs, per-channel previews & versions.', admin ? '' : 'Admin only',
        !admin),
    ].join('');
  }

  async function openLanding() {
    if (!token()) return;
    ensureOverlay();
    const ov = el('cc-home-overlay');
    const user = currentUser();
    const name = (user.full_name || user.email || '').split('@')[0] || 'there';
    const initial = (name[0] || 'U').toUpperCase();
    ov.innerHTML = `
      <div class="cc-home-wrap">
        <div class="cc-home-head">
          <div class="cc-home-brand">
            <div class="cc-home-logo" id="cc-home-logo">C</div>
            <div><div class="nm" id="cc-home-orgname">CRISP Control Center</div>
              <div class="sub">Crisis Response Intelligence</div></div>
          </div>
          <div class="cc-home-actions">
            <button class="cc-home-ico" id="cc-home-bell" aria-label="Notifications" title="Notifications">🔔</button>
            <button class="cc-home-ico" id="cc-home-gear" aria-label="Account settings" title="Account settings">⚙</button>
            <div class="cc-home-avatar" title="${esc(user.email || '')}">${esc(initial)}</div>
          </div>
        </div>
        <h1 class="cc-home-hero">${esc(greeting())}, ${esc(name)}</h1>
        <p class="cc-home-tagline">Where would you like to start?</p>
        <div class="cc-home-cards" id="cc-home-cards">${cardsHtml()}</div>
        <div class="cc-home-strip" id="cc-home-strip"></div>
        <div id="cc-home-activity"></div>
        <!-- Mandatory Control Center root — no skip control. -->
      </div>`;
    ov.classList.add('cc-home-open');

    // card actions → route navigation (the router shows the module + hides the rest)
    const go = (r) => { try { (window.__crispRouter ? window.__crispRouter.navigate : noop)(r); } catch (_e) {} };
    ov.querySelectorAll('.cc-home-card').forEach((b) => b.addEventListener('click', () => {
      if (b.hasAttribute('disabled')) return;
      const act = b.getAttribute('data-act');
      if (act === 'cc-home-c1') go('/incidents');
      else if (act === 'cc-home-c2') go('/users');
      else if (act === 'cc-home-c3') go('/org');
      else if (act === 'cc-home-c4') go('/reporting');
    }));
    el('cc-home-gear').addEventListener('click', () => go('/users'));
    el('cc-home-bell').addEventListener('click', () => go('/incidents'));
    // focus the first card for keyboard users
    const first = ov.querySelector('.cc-home-card');
    if (first) try { first.focus(); } catch (_) {}

    loadOrg();
    loadStatusAndActivity();
  }
  function noop() {}

  async function loadOrg() {
    try {
      const { body } = await jget('/config/');
      const org = body && body.org;
      if (!org) return;
      const nm = el('cc-home-orgname');
      if (nm && org.org_public_name) nm.textContent = org.org_public_name;
      if (org.org_logo_url) {
        const lg = el('cc-home-logo');
        if (lg) lg.innerHTML = `<img src="${esc(BACKEND_HOST + org.org_logo_url)}" alt="logo">`;
      }
    } catch (_) { /* defaults stand */ }
  }

  async function loadStatusAndActivity() {
    // Quick-status strip + recent activity from one reports fetch (best-effort).
    try {
      const { body, headers } = await jget('/reports/?limit=5');
      const reports = Array.isArray(body) ? body : (body && (body.items || body.reports)) || [];
      const total = headers.get('X-Total-Count') || (Array.isArray(body) ? body.length : reports.length);
      const open = reports.filter((r) => ['PENDING', 'TRIAGE', 'VERIFYING'].includes(String(r.status || '').toUpperCase())).length;
      const strip = el('cc-home-strip');
      if (strip) strip.innerHTML = `
        <div class="cc-home-stat"><div class="n">${esc(total)}</div><div class="l">Reports tracked</div></div>
        <div class="cc-home-stat"><div class="n">${esc(open)}<span style="font-size:12px;color:var(--text-dim,#6b7689)"> of last 5</span></div><div class="l">Need triage</div></div>
        <div class="cc-home-stat"><div class="n"><span class="cc-home-dot" style="background:${navigator.onLine ? '#10b981' : '#ef4444'}"></span>${navigator.onLine ? 'Online' : 'Offline'}</div><div class="l">Connectivity</div></div>`;
      const act = el('cc-home-activity');
      if (act && reports.length) {
        act.className = 'cc-home-act';
        act.innerHTML = `<h3>Recent activity</h3>` + reports.slice(0, 5).map((r) => {
          const sv = SEV_COLOR[String(r.severity || 'UNKNOWN').toUpperCase()] || '#64748b';
          const what = [r.crisis_type, r.infrastructure_type].filter(Boolean).map((x) => String(x).replace(/_/g, ' ')).join(' · ') || 'Report';
          return `<div class="cc-home-act-row"><span class="sv" style="background:${sv}"></span>
            <span class="tx">${esc(what)}${r.infrastructure_name ? ' — ' + esc(r.infrastructure_name) : ''}</span>
            <span class="ag">${esc(timeAgo(r.server_created_at))}</span></div>`;
        }).join('');
      }
    } catch (_) { /* strip/activity omitted on failure — never blocks the landing */ }
  }

  // ── launcher (user-menu item) + boot ────────────────────────────────────────
  function injectLauncher() {
    try {
      const dropdown = el('user-menu-dropdown');
      if (!dropdown || el('cc-home-launch')) return;
      const btn = document.createElement('button');
      btn.id = 'cc-home-launch'; btn.className = 'user-menu-item';
      btn.innerHTML = `<i class="fa-solid fa-grip"></i> Control Center`;
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
    // Auto-show the landing on first load after login, unless the user opted out.
    // Suppressed under automation (navigator.webdriver) so the dashboard's
    // existing feed-driven e2e specs aren't blocked by the overlay; a force flag
    // (crisp_cc_force_landing) re-enables it for the Control-Center spec itself.
    // The router (router.js) owns when the Control Center shows (route '/').
    // No auto-show / skip here anymore — the Control Center is the mandatory root.
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // public API (reachable from the menu + tests)
  window.openControlCenter = openLanding;
  window.__ccHome = { openLanding, closeLanding };
})();
