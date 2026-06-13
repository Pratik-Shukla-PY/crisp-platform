/* crisp-shell.js — CRISP unified Command Center shell (global navigation bar).
 *
 * A single persistent top bar shown on EVERY authed surface (Operations,
 * Crisis Intelligence Center, Exports, Crisis Forms, Organisation, Users,
 * Account). Before this, only the Crisis Intelligence landing carried a nav;
 * the Operations view had no in-app way back to Home and every module wore a
 * different header. This file makes one shell own the chrome so the platform
 * reads as a single application instead of a stack of separate pages.
 *
 * It owns:
 *   • CRISP brand mark (→ Home) — the same ripple-tile used in the PWA/ops bar.
 *   • Primary nav <nav id="cc-nav">: Home · Operations · Exports · Crisis Forms ·
 *     Organisation · Users · Account. Reproduces the exact contract the landing
 *     used to render (data-route / data-intent="users" / admin items disabled
 *     with an "admin" chip) so the role-gating + control-center e2e specs keep
 *     passing — the bar is now the single #cc-nav.
 *   • LIVE freshness badge + the user/role/profile menu — RE-PARENTED from the
 *     ops command-bar (#cache-freshness-badge / #user-menu) so there is exactly
 *     one of each across the app and all existing app.js wiring (by id) keeps
 *     working untouched.
 *
 * Navigation goes through window.__crispRouter.navigate(); active state is read
 * from document.body[data-route] (which the router sets on every dispatch).
 *
 * Self-contained, like the cc-*.js modules: injects its own <style> once,
 * touches no other source file's internals, and never throws on boot. Loaded
 * LAST (after router.js) so window.__crispRouter + the cc-* launchers exist.
 */
(function () {
  'use strict';
  if (window.__crispShellLoaded) return;
  window.__crispShellLoaded = true;

  const el = (id) => document.getElementById(id);
  const token = () => { try { return localStorage.getItem('crisp_token'); } catch (_e) { return null; } };
  function currentUser() {
    try { return JSON.parse(localStorage.getItem('crisp_user') || '{}') || {}; }
    catch (_e) { return {}; }
  }
  function isAdmin() {
    const role = String(currentUser().role || '').toUpperCase();
    return role === 'ADMIN' || role === 'SUPER_ADMIN';
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const go = (r) => { try { if (window.__crispRouter) window.__crispRouter.navigate(r); } catch (_e) {} };

  // Backend base (mirror cc-home.js): dev → :8000, prod → same origin.
  const _LAN_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
  const _isLocalDev = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname)
    || _LAN_RE.test(window.location.hostname);
  const BACKEND_HOST = _isLocalDev ? `http://${window.location.hostname}:8000` : window.location.origin;

  // Org identity in the brand (single source of branding across every surface).
  async function loadOrg() {
    try {
      // no-store: org branding must be authoritative — never serve a stale
      // cached name after an admin updates it (see config.py GET / comment).
      const res = await fetch(`${BACKEND_HOST}/api/v1/config/`, { cache: 'no-store', headers: { Authorization: `Bearer ${token() || ''}` } });
      if (!res.ok) return;
      const body = await res.json();
      const org = body && body.org;
      const nm = el('cc-home-orgname');
      if (nm && org && org.org_public_name) nm.textContent = org.org_public_name;
    } catch (_e) { /* keep the CRISP fallback */ }
  }

  // Operator-local clock in the header (replaces the old landing-banner clock).
  function startClock() {
    const tick = () => {
      const c = el('cgn-clock');
      if (!c) return;
      const d = new Date();
      let tz = '';
      try {
        tz = (new Intl.DateTimeFormat([], { timeZoneName: 'short' })
          .formatToParts(d).find((p) => p.type === 'timeZoneName') || {}).value || '';
      } catch (_e) { /* label is optional */ }
      const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      c.textContent = tz ? `${time} ${tz}` : time;
    };
    tick();
    if (window.__cgnClock) clearInterval(window.__cgnClock);
    window.__cgnClock = setInterval(tick, 30000);
  }

  const BAR_ID = 'crisp-globalnav';
  // The ripple-tile CRISP mark — identical to index.html .command-bar .brand-icon
  // and the PWA home brand, so branding is consistent across every surface.
  const LOGO_SVG =
    '<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="CRISP">' +
    '<defs><linearGradient id="cgn-tile" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#22455F"/><stop offset="1" stop-color="#163349"/></linearGradient></defs>' +
    '<rect width="256" height="256" rx="44" fill="url(#cgn-tile)"/>' +
    '<circle cx="128" cy="128" r="106" fill="none" stroke="#5EEAD4" stroke-width="4.5" opacity="0.3"/>' +
    '<circle cx="128" cy="128" r="81" fill="none" stroke="#2DD4BF" stroke-width="5.5" opacity="0.5"/>' +
    '<circle cx="128" cy="128" r="56" fill="none" stroke="#22D3EE" stroke-width="7" opacity="0.78"/>' +
    '<circle cx="128" cy="128" r="31" fill="none" stroke="#67E8F9" stroke-width="8"/>' +
    '<circle cx="128" cy="128" r="13" fill="#67E8F9"/>' +
    '<circle cx="184" cy="72" r="9" fill="#FB7185"/></svg>';

  // route → nav button that should read as the active section. Both /users
  // buttons map to /users; the Account button (no data-intent) is the primary
  // active target — "Users" is a sub-destination (the admin user-management tab).
  const ROUTE_LABEL = {
    '/': 'Home', '/operations': 'Operations', '/incidents': 'Incidents',
    '/exports': 'Exports',
    '/reporting': 'Crisis Forms', '/org': 'Organisation', '/users': 'Account',
  };

  // ── styles (injected once) ───────────────────────────────────────────────
  function injectStyles() {
    if (el('crisp-shell-styles')) return;
    const css = `
    :root{--gnav-h:52px}
    #${BAR_ID}{position:fixed;top:0;left:0;right:0;height:var(--gnav-h);z-index:100001;
      display:flex;align-items:center;gap:14px;padding:0 16px;overflow:visible;
      background:rgba(11,18,32,.94);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);
      border-bottom:1px solid rgba(255,255,255,.08);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
      color:#E6EDF7}
    html[dir="rtl"] #${BAR_ID}{direction:rtl}
    /* brand */
    .cgn-brand{display:inline-flex;align-items:center;gap:9px;cursor:pointer;flex:none;background:none;border:0;
      padding:0;font-family:inherit}
    .cgn-brand:focus-visible{outline:2px solid #418FDE;outline-offset:3px;border-radius:8px}
    /* the brand mark IS the Home link — show a "you are here" cue on the root */
    .cgn-brand.on .cgn-org{color:#7db8ef}
    .cgn-brand.on .cgn-logo{box-shadow:0 0 0 2px rgba(65,143,222,.55);border-radius:8px}
    .cgn-logo{width:30px;height:30px;border-radius:8px;overflow:hidden;flex:none;display:block}
    .cgn-logo svg{width:100%;height:100%;display:block}
    .cgn-word{display:flex;flex-direction:column;line-height:1.12;text-align:start;min-width:0}
    .cgn-org{font-size:13.5px;font-weight:800;letter-spacing:.01em;color:#fff;max-width:230px;
      overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .cgn-sub{font-size:9px;color:#8A99B5;text-transform:uppercase;letter-spacing:.08em;white-space:nowrap}
    .cgn-clock{font-size:11.5px;color:#8A99B5;font-variant-numeric:tabular-nums;white-space:nowrap;flex:none}
    /* primary nav */
    #${BAR_ID} #cc-nav{display:flex;align-items:center;gap:7px;flex-wrap:nowrap;overflow-x:auto;
      scrollbar-width:none;min-width:0}
    #${BAR_ID} #cc-nav::-webkit-scrollbar{display:none}
    #${BAR_ID} #cc-nav button{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;
      background:#141F35;border:1px solid #2C3A52;border-radius:999px;padding:6px 13px;color:#cdd8ec;
      font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
    #${BAR_ID} #cc-nav button:hover{border-color:#418FDE;color:#fff}
    #${BAR_ID} #cc-nav button:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
    #${BAR_ID} #cc-nav button[disabled]{opacity:.45;cursor:not-allowed}
    #${BAR_ID} #cc-nav button.on{border-color:#418FDE;color:#7db8ef;background:rgba(65,143,222,.12)}
    #${BAR_ID} #cc-nav .ad{font-size:9px;font-weight:700;color:#fbbf24;background:rgba(251,191,36,.14);
      padding:1px 6px;border-radius:999px;margin-left:2px;text-transform:uppercase}
    .cgn-spacer{flex:1 1 auto;min-width:8px}
    /* right cluster — hosts the re-parented LIVE badge + user menu */
    .cgn-right{display:flex;align-items:center;gap:12px;flex:none}
    #${BAR_ID} .live-badge{margin:0}
    #${BAR_ID} #user-menu{flex:none}
    /* hamburger (mobile) */
    .cgn-burger{display:none;align-items:center;justify-content:center;width:36px;height:36px;flex:none;
      background:#141F35;border:1px solid #2C3A52;border-radius:9px;color:#cdd8ec;cursor:pointer;font-size:15px}
    .cgn-burger:hover{border-color:#418FDE;color:#fff}
    .cgn-burger:focus-visible{outline:2px solid #418FDE;outline-offset:2px}

    /* ── page offsets (only while the shell is mounted) ───────────────────── */
    body.crisp-has-globalnav .dashboard-container{margin-top:var(--gnav-h);height:calc(100vh - var(--gnav-h))}
    /* the ops command-bar's brand/LIVE/profile moved into the shell → hide the
       now-empty duplicate so there is one logo + one profile across the app */
    body.crisp-has-globalnav .command-bar .brand{display:none}
    /* route-level overlays clear the fixed bar */
    body.crisp-has-globalnav #cc-home-overlay,
    body.crisp-has-globalnav #cc-ex-overlay,
    body.crisp-has-globalnav #cc-st-overlay,
    body.crisp-has-globalnav #cc-ops-overlay,
    body.crisp-has-globalnav #cc-cf-overlay{padding-top:var(--gnav-h);box-sizing:border-box}
    /* Transient FULLSCREEN viewers/modals are focused tasks — they must cover
       the shell bar (the nav is contextually unavailable while they're open),
       not sit under it with their top controls clipped. Raise them above the
       bar's z-index (100001). The route-level section overlays (cc-*) stay
       BELOW the bar on purpose, so cross-module nav stays reachable. */
    body.crisp-has-globalnav .pswp,
    body.crisp-has-globalnav .dp-compare-overlay,
    body.crisp-has-globalnav .ai-logic-overlay,
    body.crisp-has-globalnav .lightbox-overlay,
    body.crisp-has-globalnav .bc-reason-modal-overlay{z-index:100010}
    body.crisp-has-globalnav .lightbox-close{z-index:100011}
    /* Top-of-viewport alert strip sits just BELOW the bar (both are top:0
       fixed), so its dismiss control isn't intercepted by the bar. */
    body.crisp-has-globalnav .truncation-banner{top:var(--gnav-h)}
    /* The bell now lives in the shell — its dropdown panel must open ABOVE the
       route-level section overlays (99990-99999) so it's usable on Home /
       Exports / etc., not trapped behind the open overlay. The center-screen
       toasts (.notif-stack / .notif-burst-banner) deliberately keep their
       original layer so they surface in the Operations context only — on Home
       the dedicated #cgn-home-alert banner is the (subtler) awareness cue,
       avoiding a stacked double-alert. */
    body.crisp-has-globalnav .notif-panel{z-index:100002}

    /* ── Home "new incidents" alert (shell-owned; route '/' only) ──────────── */
    #cgn-home-alert{position:fixed;top:var(--gnav-h);left:0;right:0;z-index:100000;display:none;
      align-items:center;gap:12px;padding:8px 16px;font-size:13px;font-weight:600;color:#fff;
      background:linear-gradient(90deg,rgba(37,99,235,.96),rgba(34,211,238,.9));
      border-bottom:1px solid rgba(255,255,255,.16);box-shadow:0 6px 18px rgba(0,0,0,.28);
      font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    #cgn-home-alert.show{display:flex}
    #cgn-home-alert.crit{background:linear-gradient(90deg,rgba(239,68,68,.96),rgba(251,146,60,.92))}
    #cgn-home-alert .cgn-ha-msg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #cgn-home-alert .cgn-ha-review{background:rgba(255,255,255,.18);border:1px solid rgba(255,255,255,.55);
      color:#fff;border-radius:7px;padding:5px 13px;font-size:12px;font-weight:700;cursor:pointer;
      font-family:inherit;white-space:nowrap}
    #cgn-home-alert .cgn-ha-review:hover{background:rgba(255,255,255,.3)}
    #cgn-home-alert .cgn-ha-x{background:none;border:0;color:rgba(255,255,255,.85);cursor:pointer;
      font-size:15px;line-height:1;padding:2px 6px}
    #cgn-home-alert .cgn-ha-x:hover{color:#fff}
    /* When the alert shows, push the Home content (and its sticky sub-header)
       down so nothing hides behind it. */
    body.crisp-has-globalnav.crisp-home-alert #cc-home-overlay{padding-top:calc(var(--gnav-h) + 42px)}

    /* ── Operation context (Phase 2e — triple-cue safety on /operations/{id}) ── */
    /* Cue 1: colored operation chrome — an accent underline on the global bar. */
    body.crisp-has-globalnav.crisp-op-scoped #${BAR_ID}{
      box-shadow:0 2px 0 var(--op-color,#418FDE),0 8px 24px rgba(0,0,0,.35)}
    /* Cue 2+3: persistent context banner with breadcrumb + "Exit to global". */
    #cgn-context-banner{position:fixed;top:var(--gnav-h);left:0;right:0;z-index:100000;display:none;
      align-items:center;gap:12px;height:30px;padding:0 16px;font-size:12.5px;color:#E6EDF7;
      background:rgba(11,18,32,.97);border-bottom:2px solid var(--op-color,#418FDE);
      font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    body.crisp-op-scoped #cgn-context-banner{display:flex}
    #cgn-context-banner .cgn-cb-dot{width:8px;height:8px;border-radius:50%;background:var(--op-color,#418FDE);flex:none}
    #cgn-context-banner .cgn-cb-crumb{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9fb3d1}
    #cgn-context-banner .cgn-cb-crumb b{color:#E6EDF7;font-weight:700}
    #cgn-context-banner .cgn-cb-exit{background:#1b2942;border:1px solid #33476a;border-radius:7px;padding:4px 12px;
      color:#dce6f5;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap}
    #cgn-context-banner .cgn-cb-exit:hover{border-color:var(--op-color,#418FDE);color:#fff}
    /* Push the operation overlay below the banner while op-scoped. */
    body.crisp-has-globalnav.crisp-op-scoped #cc-ops-overlay{padding-top:calc(var(--gnav-h) + 30px)}
    /* notification panel deep-link shortcuts (markup in index.html #notif-panel) */
    .notif-panel-footer{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:9px 12px;
      border-top:1px solid rgba(255,255,255,.07);background:rgba(255,255,255,.02)}
    .notif-panel-footer .notif-footer-label{font-size:9.5px;font-weight:700;letter-spacing:.06em;
      text-transform:uppercase;color:#64748b;width:100%}
    .notif-panel-footer button{display:inline-flex;align-items:center;gap:5px;background:#141f35;
      border:1px solid #2c3a52;border-radius:999px;padding:5px 11px;color:#cdd8ec;font-size:11px;
      font-weight:600;cursor:pointer;font-family:inherit}
    .notif-panel-footer button:hover{border-color:#418fde;color:#fff}

    /* ── responsive ───────────────────────────────────────────────────────── */
    @media (max-width:860px){
      .cgn-sub{display:none}
      .cgn-org{max-width:150px}
    }
    @media (max-width:640px){
      #${BAR_ID}{gap:10px;padding:0 12px}
      .cgn-word{display:none}      /* logo-only brand on mobile */
      .cgn-clock{display:none}     /* time hidden on mobile to keep the bar compact */
      .cgn-burger{display:inline-flex}
      #${BAR_ID} #cc-nav{position:absolute;top:var(--gnav-h);left:0;right:0;display:none;
        flex-direction:column;align-items:stretch;gap:5px;padding:10px 12px;overflow:auto;max-height:72vh;
        background:rgba(11,18,32,.98);border-bottom:1px solid rgba(255,255,255,.10);
        box-shadow:0 16px 40px rgba(0,0,0,.45)}
      body.crisp-nav-open #${BAR_ID} #cc-nav{display:flex}
      #${BAR_ID} #cc-nav button{justify-content:flex-start;border-radius:10px;padding:10px 12px;font-size:13px}
    }
    `;
    const tag = document.createElement('style');
    tag.id = 'crisp-shell-styles';
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // ── nav markup (reuses the landing's exact contract) ─────────────────────
  function navHtml() {
    const admin = isAdmin();
    const b = (route, glyph, label, adminOnly, intent) =>
      `<button data-route="${route}" ${intent ? `data-intent="${intent}"` : ''}` +
      `${adminOnly && !admin ? ' disabled aria-disabled="true"' : ''}>` +
      `<span aria-hidden="true">${glyph}</span> ${esc(label)}` +
      `${adminOnly && !admin ? '<span class="ad">admin</span>' : ''}</button>`;
    return [
      // No "Home" item — the CRISP brand mark (left) is the Home affordance
      // (aria-label "go to Home"); a separate Home button was redundant.
      // Operations (the operation-centric workspace) is primary; Incidents is
      // the raw global report feed.
      b('/operations', '🎯', 'Operations', false),
      b('/incidents', '🛰', 'Incidents', false),
      b('/exports', '⬇', 'Exports', false),
      b('/reporting', '🧩', 'Crisis Forms', true),
      b('/org', '🏛', 'Organisation', true),
      b('/users', '👥', 'Users', true, 'users'),
      b('/users', '👤', 'Account', false),
    ].join('');
  }

  // ── build the bar ────────────────────────────────────────────────────────
  function buildBar() {
    if (el(BAR_ID)) return el(BAR_ID);
    injectStyles();
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.setAttribute('role', 'banner');
    bar.innerHTML =
      `<button class="cgn-brand" id="cgn-brand" title="CRISP — Home" aria-label="CRISP — go to Home">
         <span class="cgn-logo" aria-hidden="true">${LOGO_SVG}</span>
         <span class="cgn-word">
           <span class="cgn-org" id="cc-home-orgname">CRISP</span>
           <span class="cgn-sub">Crisis Intelligence</span>
         </span>
       </button>
       <nav id="cc-nav" aria-label="Primary">${navHtml()}</nav>
       <span class="cgn-spacer"></span>
       <span class="cgn-right" id="cgn-right"><span class="cgn-clock" id="cgn-clock" title="Local time">—</span></span>
       <button class="cgn-burger" id="cgn-burger" aria-label="Toggle navigation" aria-expanded="false"
               aria-controls="cc-nav">☰</button>`;
    document.body.insertBefore(bar, document.body.firstChild);
    document.body.classList.add('crisp-has-globalnav');

    // brand → Home
    el('cgn-brand').addEventListener('click', () => { closeMobileNav(); go('/'); });

    // nav clicks (event-delegated so it survives a re-render of navHtml)
    el('cc-nav').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-route]');
      if (!btn || btn.hasAttribute('disabled')) return;
      // Deep-link intent: "Users" lands on the Users tab inside Account settings.
      if (btn.getAttribute('data-intent') === 'users') window.__ccSettingsInitialTab = 'users';
      closeMobileNav();
      go(btn.getAttribute('data-route'));
    });

    // hamburger (mobile)
    el('cgn-burger').addEventListener('click', () => {
      const open = document.body.classList.toggle('crisp-nav-open');
      el('cgn-burger').setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    reparentChrome();
    setActive(currentRoute());
    return bar;
  }

  function closeMobileNav() {
    if (document.body.classList.contains('crisp-nav-open')) {
      document.body.classList.remove('crisp-nav-open');
      const b = el('cgn-burger');
      if (b) b.setAttribute('aria-expanded', 'false');
    }
  }

  // Move the canonical LIVE badge + user/role/profile menu out of the ops
  // command-bar into the shell. Re-parenting preserves their ids + listeners,
  // so app.js (_updateCacheBadge / _initUserMenu / _toggleUserMenu /
  // _maybeShowModerationButton / crispLogout) keeps driving them unchanged, and
  // they stay visible even when the router hides #view-incidents.
  function reparentChrome() {
    const right = el('cgn-right');
    if (!right) return false;
    // Enforce order: LIVE badge · clock · notification bell · role+profile menu
    // (per the brief: Live · time · 🔔 · role · profile). Re-appending in this
    // sequence each call keeps the order stable across the boot retry; #cgn-clock
    // is the shell's own element, the others are re-parented from the command-bar.
    const clock = el('cgn-clock');
    const badge = el('cache-freshness-badge');
    const notif = el('notif-area');
    const menu = el('user-menu');
    [badge, clock, notif, menu].forEach((n) => { if (n) right.appendChild(n); });
    return !!(badge && menu && notif);
  }

  // ── active-state (driven by the router's body[data-route]) ───────────────
  function currentRoute() {
    const r = document.body.getAttribute('data-route');
    if (r) return r;
    // Before the first router dispatch, derive from the hash so the bar paints
    // the right active item on cold load.
    try {
      if (window.__crispRouter && window.__crispRouter.parseHash) {
        const p = window.__crispRouter.parseHash();
        if (p && p.route && p.route !== '__unknown__') return p.route;
      }
    } catch (_e) {}
    return '/';
  }
  function setActive(route) {
    const nav = el('cc-nav');
    if (!nav) return;
    const label = ROUTE_LABEL[route] || ROUTE_LABEL['/'];
    nav.querySelectorAll('button').forEach((btn) => {
      // The Account button (data-route="/users", no intent) owns the /users
      // highlight; skip the "Users" admin sub-destination button.
      const isUsersSub = btn.getAttribute('data-route') === '/users' && btn.getAttribute('data-intent') === 'users';
      const txt = (btn.textContent || '').trim();
      const match = !isUsersSub && txt.indexOf(label) !== -1;
      btn.classList.toggle('on', match);
      if (match) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
    // Home has no nav button — the brand mark IS the Home affordance, so it
    // carries the "you are here" cue on the root route.
    const brand = el('cgn-brand');
    if (brand) {
      const onHome = route === '/';
      brand.classList.toggle('on', onHome);
      if (onHome) brand.setAttribute('aria-current', 'page');
      else brand.removeAttribute('aria-current');
    }
  }

  // ── Home "new incidents" alert ───────────────────────────────────────────
  // One shared source: app.js owns the notifications (single _unseenReports +
  // bell), exposes window.__crispNotifSummary(), and fires 'crisp:notif-change'
  // on every render. The shell surfaces that on the Home route so an operator
  // who never opened Operations still sees incoming reports. Counts are
  // inherently synced (same source) — no duplicates possible.
  let _homeAlertDismissed = 0;   // suppress until MORE arrive than were dismissed
  function notifSummary() {
    try {
      const s = window.__crispNotifSummary && window.__crispNotifSummary();
      return s && typeof s.count === 'number' ? s : { count: 0, critical: false };
    } catch (_e) { return { count: 0, critical: false }; }
  }
  function ensureHomeAlert() {
    let a = el('cgn-home-alert');
    if (a) return a;
    a = document.createElement('div');
    a.id = 'cgn-home-alert';
    a.setAttribute('role', 'status');
    a.setAttribute('aria-live', 'polite');
    a.innerHTML = '<span class="cgn-ha-msg"></span>' +
      '<button class="cgn-ha-review" type="button">Review</button>' +
      '<button class="cgn-ha-x" type="button" aria-label="Dismiss new-incident alert">✕</button>';
    document.body.appendChild(a);
    a.querySelector('.cgn-ha-review').addEventListener('click', () => {
      const s = notifSummary();
      closeMobileNav();
      // Critical arrivals jump straight to the Critical queue; otherwise the feed.
      if (s.critical) { try { window.location.hash = '#/incidents;queue=critical'; } catch (_e) { go('/incidents'); } }
      else go('/incidents');
      hideHomeAlert(true);
    });
    a.querySelector('.cgn-ha-x').addEventListener('click', () => hideHomeAlert(true));
    return a;
  }
  function hideHomeAlert(markDismissed) {
    const a = el('cgn-home-alert');
    if (a) a.classList.remove('show');
    document.body.classList.remove('crisp-home-alert');
    if (markDismissed) _homeAlertDismissed = notifSummary().count;
  }
  function updateHomeAlert() {
    const s = notifSummary();
    if (s.count === 0) _homeAlertDismissed = 0;            // reset baseline once cleared
    const show = currentRoute() === '/' && s.count > 0 && s.count > _homeAlertDismissed;
    if (!show) { hideHomeAlert(false); return; }
    const a = ensureHomeAlert();
    const msg = a.querySelector('.cgn-ha-msg');
    if (s.critical) {
      msg.innerHTML = '⚠ <strong>Critical incident received</strong>' + (s.count > 1 ? ' · ' + s.count + ' new awaiting review' : '');
    } else {
      msg.innerHTML = '🔔 <strong>' + s.count + '</strong> new incident' + (s.count > 1 ? 's' : '') + ' — awaiting review';
    }
    a.classList.toggle('crit', !!s.critical);
    a.classList.add('show');
    document.body.classList.add('crisp-home-alert');
  }

  function watchRoute() {
    const onChange = () => { setActive(currentRoute()); updateHomeAlert(); };
    try {
      const obs = new MutationObserver(onChange);
      obs.observe(document.body, { attributes: true, attributeFilter: ['data-route'] });
    } catch (_e) {}
    // hashchange is a belt-and-braces fallback if data-route ever lags.
    window.addEventListener('hashchange', onChange);
    // Notification changes (new arrivals / dismissals) refresh the Home alert.
    window.addEventListener('crisp:notif-change', updateHomeAlert);
    updateHomeAlert();
  }

  // ── Operation context (Phase 2e) — driven directly by cc-operations.js ─────
  // We drive this via an explicit hook rather than inferring from data-route:
  // the route stays '/operations' across /operations/A → /operations/B (same
  // base), so the data-route MutationObserver wouldn't fire, and the operation
  // name/colour aren't in the hash anyway. cc-operations calls setOpContext on
  // open and clearOpContext on close / list / exit.
  function ensureContextBanner() {
    let b = el('cgn-context-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'cgn-context-banner';
      b.innerHTML = '<span class="cgn-cb-dot"></span>'
        + '<span class="cgn-cb-crumb"></span>'
        + '<button class="cgn-cb-exit" type="button">Exit to global ✕</button>';
      document.body.appendChild(b);
      b.querySelector('.cgn-cb-exit').addEventListener('click', () => {
        try { window.__crispRouter ? window.__crispRouter.navigate('/') : (location.hash = '#/'); }
        catch (_e) { location.hash = '#/'; }
      });
    }
    return b;
  }
  function setOpContext(id, name, color) {
    const b = ensureContextBanner();
    document.body.style.setProperty('--op-color', color || '#418FDE');
    const crumb = b.querySelector('.cgn-cb-crumb');
    if (crumb) crumb.innerHTML = 'CRISP / Operations / <b>' + esc(name || 'Operation') + '</b>';
    document.body.classList.add('crisp-op-scoped');
  }
  function clearOpContext() {
    document.body.classList.remove('crisp-op-scoped');
    document.body.style.removeProperty('--op-color');
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  function boot() {
    if (!token()) return;          // only the authed dashboard; login is a separate page
    buildBar();
    watchRoute();
    loadOrg();
    startClock();
    // The ops chrome + cc-* launcher items can render slightly after us; retry
    // the re-parent + admin-state-dependent nav for a short window (mirrors the
    // existing injectLauncher() pollers).
    let tries = 0;
    const iv = setInterval(() => {
      const done = reparentChrome();
      // re-render nav once we can read the real role (admin gating)
      const nav = el('cc-nav');
      if (nav && !nav.__roleApplied && currentUser().role) {
        nav.innerHTML = navHtml();
        nav.__roleApplied = true;
        setActive(currentRoute());
      }
      if ((done && nav && nav.__roleApplied) || ++tries > 25) clearInterval(iv);
    }, 200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // public API (tests + manual triggers)
  window.__crispShell = { buildBar, setActive, reparentChrome, navHtml, setOpContext, clearOpContext };
})();
