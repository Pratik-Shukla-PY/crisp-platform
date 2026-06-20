/* cc-settings.js - Account + Organisation Settings (self-contained).
 *
 * Two admin/user settings modules in one file, each launched from the existing
 * user-menu and rendered in a shared overlay shell:
 *   • Account  (window.openAccountSettings) - Profile · Security · Sessions ·
 *     Audit (admin) · Users (admin). Wires to existing /api/v1/auth endpoints.
 *   • Organisation (window.openOrgSettings) - Branding (name/contact/colour/
 *     logo) · Channels (read-only). Single-org config via /api/v1/config/org
 *     (config-blob backed; NO tenant concept, NO migration).
 *
 * Deliberately self-contained, exactly like cc-crisis.js:
 *   • app.js and styles.css are NOT touched (this file + two <script> tags).
 *   • All ids / classes are cc-st- prefixed; CSS injected once.
 *   • Auth + backend-host derivation mirror app.js / cc-crisis.js.
 *   • Boots defensively - any failure here must never break the dashboard.
 */
(function () {
  'use strict';
  if (window.__ccSettingsLoaded) return;
  window.__ccSettingsLoaded = true;

  // ── auth + API base (mirror cc-crisis.js) ──────────────────────────────────
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
  const AUTH_API = `${BACKEND_HOST}/api/v1/auth`;
  const CONFIG_API = `${BACKEND_HOST}/api/v1/config`;

  // ── tiny helpers ───────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const el = (id) => document.getElementById(id);
  // D6: shared busy/double-submit guard from app.js (disables the control + spins
  // a button label during an async action). Falls back to a bare call if app.js
  // hasn't exposed it yet, so settings never hard-depends on load order.
  const busy = (b, fn) => (typeof window.withBusy === 'function' ? window.withBusy(b, fn) : (typeof fn === 'function' ? fn() : undefined));
  function fmtDate(s) {
    if (!s) return '-';
    // Shared dashboard format (app.js __ccFmtDateTime: "11 Jun 2026,
    // 2:45 PM", operator-local, ensureUTC-hardened parse). Fallback keeps
    // the old rendering if app.js hasn't exposed the helper yet.
    const shared = window.__ccFmtDateTime;
    if (shared) { const out = shared(s); return out || '-'; }
    const d = new Date(s);
    return isNaN(d.getTime()) ? '-' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  async function api(method, path, body, base) {
    const opts = { method, headers: { Authorization: `Bearer ${token() || ''}` } };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch((base || AUTH_API) + path, opts);
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_e) { data = text; }
    if (!res.ok) {
      let msg = res.statusText;
      if (data && typeof data === 'object' && 'detail' in data) {
        msg = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
      } else if (typeof data === 'string' && data) { msg = data; }
      const err = new Error(msg); err.status = res.status; err.data = data; throw err;
    }
    return data;
  }

  let _toastTimer = null;
  function toast(msg, kind) {
    let t = el('cc-st-toast');
    if (!t) { t = document.createElement('div'); t.id = 'cc-st-toast'; document.body.appendChild(t); }
    t.className = ''; t.classList.add('cc-st-show');
    if (kind === 'err') t.classList.add('cc-st-toast--err');
    if (kind === 'ok') t.classList.add('cc-st-toast--ok');
    t.textContent = msg;
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => { t.classList.remove('cc-st-show'); }, 3200);
  }

  // ── state ──────────────────────────────────────────────────────────────────
  const S = {
    mode: 'account',           // 'account' | 'org'
    tab: 'profile',
    busy: false,
    me: null, users: null, sessions: null, audit: null, org: null,
    loaded: {},                // tab → true once fetched
  };
  const ACCOUNT_TABS = [
    ['profile', 'Profile'], ['security', 'Security'], ['sessions', 'Sessions'],
    ['audit', 'Audit', true], ['users', 'Users', true],
  ];
  const ORG_TABS = [['branding', 'Branding'], ['channels', 'Channels']];
  const LANGS = [['en', 'English'], ['ar', 'العربية'], ['zh', '中文'], ['fr', 'Français'], ['ru', 'Русский'], ['es', 'Español']];

  // ── styles (injected once) ───────────────────────────────────────────────────
  function injectStyles() {
    if (el('cc-st-styles')) return;
    const css = `
    #cc-st-overlay{position:fixed;inset:0;z-index:99998;display:none;background:rgba(4,7,12,.72);
      backdrop-filter:blur(3px);overflow:auto;padding:24px 16px}
    #cc-st-overlay.cc-st-open{display:block}
    .cc-st-shell{max-width:1080px;margin:0 auto;background:var(--bg,#080c14);border:1px solid var(--border,rgba(255,255,255,.09));
      border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.6);overflow:hidden;font-size:14px;color:var(--text,#f1f5f9)}
    .cc-st-top{display:flex;align-items:center;gap:14px;padding:16px 20px;border-bottom:1px solid var(--border,rgba(255,255,255,.09))}
    .cc-st-logo{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#7c5cff,#22d3ee);
      display:grid;place-items:center;font-weight:800;color:#fff;flex:none}
    .cc-st-top h2{font-size:17px;margin:0;font-weight:700}
    .cc-st-top .cc-st-sub{color:var(--text-dim,#6b7689);font-size:12.5px;margin-top:2px}
    .cc-st-x{margin-left:auto;background:transparent;border:1px solid var(--border-2,rgba(255,255,255,.14));color:var(--text-sub,#aab4c5);
      width:34px;height:34px;border-radius:9px;cursor:pointer;font-size:16px;line-height:1}
    .cc-st-x:hover{color:#fff;border-color:var(--accent,#7c5cff)}
    .cc-st-tabs{display:flex;gap:6px;padding:12px 20px 0;flex-wrap:wrap}
    .cc-st-tab{background:transparent;border:0;border-bottom:2px solid transparent;color:var(--text-sub,#aab4c5);
      padding:8px 14px;font-size:13.5px;font-weight:600;cursor:pointer}
    .cc-st-tab.on{color:#fff;border-bottom-color:var(--accent,#7c5cff)}
    .cc-st-body{padding:18px 20px 24px}
    .cc-st-card{background:var(--surface,#0e1420);border:1px solid var(--border,rgba(255,255,255,.09));border-radius:14px;padding:16px;margin-bottom:14px}
    .cc-st-card h3{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-sub,#aab4c5);margin:0 0 12px;font-weight:700}
    .cc-st-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .cc-st-spacer{flex:1}
    .cc-st-fld{margin:0 0 12px}
    .cc-st-lbl{display:block;font-size:12px;color:var(--text-sub,#aab4c5);margin:0 0 5px}
    .cc-st-input,.cc-st-select{width:100%;background:var(--surface-2,#141c2b);border:1px solid var(--border-2,rgba(255,255,255,.14));
      color:var(--text,#f1f5f9);border-radius:9px;padding:9px 10px;font-size:13.5px;font-family:inherit}
    .cc-st-input:focus,.cc-st-select:focus{outline:none;border-color:var(--accent,#7c5cff)}
    .cc-st-grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    @media(max-width:680px){.cc-st-grid2{grid-template-columns:1fr}}
    .cc-st-btn{border:1px solid var(--border-2,rgba(255,255,255,.14));background:var(--surface-2,#141c2b);color:var(--text,#f1f5f9);
      border-radius:9px;padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer}
    .cc-st-btn:hover{border-color:var(--accent,#7c5cff)}
    .cc-st-btn.primary{background:linear-gradient(135deg,#7c5cff,#22d3ee);border:0;color:#fff}
    .cc-st-btn.ghost{background:transparent;color:var(--text-sub,#aab4c5)}
    .cc-st-btn.danger{border-color:rgba(239,68,68,.5);color:#ffb4b4}
    .cc-st-btn.sm{padding:6px 11px;font-size:12px}
    .cc-st-btn[disabled]{opacity:.5;cursor:not-allowed}
    .cc-st-table{width:100%;border-collapse:collapse;font-size:13px}
    .cc-st-table th{text-align:left;color:var(--text-dim,#6b7689);font-weight:600;font-size:11px;text-transform:uppercase;
      letter-spacing:.05em;padding:0 10px 9px;border-bottom:1px solid var(--border,rgba(255,255,255,.09))}
    .cc-st-table td{padding:10px;border-bottom:1px solid var(--border,rgba(255,255,255,.09));vertical-align:middle}
    .cc-st-pill{font-size:11px;padding:3px 9px;border-radius:999px;font-weight:600;white-space:nowrap;text-transform:uppercase;letter-spacing:.04em}
    .cc-st-pill.ok{background:rgba(16,185,129,.15);color:#5ee9b5}
    .cc-st-pill.off{background:rgba(107,118,137,.18);color:#9aa6b8}
    .cc-st-pill.warn{background:rgba(245,158,11,.15);color:#fbd38d}
    .cc-st-pill.role{background:rgba(124,92,255,.16);color:#c4b5fd}
    .cc-st-hint{font-size:11.5px;color:var(--text-dim,#6b7689);margin:6px 0 0}
    .cc-st-empty{color:var(--text-dim,#6b7689);font-size:13px;text-align:center;padding:22px;border:1px dashed var(--border-2,rgba(255,255,255,.14));border-radius:9px}
    .cc-st-meta{font-size:12px;color:var(--text-sub,#aab4c5)}
    .cc-st-meta b{color:var(--text,#f1f5f9);font-weight:600}
    .cc-st-logo-prev{width:64px;height:64px;border-radius:12px;background:var(--surface-2,#141c2b);border:1px solid var(--border-2,rgba(255,255,255,.14));
      display:grid;place-items:center;overflow:hidden;flex:none}
    .cc-st-logo-prev img{width:100%;height:100%;object-fit:contain}
    .cc-st-ch{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}
    .cc-st-ch-card{background:var(--surface-2,#141c2b);border:1px solid var(--border,rgba(255,255,255,.09));border-radius:11px;padding:13px 14px}
    .cc-st-ch-card .n{font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px}
    .cc-st-ch-card .d{color:var(--text-dim,#6b7689);font-size:11.5px;margin-top:5px}
    #cc-st-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(20px);z-index:100001;
      background:var(--surface-3,#1b2538);border:1px solid var(--border-2,rgba(255,255,255,.14));color:var(--text,#f1f5f9);
      padding:11px 18px;border-radius:10px;font-size:13px;font-weight:600;opacity:0;pointer-events:none;transition:.22s;max-width:80vw}
    #cc-st-toast.cc-st-show{opacity:1;transform:translateX(-50%) translateY(0)}
    #cc-st-toast.cc-st-toast--err{border-color:rgba(239,68,68,.6);color:#ffd2d2}
    #cc-st-toast.cc-st-toast--ok{border-color:rgba(16,185,129,.5)}
    `;
    const tag = document.createElement('style');
    tag.id = 'cc-st-styles';
    tag.textContent = css;
    document.head.appendChild(tag);
  }

  // ── overlay shell ────────────────────────────────────────────────────────────
  function ensureOverlay() {
    let ov = el('cc-st-overlay');
    if (ov) return ov;
    injectStyles();
    ov = document.createElement('div');
    ov.id = 'cc-st-overlay';
    ov.innerHTML = `
      <div class="cc-st-shell" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="cc-st-top">
          <div class="cc-st-logo">⚙</div>
          <div><h2 id="cc-st-title">Settings</h2><div class="cc-st-sub" id="cc-st-sub"></div></div>
          <button class="cc-st-x" id="cc-st-close" aria-label="Close">✕</button>
        </div>
        <div class="cc-st-tabs" id="cc-st-tabs"></div>
        <div class="cc-st-body" id="cc-st-body"></div>
      </div>`;
    document.body.appendChild(ov);
    // Close → return to the Control Center root when routed; else just hide.
    const _exit = () => { if (window.__crispRouter) window.__crispRouter.navigate('/'); else closeOverlay(); };
    el('cc-st-close').addEventListener('click', _exit);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) _exit(); });
    document.addEventListener('keydown', (e) => {
      if (!ov.classList.contains('cc-st-open')) return;
      if (e.key === 'Escape') { _exit(); return; }
      if (e.key === 'Tab') trapTab(e, ov);
    });
    return ov;
  }
  function closeOverlay() {
    const ov = el('cc-st-overlay');
    if (ov) ov.classList.remove('cc-st-open');
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
  function openOverlay(mode) {
    if (!token()) { toast('Please sign in first.', 'err'); return; }
    ensureOverlay();
    S.mode = mode === 'org' ? 'org' : 'account';
    S.loaded = {};
    S.tab = S.mode === 'org' ? 'branding' : 'profile';
    // One-shot deep-link from the Crisis Intelligence command bar ("Users"
    // should land ON the Users tab, not the profile). Honoured only when the
    // requested tab is visible for this role; always consumed so a stale
    // intent can't leak into a later open.
    try {
      const want = window.__ccSettingsInitialTab;
      window.__ccSettingsInitialTab = null;
      if (want && S.mode === 'account' && visibleTabs().some((t) => t[0] === want)) S.tab = want;
    } catch (_e) { /* deep-link is best-effort */ }
    el('cc-st-overlay').classList.add('cc-st-open');
    el('cc-st-title').textContent = S.mode === 'org' ? 'Organisation Settings' : 'Account Settings';
    el('cc-st-sub').textContent = S.mode === 'org'
      ? 'Identity, branding & channels for your deployment'
      : (currentUser().email || '');
    renderTabs();
    render();
    try { const x = el('cc-st-close'); if (x) x.focus(); } catch (_e) {}   // move focus into the modal (a11y)
  }

  function visibleTabs() {
    const list = S.mode === 'org' ? ORG_TABS : ACCOUNT_TABS;
    return list.filter((t) => !t[2] || isAdmin());   // t[2] = admin-only
  }
  function renderTabs() {
    const wrap = el('cc-st-tabs');
    wrap.innerHTML = visibleTabs().map(([k, label]) =>
      `<button class="cc-st-tab ${k === S.tab ? 'on' : ''}" data-tab="${k}">${esc(label)}</button>`).join('');
    wrap.querySelectorAll('.cc-st-tab').forEach((b) => b.addEventListener('click', () => {
      S.tab = b.getAttribute('data-tab'); renderTabs(); render();
    }));
  }

  function render() {
    const body = el('cc-st-body');
    if (!body) return;
    if (S.mode === 'org') {
      if (S.tab === 'branding') return renderOrgBranding(body);
      if (S.tab === 'channels') return renderOrgChannels(body);
    } else {
      if (S.tab === 'profile') return renderProfile(body);
      if (S.tab === 'security') return renderSecurity(body);
      if (S.tab === 'sessions') return renderSessions(body);
      if (S.tab === 'audit') return renderAudit(body);
      if (S.tab === 'users') return renderUsers(body);
    }
  }

  function loadingBody(body, label) { body.innerHTML = `<div class="cc-st-empty">Loading ${esc(label)}…</div>`; }
  function errorBody(body, err) {
    body.innerHTML = `<div class="cc-st-card"><div class="cc-st-empty" style="border-color:rgba(239,68,68,.4);color:#ffb4b4">${esc(err.message || 'Failed to load.')}</div></div>`;
  }

  // ── ACCOUNT · Profile ─────────────────────────────────────────────────────────
  async function renderProfile(body) {
    if (!S.me) {
      loadingBody(body, 'profile');
      try { S.me = await api('GET', '/me'); } catch (e) { return errorBody(body, e); }
    }
    const m = S.me;
    body.innerHTML = `
      <div class="cc-st-card">
        <h3>Profile</h3>
        <div class="cc-st-grid2">
          <div class="cc-st-fld"><label class="cc-st-lbl">Full name</label><input class="cc-st-input" id="cc-st-name" value="${esc(m.full_name || '')}"></div>
          <div class="cc-st-fld"><label class="cc-st-lbl">Email (read-only)</label><input class="cc-st-input" value="${esc(m.email || '')}" disabled></div>
        </div>
        <div class="cc-st-row" style="gap:8px;margin-top:2px">
          <span class="cc-st-pill role">${esc(m.role || 'USER')}</span>
          ${m.mfa_enabled ? '<span class="cc-st-pill ok">MFA on</span>' : '<span class="cc-st-pill off">MFA off</span>'}
          ${m.is_verified ? '<span class="cc-st-pill ok">Verified</span>' : '<span class="cc-st-pill warn">Unverified</span>'}
        </div>
        <p class="cc-st-hint">Member since ${fmtDate(m.created_at)} · ${m.login_count || 0} logins · last ${fmtDate(m.last_login_at)}.</p>
        <div class="cc-st-row" style="margin-top:12px">
          <button class="cc-st-btn" id="cc-st-gdpr-export"
                  title="Download everything CRISP stores about your account (profile, sessions, audit trail, linked reports) as JSON - your data-access right.">
            ⬇ Download my account data</button>
          <div class="cc-st-spacer"></div>
          <button class="cc-st-btn primary" id="cc-st-save-profile">Save changes</button></div>
      </div>`;
    // Data-subject access right (UNDP Privacy Policy Annex 2 (f)) - the
    // backend /auth/me/data-export endpoint previously had NO UI consumer
    // anywhere (export audit finding). JSON blob download, same pattern as
    // the PWA's "Export my data".
    el('cc-st-gdpr-export').addEventListener('click', async () => {
      try {
        const data = await api('GET', '/me/data-export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        a.href = URL.createObjectURL(blob);
        a.download = `crisp-account-data-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1500);
        toast('Account data downloaded.', 'ok');
      } catch (e) { toast('Export failed: ' + e.message, 'err'); }
    });
    el('cc-st-save-profile').addEventListener('click', (ev) => busy(ev.currentTarget, async () => {
      const full_name = el('cc-st-name').value.trim();
      if (!full_name) { toast('Name cannot be empty.', 'err'); return; }
      try {
        await api('PATCH', '/me', { full_name });
        S.me.full_name = full_name;
        try { const u = currentUser(); u.full_name = full_name; localStorage.setItem('crisp_user', JSON.stringify(u)); } catch (_) {}
        toast('Profile saved.', 'ok');
      } catch (e) { toast('Save failed: ' + e.message, 'err'); }
    }));
  }

  // ── ACCOUNT · Security ──────────────────────────────────────────────────────
  async function renderSecurity(body) {
    if (!S.me) { try { S.me = await api('GET', '/me'); } catch (_) {} }
    const mfa = S.me && S.me.mfa_enabled;
    body.innerHTML = `
      <div class="cc-st-card">
        <h3>Change password</h3>
        <div class="cc-st-fld"><label class="cc-st-lbl">Current password</label><input class="cc-st-input" type="password" id="cc-st-cur-pw" autocomplete="current-password"></div>
        <div class="cc-st-grid2">
          <div class="cc-st-fld"><label class="cc-st-lbl">New password</label><input class="cc-st-input" type="password" id="cc-st-new-pw" autocomplete="new-password"></div>
          <div class="cc-st-fld"><label class="cc-st-lbl">Confirm new password</label><input class="cc-st-input" type="password" id="cc-st-new-pw2" autocomplete="new-password"></div>
        </div>
        <p class="cc-st-hint">At least 8 characters with a mix of letters, numbers &amp; symbols.</p>
        <div class="cc-st-row" style="margin-top:10px"><div class="cc-st-spacer"></div>
          <button class="cc-st-btn primary" id="cc-st-save-pw">Update password</button></div>
      </div>
      <div class="cc-st-card">
        <h3>Two-factor authentication</h3>
        <div class="cc-st-row"><span class="cc-st-pill ${mfa ? 'ok' : 'off'}">${mfa ? 'Enabled' : 'Disabled'}</span>
          <span class="cc-st-meta">TOTP authenticator app${mfa ? ' is protecting this account.' : ' is not configured.'}</span></div>
        <p class="cc-st-hint">${mfa
          ? 'Your account requires a 6-digit code at login.'
          : 'MFA enrolment is managed during sign-in. Contact your administrator to enable TOTP for this account.'}</p>
      </div>`;
    el('cc-st-save-pw').addEventListener('click', (ev) => busy(ev.currentTarget, async () => {
      const cur = el('cc-st-cur-pw').value, np = el('cc-st-new-pw').value, np2 = el('cc-st-new-pw2').value;
      if (!cur || !np) { toast('Enter your current and new password.', 'err'); return; }
      if (np !== np2) { toast('New passwords do not match.', 'err'); return; }
      try {
        await api('PATCH', '/me', { current_password: cur, new_password: np });
        el('cc-st-cur-pw').value = el('cc-st-new-pw').value = el('cc-st-new-pw2').value = '';
        toast('Password updated.', 'ok');
      } catch (e) { toast(e.message || 'Update failed.', 'err'); }
    }));
  }

  // ── ACCOUNT · Sessions ──────────────────────────────────────────────────────
  async function renderSessions(body) {
    loadingBody(body, 'sessions');
    let rows;
    try { rows = await api('GET', '/sessions'); } catch (e) { return errorBody(body, e); }
    S.sessions = Array.isArray(rows) ? rows : [];
    const list = S.sessions.length ? S.sessions.map((s) => `<tr>
        <td>${esc(s.device || 'Unknown device')}</td>
        <td class="cc-st-meta">${esc(s.ip || '-')}</td>
        <td class="cc-st-meta">${fmtDate(s.created_at)}</td>
        <td class="cc-st-meta">${fmtDate(s.expires_at)}</td>
        <td><button class="cc-st-btn sm danger" data-revoke="${esc(s.id)}">Revoke</button></td>
      </tr>`).join('')
      : `<tr><td colspan="5"><div class="cc-st-empty">No active sessions.</div></td></tr>`;
    body.innerHTML = `
      <div class="cc-st-card">
        <h3>Active sessions</h3>
        <table class="cc-st-table"><thead><tr><th>Device</th><th>IP</th><th>Started</th><th>Expires</th><th></th></tr></thead>
          <tbody>${list}</tbody></table>
        <p class="cc-st-hint">Revoking signs that device out on its next request.</p>
      </div>`;
    body.querySelectorAll('[data-revoke]').forEach((b) => b.addEventListener('click', () => {
      const id = b.getAttribute('data-revoke');
      if (!window.confirm('Revoke this session?')) return;
      return busy(b, async () => {
        try { await api('DELETE', '/sessions/' + encodeURIComponent(id)); toast('Session revoked.', 'ok'); render(); }
        catch (e) { toast('Revoke failed: ' + e.message, 'err'); }
      });
    }));
  }

  // ── ACCOUNT · Audit (admin) ─────────────────────────────────────────────────
  async function renderAudit(body) {
    loadingBody(body, 'audit log');
    let rows;
    try { rows = await api('GET', '/audit-log'); } catch (e) { return errorBody(body, e); }
    S.audit = Array.isArray(rows) ? rows : [];
    const opts = ['<option value="">All events</option>']
      .concat([...new Set(S.audit.map((l) => l.action).filter(Boolean))].sort()
        .map((a) => `<option value="${esc(a)}">${esc(a)}</option>`)).join('');
    body.innerHTML = `
      <div class="cc-st-card">
        <div class="cc-st-row"><h3 style="margin:0">Audit log</h3><div class="cc-st-spacer"></div>
          <select class="cc-st-select" id="cc-st-audit-filter" style="width:auto">${opts}</select></div>
        <table class="cc-st-table" style="margin-top:10px"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Resource</th><th>IP</th></tr></thead>
          <tbody id="cc-st-audit-rows">${auditRows(S.audit)}</tbody></table>
        <p class="cc-st-hint">Most recent 500 events.</p>
      </div>`;
    el('cc-st-audit-filter').addEventListener('change', (e) => {
      const v = e.target.value;
      const filtered = v ? S.audit.filter((l) => l.action === v) : S.audit;
      el('cc-st-audit-rows').innerHTML = auditRows(filtered);
    });
  }
  function auditRows(list) {
    if (!list.length) return `<tr><td colspan="5"><div class="cc-st-empty">No audit events.</div></td></tr>`;
    return list.map((l) => `<tr>
      <td class="cc-st-meta">${fmtDate(l.created_at)}</td>
      <td class="cc-st-meta">${esc(l.user_email || '-')}</td>
      <td><span class="cc-st-pill role">${esc(l.action || '-')}</span></td>
      <td class="cc-st-meta">${esc([l.resource_type, l.resource_id].filter(Boolean).join(' · ') || '-')}</td>
      <td class="cc-st-meta">${esc(l.ip_address || '-')}</td>
    </tr>`).join('');
  }

  // ── ACCOUNT · Users (admin) ─────────────────────────────────────────────────
  const ROLES = ['SUPER_ADMIN', 'ADMIN', 'ANALYST', 'VIEWER', 'REPORTER'];
  async function renderUsers(body) {
    loadingBody(body, 'users');
    let rows;
    try { rows = await api('GET', '/users'); } catch (e) { return errorBody(body, e); }
    S.users = Array.isArray(rows) ? rows : [];
    const myId = (S.me && S.me.id) || currentUser().id;
    const list = S.users.map((u) => {
      const self = u.id === myId;
      return `<tr>
        <td><div style="font-weight:600">${esc(u.full_name || '-')}</div><div class="cc-st-meta">${esc(u.email)}</div></td>
        <td><select class="cc-st-select cc-st-role" data-id="${esc(u.id)}" ${self ? 'disabled title="You cannot change your own role"' : ''} style="width:auto;padding:5px 8px">
          ${ROLES.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
        <td><span class="cc-st-pill ${u.is_active ? 'ok' : 'off'}">${u.is_active ? 'Active' : 'Disabled'}</span></td>
        <td class="cc-st-meta">${fmtDate(u.last_login_at)}</td>
        <td><div class="cc-st-row" style="gap:6px;flex-wrap:nowrap">
          <button class="cc-st-btn sm" data-toggle="${esc(u.id)}" ${self ? 'disabled' : ''}>${u.is_active ? 'Disable' : 'Enable'}</button>
          <button class="cc-st-btn sm danger" data-del="${esc(u.id)}" ${self || u.role === 'SUPER_ADMIN' ? 'disabled' : ''}>Delete</button>
        </div></td>
      </tr>`;
    }).join('');
    body.innerHTML = `
      <div class="cc-st-card">
        <h3>Users &amp; roles (${S.users.length})</h3>
        <table class="cc-st-table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead>
          <tbody>${list || `<tr><td colspan="5"><div class="cc-st-empty">No users.</div></td></tr>`}</tbody></table>
        <p class="cc-st-hint">In-organisation user management. Changing a role takes effect on the user's next request.</p>
      </div>`;
    body.querySelectorAll('.cc-st-role').forEach((sel) => sel.addEventListener('change', () => busy(sel, async () => {
      const id = sel.getAttribute('data-id');
      try { await api('PATCH', '/users/' + encodeURIComponent(id), { role: sel.value }); toast('Role updated.', 'ok'); }
      catch (e) { toast('Update failed: ' + e.message, 'err'); render(); }
    })));
    body.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => busy(b, async () => {
      const id = b.getAttribute('data-toggle');
      const u = S.users.find((x) => x.id === id); if (!u) return;
      try { await api('PATCH', '/users/' + encodeURIComponent(id), { is_active: !u.is_active }); toast('User updated.', 'ok'); S.users = null; render(); }
      catch (e) { toast('Update failed: ' + e.message, 'err'); }
    })));
    body.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      const id = b.getAttribute('data-del');
      const u = S.users.find((x) => x.id === id); if (!u) return;
      if (!window.confirm(`Delete user ${u.email}? This cannot be undone.`)) return;
      return busy(b, async () => {
        try { await api('DELETE', '/users/' + encodeURIComponent(id)); toast('User deleted.', 'ok'); S.users = null; render(); }
        catch (e) { toast('Delete failed: ' + e.message, 'err'); }
      });
    }));
  }

  // ── ORG · Branding ──────────────────────────────────────────────────────────
  async function renderOrgBranding(body) {
    loadingBody(body, 'organisation settings');
    let o;
    try { o = await api('GET', '/org', undefined, CONFIG_API); } catch (e) { return errorBody(body, e); }
    S.org = o || {};
    const logo = S.org.org_logo_url ? `${BACKEND_HOST}${S.org.org_logo_url}` : '';
    body.innerHTML = `
      <div class="cc-st-card">
        <h3>Identity &amp; branding</h3>
        <div class="cc-st-row" style="gap:14px;align-items:flex-start;margin-bottom:12px">
          <div class="cc-st-logo-prev" id="cc-st-logo-prev">${logo ? `<img src="${esc(logo)}" alt="logo">` : '<span style="color:var(--text-dim,#6b7689);font-size:11px">No logo</span>'}</div>
          <div style="flex:1;min-width:200px">
            <label class="cc-st-lbl">Organisation logo</label>
            <input type="file" id="cc-st-logo-file" accept="image/png,image/jpeg,image/webp,image/svg+xml" style="font-size:12px">
            <p class="cc-st-hint">PNG, JPEG, WebP or SVG · ≤ 2 MB. Shown in the dashboard header &amp; clients.</p>
          </div>
        </div>
        <div class="cc-st-grid2">
          <div class="cc-st-fld"><label class="cc-st-lbl">Internal name</label><input class="cc-st-input" id="cc-st-org-name" value="${esc(S.org.org_name || '')}" placeholder="CRISP"></div>
          <div class="cc-st-fld"><label class="cc-st-lbl">Public display name</label><input class="cc-st-input" id="cc-st-org-public" value="${esc(S.org.org_public_name || '')}" placeholder="UN Crisis Command"></div>
          <div class="cc-st-fld"><label class="cc-st-lbl">Contact email</label><input class="cc-st-input" id="cc-st-org-email" type="email" value="${esc(S.org.org_contact_email || '')}" placeholder="ops@example.org"></div>
          <div class="cc-st-fld"><label class="cc-st-lbl">Support URL</label><input class="cc-st-input" id="cc-st-org-support" value="${esc(S.org.org_support_url || '')}" placeholder="https://…"></div>
          <div class="cc-st-fld"><label class="cc-st-lbl">Region</label><input class="cc-st-input" id="cc-st-org-region" value="${esc(S.org.org_region || '')}" placeholder="Geneva"></div>
          <div class="cc-st-fld"><label class="cc-st-lbl">Default language</label><select class="cc-st-select" id="cc-st-org-lang">
            ${LANGS.map(([v, l]) => `<option value="${v}" ${S.org.org_default_language === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
          <div class="cc-st-fld"><label class="cc-st-lbl">Primary colour</label>
            <div class="cc-st-row" style="gap:8px">
              <input type="color" id="cc-st-org-color" value="${esc(/^#[0-9a-fA-F]{6}$/.test(S.org.org_primary_color || '') ? S.org.org_primary_color : '#7c5cff')}" style="width:46px;height:38px;border:0;background:none;cursor:pointer">
              <input class="cc-st-input" id="cc-st-org-color-hex" value="${esc(S.org.org_primary_color || '#7c5cff')}" style="flex:1" maxlength="7"></div></div>
        </div>
        <div class="cc-st-row" style="margin-top:6px"><div class="cc-st-spacer"></div>
          <button class="cc-st-btn primary" id="cc-st-org-save">Save branding</button></div>
      </div>`;
    // colour picker ↔ hex sync
    const cp = el('cc-st-org-color'), hex = el('cc-st-org-color-hex');
    cp.addEventListener('input', () => { hex.value = cp.value; });
    hex.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(hex.value)) cp.value = hex.value; });
    el('cc-st-org-save').addEventListener('click', (ev) => busy(ev.currentTarget, saveOrgBranding));
    el('cc-st-logo-file').addEventListener('change', uploadOrgLogo);
  }

  async function saveOrgBranding() {
    const hex = el('cc-st-org-color-hex').value.trim();
    if (hex && !/^#[0-9a-fA-F]{6}$/.test(hex)) { toast('Primary colour must be a #RRGGBB hex value.', 'err'); return; }
    const payload = {
      org_name: el('cc-st-org-name').value.trim(),
      org_public_name: el('cc-st-org-public').value.trim(),
      org_contact_email: el('cc-st-org-email').value.trim(),
      org_support_url: el('cc-st-org-support').value.trim(),
      org_region: el('cc-st-org-region').value.trim(),
      org_default_language: el('cc-st-org-lang').value,
      org_primary_color: hex || '#7c5cff',
    };
    try { await api('PATCH', '/org', payload, CONFIG_API); toast('Organisation settings saved.', 'ok'); }
    catch (e) { toast('Save failed: ' + e.message, 'err'); }
  }

  async function uploadOrgLogo(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast('Logo must be ≤ 2 MB.', 'err'); e.target.value = ''; return; }
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch(`${CONFIG_API}/org/logo`, {
        method: 'POST', headers: { Authorization: `Bearer ${token() || ''}` }, body: fd,
      });
      if (!res.ok) {
        let msg = res.statusText; try { const j = await res.json(); msg = (j && j.detail) || msg; } catch (_) {}
        throw new Error(typeof msg === 'string' ? msg : 'Upload failed');
      }
      const data = await res.json();
      toast('Logo uploaded.', 'ok');
      const prev = el('cc-st-logo-prev');
      if (prev && data.org_logo_url) prev.innerHTML = `<img src="${esc(BACKEND_HOST + data.org_logo_url)}" alt="logo">`;
    } catch (err) { toast('Logo upload failed: ' + err.message, 'err'); }
    finally { e.target.value = ''; }
  }

  // ── ORG · Channels (read-only) ──────────────────────────────────────────────
  async function renderOrgChannels(body) {
    body.innerHTML = `<div class="cc-st-card"><h3>Channels</h3><div class="cc-st-empty">Loading channel status…</div></div>`;
    // IVR/SMS share the Twilio config; probe it best-effort (never blocks render).
    let twilio = null;
    try {
      const r = await fetch(`${BACKEND_HOST}/api/v1/ivr/status`);
      if (r.ok) twilio = await r.json();
    } catch (_) {}
    const tw = !!(twilio && twilio.twilio_configured);
    const CH = [
      { n: 'PWA / Web', d: 'Progressive web app - the primary citizen reporting surface.', on: true },
      { n: 'Android (RN)', d: 'Native React-Native build sharing the same report pipeline.', on: true },
      { n: 'Telegram', d: 'Conversational bot ingestion.', on: true },
      { n: 'WhatsApp', d: 'Twilio WhatsApp Business inbound.', on: tw },
      { n: 'SMS', d: 'Twilio SMS inbound/outbound.', on: tw },
      { n: 'IVR', d: 'Twilio voice - phone-call reporting.', on: tw },
    ];
    body.innerHTML = `
      <div class="cc-st-card">
        <h3>Channels</h3>
        <div class="cc-st-ch">
          ${CH.map((c) => `<div class="cc-st-ch-card">
            <div class="n">${esc(c.n)} <span class="cc-st-pill ${c.on ? 'ok' : 'off'}">${c.on ? 'Configured' : 'Not configured'}</span></div>
            <div class="d">${esc(c.d)}</div></div>`).join('')}
        </div>
        <p class="cc-st-hint">Read-only overview. All channels produce the same report shape (multi-channel parity). Twilio channels (WhatsApp / SMS / IVR) reflect the deployment's Twilio configuration.</p>
      </div>`;
  }

  // The account / organisation user-menu items are now STATIC + router-driven in
  // index.html (#btn-account-settings → /users, #btn-org-settings → /org; the
  // router opens these overlays via openAccountSettings / openOrgSettings). This
  // module no longer injects its OWN "Account settings" / "Organisation settings"
  // buttons - that left a duplicate of each in the dropdown after the header
  // consolidation. The overlay machinery (openOverlay + the public API below) is
  // unchanged and still backs both the menu items and the /users + /org routes.

  function boot() {
    injectStyles();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // public API (B7 cards + tests)
  window.openAccountSettings = () => openOverlay('account');
  window.openOrgSettings = () => openOverlay('org');
  window.__ccSettings = { openOverlay, closeOverlay, S };
})();
