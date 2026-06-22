// ══════════════════════════════════════════════════════════════════════════════
// CRISP - Crisis Intelligence Control Panel  v3.0
// Hierarchical, decision-focused, scalable dashboard for UN crisis response
// ══════════════════════════════════════════════════════════════════════════════

// ── Security: HTML escaping to prevent XSS ──────────────────────────────────
function escapeHtml(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
}
// escapeHtml() serializes via textContent, which escapes & < > but NOT the
// double-quote - safe in TEXT position, unsafe inside a "double-quoted" HTML
// attribute (a value like `x" onmouseover="...` breaks out). Use this for any
// attribute interpolation (title=, alt=, etc.) carrying reporter-controlled text.
function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
}

// ── Auth Gate ────────────────────────────────────────────────────────────────
const _crispToken = localStorage.getItem('crisp_token');
const _crispUser = (() => { try { return JSON.parse(localStorage.getItem('crisp_user')); } catch { return null; } })();

// ══════════════════════════════════════════════════════════════════════
// Phase F.7 (May 2026) - Dashboard i18n bootstrap (UNDP must-have #2)
// ══════════════════════════════════════════════════════════════════════
// Six UN languages: English (default), Spanish, French, Russian,
// Chinese (Simplified), Arabic. Locale chosen from localStorage,
// falling back to navigator.language, falling back to 'en'.
//
// applyI18n() walks every `[data-i18n]` attribute on the document
// and writes the matching string. Title/aria/placeholder variants
// covered via `data-i18n-title`, `data-i18n-aria-label`,
// `data-i18n-placeholder`. Reporter-supplied content (descriptions,
// transcripts, location names) stays in its source language - i18n
// only touches operator-facing chrome.
//
// RTL: Arabic flips the document direction via `dir="rtl"` on
// <html>. The Leaflet map continues to render LTR (it has its own
// coordinate system); only the surrounding chrome flips.
const I18N_SUPPORTED = ['en', 'es', 'fr', 'ru', 'zh', 'ar'];
const I18N_NATIVE = {
    en: 'English', es: 'Español', fr: 'Français',
    ru: 'Русский', zh: '简体中文', ar: 'العربية',
};
const I18N_LS_KEY = 'crisp_dashboard_lang';
let _i18nDict = {};
let _i18nLang = 'en';

function _pickInitialLocale() {
    try {
        const stored = localStorage.getItem(I18N_LS_KEY);
        if (stored && I18N_SUPPORTED.includes(stored)) return stored;
    } catch (_) { /* ignore */ }
    const nav = (navigator.language || 'en').toLowerCase();
    // Map e.g. "es-MX" → "es", "zh-Hans" → "zh"
    for (const code of I18N_SUPPORTED) {
        if (nav.startsWith(code)) return code;
    }
    return 'en';
}

async function _loadI18nDict(lang) {
    // Always include 'en' so the loaded dict can fall back on missing
    // keys without a separate fetch.
    try {
        const [primary, base] = await Promise.all([
            lang === 'en' ? null : fetch(`./i18n/${lang}.json`).then(r => r.ok ? r.json() : null),
            fetch('./i18n/en.json').then(r => r.ok ? r.json() : null),
        ]);
        // Merge: english first as floor, target language overrides.
        _i18nDict = { ...(base || {}), ...(primary || {}) };
    } catch (e) {
        console.warn('[i18n] dict load failed', lang, e);
        _i18nDict = {};
    }
}

window.t = function (key, fallback) {
    return (_i18nDict && _i18nDict[key]) || fallback || key;
};

function applyI18n() {
    const root = document;
    root.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const val = _i18nDict[key];
        if (val) el.textContent = val;
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
        const key = el.getAttribute('data-i18n-title');
        const val = _i18nDict[key];
        if (val) el.setAttribute('title', val);
    });
    root.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
        const key = el.getAttribute('data-i18n-aria-label');
        const val = _i18nDict[key];
        if (val) el.setAttribute('aria-label', val);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        const val = _i18nDict[key];
        if (val) el.setAttribute('placeholder', val);
    });
}

async function setDashboardLanguage(lang) {
    if (!I18N_SUPPORTED.includes(lang)) return;
    _i18nLang = lang;
    try { localStorage.setItem(I18N_LS_KEY, lang); } catch (_) {}
    await _loadI18nDict(lang);
    // Apply RTL on <html> for Arabic.
    document.documentElement.setAttribute(
        'dir',
        (_i18nDict._meta && _i18nDict._meta.dir) || (lang === 'ar' ? 'rtl' : 'ltr')
    );
    document.documentElement.setAttribute('lang', lang);
    applyI18n();
    // Update language pill label.
    const pill = document.getElementById('dash-lang-pill-label');
    if (pill) pill.textContent = I18N_NATIVE[lang] || lang;
}

window.toggleDashboardLanguageMenu = function () {
    const menu = document.getElementById('dash-lang-menu');
    if (!menu) return;
    if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }
    menu.style.display = 'block';
    // Populate every time so the active state stays accurate.
    menu.innerHTML = I18N_SUPPORTED.map(code => `
        <button class="dash-lang-opt ${code === _i18nLang ? 'active' : ''}"
                onclick="setDashboardLanguage('${code}'); document.getElementById('dash-lang-menu').style.display='none';"
                lang="${code}">
            ${I18N_NATIVE[code]}
        </button>
    `).join('');
    setTimeout(() => {
        const closer = (ev) => {
            const wrap = document.getElementById('dash-lang-wrap');
            if (!wrap || !wrap.contains(ev.target)) {
                menu.style.display = 'none';
                document.removeEventListener('click', closer);
            }
        };
        document.addEventListener('click', closer);
    }, 60);
};

// Fire the initial load. Awaited inside an IIFE so the rest of the
// app can keep loading; applyI18n runs as soon as the dict resolves.
(async () => {
    _i18nLang = _pickInitialLocale();
    await _loadI18nDict(_i18nLang);
    document.documentElement.setAttribute(
        'dir',
        (_i18nDict._meta && _i18nDict._meta.dir) || (_i18nLang === 'ar' ? 'rtl' : 'ltr')
    );
    document.documentElement.setAttribute('lang', _i18nLang);
    // Wait for DOMContentLoaded if we're early in the script lifecycle,
    // otherwise apply immediately.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyI18n, { once: true });
    } else {
        applyI18n();
    }
    const pill = document.getElementById('dash-lang-pill-label');
    if (pill) pill.textContent = I18N_NATIVE[_i18nLang] || _i18nLang;
})();
if (!_crispToken && !window.location.pathname.includes('login')) {
    window.location.href = 'login.html';
}

// ── Config ───────────────────────────────────────────────────────────────────
// Apr 2026 - origin-aware backend host detection. In dev (page served at
// localhost:8080 with backend on :8000) we point at :8000 directly. In prod
// (page served via nginx proxy at the same origin as the API) we use the
// page origin so HTTPS + same-host work without mixed-content / CORS drama.
// Phase F dev-on-LAN (May 2026). Loopback names + RFC-1918 private
// LAN IPs all resolve to "same host, port 8000" so a tester opening
// the dashboard from their phone on the same Wi-Fi (e.g.
// http://172.16.110.14:8080/web-dashboard/src/) gets the backend
// reachable WITHOUT a code edit. The backend's own CORS regex at
// backend/app/main.py:317 mirrors the same RFC-1918 ranges so the
// preflight succeeds. In production (https://undp.crisplabs.tech)
// hostname is neither loopback nor RFC-1918, so this branch
// short-circuits to `window.location.origin` (same-host via nginx).
const _LAN_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;
const _isLocalDev = ["localhost", "127.0.0.1", "0.0.0.0"].includes(window.location.hostname)
                  || _LAN_RE.test(window.location.hostname);
const BACKEND_HOST = _isLocalDev
    ? `http://${window.location.hostname}:8000`
    : window.location.origin;
const API = `${BACKEND_HOST}/api/v1/reports`;
// Phase H (May 2026) - Building endpoints live at /api/v1/buildings,
// NOT under /api/v1/reports/. Keep a sibling constant so the Phase H
// fetch sites don't accidentally double-prefix and 404.
const BUILDINGS_API = `${BACKEND_HOST}/api/v1/buildings`;

// Add Authorization header to all fetch calls + handle 401 with a TRANSPARENT
// refresh-and-retry (so a 30-min access-token expiry never kicks the operator to
// login / bounces them to home mid-crisis).
const _origFetch = window.fetch;
// Shared in-flight refresh so the 4s poll + concurrent clicks that all 401 at the
// same instant trigger exactly ONE /auth/refresh, not a storm.
let _refreshInflight = null;
function _tryRefreshToken() {
    if (_refreshInflight) return _refreshInflight;
    const refresh = localStorage.getItem('crisp_refresh');
    if (!refresh) return Promise.resolve(false);
    _refreshInflight = _origFetch.call(window, `${BACKEND_HOST}/api/v1/auth/refresh`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refresh }),
    })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
            if (data && data.access_token) { localStorage.setItem('crisp_token', data.access_token); return true; }
            return false;
        })
        .catch(() => false)
        .finally(() => { _refreshInflight = null; });
    return _refreshInflight;
}
function _hardLogout() {
    localStorage.removeItem('crisp_token');
    localStorage.removeItem('crisp_user');
    localStorage.removeItem('crisp_refresh');
    if (!window.location.pathname.includes('login')) window.location.href = 'login.html';
}
window.fetch = function(url, opts = {}) {
    const _isApi = typeof url === 'string' && url.includes('/api/');
    // Don't try to refresh the auth endpoints themselves (would loop).
    const _isAuth = _isApi && /\/auth\/(refresh|login|logout|step-up)/.test(url);
    if (_isApi) {
        // M5 (Phase-3): read the CURRENT token on EVERY call (it rotates via
        // /auth/refresh). Don't clobber an Authorization the caller already set
        // (the cc-* modules pass their own fresh token via headers).
        const _tok = localStorage.getItem('crisp_token');
        const _h = opts.headers || {};
        const _hasAuth = !!(_h.Authorization || _h.authorization);
        if (_tok && !_hasAuth) {
            opts.headers = { ..._h, 'Authorization': `Bearer ${_tok}` };
        }
    }
    return _origFetch.call(this, url, opts).then((res) => {
        if (res.status !== 401 || !_isApi || _isAuth) return res;
        // Already retried with a fresh token and STILL 401 → the session is truly
        // dead (refresh token revoked/expired). Now log out.
        if (opts.__crispRetried) { _hardLogout(); return res; }
        // First 401: the access token likely just expired. Refresh it transparently
        // and retry the SAME request ONCE; only log out if the refresh fails.
        return _tryRefreshToken().then((ok) => {
            if (!ok) { _hardLogout(); return res; }
            const _tok = localStorage.getItem('crisp_token');
            const _h = opts.headers || {};
            return window.fetch(url, { ...opts, __crispRetried: true, headers: { ..._h, Authorization: `Bearer ${_tok}` } });
        });
    });
};
const POLL_INTERVAL        = 4000;  // normal polling
const POLL_INTERVAL_ACTIVE = 1200;  // fast polling while any image is uploading
// Phase J.6 (May 2026) - decision-mode polling slowdown.
// When the operator has a report open AND has been interacting
// recently AND no verdict is set yet, slow polling from 4 s → 8 s
// so the panel doesn't re-render under their hands mid-decision.
const POLL_INTERVAL_DECISION = 8000;
let _pollTimer = null;

// Phase 3 (May 2026, HAR-driven) - incremental delta polling state.
// Backend `/api/v1/reports/?since=<iso>` returns ONLY reports updated
// since `since`. We track the X-Server-Time of the last response and
// echo it back on the next poll. Idle dashboards drop from ~440 KB
// per poll to ~1-2 KB.
//
// Periodic full refresh: every Nth poll we deliberately skip `since`
// to catch deletions (24h soft-delete grace window) and any state
// drift. 30 polls × 4 s = 2 min between full refreshes - fine for
// admin-action latency, plenty cheap.
let _lastServerTime = null;            // ISO 8601 cursor from previous poll
let _pollsSinceFullRefresh = 0;
const _FULL_REFRESH_EVERY_N_POLLS = 30;

// Phase 4 (May 2026, HAR-driven) - ETag / If-None-Match. Server returns
// an ETag header on every /reports/ response. Echo it back on the next
// poll; if data hasn't changed, server short-circuits with 304 + no
// body. Combined with Phase 3's `since=<cursor>`, an idle poll round-
// trips ~50 bytes (status line + headers) instead of ~440 KB.
let _lastReportsEtag = null;

// ── State ────────────────────────────────────────────────────────────────────
let allReports = [];
let sortMode = 'impact';
let timeFilterHours = 0; // 0 = show all time (no filter)
// Jun 2026 (export audit) - the tree renderer's fully-filtered set, cached so
// tree-node exports ship EXACTLY what the visible tree was built from
// (status + time + search + chips + crisis drill). exportNodeData previously
// rebuilt from raw allReports: a node badge showing 3 could export 10 rows.
let _lastTreeFiltered = null;
let statusFilter = 'active';
let selectedId = null;
const knownIds = new Set();
const liveMarkers = {};
let firstZoomDone = false;

// ── Live Incident Notifications ─────────────────────────────────────────────
// Notification Center depth cap. Bounded history (read + unread) so the
// persisted store below can't grow without limit. Raised 10 → 50 in Phase K
// so a burst never sheds older entries; the durable store reuses this cap.
const _MAX_NOTIFS = 50;
// K.5.c (May 2026, Phase K) - _seenIds LRU cap. Pre-fix the Set grew
// unbounded in localStorage; an operator session running for weeks
// eventually hit the quota → setItem threw → notifications stopped
// persisting cross-session → stale notifications re-fired next session.
// Cap at 1000 most-recent ids (FIFO eviction; JS Sets preserve insertion
// order). 1000 covers a busy day comfortably.
const _SEEN_IDS_CAP = 1000;
const _seenIds = (() => {
    try {
        const raw = JSON.parse(localStorage.getItem('crisp_seen_ids') || '[]');
        // Trim on load too - handles legacy localStorage entries from
        // pre-K.5.c sessions that may have grown unbounded.
        return new Set(raw.slice(-_SEEN_IDS_CAP));
    } catch (_) {
        return new Set();
    }
})();
// K.5.c - central LRU-eviction + persistence helper. Use this instead
// of bare `localStorage.setItem('crisp_seen_ids', ...)`. The cap is
// enforced BEFORE write so a quota-exceeded throw only fires when the
// payload would actually be larger than 1000 ids' worth (~50 KB).
function _persistSeenIds() {
    const arr = [..._seenIds];
    if (arr.length > _SEEN_IDS_CAP) {
        // Evict the oldest. Sets preserve insertion order so the first
        // entries are the oldest. Trim the in-memory Set to match.
        const evictCount = arr.length - _SEEN_IDS_CAP;
        for (let i = 0; i < evictCount; i++) _seenIds.delete(arr[i]);
    }
    try {
        localStorage.setItem('crisp_seen_ids', JSON.stringify([..._seenIds]));
    } catch (e) {
        console.warn('[CRISP] _seenIds persist failed (quota?):', e?.message || e);
    }
}

// ── Notification Center (durable, per-operator) ─────────────────────────────
// Single source of truth for the bell: a persisted, bounded history holding
// BOTH unread and read notifications. Replaces the old transient in-memory
// `_unseenReports` array (wiped on every refresh, no history, no read-state).
//
// Two ledgers with distinct, complementary roles:
//   · `_seenIds`     (above, 1000-cap) - the SHOW-ONCE gate. The poll's
//                     producer (_applyReportData) checks it BEFORE ever
//                     calling _addNotification, so a displayed incident is
//                     never re-toasted after a scope-switch / refresh.
//   · `_notifCenter` (here, _MAX_NOTIFS-cap) - the rich HISTORY the bell
//                     renders (read/unread/category). Membership = "delivered
//                     to the center". Persisted so history survives a reload.
// The caps differ on purpose: an id can age out of the 50-deep history while
// still being in the 1000-deep seen-ledger, so it still never replays.
//
// Namespaced per operator so a shared workstation never leaks one analyst's
// history (or read-state) to the next.
function _notifUserKey(prefix) {
    let uid = 'anon';
    try { uid = String((_crispUser && (_crispUser.id || _crispUser.username)) || 'anon'); } catch (_) {}
    return prefix + uid;
}
function _notifCenterKey() { return _notifUserKey('crisp_notif_center_'); }
let _notifCenter = (() => {
    try {
        const raw = JSON.parse(localStorage.getItem(_notifCenterKey()) || '[]');
        return Array.isArray(raw) ? raw.slice(0, _MAX_NOTIFS) : [];
    } catch (_) { return []; }
})();
function _persistNotifCenter() {
    try {
        if (_notifCenter.length > _MAX_NOTIFS) _notifCenter = _notifCenter.slice(0, _MAX_NOTIFS);
        localStorage.setItem(_notifCenterKey(), JSON.stringify(_notifCenter));
    } catch (e) { /* quota - non-fatal; history just won't persist this write */ }
}
function _notifUnread() { return _notifCenter.filter(n => !n.read); }
function _notifUnreadCount() { let c = 0; for (const n of _notifCenter) if (!n.read) c++; return c; }
// Push a freshly-built notification record onto the durable center (newest
// first, capped, persisted). Used by the confirmed-new path + the synthetic
// session-summary / urgent-broadcast producers.
function _notifCenterAdd(rec) {
    _notifCenter.unshift(rec);
    if (_notifCenter.length > _MAX_NOTIFS) _notifCenter = _notifCenter.slice(0, _MAX_NOTIFS);
    _persistNotifCenter();
}

let _notifPanelOpen = false;
let _initialLoadDone = false;  // Suppress notifications on first data load
let heatLayer = null;
let clusterGroup = null;
let boundaryLayers = [];
// Map↔feed sync: registry of report-id → Leaflet marker so selecting an
// incident in the feed can highlight its marker (the reverse of marker→feed).
let _markerById = {};
let _highlightedMarkerId = null;
let currentAudio = null;
let treeState = {};
let treeSearchTerm = '';
let priorityZones = new Set(JSON.parse(localStorage.getItem('crisp_priority_zones') || '[]'));

const SEV_SCORE = { CRITICAL: 10, SEVERE: 7, MODERATE: 4, MINOR: 2, UNKNOWN: 1 };
const INFRA_WEIGHTS = { HOSPITAL: 10, POWER_PLANT: 8, POWER: 8, WATER_TREATMENT: 7, WATER: 7, ROAD: 3, BRIDGE: 5, SCHOOL: 4, HOUSE: 2, OTHER: 1 };
// UNDP super-type icons + labels. Same labels appear on PWA tile titles
// and dashboard badges - single source of truth across the two surfaces.
// Legacy enum values (HOSPITAL, POWER, WATER, ROAD, HOUSE, SCHOOL, TELECOM)
// alias to the UNDP super-type they were collapsed into during the Phase
// 22 migration, so historical rows still render with a meaningful icon
// and label.
const INFRA_ICONS = {
    // UNDP super-types (canonical)
    RESIDENTIAL:             'fa-house',
    COMMERCIAL:              'fa-shop',
    GOVERNMENT:              'fa-landmark',
    UTILITY:                 'fa-bolt',
    TRANSPORT_COMMUNICATION: 'fa-road-bridge',
    COMMUNITY:               'fa-hospital',
    PUBLIC_SPACES:           'fa-tree-city',
    OTHER:                   'fa-triangle-exclamation',
    // Legacy aliases (rendered as their UNDP-aligned successor)
    HOUSE:                   'fa-house',
    HOSPITAL:                'fa-hospital',
    SCHOOL:                  'fa-hospital',
    POWER:                   'fa-bolt',
    WATER:                   'fa-bolt',
    ROAD:                    'fa-road-bridge',
    TELECOM:                 'fa-road-bridge',
};
const INFRA_LABELS = {
    RESIDENTIAL:             'Houses & apartments',
    COMMERCIAL:              'Shops & markets',
    GOVERNMENT:              'Government',
    UTILITY:                 'Power, water, waste',
    TRANSPORT_COMMUNICATION: 'Roads & bridges',
    COMMUNITY:               'Schools & hospitals',
    PUBLIC_SPACES:           'Stadiums, parks',
    OTHER:                   'Other',
    // Legacy aliases
    HOUSE:                   'Houses & apartments',
    HOSPITAL:                'Schools & hospitals',
    SCHOOL:                  'Schools & hospitals',
    POWER:                   'Power, water, waste',
    WATER:                   'Power, water, waste',
    ROAD:                    'Roads & bridges',
    TELECOM:                 'Roads & bridges',
};
const CRISIS_LABELS = {
    // Natural
    EARTHQUAKE:        'Earthquake',
    FLOOD:             'Flood',
    TSUNAMI:           'Tsunami',
    CYCLONE:           'Hurricane / Cyclone',
    WILDFIRE:          'Wildfire',
    // Technological
    EXPLOSION:         'Explosion',
    CHEMICAL_INCIDENT: 'Chemical',
    // Human-made
    CONFLICT:          'Conflict',
    CIVIL_UNREST:      'Civil unrest',
    // Catch-all
    OTHER:             'Other',
    // Legacy aliases (historical rows pre-migration-0016)
    HURRICANE:         'Hurricane / Cyclone',
    LANDSLIDE:         'Landslide',
    PANDEMIC:          'Pandemic',
};
// Helpers - used wherever enum-style strings used to leak through
// .replace(/_/g, ' ') into the UI. Pass through unknown values so a
// future enum addition doesn't break the render.
const infraLabel  = (v) => INFRA_LABELS[v]  || (v ? String(v).replace(/_/g, ' ') : '');
const crisisLabel = (v) => CRISIS_LABELS[v] || (v ? String(v).replace(/_/g, ' ') : '');

// ── B3: Dynamic Crisis Forms - report-detail rendering ──────────────────────
// Resolve form_pack_id → pack title/version and crisis_event_id → event name
// from the admin crisis-forms lists (the dashboard is admin-authed). Bulk-
// fetched ONCE and cached; failures degrade gracefully to the raw id/version.
let _crisisFormsIndex = null, _crisisFormsIndexPromise = null;
async function ensureCrisisFormsIndex() {
    if (_crisisFormsIndex) return _crisisFormsIndex;
    if (_crisisFormsIndexPromise) return _crisisFormsIndexPromise;
    _crisisFormsIndexPromise = (async () => {
        const idx = { packs: {}, events: {} };
        try {
            const base = `${BACKEND_HOST}/api/v1/admin/crisis-forms`;
            const [pRes, eRes] = await Promise.all([
                fetch(`${base}/packs`, { headers: _authHeaders() }),
                fetch(`${base}/events`, { headers: _authHeaders() }),
            ]);
            const packs = pRes.ok ? await pRes.json() : [];
            const events = eRes.ok ? await eRes.json() : [];
            (Array.isArray(packs) ? packs : []).forEach((p) => { if (p && p.id) idx.packs[p.id] = { title: p.title, version: p.active_version, crisis_type: p.crisis_type }; });
            (Array.isArray(events) ? events : []).forEach((ev) => { if (ev && ev.id) idx.events[ev.id] = { name: ev.name, crisis_type: ev.crisis_type }; });
        } catch (_e) { /* leave empty → graceful fallback */ }
        _crisisFormsIndex = idx;
        return idx;
    })();
    return _crisisFormsIndexPromise;
}
window.ensureCrisisFormsIndex = ensureCrisisFormsIndex;

// Humanize a form_data key (snake_case → "Title Case") + format its value.
function _humanizeFormKey(k) {
    return String(k == null ? '' : k).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function _formatFormValue(v) {
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    if (v == null || v === '') return '-';
    if (Array.isArray(v)) return v.length ? v.map((x) => escapeHtml(_humanizeFormKey(String(x)))).join(', ') : '-';
    if (typeof v === 'object') { try { return escapeHtml(JSON.stringify(v)); } catch (_e) { return '-'; } }
    return escapeHtml(String(v));
}
// Resolve a form_data key/value against the pack schema map (built by
// ensurePackSchema) so the dashboard shows the VERBATIM question + option labels
// (e.g. UNDP Appendix-1 wording) rather than raw codes. fmap may be null on first
// paint (humanized fallback) and is filled async once the pack schema loads.
function _fdKeyLabel(k, fmap) {
    const f = fmap && fmap[k];
    return (f && f.label) ? f.label : _humanizeFormKey(k);
}
function _fdValLabeled(v, k, fmap) {
    const opts = (fmap && fmap[k] && fmap[k].options) || null;
    const lab = (x) => (opts && opts[x] != null) ? opts[x] : _humanizeFormKey(String(x));
    if (v === true) return 'Yes';
    if (v === false) return 'No';
    if (v == null || v === '') return '-';
    if (Array.isArray(v)) return v.length ? v.map((x) => escapeHtml(lab(x))).join(', ') : '-';
    if (typeof v === 'object') { try { return escapeHtml(JSON.stringify(v)); } catch (_e) { return '-'; } }
    return escapeHtml(opts && opts[v] != null ? opts[v] : String(v));
}
function _fdRowsHtml(fd, fmap) {
    return Object.keys(fd).map((k) =>
        `<div class="dp-cf-row"><span class="dp-cf-key">${escapeHtml(_fdKeyLabel(k, fmap))}</span><span class="dp-cf-val">${_fdValLabeled(fd[k], k, fmap)}</span></div>`).join('');
}
// Fetch + cache a pack version's value→label maps so form_data answers render
// with verbatim labels. Cached by packId:version; failures degrade to codes.
const _packSchemaCache = {};
async function ensurePackSchema(packId, version) {
    if (!packId) return null;
    const ck = packId + ':' + (version || '');
    if (Object.prototype.hasOwnProperty.call(_packSchemaCache, ck)) return _packSchemaCache[ck];
    let fmap = null;
    try {
        const base = `${BACKEND_HOST}/api/v1/admin/crisis-forms`;
        const res = await fetch(`${base}/packs/${encodeURIComponent(packId)}/versions`, { headers: _authHeaders() });
        if (res.ok) {
            const vers = await res.json();
            const list = Array.isArray(vers) ? vers : [];
            const v = list.find((x) => !version || x.version === version) || list[0];
            const schema = v && v.schema_json;
            if (schema && Array.isArray(schema.sections)) {
                fmap = {};
                schema.sections.forEach((sec) => (sec.fields || []).forEach((f) => {
                    if (!f || !f.key) return;
                    const options = {};
                    (f.options || []).forEach((o) => {
                        if (o && Object.prototype.hasOwnProperty.call(o, 'value')) {
                            options[o.value] = (o.label_i18n && o.label_i18n.en) || o.label || o.value;
                        }
                    });
                    fmap[f.key] = { label: (f.label_i18n && f.label_i18n.en) || f.label || f.key, options };
                }));
            }
        }
    } catch (_e) { fmap = null; }
    _packSchemaCache[ck] = fmap;
    return fmap;
}
window.ensurePackSchema = ensurePackSchema;
// Render Report.form_data (curated crisis-pack answers) as a collapsible section.
// The pack/event NAME + verbatim answer labels are filled async post-render (see
// selectReport).
function _renderFormDataSection(r) {
    const fd = r && r.form_data;
    if (!fd || typeof fd !== 'object' || Array.isArray(fd)) return '';
    const keys = Object.keys(fd);
    if (!keys.length) return '';
    return `
        <details class="dp-section dp-crisis-answers" open>
            <summary class="dp-section-header">
                <i class="fa-solid fa-clipboard-list"></i>
                <span>Crisis-pack answers</span>
                <span class="dp-cf-count">${keys.length}</span>
                <span id="dp-cf-formname-${r.id}" class="dp-cf-formname"></span>
                <i class="fa-solid fa-chevron-down dp-section-caret"></i>
            </summary>
            <div id="dp-cf-body-${r.id}" class="dp-section-body dp-cf-grid">${_fdRowsHtml(fd, null)}</div>
        </details>`;
}

// Phase F.3.b (May 2026, pivoted from the original source-enum plan
// after the F.3.c audit revealed the operator-perceived "everything
// is Transport & Communication" problem was driven by legacy ROAD
// chip data getting normalised to TRANSPORT_COMMUNICATION via the
// backend's _apply_taxonomy hook - 89 of 120 reports). The richer
// signal is the `infrastructure_sub_type` column (ROAD / HOSPITAL /
// POWER / WATER / SCHOOL / HOUSE / TELECOM) which was already being
// captured server-side but never surfaced in the dashboard.
//
// `infraDisplayLabel(infraType, subType)` returns either the UNDP
// super-type label alone (when subType is empty / null) or
// "Super-type · Sub-type" (e.g. "Roads & bridges · Road",
// "Schools & hospitals · Hospital") so operators can tell at a
// glance whether a TRANSPORT_COMMUNICATION row is a road, telecom
// tower, or generic non-specific transport incident.
const INFRA_SUB_LABELS = {
    ROAD:     'Road',
    HOSPITAL: 'Hospital',
    HOUSE:    'House',
    POWER:    'Power grid',
    WATER:    'Water',
    SCHOOL:   'School',
    TELECOM:  'Telecom',
};
const infraDisplayLabel = (infraType, subType) => {
    const base = infraLabel(infraType);
    if (!subType) return base;
    const sub = INFRA_SUB_LABELS[subType] || String(subType).replace(/_/g, ' ');
    // Avoid doubling when sub-type IS the super-type alias (e.g.
    // infraType=ROAD AND subType=ROAD → just "Roads & bridges").
    if (String(subType).toUpperCase() === String(infraType).toUpperCase()) return base;
    return `${base} · ${sub}`;
};
const SEV_COLORS = { CRITICAL: '#ef4444', SEVERE: '#f97316', MODERATE: '#eab308', MINOR: '#22c55e', UNKNOWN: '#64748b' };

// ── QRT Queue State ───────────────────────────────────────────────────────────
let viewMode = 'buildings'; // building-centric redesign: 'buildings' (default) = building-grouped feed | 'queue' = flat "All Incidents" escape hatch. Tree retired.
let cardSortMode = 'priority'; // priority | newest | oldest | severity | type | has_media | confidence | crisis | damage | source

// ── Operational queues (Jun 2026 - attention-panel routing audit) ────────────
// Each Crisis Intelligence "Immediate Attention" row deep-links into ONE of
// these queues via the hash state segment `#/incidents;queue=<key>`. Every
// predicate mirrors the EXACT backend count definition in
// backend/app/api/endpoints/analytics.py::operational_summary, so the queue
// view shows the same population the landing badge counted:
//   critical      = active (not closed) + severity CRITICAL          (:414)
//   sla-risk      = PENDING + older than its severity's SLA target   (:407-411)
//   escalating    = reports on buildings with escalation_risk >= 70  (:486-488;
//                   NOTE: the badge counts BUILDINGS - the queue shows their
//                   linked reports, labelled accordingly)
//   verification  = reviewer_verdict NOT_REVIEWED (NO status filter) (:415)
//   triage        = PENDING + NOT_REVIEWED                           (:416-417)
//   dispatch      = help_dispatched_at set, help_arrived_at null     (:418-419)
//   stale         = PENDING + NOT_REVIEWED + older than 24h          (:424-426)
// While a queue is active it REPLACES the status pill + time-range filters
// (the queue defines the population; search/chips still narrow it).
const _QUEUE_CLOSED = ['RESOLVED', 'REJECTED', 'FALSE_ALARM'];         // analytics.py:289-293
const _QUEUE_SLA_HOURS = { CRITICAL: 1, SEVERE: 4, MODERATE: 12, MINOR: 24, UNKNOWN: 12 };  // analytics.py:309-312
const _QUEUE_STALE_HOURS = 24;                                          // analytics.py:385-386
function _slaDeadline(r) {
    const h = _QUEUE_SLA_HOURS[r.severity] != null ? _QUEUE_SLA_HOURS[r.severity] : 12;
    return new Date(ensureUTC(r.server_created_at)).getTime() + h * 3600e3;
}
const QUEUES = {
    'critical': {
        label: 'Critical incidents', icon: '🔴',
        desc: 'Open incidents at CRITICAL severity',
        pass: (r) => !_QUEUE_CLOSED.includes(r.status) && r.severity === 'CRITICAL',
        sort: 'priority',
    },
    'sla-risk': {
        label: 'SLA at-risk', icon: '⏳',
        desc: 'PENDING reports past their severity response target (1h critical / 4h severe / 12h moderate / 24h minor) - most overdue first',
        pass: (r) => r.status === 'PENDING' && Date.now() > _slaDeadline(r),
        sort: 'sla_breach',
    },
    'escalating': {
        label: 'Escalating buildings', icon: '⬆',
        desc: 'Reports on buildings with escalation risk >= 70 (the landing badge counts the BUILDINGS; this queue shows their reports)',
        pass: (r) => !_QUEUE_CLOSED.includes(r.status)
            && r.building_id && _escalatingBuildingIds && _escalatingBuildingIds.has(r.building_id),
        sort: 'priority',
        needsBuildings: true,
    },
    'verification': {
        label: 'Pending verification', icon: '🔍',
        desc: 'Reports awaiting a human review verdict (any status - an unreviewed resolved report still needs its verdict)',
        pass: (r) => (r.reviewer_verdict || 'NOT_REVIEWED') === 'NOT_REVIEWED',
        sort: 'oldest',
    },
    'triage': {
        label: 'Awaiting triage', icon: '📋',
        desc: 'PENDING and unreviewed - oldest first',
        pass: (r) => r.status === 'PENDING' && (r.reviewer_verdict || 'NOT_REVIEWED') === 'NOT_REVIEWED',
        sort: 'oldest',
    },
    'dispatch': {
        label: 'Dispatched, no arrival', icon: '🚑',
        desc: 'Help dispatched but arrival not yet confirmed',
        pass: (r) => !!r.help_dispatched_at && !r.help_arrived_at,
        sort: 'oldest',
    },
    'stale': {
        label: 'Stale (open & unreviewed)', icon: '⏱',
        desc: 'PENDING, unreviewed, older than 24 hours - oldest inactivity first',
        pass: (r) => r.status === 'PENDING'
            && (r.reviewer_verdict || 'NOT_REVIEWED') === 'NOT_REVIEWED'
            && (Date.now() - new Date(ensureUTC(r.server_created_at)).getTime()) > _QUEUE_STALE_HOURS * 3600e3,
        sort: 'oldest',
    },
    // ── Action-based Command Center pipeline (Jun 2026). Mutually exclusive:
    // active-ops wins if dispatched/responding; otherwise split by verdict.
    // These mirror analytics.py counts (needs_review / needs_response /
    // active_operations). The legacy keys above stay for back-compat.
    'needs-review': {
        label: 'Needs review', icon: '🔍',
        desc: 'New reports awaiting a verdict - most overdue first',
        pass: (r) => !_QUEUE_CLOSED.includes(r.status)
            && (r.reviewer_verdict || 'NOT_REVIEWED') === 'NOT_REVIEWED'
            && !r.help_dispatched_at && r.status !== 'RESPONDING',
        sort: 'sla_breach',
    },
    'needs-response': {
        label: 'Needs response', icon: '🚑',
        desc: 'Verified real and awaiting responder dispatch - oldest first',
        pass: (r) => !_QUEUE_CLOSED.includes(r.status)
            && r.reviewer_verdict === 'ACCEPTED'
            && !r.help_dispatched_at && r.status !== 'RESPONDING',
        sort: 'oldest',
    },
    'active-ops': {
        label: 'Active operations', icon: '🚁',
        desc: 'Responders dispatched, en route or on-scene - monitor to completion',
        pass: (r) => !_QUEUE_CLOSED.includes(r.status)
            && (!!r.help_dispatched_at || r.status === 'RESPONDING'),
        sort: 'oldest',
    },
    // Ungrouped critical - CRITICAL severity with NO operation (crisis_event_id
    // null). Backs the cluster chooser's "View ungrouped reports" action:
    // investigate the unassigned-critical reports WITHOUT creating an operation.
    // Mirrors the orphan-critical count the cluster card shows.
    'ungrouped': {
        label: 'Ungrouped critical', icon: '🚨',
        desc: 'Open CRITICAL reports not yet assigned to any operation - investigate, then optionally launch an operation to coordinate',
        pass: (r) => !_QUEUE_CLOSED.includes(r.status) && !r.crisis_event_id && r.severity === 'CRITICAL',
        sort: 'priority',
    },
    // Rejected reports - removed from the active feed + every other queue (see
    // _applyQueueFilter), reachable ONLY here for audit/re-triage.
    'rejected': {
        label: 'Rejected reports', icon: '🚫',
        desc: 'Reports an analyst rejected as invalid / spam / not actionable - kept for audit; not in the active feed or response queues',
        pass: (r) => r.reviewer_verdict === 'REJECTED',
        sort: 'recent',
    },
};
let _activeQueue = null;                 // queue key | null
let _escalatingBuildingIds = null;       // Set<building_id> (escalating queue prefetch)
let _queuePrevSort = null;               // restore the user's sort on queue exit
let _activeCrisisEventId = null;         // Operations Phase 2 - operation scope | null
let _scopeLoading = false;               // a fresh (scoped/global) feed fetch is in flight with no data yet → show "Loading…", never the prior/global list
// C1-b/c (Phase-0 scale hardening): the working set (allReports) is the newest
// window of a possibly-larger scope. `_scopeTotalCount` is the TRUE scope size
// (X-Total-Count from the last full refresh); `_scopeSummary` is the
// server-computed /analytics/summary for the active scope; `_scopeMarkers` is
// the full lean /reports/markers set. The last two are fetched ONLY when the
// feed is truncated so headline counts + the map stay correct at scale (and
// there is zero extra cost / behavior change at small scale).
let _scopeTotalCount = null;
let _scopeSummary = null;
let _scopeMarkers = null;

// True when the feed is windowed AND no narrowing filter is active - the moment
// we should trust server aggregates (summary counts, full marker set) over the
// truncated working set. With any active filter the client tally over the
// loaded set is the correct "what I see" number; at small scale it's exact.
function _scopeAggregatesActive() {
    const truncated = _scopeTotalCount != null && _scopeTotalCount > allReports.length;
    // The KPI strip + banner total are a SCOPE breakdown ("how big is this
    // crisis"), so the default status filter and the status-segment pill do NOT
    // suppress them - only a different-POPULATION narrowing (queue / search /
    // chips / an explicit custom time window) does, since those change WHICH
    // reports the scope refers to. At small scale (not truncated) the client
    // compute is exact, so this returns false and behavior is unchanged.
    const noNarrowing = (timeFilterHours || 0) <= 0 &&
        !_activeQueue && !treeSearchTerm &&
        !_activeBuildingId && !_triageScope &&
        !(_activeChipFilters && _activeChipFilters.size);
    return truncated && noNarrowing;
}

function _applyQueueFilter(reports) {
    // The "Rejected" view is the ONLY place rejected reports surface.
    if (_activeQueue === 'rejected') return reports.filter(r => r.reviewer_verdict === 'REJECTED');
    // Everywhere else (default feed + every other queue) hides them, so a rejected
    // report leaves the active feed + all review/response queues.
    const base = reports.filter(r => r.reviewer_verdict !== 'REJECTED');
    if (!_activeQueue || !QUEUES[_activeQueue]) return base;
    return base.filter(QUEUES[_activeQueue].pass);
}

// Operations Phase 2 - scope the incident feed to a single operation. Resets
// the delta cursor + ETag and clears the cache so the next fetch is a FULL,
// scoped refresh (no stale cross-operation reports leaking through a delta
// poll). Pass null to return to the global feed. cc-operations.js calls this
// when opening/closing an operation; the router clears it on every
// non-/operations route via the cc-operations teardown.
function setOperationScope(crisisEventId) {
    const next = crisisEventId || null;
    if (next === _activeCrisisEventId) return;
    _activeCrisisEventId = next;
    _lastServerTime = null;
    _lastReportsEtag = null;
    allReports = [];
    _scopeTotalCount = null;   // C1-b/c: invalidate the previous scope's aggregates
    _scopeSummary = null;
    _scopeMarkers = null;
    // New scope = a fresh truncation episode: clear any lingering banner + re-arm
    // so the (transient ~5s) "newest N of M" message shows ONCE for the new scope.
    try { _hideTruncationBanner(true); } catch (_e) {}
    _scopeLoading = true;      // a fresh scoped/global fetch starts now → loading state, not the just-cleared list
    // M12 (Phase-2): sticky chip filters must NOT silently carry into a newly-
    // entered operation scope - they'd under-count the op's incidents with no cue.
    try {
        if (_activeChipFilters && _activeChipFilters.size) {
            _activeChipFilters.clear(); _persistChipFilters(); _paintChipFilterUI();
        }
    } catch (_e) {}
    // Repaint the feed DOM to the loading state IMMEDIATELY. The #report-feed-list
    // still holds the PREVIOUS scope's cards; if we don't repaint now, revealing
    // the view (showIncidents) would flash them until the scoped fetch returns.
    try { renderFeed(); } catch (_e) {}
    try { window.__crispRouteTrace && window.__crispRouteTrace('setOperationScope', { scope: next || 'GLOBAL' }); } catch (_e) {}
    try { fetchReports(); } catch (_e) {}
}
window.setOperationScope = setOperationScope;
window.getOperationScope = () => _activeCrisisEventId;

// ── Jun 2026 navigation-clarity: Building + Triage as first-class FEED SCOPES ──
// Same axis as Operation, but applied CLIENT-SIDE on top of the op/global set: a
// building's reports are a subset of what's already loaded, so scoping to a
// building (or to the "no operation" triage bucket) needs NO refetch - it's a
// filter, like the queue/search filters. This is the spine of the
// Global → Operation/Triage → Building → Incident drill-down.
let _activeBuildingId = null;   // building-scoped feed (bld=<id>); null = all buildings
let _triageScope = false;       // op=none = reports not claimed by any operation

// Narrow the working set to the active building / triage scope. Called at the TOP
// of the feed render pipelines, BEFORE the queue/time/chip filters.
function _applyScopeFilter(reports) {
    let out = reports || [];
    if (_triageScope) out = out.filter((r) => !r.crisis_event_id);
    if (_activeBuildingId) out = out.filter((r) => r.building_id === _activeBuildingId);
    return out;
}

// ── Status TABS (Jun 2026 feed simplification) ────────────────────────────────
// The feed's primary status axis: Pending / Responding / Resolved. The active tab
// narrows the (always building-grouped) feed to that lifecycle bucket. The tab
// COUNTS (badge on each tab) are computed across the whole scope by
// updateCommandStats, so they show "how many are in each status" regardless of
// which tab is open. Replaces the old KPI pills + the flat NEEDS ACTION/RESPONDING/
// CLOSED sections + the Buildings/All-Incidents view toggle.
let _activeStatusTab = 'pending';
function _applyStatusTabFilter(reports) {
    const t = _activeStatusTab || 'pending';
    if (t === 'responding') return reports.filter((r) => r.status === 'RESPONDING');
    if (t === 'resolved') return reports.filter((r) => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM');
    return reports.filter((r) => r.status === 'PENDING' || r.status === 'VERIFIED');   // 'pending' (default)
}
// Inverse of _applyStatusTabFilter: which lifecycle tab OWNS a given status. Kept
// consistent with the predicates above. Used to reveal a deep-linked / newly-
// selected incident in its bucket when it lands outside the active tab (otherwise
// the tab filter hides its card and CrispNav.revealSelected can't scroll to it).
function _statusTabFor(status) {
    if (status === 'RESPONDING') return 'responding';
    if (status === 'RESOLVED' || status === 'FALSE_ALARM') return 'resolved';
    return 'pending';   // PENDING / VERIFIED (and any other) live in the default tab
}
window.setStatusTab = function (tab) {
    if (_activeQueue) return;   // a queue owns the lifecycle population - tabs are neutralized
    const _btn = document.querySelector(`.feed-tab[data-tab="${tab}"]`);
    if (_btn && _btn.classList.contains('tab-empty')) return;   // B3: empty bucket → non-interactive
    _activeStatusTab = (tab === 'responding' || tab === 'resolved' || tab === 'rejected') ? tab : 'pending';
    _syncStatusTabsEnabled();
    try { renderFeed(); } catch (_e) {}
};
window.getStatusTab = () => _activeStatusTab;
// Paint the status tabs' active/disabled state. When a queue owns the population
// (attention destination / rejected view) the lifecycle tabs don't apply, so we
// neutralize them (no .on highlight, aria-disabled, non-interactive) rather than
// claim a filter is active that isn't. Called from renderFeed + setStatusTab.
function _syncStatusTabsEnabled() {
    const wrap = document.querySelector('.feed-tabs');
    if (wrap) wrap.classList.toggle('tabs-queue-disabled', !!_activeQueue);
    document.querySelectorAll('.feed-tab').forEach((b) => {
        if (_activeQueue) {
            b.classList.remove('on'); b.setAttribute('aria-selected', 'false'); b.setAttribute('aria-disabled', 'true');
        } else {
            // B3: mute a tab whose lifecycle bucket is empty (count 0) so the
            // operator can't switch to a blank view. The ACTIVE tab is never muted
            // (so you can always see why the current view is empty).
            const cntEl = document.getElementById('count-' + b.dataset.tab);
            const cnt = Number((cntEl && cntEl.textContent) || '0');
            const isActive = b.dataset.tab === _activeStatusTab;
            const empty = cnt === 0 && !isActive;
            b.classList.toggle('tab-empty', empty);
            b.setAttribute('aria-disabled', empty ? 'true' : 'false');
            b.classList.toggle('on', isActive); b.setAttribute('aria-selected', isActive ? 'true' : 'false');
        }
    });
}

// Cross-cutting pill narrows (severity / originals-pending) layered on top of the
// scope + status-tab + queue population. The lifecycle pills are now TABS, so the
// only interactive pill is 'critical' (+ the command-bar originals-pending chip);
// legacy values stay honoured for old deep-links / saved views.
function _applyPillFilter(reports) {
    switch (_activePillFilter) {
        case 'critical':
            return reports.filter((r) => r.severity === 'CRITICAL');
        case 'pending':
            return reports.filter((r) => r.status === 'PENDING' || r.status === 'VERIFIED');
        case 'responding':
            return reports.filter((r) => r.status === 'RESPONDING');
        case 'resolved':
            return reports.filter((r) => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM');
        case 'originals_pending':
            return reports.filter((r) => {
                const imgs = (r.media || []).filter((m) => m.type === 'IMAGE');
                if (!imgs.length) return false;
                return groupPhotos(imgs).some((g) => {
                    const hi = g.members.find((m) => m.resolution_tier === 'ORIGINAL');
                    return !hi || hi.assembly_status !== 'complete';
                });
            });
        default:
            return reports;   // null / 'all'
    }
}

function setBuildingScope(buildingId) {
    const next = buildingId || null;
    if (next === _activeBuildingId) { try { renderFeed(); } catch (_e) {} return; }
    _activeBuildingId = next;
    // A single building reads better as a flat list than a one-card cluster — the
    // active-building scope already force-expands its cluster (see _forceOpen in
    // renderClusterFeed), so no view-mode switch is needed here.
    try { _writeScopeHash(); } catch (_e) {}
    try { renderFeed(); } catch (_e) {}   // re-paints feed + context banner
}
window.setBuildingScope = setBuildingScope;
window.getBuildingScope = () => _activeBuildingId;

function setTriageScope(on) {
    on = !!on;
    if (on === _triageScope) { try { renderFeed(); } catch (_e) {} return; }
    _triageScope = on;
    if (on) {
        // Triage = the GLOBAL set minus operation-claimed reports. Ensure the
        // server boundary is global (setOperationScope is a no-op if already
        // global), then filter client-side. Mutually exclusive with an operation.
        if (_activeCrisisEventId) { try { setOperationScope(null); } catch (_e) {} }
        _activeBuildingId = null;
    }
    try { _writeScopeHash(); } catch (_e) {}
    try { renderFeed(); } catch (_e) {}
}
window.setTriageScope = setTriageScope;
window.getTriageScope = () => _triageScope;

// Rewrite the #/incidents hash to reflect the current scope. One key per axis:
// op=<id> | op=none (triage); bld=<id>. Preserves other state segments (queue=,
// chips=…). Uses replaceState (no hashchange → no router re-dispatch → no loop);
// the breadcrumb provides up-navigation.
function _writeScopeHash() {
    try {
        let segs = [];
        if (window.__crispRouter && window.__crispRouter.parseHash) {
            segs = (window.__crispRouter.parseHash().stateSegs || []).slice();
        }
        segs = segs.filter((s) => !s.startsWith('op=') && !s.startsWith('bld='));
        if (_triageScope) segs.push('op=none');
        else if (_activeCrisisEventId) segs.push('op=' + encodeURIComponent(_activeCrisisEventId));
        if (_activeBuildingId) segs.push('bld=' + encodeURIComponent(_activeBuildingId));
        const next = '#' + ['/incidents'].concat(segs).join(';');
        if (location.hash !== next) {
            try { history.replaceState(null, '', location.pathname + location.search + next); }
            catch (_e) { location.hash = next; }
        }
    } catch (_e) {}
}
window._writeScopeHash = _writeScopeHash;   // so the op panel's "Exit to global" can drop ;op= from the URL

// ── Routing / data-init instrumentation ──────────────────────────────────────
// OFF by default. Enable with `localStorage.crisp_nav_trace = '1'` (or
// `window.__crispNavTrace = true`) to verify the load order with no hidden
// global-first path: dispatch → context detected → dataset loaded → incident
// auto-opened. Uses console.debug (hidden unless the console "Verbose" level is on).
window.__crispRouteTrace = function () {
    try {
        if (!window.__crispNavTrace &&
            !(window.localStorage && localStorage.getItem('crisp_nav_trace') === '1')) return;
        console.debug('[crisp-route]', ...arguments);
    } catch (_e) {}
};

// Read an operation scope already present in the URL (#/incidents;op=X) WITHOUT
// depending on the router having dispatched yet - used at cold boot so the FIRST
// fetch is already scoped (no global fetch+render before the router re-applies it).
function _scopeFromHash() {
    try {
        let segs = [];
        if (window.__crispRouter && window.__crispRouter.parseHash) {
            segs = window.__crispRouter.parseHash().stateSegs || [];
        } else {
            const raw = (location.hash || '').replace(/^#/, '').split('?')[0];
            segs = raw.split(';').filter(Boolean);
        }
        const seg = segs.find((s) => s.startsWith('op='));
        return seg ? (decodeURIComponent(seg.slice(3)) || null) : null;
    } catch (_e) { return null; }
}

// The feed "Loading…" placeholder. Scope-aware: names the operation so the
// operator sees the correct context BEFORE any incident card renders.
function _loadingFeedHtml() {
    const scope = (window.getOperationScope && window.getOperationScope()) || _activeCrisisEventId;
    let label = 'Loading incidents…';
    if (scope) {
        const op = (typeof _opMeta === 'function') ? _opMeta(scope) : null;
        label = 'Loading ' + (op && op.name ? escapeHtml(op.name) + ' Incidents…' : 'Operation Incidents…');
    }
    return `<div class="feed-empty-state feed-loading-state">
        <i class="fa-solid fa-circle-notch fa-spin" style="color:var(--info);"></i>
        <div class="feed-empty-title">${label}</div>
        <div class="feed-empty-sub">Fetching the latest reports for this view…</div>
    </div>`;
}

// Escalating prefetch - the badge's population lives on the buildings table
// (Building.escalation_risk / Building.state), not on report rows.
async function _loadEscalatingBuildings() {
    try {
        const base = API.replace('/api/v1/reports', '/api/v1/buildings');
        const res = await fetch(`${base}?sort_by=escalation_risk&order_dir=desc&limit=200`);
        if (!res.ok) throw new Error(String(res.status));
        const body = await res.json();
        const items = Array.isArray(body) ? body : (body.items || body.buildings || []);
        const closed = ['RESOLVED', 'ARCHIVED', 'FALSE_ALARM'];        // analytics.py:294
        _escalatingBuildingIds = new Set(items
            .filter((b) => Number(b.escalation_risk) >= 70 && !closed.includes(b.state))
            .map((b) => b.id));
    } catch (_e) {
        _escalatingBuildingIds = new Set();   // fail visible: queue shows 0 + banner stays
    }
    renderFeed();
    _renderContextBanner();
}

function _hashStateSegs() {
    return (location.hash || '').replace(/^#/, '').split(';').filter(Boolean)
        .filter((s) => !s.startsWith('/'));
}
function _queueFromHash() {
    const seg = _hashStateSegs().find((s) => s.startsWith('queue='));
    const key = seg ? seg.slice(6) : null;
    return key && QUEUES[key] ? key : null;
}

// Enter/exit a queue. updateHash=false when the change came FROM the hash
// (deep link, back/forward, refresh) to avoid feedback loops.
function setActiveQueue(key, updateHash = true) {
    key = key && QUEUES[key] ? key : null;
    if (key === _activeQueue && !updateHash) { _renderContextBanner(); return; }
    if (key && !_activeQueue) _queuePrevSort = cardSortMode;
    _activeQueue = key;
    if (key) {
        cardSortMode = QUEUES[key].sort;
        // A queue's members can live in ANY triage bucket (e.g. the
        // dispatch queue's cards sit under HELP SENT, collapsed by
        // default) - the user must immediately see the reports, so all
        // buckets open while a queue is active.
        sectionState = { needs: true, dispatched: true, resolved: true };
        if (QUEUES[key].needsBuildings && !_escalatingBuildingIds) _loadEscalatingBuildings();
    } else {
        if (_queuePrevSort) { cardSortMode = _queuePrevSort; _queuePrevSort = null; }
        sectionState = { needs: true, dispatched: false, resolved: false };
    }
    if (updateHash) {
        const segs = _hashStateSegs().filter((s) => !s.startsWith('queue='));
        if (key) segs.push('queue=' + key);
        const next = '#' + ['/incidents'].concat(segs).join(';');
        if (location.hash !== next) location.hash = next;
    }
    _renderContextBanner();
    renderFeed();
}
window.clearActiveQueue = () => setActiveQueue(null);

// Count reports matching the tree-search term (mirrors renderTreeFeed's haystack).
function _searchMatchCount() {
    const t = (treeSearchTerm || '').trim();
    if (!t) return 0;
    // Mirror the feed population (scope + rejected-hidden) so the banner's match
    // count agrees with what the search actually shows - not raw allReports.
    return _applyQueueFilter(_applyScopeFilter(allReports)).filter((r) => {
        const haystack = [
            r.description, r.infrastructure_type, r.severity, r.status, r.source,
            r.location && r.location.user_location_name, r.location && r.location.device_location_name,
            r._region, r._country, r.ai_analysis && r.ai_analysis.transcription, r.ai_analysis && r.ai_analysis.ai_summary,
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(t);
    }).length;
}
window.clearIncidentSearch = () => {
    const i = document.getElementById('tree-search');
    if (i) i.value = '';
    treeSearchTerm = '';
    try { sessionStorage.removeItem('crisp_incident_search'); } catch (_e) {}
    renderFeed();
};

// ROUTE-09 (Phase-5): the incident search filter now SURVIVES A REFRESH. The
// ?incident= detail already restored on reload, but the search term was dropped
// (it lived only in memory), so a refresh reopened the detail over an unfiltered
// feed - inconsistent. Persist the term per-tab in sessionStorage (no hash/router
// change → no deep-link-loop risk) and restore it on boot. The search box's
// oninput calls this (index.html).
window._onIncidentSearch = function (v) {
    treeSearchTerm = (v || '').toLowerCase();
    try {
        if (treeSearchTerm) sessionStorage.setItem('crisp_incident_search', treeSearchTerm);
        else sessionStorage.removeItem('crisp_incident_search');
    } catch (_e) {}
    try { renderFeed(); } catch (_e) {}
};
function _restoreIncidentSearch() {
    try {
        const t = sessionStorage.getItem('crisp_incident_search');
        if (!t) return;
        treeSearchTerm = t;
        const i = document.getElementById('tree-search');
        if (i && !i.value) i.value = t;
    } catch (_e) {}
}

// Unified Incident Context Banner - ALWAYS rendered at the top of the feed panel
// so the analyst can answer WHERE / WHAT / WHY / WHAT-NEXT in seconds. Replaces
// the queue-only banner. Precedence: operation scope > active queue > search >
// global. Each state names the scope, the count, the reason, and a clear/exit.
function _renderContextBanner() {
    // v116: paints the feed HEADER scope bar (Global › Operation + Switch) - this
    // replaced the old standalone #queue-banner card. The per-scope count moved out
    // to the status-tab row (#count-dual) so the header is a single clean breadcrumb.
    const banner = document.getElementById('feed-scope-bar');
    if (!banner) return;
    // C1-b: show the TRUE scope size (X-Total-Count), not the truncated working
    // set, for the GLOBAL/OPERATION headline. Falls back to the loaded length
    // before the first full refresh / at small scale (where they're equal).
    // Rejected-excluded, scope-aware live count so the headline agrees with the
    // status tabs (which exclude rejected). At truncated scale the server total wins.
    const _liveCount = _applyScopeFilter(allReports).filter((r) => r.reviewer_verdict !== 'REJECTED').length;
    const total = (_scopeTotalCount != null ? _scopeTotalCount : _liveCount);
    const search = (treeSearchTerm || '').trim();
    let cls, icon, countTxt;
    // Client-side scopes (building/triage) count the FILTERED set - _scopeTotalCount
    // is the server total for the op/global boundary only.
    const _scopedLen = _liveCount;

    // Jun 2026 simplification: the banner is now ONE breadcrumb row. The scope name
    // is the last crumb (no redundant big label); the Total is folded inline as the
    // count; row 2 (the status tabs) carries the per-status numbers.
    if (_activeBuildingId) {
        cls = 'ctx-bldg'; icon = '🏢';
        countTxt = _scopedLen + ' incident' + (_scopedLen === 1 ? '' : 's');
    } else if (_triageScope) {
        cls = 'ctx-triage'; icon = '🧭';
        countTxt = _scopedLen + ' incident' + (_scopedLen === 1 ? '' : 's');
    } else if (_activeCrisisEventId) {
        cls = 'ctx-op'; icon = '🎯';
        countTxt = _dualCount(total);
    } else if (_activeQueue && QUEUES[_activeQueue]) {
        const matched = _applyQueueFilter(allReports).length;
        const bCount = _activeQueue === 'escalating' && _escalatingBuildingIds
            ? ' · ' + _escalatingBuildingIds.size + ' building(s)' : '';
        cls = 'ctx-queue ctx-queue-' + _activeQueue; icon = QUEUES[_activeQueue].icon;
        countTxt = matched + ' incident' + (matched === 1 ? '' : 's') + bCount;
    } else if (search) {
        const matched = _searchMatchCount();
        cls = 'ctx-search'; icon = '🔍';
        countTxt = matched + ' match' + (matched === 1 ? '' : 'es');
    } else {
        cls = 'ctx-global'; icon = '🌐';
        countTxt = _dualCount(total);
    }

    // ONE scope control: the operation/global switcher (its menu lists Global +
    // every operation). Replaces the separate "Global" exit AND the standalone
    // Rejected button (Rejected now lives in the Filters popover).
    const switchBtn = '<button class="ctx-switch" onclick="window.__crispToggleOpSwitcher(event)" title="Switch between operations and global">' +
        '<i class="fa-solid fa-arrow-right-arrow-left"></i> Switch</button>';

    // Active attention-category shows as a clearable chip beside the switch, so the
    // category is named even though the breadcrumb leaf stays the scope.
    const queueChip = (_activeQueue && QUEUES[_activeQueue])
        ? '<button class="ctx-switch ctx-qchip" onclick="clearActiveQueue()" title="Clear the category filter">' + escapeHtml(String(QUEUES[_activeQueue].label || '').toUpperCase()) + ' ✕</button>'
        : '';

    banner.className = 'ctx-banner ' + cls;
    banner.style.display = 'flex';
    banner.innerHTML =
        '<span class="qb-icon" aria-hidden="true">' + icon + '</span>' +
        '<span class="qb-text">' + _buildScopeCrumbs() +
            '<span class="qb-total" title="Total incidents in this scope (all statuses)">' + countTxt + '</span>' +
        '</span>' +
        '<span class="qb-actions">' + queueChip + switchBtn + '</span>';
    // TOTAL incidents now sits in the HEADER next to the scope crumb (operator
    // request). The old status-tab-row count (#count-dual) is cleared so the same
    // number isn't shown twice (and so it never contradicts the hierarchy summary,
    // which counts only the ACTIVE status tab).
    const dual = document.getElementById('count-dual');
    if (dual) dual.textContent = '';
}

// The clickable scope SPINE: Global › [Operation|Triage] › [Building]. Each crumb
// steps UP one level (the leaf below the spine names the current view + count).
// This is the "where am I / how did I get here" surface.
function _buildScopeCrumbs() {
    const sep = '<span class="qb-bc-sep" aria-hidden="true">›</span>';
    const parts = ['<a class="qb-crumb qb-crumb-global" onclick="window.setIncidentOp&&window.setIncidentOp(null)">Global</a>'];
    if (_triageScope) {
        parts.push('<span class="qb-crumb qb-crumb-cur">Triage</span>');
    } else if (_activeCrisisEventId) {
        const nm = (_opMeta(_activeCrisisEventId) || {}).name || 'Operation';
        // When a building is also active, the operation is a clickable step-up;
        // otherwise it's the current leaf.
        parts.push(_activeBuildingId
            ? '<a class="qb-crumb qb-crumb-op" onclick="window.setIncidentOp&&window.setIncidentOp(decodeURIComponent(\'' + encodeURIComponent(_activeCrisisEventId) + '\'))">' + escapeHtml(nm) + '</a>'
            : '<span class="qb-crumb qb-crumb-cur">' + escapeHtml(nm) + '</span>');
    }
    if (_activeBuildingId) {
        parts.push('<span class="qb-crumb qb-crumb-cur">' + escapeHtml(_activeBuildingName() || 'Building') + '</span>');
    }
    return '<nav class="qb-crumbs" aria-label="Scope">' + parts.join(sep) + '</nav>';
}

// Best-effort building display name for the breadcrumb/banner: the OSM/infra name
// from any loaded report tagged to the active building (no fetch). Falls back to
// "Building".
function _activeBuildingName() {
    if (!_activeBuildingId) return '';
    try {
        // OSM building name ONLY (_taggedBuildingName) - never the reporter's free-text
        // "what was hit" (infrastructure_name_from_osm === false).
        const r = (allReports || []).find((x) => x && x.building_id === _activeBuildingId && _taggedBuildingName(x));
        if (r) return r.infrastructure_name;
    } catch (_e) {}
    return 'Building';
}

// P4: distinct incident clusters in the active scope. Prefers the server's
// scope-wide cluster_count (honest at 500k scale); falls back to grouping the
// loaded working set (building_id → h3 → singleton). Powers the dual count.
function _scopeClusterCount() {
    try {
        if (_scopeSummary && _scopeSummary.counts && typeof _scopeSummary.counts.cluster_count === 'number') {
            return _scopeSummary.counts.cluster_count;
        }
    } catch (_e) {}
    const keys = new Set();
    for (const r of allReports) keys.add(_clusterKey(r));
    return keys.size;
}
// ONE scope metric: "N incidents" — the REAL first-class incident count
// (analytics counts.incidents = distinct incident_id + incident-less singletons,
// scoped server-side, #12-cheap). Falls back to the feed's X-Total-Count (primary
// reports) only before the scope summary has loaded. `total` is that fallback.
function _dualCount(total) {
    // Header total = REPORTS in scope (the superset), matching the home Command Centre
    // "Total reports" tile EXACTLY so the two surfaces never show different totals.
    // (Previously this showed counts.incidents = deduped entities, which disagreed with
    // the home's report total.) Falls back to the feed's X-Total-Count before the scope
    // summary has loaded.
    let reports = total;
    try {
        const c = _scopeSummary && _scopeSummary.counts;
        if (c && typeof c.reports === 'number') reports = c.reports;
    } catch (_e) {}
    return reports + ' report' + (reports === 1 ? '' : 's');
}

// ── Buildings needing duplicate review — awareness card (global feed) ─────────
// REPLACES the old global "Merge all" panel. Per the building-centric model, two
// reports in different buildings can NEVER be duplicates, so review is always
// anchored to a building - merge/decisions therefore live ONLY in the Building
// workspace (and the operation workspace), never globally. This card is READ-ONLY
// awareness: it surfaces WHICH buildings have unsettled duplicate candidates and
// drills straight into each building's workspace, where the analyst decides.
// Reuses GET /reports/buildings-needing-review (building-scoped _rdd_candidate_pairs,
// so it agrees with /duplicate-summary). Throttled fetch; scoped to the active
// operation when one is open. Busted by building-level merge handlers below.
let _dupSummaryCache = { ts: 0, scope: undefined, data: null };
// Jun 2026 — the global "Buildings needing duplicate review" AWARENESS PANEL was
// removed from the top of the feed. Duplicate review now lives where it belongs:
// (1) a per-building DUP COUNT badge on each building row in the feed (below) that
// opens the building console's Potential-Duplicates + merge controls, and (2) the
// Operations summary page's "N buildings need duplicate review" chip. This keeps the
// SAME fetch (GET /reports/buildings-needing-review, scope-aware) but ingests it into
// a per-building map the cluster rows read, instead of painting a top banner.
let _dupReviewMap = {};   // building_id → { pairs, high }
async function _refreshDupReviewMap(force) {
    // Tear down any stale top panel left by an older build.
    const old = document.getElementById('dup-review-panel');
    if (old) old.remove();
    const scope = _activeCrisisEventId || null;
    const now = Date.now();
    if (!force && _dupSummaryCache.data && _dupSummaryCache.scope === scope && (now - _dupSummaryCache.ts) < 30000) {
        _ingestDupReview(_dupSummaryCache.data); _paintDupBadges(); return;
    }
    try {
        const url = API + '/buildings-needing-review' + (scope ? '?crisis_event_id=' + encodeURIComponent(scope) : '');
        const res = await fetch(url, { headers: { Authorization: 'Bearer ' + (localStorage.getItem('crisp_token') || '') } });
        if (!res.ok) return;
        const data = await res.json();
        _dupSummaryCache = { ts: now, scope, data };
        _ingestDupReview(data); _paintDupBadges();
    } catch (_e) { /* leave the prior map; badges just don't update */ }
}
function _ingestDupReview(d) {
    const map = {};
    for (const b of ((d && d.buildings) || [])) {
        if (b && b.building_id) map[b.building_id] = { pairs: b.candidate_pairs || 0, high: b.high || 0 };
    }
    _dupReviewMap = map;
}
// Fill the per-building dup-count slots rendered on the feed's building rows. The
// slot carries data-dup-bld=<building_id>; a building with no candidate pairs hides
// its badge. Clicking the row (the badge bubbles up) opens the building console,
// whose Potential-Duplicates section holds the merge controls.
function _paintDupBadges() {
    document.querySelectorAll('[data-dup-bld]').forEach((el) => {
        const d = _dupReviewMap[el.getAttribute('data-dup-bld')];
        if (d && d.pairs > 0) {
            el.style.display = '';
            el.innerHTML = '<i class="fa-solid fa-clone"></i> ' + d.pairs + (d.high ? ' · ' + d.high + ' high' : '');
            el.setAttribute('title', d.pairs + ' potential duplicate pair' + (d.pairs === 1 ? '' : 's')
                + (d.high ? ' (' + d.high + ' high-confidence)' : '') + ' — open the building to review & merge');
        } else {
            el.style.display = 'none';
            el.innerHTML = '';
        }
    });
}

// ── Operation switcher (Jun 2026) ────────────────────────────────────────────
// Scope the GLOBAL incidents feed to any operation (or back to global) directly
// from the feed, via #/incidents;op={id}. The op list is fetched once + cached;
// the context banner names the active operation + its region. Arriving from an
// operation dashboard ("Open Incident Feed", or clicking an op incident row)
// carries the op so context persists (the router applies the scope from the
// hash, see dispatch()).
let _opsCache = [];
function _opMeta(id) { return _opsCache.find((o) => o && o.id === id) || null; }
async function _loadOpsForSwitcher(force) {
    if (_opsCache.length && !force) return _opsCache;
    try {
        const res = await fetch(API.replace('/api/v1/reports', '/api/v1/operations'), {
            headers: { Authorization: 'Bearer ' + (localStorage.getItem('crisp_token') || '') },
        });
        if (res.ok) { const b = await res.json(); _opsCache = Array.isArray(b) ? b : (b.items || b.operations || []); }
    } catch (_e) {}
    return _opsCache;
}
function _closeOpSwitcher() { const m = document.getElementById('op-switcher-menu'); if (m) m.style.display = 'none'; }
window.setIncidentOp = function (opId) {
    // Switching operation drops any building filter (a building belongs to one op)
    // + any triage state; the router re-applies scopes from the new hash.
    const segs = _hashStateSegs().filter((s) => !s.startsWith('op=') && !s.startsWith('queue=') && !s.startsWith('bld='));
    if (opId) segs.push('op=' + encodeURIComponent(opId));
    const next = '#' + ['/incidents'].concat(segs).join(';');
    _closeOpSwitcher();
    if (location.hash !== next) location.hash = next; else _renderContextBanner();
};
// M3 (Phase-2): force a fresh op fetch + re-render after an operation is launched,
// ended, or deactivated, so the switcher + banner never present a dead op as a
// live scope target (or miss a just-launched one) until a full reload. Called by
// cc-wizard (launch) and cc-crisis (activate/deactivate toggle).
window.__crispRefreshOps = function () {
    _opsCache = [];
    return _loadOpsForSwitcher(true).then(() => { try { _renderContextBanner(); } catch (_e) {} });
};
// Called by the router after it applies the op scope on a /incidents dispatch.
// M6 (Phase-2): also drive the shell's GLOBAL/OP scope chip so it can never read
// GLOBAL while the in-feed banner reads OPERATION - the two indicators must agree.
window.__crispOnIncidentOpScope = function (opId) {
    const applyShellCtx = () => {
        try {
            const sh = window.__crispShell;
            if (!sh) return;
            if (opId && sh.setOpContext) { const m = _opMeta(opId); sh.setOpContext(opId, (m && m.name) || 'Operation'); }
            else if (!opId && sh.clearOpContext) { sh.clearOpContext(); }
        } catch (_e) {}
    };
    if (opId && !_opMeta(opId)) {
        _loadOpsForSwitcher().then(() => { try { _renderContextBanner(); } catch (_e) {} applyShellCtx(); });
    }
    _renderContextBanner();
    applyShellCtx();
};
window.__crispToggleOpSwitcher = async function (ev) {
    if (ev) ev.stopPropagation();
    let menu = document.getElementById('op-switcher-menu');
    if (menu && menu.style.display === 'block') { menu.style.display = 'none'; return; }
    if (!menu) {
        menu = document.createElement('div'); menu.id = 'op-switcher-menu';
        document.body.appendChild(menu);
        document.addEventListener('click', (e) => { if (!e.target.closest('#op-switcher-menu, .ctx-switch')) _closeOpSwitcher(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _closeOpSwitcher(); });
    }
    const btn = ev && (ev.currentTarget || (ev.target && ev.target.closest && ev.target.closest('.ctx-switch')));
    const r = btn ? btn.getBoundingClientRect() : { left: 380, bottom: 130 };
    menu.style.display = 'block';
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 308)) + 'px';
    menu.style.top = (r.bottom + 5) + 'px';
    menu.innerHTML = '<div class="osw-empty">Loading operations…</div>';
    await _loadOpsForSwitcher(true);   // M3: always fetch fresh on open - ENDED ops drop out, newly-launched ops appear
    const cur = _activeCrisisEventId;
    const esc = (s) => escapeHtml(String(s == null ? '' : s));
    const item = (id, name, sub, active) =>
        '<button class="osw-item' + (active ? ' active' : '') + '" onclick="window.setIncidentOp(' + (id ? '\'' + esc(id) + '\'' : 'null') + ')">' +
        '<span class="osw-main"><span class="osw-name">' + esc(name) + '</span>' +
        (sub ? '<span class="osw-sub">' + esc(sub) + '</span>' : '') + '</span>' +
        (active ? '<i class="fa-solid fa-check osw-check"></i>' : '') + '</button>';
    let html = '<div class="osw-h">Switch incidents view</div>';
    html += item(null, '🌐 Global incidents', 'All incidents worldwide', !cur);
    const live = (_opsCache || []).filter((o) => o && String(o.status || '').toUpperCase() !== 'ENDED');
    html += '<div class="osw-sec">Operations</div>';
    html += live.length
        ? live.map((o) => item(o.id, o.name || 'Operation',
            (o.place_name ? o.place_name + ' · ' : '') + (Number(o.critical) || 0).toLocaleString() + ' critical', o.id === cur)).join('')
        : '<div class="osw-empty">No active operations</div>';
    menu.innerHTML = html;
};

// Deep-link sync: applies `;queue=` from the hash on boot, on back/forward,
// and on refresh. Runs alongside the router's own hashchange handling.
function _syncQueueFromHash() {
    const route = ((location.hash || '').replace(/^#/, '').split(';').find((s) => s.startsWith('/')) || '');
    if (route && route !== '/incidents') return;   // queue state belongs to ops only
    const key = _queueFromHash();
    if (key !== _activeQueue) setActiveQueue(key, false);
}
// ROUTE-08 (Phase-3): the router's dispatch() now calls this INSIDE the ordered
// /incidents dispatch (router.js), so we no longer register a SEPARATE
// hashchange listener that raced dispatch() (two listeners on one event →
// double render, no ordering guarantee). The boot sync below still covers
// cold-load deep-links + refresh.
window._syncQueueFromHash = _syncQueueFromHash;
// Boot sync - covers deep links + refresh. DOMContentLoaded may already have
// fired by the time this script block runs, so sync immediately in that case.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(() => { _syncQueueFromHash(); _restoreIncidentSearch(); }, 0));
} else {
    setTimeout(() => { _syncQueueFromHash(); _restoreIncidentSearch(); }, 0);
}

// v56: the secondary filter-chip row used to sit in the (now-removed) command
// bar where it was hidden behind it. Re-parent it INTO the feed panel, right
// under the KPI strip, so it lives beside the feed it filters (and is finally
// clickable). Same boot-reparent pattern as the shell's reparentChrome.
(function _relocateFilterRow() {
    const move = () => {
        const row = document.getElementById('cmd-filter-row');
        const tabs = document.querySelector('.feed-panel .feed-tabs');
        if (row && tabs && row.previousElementSibling !== tabs) tabs.insertAdjacentElement('afterend', row);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', move);
    else move();
})();

// FILTERS popover (Jun 2026 simplification): the secondary filter chips + Saved
// Views + the Rejected entry now OPEN FROM the filter icon in the tabs row, instead
// of being an always-inline strip. Hidden until the icon is clicked; closes on
// outside-click / Escape. The active-filter count shows as a badge on the icon
// (#cmd-filter-active-count, synced by renderFeed → _syncFilterActiveCount).
(function _setupFilterPopover() {
    const setup = () => {
        const row = document.getElementById('cmd-filter-row');
        if (!row || row.dataset.popoverReady) return;
        row.dataset.popoverReady = '1';
        row.classList.add('cmd-filter-pop');   // styled as an absolute popover (hidden until .open)
        document.addEventListener('click', (e) => {
            if (!row.classList.contains('open')) return;
            if (e.target.closest('#cmd-filter-row, #feed-filter-btn')) return;
            row.classList.remove('open');
        });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') row.classList.remove('open'); });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
    else setup();
})();
window.__crispToggleFilters = function (ev) {
    if (ev) ev.stopPropagation();
    const row = document.getElementById('cmd-filter-row');
    if (row) row.classList.toggle('open');
};
// Keep the filter icon's active-count badge in sync so a closed popover still
// shows how many filters are applied. Cheap; called from renderFeed.
function _syncFilterActiveCount() {
    const badge = document.getElementById('cmd-filter-active-count');
    if (!badge) return;
    const n = (typeof _activeChipFilters !== 'undefined' && _activeChipFilters && _activeChipFilters.size) || 0;
    badge.textContent = n ? String(n) : '';
    badge.style.display = n ? 'inline-block' : 'none';
}

// ── Overlay coordination (Jun 2026) ──────────────────────────────────────────
// Fixes the "panels stack / no close / hidden behind something" class of bugs
// from the overlay audit: a guaranteed ✕ on the analytics panel, mutual
// exclusion across the in-page panels (+ closing an open detail that would
// float over them at z 100000), and a GLOBAL Escape that closes the topmost
// open dropdown / panel / transient modal. The detail panel, fullscreen report,
// PhotoSwipe, wizard, and cluster chooser already self-handle Escape.
(function _crispOverlayCoordination() {
    const PANELS = ['analytics-panel', 'predictions-panel', 'deletions-panel', 'moderation-panel'];
    const _vis = (el) => !!el && el.style.display !== 'none' && getComputedStyle(el).display !== 'none';
    const _ready = (fn) => { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn); else fn(); };

    window.__crispCloseInPagePanels = function (exceptId) {
        PANELS.forEach((id) => {
            if (id === exceptId) return;
            const p = document.getElementById(id);
            if (_vis(p)) p.style.display = 'none';
        });
    };
    function _detailOpen() {
        const d = document.getElementById('detail-panel');
        return !!(d && d.style.display && d.style.display !== 'none');
    }
    // Open an in-page panel exclusively: close the other panels + an open detail
    // panel (which would otherwise float over it at z-100000).
    window.__crispOpenExclusivePanel = function (id) {
        window.__crispCloseInPagePanels(id);
        try { if (_detailOpen() && window.closeDetail) window.closeDetail(); } catch (_e) {}
    };

    // Analytics shipped without a ✕ close - inject one (matches deletions /
    // moderation / predictions, which already have a header close button).
    _ready(function () {
        const p = document.getElementById('analytics-panel');
        if (p && !p.querySelector('.panel-x-close')) {
            const x = document.createElement('button');
            x.type = 'button'; x.className = 'panel-x-close';
            x.setAttribute('aria-label', 'Close analytics');
            x.innerHTML = '<i class="fa-solid fa-xmark"></i>';
            x.onclick = () => { p.style.display = 'none'; };
            p.appendChild(x);
        }
    });

    // Global Escape - close the topmost OPEN surface that does not already
    // self-handle Escape: transient modal → header dropdown → in-page panel →
    // notification panel. One press closes one layer (never the wrong thing).
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        const modal = document.querySelector('.reclaim-modal-backdrop, .ai-logic-overlay, .lightbox-overlay');
        if (modal) { modal.remove(); return; }
        const dd = document.querySelector('.export-dropdown.open');
        if (dd) { dd.classList.remove('open'); return; }
        for (const id of PANELS) { const p = document.getElementById(id); if (_vis(p)) { p.style.display = 'none'; return; } }
        // Incident detail / building console (D2) - a body-level overlay that
        // previously ignored Escape. Skip if a child modal (reason / sat-compare)
        // is open, since those self-handle Escape.
        const dp = document.getElementById('detail-panel');
        if (_vis(dp) && !document.querySelector('.bc-reason-modal-overlay, .dp-compare-overlay')) {
            try { window.closeDetail && window.closeDetail(); } catch (_e) { dp.style.display = 'none'; }
            return;
        }
        const np = document.getElementById('notif-panel');
        if (_vis(np)) { np.style.display = 'none'; }
    });

    // D5: tear down the in-page panels + transient modals on route change so they
    // can't orphan onto the next route (the analytics panel survived a route
    // change and reappeared over the wrong page). Exposed for router.hideAll().
    // The detail panel is intentionally NOT closed here - it owns its ?incident=
    // deep-link lifecycle (navigate() clears the selection when leaving the route).
    window.__ccCloseTransientOverlays = () => {
        try {
            document.querySelectorAll('.reclaim-modal-backdrop, .ai-logic-overlay, .lightbox-overlay, .bc-reason-modal-overlay, .dp-compare-overlay')
                .forEach((n) => { try { n.remove(); } catch (_e) {} });
            for (const id of PANELS) { const p = document.getElementById(id); if (_vis(p)) p.style.display = 'none'; }
        } catch (_e) {}
    };
})();

// Phase G.5 (May 2026) - Bulk multi-select state.
// `_bulkSelectMode` toggles the checkbox UI; `_bulkSelectedIds` is
// the Set of currently-selected report ids. Both reset on view-mode
// switch + on closeBulkSelection().
let _bulkSelectMode = false;
let _bulkSelectedIds = new Set();
let sectionState = { needs: true, dispatched: false, resolved: false };
// Priority sort: severity first, then infrastructure criticality, then recency
const SEV_PRIORITY = { CRITICAL: 4, SEVERE: 3, MODERATE: 2, MINOR: 1, UNKNOWN: 0 };
const INFRA_CARD_ICONS = {
    HOSPITAL: 'fa-hospital', POWER_PLANT: 'fa-bolt', POWER: 'fa-bolt',
    WATER_TREATMENT: 'fa-droplet', WATER: 'fa-droplet', ROAD: 'fa-road',
    BRIDGE: 'fa-archway', SCHOOL: 'fa-school', HOUSE: 'fa-house-crack',
    TELECOM: 'fa-tower-cell', GOVERNMENT: 'fa-landmark',
    OTHER: 'fa-triangle-exclamation'
};
const CLUSTER_RADIUS_KM = 15; // Merge regions within 15km

// ── Country / Continent Mappings ─────────────────────────────────────────────
const COUNTRY_TO_CONTINENT = {
    "DZ":"AF","AO":"AF","BJ":"AF","BW":"AF","BF":"AF","BI":"AF","CV":"AF","CM":"AF","CF":"AF","TD":"AF","KM":"AF","CD":"AF","CG":"AF","DJ":"AF","EG":"AF","GQ":"AF","ER":"AF","SZ":"AF","ET":"AF","GA":"AF","GM":"AF","GH":"AF","GN":"AF","GW":"AF","CI":"AF","KE":"AF","LS":"AF","LR":"AF","LY":"AF","MG":"AF","MW":"AF","ML":"AF","MR":"AF","MU":"AF","YT":"AF","MA":"AF","MZ":"AF","NA":"AF","NE":"AF","NG":"AF","RE":"AF","RW":"AF","SH":"AF","ST":"AF","SN":"AF","SC":"AF","SL":"AF","SO":"AF","ZA":"AF","SS":"AF","SD":"AF","TZ":"AF","TG":"AF","TN":"AF","UG":"AF","EH":"AF","ZM":"AF","ZW":"AF",
    "AF":"AS","AM":"AS","AZ":"AS","BH":"AS","BD":"AS","BT":"AS","BN":"AS","KH":"AS","CN":"AS","CY":"AS","GE":"AS","HK":"AS","IN":"AS","ID":"AS","IR":"AS","IQ":"AS","IL":"AS","JP":"AS","JO":"AS","KZ":"AS","KP":"AS","KR":"AS","KW":"AS","KG":"AS","LA":"AS","LB":"AS","MO":"AS","MY":"AS","MV":"AS","MN":"AS","MM":"AS","NP":"AS","OM":"AS","PK":"AS","PS":"AS","PH":"AS","QA":"AS","SA":"AS","SG":"AS","LK":"AS","SY":"AS","TW":"AS","TJ":"AS","TH":"AS","TL":"AS","TR":"AS","TM":"AS","UZ":"AS","VN":"AS","YE":"AS",
    "AL":"EU","AD":"EU","AT":"EU","BY":"EU","BE":"EU","BA":"EU","BG":"EU","HR":"EU","CZ":"EU","DK":"EU","EE":"EU","FO":"EU","FI":"EU","FR":"EU","DE":"EU","GI":"EU","GR":"EU","HU":"EU","IS":"EU","IE":"EU","IT":"EU","LV":"EU","LI":"EU","LT":"EU","LU":"EU","MK":"EU","MT":"EU","MD":"EU","MC":"EU","ME":"EU","NL":"EU","NO":"EU","PL":"EU","PT":"EU","RO":"EU","RU":"EU","SM":"EU","RS":"EU","SK":"EU","SI":"EU","ES":"EU","SJ":"EU","SE":"EU","CH":"EU","UA":"EU","GB":"EU","VA":"EU",
    "AI":"NA","AG":"NA","AW":"NA","BS":"NA","BB":"NA","BZ":"NA","BM":"NA","VG":"NA","CA":"NA","KY":"NA","CR":"NA","CU":"NA","CW":"NA","DM":"NA","DO":"NA","SV":"NA","GL":"NA","GD":"NA","GP":"NA","GT":"NA","HT":"NA","HN":"NA","JM":"NA","MQ":"NA","MX":"NA","MS":"NA","KN":"NA","LC":"NA","PM":"NA","VC":"NA","SX":"NA","TT":"NA","TC":"NA","US":"NA",
    "AS":"OC","AU":"OC","CK":"OC","FJ":"OC","PF":"OC","GU":"OC","KI":"OC","MH":"OC","FM":"OC","NR":"OC","NC":"OC","NZ":"OC","NU":"OC","NF":"OC","MP":"OC","PW":"OC","PG":"OC","PN":"OC","WS":"OC","SB":"OC","TK":"OC","TO":"OC","TV":"OC","UM":"OC","VU":"OC","WF":"OC",
    "AR":"SA","BO":"SA","BR":"SA","CL":"SA","CO":"SA","EC":"SA","FK":"SA","GF":"SA","GY":"SA","PY":"SA","PE":"SA","SR":"SA","UY":"SA","VE":"SA",
    "AQ":"AN",
    "AFG":"AS","IND":"AS","USA":"NA","GBR":"EU","FRA":"EU","DEU":"EU","ITA":"EU","ESP":"EU","CAN":"NA","MEX":"NA","BRA":"SA","ARG":"SA","ZAF":"AF","NGA":"AF","KEN":"AF","ETH":"AF","EGY":"AF","DZA":"AF","MAR":"AF","SDN":"AF","SSD":"AF","COD":"AF","UGA":"AF","SOM":"AF","MLI":"AF","NER":"AF","TCD":"AF","CAF":"AF","UKR":"EU","RUS":"EU","CHN":"AS","JPN":"AS","AUS":"OC","NZL":"OC","POL":"EU","CHE":"EU"
};

const ISO2_TO_ISO3 = {"AF":"AFG","AL":"ALB","DZ":"DZA","AD":"AND","AO":"AGO","AG":"ATG","AR":"ARG","AM":"ARM","AU":"AUS","AT":"AUT","AZ":"AZE","BS":"BHS","BH":"BHR","BD":"BGD","BB":"BRB","BY":"BLR","BE":"BEL","BZ":"BLZ","BJ":"BEN","BT":"BTN","BO":"BOL","BA":"BIH","BW":"BWA","BR":"BRA","BN":"BRN","BG":"BGR","BF":"BFA","BI":"BDI","KH":"KHM","CM":"CMR","CA":"CAN","CV":"CPV","CF":"CAF","TD":"TCD","CL":"CHL","CN":"CHN","CO":"COL","KM":"COM","CG":"COG","CD":"COD","CR":"CRI","CI":"CIV","HR":"HRV","CU":"CUB","CY":"CYP","CZ":"CZE","DK":"DNK","DJ":"DJI","DM":"DMA","DO":"DOM","EC":"ECU","EG":"EGY","SV":"SLV","GQ":"GNQ","ER":"ERI","EE":"EST","ET":"ETH","FJ":"FJI","FI":"FIN","FR":"FRA","GA":"GAB","GM":"GMB","GE":"GEO","DE":"DEU","GH":"GHA","GR":"GRC","GD":"GRD","GT":"GTM","GN":"GIN","GW":"GNB","GY":"GUY","HT":"HTI","HN":"HND","HU":"HUN","IS":"ISL","IN":"IND","ID":"IDN","IR":"IRN","IQ":"IRQ","IE":"IRL","IL":"ISR","IT":"ITA","JM":"JAM","JP":"JPN","JO":"JOR","KZ":"KAZ","KE":"KEN","KI":"KIR","KP":"PRK","KR":"KOR","KW":"KWT","KG":"KGZ","LA":"LAO","LV":"LVA","LB":"LBN","LS":"LSO","LR":"LBR","LY":"LBY","LI":"LIE","LT":"LTU","LU":"LUX","MK":"MKD","MG":"MDG","MW":"MWI","MY":"MYS","MV":"MDV","ML":"MLI","MT":"MLT","MH":"MHL","MR":"MRT","MU":"MUS","MX":"MEX","FM":"FSM","MD":"MDA","MC":"MCO","MN":"MNG","ME":"MNE","MA":"MAR","MZ":"MOZ","MM":"MMR","NA":"NAM","NR":"NRU","NP":"NPL","NL":"NLD","NZ":"NZL","NI":"NIC","NE":"NER","NG":"NGA","NO":"NOR","OM":"OMN","PK":"PAK","PW":"PLW","PA":"PAN","PG":"PNG","PY":"PRY","PE":"PER","PH":"PHL","PL":"POL","PT":"PRT","QA":"QAT","RO":"ROU","RU":"RUS","RW":"RWA","KN":"KNA","LC":"LCA","VC":"VCT","WS":"WSM","SM":"SMR","ST":"STP","SA":"SAU","SN":"SEN","RS":"SRB","SC":"SYC","SL":"SLE","SG":"SGP","SK":"SVK","SI":"SVN","SB":"SLB","SO":"SOM","ZA":"ZAF","SS":"SSD","ES":"ESP","LK":"LKA","SD":"SDN","SR":"SUR","SZ":"SWZ","SE":"SWE","CH":"CHE","SY":"SYR","TJ":"TJK","TZ":"TZA","TH":"THA","TL":"TLS","TG":"TGO","TO":"TON","TT":"TTO","TN":"TUN","TR":"TUR","TM":"TKM","TV":"TUV","UG":"UGA","UA":"UKR","AE":"ARE","GB":"GBR","US":"USA","UY":"URY","UZ":"UZB","VU":"VUT","VE":"VEN","VN":"VNM","YE":"YEM","ZM":"ZMB","ZW":"ZWE"};

const CONTINENT_NAMES = { "AF": "Africa", "AS": "Asia", "EU": "Europe", "NA": "North America", "OC": "Oceania", "SA": "South America", "AN": "Antarctica" };
const CONTINENT_CENTERS = { "AF": [0, 20], "AS": [30, 80], "EU": [50, 15], "NA": [40, -100], "OC": [-25, 140], "SA": [-15, -60], "AN": [-82, 0] };
const CONTINENT_ZOOM = { "AF": 3, "AS": 3, "EU": 4, "NA": 3, "OC": 3, "SA": 3, "AN": 3 };

// ── Utilities ────────────────────────────────────────────────────────────────
const getMediaUrl = (url) => {
    if (!url) return '';
    if (url.startsWith('data:') || url.startsWith('http')) return url;
    return `${BACKEND_HOST}/${url.replace(/^\//, '')}`;
};

// May 2026 - append a cache-buster query param without breaking
// presigned S3 URLs. S3 SigV4 signs the canonical query string -
// ANY extra param (even `?_cb=` or `&_t=`) shifts the canonical
// request and the computed signature stops matching what S3 stored.
// Browser fetch returns 403 with SignatureDoesNotMatch. The <audio>
// element doesn't surface 403 cleanly - it bubbles up as
// `Uncaught NotSupportedError: Failed to load because no supported
// source was found`, which masquerades as a codec problem. Hours
// of red-herring debugging.
//
// May 2026 (HAR-driven rewrite) - the backend now emits STABLE
// `/api/v1/reports/media/<id>/<file|thumb>` URLs instead of presigned
// S3 URLs (which churned per-poll, defeating browser cache and
// forcing 98× refetch of identical bytes). The presigned URL only
// surfaces on the redirect target after the browser dereferences the
// stable URL; <img> / <audio> elements never see it. So the
// `_isPresignedS3Url` guard below mostly fires on legacy localStorage
// cache entries (pre-fix data) and any future direct presigned URL.
// We keep it as a safety net.
const _isPresignedS3Url = (url) =>
    typeof url === 'string' && url.includes('X-Amz-Signature=');

const _withCacheBust = (url, key, value) => {
    if (!url) return '';
    if (_isPresignedS3Url(url)) return url;  // appending breaks the sig
    return url + (url.includes('?') ? '&' : '?') + key + '=' + value;
};

// ── Phase 1.5 (Apr 2026): BlurHash placeholder rendering ────────────────────
// The backend serves a ~28-char BlurHash string on each Report (field:
// `blurhash`), encoded by the reporter app at capture time and delivered in
// the meta POST (arrives in ~200 ms). Decoding it locally gives us a very
// cheap 40x40 colour-impression bitmap we can slot into the <img src> BEFORE
// any media chunk has uploaded - closing the time-to-first-visual gap from
// "first SMALL variant lands" (~2 s best case) to "meta POST round-trip"
// (~200 ms). The real photo hot-swaps in via `_maybeUpgradeDetailImage` the
// moment a complete variant arrives, so the blurhash is a transient visual
// only.
//
// Caching: decoding a 40x40 image via the 4x3 DCT costs ~1–2 ms - cheap, but
// `selectReport()` and `showIncidentPreview()` can fire many times per poll
// cycle, and the hash is stable for the lifetime of a report. A plain Map
// keyed by hash is fine: the dashboard holds ~36 reports in the feed so
// memory is negligible and no LRU eviction is needed.
const _blurhashCache = new Map();   // hash → dataURL string (or the sentinel `null`)

function blurhashToDataURL(hash, width = 40, height = 40) {
    // Null/invalid hash → no placeholder. Callers fall through to the
    // existing "awaiting media" icon.
    if (!hash || typeof hash !== 'string' || hash.length < 6) return null;
    if (!window.BlurHash || typeof window.BlurHash.decode !== 'function') return null;
    // Memoise by hash (width/height are fixed defaults for all call sites).
    if (_blurhashCache.has(hash)) return _blurhashCache.get(hash);
    try {
        const pixels = window.BlurHash.decode(hash, width, height);
        // Offscreen canvas: no DOM insertion needed, just an ephemeral 2D
        // context to hand the Uint8ClampedArray to. JPEG at q=0.6 because the
        // blurhash bitmap is already lossy/blurred - PNG would be ~4× larger
        // for zero perceptible gain.
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imgData = ctx.createImageData(width, height);
        imgData.data.set(pixels);
        ctx.putImageData(imgData, 0, 0);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
        _blurhashCache.set(hash, dataUrl);
        return dataUrl;
    } catch (e) {
        // Malformed hash - cache `null` so we don't re-attempt each render.
        console.warn('[CRISP] blurhash decode failed:', e && e.message);
        _blurhashCache.set(hash, null);
        return null;
    }
}

// ── Guaranteed-delivery: group + pick best variant ─────────────────────────
// A photo_group_id links the three variants (SMALL/MEDIUM/LARGE) of one
// captured photo. `groupPhotos()` folds a flat media[] into an array of
// groups so the gallery strip shows one thumbnail per photo instead of 3.
// `bestVariant(g)` returns the highest-quality complete variant, falling
// back to partial previews if no variant has finished yet. Legacy media
// without a photo_group_id becomes its own one-member group so reports
// queued before this feature shipped still render.
// Phase L (May 2026) - canonical 3-value SMALL/MEDIUM/ORIGINAL.
// Legacy LOW/HIGH kept in the rank table only so historical rows
// (pre-alembic-0035 backfill) still sort sensibly if they
// somehow appear; backend never emits them post-migration.
const TIER_RANK = { SMALL: 1, LOW: 1, MEDIUM: 2, HIGH: 3, ORIGINAL: 4 };

// ── Phase 2 (Apr 2026): tier override map ──────────────────────────────────
// Analysts can click SMALL / MEDIUM / LARGE to manually pick which variant
// to view. Once a user has overridden, `_maybeUpgradeDetailImage` must NOT
// auto-upgrade them back to the best tier on the next poll - their
// deliberate pick wins. Keyed by reportId (not group) because the choice
// is a panel-level preference; cleared on panel close / delete.
const _tierOverride = new Map();   // reportId → 'LOW' | 'MEDIUM' | 'HIGH'

// ── P1.5 (May 2026, audit follow-up): live tier-status on detail open ──────
// Operator concern: when a report arrives on the previous list poll, the
// `r.media[*]` records are stale by up to ~4 s (one polling cycle). Opening
// the detail panel right after capture would show the tier switcher with
// outdated assembly_status / completion_pct values, e.g. ORIGINAL stuck at
// 60 % even though it just finished server-side. Fix: piggy-back a
// GET `/reports/{id}/tier-status` call when selectReport runs. The backend
// endpoint is cheap (~1 SELECT) and returns just the per-tier media rows.
// Merge fresh status into the in-memory record and re-render the tier
// switcher if anything changed. Listing-poll updates still drive the
// steady-state view - this just removes the open-the-card lag.
async function _refreshTierStatusForDetail(reportId) {
    if (!reportId) return;
    try {
        const res = await fetch(`${BACKEND_HOST}/api/v1/reports/${reportId}/tier-status`, {
            method: 'GET',
            credentials: 'omit',  // public endpoint; no auth needed for tier surface
        });
        if (!res.ok) return;  // 404 on old backend / transient - silent no-op
        const body = await res.json();
        if (!body || !Array.isArray(body.media)) return;
        const r = allReports.find(x => x.id === reportId);
        if (!r) return;
        // Merge by media.id. The tier-status endpoint returns the same
        // shape (id, resolution_tier, assembly_status, completion_pct,
        // received_chunks, chunk_count, photo_group_id, type, url), so we
        // copy fields without inventing new ones.
        const byId = new Map((r.media || []).map(m => [m.id, m]));
        let changed = false;
        for (const fresh of body.media) {
            if (!fresh || !fresh.id) continue;
            const local = byId.get(fresh.id);
            if (!local) continue;
            for (const k of ['assembly_status', 'completion_pct', 'received_chunks', 'chunk_count', 'url', 'thumbnail_url']) {
                if (k in fresh && local[k] !== fresh[k]) {
                    local[k] = fresh[k];
                    changed = true;
                }
            }
        }
        // Only re-render the panel if (a) something changed AND (b) the
        // operator is still viewing this report (they may have navigated
        // away during the round-trip).
        if (changed && selectedId === reportId && typeof window.selectReport === 'function') {
            window.selectReport(reportId, /* skipFly */ true);
        }
    } catch (e) {
        // Network blip / abort - silent. Listing poll will catch up.
    }
}

function groupPhotos(mediaList) {
    const groups = new Map();
    const loose = [];
    for (const m of (mediaList || [])) {
        if (m.type !== 'IMAGE') continue;
        const gid = m.photo_group_id;
        if (!gid) {
            loose.push({ group_id: null, members: [m] });
            continue;
        }
        if (!groups.has(gid)) groups.set(gid, { group_id: gid, members: [] });
        groups.get(gid).members.push(m);
    }
    return [...groups.values(), ...loose];
}

// Phase 2: Build the 3-button tier switcher for a photo group. Each button
// shows SMALL / MEDIUM / LARGE; complete variants are clickable, pending
// ones show a subtle upload-% tooltip. The button matching `activeTier`
// gets the `.active` class so analysts can see which tier is showing.
// Escapes group_id / report_id for safe inline handlers.
function _buildTierSwitcher(reportId, group, activeTier) {
    // Phase L (May 2026) - canonical SMALL/MEDIUM/ORIGINAL tier
    // values match what's in the DB. Pre-L this was LOW/MEDIUM/HIGH
    // which silently disabled SMALL + ORIGINAL buttons because
    // byTier[tier] lookups missed the canonical-named Media rows.
    const tiers = [
        { tier: 'SMALL',    label: 'SMALL'    },
        { tier: 'MEDIUM',   label: 'MEDIUM'   },
        { tier: 'ORIGINAL', label: 'ORIGINAL' },
    ];
    const byTier = Object.fromEntries(group.members.map(m => [m.resolution_tier, m]));
    const gid = (group.group_id || '').replace(/'/g, '');
    const rid = (reportId || '').replace(/'/g, '');
    const btns = tiers.map(({ tier, label }) => {
        const m = byTier[tier];
        const complete = m && m.assembly_status === 'complete' && m.url;
        const pct = m ? Math.round(m.completion_pct || 0) : 0;
        const active = tier === activeTier ? ' active' : '';
        const disabled = complete ? '' : ' disabled';
        const title = complete
            ? `Show ${label} variant`
            : (m ? `${label} - uploading ${pct}%` : `${label} - not available`);
        const onclick = complete
            ? `event.stopPropagation();setDetailImageTier('${rid}','${gid}','${tier}',this)`
            : '';
        return `<button class="dp-tier-btn dp-tier-${tier.toLowerCase()}${active}${disabled}"
                        type="button"
                        ${complete ? '' : 'aria-disabled="true"'}
                        title="${title}"
                        onclick="${onclick}">${label}</button>`;
    }).join('');
    return `<div class="dp-tier-switcher" role="group" aria-label="Image quality">${btns}</div>`;
}

// May 2026 (HAR-driven, Phase 2) - bandwidth policy for the inline detail
// view. Previously every detail-panel render eagerly fetched the LARGE
// (HIGH-tier) variant via `bestVariant()`, even when the analyst was just
// scanning the queue. With LARGE variants typically ~500 KB and the
// dashboard rendering 50 reports per session, that's ~25 MB of bandwidth
// per analyst-shift the 90% case never benefits from.
//
// New default: render the SMALLEST complete variant inline (~50 KB), and
// upgrade to LARGE on EXPLICIT user intent - clicking the LARGE button
// in the tier switcher, or opening the lightbox. The auto-upgrade poll
// (`_maybeUpgradeDetailImage`) is now bounded to LOW→MEDIUM only - it
// never silently fetches LARGE behind the user's back.
//
// `thumbVariant()` mirrors `bestVariant()` but with reversed tier
// preference. It still falls back to partials/blurhash the same way
// so progressive rendering keeps working during in-flight uploads.
function thumbVariant(group) {
    if (!group || !group.members || group.members.length === 0) return null;
    // Prefer the LOWEST-rank COMPLETED variant - the thumb-first policy.
    // May 2026 (425-fallback): a tier is only renderable once its PII blur
    // is done. While pii_blur_status='pending', GET /media/{id}/file returns
    // 425 Too Early, so picking it would blank the <img>. Excluding pending
    // tiers makes the picker fall through to the ungated thumbnail/blurhash
    // (never blank) and auto-upgrade to the full image the moment blur
    // completes - no onerror hack, no 425 flicker, PII-safe by construction.
    const complete = group.members
        .filter(m => m.assembly_status === 'complete' && m.url && m.pii_blur_status !== 'pending')
        .sort((a, b) => (TIER_RANK[a.resolution_tier] || 0) - (TIER_RANK[b.resolution_tier] || 0));
    if (complete.length > 0) {
        const m = complete[0];
        return { src: getMediaUrl(m.url), tier: m.resolution_tier, isFinal: true, mediaId: m.id };
    }
    // No complete variant yet - fall back to whatever bestVariant would
    // surface (partial thumbnails / partial JPEG / blurhash). Keeps
    // progressive rendering identical during uploads.
    return bestVariant(group);
}

// Find the highest-tier complete variant for explicit "show full" actions
// (lightbox click, LARGE button). Returns null if no complete variant
// exists yet - caller should fall back to whatever inline tier is showing.
function highestCompleteVariant(group) {
    if (!group || !group.members) return null;
    // 425-fallback (May 2026): exclude blur-pending tiers - their /file 425s.
    const m = group.members
        .filter(x => x.assembly_status === 'complete' && x.url && x.pii_blur_status !== 'pending')
        .sort((a, b) => (TIER_RANK[b.resolution_tier] || 0) - (TIER_RANK[a.resolution_tier] || 0))[0];
    return m ? { src: getMediaUrl(m.url), tier: m.resolution_tier, mediaId: m.id } : null;
}

function bestVariant(group) {
    if (!group || !group.members || group.members.length === 0) return null;
    // Prefer the highest-rank COMPLETED variant.
    // 425-fallback (May 2026): exclude blur-pending tiers - their /file 425s,
    // which would blank the image. Falls through to partial/thumbnail/blurhash
    // (all ungated) until blur completes, then the full variant is picked.
    const complete = group.members
        .filter(m => m.assembly_status === 'complete' && m.url && m.pii_blur_status !== 'pending')
        .sort((a, b) => (TIER_RANK[b.resolution_tier] || 0) - (TIER_RANK[a.resolution_tier] || 0));
    if (complete.length > 0) {
        const m = complete[0];
        return { src: getMediaUrl(m.url), tier: m.resolution_tier, isFinal: true, mediaId: m.id };
    }
    // No full variant yet - pick the highest partial/thumbnail preview.
    const partials = group.members
        .filter(m => m.thumbnail_url)
        .sort((a, b) => (TIER_RANK[b.resolution_tier] || 0) - (TIER_RANK[a.resolution_tier] || 0));
    if (partials.length > 0) {
        const m = partials[0];
        return { src: getMediaUrl(m.thumbnail_url), tier: m.resolution_tier + '-partial', isFinal: false, mediaId: m.id };
    }
    // ── Phase 2.2 (Apr 2026): partial-file rendering ───────────────────────
    // If no variant has emitted a thumbnail yet but the backend has written
    // `<media_id>_partial.jpg` (updated every few chunks during upload), we
    // can show THAT file as an intermediate visual - even ~30% of a JPEG is
    // recognisable. `completion_pct` is the 0..100 progress indicator; any
    // value strictly between 0 and 100 means a partial file is on disk.
    //
    // Cache-buster: append `?p=<floor(completion_pct)>` so a move from e.g.
    // 33% → 66% forces a refetch (new URL), but a micro-tick 33.1% → 33.9%
    // reuses the cached response. Keeps the CDN/etag layer happy while still
    // advancing the visual as chunks land.
    const partialCandidate = group.members
        .filter(m => {
            const pct = m.completion_pct || 0;
            return pct > 0 && pct < 100 && m.id;
        })
        .sort((a, b) => (TIER_RANK[b.resolution_tier] || 0) - (TIER_RANK[a.resolution_tier] || 0))[0];
    if (partialCandidate) {
        const pct = partialCandidate.completion_pct || 0;
        const partialUrl = getMediaUrl('static/' + partialCandidate.id + '_partial.jpg')
                         + '?p=' + Math.floor(pct);
        return {
            src: partialUrl,
            tier: (partialCandidate.resolution_tier || 'UNKNOWN') + '-partial',
            isFinal: false,
            mediaId: partialCandidate.id,
        };
    }
    return null;
}

// ── Phase F image-reliability (May 2026) - tri-state classifier for the
// LARGE (HIGH-tier) variant of a photo group. Replaces the binary
// `assembly_status !== 'complete'` check that conflated `pending`,
// `assembling`, and `failed` into "uploading…" with a pulsing spinner
// for 14 days. Now the dashboard renders distinct visuals for:
//
//   complete    - variant is on S3; render the image.
//   uploading   - chunks still arriving inside the freshness window;
//                 show the existing fa-pulse cloud-arrow chip.
//   delayed     - chunks have been stuck `pending`/`assembling` past
//                 the freshness window but the backend hasn't yet
//                 abandoned them (sweep tick lag). Show a yellow
//                 clock chip + offer the operator a Reclaim button.
//   lost        - sweep flipped the row to `failed` with
//                 abandon_reason populated (chunks_never_arrived /
//                 assembly_worker_lost / operator_manual). Red chip
//                 + Reclaim button (retry if chunks were full; mark-
//                 abandoned otherwise - operator confirms in modal).
//   missing     - no HIGH row at all. Two sub-cases distinguished by
//                 the freshness window: `missing-fresh` (report
//                 younger than 30 min, HIGH might still arrive) renders
//                 the "ORIG pending" chip; `missing-old` returns no
//                 chip (the PWA gave up retrying, OR the channel
//                 doesn't capture HIGH at all - Telegram / WhatsApp /
//                 SMS / IVR).
//
// `_ORIG_FRESH_MS` is the SINGLE window applied to both the "HIGH
// row exists but stuck" path AND the "HIGH row never created" path.
// Matches the backend sweep's `_ABANDON_STALE_MIN=30 minutes` - any
// pending row older than this WILL be abandoned on the next sweep
// tick, so showing a chip past 30 min on a row the sweep can't
// rescue is operator-confusing noise.
//
// Phase F (operator follow-up, May 2026) - the missing-HIGH branch
// previously used a 14-day deferral horizon under the rationale that
// the PWA's offline-queue retry runs that long. In practice the
// 14-day chip was operator-trained noise: stale captures (4-day-old
// reports, abandoned Telegram-channel rows that never have a HIGH
// tier by design) lit chips that never cleared. Aligning both
// branches on the 30-min window matches operator expectation ("if
// it's been more than 30 min and the LARGE hasn't shown, the PWA
// won't deliver it without intervention") AND matches the backend's
// own abandon threshold so the operator's mental model is unified
// across the client + server.
const _ORIG_FRESH_MS = 30 * 60 * 1000;  // 30 min - matches backend sweep

function _classifyHighTier(group, reportAgeMs) {
    if (!group || !group.members) return 'missing-old';
    const large = group.members.find(m => m.resolution_tier === 'ORIGINAL');
    if (!large) {
        // No HIGH row at all. Within the same 30-min freshness window
        // we use for pending/assembling rows: the HIGH might still
        // arrive. Past 30 min it's "missing-old" and we stop chipping.
        return reportAgeMs < _ORIG_FRESH_MS ? 'missing-fresh' : 'missing-old';
    }
    if (large.assembly_status === 'complete') return 'complete';
    if (large.assembly_status === 'failed') {
        // R6 (Jun 2026): a tier the CLIENT deliberately DEFERRED — slow network
        // (bandwidth_tier_deferred) or evicted to free device storage after the
        // SMALL preview delivered (storage_evicted) — is RETRYABLE, not lost. It
        // auto-revives on the next successful chunk. Treat as 'delayed' so it
        // reads as "awaiting connectivity", not a permanent failure. A genuine
        // integrity/encode failure (no deferred reason) stays 'lost'.
        const _r = large.abandon_reason || '';
        if (_r === 'bandwidth_tier_deferred' || _r === 'storage_evicted') return 'delayed';
        return 'lost';
    }
    // pending / assembling - distinguished by freshness window.
    return reportAgeMs < _ORIG_FRESH_MS ? 'uploading' : 'delayed';
}

// ── Report Assessment - the ONE automated-credibility surface ─────────────────
// Renders the single, system-only Confidence Score (0-100) from the backend
// `incident_credibility` object (see app/services/credibility.py). The score is
// the SUM of independent automated checks (AI content, satellite, location,
// corroboration, reporter) - it is the MACHINE's assessment only. An analyst's
// accept/reject verdict and manual review deliberately never move it (that is
// the operational status, shown elsewhere). One primary CTA - "AI-Assisted
// Report Assessment" - runs every check; the resulting score is then clickable
// → a per-check breakdown modal that explains exactly how the number is reached.
// No incident mutation here; the CTA just (re)computes the score.
function _credBandMeta(band) {
    const M = {
        VERIFIED:   { word: 'High confidence', color: '#22c55e' },
        LIKELY:     { word: 'Likely credible', color: '#2dd4bf' },
        MIXED:      { word: 'Mixed signals',   color: '#eab308' },
        WEAK:       { word: 'Low confidence',  color: '#f97316' },
        UNVERIFIED: { word: 'Not yet assessed', color: '#64748b' },
    };
    const m = M[band] || M.UNVERIFIED;
    return { cls: (band || 'unverified').toLowerCase(), word: m.word, color: m.color };
}

// ── Assessment cache (per session) ───────────────────────────────────────────
// The completed assessment is cached against the report id so the breakdown is
// REUSED whenever the operator reopens it, and a background poll that momentarily
// serializes incident_credibility as null can never revert the card to "run it
// again". Re-running (runFullAssessment) overwrites this. In-memory only: after a
// refresh it self-heals from the server-computed incident_credibility.
window.__assessCache = window.__assessCache || {};

// Resolve the assessment snapshot for a report: prefer the live server-computed
// incident_credibility when it is assessed (refreshing the cache from it), else
// fall back to the cached snapshot from when the operator last ran it.
function _assessSnapshot(r) {
    if (!r) return null;
    const liveIc = r.incident_credibility;
    if (liveIc && liveIc.assessed && liveIc.score !== null && liveIc.score !== undefined) {
        const prev = window.__assessCache[r.id];
        let icAt = null;
        if (liveIc.assessed_at) { try { icAt = new Date(ensureUTC(liveIc.assessed_at)).getTime(); } catch (_e) { icAt = null; } }
        const snap = {
            ic: liveIc,
            verification: r.verification || (prev && prev.verification) || null,
            ai_assessment: r.ai_assessment || (prev && prev.ai_assessment) || null,
            duplicate_count: r.duplicate_count || 0,
            building_id: r.building_id || null,
            // Prefer the FRESH server timestamp when present so "Last assessed N
            // ago" tracks the latest assessment even when another operator re-ran
            // it; fall back to this client's run-time only when the server omits it.
            at: icAt || (prev && prev.at) || null,
        };
        window.__assessCache[r.id] = snap;
        return snap;
    }
    return window.__assessCache[r.id] || null;
}

// "Last assessed N ago" caption from the snapshot timestamp.
function _assessedAtLabel(snap) {
    if (!snap || !snap.at) return '';
    try { return `Last assessed ${timeAgo(new Date(snap.at).toISOString())}`; } catch (_e) { return ''; }
}

// Compact contributor checklist for the card: each automated check that RAN with
// points shows a ✓; ran-but-zero a neutral dot; not-run a dim ✗.
function _contributorChips(ic) {
    const short = { ai: 'AI analysis', satellite: 'Satellite', location: 'Location', corroboration: 'Duplicates', reporter: 'Reporter' };
    return (ic.factors || []).map(f => {
        const ok = f.ran && f.awarded > 0;
        const cls = ok ? 'ok' : (f.ran ? 'neutral' : 'off');
        const icon = ok ? 'fa-circle-check' : (f.ran ? 'fa-circle' : 'fa-circle-xmark');
        return `<span class="dp-contrib dp-contrib-${cls}"><i class="fa-solid ${icon}"></i> ${escapeHtml(short[f.key] || f.label)}</span>`;
    }).join('');
}

function _renderIncidentAssessment(r) {
    const snap = _assessSnapshot(r);
    const totalChecks = (snap && snap.ic.total_checks) || 5;

    // Not yet assessed → one plain explainer + the single primary CTA. No
    // fabricated number, no scattered per-check buttons.
    if (!snap) {
        return `
        <section class="dp-section dp-assess dp-assess-cta-state" id="dp-assess-${r.id}">
            <div class="dp-assess-cta-head">
                <i class="fa-solid fa-gauge-high dp-assess-cta-icon"></i>
                <div>
                    <div class="dp-assess-title">Report Assessment</div>
                    <div class="dp-assess-cta-sub">Run every automated credibility check to score this report 0&ndash;100.</div>
                </div>
            </div>
            <button class="dp-assess-cta" id="btn-assess-${r.id}" onclick="runFullAssessment('${r.id}')">
                <i class="fa-solid fa-wand-magic-sparkles"></i> AI-Assisted Report Assessment
            </button>
            <div class="dp-assess-cta-note">Runs AI content analysis, satellite correlation, location, corroboration &amp; reporter checks. Analyst decisions never affect this score.</div>
        </section>`;
    }

    // Assessed → the big, clickable Confidence Score + contributor checklist +
    // "Last assessed N ago" + a re-run affordance. Click the score row → the
    // investigative breakdown workspace.
    const ic = snap.ic;
    const meta = _credBandMeta(ic.band);
    const atLabel = _assessedAtLabel(snap);
    return `
    <section class="dp-section dp-assess dp-assess-scored dp-cred-${meta.cls}" id="dp-assess-${r.id}" style="--cred-color:${meta.color};">
        <div class="dp-assess-scorerow" role="button" tabindex="0"
             aria-label="Open the Confidence Score breakdown"
             onclick="_showAssessmentModal('${r.id}')"
             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();_showAssessmentModal('${r.id}');}">
            <div class="dp-assess-dial">
                <span class="dp-assess-num">${ic.score}</span>
                <span class="dp-assess-den">/100</span>
            </div>
            <div class="dp-assess-meta">
                <div class="dp-assess-title">Confidence Score <span class="dp-assess-band">${meta.word}</span></div>
                <div class="dp-assess-contribs">${_contributorChips(ic)}</div>
                <div class="dp-assess-presence">${atLabel ? escapeHtml(atLabel) + ' · ' : ''}${ic.ran_count} of ${totalChecks} checks <span class="dp-assess-link">View breakdown <i class="fa-solid fa-arrow-right"></i></span></div>
            </div>
        </div>
    </section>`;
    // Re-run lives inside the breakdown workspace (the modal's sticky header
    // "Re-run assessment"), keeping this card to a single decision: the score.
}
window._renderIncidentAssessment = _renderIncidentAssessment;

// Build the multi-signal payload for POST /{id}/ai-assess. Shared by the single
// "AI-Assisted Report Assessment" CTA and the legacy Re-run path so both send an
// identical dossier to Claude.
function _buildAiAssessPayload(r) {
    const loc = r.location;
    const nearbyReports = loc ? allReports.filter(rr => rr.id !== r.id && rr.location &&
        haversineKm(loc.latitude, loc.longitude, rr.location.latitude, rr.location.longitude) < 5).length : 0;
    return {
        id: r.id, source: r.source, severity: r.severity,
        infrastructure_type: r.infrastructure_type, status: r.status,
        description: r.description || '',
        transcription: r.ai_analysis?.transcription || '',
        ai_summary: r.ai_analysis?.ai_summary || '',
        location: loc ? { lat: loc.latitude, lng: loc.longitude, name: loc.user_location_name || loc.device_location_name || '' } : null,
        media_count: r.media?.length || 0,
        has_image: !!r.media?.find(m => m.type === 'IMAGE'),
        has_audio: !!r.media?.find(m => m.type === 'AUDIO'),
        verification: r.verification ? {
            score: r.verification.total_score, verdict: r.verification.verdict,
            scores: r.verification.scores || {},
            photo_analysis: r.verification.photo_analysis || '',
            satellite_scene: r.verification.satellite_scene_description || '',
            key_findings: r.verification.key_findings || [],
            caveats: r.verification.caveats || [],
        } : null,
        caller_info: r.caller_info || null,
        nearby_reports: nearbyReports,
    };
}

// THE single assessment trigger. Runs every automated check (AI content +
// satellite correlation), then re-fetches the report so the server-computed
// Confidence Score (incident_credibility) is fresh, and re-renders. Individual
// checks may fail (e.g. no cloud-free imagery, AI key missing); the breakdown
// then shows each as "could not run" rather than blocking the whole score.
window.runFullAssessment = async (id) => {
    const r = allReports.find(x => x.id === id)
        || (_detailOnlyReport && _detailOnlyReport.id === id ? _detailOnlyReport : null);
    if (!r) return;
    if (window.__assessRunning === id) return;            // double-submit guard
    window.__assessRunning = id;

    const btn = document.getElementById(`btn-assess-${id}`)
        || document.querySelector('#assess-modal-overlay .assess-rerun-top')
        || document.querySelector(`#dp-assess-${id} .dp-assess-rerun`);
    if (btn) { btn._label = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running…'; }
    showToast('Running automated assessment — AI analysis + satellite…', 'info');

    // Re-run (already assessed once) forces a fresh Claude call; first run uses
    // the cache-friendly default.
    const force = !!(r.ai_assessment || (r.incident_credibility && r.incident_credibility.assessed));
    const aiUrl = `${BACKEND_HOST}/api/v1/reports/${id}/ai-assess${force ? '?force=true' : ''}`;

    const [aiOk, satOk] = await Promise.all([
        fetch(aiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_buildAiAssessPayload(r)) })
            .then(res => res.ok).catch(() => false),
        fetch(`${API}/${id}/verify`, { method: 'POST' }).then(res => res.ok).catch(() => false),
    ]);

    // Re-fetch the full report so incident_credibility (server-computed) is fresh.
    const fresh = await _fetchReportByIdRaw(id);
    if (fresh) {
        const idx = allReports.findIndex(x => x.id === id);
        if (idx >= 0) allReports[idx] = { ...allReports[idx], ...fresh };
        if (_detailOnlyReport && _detailOnlyReport.id === id) _detailOnlyReport = { ..._detailOnlyReport, ...fresh };
        // Cache the completed result against the report (the user reopens the
        // breakdown repeatedly; it must reuse THIS result, with the run time).
        const fic = fresh.incident_credibility;
        if (fic && fic.assessed) {
            window.__assessCache[id] = {
                ic: fic, verification: fresh.verification || null, ai_assessment: fresh.ai_assessment || null,
                duplicate_count: fresh.duplicate_count || 0, building_id: fresh.building_id || null, at: Date.now(),
            };
        }
    }
    window.__assessRunning = null;
    try { selectReport(id, true); renderFeed(); } catch (_e) {}
    // If the breakdown is open, refresh it in place with the new result.
    if (document.getElementById('assess-modal-overlay')) { try { _showAssessmentModal(id); } catch (_e) {} }

    const ic = fresh && fresh.incident_credibility;
    if (ic && ic.assessed && ic.score !== null && ic.score !== undefined) {
        showToast(`Confidence Score: ${ic.score}/100 · ${_credBandMeta(ic.band).word}`, 'success');
    } else if (!aiOk && !satOk) {
        showToast('Assessment could not run — check API keys / connectivity.', 'error');
        if (btn && btn._label) { btn.disabled = false; btn.innerHTML = btn._label; }
    } else {
        showToast('Assessment ran with partial results — open the breakdown.', 'info');
    }
};

// ── Breakdown workspace - section renderers ───────────────────────────────────
// The breakdown is the ONE investigative surface: everything needed to answer
// "how confident are we this incident is real, and why?" lives here, so the
// operator never navigates to another section. Section 2 embeds the FULL
// satellite analysis (it no longer lives in the Evidence section).

// Section 2 - Satellite verification, fully embedded (imagery + ground↔satellite
// comparison + sub-scores + AI observations + re-verify). Self-contained from
// r.verification so it can render inside the modal.
function _renderSatelliteAnalysis(r) {
    const v = r.verification || null;
    if (!v) {
        return `<div class="assess-sat-empty">
            <i class="fa-solid fa-satellite-dish"></i>
            <span>Satellite imagery correlation hasn't run for this report.</span>
            <button class="assess-mini-btn" id="btn-verify-${r.id}" onclick="runVerification('${r.id}')"><i class="fa-solid fa-satellite"></i> Run satellite check</button>
        </div>`;
    }
    if (v.error) {
        return `<div class="assess-sat-empty assess-sat-err">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span>Satellite verification could not run: ${escapeHtml(v.error)}</span>
            <button class="assess-mini-btn" id="btn-verify-${r.id}" onclick="runVerification('${r.id}')"><i class="fa-solid fa-rotate"></i> Retry satellite</button>
        </div>`;
    }
    const total = v.total_score || 0;
    const gc = total >= 80 ? '#22c55e' : total >= 60 ? '#86efac' : total >= 40 ? '#eab308' : total >= 20 ? '#f97316' : '#ef4444';
    const verdictLabels = { STRONGLY_CORROBORATED:'Corroborated', LIKELY_AUTHENTIC:'Likely Authentic', PARTIALLY_VERIFIED:'Partial', LOW_CONFIDENCE:'Low Confidence', UNVERIFIED:'Unverified' };
    const vLabel = verdictLabels[v.verdict] || v.verdict || '';

    const satSrc    = v.satellite_image_url ? getMediaUrl(v.satellite_image_url) : '';
    const satAltSrc = v.satellite_image_url_alt ? getMediaUrl(v.satellite_image_url_alt) : '';
    const satLabel  = (v.satellite_source || 'Satellite').split('(')[0].trim();
    const satAltLabel = (v.satellite_source_alt || 'Alt').split('(')[0].trim();
    const cit = (r.media || []).find(m => m.type === 'IMAGE' && m.assembly_status === 'complete' && m.url);
    const citSrc = cit ? getMediaUrl(cit.url) : ((r.media || []).find(m => m.type === 'IMAGE' && m.thumbnail_url) ? getMediaUrl((r.media || []).find(m => m.type === 'IMAGE' && m.thumbnail_url).thumbnail_url) : '');

    // Imagery: a ground↔satellite wipe comparison when both exist (the real
    // operator question - does the overhead corroborate the ground report?);
    // otherwise whichever single image we have, with a primary/alt tab.
    let imageryHtml = '';
    if (citSrc && satSrc) {
        imageryHtml = `<div class="assess-compare" id="assess-compare-${r.id}">
            <div class="assess-compare-stage">
                <img class="assess-compare-base" src="${satSrc}" alt="Satellite view" onclick="openLightbox('${satSrc}','Satellite')">
                <img class="assess-compare-top" id="assess-compare-top-${r.id}" src="${citSrc}" alt="Ground report" style="clip-path:inset(0 50% 0 0);">
                <div class="assess-compare-divider" id="assess-compare-div-${r.id}" style="left:50%;"></div>
            </div>
            <input type="range" min="0" max="100" value="50" class="assess-compare-range" aria-label="Wipe between the ground photo and the satellite view" oninput="_assessWipe('${r.id}', this.value)">
            <div class="assess-compare-labels"><span><i class="fa-solid fa-camera"></i> Ground photo</span><span>Satellite view <i class="fa-solid fa-satellite"></i></span></div>
        </div>`;
    } else if (satSrc) {
        imageryHtml = `<div class="assess-sat-imgwrap">
            ${satAltSrc ? `<div class="dp-sat-tabs">
                <button class="dp-sat-tab active" onclick="switchSatSource('${r.id}','primary',this,'${satSrc}')">${escapeHtml(satLabel)}</button>
                <button class="dp-sat-tab" onclick="switchSatSource('${r.id}','alt',this,'${satAltSrc}')">${escapeHtml(satAltLabel)}</button>
            </div>` : ''}
            <div class="dp-img" onclick="openLightbox(document.getElementById('dp-sat-img-${r.id}').src,'Satellite')">
                <img id="dp-sat-img-${r.id}" src="${satSrc}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;">
            </div>
        </div>`;
    }

    // Match confidence - the 4 sub-scores (each /25).
    const sc = v.scores || {};
    const subDefs = [
        ['Location authenticity', sc.location_authenticity],
        ['Damage corroboration', sc.damage_corroboration],
        ['Description coherence', sc.description_coherence],
        ['Data quality', sc.data_quality],
    ].filter(([, val]) => typeof val === 'number');
    const subHtml = subDefs.length ? `<div class="assess-subscores">${subDefs.map(([l, val]) => {
        const pc = Math.max(2, Math.round((val / 25) * 100));
        return `<div class="assess-subscore"><span class="assess-subscore-l">${l}</span><div class="assess-subscore-bar"><span style="width:${pc}%;"></span></div><b>${val}/25</b></div>`;
    }).join('')}</div>` : '';

    // Acquisition + cloud + sources + last-verified chips.
    const chips = [];
    if (v.satellite_acquisition_date) {
        const acq = formatShortDate(v.satellite_acquisition_date);
        const gap = (typeof v.satellite_days_gap === 'number') ? v.satellite_days_gap : null;
        let gapLabel = '', gapColor = '#94a3b8';
        if (gap !== null) {
            if (gap === 0) { gapLabel = 'same day as incident'; gapColor = '#22c55e'; }
            else if (gap > 0) { gapLabel = `${gap}d before incident`; gapColor = gap <= 3 ? '#22c55e' : gap <= 14 ? '#eab308' : '#f97316'; }
            else { const a = Math.abs(gap); gapLabel = `${a}d after incident`; gapColor = a <= 7 ? '#22c55e' : a <= 30 ? '#eab308' : '#f97316'; }
        }
        chips.push(`<span class="dp-sat-meta-chip" style="border-color:${gapColor}40;"><i class="fa-regular fa-calendar"></i> <span style="color:#cbd5e1;">${acq}</span>${gapLabel ? ` <span style="color:${gapColor};font-weight:600;">· ${gapLabel}</span>` : ''}</span>`);
    }
    if (typeof v.satellite_cloud_cover_pct === 'number') {
        const c = v.satellite_cloud_cover_pct, cc = c <= 30 ? '#22c55e' : c <= 70 ? '#eab308' : '#ef4444';
        chips.push(`<span class="dp-sat-meta-chip" style="border-color:${cc}40;"><i class="fa-solid fa-cloud" style="color:${cc};"></i> <span style="color:#cbd5e1;font-weight:600;">${c.toFixed(0)}% cloud</span></span>`);
    }
    const srcs = Array.isArray(v.satellite_images) ? v.satellite_images : [];
    if (srcs.length >= 2) chips.push(`<span class="dp-sat-meta-chip" title="${escapeHtml(srcs.map(s => s.source || '').filter(Boolean).join(' · '))}"><i class="fa-solid fa-layer-group"></i> <span style="color:#cbd5e1;font-weight:600;">${srcs.length} sources</span></span>`);
    else if (v.satellite_source) chips.push(`<span class="dp-sat-meta-chip" title="${escapeHtml(v.satellite_source)}"><i class="fa-solid fa-satellite-dish"></i> <span style="color:#cbd5e1;font-weight:600;">${escapeHtml(v.satellite_source.split('(')[0].trim())}</span></span>`);
    if (v.scored_at) chips.push(`<span class="dp-sat-meta-chip" title="Last AI verification run"><i class="fa-solid fa-clock-rotate-left"></i> <span style="color:#cbd5e1;">${timeAgo(v.scored_at)}</span></span>`);
    const chipsHtml = chips.length ? `<div class="dp-sat-meta-row">${chips.join('')}</div>` : '';

    // AI observations (reasoning / findings / scene / caveats) - all real.
    const obs = [];
    if (v.reasoning) obs.push(`<p class="assess-sat-obs">${escapeHtml(String(v.reasoning).slice(0, 400))}</p>`);
    else if (v.satellite_scene_description) obs.push(`<p class="assess-sat-obs">${escapeHtml(String(v.satellite_scene_description).slice(0, 400))}</p>`);
    if (Array.isArray(v.key_findings) && v.key_findings.length) obs.push(`<ul class="assess-sat-list">${v.key_findings.slice(0, 4).map(k => `<li><i class="fa-solid fa-circle-check"></i> ${escapeHtml(k)}</li>`).join('')}</ul>`);
    if (Array.isArray(v.caveats) && v.caveats.length) obs.push(`<ul class="assess-sat-list assess-sat-caveats">${v.caveats.slice(0, 3).map(k => `<li><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(k)}</li>`).join('')}</ul>`);

    const cloudWarn = ((v.satellite_cloud_cover_pct ?? 0) > 70 && (sc.damage_corroboration ?? 25) <= 10)
        ? `<div class="dp-sat-warning"><i class="fa-solid fa-triangle-exclamation"></i> Heavy cloud cover may have reduced visible damage detection - consider re-verifying after the next clear pass.</div>` : '';

    return `
        <div class="assess-sat-head">
            <i class="fa-solid fa-satellite" style="color:${gc};"></i>
            <span class="assess-sat-score" style="color:${gc};">${total}/100</span>
            <span class="assess-sat-verdict" style="color:${gc};">${escapeHtml(vLabel)}</span>
            <div class="dp-sat-bar"><div class="dp-sat-bar-fill" style="width:${total}%;background:${gc};"></div></div>
        </div>
        ${chipsHtml}
        ${imageryHtml}
        ${subHtml}
        ${cloudWarn}
        ${obs.join('')}
        <div class="dp-sat-actions">
            <button class="dp-reverify-btn" id="btn-verify-${r.id}" onclick="runVerification('${r.id}')" title="Re-run AI satellite verification (~25s)"><i class="fa-solid fa-rotate"></i> Re-verify</button>
            <button class="dp-share-evidence-btn" onclick="copyEvidenceLink('${r.id}')" title="Copy a public link to this verification"><i class="fa-solid fa-share-nodes"></i> Share evidence</button>
        </div>`;
}

// Wipe handler for the ground↔satellite comparison slider.
window._assessWipe = (id, val) => {
    const top = document.getElementById(`assess-compare-top-${id}`);
    const div = document.getElementById(`assess-compare-div-${id}`);
    if (top) top.style.clipPath = `inset(0 ${100 - val}% 0 0)`;
    if (div) div.style.left = `${val}%`;
};

// Section 4 - Evidence & metadata checks. REAL signals only (no fabricated
// "image authenticity" verdict - the codebase has no tamper/EXIF analyzer, so we
// surface only what is genuinely recorded). Each check renders only when its
// backing field is present.
function _renderEvidenceChecks(r) {
    const checks = [];
    const _row = (state, icon, label, detail) =>
        `<div class="assess-check assess-check-${state}"><i class="fa-solid ${icon}"></i><div><div class="assess-check-l">${label}</div>${detail ? `<div class="assess-check-d">${detail}</div>` : ''}</div></div>`;
    const loc = r.location || null;

    // GPS / location consistency.
    if (loc && loc.latitude != null && loc.longitude != null) {
        const acc = loc.accuracy_meters;
        const accTxt = (typeof acc === 'number') ? ` (±${Math.round(acc)} m${acc <= 50 ? ', precise' : ''})` : '';
        checks.push(_row('ok', 'fa-location-crosshairs', 'GPS coordinates present', `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}${escapeHtml(accTxt)}`));
        const dn = loc.device_location_name, un = loc.user_location_name;
        if (dn && un && dn.trim() && un.trim() && dn.trim() !== un.trim()) {
            checks.push(_row('warn', 'fa-triangle-exclamation', 'Device GPS and reported place differ', `Device: ${escapeHtml(dn)} · Reported: ${escapeHtml(un)}`));
        }
        if (loc.is_user_corrected) checks.push(_row('info', 'fa-pen', 'Reporter adjusted the pin', 'The location was manually corrected from the raw GPS fix.'));
        if (typeof loc.geocoding_confidence === 'number') {
            const g = loc.geocoding_confidence;
            checks.push(_row(g >= 0.7 ? 'ok' : 'warn', 'fa-map-location-dot', 'Location geocoded from text', `Geocoding confidence ${Math.round(g * 100)}%${loc.geocoding_source ? ' · ' + escapeHtml(loc.geocoding_source) : ''}`));
        }
    } else if (loc && typeof loc.geocoding_confidence === 'number') {
        checks.push(_row(loc.geocoding_confidence >= 0.7 ? 'ok' : 'warn', 'fa-map-location-dot', 'Location geocoded from text', `Confidence ${Math.round(loc.geocoding_confidence * 100)}%`));
    } else {
        checks.push(_row('off', 'fa-location-dot', 'No location attached', 'This report has no GPS or geocoded coordinates.'));
    }

    // Timestamp consistency.
    if (r.client_created_at && r.server_created_at) {
        let delayTxt = '';
        try {
            const d = (new Date(ensureUTC(r.server_created_at)) - new Date(ensureUTC(r.client_created_at))) / 60000;
            if (isFinite(d)) delayTxt = d < 2 ? 'received in real time' : `${Math.round(d)} min from capture to receipt`;
        } catch (_e) {}
        checks.push(_row('ok', 'fa-clock', 'Capture and receipt times recorded', `Captured ${formatShortDate(r.client_created_at)}${delayTxt ? ' · ' + delayTxt : ''}`));
    } else if (r.server_created_at) {
        checks.push(_row('info', 'fa-clock', 'Received', formatShortDate(r.server_created_at)));
    }

    // Media integrity + PII (per first image, when those fields are serialized).
    const im = (r.media || []).find(m => m.type === 'IMAGE');
    if (im) {
        if (im.assembly_status) checks.push(_row(im.assembly_status === 'complete' ? 'ok' : 'warn', 'fa-puzzle-piece', 'Photo upload assembled', `Status: ${escapeHtml(im.assembly_status)}`));
        if (im.full_asset_checksum) checks.push(_row('ok', 'fa-fingerprint', 'Integrity checksum recorded', 'A device-side checksum was captured for the original bytes.'));
        if (im.client_blur_applied) checks.push(_row('ok', 'fa-user-shield', 'Client-side face blur applied', 'Faces were redacted on the device before upload.'));
        const pb = im.pii_blur_status;
        if (pb) {
            const pbMap = { complete_clean: ['ok', 'PII check clean'], complete_with_redactions: ['ok', 'Faces redacted server-side'], pending: ['info', 'PII check pending'], failed: ['warn', 'PII redaction failed — verify manually'], not_needed: ['ok', 'No PII detected'] };
            const [st, lbl] = pbMap[pb] || ['info', `PII status: ${pb}`];
            checks.push(_row(st, 'fa-shield-halved', lbl, ''));
        }
    }

    // AI photo analysis (the only real image-content signal — labelled honestly,
    // NOT presented as a tamper/authenticity verdict).
    const v = r.verification || null;
    if (v && v.photo_analysis) checks.push(_row('info', 'fa-image', 'AI photo analysis', escapeHtml(String(v.photo_analysis).slice(0, 220))));

    if (!checks.length) return `<div class="assess-empty-note">No additional evidence or metadata signals recorded for this report.</div>`;
    return `<div class="assess-checks">${checks.join('')}</div>`;
}

// Section 5 - concise AI reasoning, composed from the real ai_assessment /
// verification narrative plus the strongest contributing factors.
function _renderAiReasoning(r, snap) {
    const aa = r.ai_assessment || (snap && snap.ai_assessment) || null;
    const v = r.verification || (snap && snap.verification) || null;
    const ic = snap.ic;
    const paras = [];
    if (aa && aa.summary) paras.push(escapeHtml(aa.summary));
    else if (v && v.reasoning) paras.push(escapeHtml(String(v.reasoning).slice(0, 400)));
    const top = (ic.factors || []).filter(f => f.ran && f.awarded > 0).sort((a, b) => b.awarded - a.awarded).slice(0, 3);
    const why = top.length ? `Strongest signals: ${top.map(f => `${escapeHtml(f.label)} (+${f.awarded})`).join(', ')}.` : '';
    const action = (aa && aa.suggested_action) ? `<div class="assess-ai-action"><i class="fa-solid fa-arrow-right"></i> Suggested: ${escapeHtml(aa.suggested_action)}</div>` : '';
    if (!paras.length && !why) return `<div class="assess-empty-note">No AI narrative available yet.</div>`;
    return `${paras.map(p => `<p class="assess-ai-p">${p}</p>`).join('')}${why ? `<p class="assess-ai-why">${why}</p>` : ''}${action}`;
}

// Section 3 - duplicate / corroboration analysis, loaded async into the modal.
window._loadAssessmentDuplicates = async (r) => {
    const host = document.getElementById('assess-dup-host');
    if (!host || !r) return;
    const loc = r.location || null;
    const distLabel = (cid) => {
        if (!loc) return '';
        const o = allReports.find(x => x.id === cid);
        if (!o || !o.location) return '';
        const d = haversineKm(loc.latitude, loc.longitude, o.location.latitude, o.location.longitude);
        return d < 1 ? `${Math.round(d * 1000)} m away` : `${d.toFixed(1)} km away`;
    };
    let cands = [];
    if (r.building_id) {
        try {
            const res = await fetch(`${API}/${encodeURIComponent(r.id)}/duplicates`);
            if (res.ok) { const data = await res.json(); cands = (data && data.candidates) || []; }
        } catch (_e) {}
    }
    if (document.getElementById('assess-dup-host') !== host) return;  // modal closed/replaced

    if (cands.length) {
        const conf = (lvl) => { const c = lvl === 'HIGH' ? '#f87171' : lvl === 'MEDIUM' ? '#fb923c' : '#9fb3d1'; return `<span class="assess-dup-conf" style="color:${c};border-color:${c};">${escapeHtml(lvl || '')}</span>`; };
        host.innerHTML = cands.map(c => {
            const meta = [_dupTitle(c.crisis_type), _dupTitle(c.infrastructure_type), c.location_name].filter(Boolean).join(' · ');
            const dist = distLabel(c.report_id);
            const sub = [c.reporter, c.server_created_at ? timeAgo(c.server_created_at) : '', (c.score != null ? `Similarity ${c.score}%` : (c.confidence ? c.confidence + ' confidence' : '')), dist].filter(Boolean).join(' · ');
            const reasons = (c.reasons || []).map(x => `<span class="assess-dup-reason" title="+${x.weight || 0} pts">✓ ${escapeHtml(x.label || x.factor || '')}${x.detail ? ' (' + escapeHtml(x.detail) + ')' : ''}</span>`).join('');
            const idJs = `decodeURIComponent('${encodeURIComponent(c.report_id)}')`;
            return `<div class="assess-dup-row">
                <div class="assess-dup-main">${conf(c.confidence)}<a class="assess-dup-open" onclick="(function(){var o=document.getElementById('assess-modal-overlay');if(o)o.remove();window._switchToReport(${idJs});})()">${escapeHtml(meta || 'Report')} <i class="fa-solid fa-arrow-up-right-from-square"></i></a></div>
                ${sub ? `<div class="assess-dup-sub">${escapeHtml(sub)}</div>` : ''}
                ${reasons ? `<div class="assess-dup-reasons">${reasons}</div>` : ''}
            </div>`;
        }).join('')
            // Merge DECISIONS live at the building level (v91) - this stays
            // read-only and links out to the Building Console workflow.
            + `<button class="assess-dup-review" onclick="(function(){var o=document.getElementById('assess-modal-overlay');if(o)o.remove();window.openBuildingConsole&&window.openBuildingConsole(decodeURIComponent('${encodeURIComponent(r.building_id)}'));})()"><i class="fa-solid fa-code-merge"></i> Review &amp; merge in Building Console</button>`;
        return;
    }

    // Fallback: nearby corroborating incidents (haversine), since duplicate
    // candidates require a mapped building.
    if (loc) {
        const nearby = allReports.filter(rr => rr.id !== r.id && rr.location && haversineKm(loc.latitude, loc.longitude, rr.location.latitude, rr.location.longitude) < 5)
            .map(rr => ({ rr, dist: haversineKm(loc.latitude, loc.longitude, rr.location.latitude, rr.location.longitude) }))
            .sort((a, b) => a.dist - b.dist).slice(0, 6);
        if (nearby.length) {
            host.innerHTML = `<div class="assess-dup-note">No confirmed duplicates. ${nearby.length} other report${nearby.length === 1 ? '' : 's'} within 5 km may corroborate this incident:</div>` + nearby.map(({ rr, dist }) => {
                const meta = [infraDisplayLabel(rr.infrastructure_type, rr.infrastructure_sub_type), (rr.location.user_location_name || rr.location.device_location_name || '')].filter(Boolean).join(' · ');
                const d = dist < 1 ? `${Math.round(dist * 1000)} m away` : `${dist.toFixed(1)} km away`;
                const idJs = `decodeURIComponent('${encodeURIComponent(rr.id)}')`;
                return `<div class="assess-dup-row"><div class="assess-dup-main"><a class="assess-dup-open" onclick="(function(){var o=document.getElementById('assess-modal-overlay');if(o)o.remove();window._switchToReport(${idJs});})()">${escapeHtml(meta || 'Report')} <i class="fa-solid fa-arrow-up-right-from-square"></i></a></div><div class="assess-dup-sub">${escapeHtml(d + ' · ' + _displayStatus(rr).label)}</div></div>`;
            }).join('');
            return;
        }
    }
    host.innerHTML = `<div class="assess-empty-note">No duplicate or nearby corroborating reports found.</div>`;
};

// The Confidence Score breakdown - an investigative WORKSPACE opened by clicking
// the score. Five sections: Score composition · Satellite verification (embedded)
// · Duplicate analysis · Evidence & metadata checks · AI reasoning. Reuses the
// cached snapshot (never asks to re-run once assessed). Closes with ×, click-out,
// or Escape. Re-run is a separate action (the card's "Re-run assessment").
window._showAssessmentModal = (reportId) => {
    const r = allReports.find(x => x.id === reportId)
        || (_detailOnlyReport && _detailOnlyReport.id === reportId ? _detailOnlyReport : null);
    const snap = _assessSnapshot(r);
    if (!snap) { showToast('Run the assessment first to see the breakdown.', 'info'); return; }
    const ic = snap.ic;

    const old = document.getElementById('assess-modal-overlay');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'assess-modal-overlay';
    ov.className = 'assess-modal-overlay';
    const onKey = (e) => {
        const o = document.getElementById('assess-modal-overlay');
        if (!o) { document.removeEventListener('keydown', onKey); return; }
        if (e.key === 'Escape') { o.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };

    const meta = _credBandMeta(ic.band);
    const factors = ic.factors || [];

    // Section 1 - score composition (per-check points + bars + evidence).
    const rowHtml = factors.map(f => {
        const pct = (f.ran && f.max) ? Math.max(2, Math.round((f.awarded / f.max) * 100)) : 0;
        const state = !f.ran ? 'skip' : (f.awarded >= f.max * 0.7 ? 'strong' : f.awarded > 0 ? 'partial' : 'none');
        return `<div class="assess-factor assess-factor-${state}">
            <div class="assess-factor-top">
                <span class="assess-factor-label">${escapeHtml(f.label)}</span>
                <span class="assess-factor-pts">${f.ran ? `+${f.awarded}` : '<i class="fa-solid fa-minus"></i>'}<span class="assess-factor-max"> / ${f.max}</span></span>
            </div>
            <div class="assess-factor-bar"><span style="width:${pct}%;"></span></div>
            <div class="assess-factor-reason">${escapeHtml(f.reason || '')}</div>
        </div>`;
    }).join('');
    const eqTerms = factors.filter(f => f.ran && f.awarded > 0).map(f => `<span class="assess-eq-term">+${f.awarded}</span>`).join('');
    const eqHtml = `<div class="assess-eq"><div class="assess-eq-row">${eqTerms || '<span class="assess-eq-term">+0</span>'}<span class="assess-eq-eq">=</span><span class="assess-eq-total">${ic.score}</span><span class="assess-eq-den">/ 100</span></div></div>`;

    const atLabel = _assessedAtLabel(snap);
    const _section = (key, icon, title, body, sub) =>
        `<details class="assess-sec" ${key === 'composition' || key === 'satellite' ? 'open' : ''}>
            <summary class="assess-sec-head"><i class="fa-solid ${icon}"></i> <span>${title}</span>${sub ? `<span class="assess-sec-sub">${sub}</span>` : ''}<i class="fa-solid fa-chevron-down assess-sec-caret"></i></summary>
            <div class="assess-sec-body">${body}</div>
        </details>`;

    const dupCount = snap.duplicate_count || 0;

    ov.innerHTML = `<div class="assess-modal assess-workspace" role="dialog" aria-label="Confidence Score breakdown" style="--cred-color:${meta.color};">
        <div class="assess-head">
            <div class="assess-head-dial"><span class="assess-head-num">${ic.score}</span><span class="assess-head-den">/100</span></div>
            <div class="assess-head-meta">
                <div class="assess-head-title">Confidence Score</div>
                <div class="assess-head-band">${meta.word} · ${ic.ran_count} of ${ic.total_checks} checks ran${atLabel ? ' · ' + escapeHtml(atLabel) : ''}</div>
            </div>
            <button class="assess-rerun-top" onclick="runFullAssessment('${r.id}')" title="Run every automated check again"><i class="fa-solid fa-rotate"></i> Re-run assessment</button>
            <button class="assess-close" aria-label="Close" onclick="const o=document.getElementById('assess-modal-overlay');if(o)o.remove();"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="assess-intro">Everything the system used to judge how credible and actionable this report is — automated checks only; an analyst's verdict never changes the score.</div>
        <div class="assess-body">
            ${_section('composition', 'fa-calculator', 'Score composition', `<div class="assess-factors">${rowHtml}</div>${eqHtml}`)}
            ${_section('satellite', 'fa-satellite', 'Satellite verification', _renderSatelliteAnalysis(r))}
            ${_section('duplicates', 'fa-clone', 'Duplicate analysis', `<div id="assess-dup-host"><div class="assess-empty-note"><i class="fa-solid fa-spinner fa-spin"></i> Checking for duplicate and nearby reports…</div></div>`, dupCount > 0 ? `${dupCount} merged` : '')}
            ${_section('evidence', 'fa-clipboard-check', 'Evidence & metadata checks', _renderEvidenceChecks(r))}
            ${_section('reasoning', 'fa-lightbulb', 'AI reasoning', _renderAiReasoning(r, snap))}
        </div>
        <div class="assess-method">
            <div class="assess-method-h"><i class="fa-solid fa-circle-info"></i> How this is calculated</div>
            <p>The Confidence Score is the sum of independent automated checks, each contributing up to a fixed maximum: <strong>AI content 30</strong> · <strong>Satellite 25</strong> · <strong>Location 15</strong> · <strong>Corroboration 15</strong> · <strong>Reporter 15</strong> = 100.</p>
            <p>It reflects the <strong>system's automated assessment only</strong>. An analyst accepting, rejecting, or otherwise reviewing this report never changes the number — that decision is tracked separately as the report's status.</p>
        </div>
    </div>`;
    document.body.appendChild(ov);
    try { _loadAssessmentDuplicates(r); } catch (_e) {}
};

// ── ONE combined incident status ──────────────────────────────────────────────
// The operational lifecycle (PENDING/RESPONDING/RESOLVED/FALSE_ALARM) and the
// human review verdict (NOT_REVIEWED/ACCEPTED/REJECTED) were two separate pills
// that read like two competing statuses ("PENDING" + "Not reviewed") and ADDED
// cognitive load. This collapses them into ONE status the operator reads at a
// glance - a single lifecycle: Needs review -> Accepted/Rejected -> Responding
// -> Resolved (the most-advanced operational state wins; verdict only shows
// while the incident is still pending a response decision).
function _displayStatus(r) {
    const st = r.status, vd = r.reviewer_verdict || 'NOT_REVIEWED';
    if (st === 'FALSE_ALARM') return { label: 'False alarm', cls: 'false-alarm', title: 'Closed as a false alarm.' };
    if (st === 'RESOLVED')    return { label: 'Resolved',    cls: 'resolved',    title: 'Situation handled and resolved.' };
    if (st === 'RESPONDING')  return { label: 'Responding',  cls: 'responding',  title: 'Help has been dispatched - response in progress.' };
    if (vd === 'REJECTED')    return { label: 'Rejected',    cls: 'rejected',    title: 'An analyst reviewed and rejected this report.' };
    if (vd === 'ACCEPTED')    return { label: 'Accepted',    cls: 'accepted',    title: 'Reviewed and accepted - awaiting a response decision.' };
    return { label: 'Needs review', cls: 'needs-review', title: 'New report - not yet reviewed or responded to.' };
}
window._displayStatus = _displayStatus;

// ── Feed-card shared helpers ─────────────────────────────────────────────────
// ONE source of truth for the Confidence chip, status pill, action CTA and card
// title across all three card renderers (createIncidentCard, createIncidentRow,
// showIncidentPreview). Before this, each renderer hand-rolled its own status /
// action / score markup and drifted from the incident-detail workflow (stale
// "SEND HELP" / "HELPED" labels, the satellite sub-score shown as if it were the
// Confidence Score). Routing all three through these helpers keeps the feed in
// lock-step with the detail page.

// Short band labels for the compact card chip (the detail page uses the longer
// _credBandMeta words like "High confidence"). UNVERIFIED -> "Unrated" so it is
// never confused with the human "Rejected" verdict.
const _BAND_SHORT = { VERIFIED: 'Verified', LIKELY: 'Likely', MIXED: 'Mixed', WEAK: 'Weak', UNVERIFIED: 'Unrated' };

// The composite Confidence Score chip - the SAME 0-100 + band the operator acts
// on in the detail panel (incident_credibility, server-computed at read time and
// present on every list payload). Suppressed to a muted "Unrated" pill until the
// AI and/or satellite check has run (incident_credibility.assessed).
function _confidenceChip(r) {
    const ic = r && r.incident_credibility;
    if (ic && ic.assessed && typeof ic.score === 'number') {
        const meta = _credBandMeta(ic.band);
        const short = _BAND_SHORT[ic.band] || 'Unrated';
        return `<span class="qrt-confidence cf-${meta.cls}" style="--cf:${meta.color}"`
            + ` title="Confidence Score ${ic.score}/100 - ${meta.word}. Open the incident for the full breakdown.">`
            + `<span class="cf-dot"></span>${short} ${ic.score}</span>`;
    }
    return `<span class="qrt-confidence cf-unverified" title="Not yet assessed - open the incident to run the assessment.">`
        + `<span class="cf-dot"></span>Unrated</span>`;
}
window._confidenceChip = _confidenceChip;

// Tiny media-presence icons (photo / audio) - split OUT of the old evidence chip
// so the card carries exactly one number (the Confidence Score) and the media
// state reads as a separate, quieter signal.
function _cardMediaIcons(r) {
    const m = (r && r.media) || [];
    const hasImg = m.some(x => x && x.type === 'IMAGE');
    const hasAudio = m.some(x => x && x.type === 'AUDIO');
    return (hasImg ? '<i class="fa-solid fa-camera qrt-media-ic" title="Photo attached"></i>' : '')
         + (hasAudio ? '<i class="fa-solid fa-microphone qrt-media-ic" title="Audio attached"></i>' : '');
}

const _STATUS_ICON = {
    'needs-review': 'fa-circle-dot', accepted: 'fa-circle-check', rejected: 'fa-ban',
    responding: 'fa-truck-medical', resolved: 'fa-flag-checkered', 'false-alarm': 'fa-xmark',
};

// Verdict-aware operational status pill - identical vocabulary to the detail page
// (_displayStatus composes report.status x reviewer_verdict): Needs review /
// Accepted / Rejected / Responding / Resolved / False alarm.
function _cardStatusPill(r) {
    const ds = _displayStatus(r);
    const ic = _STATUS_ICON[ds.cls] || 'fa-circle-dot';
    return `<span class="qrt-status-pill st-${ds.cls}" title="${ds.title}"><i class="fa-solid ${ic}"></i> ${ds.label}</span>`;
}
window._cardStatusPill = _cardStatusPill;

// Footer-right: the status pill, plus the Notify Responders CTA for incidents
// that are still open (PENDING/VERIFIED and not rejected). Rejected / responding
// / resolved / false-alarm cards show the pill only (no live dispatch button) -
// this also fixes the rejected-queue bug where a rejected report (still status
// PENDING) used to render a clickable "SEND HELP". patchReport(id,'dispatch') is
// the same always-dispatch + reporter-push path as the detail "Notify Response
// Team" action; only the card label was stale.
function _cardActionEl(r) {
    const verdict = r.reviewer_verdict || 'NOT_REVIEWED';
    const isOpen = (r.status === 'PENDING' || r.status === 'VERIFIED') && verdict !== 'REJECTED';
    if (isOpen) {
        return _cardStatusPill(r)
            + `<button class="qrt-dispatch-btn" title="Notify the response team and alert the reporter"`
            + ` onclick="event.stopPropagation(); patchReport('${r.id}', 'dispatch')">`
            + `<i class="fa-solid fa-bell-concierge"></i> Notify Responders</button>`;
    }
    return _cardStatusPill(r);
}
window._cardActionEl = _cardActionEl;

// A GENUINELY tagged building: building_id + a name that came from an OSM footprint
// (infrastructure_name_from_osm !== false). This is the ONLY case we present
// infrastructure_name as a BUILDING name + a Building Console route. The "Other /
// not listed" free-text (infrastructure_name_from_osm === false) is the reporter's
// "what was hit" label - the incident TYPE, never a building - so it must not show a
// building link or breadcrumb segment. (Explicit `false` is the discriminator;
// `null` legacy rows are treated as taggable to avoid regressing pre-v3 data.)
function _taggedBuildingName(r) {
    return !!(r && r.building_id && r.infrastructure_name && r.infrastructure_name_from_osm !== false);
}
window._taggedBuildingName = _taggedBuildingName;

// Whether to surface a building AT ALL (breadcrumb segment / card link / Console
// route): building_id is set AND it is NOT the "Other" free-text masquerade (a name
// typed for "Other / what was hit" with infrastructure_name_from_osm === false). A
// building_id with no name still surfaces (labeled "Building"); only the masquerade
// is hidden. The display label is the genuine name when _taggedBuildingName, else
// "Building".
// Canonical hierarchy-crumb labels + placeholders so EVERY breadcrumb/spine renders
// the uniform Global › Operation › Building › Incident with the SAME wording when a
// level is genuinely absent (muted, non-link via .dp-bc-absent). A building name here
// ALWAYS comes from the OSM record (_taggedBuildingName) - never the reporter's
// free-text "what was hit".
const _HIER_OP_ABSENT = 'No operation';
const _HIER_BLDG_ABSENT = 'Unmapped building';
function _opCrumbName(r) {
    return (r && r.crisis_event_id) ? (r.crisis_event_name || 'Operation') : null;
}
function _bldgCrumbName(r) {
    if (_taggedBuildingName(r)) return r.infrastructure_name;   // genuine OSM building name
    if (r && r.building_id) return 'Building';                  // tagged but unnamed
    return null;                                                // no building at all
}
window._opCrumbName = _opCrumbName;
window._bldgCrumbName = _bldgCrumbName;

function _hasBuildingLink(r) {
    return !!(r && r.building_id) && !(r.infrastructure_name && r.infrastructure_name_from_osm === false);
}
window._hasBuildingLink = _hasBuildingLink;

// NOTE: the old `_cardTitle` helper was removed - it led with the building name
// (infrastructure_name) for tagged reports, which violates the no-redundant-parent
// principle now that incident cards always sit UNDER their building. The card title
// is built inline in createIncidentCard (leads with "what was hit" / infra label;
// see feedback_no_redundant_parent_context). Don't reintroduce a building-name-first
// title helper.

// "N more reports nearby" CTA -> a modal listing the nearby incidents, each
// click-through to that incident. Sourced from `allReports`, which ALREADY
// excludes merged-away duplicates (confirmed duplicates collapsed under their
// primary are hidden from the feed working set) - so a primary never lists the
// reports merged into it.
window._showNearbyModal = (reportId) => {
    const r = allReports.find(x => x.id === reportId)
        || (_detailOnlyReport && _detailOnlyReport.id === reportId ? _detailOnlyReport : null);
    if (!r || !r.location) return;
    const loc = r.location;
    const nearby = allReports
        .filter(rr => rr.id !== r.id && rr.location)
        .map(rr => ({ rr, dist: haversineKm(loc.latitude, loc.longitude, rr.location.latitude, rr.location.longitude) }))
        .filter(x => x.dist < 5)
        .sort((a, b) => a.dist - b.dist);

    const old = document.getElementById('nearby-modal-overlay');
    if (old) old.remove();
    const ov = document.createElement('div');
    ov.id = 'nearby-modal-overlay';
    ov.className = 'nearby-modal-overlay';
    const onKey = (e) => {
        const o = document.getElementById('nearby-modal-overlay');
        if (!o) { document.removeEventListener('keydown', onKey); return; }
        if (e.key === 'Escape') { o.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };

    const _distLabel = (d) => d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`;
    const _incidentRow = ({ rr, dist }) => {
        const sevc = SEV_COLORS[rr.severity] || '#64748b';
        const infra = infraDisplayLabel(rr.infrastructure_type, rr.infrastructure_sub_type) || 'Incident';
        const place = (rr.location && (rr.location.user_location_name || rr.location.device_location_name))
            || `${rr.location.latitude.toFixed(3)}, ${rr.location.longitude.toFixed(3)}`;
        const ds = _displayStatus(rr);
        const dup = (rr.duplicate_count > 0) ? `<span class="nearby-dup" title="${rr.duplicate_count} corroborating reports merged under this incident">🔗 ${rr.duplicate_count}</span>` : '';
        return `<button class="nearby-row" onclick="window.openIncident('${rr.id}');const o=document.getElementById('nearby-modal-overlay');if(o)o.remove();">
            <span class="nearby-sev" style="background:${sevc};"></span>
            <span class="nearby-main">
                <span class="nearby-title">${escapeHtml(infra)} ${dup}</span>
                <span class="nearby-sub">${escapeHtml(place)} · ${escapeHtml(ds.label)}</span>
            </span>
            <span class="nearby-dist">${_distLabel(dist)} <i class="fa-solid fa-chevron-right"></i></span>
        </button>`;
    };

    // Group by BUILDING (the operational object): Building › Incident, groups open
    // by default; the building header opens the Building Console. Incidents with no
    // mapped building fall into a final "Not in a mapped building" group.
    const byBuilding = new Map();
    const ungrouped = [];
    for (const item of nearby) {
        const bid = item.rr.building_id;
        if (!bid) { ungrouped.push(item); continue; }
        if (!byBuilding.has(bid)) byBuilding.set(bid, { bid, items: [], name: null, minDist: Infinity });
        const g = byBuilding.get(bid);
        g.items.push(item);
        if (item.dist < g.minDist) g.minDist = item.dist;
        if (!g.name && _taggedBuildingName(item.rr)) g.name = item.rr.infrastructure_name;   // OSM name only, never free-text
    }
    const groupsHtml = [...byBuilding.values()].sort((a, b) => a.minDist - b.minDist).map(g => `
        <div class="nearby-group">
            <button class="nearby-group-head" title="Open the Building Console (all reports for this building)"
                    onclick="window.openBuildingConsole&&window.openBuildingConsole(decodeURIComponent('${encodeURIComponent(g.bid)}'));const o=document.getElementById('nearby-modal-overlay');if(o)o.remove();">
                <i class="fa-solid fa-building nearby-group-icon"></i>
                <span class="nearby-group-name">${escapeHtml(g.name || 'Building')}</span>
                <span class="nearby-group-count">${g.items.length}</span>
                <span class="nearby-group-go">${_distLabel(g.minDist)} <i class="fa-solid fa-arrow-up-right-from-square"></i></span>
            </button>
            <div class="nearby-group-body">${g.items.map(_incidentRow).join('')}</div>
        </div>`).join('');
    const ungroupedHtml = ungrouped.length ? `
        <div class="nearby-group">
            <div class="nearby-group-head nearby-group-head-static">
                <i class="fa-solid fa-location-dot nearby-group-icon"></i>
                <span class="nearby-group-name">Not in a mapped building</span>
                <span class="nearby-group-count">${ungrouped.length}</span>
            </div>
            <div class="nearby-group-body">${ungrouped.map(_incidentRow).join('')}</div>
        </div>` : '';
    const listInner = (groupsHtml + ungroupedHtml) || '<div class="nearby-empty">No other incidents nearby.</div>';

    ov.innerHTML = `<div class="nearby-modal" role="dialog" aria-label="Nearby incidents">
        <div class="nearby-head">
            <span><i class="fa-solid fa-layer-group"></i> ${nearby.length} nearby incident${nearby.length === 1 ? '' : 's'} <span class="nearby-head-sub">within 5 km</span></span>
            <button class="nearby-close" aria-label="Close" onclick="const o=document.getElementById('nearby-modal-overlay');if(o)o.remove();"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="nearby-list">${listInner}</div>
    </div>`;
    document.body.appendChild(ov);
};

/** Ensure ISO string is treated as UTC if no timezone indicator present */
function ensureUTC(iso) {
    if (!iso) return iso;
    const s = String(iso).trim();
    if (/Z$/i.test(s) || /[+-]\d{2}:\d{2}$/.test(s) || /[+-]\d{4}$/.test(s)) return s;
    return s + 'Z';
}

// ── Operator-local time presentation (Jun 2026) ──────────────────────────
// ONE date-time format for the whole dashboard: "11 Jun 2026, 2:45 PM"
// in the operator's local timezone + locale. Every absolute timestamp
// shown in UI goes through here - never raw ISO, never UTC wall-clock.
// Parsing routes through ensureUTC so a naive backend string can never
// render shifted by the local offset.
function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(ensureUTC(iso));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString([], {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
    });
}
// DATE-ONLY values (e.g. satellite acquisition_date "2026-06-08") must not
// be fed to the Date parser as bare strings - JS reads them as UTC
// midnight, which displays as the PREVIOUS day for viewers west of UTC.
// Anchor the literal Y-M-D to LOCAL midnight, then show the calendar date.
function fmtDateOnly(s) {
    if (!s) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s).trim());
    if (!m) return fmtDateTime(s) || String(s);
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}
// Exposed for the sibling modules (cc-home / cc-settings / cc-crisis /
// predictions load after app.js) so every surface shares one format.
window.__ccFmtDateTime = fmtDateTime;
window.__ccFmtDateOnly = fmtDateOnly;
window.__ccEnsureUTC = ensureUTC;

function timeAgo(iso) {
    const d = new Date(ensureUTC(iso));
    if (isNaN(d.getTime())) return 'Just now';
    const diff = (Date.now() - d) / 1000;
    if (diff < 0) return 'Just now';
    if (diff < 60) return `${Math.round(diff)}s ago`;
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) {
        const h = Math.floor(diff / 3600);
        const m = Math.round((diff % 3600) / 60);
        return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
    }
    const days = Math.round(diff / 86400);
    return days === 1 ? '1 day ago' : `${days}d ago`;
}

/** Rich time display for detail panel: "3:45 PM · 2h 15m ago" */
function timeDisplay(iso) {
    const d = new Date(ensureUTC(iso));
    if (isNaN(d.getTime())) return 'Unknown';
    const localTime = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return `${localTime} · ${timeAgo(iso)}`;
}

/** Short date format: "Apr 2, 3:45 PM" */
function formatShortDate(iso) {
    const d = new Date(ensureUTC(iso));
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ', ' +
           d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function showToast(msg, type = 'info') {
    let container = document.querySelector('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-check-circle' : 'fa-info-circle'}"></i> ${msg}`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// D6: shared double-submit / busy guard. Disables the triggering button for the
// duration of an async action and shows an inline spinner, then restores it.
// Re-entrant calls on an already-busy button are ignored (the real double-submit
// guard). Returns whatever the wrapped fn resolves to (undefined if guarded out).
// Many handlers re-render their panel on success, replacing the button - that's
// fine: the finally block then operates on a detached node, which is harmless.
async function withBusy(btn, fn) {
    if (!btn) { return typeof fn === 'function' ? await fn() : undefined; }
    if (btn.dataset.busy === '1' || btn.disabled) return undefined; // already in flight
    // Only buttons/links get the spinner label-swap; for form controls (select,
    // input) we must NOT touch innerHTML (it would wipe a <select>'s options) -
    // disabling them is enough to block a second submit.
    const tag = (btn.tagName || '').toUpperCase();
    const swap = tag === 'BUTTON' || tag === 'A';
    const prevHtml = swap ? btn.innerHTML : null;
    const prevWidth = btn.offsetWidth;
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    if (swap) {
        // Pin the width so the spinner swap doesn't reflow the button.
        if (prevWidth) { try { btn.style.minWidth = prevWidth + 'px'; } catch (_e) {} }
        try { btn.innerHTML = '<span class="cc-busy-spin" aria-hidden="true"></span>'; } catch (_e) {}
    }
    try {
        return await fn();
    } finally {
        // The node may have been replaced by a re-render; guard every touch.
        try {
            btn.disabled = false;
            delete btn.dataset.busy;
            btn.removeAttribute('aria-busy');
            if (swap) { btn.style.minWidth = ''; btn.innerHTML = prevHtml; }
        } catch (_e) { /* node detached - nothing to restore */ }
    }
}
window.withBusy = withBusy;

// ── Ungrouped-critical cluster chooser ───────────────────────────────────────
// Clicking the "N critical reports, no operation" card no longer FORCES
// operation creation. It opens a deliberate two-option chooser so the operator
// chooses the workflow:
//   A) View ungrouped reports - investigate the unassigned-critical reports in
//      the global feed (#/incidents;queue=ungrouped). NO operation is created.
//   B) Create new operation   - open the 4-step wizard (fromCluster:true); on
//      launch the backend claims the open-critical, no-operation reports.
// This supports both Monitor→Investigate→Act AND Monitor→Investigate→Create
// Operation→Coordinate. Creation is a deliberate choice, never the default.
function _injectClusterChooserStyles() {
    if (document.getElementById('ccx-styles')) return;
    const st = document.createElement('style');
    st.id = 'ccx-styles';
    st.textContent = `
    .ccx-overlay{position:fixed;inset:0;z-index:100040;display:flex;align-items:center;justify-content:center;
      background:rgba(5,10,20,.62);padding:20px;animation:ccxfade .12s ease}
    @keyframes ccxfade{from{opacity:0}to{opacity:1}}
    .ccx-box{position:relative;width:min(460px,100%);background:#101a2e;border:1px solid #2a3a55;border-radius:16px;
      box-shadow:0 24px 60px rgba(0,0,0,.5);padding:22px 22px 20px;color:#E6EDF7;
      font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
    .ccx-x{position:absolute;top:12px;right:12px;width:28px;height:28px;border-radius:8px;border:1px solid #2a3a55;
      background:transparent;color:#9fb2d4;cursor:pointer;font-size:13px;line-height:1}
    .ccx-x:hover{border-color:#f87171;color:#fca5a5}
    .ccx-hd{display:flex;gap:12px;align-items:flex-start;margin:2px 26px 18px 0}
    .ccx-ic{font-size:22px;line-height:1.1;flex:0 0 auto}
    .ccx-t{font-size:15px;font-weight:800;letter-spacing:.01em}
    .ccx-s{font-size:12px;color:#9fb2d4;margin-top:4px;line-height:1.45}
    .ccx-opts{display:flex;flex-direction:column;gap:10px}
    .ccx-opt{display:flex;align-items:center;gap:12px;text-align:left;width:100%;cursor:pointer;background:#0d1626;
      border:1px solid #233149;border-radius:12px;padding:13px 14px;color:#E6EDF7;
      transition:border-color .12s,background .12s,transform .06s}
    .ccx-opt:hover{border-color:#418FDE;background:#13203a}
    .ccx-opt:active{transform:translateY(1px)}
    .ccx-opt:focus-visible{outline:2px solid #418FDE;outline-offset:2px}
    .ccx-opt-go:hover{border-color:#34D399;background:#10241d}
    .ccx-opt-ic{font-size:20px;flex:0 0 auto}
    .ccx-opt-txt{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
    .ccx-opt-txt b{font-size:13.5px;font-weight:700}
    .ccx-opt-txt span{font-size:11.5px;color:#9fb2d4;line-height:1.4}
    .ccx-opt-ar{font-size:18px;color:#5f7290;flex:0 0 auto}`;
    document.head.appendChild(st);
}
function openClusterChooser(opts) {
    opts = opts || {};
    const critical = Number(opts.critical) || 0;
    _injectClusterChooserStyles();
    const prev = document.getElementById('cluster-chooser');
    if (prev) { try { prev.remove(); } catch (_e) {} }

    const n = critical
        ? `${critical.toLocaleString()} critical report${critical === 1 ? '' : 's'}`
        : 'Critical reports';
    const ov = document.createElement('div');
    ov.id = 'cluster-chooser';
    ov.className = 'ccx-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', 'Ungrouped critical reports - choose an action');
    ov.innerHTML = `
      <div class="ccx-box">
        <button class="ccx-x" type="button" aria-label="Close">✕</button>
        <div class="ccx-hd"><span class="ccx-ic" aria-hidden="true">🚨</span>
          <div><div class="ccx-t">${escapeHtml(n)} · no operation</div>
          <div class="ccx-s">These critical reports aren't assigned to any operation. Investigate them first, or create an operation to coordinate a response - your choice.</div></div></div>
        <div class="ccx-opts">
          <button class="ccx-opt" id="ccx-view" type="button">
            <span class="ccx-opt-ic" aria-hidden="true">📋</span>
            <span class="ccx-opt-txt"><b>View ungrouped reports</b>
              <span>Open these reports in the global feed to investigate. No operation is created.</span></span>
            <span class="ccx-opt-ar" aria-hidden="true">›</span></button>
          <button class="ccx-opt ccx-opt-go" id="ccx-create" type="button">
            <span class="ccx-opt-ic" aria-hidden="true">🚀</span>
            <span class="ccx-opt-txt"><b>Create new operation</b>
              <span>Launch an operation to coordinate the response and claim these reports.</span></span>
            <span class="ccx-opt-ar" aria-hidden="true">›</span></button>
        </div>
      </div>`;
    document.body.appendChild(ov);

    const close = () => { try { ov.remove(); } catch (_e) {} document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
    document.addEventListener('keydown', onKey);
    ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
    ov.querySelector('.ccx-x').addEventListener('click', close);
    // A) Investigate - no operation created.
    ov.querySelector('#ccx-view').addEventListener('click', () => {
        close();
        try { window.location.hash = '#/incidents;queue=ungrouped'; } catch (_e) {}
    });
    // B) Coordinate - the deliberate 4-step wizard; fromCluster claims on launch.
    ov.querySelector('#ccx-create').addEventListener('click', () => {
        close();
        try {
            if (typeof window.openOperationWizard === 'function') window.openOperationWizard({ fromCluster: true });
            else showToast('Operation wizard is still loading - try again in a moment.', 'info');
        } catch (_e) { showToast('Could not open the operation wizard.', 'error'); }
    });
    // Focus the safe/investigate action first (creation is never the default).
    try { ov.querySelector('#ccx-view').focus(); } catch (_e) {}
}
window.openClusterChooser = openClusterChooser;

// ── Operations Phase 3 - undo write-path ──────────────────────────────────────
// Reverses the most recent cluster claim on an operation (un-sets
// crisis_event_id on exactly those reports). Surfaced as the operation
// dashboard's "Undo claim" button.

async function unclaimOperation(opId, btn) {
    if (!opId) return;
    // D4: disable the trigger during the async unclaim so it can't be spam-clicked.
    const _reenable = () => { if (btn) { try { btn.disabled = false; } catch (_e) {} } };
    if (btn) { try { btn.disabled = true; } catch (_e) {} }
    try {
        const res = await fetch(`${BACKEND_HOST}/api/v1/operations/${encodeURIComponent(opId)}/unclaim`,
            { method: 'POST' });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { showToast(body.detail || 'Nothing to undo', 'info'); _reenable(); return; }
        const n = body.unclaimed_count || 0;
        showToast(`Claim reversed · ${n} report${n === 1 ? '' : 's'} released`, 'success');
        // D4: defer the redirect home so the success toast is actually readable
        // (it used to redirect in the same tick, flashing the toast away).
        setTimeout(() => { try { window.location.hash = '#/'; } catch (_e) {} }, 1800);
    } catch (_e) { showToast('Undo failed - network error', 'error'); _reenable(); }
}
window.unclaimOperation = unclaimOperation;

// ── Live Incident Notification System ────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════
// Phase J.4 (May 2026) - Notification card-stack + burst-mode banner
// ══════════════════════════════════════════════════════════════════════
// Replaces the clobber-and-replace flash with an honest card stack
// (center-screen per operator preference). New cards push the
// previous ones into a fanned-deck visual. Burst threshold (operator
// confirmed: 5 in 5 s) coalesces extreme arrival rates into a single
// "+N incoming" banner so the surface stays calm even under disaster
// traffic. Dedup keys: report.id, client_report_id, and a
// building+crisis 60 s coalesce.

const _STACK_MAX_VISIBLE = 3;       // max cards in the visible stack
const _STACK_AUTODISMISS_SOLO_MS = 5000;  // single card lifespan (~5s, show-once)
const _STACK_QUIET_MS = 12000;      // stack collapse after this long idle
const _BURST_THRESHOLD = 3;         // 3 in 12 s - engage under SUSTAINED load too, not
const _BURST_WINDOW_MS = 12000;     // just sharp bursts; collapses center-card spam into
                                    // the burst banner (bell still counts every arrival).
const _COALESCE_WINDOW_MS = 60000;  // same building+crisis = update
// REAL-TIME age gate: a report only flashes an individual center-screen toast
// when it was CREATED within this window of now. Older reports are "historical"
// - they land silently in the Notification Center (unread) and are summarised by
// a "since your last visit" banner, never replayed as per-card pop-ups (e.g.
// opening an Operation surfaces its hours-old backlog).
const _REALTIME_WINDOW_MS = 5 * 60 * 1000;
const _BACKLOG_BANNER_MIN = 3;   // >= this many silent historical arrivals in ONE
                                 // full-refresh (scope switch) → one summary banner
let _backlogSilent = 0;          // running count of age-gated (silent) arrivals
let _notificationStack = [];        // [{ id, clientId, buildingId, crisisType, severity, type, location, source, srcIcon, srcBrand, sevColor, addedAt }]
let _burstArrivals = [];            // timestamps of recent arrivals (in burst window)
let _burstBannerActive = false;
let _stackQuietTimer = null;
let _stackSoloTimer  = null;        // exactly one auto-dismiss timer at a
                                    // time (cleared on every stack mutation;
                                    // re-armed only when length === 1).

// Notification-lifecycle debug hook - set
// `localStorage.crisp_notif_debug = '1'` in DevTools to trace every
// dedup decision in the console. Off in production. The state inspector
// `window.__crispNotifDebug()` is always available regardless of the flag.
function _notifLog(...args) {
    try {
        if (localStorage.getItem('crisp_notif_debug') === '1') {
            console.log('[CRISP-notif]', ...args);
        }
    } catch (_) { /* SSR / disabled storage - silent */ }
}

function _inBurstMode() {
    const now = Date.now();
    _burstArrivals = _burstArrivals.filter(t => (now - t) < _BURST_WINDOW_MS);
    return _burstArrivals.length >= _BURST_THRESHOLD;
}

// Helper - central place to (re)arm the per-stack timers. Called from
// `_addNotification` and `_dismissStackCard` so growth + shrink land on
// the same state machine. Prior code had a per-card `notif._dismissTimer`
// that leaked when the stack grew from 1 → 2 (the solo timer kept
// firing and made card 1 vanish mid-stack).
function _refreshStackTimers() {
    if (_stackSoloTimer)  { clearTimeout(_stackSoloTimer);  _stackSoloTimer  = null; }
    if (_stackQuietTimer) { clearTimeout(_stackQuietTimer); _stackQuietTimer = null; }
    if (_notificationStack.length === 1) {
        const solo = _notificationStack[0];
        _stackSoloTimer = setTimeout(() => {
            _notificationStack = _notificationStack.filter(n => n.id !== solo.id);
            _stackSoloTimer = null;
            _renderNotificationStack();
        }, _STACK_AUTODISMISS_SOLO_MS);
    } else if (_notificationStack.length > 1) {
        _stackQuietTimer = setTimeout(() => {
            // Fly the whole stack to the bell.
            const stackEl = document.getElementById('notif-stack');
            if (stackEl) {
                stackEl.classList.add('fly-away');
                setTimeout(() => {
                    _notificationStack = [];
                    _stackQuietTimer = null;
                    _renderNotificationStack();
                }, 700);
            } else {
                _notificationStack = [];
                _stackQuietTimer = null;
                _renderNotificationStack();
            }
        }, _STACK_QUIET_MS);
    }
}

function _addNotification(r) {
    // May 2026 (regression follow-up) - the prior fix's
    // `_suppressNewReportNotifications` flag was REMOVED. It papered over
    // the underlying problem (knownIds.clear() in _replaceReportData
    // causes EVERY report to look new) by silencing the notify path
    // wholesale. On any deployment where the dashboard couldn't read
    // X-Server-Time (cross-origin dev, LAN, cloudflared tunnel - CORS
    // expose_headers omission) `wantFullRefresh` stayed true forever,
    // EVERY poll re-walked the snapshot under the suppression flag, and
    // ALL operator notifications were silently dropped. _replaceReportData
    // is now diff-based so the only path that ever calls _addNotification
    // is a TRULY-new report; this entry stays unguarded.
    const locName = r.location?.user_location_name || r.location?.device_location_name || 'Unknown location';
    const srcIcons = {APP:'fa-mobile-screen-button',ANDROID:'fa-robot',WHATSAPP:'fa-whatsapp',TELEGRAM:'fa-telegram',SMS:'fa-comment-sms',IVR:'fa-phone'};
    const srcBrand = ['WHATSAPP','TELEGRAM'].includes(r.source) ? 'fa-brands' : 'fa-solid';
    const sevColor = SEV_COLORS[r.severity] || '#64748b';
    const now = Date.now();

    const notif = {
        id: r.id,
        clientId: r.client_report_id || null,
        buildingId: r.building_id || null,
        crisisType: r.crisis_type || null,
        type: (r.infrastructure_type || 'OTHER').replace(/_/g, ' '),
        severity: r.severity || 'UNKNOWN',
        location: locName,
        source: r.source || 'APP',
        srcIcon: srcIcons[r.source] || 'fa-mobile-screen-button',
        srcBrand,
        sevColor,
        timestamp: r.server_created_at,
        addedAt: now,
        coalescedCount: 1,
        // Operation this incident belongs to (denormalised crisis_event_name).
        // null = global (not tied to any operation). Shown on the card + bell.
        operation: r.crisis_event_name || null,
        // Operation ID - so clicking the notification opens the incident INSIDE
        // its operation (deep-link), not just the global feed.
        crisisEventId: r.crisis_event_id || null,
        // Corroboration (#8): a new report in a building that ALREADY has a visible
        // incident is additional EVIDENCE, not a new incident - soften the alert so
        // analysts focus on genuinely-new incidents. Building is the dominant
        // duplicate signal; the analyst still confirms/merges explicitly.
        corroborates: !!(r.building_id && allReports.some((x) => x && x.id !== r.id && x.building_id === r.building_id)),
        // Category (notification taxonomy):
        //   A Informational - new / corroborating report (toast 5s, never repeat)
        //   B Important     - CRITICAL severity (toast 5s + stays highlighted in
        //                     the center until read)
        //   C Urgent        - safety / outage / emergency broadcast (persistent
        //                     until acknowledged). No automatic producer in v1 -
        //                     reserved for window.crispUrgentBroadcast(); the audit
        //                     confirmed nothing in the report path is urgent.
        cat: (String(r.severity).toUpperCase() === 'CRITICAL') ? 'B' : 'A',
        read: false,
        acknowledged: false,
    };

    // ── DEDUP-FIRST. Nothing touches state until we know this is a
    //    genuinely new event. The four checks below distinguish:
    //      (1) same id, card still visible       → update in place
    //      (2) same id, card auto-dismissed      → silent bell-entry refresh
    //      (3) same clientId (offline reconcile) → adopt server id
    //      (4) same building+crisis within 60s   → coalesce count chip

    // 1. Same report.id already in stack → upgrade in place, no
    //    second card, no bell bump.
    const existing = _notificationStack.find(n => n.id === notif.id);
    if (existing) {
        existing.severity = notif.severity;
        existing.type = notif.type;
        existing.location = notif.location;
        existing.sevColor = notif.sevColor;
        existing._upgraded = true;
        existing._upgradeReason = 'updated';
        _renderNotificationStack();
        _notifLog('dedup:stack-update', notif.id);
        return;
    }

    // 2. Bell-panel dedup. If we've already shown this id in the bell
    //    panel (even after the card disappeared from the stack), we
    //    don't want a second center-screen card. This is the typical
    //    "small image arrived, then full image arrived 30s later"
    //    media-upgrade case. PRIOR REGRESSION: this used to return
    //    silently, so the bell entry stayed stale (e.g. old severity).
    //    Now we update the bell entry IN PLACE so the operator sees
    //    fresh content on next bell open. Center-screen still suppressed.
    const bellIdx = _notifCenter.findIndex(n => n.id === notif.id);
    if (bellIdx >= 0) {
        const prev = _notifCenter[bellIdx];
        _notifCenter[bellIdx] = {
            ...prev,
            severity: notif.severity,
            type: notif.type,
            location: notif.location,
            sevColor: notif.sevColor,
            timestamp: notif.timestamp,
            cat: notif.cat,
            // addedAt + read stay - bell entry's "age" is anchored to first
            // arrival and a media-upgrade must not silently mark it unread again.
        };
        _persistNotifCenter();
        _renderNotifications();
        _notifLog('dedup:bell-update', notif.id);
        return;
    }

    // 3. Same client_report_id (offline-queue reconciliation where the
    //    server assigned a different id).
    if (notif.clientId) {
        const byClient = _notificationStack.find(n => n.clientId === notif.clientId);
        if (byClient) {
            byClient.id = notif.id;
            byClient.severity = notif.severity;
            byClient._upgraded = true;
            byClient._upgradeReason = 'reconciled';
            _renderNotificationStack();
            _notifLog('dedup:client-reconcile', notif.clientId, '→', notif.id);
            return;
        }
        const bellClientIdx = _notifCenter.findIndex(n => n.clientId === notif.clientId);
        if (bellClientIdx >= 0) {
            // Adopt the server id on the bell entry but don't pop another card.
            _notifCenter[bellClientIdx] = {
                ..._notifCenter[bellClientIdx],
                id: notif.id,
            };
            _persistNotifCenter();
            _renderNotifications();
            _notifLog('dedup:bell-client-reconcile', notif.clientId, '→', notif.id);
            return;
        }
    }

    // 4. Building + crisis-type coalesce within 60s.
    if (notif.buildingId && notif.crisisType) {
        const sib = _notificationStack.find(n =>
            n.buildingId === notif.buildingId &&
            n.crisisType === notif.crisisType &&
            (now - n.addedAt) < _COALESCE_WINDOW_MS
        );
        if (sib) {
            sib.coalescedCount = (sib.coalescedCount || 1) + 1;
            sib._upgraded = true;
            sib._upgradeReason = `coalesced ×${sib.coalescedCount}`;
            _renderNotificationStack();
            _notifLog('dedup:coalesce', notif.buildingId, sib.coalescedCount);
            return;
        }
    }

    // ── Confirmed: new event. Now mutate state.
    _notifLog('new', notif.id, notif.severity, notif.type);

    // SHOW-ONCE (durable). Record that this incident has been DISPLAYED so it
    // can NEVER be replayed by a later poll - not after an operation-scope
    // full-refresh evicts it from knownIds, not after a page reload, not on
    // any route change. The poll's producer gate (_applyReportData) consults
    // _seenIds.has(id) BEFORE it ever calls _addNotification, so this single
    // write closes the exact replay window that made already-seen toasts
    // re-flash when the analyst moved between Home / Operations / Incidents.
    // (Set on the CONFIRMED-NEW branch, i.e. AFTER the four dedup checks, so
    // offline-reconcile / coalesce semantics above are preserved.)
    _seenIds.add(notif.id);
    _persistSeenIds();

    // Notification Center (durable history) - newest first, unread, capped,
    // persisted. This is what the bell renders + what survives a refresh.
    _notifCenterAdd(notif);
    _renderNotifications();

    // Category C (Urgent) - persistent banner, no auto-dismiss, no burst/stack.
    if (notif.cat === 'C') { _showUrgentBanner(notif); return; }

    // ── AGE GATE. The durable record above (_seenIds + _notifCenterAdd +
    //    _renderNotifications) has ALREADY run, so a historical-but-unseen report
    //    is now an unread bell entry that the "since your last visit" summary
    //    surfaces - it just must NOT pop a center-screen toast. Only GENUINELY
    //    REAL-TIME arrivals (created within _REALTIME_WINDOW_MS of now) flash a
    //    card / engage burst. This is what stops opening an Operation (or any
    //    scope full-refresh) from replaying its hours-old backlog as individual
    //    pop-ups. AGE - not seen-state - is the right discriminator: an id evicted
    //    from the 1000-cap _seenIds and reloaded via a scope switch is still OLD,
    //    so still no re-toast. A missing / unparseable timestamp is treated as
    //    real-time (never drop a genuine arrival on an unknown time). NOTE: we do
    //    NOT bypass on client_report_id - nearly every app/chat report carries one,
    //    so that would defeat the gate; a genuine offline-reconcile is already
    //    handled by the clientId dedup branch above (it returns before here).
    const _createdMs = notif.timestamp
        ? new Date((window.__ccEnsureUTC || ((x) => x))(notif.timestamp)).getTime() : NaN;
    if (Number.isFinite(_createdMs) && (now - _createdMs) > _REALTIME_WINDOW_MS) {
        _backlogSilent++;
        _notifLog('age-gate:silent-bell', notif.id, Math.round((now - _createdMs) / 60000) + 'm old');
        return;
    }

    // Track arrival for burst detection.
    _burstArrivals.push(now);

    if (_inBurstMode()) {
        _showBurstBanner();
        // Suppress per-card spawn; the center already recorded it.
        return;
    } else if (_burstBannerActive) {
        _hideBurstBanner();
    }

    // Prepend to the transient toast stack (~5s show-once surface).
    notif.displayedAt = now;
    _notificationStack.unshift(notif);
    if (_notificationStack.length > _STACK_MAX_VISIBLE) {
        _notificationStack = _notificationStack.slice(0, _STACK_MAX_VISIBLE);
    }
    _renderNotificationStack();

    // Re-arm timers based on the new stack size (Bug C fix - the prior
    // code armed a per-card timer that survived when the stack grew).
    _refreshStackTimers();
}

// Build the inner HTML for a stack card. Pure function - no side
// effects. Called by `_renderNotificationStack` only when a card
// either needs to be CREATED (new id) or its content changed
// (severity / upgrade-chip / location / count). Position is NOT
// embedded here - CSS handles position via `data-pos` so transitions
// are smooth when index changes.
function _buildStackCardInner(n) {
    const srcLabel = {APP:'Mobile App',ANDROID:'Android',WHATSAPP:'WhatsApp',TELEGRAM:'Telegram',SMS:'SMS',IVR:'Voice Call'}[n.source] || n.source;
    const upgradeChip = n._upgraded
        ? `<div class="notif-upgrade-chip" title="${escapeHtml(n._upgradeReason || 'updated')}">
              <i class="fa-solid fa-arrow-up"></i> ${escapeHtml(n._upgradeReason || 'updated')}
           </div>` : '';
    const hintTail = _notificationStack.length === 1 ? ' &middot; Auto-dismiss in 5s' : '';
    const opChip = n.operation
        ? `<div class="notif-flash-op" title="Operation"><i class="fa-solid fa-folder-tree"></i> ${escapeHtml(n.operation)}</div>`
        : `<div class="notif-flash-op global" title="Not tied to any operation"><i class="fa-solid fa-earth-americas"></i> Global</div>`;
    return `
        ${upgradeChip}
        <div class="notif-flash-icon" style="color:${n.sevColor};">🚨</div>
        <div class="notif-flash-title">${n.coalescedCount > 1 ? `${n.coalescedCount}× reports - same building` : (n.corroborates ? 'Existing Incident Updated (+1 corroborating report)' : 'NEW INCIDENT REPORTED')}</div>
        ${opChip}
        <div class="notif-flash-detail">
            <span class="notif-sev" style="background:${n.sevColor}25;color:${n.sevColor};font-size:13px;padding:4px 10px;">${n.severity}</span>
            <span style="font-size:16px;font-weight:700;color:#e2e8f0;">${escapeHtml(n.type)}</span>
        </div>
        <div class="notif-flash-loc"><i class="fa-solid fa-location-dot" style="color:${n.sevColor};"></i> ${escapeHtml(n.location)}</div>
        <div class="notif-flash-source"><i class="${n.srcBrand} ${n.srcIcon}"></i> via ${escapeHtml(srcLabel)}</div>
        <div class="notif-flash-hint">Click to view${hintTail}</div>
    `;
}

// Incremental DOM update. Replaces the old `stack.innerHTML = ...`
// path that destroyed + recreated every card on every render. Now:
//   · existing nodes are looked up by `data-id`
//   · brand-new ids are appended (with `.is-entering` for animate-in)
//   · dropped ids are animate-out + removed
//   · surviving nodes have data-pos / data attributes / inner HTML
//     updated in place - no DOM destroy, so CSS transitions on
//     `transform: translateY(...) scale(...) rotate(...)` interpolate
//     smoothly from the old position to the new one
//
// CSS drives position via `.notif-stack-card[data-pos="N"]` rules,
// keeping the JS layer free of magic numbers.
function _renderNotificationStack() {
    let stack = document.getElementById('notif-stack');
    if (!stack) {
        stack = document.createElement('div');
        stack.id = 'notif-stack';
        stack.className = 'notif-stack';
        document.body.appendChild(stack);
    }

    // Empty-state: animate out remaining cards then remove.
    if (!_notificationStack.length) {
        // Allow a graceful exit if cards are present; otherwise nothing to do.
        const kids = Array.from(stack.children);
        if (!kids.length) {
            stack.classList.remove('has-cards', 'fly-away');
            return;
        }
        // Mark them all leaving; remove after the CSS transition completes.
        kids.forEach((el) => el.classList.add('is-leaving'));
        setTimeout(() => {
            if (!_notificationStack.length) {
                stack.innerHTML = '';
                stack.classList.remove('has-cards', 'fly-away');
            }
        }, 320);
        return;
    }

    stack.classList.remove('fly-away');
    stack.classList.add('has-cards');

    // Desired set: notif id → (notif, index)
    const desired = new Map();
    _notificationStack.forEach((n, i) => desired.set(String(n.id), { n, i }));

    // First pass - remove any DOM card whose id is not in the desired set.
    Array.from(stack.children).forEach((el) => {
        const id = el.getAttribute('data-id');
        if (!desired.has(id)) {
            // Animate out then remove. Guard against double-removal.
            if (!el.classList.contains('is-leaving')) {
                el.classList.add('is-leaving');
                setTimeout(() => { if (el.parentNode === stack) stack.removeChild(el); }, 320);
            }
        }
    });

    // Second pass - for each desired id, update or create.
    desired.forEach(({ n, i }, id) => {
        let el = stack.querySelector(`.notif-stack-card[data-id="${cssEscape(id)}"]`);
        if (!el) {
            // Create new.
            el = document.createElement('div');
            el.className = 'notif-stack-card is-entering';
            el.setAttribute('data-id', id);
            el.setAttribute('data-pos', String(i));
            el.onclick = () => _dismissStackCard(n.id);
            el.innerHTML = _buildStackCardInner(n);
            if (n._upgraded) el.classList.add('is-upgraded');
            stack.appendChild(el);
            // Drop is-entering after the 320ms flash-in finishes so a
            // future re-render doesn't restart the entrance.
            setTimeout(() => el.classList.remove('is-entering'), 360);
            return;
        }
        // Existing - update content + position. NO DOM destroy.
        // Only rewrite innerHTML if the content fingerprint changed,
        // so the upgrade-chip animation doesn't re-fire on every poll.
        const fp = `${n.severity}|${n.type}|${n.location}|${n.coalescedCount}|${n._upgraded ? 1 : 0}|${n._upgradeReason || ''}`;
        if (el.getAttribute('data-fp') !== fp) {
            el.innerHTML = _buildStackCardInner(n);
            el.setAttribute('data-fp', fp);
        }
        el.setAttribute('data-pos', String(i));
        el.classList.toggle('is-upgraded', !!n._upgraded);
        // Defensive: never mark an existing card "entering" again.
        el.classList.remove('is-entering', 'is-leaving');
    });
}

// Minimal CSS.escape polyfill - Safari < 15 didn't have it.
function cssEscape(s) {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

window._dismissStackCard = (id) => {
    _notificationStack = _notificationStack.filter(n => n.id !== id);
    _renderNotificationStack();
    // Re-arm timers for the new stack state - if 2 cards remained and
    // one was just dismissed, the solo timer needs to start for the
    // last surviving card. The shared helper centralises this.
    _refreshStackTimers();
    dismissNotif(id);
};
// Expose for any historical caller (kept for back-compat).
function _dismissStackCard(id) { return window._dismissStackCard(id); }

// Burst banner - pinned center-top when 5+ arrive in 5 s.
function _showBurstBanner() {
    _burstBannerActive = true;
    document.body.classList.add('burst-mode');
    let banner = document.getElementById('notif-burst-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'notif-burst-banner';
        banner.className = 'notif-burst-banner';
        banner.onclick = () => {
            _hideBurstBanner();
            toggleNotifPanel();
        };
        document.body.appendChild(banner);
    }
    const total = _notifUnreadCount();
    banner.innerHTML = `
        <i class="fa-solid fa-bolt"></i>
        <strong>${total}</strong> incidents reporting
        <span class="notif-burst-hint">tap to triage</span>
    `;
    // Reset auto-clear timer; banner stays as long as arrivals keep coming.
    if (banner._clearTimer) clearTimeout(banner._clearTimer);
    banner._clearTimer = setTimeout(() => _hideBurstBanner(), 8000);
}

function _hideBurstBanner() {
    _burstBannerActive = false;
    document.body.classList.remove('burst-mode');
    const banner = document.getElementById('notif-burst-banner');
    if (banner) {
        if (banner._clearTimer) clearTimeout(banner._clearTimer);
        banner.remove();
    }
}

// K.5.e (May 2026, Phase K) - truncation banner. Now a TRANSIENT ~5s message
// (Jun 2026), not a persistent bar.
// When the scope total (X-Total-Count) exceeds the rows actually returned, the
// FEED LIST is windowed to the newest N (counts + map still reflect ALL via
// /analytics/summary + /reports/markers). Operators need to KNOW that once on
// entering a truncated scope - they don't need a permanent banner nagging on
// every route. So it shows ONCE per truncation episode (per scope entry) and
// auto-dismisses after ~5s, consistent with the other informational banners.
// The poll re-detects truncation on every full-refresh (~2 min) + scope change;
// `_truncShown` guards against re-popping, and is reset when truncation resolves
// or the scope changes (setOperationScope) so a new episode shows once.
let _truncShown = false;
let _truncTimer = null;
function _showTruncationBanner(total, shown) {
    if (_truncShown) return;          // already shown this episode - don't re-pop
    _truncShown = true;
    let banner = document.getElementById('truncation-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'truncation-banner';
        banner.className = 'truncation-banner';
        // Insert at the very top of the body so it sits above the
        // dashboard chrome without needing CSS positioning gymnastics.
        document.body.insertBefore(banner, document.body.firstChild);
    }
    banner.innerHTML = `
        <i class="fa-solid fa-triangle-exclamation"></i>
        <strong>Feed list shows the newest ${shown.toLocaleString()} of ${total.toLocaleString()} reports</strong>
        - counts and map reflect all ${total.toLocaleString()}; use filters or open an operation to narrow the list.
        <span class="truncation-banner-close" onclick="_hideTruncationBanner()" title="Dismiss">×</span>
    `;
    banner.style.display = 'flex';
    if (_truncTimer) clearTimeout(_truncTimer);
    _truncTimer = setTimeout(() => _hideTruncationBanner(), 5000);   // auto-dismiss
}
// Hide the banner (auto-dismiss timer, the × button, or a resolved shortfall).
// Does NOT reset _truncShown - so it stays dismissed for the rest of this
// episode and won't re-pop on the next poll. `resetEpisode` (passed only when
// the shortfall RESOLVES or the scope changes) re-arms it for a future episode.
function _hideTruncationBanner(resetEpisode) {
    if (_truncTimer) { clearTimeout(_truncTimer); _truncTimer = null; }
    const banner = document.getElementById('truncation-banner');
    if (banner) banner.style.display = 'none';
    if (resetEpisode === true) _truncShown = false;
}
// Expose for the close button + e2e spec to drive directly.
window._hideTruncationBanner = _hideTruncationBanner;

// Back-compat: legacy code paths that called _showFlashNotification
// now route through the new stack renderer. The old per-card centred
// flash element is no longer used.
function _showFlashNotification(n /* , sevColor */) {
    // No-op: notifications are now driven by _renderNotificationStack
    // via _addNotification. Kept as a stable entry point so any
    // out-of-tree caller that imported it doesn't ReferenceError.
}

function _renderNotifications() {
    const bell = document.getElementById('notif-bell');
    const countEl = document.getElementById('notif-count');
    const list = document.getElementById('notif-list');
    if (!bell || !countEl || !list) return;

    const unread = _notifUnread();
    const count = unread.length;

    // Bell badge = UNREAD count (read history does not light the bell).
    if (count > 0) {
        countEl.textContent = count > 99 ? '99+' : String(count);
        countEl.style.display = 'flex';
        bell.classList.add('has-new');
    } else {
        countEl.style.display = 'none';
        bell.classList.remove('has-new');
    }

    // Notify the global shell (crisp-shell.js) so the Home "new incidents"
    // alert + any other consumers stay in sync with this single source.
    try { window.dispatchEvent(new CustomEvent('crisp:notif-change')); } catch (_e) {}

    if (!_notifCenter.length) {
        list.innerHTML = '<div class="notif-empty"><i class="fa-solid fa-check-circle"></i> No incidents yet</div>';
        return;
    }

    // One card renderer for both unread + read history. Synthetic items
    // (session summary / urgent broadcast) carry a title/body and no incident.
    const card = (n) => {
        const sevColor = SEV_COLORS[n.severity] || (n.sevColor || '#64748b');
        const synthetic = String(n.id).startsWith('__');
        const cls = 'notif-card'
            + (n.cat === 'B' ? ' notif-card-important' : '')
            + (n.cat === 'C' ? ' notif-card-urgent' : '')
            + (n.read ? ' is-read' : '');
        const safeId = String(n.id).replace(/[^\w:-]/g, '');
        if (synthetic) {
            return `<div class="${cls}" onclick="openNotif('${safeId}')" style="border-left:3px solid ${sevColor};">
                <div class="notif-card-top">
                    <span class="notif-type"><i class="${n.srcBrand || 'fa-solid'} ${n.srcIcon || 'fa-bell'}"></i> ${escapeHtml(n.title || 'Update')}</span>
                </div>
                <div class="notif-loc">${escapeHtml(n.body || '')}</div>
                <div class="notif-time">${timeAgo(n.timestamp)}</div>
            </div>`;
        }
        return `<div class="${cls}" onclick="openNotif('${safeId}')" style="border-left:3px solid ${sevColor};">
            <div class="notif-card-top">
                <span class="notif-sev" style="background:${sevColor}20;color:${sevColor};">${n.severity}</span>
                <span class="notif-type">${escapeHtml(n.type)}</span>
                ${n.cat === 'B' ? '<span class="notif-impt-tag" title="Important">!</span>' : ''}
                <i class="${n.srcBrand} ${n.srcIcon}" style="color:#64748b;font-size:11px;" title="${escapeHtml(n.source)}"></i>
            </div>
            <div class="notif-loc"><i class="fa-solid fa-location-dot" style="color:${sevColor};"></i> ${escapeHtml(n.location)}</div>
            <div class="notif-op ${n.operation ? '' : 'global'}"><i class="fa-solid ${n.operation ? 'fa-folder-tree' : 'fa-earth-americas'}"></i> ${n.operation ? escapeHtml(n.operation) : 'Global'}</div>
            <div class="notif-time">${timeAgo(n.timestamp)}</div>
        </div>`;
    };

    const readItems = _notifCenter.filter(n => n.read);
    let html = '';
    if (count > 0) {
        html += `<div class="notif-sec-h">Unread <span>${count}</span></div>` + unread.map(card).join('');
    }
    if (readItems.length) {
        html += `<div class="notif-sec-h notif-sec-read">Earlier <span>${readItems.length}</span></div>` + readItems.map(card).join('');
    }
    list.innerHTML = html;
}

window.toggleNotifPanel = () => {
    const panel = document.getElementById('notif-panel');
    if (!panel) return;
    _notifPanelOpen = !_notifPanelOpen;
    panel.style.display = _notifPanelOpen ? 'block' : 'none';
};

// Open a notification: mark it READ (kept in history - never deleted), clear
// any live center-screen toast for it, close the panel, and open the incident
// inside its operation. Used for both unread + read-history cards (re-opening a
// read card is a no-op on read-state). Synthetic items (session summary /
// urgent broadcast) have no incident to open.
window.openNotif = (id) => {
    const n = _notifCenter.find(x => String(x.id) === String(id));
    if (n && !n.read) { n.read = true; _persistNotifCenter(); }
    // Clear the transient toast for this id if it's still on screen.
    _notificationStack = _notificationStack.filter(x => String(x.id) !== String(id));
    _renderNotificationStack();
    _refreshStackTimers();
    const panel = document.getElementById('notif-panel');
    if (panel) panel.style.display = 'none';
    _notifPanelOpen = false;
    _renderNotifications();
    if (n && String(n.id).startsWith('__')) return;   // synthetic - no incident
    window.openIncident(id, { operationId: n && n.crisisEventId, source: 'notification' });
};
// Back-compat: every existing caller / inline onclick that said dismissNotif
// now routes through the read-model handler.
window.dismissNotif = window.openNotif;

// "Mark all read": move every unread item to read (history retained, badge → 0).
// Does NOT delete - history stays available, satisfying the "notification
// history remains available" requirement.
window.clearAllNotifs = () => {
    let changed = false;
    _notifCenter.forEach(n => {
        if (!n.read) { n.read = true; changed = true; }
        _seenIds.add(n.id);   // defensive: keep the show-once gate consistent
    });
    if (changed) { _persistNotifCenter(); _persistSeenIds(); }
    _renderNotifications();
    // Keep the panel OPEN so the operator sees the items moved to "Earlier"
    // (the new value: history is retained, not wiped).
};

// "Clear" the read history: remove READ items only (anything still unread
// stays). Two-step by design - "Mark all read" then "Clear" fully empties.
window.clearNotifHistory = () => {
    _notifCenter = _notifCenter.filter(n => !n.read);
    _persistNotifCenter();
    _renderNotifications();
};

// ── Category C (Urgent) - persistent until acknowledged ─────────────────────
// A red banner that stays until the operator clicks Acknowledge. No
// auto-dismiss. Reserved for rare safety / outage / emergency broadcasts;
// there is NO automatic producer in v1 (the audit confirmed nothing in the
// report path is urgent). Ops tooling can raise one via
// window.crispUrgentBroadcast({ title, body }).
function _showUrgentBanner(item) {
    let banner = document.getElementById('notif-urgent-banner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'notif-urgent-banner';
        banner.className = 'notif-urgent-banner';
        document.body.appendChild(banner);
    }
    banner.innerHTML = `
        <i class="fa-solid fa-triangle-exclamation"></i>
        <div class="nub-text"><strong>${escapeHtml(item.title || 'Urgent')}</strong>${item.body ? ' &middot; ' + escapeHtml(item.body) : ''}</div>
        <button type="button" class="nub-ack">Acknowledge</button>
    `;
    banner.querySelector('.nub-ack').onclick = () => {
        item.acknowledged = true; item.read = true; _persistNotifCenter();
        banner.remove(); _renderNotifications();
    };
    banner.style.display = 'flex';
}
window.crispUrgentBroadcast = (opts) => {
    opts = opts || {};
    const item = {
        id: '__urgent_' + Date.now(),
        cat: 'C', read: false, acknowledged: false,
        title: opts.title || 'Urgent alert', body: opts.body || '',
        severity: 'CRITICAL', type: 'BROADCAST', location: opts.location || '',
        source: 'SYSTEM', srcIcon: 'fa-tower-broadcast', srcBrand: 'fa-solid',
        sevColor: '#ef4444', operation: null, crisisEventId: null,
        timestamp: new Date().toISOString(), addedAt: Date.now(), coalescedCount: 1,
    };
    _notifCenterAdd(item);
    _renderNotifications();
    _showUrgentBanner(item);
    return item.id;
};

// ── Session summary ("Since your last visit: +N reports …") ─────────────────
// Shown ONCE per browser session (sessionStorage guard - survives an in-session
// refresh, never re-fires on route change), comparing against a per-operator
// last-visit watermark. The replacement for replaying dozens of stale alerts.
function _visitWatermarkKey() { return _notifUserKey('crisp_last_visit_'); }
function _advanceVisitWatermark() {
    try { localStorage.setItem(_visitWatermarkKey(), new Date().toISOString()); } catch (_) {}
}
function _maybeShowSessionSummary() {
    let shown = false;
    try { shown = sessionStorage.getItem('crisp_notif_summary_shown') === '1'; } catch (_) {}
    if (shown) return;
    try { sessionStorage.setItem('crisp_notif_summary_shown', '1'); } catch (_) {}

    let watermark = null;
    try { watermark = localStorage.getItem(_visitWatermarkKey()); } catch (_) {}
    const wmMs = watermark ? Date.parse(watermark) : NaN;
    // First-ever visit on this profile (or unparseable) - set a baseline
    // silently; there is nothing to summarise yet.
    if (!wmMs) { _advanceVisitWatermark(); return; }

    // Count what arrived since the last visit, from the loaded working set.
    // (Approximation at extreme scale where the feed is windowed; strictly
    // better than replaying old toasts, and dependency-free.)
    const fresh = (allReports || []).filter(r => {
        const t = Date.parse(r && r.server_created_at);
        return t && t > wmMs;
    });
    const newCount = fresh.length;
    const critCount = fresh.filter(r => String(r.severity).toUpperCase() === 'CRITICAL').length;
    const opCount = new Set(fresh.map(r => r && r.crisis_event_id).filter(Boolean)).size;
    _advanceVisitWatermark();   // measure the NEXT visit from now
    if (newCount <= 0) return;  // nothing new - stay quiet

    const parts = [`+${newCount} new report${newCount === 1 ? '' : 's'}`];
    if (critCount > 0) parts.push(`+${critCount} critical`);
    if (opCount > 0) parts.push(`across ${opCount} operation${opCount === 1 ? '' : 's'}`);
    const msg = parts.join(' · ');

    // Record in the center so it's available later (Cat A, unread).
    _notifCenterAdd({
        id: '__session_' + Date.now(), cat: 'A', read: false, acknowledged: false,
        title: 'Since your last visit', body: msg,
        severity: critCount > 0 ? 'CRITICAL' : 'INFO', type: 'SUMMARY', location: '',
        source: 'SYSTEM', srcIcon: 'fa-clock-rotate-left', srcBrand: 'fa-solid',
        sevColor: critCount > 0 ? '#ef4444' : '#38bdf8', operation: null, crisisEventId: null,
        timestamp: new Date().toISOString(), addedAt: Date.now(), coalescedCount: 1,
    });
    _renderNotifications();
    _showSessionSummaryBanner(msg, critCount > 0);
}
function _showSessionSummaryBanner(msg, crit) {
    let banner = document.getElementById('notif-session-summary');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'notif-session-summary';
        banner.className = 'notif-session-summary';
        banner.onclick = () => { _hideSessionSummaryBanner(); window.toggleNotifPanel(); };
        document.body.appendChild(banner);
    }
    banner.classList.toggle('crit', !!crit);
    banner.innerHTML = `
        <i class="fa-solid fa-clock-rotate-left"></i>
        <div class="nss-text"><strong>Since your last visit</strong><span>${escapeHtml(msg)}</span></div>
        <span class="nss-hint">tap to review</span>
    `;
    banner.style.display = 'flex';
    if (banner._t) clearTimeout(banner._t);
    banner._t = setTimeout(() => _hideSessionSummaryBanner(), 5000);   // ~5s auto-dismiss
}
function _hideSessionSummaryBanner() {
    const b = document.getElementById('notif-session-summary');
    if (b) { if (b._t) clearTimeout(b._t); b.style.display = 'none'; }
}
// Advance the visit watermark when the operator leaves, so the next session
// measures "since your last visit" from this moment.
try { window.addEventListener('beforeunload', () => { try { _advanceVisitWatermark(); } catch (_) {} }); } catch (_) {}

// Open an incident's detail panel from ANYWHERE. The notification bell now
// lives in the global shell, so a click can arrive while the Operations view
// is hidden (Home / Exports / any overlay). Route to Operations first, then
// select once #view-incidents has mounted (brief rAF retry); if already there,
// select immediately.
// The single incident-open entry point now lives in crisp-nav.js (CrispNav).
// This alias keeps every existing caller working AND makes them deep-link +
// operation-aware: CrispNav.openIncident routes to the incident's operation
// (or global), writes #…?incident=<id>, opens the detail, highlights the row,
// and the router's restoreFromHash handles refresh / Back / Forward.
window.openIncident = (id, opts) => {
    if (!id) return;
    if (window.CrispNav && typeof window.CrispNav.openIncident === 'function') {
        window.CrispNav.openIncident(id, opts || {});
    } else if (typeof window.selectReport === 'function') {
        window.selectReport(id);   // pre-boot fallback
    }
};
// Read-only accessor onto the loaded report cache - CrispNav uses it to resolve
// an incident's operation (crisis_event_id) and to wait for the report to land.
window.__crispGetReport = (id) => {
    try { return (allReports || []).find((x) => x && x.id === id) || null; } catch (_e) { return null; }
};
// Test hook: number of markers currently plotted on the main map (the marker
// registry is rebuilt every render and is independent of cluster collapsing, so
// it's a stable assertion target for the C1-c scale test).
window.__crispMapMarkerCount = () => { try { return Object.keys(_markerById || {}).length; } catch (_e) { return 0; } };
// C1-d (Phase-0): lazily load a single report that is OUTSIDE the newest-N
// working set - an older marker click (the map now plots up to 20k lean points)
// or a deep-link at scale. Fetches GET /reports/{id}, merges it into the cache
// (so selectReport + the detail render + crisis_event_id resolution all work),
// and resolves the report (or null). Idempotent: returns the cached copy if
// already present, so it's safe to call on every open.
window.__crispEnsureReport = async (id) => {
    if (!id) return null;
    const cached = (allReports || []).find((x) => x && x.id === id);
    if (cached) return cached;
    try {
        const res = await fetch(`${API}/${encodeURIComponent(id)}`);   // auth via interceptor
        if (!res.ok) return null;
        const r = await res.json();
        if (r && r.id) {
            try { _applyReportData([r]); } catch (_e) { try { allReports.push(r); } catch (_e2) {} }
            return (allReports || []).find((x) => x && x.id === id) || r;
        }
    } catch (_e) {}
    return null;
};

// Single source of truth for the shell's Home alert (unread count + whether any
// unread incident is CRITICAL). Reads the same durable center the bell renders.
window.__crispNotifSummary = () => {
    const unread = _notifUnread();
    return {
        count: unread.length,
        critical: unread.some(n => String(n.severity).toUpperCase() === 'CRITICAL'),
    };
};

// Test hook (e2e): drive the REAL producer path deterministically without
// waiting for the 4s poll. `replace:true` routes through _replaceReportData
// (the full-refresh diff that EVICTS knownIds - the operation-scope-switch
// path that caused the replay bug); otherwise _applyReportData (the delta
// upsert). Lets specs assert show-once across a knownIds eviction.
window.__crispApplyReportsForTest = (arr, opts) => {
    try {
        if (opts && opts.replace) _replaceReportData(arr || []);
        else _applyReportData(arr || []);
        return true;
    } catch (e) { return String((e && e.message) || e); }
};

// Close panel when clicking outside
document.addEventListener('click', (e) => {
    if (_notifPanelOpen && !e.target.closest('.notif-area')) {
        const panel = document.getElementById('notif-panel');
        if (panel) panel.style.display = 'none';
        _notifPanelOpen = false;
    }
});

// ── Spatial Clustering (15km radius) ─────────────────────────────────────────
function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Clusters reports by proximity - reports within CLUSTER_RADIUS_KM share a region name
function clusterReportsByProximity(reports) {
    const clusters = []; // { center: {lat, lng}, name: string, reports: [] }
    const withLoc = reports.filter(r => r.location);
    const noLoc = reports.filter(r => !r.location);

    for (const r of withLoc) {
        const lat = r.location.latitude;
        const lng = r.location.longitude;
        let matched = null;

        for (const c of clusters) {
            if (haversineKm(lat, lng, c.center.lat, c.center.lng) <= CLUSTER_RADIUS_KM) {
                matched = c;
                break;
            }
        }

        if (matched) {
            matched.reports.push(r);
            // Update center to centroid
            const n = matched.reports.length;
            matched.center.lat = ((matched.center.lat * (n - 1)) + lat) / n;
            matched.center.lng = ((matched.center.lng * (n - 1)) + lng) / n;
        } else {
            clusters.push({ center: { lat, lng }, name: null, reports: [r] });
        }
    }
    return { clusters, noLoc };
}

// Assigns the best available region name to a cluster
function assignClusterName(cluster) {
    // Use the best geocoded name from any report in the cluster
    const names = cluster.reports
        .map(r => r._geo_city || r._geo_town || r._geo_suburb)
        .filter(Boolean);

    if (names.length > 0) {
        // Use most common name
        const freq = {};
        names.forEach(n => { freq[n] = (freq[n] || 0) + 1; });
        return Object.entries(freq).sort((a, b) => b[1] - a[1])[0][0];
    }

    // Fallback: use country + approximate coords
    const country = cluster.reports.find(r => r._country)?._country || 'Unknown';
    return `${country} Zone (${cluster.center.lat.toFixed(2)}, ${cluster.center.lng.toFixed(2)})`;
}

// Apply 15km clustering to all reports - sets r._region for each
function applyRegionClustering(reports) {
    const { clusters } = clusterReportsByProximity(reports);
    for (const c of clusters) {
        const name = assignClusterName(c);
        c.name = name;
        for (const r of c.reports) {
            r._cluster_region = name;
            // Only override _region if it's a fallback/generic name
            if (!r._region || r._region === 'Unknown Region' || r._region.endsWith('Strategy Zone')) {
                r._region = name;
            }
        }
    }
}

// ── Hierarchy Logic ──────────────────────────────────────────────────────────
function collectIncidents(data) {
    if (Array.isArray(data)) return data;
    return Object.values(data).flatMap(collectIncidents);
}

function calculateNodeMetrics(data) {
    const incidents = collectIncidents(data);
    const s = { p1: 0, p2: 0, p3: 0, total: incidents.length, latest: 0, impact: 0, infra: 0, confidence: 0, infraTypes: {} };
    incidents.forEach(r => {
        if (r.severity === 'CRITICAL' || r.severity === 'SEVERE') s.p1++;
        else if (r.severity === 'MODERATE') s.p2++;
        else s.p3++;
        const t = new Date(ensureUTC(r.server_created_at)).getTime();
        if (t > s.latest) s.latest = t;
        const sevScore = SEV_SCORE[r.severity] || 1;
        const infraWeight = INFRA_WEIGHTS[r.infrastructure_type] || 1;
        s.impact += sevScore * infraWeight;
        if (infraWeight > 2) s.infra++;
        const itype = r.infrastructure_type || 'OTHER';
        s.infraTypes[itype] = (s.infraTypes[itype] || 0) + 1;
    });
    // Confidence: based on report density and spatial clustering
    if (s.total > 0) {
        const densityBonus = Math.min(s.total * 10, 40);
        const severityBonus = Math.min((s.p1 * 15 + s.p2 * 5), 35);
        const recentBonus = (Date.now() - s.latest < 3600000) ? 25 : (Date.now() - s.latest < 86400000) ? 15 : 5;
        s.confidence = Math.min(densityBonus + severityBonus + recentBonus, 100);
    }
    return s;
}

function buildControlPanelTree(reports) {
    // Flat 2-level tree: Region → Type → Incidents[]
    const tree = {};
    reports.forEach(r => {
        const region = r._region || r._country || r.location?.user_location_name || r.location?.device_location_name || 'Unknown';
        const country = r._country || '';
        const label = country && country !== region ? `${region}, ${country}` : region;
        const type = r.infrastructure_type || 'OTHER';

        if (!tree[label]) tree[label] = {};
        if (!tree[label][type]) tree[label][type] = [];
        tree[label][type].push(r);
    });
    return tree;
}

function getTopHotspots(reports, count = 5) {
    // Group by region, score, return top N
    const regionMap = {};
    reports.forEach(r => {
        const key = `${r._country || 'Unknown'}|${r._region || 'Unknown'}`;
        if (!regionMap[key]) regionMap[key] = { country: r._country || 'Unknown', region: r._region || 'Unknown', continent: r._continent_code, incidents: [] };
        regionMap[key].incidents.push(r);
    });
    return Object.values(regionMap)
        .map(g => ({ ...g, metrics: calculateNodeMetrics(g.incidents) }))
        .sort((a, b) => b.metrics.impact - a.metrics.impact)
        .slice(0, count);
}

function sortNodes(keys, data) {
    return keys.sort((a, b) => {
        const ma = calculateNodeMetrics(data[a]);
        const mb = calculateNodeMetrics(data[b]);
        if (sortMode === 'recent') return mb.latest - ma.latest;
        if (sortMode === 'infra') return mb.infra - ma.infra || mb.impact - ma.impact;
        if (sortMode === 'density') return mb.total - ma.total || mb.impact - ma.impact;
        return mb.impact - ma.impact; // default: impact
    });
}

// ── UI Rendering ─────────────────────────────────────────────────────────────
function metricsHTML(stats, compact = false) {
    const urgency = stats.total > 0 ? (stats.impact / stats.total > 25 ? 'HIGH' : stats.impact / stats.total > 10 ? 'MEDIUM' : 'LOW') : 'LOW';
    const latestStr = stats.latest ? timeAgo(new Date(stats.latest).toISOString()) : '';

    if (compact) {
        return `
            <div class="tree-metrics">
                ${stats.p1 > 0 ? `<span class="m-badge p1" title="Critical/Severe">${stats.p1}</span>` : ''}
                ${stats.p2 > 0 ? `<span class="m-badge p2" title="Moderate">${stats.p2}</span>` : ''}
                <span class="m-badge total" title="Total incidents">${stats.total}</span>
                ${stats.confidence > 0 ? `<span class="m-conf" title="Confidence">${stats.confidence}%</span>` : ''}
            </div>`;
    }
    return `
        <div class="tree-metrics">
            ${stats.p1 > 0 ? `<span class="m-badge p1" title="Critical/Severe incidents">🔴 ${stats.p1}</span>` : ''}
            ${stats.p2 > 0 ? `<span class="m-badge p2" title="Moderate incidents">🟠 ${stats.p2}</span>` : ''}
            ${stats.p3 > 0 ? `<span class="m-badge p3" title="Low severity">🟡 ${stats.p3}</span>` : ''}
            <span class="m-badge total" title="Total incidents">📍 ${stats.total}</span>
            ${stats.infra > 0 ? `<span class="m-badge infra" title="Critical infrastructure impacted">🏥 ${stats.infra}</span>` : ''}
            ${stats.confidence > 0 ? `<span class="m-conf" title="Confidence score">${stats.confidence}%</span>` : ''}
            ${latestStr ? `<span class="m-time" title="Latest report">⏱ ${latestStr}</span>` : ''}
            <span class="m-score urgency-${urgency}" title="Urgency">${urgency}</span>
        </div>`;
}

function quickActionsHTML(path, level) {
    const isPriority = priorityZones.has(path);
    return `
        <div class="tree-actions">
            <button class="a-btn" onclick="event.stopPropagation(); focusMapOnNode('${path}')" title="View on Map"><i class="fa-solid fa-crosshairs"></i></button>
            <button class="a-btn" onclick="event.stopPropagation(); exportNodeData('${path}')" title="Export Data"><i class="fa-solid fa-file-export"></i></button>
            <button class="a-btn ${isPriority ? 'a-btn-active' : ''}" onclick="event.stopPropagation(); togglePriorityZone('${path}')" title="${isPriority ? 'Remove Priority' : 'Mark Priority Zone'}"><i class="fa-solid fa-flag"></i></button>
        </div>`;
}

function getLevelIcon(levelName, label) {
    const LEVEL_ICONS = {
        continent: { icon: 'fa-earth-americas', tooltip: 'Continent' },
        country: { icon: 'fa-flag', tooltip: 'Country' },
        region: { icon: 'fa-map-location-dot', tooltip: 'Region' },
        type: { icon: INFRA_ICONS[label] || 'fa-triangle-exclamation', tooltip: `Infrastructure: ${label}` },
        severity: { icon: 'fa-gauge-high', tooltip: `Severity: ${label}` },
        status: { icon: 'fa-circle-check', tooltip: `Status: ${label}` }
    };
    const entry = LEVEL_ICONS[levelName] || { icon: 'fa-folder', tooltip: levelName };
    return `<i class="fa-solid ${entry.icon} tree-level-icon" title="${entry.tooltip}"></i>`;
}

function createTreeHeader(label, stats, levelName, path, isExpanded) {
    const div = document.createElement('div');
    div.className = `tree-header level-${levelName}-header ${isExpanded ? 'expanded' : ''}`;
    const isPriority = priorityZones.has(path);

    const useCompact = ['type', 'severity', 'status'].includes(levelName);

    const sevDots = stats.p1 > 0
        ? `<span class="tv-sev-dots">${'🔴'.repeat(Math.min(stats.p1, 3))}${stats.p1 > 3 ? '+' + (stats.p1-3) : ''}</span>`
        : '';

    div.innerHTML = `
        <span class="chevron" title="Expand/Collapse"><i class="fa-solid fa-chevron-right"></i></span>
        ${getLevelIcon(levelName, label)}
        <span class="tree-label">${label}</span>
        <span class="tv-count">${stats.total}</span>
        ${sevDots}
    `;

    div.onclick = (e) => {
        e.stopPropagation();
        toggleTreeNode(path);
    };
    return div;
}

function renderTreeLevel(parentEl, data, levelIndex, currentPath) {
    // Flat 2-level: region (0) → type (1) → incidents
    const levels = ['region', 'type'];
    const levelName = levels[levelIndex];
    if (!levelName) return;

    const keys = Object.keys(data).sort((a, b) => {
        const sa = collectIncidents(data[a]);
        const sb = collectIncidents(data[b]);
        // Sort by critical count desc, then total desc
        const pa = sa.filter(r => r.severity === 'CRITICAL' || r.severity === 'SEVERE').length;
        const pb = sb.filter(r => r.severity === 'CRITICAL' || r.severity === 'SEVERE').length;
        if (pb !== pa) return pb - pa;
        return sb.length - sa.length;
    });

    keys.forEach(key => {
        const path = currentPath ? `${currentPath}|${key}` : key;
        if (treeState[path] === undefined) treeState[path] = levelIndex === 0; // regions expanded by default
        const expanded = !!treeState[path];
        const stats = calculateNodeMetrics(data[key]);

        const node = document.createElement('div');
        node.className = `tree-node level-${levelName}`;
        node.appendChild(createTreeHeader(key, stats, levelName, path, expanded));

        if (expanded) {
            const content = document.createElement('div');
            content.className = 'tree-content';

            if (levelIndex < levels.length - 1) {
                renderTreeLevel(content, data[key], levelIndex + 1, path);
            } else {
                // Leaf: render incident rows with inline actions
                const incidents = Array.isArray(data[key]) ? data[key] : collectIncidents(data[key]);
                incidents.sort((a, b) => {
                    const sa = SEV_PRIORITY[b.severity] || 0;
                    const sb = SEV_PRIORITY[a.severity] || 0;
                    return sa !== sb ? sa - sb : new Date(b.server_created_at) - new Date(a.server_created_at);
                });
                incidents.forEach(r => content.appendChild(createIncidentRow(r)));
            }
            node.appendChild(content);
        }
        parentEl.appendChild(node);
    });
}

function createIncidentRow(r) {
    const inc = document.createElement('div');
    inc.className = `tree-incident ${selectedId === r.id ? 'selected' : ''}`;
    inc.dataset.id = r.id;   // for CrispNav.markSelected highlight/scroll
    // Route through the unified helper → deep-links + opens inside the incident's
    // operation (or global) instead of bare selectReport.
    inc.onclick = (e) => { if (e.target.closest('.tv-act')) return; window.openIncident(r.id); };

    const desc = (r.ai_analysis?.ai_summary || r.description || r.ai_analysis?.transcription || '').substring(0, 35);
    const sevColor = SEV_COLORS[r.severity] || '#64748b';
    const srcIcon = {APP:'fa-mobile-screen-button',ANDROID:'fa-robot',WHATSAPP:'fa-whatsapp',TELEGRAM:'fa-telegram',SMS:'fa-comment-sms',IVR:'fa-phone'}[r.source] || 'fa-mobile-screen-button';
    const srcClass = {APP:'qrt-src-app',WHATSAPP:'qrt-src-whatsapp',TELEGRAM:'qrt-src-telegram',SMS:'qrt-src-sms',IVR:'qrt-src-ivr'}[r.source] || 'qrt-src-app';
    const srcBrand = ['WHATSAPP','TELEGRAM'].includes(r.source) ? 'fa-brands' : 'fa-solid';

    const _ds = _displayStatus(r);
    const _verdict = r.reviewer_verdict || 'NOT_REVIEWED';
    const _isOpen = (r.status === 'PENDING' || r.status === 'VERIFIED') && _verdict !== 'REJECTED';
    inc.innerHTML = `
        <span class="inc-sev-dot sev-dot-${r.severity}"></span>
        <span class="tv-status st-${_ds.cls}" title="${_ds.title}">${_ds.label}</span>
        <span class="tv-desc" title="${(r.description || '').replace(/"/g, '&quot;')}">${desc || 'No description'}</span>
        <span class="tv-meta">
            <span class="tv-time">${timeAgo(r.server_created_at)}</span>
            ${_confidenceChip(r)}
            <span class="qrt-source-badge ${srcClass}" title="${r.source}"><i class="${srcBrand} ${srcIcon}"></i></span>
        </span>
        <span class="tv-actions">
            ${_isOpen ? `<button class="tv-act tv-act-dispatch" onclick="event.stopPropagation();patchReport('${r.id}','dispatch')" title="Notify Responders"><i class="fa-solid fa-bell-concierge"></i></button>` : ''}
            ${r.status !== 'FALSE_ALARM' ? `<button class="tv-act tv-act-false" onclick="event.stopPropagation();patchReport('${r.id}','false-alarm')" title="False Alarm"><i class="fa-solid fa-ban"></i></button>` : ''}
            <button class="tv-act tv-act-delete" onclick="event.stopPropagation();if(confirm('Delete?'))deleteReport('${r.id}')" title="Delete"><i class="fa-solid fa-trash"></i></button>
        </span>
    `;

    inc.onmouseenter = () => _armIncidentPreview(r, inc);
    inc.onmouseleave = _disarmIncidentPreview;
    return inc;
}

function renderHotspots(parentEl, reports) {
    const hotspots = getTopHotspots(reports);
    if (hotspots.length === 0) return;

    const section = document.createElement('div');
    section.className = 'level-hotspots';

    const header = document.createElement('div');
    header.className = 'tree-header hotspot-header';
    header.innerHTML = `
        <i class="fa-solid fa-fire text-critical" title="Global Hotspots"></i>
        <span class="tree-label">TOP ${hotspots.length} GLOBAL HOTSPOTS</span>
        <span class="m-badge p1" title="Critical/Severe incidents">${hotspots.reduce((s, h) => s + h.metrics.p1, 0)}</span>
    `;
    section.appendChild(header);

    const content = document.createElement('div');
    content.className = 'tree-content hotspot-content';

    hotspots.forEach((h, i) => {
        const item = document.createElement('div');
        item.className = 'hotspot-item';
        item.onclick = () => {
            const incs = h.incidents.filter(r => r.location);
            if (incs.length > 0) {
                const bounds = L.latLngBounds(incs.map(r => [r.location.latitude, r.location.longitude]));
                map.flyToBounds(bounds, { padding: [50, 50], maxZoom: 12 });
            }
        };
        item.innerHTML = `
            <div class="hotspot-rank">#${i + 1}</div>
            <div class="hotspot-info">
                <div class="hotspot-name">${h.region}, ${h.country}</div>
                <div class="hotspot-stats">
                    ${h.metrics.p1 > 0 ? `<span class="m-badge p1" title="Critical/Severe incidents">${h.metrics.p1}</span>` : ''}
                    ${h.metrics.p2 > 0 ? `<span class="m-badge p2" title="Moderate incidents">${h.metrics.p2}</span>` : ''}
                    <span class="m-badge total" title="Total incidents">${h.metrics.total}</span>
                    <span class="m-score urgency-${h.metrics.impact / h.metrics.total > 25 ? 'HIGH' : h.metrics.impact / h.metrics.total > 10 ? 'MEDIUM' : 'LOW'}" title="Impact score">
                        Score: ${Math.round(h.metrics.impact)}
                    </span>
                    <span class="m-conf" title="Confidence score">${h.metrics.confidence}%</span>
                </div>
            </div>
            <div class="hotspot-actions">
                <button class="a-btn" onclick="event.stopPropagation(); exportNodeDataFromIncidents(${JSON.stringify(h.incidents.map(r => r.id))})" title="Export"><i class="fa-solid fa-file-export"></i></button>
            </div>
        `;
        content.appendChild(item);
    });

    section.appendChild(content);
    parentEl.appendChild(section);
}

// v116: feed density (Comfortable default ↔ Compact). Mirrors the Operations-registry
// crisp_ops_density pattern. Compact is a CSS-driven dense variant of the SAME card
// (#report-feed-list.feed-compact) - the renderer + actions are unchanged, so the
// accordion/console wiring is untouched. Persisted per operator.
let _feedDensity = 'comfortable';
try { if (localStorage.getItem('crisp_feed_density') === 'compact') _feedDensity = 'compact'; } catch (_e) {}
function _applyFeedDensity() {
    const compact = _feedDensity === 'compact';
    const list = document.getElementById('report-feed-list');
    if (list) list.classList.toggle('feed-compact', compact);
    const btn = document.getElementById('feed-density');
    if (btn) {
        btn.classList.toggle('on', compact);
        btn.setAttribute('aria-pressed', compact ? 'true' : 'false');
        const ic = btn.querySelector('i');
        if (ic) ic.className = compact ? 'fa-solid fa-table-cells' : 'fa-solid fa-table-cells-large';
        btn.title = compact ? window.t('density_comfortable', 'Comfortable view') : window.t('density_compact', 'Compact view');
    }
}
window.setFeedDensity = function (mode) {
    _feedDensity = (mode === 'compact') ? 'compact' : 'comfortable';
    try { localStorage.setItem('crisp_feed_density', _feedDensity); } catch (_e) {}
    _applyFeedDensity();
};
window.toggleFeedDensity = function () {
    window.setFeedDensity(_feedDensity === 'compact' ? 'comfortable' : 'compact');
};

function renderFeed() {
    _renderContextBanner();   // context banner ALWAYS renders first - the scope is visible before any list
    try { _syncFilterActiveCount(); } catch (_e) {}   // collapsed Filters label shows the active-filter count
    const el = document.getElementById('report-feed-list');
    if (!el) return;
    try { _applyFeedDensity(); } catch (_e) {}   // keep density class + toggle button in sync
    // The scoped/global LIST fetch is in flight → show a real "Loading Operation
    // Incidents…" placeholder instead of the (misleading) empty state, a stale
    // list, or the partial single incident that the by-id lazy fetch may have
    // merged in. `_scopeLoading` is set by setOperationScope() / boot and cleared
    // ONLY when the LIST fetchReports() applies data (NOT by a by-id merge), so it
    // stays up until the full operation dataset arrives.
    if (_scopeLoading) {
        el.innerHTML = _loadingFeedHtml();
        updateCommandStats();
        return;
    }
    // P2 single-page consolidation: the OPERATIONS REGISTRY (the #/operations route) is
    // now the top level of the tree, rendered here in the feed panel (no separate
    // overlay) — operations → buildings → incidents, each op opening in the right panel.
    if (_opsRegMode) {
        renderOperationsRegistry(el);
        return;
    }
    // Attention-card destination (GLOBAL feed + a category, no op/building/triage
    // scope): group the matching incidents by Operation → Building so the operator
    // sees the Global → Operation → Building → Incident hierarchy in-page (Jun 2026
    // nav-clarity). Headers drill the scope. Cards stay createIncidentCard, so the
    // flat-feed contracts (data-report-id, counts) hold.
    if (_activeQueue && !_activeCrisisEventId && !_activeBuildingId && !_triageScope) {
        renderOperationGroupedFeed(el);
    } else {
        // The feed is ALWAYS building-grouped now (the Buildings/All-Incidents view
        // toggle was retired); the active status TAB narrows it to a lifecycle bucket.
        renderClusterFeed(el);
    }
    updateCommandStats();
    // Per-building dup-count badges: refresh AFTER the building rows render so the
    // cache fast-path paints onto the fresh slots (the async fetch repaints on land).
    try { _refreshDupReviewMap(); } catch (_e) {}
    try { _syncStatusTabsEnabled(); } catch (_e) {}   // neutralize tabs when a queue owns the population
    // No progressive-reveal pass: every path is a set of collapsed cluster sections
    // (cheap), and progressive-hiding cards across collapsed bodies would fight
    // expansion. (Was applied only to the now-retired flat queue.)
}

// ── Clusters Mode (opt-in) ────────────────────────────────────────────────────
// Group reports into Building/Location incident clusters so the analyst sees ONE
// operational problem, not N report cards. Cluster key precedence:
//   building_id  →  h3 cell (~175 m)  →  the report itself (singleton)
// so NOTHING ever disappears from the feed. Read-time aggregation over the loaded
// working set; clusters collapsed by default, expand for the evidence (reports).
const _CC_SEV_RANK = { CRITICAL: 4, SEVERE: 3, MODERATE: 2, MINOR: 1, UNKNOWN: 0 };
// Which clusters the operator has expanded - persisted across feed re-renders
// (polls) so new data never re-collapses an open cluster. Keyed by cluster key.
const _expandedClusters = new Set();

function _ensureClusterStyles() {
    if (document.getElementById('cc-cluster-styles')) return;
    const s = document.createElement('style');
    s.id = 'cc-cluster-styles';
    // The building feed is the Operation→Building→Incident tree MINUS the operation
    // level: Building (teal, level B) → Incident (slate leaf, level C). Same connector
    // rail + elbow + colours as the op tree so the two feeds read identically. (The
    // .opg-toolbar / .opg-inc styles come from _ensureOpGroupStyles, also injected by
    // renderClusterFeed.)
    s.textContent = `
      .cc-cluster{margin:0 0 3px}
      /* Building header ROW: scope the no-border override here (the base
         .qrt-section-header border-bottom is shared by other feed renderers). */
      .cc-cluster .qrt-section-header{display:flex;align-items:center;gap:6px;cursor:pointer;border-radius:6px;border-bottom:none;padding:3px 4px}
      .cc-cluster .qrt-section-header:hover{background:rgba(255,255,255,.03)}
      .cc-cluster .qrt-section-chevron{flex:none;width:11px;text-align:center;color:#5f9d92;font-size:10px}
      .cc-cluster-sev{width:9px;height:9px;border-radius:50%;flex:none}
      .cc-cluster-main{flex:1;min-width:0}
      /* Building level = TEAL font (operator request). No bg/border on the row. */
      .cc-cluster-title{font-weight:700;font-size:12.5px;color:#2dd4bf;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cc-cluster-name-link{cursor:pointer}
      .cc-cluster-name-link:hover{color:#e6f6f2;text-decoration:underline}
      .cc-cluster-meta{font-size:11px;color:#9fb3d1;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .cc-cluster-meta b{color:#f87171}
      /* merged-duplicate indicator (neutral): the count of corroborating reports
         already collapsed under their primary — replaces the old "· M reports". */
      .cc-cluster-mergedup{color:#93a3b8}
      .cc-cluster-mergedup i{font-size:9px;margin-right:2px}
      .cc-cluster-single .cc-cluster-title{font-weight:500;color:#cbd9ef}
      .cc-cluster .qrt-section-count{background:none;border:none;color:#2dd4bf;font-weight:800}
      /* ONE connector method: building (teal) -> incidents, identical to .opg-bldg-body. */
      .cc-cluster .qrt-section-body{margin:1px 0 6px 12px;padding-left:12px;border-left:1.5px solid rgba(45,212,191,.34);
        display:flex;flex-direction:column;gap:7px}
      .cc-cluster .qrt-section-body > .opg-inc > .qrt-card{margin:0}
      .cc-cluster-open{flex:none;background:none;border:none;color:#9fb3d1;cursor:pointer;padding:4px 6px;border-radius:6px;font-size:12px}
      .cc-cluster-open:hover{background:rgba(148,163,184,.16);color:#e6eefb}
      /* candidate-pair badge (possible duplicates still to review) — neutralised
         off sky-blue so it isn't read as an incident/report count. */
      .cc-cluster-dup{flex:none;display:inline-flex;align-items:center;gap:4px;background:rgba(148,163,184,.12);
        border:none;color:#93a3b8;border-radius:999px;padding:2px 9px;
        font-size:10.5px;font-weight:700;white-space:nowrap;cursor:pointer}
      .cc-cluster-dup:hover{background:rgba(148,163,184,.2)}
      .cc-cluster-dup i{font-size:9px}`;
    document.head.appendChild(s);
}

function _clusterKey(r) {
    if (r.building_id) return 'b:' + r.building_id;
    const h = r.location && r.location.h3_idx;
    if (h) return 'h3:' + h;
    return 'r:' + r.id;   // singleton - ungroupable report still gets its own card
}
function _reportAreaName(r) {
    const l = r && r.location;
    return ((l && (l.user_location_name || l.device_location_name)) || '').trim();
}
// A building's display name = the building TAG the reporter selected (the OSM
// footprint, carried as infrastructure_name) disambiguated with the area, e.g.
// "DoubleTree Hotel · Koramangala". NEVER the infrastructure_type ("what was hit")
// - that is a category, not a building (the source of the "Commercial / Government /
// Transport communication" mis-naming). Falls back to the area alone, then coords.
function _buildingDisplayName(rs) {
    const arr = Array.isArray(rs) ? rs : [rs];
    let name = '';
    // OSM building name ONLY (_taggedBuildingName) - a free-text "what was hit" answer
    // (infrastructure_name_from_osm === false) must never become the building/cluster
    // name; such rows fall through to the area / coords label below.
    for (const r of arr) { if (_taggedBuildingName(r)) { const n = String(r.infrastructure_name).trim(); if (n) { name = n; break; } } }
    let area = '';
    for (const r of arr) { const a = _reportAreaName(r); if (a) { area = a; break; } }
    if (name && area) {
        const nl = name.toLowerCase(), al = area.toLowerCase();
        return (nl !== al && !al.startsWith(nl)) ? (name + ' · ' + area) : name;
    }
    if (name) return name;
    if (area) return area;
    const r0 = arr.find((r) => r && r.location && r.location.latitude != null);
    if (r0) return 'Building at ' + Number(r0.location.latitude).toFixed(3) + ', ' + Number(r0.location.longitude).toFixed(3);
    return 'Unnamed building';
}
// The cluster name IS the building display name (building clusters only; the
// ungrouped bucket sets its own label in _clusterSummary).
function _clusterName(rs) { return _buildingDisplayName(rs); }
function _clusterSummary(key, rs) {
    let maxRank = 0, maxSev = 'UNKNOWN', critical = 0, newCount = 0, lastActivity = 0, totalReports = 0;
    let opId = null;
    const now = Date.now();
    for (const r of rs) {
        const sev = String(r.severity || 'UNKNOWN').toUpperCase();
        const rank = _CC_SEV_RANK[sev] || 0;
        if (rank > maxRank) { maxRank = rank; maxSev = sev; }
        if (sev === 'CRITICAL') critical++;
        const t = Date.parse(r.server_created_at) || 0;
        if (t > lastActivity) lastActivity = t;
        if (t && now - t < 24 * 3600 * 1000) newCount++;
        // total reports = each visible incident + its merged corroborating reports.
        totalReports += 1 + (r.duplicate_count || 0);
        // operation tag: the dominant (first non-null) crisis_event_id — used to group
        // buildings under their Operation in the GLOBAL feed (Operation→Building→Incident).
        if (!opId && r.crisis_event_id) opId = r.crisis_event_id;
    }
    const ungrouped = key === 'ungrouped';
    // count = distinct INCIDENT units in this building (Building → Incident → Report);
    // reportCount = the raw report volume (used by the ungrouped "to map" message).
    return { key, reports: rs, count: _distinctIncidents(rs), reportCount: rs.length, totalReports,
             maxRank, maxSev, critical, newCount,
             lastActivity, opId,
             name: ungrouped ? 'Needs mapping · Ungrouped reports' : _clusterName(rs),
             singleton: !ungrouped && key.charAt(0) === 'r',
             buildingId: key.charAt(0) === 'b' ? key.slice(2) : null,
             ungrouped };
}
function _renderClusterCard(c, forceOpen) {
    const sec = document.createElement('div');
    // forceOpen (building/triage/queue scope) expands the card for THIS render only.
    // It must NOT be written into the persistent _expandedClusters Set, or every
    // building would stay expanded in every later view (the "clicking one incident
    // expands everything" bug — a stale force-open leaked into the global/op feed).
    const expanded = !!forceOpen || _expandedClusters.has(c.key);
    // v116: the OPEN building card gets a teal "active" ring because it is mirrored in
    // the Building Console on the right (single-open accordion ↔ one console).
    const _active = expanded && !!c.buildingId;
    sec.className = 'qrt-section cc-cluster' + (expanded ? '' : ' collapsed') + (c.singleton ? ' cc-cluster-single' : '') + (_active ? ' cc-cluster-active' : '');
    sec.dataset.clusterKey = c.key;
    const color = SEV_COLORS[c.maxSev] || SEV_COLORS.UNKNOWN;
    // Building count = distinct INCIDENT units (real incidents table, grouped by
    // incident_id). The corroborating reports per incident now live under each
    // incident card's "N reports" expander, so the building header is a single clean
    // "N incidents" (the v132 "· M duplicates" chip is superseded by that model).
    const _inc = c.count;
    const bits = [ c.ungrouped
        ? `${c.reportCount} report${c.reportCount !== 1 ? 's' : ''} to map`
        : `${_inc} incident${_inc !== 1 ? 's' : ''}` ];
    if (c.critical) bits.push(`<b>${c.critical} critical</b>`);
    if (c.newCount) bits.push(`${c.newCount} new`);
    bits.push(timeAgo(new Date(c.lastActivity || Date.now()).toISOString()));
    const header = document.createElement('div');
    header.className = 'qrt-section-header';
    // Tree-consistent gestures (matches the Operation→Building→Incident tree): the
    // chevron / header row TOGGLES the building's incidents inline (multi-open, so
    // Expand-all / Collapse-all work); the building NAME opens its Building Console on
    // the right. h3 / singleton / ungrouped clusters have no console — name is plain.
    const _nameLink = !!c.buildingId;
    const _titleInner = `<div class="cc-cluster-title${_nameLink ? ' cc-cluster-name-link' : ''}"${_nameLink ? ' role="button" tabindex="0" title="Open the building console"' : ''}>${escapeHtml(c.name)}</div>`;
    // Per-building duplicate-count badge (filled async by _paintDupBadges from
    // /buildings-needing-review). Clicking it opens the building console where the
    // Potential-Duplicates merge controls live.
    const _dupSlot = c.buildingId
        ? `<span class="cc-cluster-dup" data-dup-bld="${escapeHtml(c.buildingId)}" style="display:none"></span>`
        : '';
    header.innerHTML =
        `<i class="fa-solid fa-chevron-down qrt-section-chevron"></i>` +
        `<span class="cc-cluster-sev" style="background:${color}"></span>` +
        `<div class="cc-cluster-main">${_titleInner}` +
        `<div class="cc-cluster-meta">${bits.join(' · ')}</div></div>` +
        _dupSlot +
        `<span class="qrt-section-count">${c.count}</span>`;
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    header.setAttribute('aria-label', (expanded ? 'Collapse ' : 'Expand ') + (c.name || 'building') + ' incidents');
    // Toggle this building's incidents (multi-open — does NOT touch other buildings).
    const _toggleCluster = () => {
        // Read the VISUAL state (not just the Set) so a force-opened card (expanded for
        // the render but not in _expandedClusters) still collapses on the first click.
        const wasOpen = !sec.classList.contains('collapsed');
        if (wasOpen) { _expandedClusters.delete(c.key); sec.classList.add('collapsed'); header.setAttribute('aria-expanded', 'false'); }
        else { _expandedClusters.add(c.key); sec.classList.remove('collapsed'); header.setAttribute('aria-expanded', 'true'); }
    };
    // Open the building console (the drill-in action). Ensures the building is expanded
    // and is the single "active" one mirrored by the console on the right.
    const _openConsole = () => {
        if (!c.buildingId) { _toggleCluster(); return; }
        _expandedClusters.add(c.key);
        sec.classList.remove('collapsed');
        header.setAttribute('aria-expanded', 'true');
        const list = sec.parentElement;
        if (list) list.querySelectorAll('.cc-cluster.cc-cluster-active').forEach((o) => { if (o !== sec) o.classList.remove('cc-cluster-active'); });
        sec.classList.add('cc-cluster-active');
        if (window.openBuildingConsole) { try { window.openBuildingConsole(c.buildingId); } catch (_e) {} }
    };
    header.addEventListener('click', _toggleCluster);
    header.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _toggleCluster(); }
    });
    sec.appendChild(header);
    if (_nameLink) {
        const nameEl = header.querySelector('.cc-cluster-name-link');
        if (nameEl) {
            nameEl.addEventListener('click', (e) => { e.stopPropagation(); _openConsole(); });
            nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); _openConsole(); } });
        }
    }
    const body = document.createElement('div');
    body.className = 'qrt-section-body';
    // Cards within a building honour the active sort mode (the sort icon in the
    // tabs row). Each is wrapped in .opg-inc — the SAME slate-elbow leaf component the
    // operation tree uses — so the building->incident connector matches everywhere.
    _groupByIncident(c.reports.slice().sort(getSortFunction())).forEach((members) => {
        body.appendChild(_renderIncidentGroup(members));
    });
    sec.appendChild(body);
    return sec;
}

// ── Incident grouping (Building → Incident → Report) ──────────────────────────
// The feed stays REPORT-sourced (so map/search/filters/export/status are
// untouched), but reports are grouped into the first-class INCIDENT entity by the
// server-assigned r.incident_id (a report with incident_id NULL — the best-effort
// auto-assign fallback — becomes its own singleton). First-seen order is preserved
// so the active sort drives both the lead report and the group order.
function _groupByIncident(reports) {
    const order = [];
    const groups = new Map();
    for (const r of (reports || [])) {
        const k = (r && r.incident_id) || ('r:' + (r && r.id));
        if (!groups.has(k)) { groups.set(k, []); order.push(k); }
        groups.get(k).push(r);
    }
    return order.map((k) => groups.get(k));
}
// Count of distinct incident UNITS among loaded reports (= what the feed renders):
// distinct incident_id + each incident-less report as its own singleton. Matches the
// server banner count (analytics counts.incidents) by construction.
function _distinctIncidents(reports) {
    const s = new Set();
    for (const r of (reports || [])) s.add((r && r.incident_id) || ('r:' + (r && r.id)));
    return s.size;
}
// Render ONE incident as a feed unit. A single-report incident renders exactly like
// today (the ≈1:1 common case — no visual change). A multi-report incident renders
// ONE card led by the first member, with an "N reports" expander that reveals the
// member reports nested + dimmed (subsumes the v132 confirmed-duplicate expander —
// incident_id ⊇ confirmed-dups). N = the authoritative report_count incl. the
// confirmed-duplicate members collapsed under each visible member.
function _renderIncidentGroup(members) {
    const inc = document.createElement('div');
    inc.className = 'opg-inc';
    const lead = members[0];
    const reportCount = members.reduce((n, m) => n + 1 + ((m && m.duplicate_count) || 0), 0);
    if (reportCount <= 1) { inc.appendChild(createIncidentCard(lead)); return inc; }
    inc.appendChild(createIncidentCard(lead, { incidentId: (lead && lead.incident_id) || null, reportCount, members }));
    return inc;
}
// The neutral "N reports" expander chip the lead card of a multi-report incident
// wears (replaces _dupMergedBadge for grouped cards). Opens the member reports
// inline via toggleIncidentMembers.
function _incidentExpander(r, ctx) {
    const n = ctx.reportCount;
    const incId = ctx.incidentId;
    const idAttr = incId ? `data-inc="${escapeAttr(incId)}"` : `data-rep="${escapeAttr(r.id)}"`;
    const args = incId
        ? `decodeURIComponent('${encodeURIComponent(incId)}'),null`
        : `null,decodeURIComponent('${encodeURIComponent(r.id)}')`;
    const base = 'display:inline-flex;align-items:center;gap:4px;background:rgba(148,163,184,.12);color:#93a3b8;border:none;border-radius:6px;padding:2px 7px;font-size:11px;font-weight:600;cursor:pointer';
    return `<span class="qrt-dup-merged" role="button" tabindex="0" aria-expanded="false" ${idAttr}`
        + ` title="${n} reports corroborate this incident · click to show them"`
        + ` onclick="event.stopPropagation();window.toggleIncidentMembers(${args},this)"`
        + ` onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();window.toggleIncidentMembers(${args},this);}"`
        + ` style="${base}"><i class="fa-solid fa-layer-group"></i> ${n} reports <i class="fa-solid fa-chevron-down qrt-dup-twist"></i></span>`;
}
// One dimmed nested member row (reuses the v132 .qrt-dup-child styles). Accepts both
// a full Report object (rich: has r.location) and a server _member_dict (lean). The
// card's lead is skipped (it IS the headline).
function _incNestedRow(m, leadId) {
    if (!m || m.id === leadId) return '';
    const sev = String(m.severity || 'UNKNOWN').toUpperCase();
    const col = SEV_COLORS[sev] || SEV_COLORS.UNKNOWN;
    const what = infraDisplayLabel(m.infrastructure_type || 'OTHER') || (m.crisis_type || 'Report');
    const when = m.server_created_at ? timeAgo(m.server_created_at) : '';
    const where = m.location_name || (m.location && (m.location.user_location_name || m.location.device_location_name)) || '';
    const tag = m.is_lead ? 'lead' : 'report';
    const idJs = `decodeURIComponent('${encodeURIComponent(m.id)}')`;
    return `<div class="qrt-dup-child" role="button" tabindex="0" title="Open this report"`
        + ` onclick="event.stopPropagation();window.openIncident&&window.openIncident(${idJs})"`
        + ` onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();window.openIncident&&window.openIncident(${idJs});}">`
        + `<i class="fa-solid fa-angle-right qrt-dup-child-ic"></i>`
        + `<span class="qrt-dup-child-sev" style="background:${col}"></span>`
        + `<span class="qrt-dup-child-what">${escapeHtml(what)}</span>`
        + (where ? `<span class="qrt-dup-child-where">${escapeHtml(where)}</span>` : '')
        + `<span class="qrt-dup-child-tag">${tag}</span>`
        + (when ? `<span class="qrt-dup-child-time">${escapeHtml(when)}</span>` : '')
        + `</div>`;
}
// Expand/collapse an incident's member reports under its lead card. Authoritative
// membership (incl. confirmed-duplicate members collapsed out of /reports) comes from
// GET /incidents/{id}; falls back to the locally-grouped visible members on failure
// or when the report has no incident_id (then GET /reports/{id}/duplicates). Lazy +
// cached on the card element; survives idle polls (304 = no feed re-render).
window.toggleIncidentMembers = async function (incidentId, reportId, badgeEl) {
    const card = badgeEl && badgeEl.closest && badgeEl.closest('.qrt-card');
    if (!card) return;
    const leadId = card.dataset && card.dataset.reportId;
    const host = card.closest('.opg-inc') || card.parentElement;
    let box = card._incMembersBox;
    if (box && box.isConnected) {
        const hidden = box.style.display === 'none';
        box.style.display = hidden ? '' : 'none';
        badgeEl.classList.toggle('expanded', hidden);
        badgeEl.setAttribute('aria-expanded', hidden ? 'true' : 'false');
        return;
    }
    box = document.createElement('div');
    box.className = 'qrt-dup-children';
    box.innerHTML = '<div class="qrt-dup-empty">Loading reports…</div>';
    if (card.nextSibling) host.insertBefore(box, card.nextSibling); else host.appendChild(box);
    card._incMembersBox = box;
    badgeEl.classList.add('expanded');
    badgeEl.setAttribute('aria-expanded', 'true');
    // local map (id → full Report) for location enrichment + the failure fallback.
    const local = new Map();
    for (const m of (card._incidentMembers || [])) if (m && m.id) local.set(m.id, m);
    const _paint = (rows) => {
        const html = rows.map((m) => _incNestedRow(local.get(m.id) || m, leadId)).join('');
        box.innerHTML = html || '<div class="qrt-dup-empty">No other reports.</div>';
    };
    try {
        let rows;
        if (incidentId) {
            const inc = await _incJSON(`${INCIDENTS_API}/${encodeURIComponent(incidentId)}`);
            rows = (inc && inc.reports) || [];
        } else {
            const res = await fetch(`${API}/${encodeURIComponent(reportId)}/duplicates`,
                { headers: { Authorization: 'Bearer ' + (localStorage.getItem('crisp_token') || '') } });
            const data = res.ok ? await res.json() : { candidates: [] };
            rows = ((data && data.candidates) || []).filter((c) => c && c.confirmed)
                .map((c) => ({ ...c, id: c.report_id }));
        }
        _paint(rows);
    } catch (_e) {
        // fall back to the locally-grouped visible members (minus the lead)
        _paint((card._incidentMembers || []).filter((m) => m && m.id !== leadId));
    }
};
// Population matches the queue feed's narrowing (queue/status/time/search/chips)
// so toggling view modes shows the SAME reports, just grouped.
// Post-scope/queue narrowing shared by BOTH feed render paths (the building-grouped
// cluster feed AND the attention-queue op→building grouped feed) so a queue view
// honours the Critical chip / time / crisis-drill / search / chips identically - the
// tab badges then never disagree with the list. (The status TAB is applied
// separately, only when no queue owns the population.)
function _applyPostQueueNarrowing(reports) {
    let out = _applyPillFilter(reports);
    if (!_activeQueue && timeFilterHours > 0) {
        const cutoff = Date.now() - timeFilterHours * 3600000;
        out = out.filter((r) => _priorityTime(r) > cutoff);
    }
    if (_crisisDrillFilter != null) out = out.filter((r) => (r.crisis_type || 'UNKNOWN') === _crisisDrillFilter);
    if (treeSearchTerm) {
        out = out.filter((r) => {
            const hay = [r.description, r.infrastructure_type, r.infrastructure_name, r.severity, r.status,
                r.location?.user_location_name, r.location?.device_location_name].filter(Boolean).join(' ').toLowerCase();
            return hay.includes(treeSearchTerm);
        });
    }
    if (_activeChipFilters && _activeChipFilters.size) out = out.filter(_passesChipFilters);
    return out;
}
function _clusterFilteredReports() {
    // The Rejected TAB is the only in-feed place rejected reports surface (every other
    // view strips them via _applyQueueFilter). Show ONLY rejected — scope-filtered +
    // post-queue narrowed — so the tab honours building/triage scope, search + chips.
    if (!_activeQueue && _activeStatusTab === 'rejected') {
        return _applyPostQueueNarrowing(
            _applyScopeFilter(allReports).filter((r) => (r.reviewer_verdict || 'NOT_REVIEWED') === 'REJECTED'));
    }
    // scope (building/triage) → rejected-hidden + queue → status TAB (when no queue
    // owns the population) → shared post-queue narrowing.
    const base = _applyQueueFilter(_applyScopeFilter(allReports));
    const reports = _activeQueue ? base : _applyStatusTabFilter(base);
    return _applyPostQueueNarrowing(reports);
}
// Jun 2026 nav-clarity: the attention-card DESTINATION. Groups the category-filtered
// incidents by Operation → Building (sections expanded; headers drill the scope), so
// the Global → Operation → Building → Incident hierarchy is visible in-page. Cards are
// the shared createIncidentCard (so #report-feed-list .qrt-card contracts still hold).
function _ensureOpGroupStyles() {
    if (document.getElementById('cc-opg-styles')) return;
    const s = document.createElement('style');
    s.id = 'cc-opg-styles';
    // Operation -> Building -> Incident TREE. Three muted, professional levels so the
    // parent-child structure is obvious at a glance without clutter:
    //   Operations = violet (A) · Buildings = teal (B) · Incidents = slate (C).
    // Each level owns a thin connector rail to its children (violet rail under an
    // operation, teal rail under a building) with a short elbow into each child; the
    // tick into an incident is slate so the leaf level reads distinctly. A small
    // indent per level keeps it compact; collapse hides a node's body.
    s.textContent = `
      .opg-toolbar{position:sticky;top:0;z-index:6;display:flex;align-items:center;gap:8px;
        padding:7px 10px;margin:-4px 0 9px;background:#0b1322;border-bottom:1px solid #1d2942}
      .opg-tb-sum{font-size:11px;color:#9fb2d4;font-weight:600;min-width:0;overflow:hidden;
        text-overflow:ellipsis;white-space:nowrap}
      .opg-tb-spacer{margin-left:auto;flex:1}
      .opg-tb-btn{flex:none;font-size:11px;font-weight:700;color:#b7c6e0;background:#16223a;
        border:1px solid #25344f;border-radius:6px;padding:3px 9px;cursor:pointer;
        display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
      .opg-tb-btn:hover{background:#1d2c49;color:#e6edf7}
      .opg-tb-btn i{font-size:10px}

      .opg-twist{flex:none;width:13px;text-align:center;color:#7e93b5;font-size:10px;
        transition:transform .12s ease}
      .opg-op.opg-collapsed>.opg-op-head .opg-twist,
      .opg-bldg.opg-collapsed>.opg-bldg-head .opg-twist{transform:rotate(-90deg)}

      /* Operation — level A. Header ROW, NOT a card: no border, no background.
         Hierarchy is shown by FONT COLOUR (purple) + a thin connector rail only
         (operator request). The chevron sits tight so it adds no extra indent. */
      .opg-op{margin:0 0 8px}
      .opg-op-head{display:flex;align-items:center;gap:6px;padding:3px 4px;cursor:pointer;border-radius:6px}
      .opg-op-head:hover{background:rgba(255,255,255,.03)}
      .opg-op-ic{flex:none;color:#a78bfa;font-size:11px}
      .opg-triage .opg-op-ic{color:#b3a4dd}
      .opg-op-name{font-size:12.5px;font-weight:800;color:#a78bfa;letter-spacing:.01em;min-width:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .opg-triage .opg-op-name{color:#b3a4dd}
      .opg-op-count{flex:none;font-size:11px;font-weight:800;color:#a78bfa;background:none;padding:0 2px;
        font-variant-numeric:tabular-nums}
      .opg-op-drill{margin-left:auto;flex:none;font-size:11px;font-weight:700;color:#9aa7c2;
        cursor:pointer;white-space:nowrap}
      .opg-op-drill:hover{color:#c7d2e6;text-decoration:underline}
      /* Connector: thin purple rail from the operation to its buildings, starting just
         BELOW the header (margin-top) so it never merges back into the parent row. */
      .opg-op-body{margin:1px 0 6px 12px;padding-left:12px;border-left:1.5px solid rgba(167,139,250,.38)}

      /* Building — level B. Header ROW: no bg, no border; distinguished by TEAL font. */
      .opg-bldg{position:relative;margin-top:2px}
      .opg-bldg-head{display:flex;align-items:center;gap:6px;padding:3px 4px;font-size:11.5px;
        color:#2dd4bf;font-weight:700;cursor:pointer;border-radius:6px;position:relative}
      .opg-bldg-head:hover{background:rgba(255,255,255,.03)}
      .opg-bldg-head::before{content:'';position:absolute;left:-12px;top:13px;width:10px;height:1.5px;
        background:rgba(167,139,250,.38)}
      .opg-bldg-ic{flex:none;color:#2dd4bf;font-size:10px}
      .opg-bldg-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      .opg-bldg-name.opg-clickable{cursor:pointer}
      .opg-bldg-name.opg-clickable:hover{color:#7defd9;text-decoration:underline}
      .opg-bldg-count{flex:none;margin-left:auto;font-size:11px;font-weight:800;color:#2dd4bf;background:none;
        padding:0 2px;font-variant-numeric:tabular-nums}
      .opg-bldg-body{margin:1px 0 6px 11px;padding-left:12px;border-left:1.5px solid rgba(45,212,191,.34);
        display:flex;flex-direction:column;gap:7px}

      /* Incident — level C (the only card). Connector elbow inherits the parent
         BUILDING colour (teal) so the rail palette stays at 3 colours. */
      .opg-inc{position:relative}
      .opg-inc::before{content:'';position:absolute;left:-12px;top:14px;width:10px;height:1.5px;
        background:rgba(45,212,191,.34)}

      /* op -> building elbow: a short purple tick from the operation rail into each
         building card (the feed groups buildings as .cc-cluster under .opg-op-body),
         so the hierarchy reads as clean connected lines, not a floating rail. */
      .opg-op-body > .cc-cluster > .qrt-section-header{position:relative}
      .opg-op-body > .cc-cluster > .qrt-section-header::before{content:'';position:absolute;
        left:-12px;top:13px;width:10px;height:1.5px;background:rgba(167,139,250,.38)}

      .opg-op.opg-collapsed>.opg-op-body{display:none}
      .opg-bldg.opg-collapsed>.opg-bldg-body{display:none}
    `;
    document.head.appendChild(s);
}

// ── P2: Operations REGISTRY as the Console's left tree (#/operations) ──────────
// The operations list is no longer a separate full-page overlay — it renders here as
// the TOP level of the Operation → Building → Incident tree. Each operation is a
// collapsible node: its NAME (or "Open →") opens the operation summary in the right
// panel; its chevron expands to that operation's buildings → incidents (grouped from
// the loaded working set — the full per-op worklist is in the panel). Controls: search
// · sort · Expand/Collapse all · + New. Active only on the #/operations route, so the
// building-first #/incidents default is unchanged.
let _opsRegMode = false;
let _opsRegExpanded = new Set();   // expanded operation ids
let _opsRegSelectedOp = null;      // op whose panel is open (highlight; keeps the global tree)
let _opsRegView = { q: '', sort: 'worst', status: 'live', health: '', shown: 30 };
const OPS_REG_PAGE = 30;           // windowing page size (must-have #12 scale)
function setOpsRegistryMode(on) {
    const next = !!on;
    if (next === _opsRegMode) return;
    _opsRegMode = next;
    if (!next) { _opsRegSelectedOp = null; return void (function () { try { renderFeed(); } catch (_e) {} })(); }
    // Home summary-chip handoff (crisp_ops_filter): preset the health / status filter so a
    // "N critical state" chip lands on the registry already filtered.
    try {
        const h = sessionStorage.getItem('crisp_ops_filter');
        sessionStorage.removeItem('crisp_ops_filter');
        if (h === 'red') { _opsRegView.health = 'RED'; _opsRegView.status = 'live'; }
        else if (h === 'amber') { _opsRegView.health = 'AMBER'; _opsRegView.status = 'live'; }
        else if (h === 'green') { _opsRegView.health = 'GREEN'; _opsRegView.status = 'live'; }
        else if (h === 'unattended') { _opsRegView.health = 'UNATT'; _opsRegView.status = 'live'; }
        else if (h === 'all') { _opsRegView.health = ''; _opsRegView.status = 'all'; }
    } catch (_e) {}
    _opsRegView.shown = OPS_REG_PAGE;
    try { renderFeed(); } catch (_e) {}
}
window.setOpsRegistryMode = setOpsRegistryMode;
window.getOpsRegistryMode = () => _opsRegMode;

function _opsRegFiltered(ops) {
    const v = _opsRegView;
    const q = (v.q || '').trim().toLowerCase();
    const isEnded = (o) => String(o && o.status || '').toUpperCase() === 'ENDED';
    const unatt = (o) => String(o.status || '').toUpperCase() === 'LIVE' && Number(o.critical || 0) > 0 && !(Number(o.responders_active || 0) > 0);
    return ops.filter((o) => {
        if (v.status === 'live' && isEnded(o)) return false;
        if (v.status === 'ended' && !isEnded(o)) return false;
        const h = String(o.health || '').toUpperCase();
        if ((v.health === 'RED' || v.health === 'AMBER' || v.health === 'GREEN') && h !== v.health) return false;
        if (v.health === 'UNATT' && !unatt(o)) return false;
        if (q && !String(o.name || '').toLowerCase().includes(q) && !String(o.place_name || '').toLowerCase().includes(q)) return false;
        return true;
    });
}
function _opsRegSorted(ops) {
    const list = _opsRegFiltered(ops);
    const rank = { RED: 0, AMBER: 1, GREEN: 2 };
    if (_opsRegView.sort === 'name') list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    else list.sort((a, b) => ((rank[String(a.health || '').toUpperCase()] ?? 3) - (rank[String(b.health || '').toUpperCase()] ?? 3))
        || (Number(b.critical || 0) - Number(a.critical || 0)) || (Number(b.total || 0) - Number(a.total || 0)));
    return list;
}

function renderOperationsRegistry(el) {
    _ensureClusterStyles();
    _ensureOpGroupStyles();
    _ensureOpsRegStyles();
    if (!(_opsCache && _opsCache.length) && typeof _loadOpsForSwitcher === 'function') {
        _loadOpsForSwitcher().then(() => { try { if (_opsRegMode) renderFeed(); } catch (_e) {} });
    }
    const ops = _opsRegSorted((_opsCache || []).filter((o) => o && o.id && !o.is_cluster));
    // Group the loaded working set by operation (the per-op full worklist is in the panel).
    const byOp = new Map();
    (allReports || []).forEach((r) => {
        const k = r.crisis_event_id; if (!k) return;
        let g = byOp.get(k); if (!g) { g = []; byOp.set(k, g); } g.push(r);
    });
    el.innerHTML = '';
    const tb = document.createElement('div');
    tb.className = 'opg-toolbar opg-reg-toolbar';
    tb.innerHTML =
        '<input type="search" class="opg-reg-search" placeholder="Search operations…" aria-label="Search operations" value="' + escapeAttr(_opsRegView.q) + '">'
        + '<span class="opg-reg-seg" role="tablist" aria-label="Operation status">'
            + '<button type="button" class="opg-reg-segbtn' + (_opsRegView.status === 'live' ? ' on' : '') + '" data-status="live">Live</button>'
            + '<button type="button" class="opg-reg-segbtn' + (_opsRegView.status === 'ended' ? ' on' : '') + '" data-status="ended">Ended</button>'
            + '<button type="button" class="opg-reg-segbtn' + (_opsRegView.status === 'all' ? ' on' : '') + '" data-status="all">All</button>'
        + '</span>'
        + '<select class="opg-reg-sort" aria-label="Sort operations"><option value="worst"' + (_opsRegView.sort === 'worst' ? ' selected' : '') + '>Worst first</option><option value="name"' + (_opsRegView.sort === 'name' ? ' selected' : '') + '>Name A–Z</option></select>'
        + '<span class="opg-reg-fchips" role="group" aria-label="Health filter">'
            + '<button type="button" class="opg-reg-fchip red' + (_opsRegView.health === 'RED' ? ' on' : '') + '" data-health="RED" title="Critical-state operations">RED</button>'
            + '<button type="button" class="opg-reg-fchip amber' + (_opsRegView.health === 'AMBER' ? ' on' : '') + '" data-health="AMBER" title="Rising operations">AMBER</button>'
            + '<button type="button" class="opg-reg-fchip green' + (_opsRegView.health === 'GREEN' ? ' on' : '') + '" data-health="GREEN" title="Stable operations">GREEN</button>'
        + '</span>'
        + '<span class="opg-tb-sum">' + ops.length + ' operation' + (ops.length === 1 ? '' : 's') + '</span>'
        + '<span class="opg-tb-spacer"></span>'
        + '<button type="button" class="opg-tb-btn opg-reg-new" id="cco-newop" title="Start a new operation"><i class="fa-solid fa-plus"></i> New operation</button>'
        + '<button type="button" class="opg-tb-btn" data-reg-all="expand" title="Expand all"><i class="fa-solid fa-angles-down"></i></button>'
        + '<button type="button" class="opg-tb-btn" data-reg-all="collapse" title="Collapse all"><i class="fa-solid fa-angles-up"></i></button>';
    el.appendChild(tb);
    const _searchEl = tb.querySelector('.opg-reg-search');
    if (_searchEl) _searchEl.addEventListener('input', (e) => {
        _opsRegView.q = e.target.value || ''; _opsRegView.shown = OPS_REG_PAGE; renderOperationsRegistry(el);
        const s = el.querySelector('.opg-reg-search'); if (s) { s.focus(); try { s.setSelectionRange(s.value.length, s.value.length); } catch (_e) {} }
    });
    tb.querySelector('.opg-reg-sort').addEventListener('change', (e) => { _opsRegView.sort = e.target.value; renderOperationsRegistry(el); });
    tb.querySelectorAll('.opg-reg-segbtn').forEach((b) => b.addEventListener('click', () => { _opsRegView.status = b.getAttribute('data-status'); _opsRegView.shown = OPS_REG_PAGE; renderOperationsRegistry(el); }));
    tb.querySelectorAll('.opg-reg-fchip').forEach((c) => c.addEventListener('click', () => { const h = c.getAttribute('data-health'); _opsRegView.health = (_opsRegView.health === h) ? '' : h; _opsRegView.shown = OPS_REG_PAGE; renderOperationsRegistry(el); }));
    tb.querySelector('.opg-reg-new').addEventListener('click', () => { try { (window.openOperationWizard || function () {})(); } catch (_e) {} });
    tb.querySelector('[data-reg-all="expand"]').addEventListener('click', () => { ops.forEach((o) => _opsRegExpanded.add(o.id)); renderOperationsRegistry(el); });
    tb.querySelector('[data-reg-all="collapse"]').addEventListener('click', () => { _opsRegExpanded.clear(); renderOperationsRegistry(el); });

    // Orphan-critical CTA: un-operationalised critical reports → the two-option chooser
    // (View ungrouped reports · Create operation). Shown only in the unfiltered view.
    const _cluster = (_opsCache || []).find((o) => o && o.is_cluster) || null;
    if (_cluster && Number(_cluster.critical) > 0 && !(_opsRegView.q || '').trim()) {
        const n = Number(_cluster.critical);
        const cta = document.createElement('button');
        cta.type = 'button';
        cta.className = 'opg-reg-cluster-cta';
        cta.setAttribute('data-cluster', '1');
        cta.innerHTML = '<i class="fa-solid fa-triangle-exclamation"></i> ' + n + ' critical report' + (n === 1 ? '' : 's') + ' not yet in an operation — review or operationalise';
        cta.addEventListener('click', () => { try { (window.openClusterChooser || function () {})({ critical: n }); } catch (_e) {} });
        el.appendChild(cta);
    }

    const badge = document.getElementById('feed-count-badge');
    if (badge) badge.textContent = ops.length + ' operation' + (ops.length === 1 ? '' : 's');

    if (!ops.length) {
        const empty = document.createElement('div');
        empty.className = 'feed-empty-state';
        empty.innerHTML = '<i class="fa-solid fa-bullseye"></i><div class="feed-empty-title">' + ((_opsCache && _opsCache.length) ? 'No operations match' : 'Loading operations…') + '</div>'
            + '<div class="feed-empty-sub">' + ((_opsCache && _opsCache.length) ? 'Try a different search.' : 'Reading the portfolio…') + '</div>';
        el.appendChild(empty);
        return;
    }

    ops.slice(0, _opsRegView.shown).forEach((op) => {   // windowing (must-have #12 scale)
        const expanded = _opsRegExpanded.has(op.id);
        const reports = byOp.get(op.id) || [];
        const opWrap = document.createElement('div');
        opWrap.className = 'opg-op' + (expanded ? '' : ' opg-collapsed') + (op.id === _opsRegSelectedOp ? ' cc-cluster-active' : '');
        opWrap.dataset.opgKey = 'op:' + op.id;
        opWrap.dataset.op = op.id;
        const crit = Number(op.critical || 0), tot = Number(op.total || 0);
        const health = String(op.health || '').toUpperCase();
        const opHead = document.createElement('div');
        opHead.className = 'opg-op-head';
        opHead.setAttribute('role', 'button');
        opHead.setAttribute('aria-expanded', String(expanded));
        opHead.innerHTML =
            '<i class="fa-solid fa-chevron-down opg-twist" aria-hidden="true"></i>'
            + '<span class="opg-reg-health hc-' + (health || 'NA') + '" title="' + escapeAttr(op.health_reason || health || '') + '"></span>'
            + '<span class="opg-op-name"><span class="opg-reg-opname">' + escapeHtml(op.name || 'Operation') + '</span>' + (op.place_name ? '<span class="opg-reg-place"> · ' + escapeHtml(op.place_name) + '</span>' : '') + '</span>'
            + (crit ? '<span class="opg-op-count opg-reg-crit" title="' + crit + ' critical">' + crit + '</span>' : '')
            + '<span class="opg-op-count" title="' + tot + ' report' + (tot === 1 ? '' : 's') + '">' + tot + '</span>'
            + '<a class="opg-op-drill">Open →</a>';
        opHead.addEventListener('click', () => {
            if (_opsRegExpanded.has(op.id)) _opsRegExpanded.delete(op.id); else _opsRegExpanded.add(op.id);
            renderOperationsRegistry(el);
        });
        const _openOp = (e) => { e.stopPropagation(); if (window.openOperationSummary) window.openOperationSummary(op.id); };
        opHead.querySelector('.opg-reg-opname').addEventListener('click', _openOp);
        opHead.querySelector('.opg-op-drill').addEventListener('click', _openOp);
        opWrap.appendChild(opHead);
        const opBody = document.createElement('div');
        opBody.className = 'opg-op-body';
        if (expanded) {
            if (!reports.length) {
                opBody.innerHTML = '<div class="opg-reg-empty">No incidents in the loaded set — <a class="opg-reg-openlink">open the operation</a> for its full worklist.</div>';
                const lk = opBody.querySelector('.opg-reg-openlink');
                if (lk) lk.addEventListener('click', _openOp);
            } else {
                const groups = new Map();
                reports.forEach((r) => { let k = _clusterKey(r); if (k.charAt(0) !== 'b') k = 'ungrouped'; let g = groups.get(k); if (!g) { g = []; groups.set(k, g); } g.push(r); });
                const clusters = [];
                groups.forEach((rs, key) => clusters.push(_clusterSummary(key, rs)));
                clusters.sort((a, b) => ((a.ungrouped ? 1 : 0) - (b.ungrouped ? 1 : 0)) || (b.maxRank - a.maxRank) || (b.count - a.count));
                clusters.forEach((c) => opBody.appendChild(_renderClusterCard(c)));   // buildings collapsed by default
            }
        }
        opWrap.appendChild(opBody);
        el.appendChild(opWrap);
    });
    if (ops.length > _opsRegView.shown) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'opg-reg-more';
        more.textContent = 'Load more (' + (ops.length - _opsRegView.shown) + ')';
        more.addEventListener('click', () => { _opsRegView.shown += OPS_REG_PAGE; renderOperationsRegistry(el); });
        el.appendChild(more);
    }
    try { updateCommandStats(); } catch (_e) {}
}

function _ensureOpsRegStyles() {
    if (document.getElementById('cc-opsreg-styles')) return;
    const s = document.createElement('style');
    s.id = 'cc-opsreg-styles';
    s.textContent = `
      .opg-reg-toolbar{flex-wrap:wrap;gap:6px}
      .opg-reg-search{flex:1 1 130px;min-width:90px;background:#0e1726;border:1px solid #25344f;border-radius:7px;
        color:#dce8fb;font-size:11.5px;padding:4px 9px;outline:none}
      .opg-reg-search:focus{border-color:#3a517a}
      .opg-reg-sort{background:#0e1726;border:1px solid #25344f;border-radius:7px;color:#b7c6e0;font-size:11px;padding:4px 6px;cursor:pointer}
      .opg-reg-seg{display:inline-flex;border:1px solid #25344f;border-radius:7px;overflow:hidden}
      .opg-reg-segbtn{background:#0e1726;border:none;color:#8aa0bf;font-size:11px;font-weight:700;padding:4px 9px;cursor:pointer;font-family:inherit}
      .opg-reg-segbtn.on{background:#1d2c49;color:#eaf2fc}
      .opg-reg-fchips{display:inline-flex;gap:4px}
      .opg-reg-fchip{font-size:10px;font-weight:800;letter-spacing:.3px;padding:3px 7px;border-radius:7px;cursor:pointer;font-family:inherit;
        border:1px solid #25344f;background:#0e1726;color:#8aa0bf}
      .opg-reg-fchip.red.on{background:rgba(239,68,68,.18);border-color:rgba(239,68,68,.5);color:#fca5a5}
      .opg-reg-fchip.amber.on{background:rgba(245,158,11,.18);border-color:rgba(245,158,11,.5);color:#fcd34d}
      .opg-reg-fchip.green.on{background:rgba(34,197,94,.18);border-color:rgba(34,197,94,.5);color:#86efac}
      .opg-reg-more{display:block;width:calc(100% - 8px);margin:2px 4px 10px;padding:8px;border-radius:8px;
        border:1px solid #25344f;background:#16223a;color:#b7c6e0;font-size:11.5px;font-weight:700;cursor:pointer;font-family:inherit}
      .opg-reg-more:hover{background:#1d2c49;color:#e6edf7}
      .opg-reg-health{flex:none;width:8px;height:8px;border-radius:50%;background:#5b6b86}
      .opg-reg-health.hc-RED{background:#ef4444}.opg-reg-health.hc-AMBER{background:#f59e0b}.opg-reg-health.hc-GREEN{background:#22c55e}
      .opg-reg-place{color:#8aa0bf;font-weight:500}
      .opg-reg-crit{background:rgba(239,68,68,.16);border:1px solid rgba(239,68,68,.3);color:#fca5a5}
      .opg-reg-empty{font-size:11.5px;color:#9fb3d1;padding:6px 4px}
      .opg-reg-openlink{color:#9db8ef;cursor:pointer;text-decoration:underline}
      .opg-reg-cluster-cta{display:flex;align-items:center;gap:7px;width:calc(100% - 8px);margin:0 4px 8px;
        padding:8px 11px;border-radius:9px;border:1px solid rgba(239,68,68,.4);background:rgba(239,68,68,.10);
        color:#fca5a5;font-size:11.5px;font-weight:700;cursor:pointer;text-align:left;font-family:inherit}
      .opg-reg-cluster-cta:hover{background:rgba(239,68,68,.18)}
      .opg-reg-cluster-cta i{flex:none}`;
    document.head.appendChild(s);
}

// Tree-collapse state for the Operation -> Building -> Incident grouped feed. Holds the
// keys (op:<id> / bld:<op>:<bldg>) the operator has explicitly collapsed; reset when the
// attention category changes so each category opens fully expanded.
let _opgCollapsed = new Set();
let _opgScopeKey = null;

function renderOperationGroupedFeed(el) {
    _ensureClusterStyles();
    _ensureOpGroupStyles();
    // Section names come from _opsCache (the switcher's operations list). Load it
    // lazily + re-render once it lands so sections show real operation names, not
    // the generic "Operation" fallback. Guarded so it fires at most once.
    if (typeof _loadOpsForSwitcher === 'function' && !(_opsCache && _opsCache.length)) {
        _loadOpsForSwitcher().then(() => {
            try { if (_activeQueue && !_activeCrisisEventId && !_activeBuildingId && !_triageScope) renderFeed(); } catch (_e) {}
        });
    }
    const q = _activeQueue;
    // A new attention category opens fully expanded (drop the prior collapse state).
    const scopeKey = String(q || '');
    if (scopeKey !== _opgScopeKey) { _opgCollapsed = new Set(); _opgScopeKey = scopeKey; }
    // Same post-queue narrowing as the cluster feed so Critical / search / chips /
    // crisis-drill actually filter this grouped view too (no badge-vs-list drift).
    const reports = _applyPostQueueNarrowing(_applyQueueFilter(_applyScopeFilter(allReports)));
    if (!reports.length) {
        el.innerHTML = '<div class="cluster-empty">No incidents in this category.</div>';
        try { updateCommandStats(); } catch (_e) {}
        return;
    }
    const qSeg = q ? (';queue=' + encodeURIComponent(q)) : '';
    // group by operation (crisis_event_id) → building (building_id)
    const ops = new Map();
    reports.forEach((r) => {
        const k = r.crisis_event_id || '__triage__';
        if (!ops.has(k)) ops.set(k, { opId: r.crisis_event_id || null, reports: [] });
        ops.get(k).reports.push(r);
    });
    const opList = [...ops.values()].sort((a, b) => b.reports.length - a.reports.length);
    // Summary counts the REAL hierarchy — a triage section ("no operation") and a
    // "No building tagged" bucket are shown in the tree but are not counted as an
    // operation / building.
    const realOps = opList.filter((s) => s.opId).length;
    const realBldgs = new Set(reports.filter((r) => r.building_id).map((r) => r.building_id)).size;
    el.innerHTML = '';
    // ── sticky toolbar: hierarchy summary + Expand all / Collapse all ──
    const tb = document.createElement('div');
    tb.className = 'opg-toolbar';
    const _plur = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
    tb.innerHTML =
        '<span class="opg-tb-sum">' + _plur(realOps, 'operation') + ' · '
            + _plur(realBldgs, 'building') + ' · ' + _plur(reports.length, 'incident') + '</span>'
        + '<span class="opg-tb-spacer"></span>'
        + '<button type="button" class="opg-tb-btn" data-opg-all="expand" title="Expand all"><i class="fa-solid fa-angles-down"></i> Expand</button>'
        + '<button type="button" class="opg-tb-btn" data-opg-all="collapse" title="Collapse all"><i class="fa-solid fa-angles-up"></i> Collapse</button>';
    tb.querySelector('[data-opg-all="expand"]').addEventListener('click', () => _opgApplyAll(false));
    tb.querySelector('[data-opg-all="collapse"]').addEventListener('click', () => _opgApplyAll(true));
    el.appendChild(tb);

    opList.forEach((sec) => {
        const isTriage = !sec.opId;
        const opKey = 'op:' + (sec.opId || '__triage__');
        const opName = isTriage ? 'Triage — no operation' : ((_opMeta(sec.opId) || {}).name || 'Operation');
        const opHash = (isTriage ? '#/incidents;op=none' : ('#/incidents;op=' + encodeURIComponent(sec.opId))) + qSeg;
        const opWrap = document.createElement('div');
        opWrap.className = 'opg-op' + (isTriage ? ' opg-triage' : '') + (_opgCollapsed.has(opKey) ? ' opg-collapsed' : '');
        opWrap.dataset.opgKey = opKey;
        const opHead = document.createElement('div');
        opHead.className = 'opg-op-head';
        opHead.setAttribute('role', 'button');
        opHead.setAttribute('aria-expanded', String(!_opgCollapsed.has(opKey)));
        opHead.innerHTML =
            '<i class="fa-solid fa-chevron-down opg-twist" aria-hidden="true"></i>'
            + '<i class="fa-solid ' + (isTriage ? 'fa-compass' : 'fa-bullseye') + ' opg-op-ic" aria-hidden="true"></i>'
            + '<span class="opg-op-name">' + escapeHtml(opName) + '</span>'
            + (function () { const _ic = _distinctIncidents(sec.reports); return '<span class="opg-op-count" title="' + _ic + ' incident' + (_ic === 1 ? '' : 's') + '">' + _ic + '</span>'; })()
            + '<a class="opg-op-drill">View →</a>';
        opHead.addEventListener('click', () => _opgToggle(opWrap));
        opHead.querySelector('.opg-op-drill').addEventListener('click', (e) => {
            e.stopPropagation();
            // A real operation opens its summary in the right panel (single-page console);
            // the triage pseudo-section has no summary, so it just scopes the feed.
            if (sec.opId && window.openOperationSummary) window.openOperationSummary(sec.opId);
            else location.hash = opHash;
        });
        opWrap.appendChild(opHead);
        const opBody = document.createElement('div');
        opBody.className = 'opg-op-body';
        // building sub-groups
        const blds = new Map();
        sec.reports.forEach((r) => {
            const bk = r.building_id || '__nobldg__';
            if (!blds.has(bk)) blds.set(bk, { bid: r.building_id || null, reports: [] });
            blds.get(bk).reports.push(r);
        });
        [...blds.values()].sort((a, b) => b.reports.length - a.reports.length).forEach((bg) => {
            const noBldg = !bg.bid;
            const bKey = 'bld:' + (sec.opId || '__triage__') + ':' + (bg.bid || '__nobldg__');
            const bName = noBldg ? 'No building tagged' : _buildingDisplayName(bg.reports);
            const bWrap = document.createElement('div');
            bWrap.className = 'opg-bldg' + (_opgCollapsed.has(bKey) ? ' opg-collapsed' : '');
            bWrap.dataset.opgKey = bKey;
            const bHead = document.createElement('div');
            bHead.className = 'opg-bldg-head';
            bHead.setAttribute('role', 'button');
            bHead.setAttribute('aria-expanded', String(!_opgCollapsed.has(bKey)));
            bHead.innerHTML =
                '<i class="fa-solid fa-chevron-down opg-twist" aria-hidden="true"></i>'
                + '<i class="fa-solid fa-building opg-bldg-ic" aria-hidden="true"></i>'
                + '<span class="opg-bldg-name' + (noBldg ? '' : ' opg-clickable') + '">' + escapeHtml(bName) + '</span>'
                + '<span class="opg-bldg-count">' + _distinctIncidents(bg.reports) + '</span>';
            bHead.addEventListener('click', () => _opgToggle(bWrap));
            if (!noBldg) {
                const bHash = (isTriage ? '#/incidents;op=none' : ('#/incidents;op=' + encodeURIComponent(sec.opId)))
                    + ';bld=' + encodeURIComponent(bg.bid) + qSeg;
                // The building NAME navigates to the building scope; the rest of the row toggles.
                bHead.querySelector('.opg-bldg-name').addEventListener('click', (e) => { e.stopPropagation(); location.hash = bHash; });
            }
            bWrap.appendChild(bHead);
            const cards = document.createElement('div');
            cards.className = 'opg-bldg-body';
            _groupByIncident(bg.reports).forEach((members) => cards.appendChild(_renderIncidentGroup(members)));
            bWrap.appendChild(cards);
            opBody.appendChild(bWrap);
        });
        opWrap.appendChild(opBody);
        el.appendChild(opWrap);
    });
    try { updateCommandStats(); } catch (_e) {}
}

// Toggle a single op/building node (cheap show/hide, no re-render — keeps scroll pos).
function _opgToggle(node) {
    const k = node && node.dataset && node.dataset.opgKey;
    if (!k) return;
    const collapsed = _opgCollapsed.has(k);
    if (collapsed) { _opgCollapsed.delete(k); node.classList.remove('opg-collapsed'); }
    else { _opgCollapsed.add(k); node.classList.add('opg-collapsed'); }
    const head = node.querySelector('.opg-op-head, .opg-bldg-head');
    if (head) head.setAttribute('aria-expanded', String(collapsed));
}

// Expand all -> open every node. Collapse all -> collapse to the operation level
// (operations closed; buildings reset to open so a later op-expand reads cleanly).
function _opgApplyAll(collapse) {
    const el = document.getElementById('report-feed-list');
    if (!el) return;
    el.querySelectorAll('.opg-bldg').forEach((n) => {
        _opgCollapsed.delete(n.dataset.opgKey); n.classList.remove('opg-collapsed');
        const h = n.querySelector('.opg-bldg-head'); if (h) h.setAttribute('aria-expanded', 'true');
    });
    el.querySelectorAll('.opg-op').forEach((n) => {
        if (collapse) { _opgCollapsed.add(n.dataset.opgKey); n.classList.add('opg-collapsed'); }
        else { _opgCollapsed.delete(n.dataset.opgKey); n.classList.remove('opg-collapsed'); }
        const h = n.querySelector('.opg-op-head'); if (h) h.setAttribute('aria-expanded', String(!collapse));
    });
}

function renderClusterFeed(el) {
    _ensureClusterStyles();
    _ensureOpGroupStyles();   // shared tree chrome: .opg-toolbar + .opg-inc connector leaf
    const reports = _clusterFilteredReports();
    el.innerHTML = '';
    if (!reports.length) {
        el.innerHTML = `<div class="feed-empty-state">
            <i class="fa-solid fa-object-group"></i>
            <div class="feed-empty-title">${allReports.length === 0 ? 'Awaiting Incidents' : 'No incidents in this view'}</div>
            <div class="feed-empty-sub">${allReports.length === 0 ? 'Reports from the field will appear here, grouped by building/location.' : 'Try widening the filters above.'}</div>
        </div>`;
        const badge = document.getElementById('feed-count-badge');
        if (badge) badge.textContent = 'All Clear';
        return;
    }
    const groups = new Map();
    for (const r of reports) {
        let k = _clusterKey(r);
        // Building-first: every report with no building_id (h3 cell or singleton)
        // collapses into ONE "Needs mapping / Ungrouped" bucket so the feed reads as
        // a list of buildings, and unmapped reports are surfaced (never hidden).
        if (k.charAt(0) !== 'b') k = 'ungrouped';
        let g = groups.get(k);
        if (!g) { g = []; groups.set(k, g); }
        g.push(r);
    }
    const clusters = [];
    groups.forEach((rs, key) => clusters.push(_clusterSummary(key, rs)));
    // Buildings worst-first; the Ungrouped bucket always sorts last (it's context).
    clusters.sort((a, b) => ((a.ungrouped ? 1 : 0) - (b.ungrouped ? 1 : 0))
        || (b.maxRank - a.maxRank) || (b.lastActivity - a.lastActivity) || (b.count - a.count));
    // When the operator has drilled into the deepest scopes (a single building, or
    // the triage bucket), or has switched to the flat "queue" escape hatch,
    // auto-expand the cluster(s) so the reports show immediately instead of one
    // collapsed card they'd have to click open.
    const _forceOpen = !!(_activeBuildingId || _triageScope || viewMode === 'queue');
    const nBld = clusters.filter(c => !c.ungrouped).length;
    const nInc = clusters.reduce((n, c) => n + c.count, 0);
    // GLOBAL view shows the full Operation → Building → Incident hierarchy: when real
    // operations exist, the building cards are grouped under their Operation. Op/building-
    // scoped views stay the flat building list (you're already inside an operation). When
    // nothing is assigned to an operation (early data / all-triage), stay flat — there is
    // nothing to group by.
    const _isGlobal = !_activeCrisisEventId && !_activeBuildingId && !_triageScope;
    const _opGrouped = _isGlobal && clusters.some((c) => c.opId);
    const nOps = _opGrouped ? new Set(clusters.filter((c) => c.opId).map((c) => c.opId)).size : 0;
    // op section names come from _opsCache; load lazily ONCE + re-render so headers show
    // real operation names instead of the generic "Operation" fallback.
    if (_opGrouped && !_opGroupNamesRequested && typeof _loadOpsForSwitcher === 'function' && !(_opsCache && _opsCache.length)) {
        _opGroupNamesRequested = true;
        _loadOpsForSwitcher().then(() => { try { if (!_activeCrisisEventId && !_activeBuildingId && !_triageScope) renderFeed(); } catch (_e) {} });
    }
    // Sticky Expand-all / Collapse-all toolbar — same control set as the operation tree.
    // Skipped when there is only one cluster (nothing to manage).
    if (clusters.length >= 2) {
        const tb = document.createElement('div');
        tb.className = 'opg-toolbar';
        const _plur = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
        // Structure only (ops · buildings). The incident count is deliberately NOT
        // repeated here: it counts only the ACTIVE status tab (e.g. Pending), which
        // contradicted the header's all-status total. Total lives in the header; the
        // active-tab number is on the status tab itself.
        const _sum = _opGrouped
            ? (_plur(nOps, 'operation') + ' · ' + _plur(nBld, 'building'))
            : _plur(nBld, 'building');
        tb.innerHTML =
            '<span class="opg-tb-sum">' + _sum + '</span>'
            + '<span class="opg-tb-spacer"></span>'
            + '<button type="button" class="opg-tb-btn" data-cc-all="expand" title="Expand all"><i class="fa-solid fa-angles-down"></i> Expand</button>'
            + '<button type="button" class="opg-tb-btn" data-cc-all="collapse" title="Collapse all"><i class="fa-solid fa-angles-up"></i> Collapse</button>';
        tb.querySelector('[data-cc-all="expand"]').addEventListener('click', () => _clusterApplyAll(el, clusters, true));
        tb.querySelector('[data-cc-all="collapse"]').addEventListener('click', () => _clusterApplyAll(el, clusters, false));
        el.appendChild(tb);
    }
    if (_opGrouped) _mountOpGroupedClusters(el, clusters);
    else _mountClusterWindow(el, clusters, _forceOpen);
    const badge = document.getElementById('feed-count-badge');
    if (badge) {
        badge.textContent =
            `${nBld} building${nBld !== 1 ? 's' : ''} · ${reports.length} report${reports.length !== 1 ? 's' : ''}`;
    }
}

// Expand-all / Collapse-all for the building feed. Updates _expandedClusters for EVERY
// cluster (so windowed cards that scroll in later render in the right state) and toggles
// the classes on already-rendered cards — no full re-render, so scroll is preserved.
// (Operation sections, when present at Global, stay expanded — the op level is the
// always-visible spine; each op is collapsible via its own chevron.)
function _clusterApplyAll(el, clusters, expand) {
    clusters.forEach((c) => { if (expand) _expandedClusters.add(c.key); else _expandedClusters.delete(c.key); });
    el.querySelectorAll('.cc-cluster').forEach((sec) => {
        const on = _expandedClusters.has(sec.dataset.clusterKey);
        sec.classList.toggle('collapsed', !on);
        if (!on) sec.classList.remove('cc-cluster-active');
        const h = sec.querySelector('.qrt-section-header');
        if (h) h.setAttribute('aria-expanded', on ? 'true' : 'false');
    });
    // Op-grouped GLOBAL view: the building cards above are ALREADY collapsed rows, so
    // Collapse-all must also close the OPERATION sections (.opg-op) - otherwise the
    // button has no visible effect (the operator-reported "Collapse all not working").
    // Collapse-all -> operations closed to their header spine; Expand-all -> operations
    // open. State persists via _opgCollapsed so it survives the next re-render too.
    el.querySelectorAll('.opg-op').forEach((op) => {
        const k = op.dataset && op.dataset.opgKey; if (!k) return;
        if (expand) { _opgCollapsed.delete(k); op.classList.remove('opg-collapsed'); }
        else { _opgCollapsed.add(k); op.classList.add('opg-collapsed'); }
        const h = op.querySelector('.opg-op-head');
        if (h) h.setAttribute('aria-expanded', String(expand));
    });
}

// GLOBAL hierarchy: group the rich building cards under their Operation so the feed
// reads Operation → Building → Incident. Reuses the .opg-op header/rail chrome and the
// EXISTING _renderClusterCard for buildings (so the cards keep their dup badges, console
// links, v133 incident grouping). Unassigned buildings (no operation) fall into a single
// "no operation" section, sorted last. Buildings stay collapsed by default; ops expanded.
let _opGroupNamesRequested = false;
function _mountOpGroupedClusters(el, clusters) {
    const ops = new Map();
    for (const c of clusters) {
        const k = c.opId || '__unassigned__';
        if (!ops.has(k)) ops.set(k, { opId: c.opId || null, clusters: [] });
        ops.get(k).clusters.push(c);
    }
    const _rank = (sec) => Math.max(0, ...sec.clusters.map((c) => c.maxRank));
    const _inc = (sec) => sec.clusters.reduce((n, c) => n + c.count, 0);
    const opList = [...ops.values()].sort((a, b) => {
        if (!!a.opId !== !!b.opId) return a.opId ? -1 : 1;   // real operations before "no operation"
        return (_rank(b) - _rank(a)) || (_inc(b) - _inc(a));
    });
    opList.forEach((sec) => {
        const isUnassigned = !sec.opId;
        const opKey = 'op:' + (sec.opId || '__unassigned__');
        const opName = isUnassigned ? 'Unassigned · no operation' : ((_opMeta(sec.opId) || {}).name || 'Operation');
        const nBld = sec.clusters.filter((c) => !c.ungrouped).length;
        const nInc = _inc(sec);
        const opWrap = document.createElement('div');
        opWrap.className = 'opg-op' + (isUnassigned ? ' opg-triage' : '') + (_opgCollapsed.has(opKey) ? ' opg-collapsed' : '');
        opWrap.dataset.opgKey = opKey;
        const opHead = document.createElement('div');
        opHead.className = 'opg-op-head';
        opHead.setAttribute('role', 'button');
        opHead.setAttribute('aria-expanded', String(!_opgCollapsed.has(opKey)));
        opHead.innerHTML =
            '<i class="fa-solid fa-chevron-down opg-twist" aria-hidden="true"></i>'
            + '<i class="fa-solid ' + (isUnassigned ? 'fa-compass' : 'fa-bullseye') + ' opg-op-ic" aria-hidden="true"></i>'
            + '<span class="opg-op-name">' + escapeHtml(opName) + '</span>'
            + '<span class="opg-op-count" title="' + nBld + ' building' + (nBld === 1 ? '' : 's') + ' · ' + nInc + ' incident' + (nInc === 1 ? '' : 's') + '">' + nInc + '</span>'
            + (isUnassigned ? '' : '<a class="opg-op-drill">View →</a>');
        opHead.addEventListener('click', () => _opgToggle(opWrap));
        const drill = opHead.querySelector('.opg-op-drill');
        if (drill) drill.addEventListener('click', (e) => {
            e.stopPropagation();
            if (sec.opId && window.openOperationSummary) window.openOperationSummary(sec.opId);
        });
        opWrap.appendChild(opHead);
        const opBody = document.createElement('div');
        opBody.className = 'opg-op-body';
        sec.clusters.forEach((c) => opBody.appendChild(_renderClusterCard(c)));
        opWrap.appendChild(opBody);
        el.appendChild(opWrap);
    });
}

// v116: building-level infinite scroll. Render the building cards a page (10) at a
// time and append the rest as the operator scrolls - mirrors _applyProgressiveReveal
// but at the cluster/section grain. This is DOM-perf windowing over the already-loaded
// working set; it does NOT change the server fetch cap (must-have #12). Reset on every
// renderClusterFeed call (scope/status-tab/filter/density change) so a new view starts
// from the top.
let _feedBuildingIO = null;
const _FEED_BUILDING_PAGE = 10;
function _mountClusterWindow(el, clusters, forceOpen) {
    if (_feedBuildingIO) { try { _feedBuildingIO.disconnect(); } catch (_) {} _feedBuildingIO = null; }
    const total = clusters.length;
    let shown = 0;
    const _renderUpTo = (target, before) => {
        const frag = document.createDocumentFragment();
        for (; shown < target; shown++) {
            const c = clusters[shown];
            frag.appendChild(_renderClusterCard(c, forceOpen));   // render-only force-open; no Set pollution
        }
        if (before) el.insertBefore(frag, before); else el.appendChild(frag);
    };
    // First page = 10, but extend it so the currently-open (expanded) building is never
    // left below the fold after a re-render (its inline tree + linked console must show).
    let firstPage = Math.min(_FEED_BUILDING_PAGE, total);
    for (let i = firstPage; i < total; i++) {
        if (_expandedClusters.has(clusters[i].key)) { firstPage = i + 1; break; }
    }
    _renderUpTo(firstPage, null);
    if (shown >= total) return;
    const sentinel = document.createElement('div');
    sentinel.className = 'feed-bld-sentinel';
    const _paint = () => {
        sentinel.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin" aria-hidden="true"></i> ' +
            escapeHtml(window.t('loading_more_buildings', 'Loading more buildings')) +
            ` <span class="fbs-progress">${shown} / ${total}</span>`;
    };
    _paint();
    el.appendChild(sentinel);
    _feedBuildingIO = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            _renderUpTo(Math.min(shown + _FEED_BUILDING_PAGE, total), sentinel);
            if (shown >= total) { try { _feedBuildingIO.disconnect(); } catch (_) {} sentinel.remove(); return; }
            _paint();
        }
    }, { root: null, rootMargin: '300px 0px', threshold: 0 });
    _feedBuildingIO.observe(sentinel);
}

let _progressiveIO = null;
const _PROGRESSIVE_PAGE_SIZE = 50;
function _applyProgressiveReveal(container) {
    // Disconnect any previous observer so we don't keep stacks from the
    // previous render cycle.
    if (_progressiveIO) { try { _progressiveIO.disconnect(); } catch (_) {} }
    // Flat-scan every visible card within the feed. Cards in different view
    // modes (.qrt-card for queue, .tree-leaf-card for tree) share the
    // *position* of being inside `#report-feed-list`, so select all cards.
    const cards = container.querySelectorAll('.qrt-card, .tree-leaf-card');
    if (cards.length <= _PROGRESSIVE_PAGE_SIZE) return;

    // Hide everything beyond the initial page.
    let visibleCount = _PROGRESSIVE_PAGE_SIZE;
    // Keep the SELECTED incident (deep-link / op-worklist click / search) inside
    // the revealed window so it is never display:none when CrispNav scrolls to it.
    // Reveal everything up to + including its card (cheap: one extra scan).
    if (selectedId) {
        for (let i = visibleCount; i < cards.length; i++) {
            const cid = (cards[i].dataset && cards[i].dataset.id) || cards[i].getAttribute('data-id');
            if (cid === selectedId) { visibleCount = i + 1; break; }
        }
    }
    cards.forEach((c, i) => { if (i >= visibleCount) c.style.display = 'none'; });

    // Add a sentinel div right after the last visible card.
    //
    // Phase 25.1 (May 2026) - anchor the sentinel by the LAST VISIBLE
    // card, not the first-hidden card. The previous version did
    //     cards[visibleCount - 1].parentElement
    //         .insertBefore(sentinel, cards[visibleCount].nextSibling);
    // which crashes when `cards[visibleCount - 1]` and
    // `cards[visibleCount]` have different parents - exactly what
    // happens in Queue Mode (three separate <section>s for backlog /
    // triage / responding). A new report arriving via any channel
    // (e.g. Telegram) triggered the re-render that pushed the cutoff
    // across a section boundary and threw the user-visible
    // "Failed to execute 'InsertBefore' on 'Node'" render error.
    //
    // Using anchor.nextSibling is null-safe (insertBefore with null
    // appends to end of parent) and the reference node is by
    // definition a child of anchor.parentElement.
    const sentinel = document.createElement('div');
    sentinel.className = '_feed-sentinel';
    sentinel.style.cssText = 'height:1px;width:100%;';
    {
        const anchor = cards[visibleCount - 1];
        if (anchor && anchor.parentElement) {
            anchor.parentElement.insertBefore(sentinel, anchor.nextSibling);
        }
    }

    _progressiveIO = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (!e.isIntersecting) continue;
            const next = Math.min(visibleCount + _PROGRESSIVE_PAGE_SIZE, cards.length);
            for (let i = visibleCount; i < next; i++) cards[i].style.display = '';
            visibleCount = next;
            if (visibleCount >= cards.length) {
                try { _progressiveIO.disconnect(); } catch (_) {}
                sentinel.remove();
                return;
            }
            // Reposition sentinel after the new last-visible card.
            // Same defensive anchor pattern as the initial placement.
            const lastVisible = cards[visibleCount - 1];
            if (lastVisible && lastVisible.parentElement) {
                // If the previous parent differs (cross-section move
                // during Queue Mode), detach first so insertBefore can't
                // confuse two different DOM ancestors.
                if (sentinel.parentElement && sentinel.parentElement !== lastVisible.parentElement) {
                    try { sentinel.remove(); } catch (_) {}
                }
                lastVisible.parentElement.insertBefore(sentinel, lastVisible.nextSibling);
            }
        }
    }, { root: container, rootMargin: '400px 0px', threshold: 0 });
    _progressiveIO.observe(sentinel);
}

// ── Queue Mode: three-bucket triage cards ─────────────────────────────────────
// RETIRED (Jun 2026 feed simplification): no longer dispatched - the feed is always
// building-grouped and the three buckets became the Pending/Responding/Resolved
// TABS. Kept (with consistent labels) only as a fallback should a flat list return.
function renderTriageQueue(el) {
    // Operational queue (attention-panel deep link) - the queue predicate
    // DEFINES the population (replaces status/time filters; search/chips
    // still narrow below). Building/Triage scope is applied FIRST.
    let reports = _applyQueueFilter(_applyScopeFilter(allReports));
    if (!_activeQueue && timeFilterHours > 0) {
        const cutoff = Date.now() - timeFilterHours * 3600000;
        // K.5.b (May 2026, Phase K) - use _priorityTime so offline-
        // drained reports stay visible by CAPTURE time, not by the
        // drain timestamp the server stamped when the chunks finally
        // arrived. Pre-fix the "Last 1 hour" filter silently hid a
        // 2h-old offline-queued report that drained 30s ago.
        reports = reports.filter(r => _priorityTime(r) > cutoff);
    }

    // Apply pill filter (if user clicked a stat pill)
    if (_activePillFilter === 'critical') {
        // M2: match the 'Critical' KPI count + the 'critical' queue (CRITICAL only).
        reports = reports.filter(r => r.severity === 'CRITICAL');
    } else if (_activePillFilter === 'pending') {
        reports = reports.filter(r => r.status === 'PENDING' || r.status === 'VERIFIED');
    } else if (_activePillFilter === 'responding') {
        reports = reports.filter(r => r.status === 'RESPONDING');
    } else if (_activePillFilter === 'resolved') {
        reports = reports.filter(r => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM');
    } else if (_activePillFilter === 'originals_pending') {
        // Phase C.2 - surface reports where the LARGE (HIGH) tier hasn't
        // finished assembling for at least one captured photo. Helps
        // operators monitor the "Original delayed by poor connectivity"
        // case before silently shipping medium-tier previews to the
        // archive.
        reports = reports.filter(r => {
            const imgs = (r.media || []).filter(m => m.type === 'IMAGE');
            if (imgs.length === 0) return false;
            const groups = groupPhotos(imgs);
            return groups.some(g => {
                const hi = g.members.find(m => m.resolution_tier === 'ORIGINAL');
                return !hi || hi.assembly_status !== 'complete';
            });
        });
    }
    // 'all' or null = no additional filter

    // Phase G.1 (May 2026) - apply stacking chip filters on top of the
    // time + status pill chain. AND between active chips (with damage
    // dimension treated as OR-within). Set is empty → no-op.
    if (_activeChipFilters.size) {
        reports = reports.filter(_passesChipFilters);
    }

    // Three buckets by action status
    const needs      = reports.filter(r => r.status === 'PENDING' || r.status === 'VERIFIED');
    const dispatched = reports.filter(r => r.status === 'RESPONDING');
    const resolved   = reports.filter(r => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM');

    // Sort each bucket based on selected sort mode
    const sorter = getSortFunction();
    [needs, dispatched, resolved].forEach(bucket => bucket.sort(sorter));

    el.innerHTML = '';

    // Empty state
    if (!reports.length) {
        el.innerHTML = `<div class="feed-empty-state">
            <i class="fa-solid fa-satellite-dish"></i>
            <div class="feed-empty-title">${allReports.length === 0 ? 'Awaiting Incidents' : 'No incidents in this time window'}</div>
            <div class="feed-empty-sub">${allReports.length === 0 ? 'Reports from the field will appear here in real-time as they arrive.' : 'Try expanding the time filter above.'}</div>
        </div>`;
        const badge = document.getElementById('feed-count-badge');
        if (badge) badge.textContent = 'All Clear';
        return;
    }

    const frag = document.createDocumentFragment();

    // Show active filter indicator with clear button
    if (_activePillFilter && _activePillFilter !== 'all') {
        const filterBar = document.createElement('div');
        filterBar.className = 'feed-filter-bar';
        filterBar.innerHTML = `<i class="fa-solid fa-filter"></i> Showing: <strong>${_activePillFilter.toUpperCase()}</strong> <button onclick="filterByPill('${_activePillFilter}')" class="filter-clear-btn"><i class="fa-solid fa-xmark"></i> Clear</button>`;
        frag.appendChild(filterBar);
    }

    // Flashing alert if critical incidents are still waiting for response
    const criticals = needs.filter(r => r.severity === 'CRITICAL');
    if (criticals.length > 0) frag.appendChild(createAlertBanner(criticals.length));

    // Three collapsible sections
    frag.appendChild(createQueueSection('needs',      '<i class="fa-solid fa-circle-exclamation"></i> PENDING',    needs,      'qrt-section-needs'));
    frag.appendChild(createQueueSection('dispatched', '<i class="fa-solid fa-truck-medical"></i> RESPONDING',     dispatched, 'qrt-section-dispatched'));
    frag.appendChild(createQueueSection('resolved',   '<i class="fa-solid fa-circle-check"></i> RESOLVED',        resolved,   'qrt-section-resolved'));

    el.appendChild(frag);
    const _fcb = document.getElementById('feed-count-badge');
    if (_fcb) _fcb.textContent =
        needs.length > 0 ? `${needs.length} Pending` : 'All Clear';
}

// Phase F.8.b (May 2026) - Offline-sync honest sort key.
// Returns the report's TRIAGE timestamp - the moment the operator
// should reason about. For online reports this is identical to
// server_created_at (received = captured ± seconds). For offline-
// queued reports that drained N minutes / hours later, this is
// client_created_at so the report's place in the priority queue
// matches when the reporter actually witnessed the event.
//
// Threshold: when server_created_at - client_created_at > 5 min,
// trust client_created_at. The 5-min buffer absorbs normal
// clock-skew + network jitter so we don't flap on every report.
const _F8_STALE_THRESHOLD_MS = 5 * 60 * 1000;

function _priorityTime(r) {
    const s = r.server_created_at ? new Date(ensureUTC(r.server_created_at)).getTime() : null;
    const c = r.client_created_at ? new Date(ensureUTC(r.client_created_at)).getTime() : null;
    if (s == null) return c;
    if (c == null) return s;
    // If server received WAY later than client capture, this is a
    // drained-offline submission - use client_created_at so priority
    // sorting honours capture time rather than drain time.
    if (s - c > _F8_STALE_THRESHOLD_MS) return c;
    return s;
}

function _isStaleArrival(r) {
    const s = r.server_created_at ? new Date(ensureUTC(r.server_created_at)).getTime() : null;
    const c = r.client_created_at ? new Date(ensureUTC(r.client_created_at)).getTime() : null;
    if (s == null || c == null) return false;
    return (s - c) > _F8_STALE_THRESHOLD_MS;
}

function sortByPriorityDesc(a, b) {
    // 1. Severity (CRITICAL first)
    const ds = (SEV_PRIORITY[b.severity] || 0) - (SEV_PRIORITY[a.severity] || 0);
    if (ds !== 0) return ds;
    // 2. Infrastructure criticality (hospitals, power before roads, houses)
    const dw = (INFRA_WEIGHTS[b.infrastructure_type] || 1) - (INFRA_WEIGHTS[a.infrastructure_type] || 1);
    if (dw !== 0) return dw;
    // 3. Recency (newest-captured first - Phase F.8.b uses
    //    _priorityTime so drained-offline reports don't pretend to be
    //    "just now").
    return _priorityTime(b) - _priorityTime(a);
}

// ── Sort Functions ───────────────────────────────────────────────────────────

window.setCardSortMode = function (mode) {
    cardSortMode = mode;
    // Update active state on buttons
    document.querySelectorAll('.sort-opt').forEach(b => b.classList.toggle('active', b.dataset.sort === mode));
    document.querySelector('.sort-dropdown')?.classList.remove('open');
    renderFeed();
};

function getSortFunction() {
    // UNDP Appendix-1 labels (April 2026 rename). NO_DAMAGE kept for legacy
    // rows written before the normalisation hook landed.
    const DAMAGE_ORDER = { COMPLETE: 3, PARTIAL: 2, MINIMAL: 1, NO_DAMAGE: 1 };
    const SOURCE_ORDER = { IVR: 6, SMS: 5, TELEGRAM: 4, WHATSAPP: 3, ANDROID: 2, APP: 1 };

    switch (cardSortMode) {
        case 'sla_breach':
            // Most overdue first: smallest (deadline - now) ascending.
            return (a, b) => _slaDeadline(a) - _slaDeadline(b);
        case 'newest':
            return (a, b) => new Date(b.server_created_at) - new Date(a.server_created_at);
        case 'oldest':
            return (a, b) => new Date(a.server_created_at) - new Date(b.server_created_at);
        case 'severity':
            return (a, b) => {
                const d = (SEV_PRIORITY[b.severity] || 0) - (SEV_PRIORITY[a.severity] || 0);
                return d !== 0 ? d : new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        case 'type':
            return (a, b) => {
                const ta = a.infrastructure_type || 'OTHER';
                const tb = b.infrastructure_type || 'OTHER';
                return ta < tb ? -1 : ta > tb ? 1 : new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        case 'has_media':
            return (a, b) => {
                const ma = (a.media || []).filter(m => m.assembly_status === 'complete').length;
                const mb = (b.media || []).filter(m => m.assembly_status === 'complete').length;
                return mb - ma || new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        case 'confidence':
            return (a, b) => {
                // Composite Confidence Score (incident_credibility) - the value
                // shown on the card + detail, not the AI-only sub-score.
                const sa = (a.incident_credibility && a.incident_credibility.assessed) ? a.incident_credibility.score : -1;
                const sb = (b.incident_credibility && b.incident_credibility.assessed) ? b.incident_credibility.score : -1;
                return sb - sa || new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        case 'crisis':
            return (a, b) => {
                const ca = a.crisis_type || 'ZZZ';
                const cb = b.crisis_type || 'ZZZ';
                return ca < cb ? -1 : ca > cb ? 1 : new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        case 'damage':
            return (a, b) => {
                const da = DAMAGE_ORDER[a.damage_classification] || 0;
                const db2 = DAMAGE_ORDER[b.damage_classification] || 0;
                return db2 - da || new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        case 'source':
            return (a, b) => {
                const sa = SOURCE_ORDER[a.source] || 0;
                const sb = SOURCE_ORDER[b.source] || 0;
                return sb - sa || new Date(b.server_created_at) - new Date(a.server_created_at);
            };
        default: // 'priority'
            return sortByPriorityDesc;
    }
}

function createAlertBanner(count) {
    const el = document.createElement('div');
    el.className = 'qrt-alert-banner';
    el.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${count} CRITICAL incident${count > 1 ? 's' : ''} - immediate response required`;
    return el;
}

function createQueueSection(key, label, incidents, cssClass) {
    // A section that holds the SELECTED incident always renders EXPANDED so the
    // card is visible when we scroll to it (HELP SENT / CLOSED start collapsed by
    // default). This does NOT mutate the operator's saved collapse preference
    // (sectionState), which still governs every other section + later renders.
    const hasSelected = selectedId && incidents.some((r) => r.id === selectedId);
    const isOpen = hasSelected || sectionState[key] !== false;
    const sec = document.createElement('div');
    sec.className = `qrt-section ${cssClass}${isOpen ? '' : ' collapsed'}`;

    const header = document.createElement('div');
    header.className = 'qrt-section-header';
    header.innerHTML = `
        <span class="qrt-section-label">${label}</span>
        <span class="qrt-section-count">${incidents.length}</span>
        <i class="fa-solid fa-chevron-down qrt-section-chevron"></i>
    `;
    header.onclick = () => {
        sectionState[key] = !sectionState[key];
        sec.classList.toggle('collapsed');
    };
    sec.appendChild(header);

    const body = document.createElement('div');
    body.className = 'qrt-section-body';
    if (incidents.length === 0) {
        body.innerHTML = `<div class="qrt-empty"><i class="fa-solid fa-circle-check" style="opacity:0.35;"></i> None</div>`;
    } else {
        incidents.forEach(r => body.appendChild(createIncidentCard(r)));
    }
    sec.appendChild(body);
    return sec;
}

// Full data-integrity / provenance chip set, rendered in the DETAIL panel.
// The feed card was simplified to carry only a blocking ⚠ + the evidence chip
// (see createIncidentCard); this surfaces the complete media-integrity / PII
// state, original-upload progress, and crisis-form provenance on the detail
// panel so nothing is lost. Reuses the .k5a-chip / .qrt-orig-chip classes.
function _incidentStatusChips(r) {
    const media = r.media || [];
    const hasAbandon = (reason) => media.some(m => m && m.abandon_reason === reason && !m.recovered_at);
    const hasPii = (status) => media.some(m => m && m.pii_blur_status === status);
    const chips = [];
    if (hasAbandon('checksum_mismatch')) chips.push('<span class="k5a-chip k5a-chip-red" title="Media failed integrity check (checksum mismatch). Bytes are corrupt - only a fresh upload can recover."><i class="fa-solid fa-triangle-exclamation"></i> Media corrupt</span>');
    if (hasAbandon('chunks_never_arrived') || hasAbandon('assembly_worker_lost')) chips.push('<span class="k5a-chip k5a-chip-red" title="Upload abandoned after the freshness window. Use the Reclaim action below."><i class="fa-solid fa-satellite-dish"></i> Upload abandoned</span>');
    if (hasPii('failed')) chips.push('<span class="k5a-chip k5a-chip-red" title="PII blur (face / text redaction) failed. Review manually before sharing."><i class="fa-solid fa-eye-low-vision"></i> Redaction failed</span>');
    if (hasPii('pending')) chips.push('<span class="k5a-chip k5a-chip-amber" title="Image is being scanned for PII; the public URL is gated until the scan completes."><i class="fa-solid fa-shield-halved"></i> Checking PII…</span>');
    if (hasPii('complete_with_redactions')) chips.push('<span class="k5a-chip k5a-chip-green" title="Faces / PII text were detected and automatically blurred. Safe to share."><i class="fa-solid fa-shield-check"></i> Auto-redacted</span>');
    if (hasAbandon('bandwidth_tier_deferred')) chips.push('<span class="k5a-chip k5a-chip-amber" title="Higher-quality variant not delivered (slow network). SMALL preview is available; the original auto-retries when bandwidth allows."><i class="fa-solid fa-signal"></i> Original (slow network)</span>');
    if (hasAbandon('storage_evicted')) chips.push('<span class="k5a-chip k5a-chip-amber" title="Full-resolution upload deferred to free device storage after the preview delivered. The SMALL preview is available; the original auto-retries when space + connectivity allow."><i class="fa-solid fa-database"></i> Original (deferred — storage)</span>');
    if (r.submitted_as_anonymous_due_to_expired_token) chips.push('<span class="k5a-chip k5a-chip-grey" title="Reporter token had expired at drain time; submission accepted anonymously."><i class="fa-solid fa-unlock"></i> Attribution lost</span>');
    if (r.sync_status === 'PARTIAL' && media.some(m => m && m.assembly_status === 'pending')) chips.push('<span class="k5a-chip k5a-chip-amber" title="Report still progressing - some chunks pending."><i class="fa-solid fa-hourglass-half"></i> Uploading…</span>');
    const groups = groupPhotos(media.filter(m => m.type === 'IMAGE'));
    const ageMs = r.server_created_at ? Date.now() - new Date(r.server_created_at).getTime() : 0;
    let lost = 0, delayed = 0, uploading = 0, missingFresh = 0;
    for (const g of groups) {
        const st = _classifyHighTier(g, ageMs);
        if (st === 'lost') lost++; else if (st === 'delayed') delayed++;
        else if (st === 'uploading') uploading++; else if (st === 'missing-fresh') missingFresh++;
    }
    const pend = lost + delayed + uploading + missingFresh;
    if (pend > 0 && groups.length > 0) {
        const state = lost ? 'lost' : delayed ? 'delayed' : uploading ? 'uploading' : 'missing-fresh';
        const ic = { lost: 'fa-circle-xmark', delayed: 'fa-clock', uploading: 'fa-cloud-arrow-up fa-pulse', 'missing-fresh': 'fa-cloud-arrow-up fa-pulse' }[state];
        const lb = { lost: 'LOST', delayed: 'DELAYED', uploading: 'ORIG', 'missing-fresh': 'ORIG' }[state];
        chips.push(`<span class="qrt-orig-chip qrt-orig-chip-${state}" title="Original-quality upload status"><i class="fa-solid ${ic}"></i> ${lb} <span class="qrt-orig-chip-pct">${pend}/${groups.length}</span></span>`);
    }
    if (r.form_pack_id) chips.push(`<span class="k5a-chip" style="background:rgba(34,211,238,0.14);color:#67e8f9;" title="Submitted via a Dynamic Crisis Form pack${r.form_pack_version ? ' (v' + r.form_pack_version + ')' : ''}"><i class="fa-solid fa-clipboard-list"></i> Crisis form</span>`);
    return chips.join('');
}
window._incidentStatusChips = _incidentStatusChips;   // test hook + detail-panel reuse

// Duplicate collapse: the "N duplicates" chip the PRIMARY card wears once an analyst
// has merged corroborating reports beneath it. duplicate_count is the number of
// merged-away duplicates (server-derived); the incident itself plus its duplicates =
// N+1 corroborating reports. The chip is now an EXPANDER (neutral, not a competing
// metric): clicking it reveals the merged duplicate reports NESTED + dimmed under the
// card, so "all incidents incl. duplicates" stay visible while the building roll-up
// count stays merged. Returns '' for ordinary reports so the card stays scannable.
function _dupMergedBadge(r) {
    const n = (r && r.duplicate_count) || 0;
    if (!n) return '';
    const corro = n + 1;
    const bid = r && r.building_id;
    const base = 'display:inline-flex;align-items:center;gap:4px;background:rgba(148,163,184,.12);color:#93a3b8;border:none;border-radius:6px;padding:2px 7px;font-size:11px;font-weight:600';
    const label = `<i class="fa-solid fa-link"></i> ${n} duplicate${n > 1 ? 's' : ''}`;
    // Building-less clusters (h3 / singleton) have no in-building duplicates to
    // expand (duplicate review is building-scoped) → plain read-only chip.
    if (!bid) {
        return `<span class="qrt-dup-merged" title="${n} duplicate report${n > 1 ? 's' : ''} merged under this incident · ${corro} corroborating reports total."` +
            ` style="${base};cursor:default">${label}</span>`;
    }
    const idJs = `decodeURIComponent('${encodeURIComponent(r.id)}')`;
    return `<span class="qrt-dup-merged" role="button" tabindex="0" aria-expanded="false" data-dup-toggle="${escapeAttr(r.id)}"` +
        ` title="${n} duplicate report${n > 1 ? 's' : ''} merged under this incident · ${corro} corroborating reports total. Click to show them."` +
        ` onclick="event.stopPropagation();window.toggleDupChildren(${idJs},this)"` +
        ` onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();window.toggleDupChildren(${idJs},this);}"` +
        ` style="${base};cursor:pointer">${label} <i class="fa-solid fa-chevron-down qrt-dup-twist"></i></span>`;
}
window._dupMergedBadge = _dupMergedBadge;

// Expand/collapse the merged duplicate reports under a primary incident card. The
// duplicates are rendered as dimmed sub-rows nested inside the building rail (so the
// list shows every incident incl. duplicates, while the building header keeps the
// merged count). Lazy: fetched once from GET /{id}/duplicates (confirmed pairs only),
// cached on the card element. Read-only here — merge/undo controls stay in the
// building console (reached via the building name).
window.toggleDupChildren = async function (reportId, badgeEl) {
    const card = badgeEl && badgeEl.closest && badgeEl.closest('.qrt-card');
    if (!card) return;
    const host = card.closest('.opg-inc') || card.parentElement;   // sit under the card, inside the teal rail
    let box = card._dupChildrenBox;
    if (box && box.isConnected) {
        const hidden = box.style.display === 'none';
        box.style.display = hidden ? '' : 'none';
        badgeEl.classList.toggle('expanded', hidden);
        badgeEl.setAttribute('aria-expanded', hidden ? 'true' : 'false');
        return;
    }
    box = document.createElement('div');
    box.className = 'qrt-dup-children';
    box.innerHTML = '<div class="qrt-dup-empty">Loading duplicates…</div>';
    if (card.nextSibling) host.insertBefore(box, card.nextSibling); else host.appendChild(box);
    card._dupChildrenBox = box;
    badgeEl.classList.add('expanded');
    badgeEl.setAttribute('aria-expanded', 'true');
    try {
        const res = await fetch(`${API}/${encodeURIComponent(reportId)}/duplicates`,
            { headers: { Authorization: 'Bearer ' + (localStorage.getItem('crisp_token') || '') } });
        const data = res.ok ? await res.json() : { candidates: [] };
        const confirmed = ((data && data.candidates) || []).filter((c) => c && c.confirmed);
        if (!confirmed.length) { box.innerHTML = '<div class="qrt-dup-empty">No merged duplicates to show.</div>'; return; }
        box.innerHTML = confirmed.map((c) => {
            const sev = String(c.severity || 'UNKNOWN').toUpperCase();
            const col = SEV_COLORS[sev] || SEV_COLORS.UNKNOWN;
            const what = infraDisplayLabel(c.infrastructure_type || 'OTHER') || (c.crisis_type || 'Incident');
            const when = c.server_created_at ? timeAgo(c.server_created_at) : '';
            const where = c.location_name || '';
            const idJs = `decodeURIComponent('${encodeURIComponent(c.report_id)}')`;
            return `<div class="qrt-dup-child" role="button" tabindex="0"` +
                ` title="Duplicate of this incident — open it"` +
                ` onclick="event.stopPropagation();window.openIncident&&window.openIncident(${idJs})"` +
                ` onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();window.openIncident&&window.openIncident(${idJs});}">` +
                `<i class="fa-solid fa-angle-right qrt-dup-child-ic"></i>` +
                `<span class="qrt-dup-child-sev" style="background:${col}"></span>` +
                `<span class="qrt-dup-child-what">${escapeHtml(what)}</span>` +
                (where ? `<span class="qrt-dup-child-where">${escapeHtml(where)}</span>` : '') +
                `<span class="qrt-dup-child-tag">duplicate</span>` +
                (when ? `<span class="qrt-dup-child-time">${escapeHtml(when)}</span>` : '') +
                `</div>`;
        }).join('');
    } catch (_e) {
        box.innerHTML = '<div class="qrt-dup-empty">Could not load duplicates.</div>';
    }
};

function createIncidentCard(r, incCtx) {
    const card = document.createElement('div');
    const isSelected = (typeof _bulkSelectedIds !== 'undefined') && _bulkSelectedIds.has(r.id);
    card.className = `qrt-card ${selectedId === r.id ? 'selected' : ''} ${isSelected ? 'bulk-checked' : ''}`;
    // Multi-report incident context (set by _renderIncidentGroup): the card is the
    // incident's LEAD; it wears an "N reports" expander (see meta row) + clicking it
    // opens the Incident Detail (members/merge/split), not the single report.
    const _isInc = !!(incCtx && incCtx.incidentId && incCtx.reportCount > 1);
    if (incCtx) { card._incidentMembers = incCtx.members || []; card._incidentId = incCtx.incidentId || null; }
    // Phase F image-reliability (May 2026) - expose the report id on
    // the card element so e2e specs + operator devtools can scope to
    // a specific card without doing visibility heuristics or relying
    // on `:first` (which is brittle once the progressive-reveal
    // virtualizer at line ~1511 starts hiding cards beyond index 50).
    // Specifically required by tests/dashboard/07-multi-image-gallery
    // ("per-card ORIG chip surfaces on reports with incomplete LARGE"),
    // which used to be lucky-passing when the dev DB had < 50 reports
    // and became flaky once F1's sweep tests grew the DB past that
    // threshold and sank the synthetic-MODERATE report below the
    // visibility horizon.
    card.dataset.reportId = r.id;
    card.dataset.id = r.id;   // for CrispNav.markSelected highlight/scroll
    card.onclick    = (ev) => {
        // Phase G.5 - checkbox click is opt-in; clicking elsewhere on
        // the card still opens the detail panel via the existing path.
        if (ev.target && ev.target.classList && ev.target.classList.contains('qrt-bulk-check')) return;
        // A multi-report incident drills into the Incident Detail (members/merge/split);
        // a single-report incident opens the report directly.
        if (_isInc && window.openIncidentDetail) { window.openIncidentDetail(incCtx.incidentId); return; }
        window.openIncident(r.id);   // unified: deep-link + op-aware
    };
    card.onmouseenter = () => _armIncidentPreview(r, card);
    card.onmouseleave = _disarmIncidentPreview;

    const sev   = r.severity || 'UNKNOWN';
    const infra = r.infrastructure_type || 'OTHER';

    // WHERE - prefer user-named location, fall back to device name, then coords
    const loc     = r.location;
    const locText = loc?.user_location_name
                 || loc?.device_location_name
                 || (loc ? `${loc.latitude.toFixed(3)}, ${loc.longitude.toFixed(3)}` : 'Location unknown');

    // Footer signals now come from the shared helpers (see _confidenceChip /
    // _cardActionEl above): the composite Confidence Score + band, the
    // verdict-aware status pill, and the Notify-Responders CTA. This replaced the
    // old inline "SEND HELP" button + the satellite-sub-score evidence chip so the
    // card mirrors the incident-detail workflow exactly.

    // Only a BLOCKING data-integrity / privacy issue stays on the card - a single
    // labeled red chip (corrupt / abandoned / redaction-failed) that says "open
    // this report to resolve". The full non-blocking chip set (PII-pending,
    // slow-network, attribution, uploading, orig-pending, crisis form) lives in
    // the detail panel's dp-status-chips row (see _incidentStatusChips).
    const _media = r.media || [];
    const _hasAbandonReason = (reason) => _media.some(m => m && m.abandon_reason === reason && !m.recovered_at);
    const _hasPiiBlurStatus = (status) => _media.some(m => m && m.pii_blur_status === status);
    let _blockingFlag = '';
    if (_hasAbandonReason('checksum_mismatch')) {
        _blockingFlag = '<span class="k5a-chip k5a-chip-red" title="Media failed integrity check (checksum mismatch) - bytes are corrupt. Open the report to resolve."><i class="fa-solid fa-triangle-exclamation"></i> Media corrupt</span>';
    } else if (_hasAbandonReason('chunks_never_arrived') || _hasAbandonReason('assembly_worker_lost')) {
        _blockingFlag = '<span class="k5a-chip k5a-chip-red" title="Upload abandoned after the freshness window. Open the report to reclaim."><i class="fa-solid fa-satellite-dish"></i> Upload abandoned</span>';
    } else if (_hasPiiBlurStatus('failed')) {
        _blockingFlag = '<span class="k5a-chip k5a-chip-red" title="PII redaction failed - review manually before sharing."><i class="fa-solid fa-eye-low-vision"></i> Redaction failed</span>';
    }

    // Phase G.5 - bulk-select checkbox at top-left. Visible only when
    // multi-select mode is enabled (operator toggled the toolbar
    // button); otherwise stays out of the way.
    const bulkChk = (typeof _bulkSelectMode !== 'undefined' && _bulkSelectMode)
        ? `<input type="checkbox" class="qrt-bulk-check"
                  ${isSelected ? 'checked' : ''}
                  onclick="event.stopPropagation(); _toggleBulkSelectId('${r.id}', this.checked);"
                  title="Select for bulk action" />`
        : '';

    // The card sits UNDER its building in the feed (building cluster / Console /
    // op→building group), so it must NOT repeat the building name (the parent header
    // already shows it) - see feedback_no_redundant_parent_context. A building-tagged
    // card leads with WHAT WAS HIT (the infra display label); an untagged card keeps
    // its own free-text name (or the infra label). The building summary is reached
    // from the building header, not the card title - so the title is plain text and
    // the card click opens the INCIDENT (single, unambiguous action).
    const _titlePlain = _hasBuildingLink(r)
        ? infraDisplayLabel(infra, r.infrastructure_sub_type)
        : (r.infrastructure_name || infraDisplayLabel(infra, r.infrastructure_sub_type));
    // No separate infra-type chip: the title now carries the infra label, so a chip
    // would duplicate it (redundancy). crisis/damage chips still distinguish the card.
    const _titleEl = `<span class="qrt-infra-name" title="${escapeAttr(_titlePlain)}">${escapeHtml(_titlePlain)}</span>`;
    const _src = (r.source || 'APP');
    const _srcTitle = { APP: 'Mobile App', ANDROID: 'Android App', WHATSAPP: 'WhatsApp', TELEGRAM: 'Telegram', SMS: 'SMS', IVR: 'Voice Call' }[_src] || 'Mobile App';
    const _srcIcon = { APP: '<i class="fa-solid fa-mobile-screen-button"></i>', ANDROID: '<i class="fa-solid fa-robot"></i>', WHATSAPP: '<i class="fa-brands fa-whatsapp"></i>', TELEGRAM: '<i class="fa-brands fa-telegram"></i>', SMS: '<i class="fa-solid fa-comment-sms"></i>', IVR: '<i class="fa-solid fa-phone"></i>' }[_src] || '<i class="fa-solid fa-mobile-screen-button"></i>';
    // Card declutter (v137): the severity TEXT badge, the status pill ("Needs review" —
    // redundant inside a status tab), and the Notify CTA are NO LONGER on the card. The
    // severity LEFT strip carries severity; the active status tab carries status; Notify
    // + the full action set live in the hover preview + detail panel. _verdict is still
    // used below for the rejected-tab reason chip.
    const _verdict = r.reviewer_verdict || 'NOT_REVIEWED';
    const _whenInner = _isStaleArrival(r)
        ? `<span class="qrt-stale" title="Captured offline ${escapeAttr(timeAgo(r.client_created_at))}, received ${escapeAttr(timeAgo(r.server_created_at))}"><i class="fa-solid fa-cloud-arrow-up"></i> ${escapeHtml(timeAgo(r.client_created_at))}</span>`
        : escapeHtml(timeAgo(r.server_created_at));

    // Density-optimised two-row card (≈half the old height). Row 1 = the triage line
    // (what · severity · source · status); row 2 = the meta line (where · when ·
    // confidence · merged-dups · blocking · Notify). Compact view shows row 1 only.
    // Everything not on the card (crisis/damage tags, media thumbnails, full location)
    // appears in the hover preview — no loss of information.
    card.innerHTML = `
        ${bulkChk}
        <div class="qrt-sev-strip strip-${sev}"></div>
        <div class="qrt-card-body">
            <div class="qrt-what">
                ${_titleEl}
                <span class="qrt-source-badge qrt-src-${_src.toLowerCase()}" title="Source: ${_srcTitle}">${_srcIcon}</span>
            </div>
            <div class="qrt-meta">
                <span class="qrt-where"><i class="fa-solid fa-location-dot"></i><span class="qrt-where-text" title="${escapeAttr(locText)}">${escapeHtml(locText)}</span></span>
                <span class="qrt-when"><i class="fa-regular fa-clock"></i>${_whenInner}</span>
                ${_confidenceChip(r)}
                ${_isInc ? _incidentExpander(r, incCtx) : _dupMergedBadge(r)}
                ${_blockingFlag}
                ${(_verdict === 'REJECTED' && r.action_taken) ? `<span class="qrt-reject-reason" title="Rejection reason: ${escapeAttr(r.action_taken)}"><i class="fa-solid fa-circle-xmark"></i> ${escapeHtml(r.action_taken)}</span>` : ''}
            </div>
        </div>
    `;
    return card;
}

// Compat stub. The Buildings/All-Incidents view toggle was retired in the Jun 2026
// feed simplification - the feed is ALWAYS building-grouped now and status is the
// 3-tab axis. Legacy callers (saved views, old deep-links, setBuildingScope, the
// dup-review panel) still call this; it just re-renders.
window.setViewMode = function(mode) {
    // 'buildings' (default, building-grouped) | 'queue' = the flat "All Incidents"
    // escape hatch — expands every cluster so all incident cards are directly
    // visible as one list (used when the operator wants the raw feed, not the
    // building roll-up). Unknown modes are ignored (keep the current view).
    if (mode === 'buildings' || mode === 'queue') viewMode = mode;
    try { renderFeed(); } catch (_e) {}
};

// ── Tree Mode: original hierarchical feed ─────────────────────────────────────
function renderTreeFeed(el) {
    // Operational queue (attention-panel deep link) - replaces status/time.
    let filtered = _activeQueue ? _applyQueueFilter(allReports)
        : allReports.filter(r => {
            if (statusFilter === 'all') return true;
            const s = r.status;
            if (statusFilter === 'active') return s === 'PENDING' || s === 'VERIFIED';
            return s.toLowerCase() === statusFilter.toLowerCase();
        });
    // Filter by time
    if (!_activeQueue && timeFilterHours > 0) {
        const cutoff = Date.now() - timeFilterHours * 3600000;
        // K.5.b - use _priorityTime so offline-drained reports stay visible
        // by capture time, not the late server-receive timestamp.
        filtered = filtered.filter(r => _priorityTime(r) > cutoff);
    }
    // Filter by search
    if (treeSearchTerm) {
        filtered = filtered.filter(r => {
            const haystack = [
                r.description, r.infrastructure_type, r.severity, r.status, r.source,
                r.location?.user_location_name, r.location?.device_location_name,
                r._region, r._country, r.ai_analysis?.transcription, r.ai_analysis?.ai_summary,
            ].filter(Boolean).join(' ').toLowerCase();
            return haystack.includes(treeSearchTerm);
        });
    }
    // Phase G.1 - apply stacking chip filters in tree mode too, so the
    // operator's chip selection persists across view-mode switches.
    if (_activeChipFilters.size) {
        filtered = filtered.filter(_passesChipFilters);
    }
    el.innerHTML = '';
    _lastTreeFiltered = filtered;   // export parity - see exportNodeData
    const frag = document.createDocumentFragment();
    const tree = buildControlPanelTree(filtered);
    renderTreeLevel(frag, tree, 0, '');
    el.appendChild(frag);
    const _fcb = document.getElementById('feed-count-badge');
    if (_fcb) _fcb.textContent = `${filtered.length} Active`;
    // Update status tab highlights
    document.querySelectorAll('.stab').forEach(btn => btn.classList.remove('active'));
    const activeTab = document.getElementById(`stab-${statusFilter}`);
    if (activeTab) activeTab.classList.add('active');
}

/** Get the time-filtered report set (shared by stats, analytics, and map) */
// Phase G.4 - Single-crisis drill-down filter. Layers on top of the
// G.1 chip filter set without colliding with the existing chip ids.
// Set by clicking a crisis-type bar in the analytics panel; cleared
// by clicking the same bar again or by clearing all chip filters.
let _crisisDrillFilter = null;

function _getFilteredReports() {
    let reports = _applyQueueFilter(allReports);
    if (!_activeQueue && timeFilterHours > 0) {
        const cutoff = Date.now() - timeFilterHours * 3600000;
        // K.5.b - use _priorityTime for offline-aware time filter.
        reports = reports.filter(r => _priorityTime(r) > cutoff);
    }
    if (_crisisDrillFilter != null) {
        reports = reports.filter(r => (r.crisis_type || 'UNKNOWN') === _crisisDrillFilter);
    }
    return reports;
}

// C1-b: fetch the server's scope-aware operational summary so the KPI strip and
// the context-banner total can show TRUE scope counts when the feed is truncated
// (the working set is only the newest N). Scoped by crisis_event_id when an
// operation is active; on any error it leaves _scopeSummary null so the client
// compute (correct at small scale) still drives the strip.
async function _fetchScopeSummary() {
    try {
        const base = API.replace('/api/v1/reports', '/api/v1/analytics/summary');
        const url = base + (_activeCrisisEventId
            ? '?crisis_event_id=' + encodeURIComponent(_activeCrisisEventId) : '');
        const res = await fetch(url);   // auth header injected by the interceptor
        if (!res.ok) { _scopeSummary = null; return; }
        const body = await res.json();
        _scopeSummary = (body && body.counts) ? body : null;
        // Re-render now that authoritative counts are in.
        try { updateCommandStats(); } catch (_e) {}
        try { _renderContextBanner(); } catch (_e) {}
    } catch (_e) { _scopeSummary = null; }
}

// C1-c: fetch the FULL lean marker set (id + coords + severity/status/type, up
// to 20k) for the active scope so the main map plots a representative Common
// Operating Picture at scale instead of the truncated newest-N working set
// (SCALE-04). Normalised into report-shaped objects so the existing marker
// builder consumes them unchanged (no media → no thumbnail in the hover
// tooltip; the click still opens the full report via the lazy by-id fetch).
async function _fetchMapMarkers() {
    try {
        const base = API.replace('/api/v1/reports', '/api/v1/reports/markers');
        const params = new URLSearchParams();
        params.set('limit', '20000');
        if (_activeCrisisEventId) params.set('crisis_event_id', _activeCrisisEventId);
        const res = await fetch(base + '?' + params.toString());   // auth via interceptor
        if (!res.ok) { _scopeMarkers = null; return; }
        const rows = await res.json();
        _scopeMarkers = (Array.isArray(rows) ? rows : []).map((m) => ({
            id: m.id,
            severity: m.severity,
            status: m.status,
            crisis_type: m.crisis_type,
            infrastructure_type: m.infrastructure_type,
            crisis_event_id: m.crisis_event_id || null,   // ROUTE-04: preserve op context for lean-marker clicks
            duplicate_count: m.duplicate_count || 0,      // duplicate collapse: drives the pin's "N reports" count
            server_created_at: m.server_created_at,
            location: { latitude: m.lat, longitude: m.lng },
            media: [],
            _lean: true,
        }));
        try { updateMapMarkers(); } catch (_e) {}
    } catch (_e) { _scopeMarkers = null; }
}

function updateCommandStats() {
    // Scope-aware (building/triage): the tab badges + Critical count reflect the
    // CURRENT scope, not the whole op/global set.
    const reports = _applyScopeFilter(_getFilteredReports());
    let critical = 0, responding = 0, resolved = 0, pending = 0;

    reports.forEach(r => {
        // CONSISTENCY CONTRACT: a REJECTED report is set aside (its own tab/count) and
        // is excluded from every open/active/critical tally — matching the backend
        // `active` filter + the feed's _applyQueueFilter. Without this skip a rejected
        // PENDING report inflated Pending/Critical so the strip disagreed with the feed.
        if (r.reviewer_verdict === 'REJECTED') return;
        // "Critical" = OPEN (not closed) severity-CRITICAL, matching the backend
        // counts.critical (active CRITICAL) + the 'critical' queue. A resolved critical
        // is closed, not an open critical, so the badge agrees with the home tile.
        if (r.severity === 'CRITICAL' && r.status !== 'RESOLVED' && r.status !== 'FALSE_ALARM') critical++;
        if (r.status === 'RESPONDING') responding++;
        if (r.status === 'RESOLVED' || r.status === 'FALSE_ALARM') resolved++;
        if (r.status === 'PENDING' || r.status === 'VERIFIED') pending++;
    });
    let total = reports.length;

    // C1-b: when the scope is TRUNCATED and NO narrowing filter is active, the
    // client tallies above are over the newest-N window only (wrong-low). Prefer
    // the server's scope summary so the headline strip reflects ALL reports.
    // Any active filter makes the client tally the correct "what I see" number,
    // so we keep the client values then (and at small scale there is no summary).
    if (_scopeAggregatesActive() && _scopeSummary && _scopeSummary.counts) {
        // Single source of truth: read the EXPLICIT backend counts (same ones the home
        // Command Centre tiles use) rather than deriving from active/total, so the tabs
        // and the home tiles always agree. All exclude rejected (backend `active`).
        const sc = _scopeSummary.counts;
        const tot = Number(_scopeSummary.total_reports) || Number(sc.reports) || 0;
        critical = Number(sc.critical) || 0;            // active CRITICAL, rejected-excluded
        responding = Number(sc.active_ops) || 0;        // status == RESPONDING
        resolved = Number(sc.resolved) || 0;            // status == RESOLVED (explicit)
        pending = Number(sc.pending != null ? sc.pending
                         : Math.max(0, (Number(sc.active) || 0) - responding));  // status PENDING, rejected-excluded
        total = tot;
    }

    const _set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    _set('count-critical', critical);
    _set('count-pending', pending);
    _set('count-responding', responding);
    _set('count-resolved', resolved);
    _set('count-total', total);   // #count-total was retired from the strip (Total is now in the breadcrumb); no-op if absent
    // B3: re-paint the tab enabled/empty state now that the fresh counts are set
    // (mutes any Pending/Responding/Resolved tab whose bucket is 0).
    try { _syncStatusTabsEnabled(); } catch (_e) {}

    // Rejected entry (Filters popover): count + show only when there are any and
    // we're not already viewing them.
    const rejectedCount = (allReports || []).filter((r) => r.reviewer_verdict === 'REJECTED').length;
    _set('count-rejected', rejectedCount);   // the Rejected status TAB badge
    const rejCnt = document.getElementById('cmd-rejected-count');
    if (rejCnt) rejCnt.textContent = rejectedCount;
    const rejBtn = document.getElementById('cmd-filter-rejected');
    if (rejBtn) rejBtn.style.display = (rejectedCount > 0 && _activeQueue !== 'rejected') ? '' : 'none';

    // Phase C.2 - Originals-pending count. Show the pill only when > 0
    // so the command bar doesn't grow a permanent "0 ORIG PENDING" chip
    // (which would mislead operators into thinking it's broken).
    //
    // Phase F image-reliability (May 2026). The pill counts reports that
    // have at least one HIGH-tier variant in `uploading` / `delayed` /
    // `lost` / `missing-fresh` - i.e. any tri-state OTHER than
    // `complete` or `missing-old`. Pre-fix this counter conflated all
    // non-complete states under one label which never decremented when
    // the backend gave up (no terminal state existed yet). Now the
    // counter falls to zero correctly once the sweep abandons stuck
    // rows AND the operator dismisses them via the Reclaim button or
    // they age past the 14-day horizon.
    let origPending = 0;
    for (const r of reports) {
        const imgs = (r.media || []).filter(m => m.type === 'IMAGE');
        if (imgs.length === 0) continue;
        const ageMs = r.server_created_at
            ? Date.now() - new Date(r.server_created_at).getTime()
            : 0;
        const grps = groupPhotos(imgs);
        if (grps.some(g => {
            const st = _classifyHighTier(g, ageMs);
            return st === 'lost' || st === 'delayed' ||
                   st === 'uploading' || st === 'missing-fresh';
        })) {
            origPending += 1;
        }
    }
    _set('count-originals-pending', origPending);
    const origPill = document.getElementById('stat-originals-pending');
    if (origPill) origPill.style.display = origPending > 0 ? '' : 'none';

    // Average wait time of pending reports
    const pendingReports = reports.filter(r => r.status === 'PENDING' || r.status === 'VERIFIED');
    if (pendingReports.length > 0) {
        const avgWaitMs = pendingReports.reduce((s, r) => s + (Date.now() - new Date(ensureUTC(r.server_created_at)).getTime()), 0) / pendingReports.length;
        const avgMin = Math.round(avgWaitMs / 60000);
        _set('count-avg-response', avgMin < 60 ? `${avgMin}m` : `${Math.floor(avgMin/60)}h${avgMin%60 > 0 ? ' ' + avgMin%60 + 'm' : ''}`);
    } else {
        _set('count-avg-response', '✓');
    }

    // Pulse critical when there are critical incidents pending.
    // Phase F.1.b renamed the class from `pulse-attention` (legacy
    // .stat-pill) to `active-pulse` to match the new segmented
    // control's CSS keyframe. The element id (#stat-critical) is
    // preserved across both versions.
    const critEl = document.getElementById('stat-critical');
    if (critEl) critEl.classList.toggle('active-pulse', critical > 0 && pending > 0);

    // Update analytics if panel is open
    if (document.getElementById('analytics-panel')?.style.display !== 'none') _renderAnalytics();
}

// ── Status-filter selection: click a segmented-control item to filter the feed ──
//
// Phase F.1.b - the five separate .stat-pill elements were replaced by
// one segmented control (.cmd-status-seg with .cmd-status-seg-item
// children). Selection lookup is now by id (#stat-critical etc.) which
// is stable across the redesign; the active class moved from
// `.pill-active` on `.clickable-pill` to plain `.active` on
// `.cmd-status-seg-item`.
let _activePillFilter = null;

window.filterByPill = function (type) {
    // Toggle: click the same control again to clear. Lifecycle (pending/responding/
    // resolved) are now TABS; the only interactive pill is the cross-cutting
    // 'critical' chip (+ the command-bar originals-pending chip).
    _activePillFilter = (_activePillFilter === type) ? null : type;
    const crit = document.getElementById('stat-critical');
    if (crit) crit.classList.toggle('on', _activePillFilter === 'critical');
    const op = document.getElementById('stat-originals-pending');
    if (op) op.classList.toggle('active', _activePillFilter === 'originals_pending');
    renderFeed();
};

// Phase G.1 (May 2026) - Stacking multi-filter chips.
//
// State: `_activeChipFilters` is a Set<string> of chip ids. Empty set
// means no chip filter is active. Multiple chips stack with AND
// semantics between chip dimensions and OR semantics within the
// damage dimension (so dmg-complete + dmg-partial both selected
// matches reports with either damage class - not zero rows).
//
// Persistence: localStorage (cross-session) + URL hash (deep-linkable
// to a colleague). URL hash takes precedence on page load so a deep-
// linked URL beats whatever the operator had stashed locally.
//
// Render pipeline: `_passesChipFilters(r)` predicate is applied after
// the existing time + status pill filters in both `renderTriageQueue`
// (queue mode) and `renderTreeFeed` (tree mode). Filter chips are
// VIEW-MODE-INDEPENDENT - selecting "Debris clearing" filters the
// same set of reports in either mode.
const CHIP_FILTERS_LS_KEY = 'crisp_dashboard_chip_filters_v1';
let _activeChipFilters = new Set();

function _restoreChipFiltersFromStorage() {
    try {
        // URL hash takes precedence so deep-links work even after a
        // cross-session localStorage stash.
        const hash = window.location.hash || '';
        const m = hash.match(/(?:^#|;)chips=([^;]+)/);
        if (m) {
            for (const id of m[1].split(',')) {
                if (id) _activeChipFilters.add(id);
            }
            // Mirror to localStorage so a subsequent tab without the
            // hash still sees the same filter set.
            localStorage.setItem(CHIP_FILTERS_LS_KEY, JSON.stringify([..._activeChipFilters]));
            return;
        }
        const raw = localStorage.getItem(CHIP_FILTERS_LS_KEY);
        if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
                for (const id of arr) _activeChipFilters.add(id);
            }
        }
    } catch (_) {
        // Defensive - bad JSON, no localStorage, etc. → start empty.
    }
}

function _persistChipFilters() {
    try {
        localStorage.setItem(CHIP_FILTERS_LS_KEY, JSON.stringify([..._activeChipFilters]));
    } catch (_) { /* quota / private-browsing → silent */ }
    // Update URL hash without triggering a navigation.
    try {
        const arr = [..._activeChipFilters];
        // Strip any existing chips= segment, preserve other hash params.
        const otherHash = (window.location.hash || '').replace(/(?:^#|;)chips=[^;]*/, '');
        const cleanHash = otherHash.replace(/^#/, '').replace(/^;/, '');
        const newHash = arr.length
            ? `#chips=${arr.join(',')}${cleanHash ? ';' + cleanHash : ''}`
            : (cleanHash ? `#${cleanHash}` : '');
        // Only update if it changed (avoid stacking history entries).
        if (window.location.hash !== newHash) {
            const url = window.location.pathname + window.location.search + newHash;
            history.replaceState(null, '', url);
        }
    } catch (_) { /* IE-style errors → ignore */ }
}

function _paintChipFilterUI() {
    document.querySelectorAll('.cmd-filter-chip').forEach(btn => {
        const id = btn.dataset.chip;
        btn.classList.toggle('active', _activeChipFilters.has(id));
    });
    const clearBtn = document.getElementById('cmd-filter-chip-clear');
    if (clearBtn) {
        clearBtn.style.display = _activeChipFilters.size > 0 ? '' : 'none';
    }
}

window.toggleChipFilter = function (chipId) {
    if (!chipId) return;
    if (_activeChipFilters.has(chipId)) {
        _activeChipFilters.delete(chipId);
    } else {
        _activeChipFilters.add(chipId);
    }
    _persistChipFilters();
    _paintChipFilterUI();
    renderFeed();
};

window.clearAllChipFilters = function () {
    const hadCrisis = (typeof _crisisDrillFilter !== 'undefined' && _crisisDrillFilter != null);
    if (_activeChipFilters.size === 0 && !hadCrisis) return;
    _activeChipFilters.clear();
    if (hadCrisis) { _crisisDrillFilter = null; }
    _persistChipFilters();
    _paintChipFilterUI();
    renderFeed();
};

// ══════════════════════════════════════════════════════════════════════
// Phase G.6 (May 2026) - Saved view presets
// ══════════════════════════════════════════════════════════════════════
// Operator captures the current viewing state ({chips, status pill,
// time filter, view mode, sort mode}) under a chosen name. Stored
// in localStorage - single-device for now; a backend `UserView`
// table can layer on later when multi-device sharing becomes real.
//
// State shape (serialised as JSON):
//   {
//     name: string,
//     chips: string[],         // _activeChipFilters as array
//     statusPill: string|null, // _activePillFilter
//     timeHours: number,       // timeFilterHours
//     viewMode: string,        // viewMode
//     sortMode: string,        // cardSortMode
//     crisis: string|null,     // _crisisDrillFilter
//     createdAt: ISO 8601,
//   }
const SAVED_VIEWS_LS_KEY = 'crisp_dashboard_views_v1';

function _loadSavedViews() {
    try {
        const raw = localStorage.getItem(SAVED_VIEWS_LS_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
}

function _persistSavedViews(views) {
    try { localStorage.setItem(SAVED_VIEWS_LS_KEY, JSON.stringify(views)); }
    catch (_) { showToast('localStorage quota - cannot save', 'error'); }
}

function _captureCurrentView() {
    return {
        chips: [..._activeChipFilters],
        statusPill: (typeof _activePillFilter !== 'undefined') ? _activePillFilter : null,
        timeHours: timeFilterHours,
        viewMode,
        sortMode: cardSortMode,
        crisis: (typeof _crisisDrillFilter !== 'undefined') ? _crisisDrillFilter : null,
    };
}

function _applyView(v) {
    if (!v) return;
    _activeChipFilters.clear();
    for (const id of (v.chips || [])) _activeChipFilters.add(id);
    if (typeof _activePillFilter !== 'undefined') {
        // Reach into the global state directly - the existing pill-
        // setter wraps a renderFeed which is wasted work here.
        _activePillFilter = v.statusPill || null;
        // v111: lifecycle is now the status TABS, not pills. Map a legacy saved
        // lifecycle pill onto the tab so it doesn't collide with the active tab
        // (which would empty the feed), and sync the Critical chip's .on state.
        if (['pending', 'responding', 'resolved'].includes(_activePillFilter)) {
            _activeStatusTab = _activePillFilter; _activePillFilter = null;
        }
        const _crit = document.getElementById('stat-critical');
        if (_crit) _crit.classList.toggle('on', _activePillFilter === 'critical');
    }
    timeFilterHours = (typeof v.timeHours === 'number') ? v.timeHours : 0;
    if (v.viewMode) {
        // Building-centric redesign: normalize legacy saved modes.
        viewMode = v.viewMode === 'clusters' ? 'buildings'
                 : v.viewMode === 'tree' ? 'queue'
                 : (v.viewMode === 'buildings' || v.viewMode === 'queue') ? v.viewMode
                 : 'buildings';
    }
    if (v.sortMode) cardSortMode = v.sortMode;
    if (typeof v.crisis !== 'undefined') _crisisDrillFilter = v.crisis || null;
    _persistChipFilters();
    _paintChipFilterUI();
    renderFeed();
}

window.toggleSavedViewsMenu = function () {
    const menu = document.getElementById('cmd-views-menu');
    if (!menu) return;
    if (menu.style.display !== 'none') { menu.style.display = 'none'; return; }
    _renderSavedViewsMenu();
    menu.style.display = 'block';
    // Click outside to close.
    setTimeout(() => {
        const closer = (ev) => {
            const wrap = document.getElementById('cmd-views-wrap');
            if (!wrap || !wrap.contains(ev.target)) {
                menu.style.display = 'none';
                document.removeEventListener('click', closer);
            }
        };
        document.addEventListener('click', closer);
    }, 60);
};

function _renderSavedViewsMenu() {
    const menu = document.getElementById('cmd-views-menu');
    if (!menu) return;
    const views = _loadSavedViews();
    // Capture current state as the "Save current view" CTA.
    const cur = _captureCurrentView();
    const curBits = [];
    if (cur.chips.length) curBits.push(`${cur.chips.length} chip${cur.chips.length === 1 ? '' : 's'}`);
    if (cur.statusPill) curBits.push(cur.statusPill);
    if (cur.timeHours > 0) curBits.push(`${cur.timeHours}h`);
    if (cur.crisis) curBits.push(cur.crisis);
    if (cur.viewMode && cur.viewMode !== 'buildings') curBits.push(cur.viewMode);

    menu.innerHTML = `
        <div class="cmd-views-section">
            <button class="cmd-views-save-btn" onclick="_promptSaveView()">
                <i class="fa-solid fa-plus"></i> Save current view…
            </button>
            <div class="cmd-views-current">
                ${curBits.length
                    ? `Current state: ${curBits.map(b => `<span class="cmd-views-curchip">${escapeHtml(b)}</span>`).join(' ')}`
                    : 'No active filters'}
            </div>
        </div>
        ${views.length ? `
            <div class="cmd-views-section">
                <div class="cmd-views-heading">Saved views</div>
                ${views.map((v, i) => `
                    <div class="cmd-views-row">
                        <button class="cmd-views-apply"
                                onclick="_applySavedViewByIndex(${i})"
                                title="Apply this view">
                            <i class="fa-regular fa-bookmark"></i>
                            <span>${escapeHtml(v.name || `View ${i+1}`)}</span>
                        </button>
                        <button class="cmd-views-del"
                                onclick="_deleteSavedViewByIndex(${i})"
                                title="Delete this view">
                            <i class="fa-regular fa-trash-can"></i>
                        </button>
                    </div>
                `).join('')}
            </div>
        ` : `<div class="cmd-views-empty">No saved views yet. Use "Save current view…" above to capture the current filters.</div>`}
    `;
}

window._promptSaveView = function () {
    const name = prompt('Name this view:', '');
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) {
        showToast('View name is required', 'error');
        return;
    }
    const view = {
        name: trimmed.slice(0, 80),
        ..._captureCurrentView(),
        createdAt: new Date().toISOString(),
    };
    const all = _loadSavedViews();
    // Replace if a same-named view already exists.
    const existingIdx = all.findIndex(v => v.name === view.name);
    if (existingIdx >= 0) {
        all[existingIdx] = view;
    } else {
        all.push(view);
    }
    _persistSavedViews(all);
    _renderSavedViewsMenu();
    showToast(`View saved: ${view.name}`, 'success');
};

window._applySavedViewByIndex = function (i) {
    const all = _loadSavedViews();
    if (!all[i]) return;
    _applyView(all[i]);
    showToast(`Applied: ${all[i].name}`, 'success');
    const menu = document.getElementById('cmd-views-menu');
    if (menu) menu.style.display = 'none';
};

window._deleteSavedViewByIndex = function (i) {
    const all = _loadSavedViews();
    if (!all[i]) return;
    if (!confirm(`Delete saved view "${all[i].name}"?`)) return;
    const name = all[i].name;
    all.splice(i, 1);
    _persistSavedViews(all);
    _renderSavedViewsMenu();
    showToast(`Deleted view: ${name}`, 'success');
};

// Filter predicate. Applied AFTER time + status pill filters. AND
// between dimensions, OR within the damage dimension (so a report
// matching ANY of the selected damage chips passes that dimension).
function _passesChipFilters(r) {
    if (!_activeChipFilters.size) return true;
    if (_activeChipFilters.has('debris')) {
        if (!r.debris_clearing_needed) return false;
    }
    // Damage chips: OR within dimension.
    const dmgChipsOn = [];
    if (_activeChipFilters.has('dmg-complete')) dmgChipsOn.push('COMPLETE');
    if (_activeChipFilters.has('dmg-partial')) dmgChipsOn.push('PARTIAL');
    if (dmgChipsOn.length) {
        if (!dmgChipsOn.includes(r.damage_classification)) return false;
    }
    if (_activeChipFilters.has('has-media')) {
        if (!(r.media && r.media.length > 0)) return false;
    }
    if (_activeChipFilters.has('verified')) {
        // "Credible": composite Confidence band VERIFIED or LIKELY - the same
        // Confidence Score the operator acts on, NOT the raw satellite sub-score.
        const ic = r.incident_credibility;
        if (!ic || !ic.assessed || !(ic.band === 'VERIFIED' || ic.band === 'LIKELY')) return false;
    }
    if (_activeChipFilters.has('needs-review')) {
        const vd = r.reviewer_verdict || 'NOT_REVIEWED';
        if (!(vd === 'NOT_REVIEWED' && (r.status === 'PENDING' || r.status === 'VERIFIED'))) return false;
    }
    if (_activeChipFilters.has('building')) {
        if (!r.building_id) return false;
    }
    return true;
}

window.toggleAnalytics = function () {
    const panel = document.getElementById('analytics-panel');
    if (!panel) return;
    const show = panel.style.display === 'none';
    if (show && window.__crispOpenExclusivePanel) window.__crispOpenExclusivePanel('analytics-panel');
    panel.style.display = show ? 'block' : 'none';
    if (show) _renderAnalytics();
};

function _calcTeamScore(reports) {
    if (!reports.length) return { score: 0, breakdown: {} };
    const total = reports.length;
    // 1. Response rate (0-30 pts): % of reports that have been dispatched or resolved
    const acted = reports.filter(r => r.status === 'RESPONDING' || r.status === 'RESOLVED' || r.status === 'FALSE_ALARM').length;
    const responseScore = Math.round((acted / total) * 30);
    // 2. Critical resolution (0-25 pts): % of critical/severe incidents resolved
    const criticals = reports.filter(r => r.severity === 'CRITICAL' || r.severity === 'SEVERE');
    const critResolved = criticals.filter(r => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM').length;
    const critScore = criticals.length > 0 ? Math.round((critResolved / criticals.length) * 25) : 25;
    // 3. Verification coverage (0-20 pts): % of reports verified with satellite
    const verified = reports.filter(r => r.verification).length;
    const verifyScore = Math.round((verified / total) * 20);
    // 4. Data completeness (0-15 pts): avg media received / expected
    let completeness = 0;
    reports.forEach(r => { if (r.expected_media > 0) completeness += (r.received_media || 0) / r.expected_media; else completeness += 1; });
    const dataScore = Math.round((completeness / total) * 15);
    // 5. False alarm detection (0-10 pts): identifying false alarms shows good triage
    const falseAlarms = reports.filter(r => r.status === 'FALSE_ALARM').length;
    const faScore = Math.min(10, falseAlarms * 2);
    const score = Math.min(100, responseScore + critScore + verifyScore + dataScore + faScore);
    return { score, breakdown: { response: responseScore, critical: critScore, verification: verifyScore, data: dataScore, triage: faScore } };
}

function _renderAnalytics() {
  try {
    const reports = _getFilteredReports();
    if (!reports.length) return;

    // ── KPI Cards (Plecto-style hero metrics) ──
    const dateEl = document.getElementById('ac-kpi-date');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

    const pendingR = reports.filter(r => r.status === 'PENDING' || r.status === 'VERIFIED');
    const critPending = pendingR.filter(r => r.severity === 'CRITICAL' || r.severity === 'SEVERE').length;
    const el1 = document.getElementById('kpi-pending');
    if (el1) el1.textContent = pendingR.length;
    const sub1 = document.getElementById('kpi-pending-sub');
    if (sub1) sub1.innerHTML = critPending > 0 ? `<span class="down"><i class="fa-solid fa-arrow-up"></i> ${critPending} critical/severe</span>` : '<span class="up">No critical pending</span>';

    // Avg wait time of pending reports
    if (pendingR.length > 0) {
        const avgMs = pendingR.reduce((s, r) => s + (Date.now() - new Date(ensureUTC(r.server_created_at)).getTime()), 0) / pendingR.length;
        const hrs = Math.floor(avgMs / 3600000);
        const mins = Math.floor((avgMs % 3600000) / 60000);
        const el2 = document.getElementById('kpi-avg-wait');
        if (el2) el2.textContent = `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
        const sub2 = document.getElementById('kpi-wait-sub');
        if (sub2) sub2.innerHTML = avgMs > 3600000 ? '<span class="down"><i class="fa-solid fa-arrow-up"></i> Over 1 hour</span>' : '<span class="up"><i class="fa-solid fa-arrow-down"></i> Under 1 hour</span>';
    } else {
        const el2 = document.getElementById('kpi-avg-wait');
        if (el2) el2.textContent = '00:00';
        const sub2 = document.getElementById('kpi-wait-sub');
        if (sub2) sub2.innerHTML = '<span class="up">All responded</span>';
    }

    const resolvedR = reports.filter(r => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM');
    const el3 = document.getElementById('kpi-resolved');
    if (el3) el3.textContent = resolvedR.length;
    const sub3 = document.getElementById('kpi-resolved-sub');
    if (sub3) sub3.innerHTML = `of ${reports.length} total`;

    const acted = reports.filter(r => r.status === 'RESPONDING' || r.status === 'RESOLVED' || r.status === 'FALSE_ALARM').length;
    const rate = reports.length > 0 ? Math.round((acted / reports.length) * 100) : 0;
    const el4 = document.getElementById('kpi-response-rate');
    if (el4) el4.textContent = rate + '%';
    const sub4 = document.getElementById('kpi-rate-sub');
    if (sub4) sub4.innerHTML = rate >= 80 ? '<span class="up"><i class="fa-solid fa-arrow-up"></i> Strong</span>' : rate >= 50 ? 'Moderate' : '<span class="down"><i class="fa-solid fa-arrow-down"></i> Needs attention</span>';

    const falseAlarms = reports.filter(r => r.status === 'FALSE_ALARM').length;
    const faRate = reports.length > 0 ? Math.round((falseAlarms / reports.length) * 100) : 0;
    const el5 = document.getElementById('kpi-false-rate');
    if (el5) el5.textContent = faRate + '%';
    const sub5 = document.getElementById('kpi-false-sub');
    if (sub5) sub5.innerHTML = `${falseAlarms} of ${reports.length} reports`;

    // 0. Team Performance Score (hero)
    const ts = _calcTeamScore(reports);
    const sc = ts.score;
    const scColor = sc >= 80 ? '#22c55e' : sc >= 60 ? '#86efac' : sc >= 40 ? '#eab308' : sc >= 20 ? '#f97316' : '#ef4444';
    const scLabel = sc >= 80 ? 'Excellent' : sc >= 60 ? 'Good' : sc >= 40 ? 'Fair' : sc >= 20 ? 'Needs Improvement' : 'Critical';
    const C = 251.33; // r=40, circumference
    const scOffset = C - (sc / 100) * C;
    const _tsr = document.getElementById('team-score-ring');
    if (_tsr) _tsr.innerHTML = `
        <svg width="96" height="96" viewBox="0 0 96 96">
            <circle cx="48" cy="48" r="40" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8"/>
            <circle cx="48" cy="48" r="40" fill="none" stroke="${scColor}" stroke-width="8" stroke-linecap="round"
                stroke-dasharray="${C}" stroke-dashoffset="${scOffset}" transform="rotate(-90 48 48)" style="transition:stroke-dashoffset 0.8s ease;"/>
        </svg>
        <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;">
            <span style="font-size:28px;font-weight:800;color:${scColor};font-family:var(--font-head);line-height:1;">${sc}</span>
            <span style="font-size:10px;color:var(--text-dim);">/100</span>
        </div>`;
    if (_tsr) _tsr.style.position = 'relative';

    const bd = ts.breakdown;
    const _tsd = document.getElementById('team-score-details');
    if (_tsd) _tsd.innerHTML = `
        <div style="font-size:18px;font-weight:800;color:${scColor};font-family:var(--font-head);margin-bottom:4px;">${scLabel}</div>
        <div style="font-size:12px;color:var(--text-sub);margin-bottom:8px;">Team Performance Score - based on response speed, critical resolution, verification coverage, and data quality</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <span class="ac-score-chip">Response ${bd.response}/30</span>
            <span class="ac-score-chip">Critical ${bd.critical}/25</span>
            <span class="ac-score-chip">Verified ${bd.verification}/20</span>
            <span class="ac-score-chip">Data ${bd.data}/15</span>
            <span class="ac-score-chip">Triage ${bd.triage}/10</span>
        </div>`;

    // 0b. Score Trend (daily - store in localStorage)
    const TREND_KEY = 'crisp_score_trend';
    // Key by the operator's LOCAL calendar day (was toISOString = UTC day,
    // which rolled the bucket over at 05:30 IST / mid-shift elsewhere).
    const _now = new Date();
    const today = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
    let trend = {};
    try { trend = JSON.parse(localStorage.getItem(TREND_KEY) || '{}'); } catch (_) {}
    trend[today] = sc;
    // Keep last 14 days
    const trendDays = Object.keys(trend).sort().slice(-14);
    const cleanTrend = {};
    trendDays.forEach(d => { cleanTrend[d] = trend[d]; });
    try { localStorage.setItem(TREND_KEY, JSON.stringify(cleanTrend)); } catch (_) {}

    const trendMax = Math.max(...Object.values(cleanTrend), 100);
    const trendEntries = Object.entries(cleanTrend);
    const _stc = document.getElementById('score-trend-chart');
    if (_stc) _stc.innerHTML = `
        <div class="ac-timeline-bars" style="height:50px;">
            ${trendEntries.map(([day, val]) => {
                const col = val >= 80 ? '#22c55e' : val >= 60 ? '#86efac' : val >= 40 ? '#eab308' : val >= 20 ? '#f97316' : '#ef4444';
                return `<div class="ac-tbar" style="height:${Math.max(4, (val/trendMax)*100)}%;background:linear-gradient(to top,${col}66,${col});" title="${fmtDateOnly(day)}: ${val}/100">
                    <span class="ac-tbar-val">${val}</span>
                </div>`;
            }).join('')}
        </div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text-dim);margin-top:4px;">
            ${trendEntries.length > 1 ? `<span>${fmtDateOnly(trendEntries[0][0])}</span><span>${fmtDateOnly(trendEntries[trendEntries.length-1][0])}</span>` : '<span>Today</span>'}
        </div>`;

    // 1. Severity Distribution
    const sevCounts = { CRITICAL: 0, SEVERE: 0, MODERATE: 0, MINOR: 0 };
    reports.forEach(r => { if (sevCounts[r.severity] !== undefined) sevCounts[r.severity]++; });
    const maxSev = Math.max(...Object.values(sevCounts), 1);
    const sevColors = { CRITICAL: '#ef4444', SEVERE: '#f97316', MODERATE: '#eab308', MINOR: '#22c55e' };
    const _sdEl = document.getElementById('sev-dist-bars');
    if (_sdEl) _sdEl.innerHTML = Object.entries(sevCounts).map(([k, v]) =>
        `<div class="ac-bar-row">
            <span class="ac-bar-label">${k}</span>
            <div class="ac-bar-track"><div class="ac-bar-fill" style="width:${(v/maxSev)*100}%;background:${sevColors[k]};"></div></div>
            <span class="ac-bar-val">${v}</span>
        </div>`
    ).join('');

    // 2. Infrastructure Breakdown
    const infraCounts = {};
    reports.forEach(r => { infraCounts[r.infrastructure_type] = (infraCounts[r.infrastructure_type] || 0) + 1; });
    const infraSorted = Object.entries(infraCounts).sort((a, b) => b[1] - a[1]);
    const maxInfra = Math.max(...infraSorted.map(e => e[1]), 1);
    const _idEl = document.getElementById('infra-dist-bars');
    if (_idEl) _idEl.innerHTML = infraSorted.map(([k, v]) =>
        `<div class="ac-bar-row">
            <span class="ac-bar-label">${k}</span>
            <div class="ac-bar-track"><div class="ac-bar-fill" style="width:${(v/maxInfra)*100}%;background:var(--info);"></div></div>
            <span class="ac-bar-val">${v}</span>
        </div>`
    ).join('');

    // 3. Response Metrics (use rm_ prefix to avoid variable shadowing with KPI section)
    const rm_pending = reports.filter(r => r.status === 'PENDING' || r.status === 'VERIFIED').length;
    const rm_dispatched = reports.filter(r => r.status === 'RESPONDING').length;
    const rm_done = reports.filter(r => r.status === 'RESOLVED' || r.status === 'FALSE_ALARM').length;
    const rm_fa = reports.filter(r => r.status === 'FALSE_ALARM').length;
    const rm_rate = reports.length > 0 ? Math.round(((rm_dispatched + rm_done) / reports.length) * 100) : 0;
    const avgMedia = reports.length > 0 ? (reports.reduce((s, r) => s + (r.received_media || 0), 0) / reports.length).toFixed(1) : 0;
    const _rmEl = document.getElementById('response-metrics');
    if (_rmEl) _rmEl.innerHTML = `
        <div class="ac-metric"><span class="ac-metric-val" style="color:#ef4444;">${rm_pending}</span><span class="ac-metric-label">Awaiting</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#a78bfa;">${rm_dispatched}</span><span class="ac-metric-label">Help Sent</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#10b981;">${rm_done}</span><span class="ac-metric-label">Closed</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#38bdf8;">${rm_rate}%</span><span class="ac-metric-label">Response Rate</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#f59e0b;">${rm_fa}</span><span class="ac-metric-label">False Alarms</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#94a3b8;">${avgMedia}</span><span class="ac-metric-label">Avg Media/Report</span></div>
    `;

    // 4. Timeline (last 24h, binned by hour)
    const now = Date.now();
    const hours = Array(24).fill(0);
    reports.forEach(r => {
        const h = Math.floor((now - new Date(ensureUTC(r.server_created_at)).getTime()) / 3600000);
        if (h >= 0 && h < 24) hours[23 - h]++;
    });
    const maxH = Math.max(...hours, 1);
    const _tcEl = document.getElementById('timeline-chart');
    if (_tcEl) _tcEl.innerHTML = `
        <div class="ac-timeline-bars">
            ${hours.map((v, i) => `<div class="ac-tbar" style="height:${Math.max(2, (v/maxH)*100)}%;" title="${24 - i}h ago: ${v} incidents"><span class="ac-tbar-val">${v || ''}</span></div>`).join('')}
        </div>
        <div class="ac-timeline-labels"><span>24h ago</span><span>Now</span></div>
    `;

    // 5. Top Affected Regions
    const regionCounts = {};
    reports.forEach(r => {
        const name = r.location?.user_location_name || r.location?.device_location_name || r._region || 'Unknown';
        const short = name.split(',')[0].trim();
        regionCounts[short] = (regionCounts[short] || 0) + 1;
    });
    const topRegions = Object.entries(regionCounts).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const _trEl = document.getElementById('top-regions');
    if (_trEl) _trEl.innerHTML = topRegions.map(([name, count], i) =>
        `<div class="ac-list-row">
            <span class="ac-list-rank">${i + 1}</span>
            <span class="ac-list-name">${name}</span>
            <span class="ac-list-count">${count}</span>
        </div>`
    ).join('') || '<div style="color:var(--text-dim);font-size:12px;">No location data</div>';

    // 6. Verification Summary
    const verified = reports.filter(r => r.verification).length;
    const unverified = reports.length - verified;
    const avgScore = verified > 0 ? Math.round(reports.filter(r => r.verification).reduce((s, r) => s + (r.verification.total_score || 0), 0) / verified) : 0;
    const highConf = reports.filter(r => r.verification && r.verification.total_score >= 60).length;
    const lowConf = reports.filter(r => r.verification && r.verification.total_score < 40).length;
    const _vsEl = document.getElementById('verify-summary');
    if (_vsEl) _vsEl.innerHTML = `
        <div class="ac-metric"><span class="ac-metric-val" style="color:#22c55e;">${verified}</span><span class="ac-metric-label">Verified</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#64748b;">${unverified}</span><span class="ac-metric-label">Unverified</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#38bdf8;">${avgScore}</span><span class="ac-metric-label">Avg Score</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#22c55e;">${highConf}</span><span class="ac-metric-label">High Conf</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#ef4444;">${lowConf}</span><span class="ac-metric-label">Low Conf</span></div>
    `;

    // 7. Data Quality Metrics
    const withPhoto = reports.filter(r => r.media?.some(m => m.type === 'IMAGE' && m.assembly_status === 'complete')).length;
    const withAudio = reports.filter(r => r.media?.some(m => m.type === 'AUDIO' && m.assembly_status === 'complete')).length;
    const withLocation = reports.filter(r => r.location && (r.location.latitude || r.location.device_latitude)).length;
    const withTranscript = reports.filter(r => r.ai_analysis?.transcription).length;
    const withDescription = reports.filter(r => r.description && r.description.trim().length > 0).length;
    const photoPct = reports.length > 0 ? Math.round((withPhoto / reports.length) * 100) : 0;
    const audioPct = reports.length > 0 ? Math.round((withAudio / reports.length) * 100) : 0;
    const locPct = reports.length > 0 ? Math.round((withLocation / reports.length) * 100) : 0;
    const dqEl = document.getElementById('data-quality-metrics');
    if (dqEl) dqEl.innerHTML = `
        <div class="ac-metric"><span class="ac-metric-val" style="color:${photoPct >= 80 ? '#22c55e' : photoPct >= 50 ? '#eab308' : '#ef4444'};">${photoPct}%</span><span class="ac-metric-label">Have Photos</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:${audioPct >= 80 ? '#22c55e' : audioPct >= 50 ? '#eab308' : '#ef4444'};">${audioPct}%</span><span class="ac-metric-label">Have Audio</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:${locPct >= 90 ? '#22c55e' : '#eab308'};">${locPct}%</span><span class="ac-metric-label">Have GPS</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#38bdf8;">${withTranscript}</span><span class="ac-metric-label">Transcribed</span></div>
        <div class="ac-metric"><span class="ac-metric-val" style="color:#94a3b8;">${withDescription}</span><span class="ac-metric-label">Have Text</span></div>
    `;

    // ── Phase G.4 - Drill-down breakdowns ──────────────────────────
    // 8. Top buildings (by report count). Click → openBuildingConsole.
    const buildingCounts = {};
    const buildingLabels = {};
    reports.forEach(r => {
        const bid = r.building_id;
        if (!bid) return;
        buildingCounts[bid] = (buildingCounts[bid] || 0) + 1;
        // Pick a label - first non-empty per id wins.
        if (!buildingLabels[bid]) {
            buildingLabels[bid] =
                r.location?.user_location_name
                || r.location?.device_location_name
                || (bid.startsWith('osm:way:') ? `OSM way ${bid.slice(8)}` : `Cluster ${bid.slice(0, 8)}`);
        }
    });
    const topBuildings = Object.entries(buildingCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
    const bdEl = document.getElementById('building-distribution');
    if (bdEl) bdEl.innerHTML = topBuildings.length
        ? topBuildings.map(([bid, count], i) => `
            <div class="ac-list-row ac-list-row-clickable"
                 onclick="closeAnalyticsPanel && closeAnalyticsPanel(); openBuildingConsole('${bid}');"
                 title="Open Building Intelligence Console for this building">
                <span class="ac-list-rank">${i + 1}</span>
                <span class="ac-list-name">${escapeHtml(buildingLabels[bid] || bid)}</span>
                <span class="ac-list-count">${count}</span>
            </div>`).join('')
        : '<div style="color:var(--text-dim);font-size:12px;">No reports tagged to a building yet</div>';

    // 9. Debris-clearing breakdown. Click → toggle the G.1 debris chip
    //    and close analytics so the operator lands back in the triage feed.
    const debrisNeeded = reports.filter(r => r.debris_clearing_needed === true).length;
    const debrisNotNeeded = reports.filter(r => r.debris_clearing_needed === false).length;
    const debrisUnknown = reports.filter(r => r.debris_clearing_needed == null).length;
    const debrisEl = document.getElementById('debris-breakdown');
    if (debrisEl) debrisEl.innerHTML = `
        <div class="ac-metric ac-metric-clickable"
             onclick="closeAnalyticsPanel && closeAnalyticsPanel(); _ensureChipFilter('debris', true);"
             title="Filter feed: only reports flagged as needing debris clearing">
            <span class="ac-metric-val" style="color:#fbbf24;">${debrisNeeded}</span>
            <span class="ac-metric-label">Needed</span>
        </div>
        <div class="ac-metric"
             title="Reporters explicitly answered No">
            <span class="ac-metric-val" style="color:#94a3b8;">${debrisNotNeeded}</span>
            <span class="ac-metric-label">Not Needed</span>
        </div>
        <div class="ac-metric"
             title="No debris answer on the original report">
            <span class="ac-metric-val" style="color:#64748b;">${debrisUnknown}</span>
            <span class="ac-metric-label">Unknown</span>
        </div>
    `;

    // 10. Crisis-type distribution. Click → in-memory crisis filter
    //     applied as a one-off chip-like filter that survives until cleared.
    const crisisCounts = {};
    reports.forEach(r => {
        const ct = r.crisis_type || 'UNKNOWN';
        crisisCounts[ct] = (crisisCounts[ct] || 0) + 1;
    });
    const crisisSorted = Object.entries(crisisCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const maxCrisis = Math.max(...crisisSorted.map(e => e[1]), 1);
    const crisisColor = (k) => ({
        EARTHQUAKE: '#f97316', FLOOD: '#3b82f6', TSUNAMI: '#06b6d4',
        HURRICANE: '#8b5cf6', WILDFIRE: '#ef4444', EXPLOSION: '#dc2626',
        CHEMICAL: '#22c55e', CONFLICT: '#a16207', CIVIL_UNREST: '#fbbf24',
        UNKNOWN: '#64748b',
    })[k] || '#94a3b8';
    const cdEl = document.getElementById('crisis-distribution');
    if (cdEl) cdEl.innerHTML = crisisSorted.length
        ? crisisSorted.map(([k, v]) => `
            <div class="ac-bar-row ac-bar-row-clickable"
                 onclick="closeAnalyticsPanel && closeAnalyticsPanel(); _setCrisisDrillFilter('${k}');"
                 title="Filter feed by crisis type: ${escapeHtml(k.replace(/_/g, ' '))}">
                <span class="ac-bar-label">${escapeHtml(crisisLabel(k) || k.replace(/_/g, ' '))}</span>
                <div class="ac-bar-track">
                    <div class="ac-bar-fill" style="width:${(v / maxCrisis) * 100}%;background:${crisisColor(k)};"></div>
                </div>
                <span class="ac-bar-val">${v}</span>
            </div>`).join('')
        : '<div style="color:var(--text-dim);font-size:12px;">No crisis-type data</div>';

  } catch (e) { console.warn('[CRISP] Analytics render error:', e); }
}

// ── Phase G.4 helpers ──────────────────────────────────────────────────
// Chip filter setters used by analytics drill-down clicks.
window._ensureChipFilter = function (chipId, shouldBeOn) {
    if (!chipId) return;
    const isOn = _activeChipFilters.has(chipId);
    if (shouldBeOn && !isOn) {
        toggleChipFilter(chipId);
    } else if (!shouldBeOn && isOn) {
        toggleChipFilter(chipId);
    } else {
        // Already in the desired state - just nudge a re-render in case
        // the operator clicked from analytics with no actual chip change.
        renderFeed();
    }
    showToast(shouldBeOn ? `Filter applied: ${chipId}` : `Filter cleared: ${chipId}`, 'success');
};

// Phase G.4 - Single-crisis drill-down filter declared above; this is
// just a comment marker for the next reader.

window._setCrisisDrillFilter = function (crisis) {
    if (_crisisDrillFilter === crisis) {
        // Same bar clicked twice → clear it.
        _crisisDrillFilter = null;
        showToast(`Crisis filter cleared`, 'success');
    } else {
        _crisisDrillFilter = crisis;
        showToast(`Filter: crisis=${crisis.replace(/_/g, ' ')}`, 'success');
    }
    renderFeed();
};

// Crisis drill-down predicate - applied INSIDE _getFilteredReports
// below via `_passesCrisisDrill`. Kept here next to the state so the
// filter is one logical unit.
window._passesCrisisDrill = function (r) {
    if (_crisisDrillFilter == null) return true;
    return (r.crisis_type || 'UNKNOWN') === _crisisDrillFilter;
};

// Phase G.4 - graceful close for analytics panel (no-op if already
// closed). The existing toggle is `_renderAnalytics`-gated by panel
// visibility; we provide an explicit closer so drill-down clicks
// don't have to know about the implementation.
window.closeAnalyticsPanel = function () {
    const panel = document.getElementById('analytics-panel');
    if (panel) panel.style.display = 'none';
    const btn = document.getElementById('btn-analytics');
    if (btn) btn.classList.remove('active');
};

// ══════════════════════════════════════════════════════════════════════
// Phase G.5 (May 2026) - Bulk multi-select + batch verify
// ══════════════════════════════════════════════════════════════════════
// Operator toggles "Select" mode → each visible card grows a
// checkbox. Selected ids accumulate in `_bulkSelectedIds`. A floating
// bottom-of-viewport bar appears whenever the selection is non-empty
// with 4 actions: Verify (SSE batch endpoint) / Accept / Dispatch /
// Reject. Accept / Dispatch / Reject loop the existing per-report
// endpoints client-side with a small concurrency cap so each action
// stays atomic in AuthAuditLog.

window.toggleBulkSelectMode = function () {
    _bulkSelectMode = !_bulkSelectMode;
    if (!_bulkSelectMode) _bulkSelectedIds.clear();
    _paintBulkSelectUI();
    renderFeed();
};

window._toggleBulkSelectId = function (id, checked) {
    if (checked) {
        _bulkSelectedIds.add(id);
    } else {
        _bulkSelectedIds.delete(id);
    }
    _paintBulkSelectUI();
};

window.clearBulkSelection = function () {
    _bulkSelectedIds.clear();
    _paintBulkSelectUI();
    renderFeed();
};

function _paintBulkSelectUI() {
    const bar = document.getElementById('bulk-action-bar');
    const count = _bulkSelectedIds.size;
    const toggleBtn = document.getElementById('btn-bulk-select');
    if (toggleBtn) {
        toggleBtn.classList.toggle('active', _bulkSelectMode);
        toggleBtn.title = _bulkSelectMode ? 'Leave bulk-select mode' : 'Enable bulk-select mode';
    }
    if (!bar) return;
    if (!_bulkSelectMode || count === 0) {
        bar.style.display = 'none';
        return;
    }
    bar.style.display = '';
    const countEl = document.getElementById('bulk-count');
    if (countEl) countEl.textContent = String(count);
}

// SSE batch verify - opens an EventSource against the batch-verify
// stream and surfaces progress via toast. Since EventSource doesn't
// allow custom headers (no Authorization), we instead use fetch
// with stream:true semantics and manually parse SSE events.
window.bulkVerifySelected = async function () {
    if (_bulkSelectedIds.size === 0) return;
    if (_bulkSelectedIds.size > 100) {
        showToast(`Batch too large (${_bulkSelectedIds.size}). Cap is 100.`, 'error');
        return;
    }
    const ids = [..._bulkSelectedIds];
    const progressEl = document.getElementById('bulk-progress');
    if (progressEl) progressEl.textContent = `0 / ${ids.length}`;
    showToast(`Verifying ${ids.length} reports…`, 'info');

    try {
        const res = await fetch(`${API}/batch-verify`, {
            method: 'POST',
            headers: _authHeaders(),
            body: JSON.stringify({ report_ids: ids }),
        });
        if (res.status === 401 || res.status === 403) {
            showToast('Analyst role required.', 'error');
            return;
        }
        if (!res.ok) {
            const err = await res.text();
            showToast(`Batch verify failed: ${err.slice(0, 80)}`, 'error');
            return;
        }
        // Read the SSE stream chunk-by-chunk.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let done = 0;
        let failed = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const { value, done: streamDone } = await reader.read();
            if (streamDone) break;
            buf += decoder.decode(value, { stream: true });
            // SSE frames are separated by double newline.
            const frames = buf.split('\n\n');
            buf = frames.pop() || '';
            for (const frame of frames) {
                if (!frame.trim() || frame.startsWith(':')) continue;
                // Each frame is "event: <name>\ndata: <json>"
                let evName = 'message';
                let data = null;
                for (const line of frame.split('\n')) {
                    if (line.startsWith('event:')) evName = line.slice(6).trim();
                    else if (line.startsWith('data:')) {
                        try { data = JSON.parse(line.slice(5).trim()); } catch (_) {}
                    }
                }
                if (!data) continue;
                if (evName === 'progress') {
                    done = data.done || done;
                    if (data.status !== 'ok') failed += 1;
                    if (progressEl) progressEl.textContent = `${done} / ${data.total}${failed ? ` (${failed} failed)` : ''}`;
                } else if (evName === 'done') {
                    const s = data.summary || {};
                    showToast(
                        `Batch verify: ${s.succeeded || 0} succeeded, ${s.failed || 0} failed`,
                        (s.failed || 0) === 0 ? 'success' : 'error',
                    );
                }
            }
        }
        // Refresh the in-memory reports to pick up the new
        // verification rows.
        _loadReports && _loadReports();
    } catch (e) {
        showToast(`Network error: ${e.message}`, 'error');
    }
};

// Bulk-loop helper for actions that don't have a batch endpoint
// (Accept / Dispatch / Reject). Concurrency cap = 3 client-side.
async function _bulkLoop(actionName, perReportFn) {
    if (_bulkSelectedIds.size === 0) return;
    const ids = [..._bulkSelectedIds];
    const progressEl = document.getElementById('bulk-progress');
    let done = 0;
    let failed = 0;
    showToast(`${actionName}: 0 / ${ids.length}…`, 'info');
    if (progressEl) progressEl.textContent = `0 / ${ids.length}`;

    // 3-in-flight pool.
    const POOL = 3;
    let i = 0;
    async function worker() {
        while (i < ids.length) {
            const my = i++;
            try {
                await perReportFn(ids[my]);
            } catch (e) {
                failed += 1;
            }
            done += 1;
            if (progressEl) progressEl.textContent = `${done} / ${ids.length}${failed ? ` (${failed} failed)` : ''}`;
        }
    }
    await Promise.all(Array.from({ length: POOL }, () => worker()));
    showToast(
        `${actionName}: ${done - failed} succeeded${failed ? `, ${failed} failed` : ''}`,
        failed === 0 ? 'success' : 'error',
    );
    _loadReports && _loadReports();
}

window.bulkAcceptSelected = () => _bulkLoop('Accept', async (id) => {
    const res = await fetch(`${API}/${encodeURIComponent(id)}/review`, {
        method: 'POST',
        headers: _authHeaders(),
        body: JSON.stringify({ verdict: 'ACCEPTED' }),
    });
    if (!res.ok) throw new Error('review failed');
});

window.bulkDispatchSelected = () => _bulkLoop('Dispatch', async (id) => {
    const res = await fetch(`${API}/${encodeURIComponent(id)}/dispatch`, {
        method: 'POST',
        headers: _authHeaders(),
    });
    if (!res.ok) throw new Error('dispatch failed');
});

window.bulkRejectSelected = () => {
    if (!confirm(`Reject ${_bulkSelectedIds.size} reports as false alarms? This cannot be undone in bulk.`)) return;
    return _bulkLoop('Reject', async (id) => {
        const res = await fetch(`${API}/${encodeURIComponent(id)}/false-alarm`, {
            method: 'POST',
            headers: _authHeaders(),
        });
        if (!res.ok) throw new Error('reject failed');
    });
};

// ── Incident Preview (Hover Tooltip) ─────────────────────────────────────────
function showIncidentPreview(r, event) {
    let p = document.getElementById('fast-preview');
    if (!p) {
        p = document.createElement('div');
        p.id = 'fast-preview';
        p.className = 'glass-panel fast-preview-tooltip';
        document.body.appendChild(p);
    }

    const img = r.media?.find(m => m.type === 'IMAGE');
    const audio = r.media?.find(m => m.type === 'AUDIO');
    const loc = r.location;
    const ai = r.ai_analysis;
    const v = r.verification;
    const sevColor = SEV_COLORS[r.severity] || '#64748b';
    const locName = loc?.user_location_name || loc?.device_location_name || (loc ? `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}` : 'Unknown');
    const srcIcon = {APP:'fa-mobile-screen-button',ANDROID:'fa-robot',WHATSAPP:'fa-whatsapp',TELEGRAM:'fa-telegram',SMS:'fa-comment-sms',IVR:'fa-phone'}[r.source] || 'fa-mobile-screen-button';
    const srcBrand = ['WHATSAPP','TELEGRAM'].includes(r.source) ? 'fa-brands' : 'fa-solid';
    const hoverAiSummary = ai?.ai_summary || '';
    const hoverUserText = r.description || ai?.transcription || '';
    const hoverDisplayText = hoverAiSummary || hoverUserText;

    const thumbUrl = img?.thumbnail_url ? getMediaUrl(img.thumbnail_url) : '';
    const fullUrl  = img?.url && img.assembly_status === 'complete' ? getMediaUrl(img.url) : '';
    const audioUrl = audio?.url ? getMediaUrl(audio.url) : (audio?.thumbnail_url ? getMediaUrl(audio.thumbnail_url) : '');
    // Phase 2 (May 2026): hover-preview is a 380px tooltip - no need to
    // fetch the LARGE variant for it. Prefer the thumb (which is also
    // already in cache from the inline detail panel render). Falls back
    // to full only if no thumb exists (legacy single-variant rows).
    // Phase 2.2: if the best variant isn't ready yet but the backend has
    // written a partial JPEG (0 < completion_pct < 100), surface it here so
    // the hover-preview shows something recognisable within seconds of the
    // first chunk landing. Cache-busted by the same `?p=<pct>` stepping
    // that `bestVariant` uses.
    let partialPreviewUrl = '';
    if (img && img.type === 'IMAGE' && img.id &&
        img.assembly_status !== 'complete' &&
        (img.completion_pct || 0) > 0 && (img.completion_pct || 0) < 100) {
        partialPreviewUrl = getMediaUrl('static/' + img.id + '_partial.jpg')
                          + '?p=' + Math.floor(img.completion_pct);
    }
    // Phase 1.5: last-resort - blurhash placeholder. Used when no variant,
    // no partial thumbnail, and no partial file exists yet (e.g. meta POST
    // landed but the first chunk is still in flight). Never overrides a
    // real photo source.
    const blurPreviewUrl = blurhashToDataURL(r.blurhash);
    // Phase 2: thumb-first preference (was full-first). Cuts hover-preview
    // image bandwidth ~10× when LOW + LARGE both exist for a report.
    const photoSrc = thumbUrl || fullUrl || partialPreviewUrl || blurPreviewUrl || '';
    // May 2026 - route sat URLs through getMediaUrl(). The backend now
    // emits stable `/api/v1/reports/<id>/satellite/<slot>` URLs for S3-
    // backed media; getMediaUrl() correctly handles relative paths
    // (prepends BACKEND_HOST) and external https URLs (pass-through).
    // The previous `${BACKEND_HOST}${...}` concat broke whenever the
    // serializer returned an `https://s3...` presigned URL - producing
    // `https://undp/.../https://s3.../...` → 404.
    const satSrc = v?.satellite_image_url ? getMediaUrl(v.satellite_image_url) : '';

    // Verification score dots
    const scores = v?.scores || {};
    const dotCol = (val) => (val || 0) >= 20 ? '#22c55e' : (val || 0) >= 13 ? '#eab308' : '#ef4444';
    const gc = v ? (v.total_score >= 60 ? '#22c55e' : v.total_score >= 40 ? '#eab308' : '#ef4444') : '';

    p.innerHTML = `
        <div class="fp-header">
            <span class="fp-sev-strip" style="background:${sevColor};"></span>
            <div class="fp-header-info">
                <div class="fp-title-row">
                    <i class="fa-solid ${INFRA_ICONS[r.infrastructure_type] || 'fa-triangle-exclamation'}" style="color:${sevColor};"></i>
                    <span class="fp-type">${infraDisplayLabel(r.infrastructure_type, r.infrastructure_sub_type)}</span>
                    <span class="fp-sev-badge" style="background:${sevColor}20;color:${sevColor};">${r.severity}</span>
                    <span class="fp-status-badge st-${_displayStatus(r).cls}" title="${_displayStatus(r).title}">${_displayStatus(r).label}</span>
                </div>
                <div class="fp-meta-row">
                    <span>${timeAgo(r.server_created_at)}</span>
                    <span><i class="${srcBrand} ${srcIcon}"></i> ${r.source}</span>
                    ${_confidenceChip(r)}
                    ${r.crisis_type ? `<span class="qrt-tag qrt-tag-crisis">${escapeHtml(crisisLabel(r.crisis_type))}</span>` : ''}
                    ${r.damage_classification ? `<span class="qrt-tag qrt-tag-dmg-${r.damage_classification}">${escapeHtml(r.damage_classification.replace(/_/g,' '))}</span>` : ''}
                </div>
            </div>
        </div>
        ${photoSrc ? `<div class="fp-img-section">
            <img id="fp-preview-img" src="${photoSrc}" class="fp-photo" onerror="this.style.display='none'"${
                // Phase 1.5: when the only thing we have is the blurhash,
                // apply a soft blur + saturation bump so the image reads as
                // a placeholder (not a low-res real photo). The filter is
                // dropped automatically once a real variant replaces the src.
                photoSrc === blurPreviewUrl && photoSrc ? ' style="filter:blur(6px) saturate(1.1);"' : ''
            }>
            ${satSrc ? `<div class="fp-img-toggle">
                <button class="fp-itg active" onclick="event.stopPropagation();document.getElementById('fp-preview-img').src='${photoSrc}';this.classList.add('active');this.nextElementSibling.classList.remove('active')"><i class="fa-solid fa-camera"></i></button>
                <button class="fp-itg" onclick="event.stopPropagation();document.getElementById('fp-preview-img').src='${satSrc}';this.classList.add('active');this.previousElementSibling.classList.remove('active')"><i class="fa-solid fa-satellite"></i></button>
            </div>` : ''}
        </div>` : ''}
        <div class="fp-body">
            ${hoverAiSummary ? `<div class="fp-text" style="border-left:2px solid #3b82f6;padding-left:6px;"><i class="fa-solid fa-robot" style="font-size:10px;color:#3b82f6;margin-right:3px;"></i>${escapeHtml(hoverAiSummary.substring(0, 140))}${hoverAiSummary.length > 140 ? '...' : ''}</div>` : ''}
            ${hoverUserText && (!hoverAiSummary || hoverUserText !== hoverAiSummary) ? `<div class="fp-text" style="font-size:11px;color:#94a3b8;margin-top:3px;"><i class="fa-solid fa-user" style="font-size:9px;margin-right:3px;"></i>${escapeHtml(hoverUserText.substring(0, 100))}${hoverUserText.length > 100 ? '...' : ''}</div>` : ''}
            ${!hoverAiSummary && !hoverUserText ? '' : ''}
            <div class="fp-loc-row"><i class="fa-solid fa-location-dot" style="color:${sevColor};"></i> ${escapeHtml(locName)}</div>
            ${audioUrl ? `<button class="fp-play-btn" onclick="event.stopPropagation();playPreviewAudio('${audioUrl}',this)"><i class="fa-solid fa-play"></i> Play Audio</button>` : ''}
            ${v ? `<div class="fp-verify-row">
                <span class="fp-verify-label">Satellite</span>
                <span class="fp-verify-score" style="color:${gc};">${v.total_score}</span>
                <div class="fp-verify-dots">
                    <span style="color:${dotCol(scores.location_authenticity)};">● Loc ${scores.location_authenticity ?? '-'}</span>
                    <span style="color:${dotCol(scores.damage_corroboration)};">● Dmg ${scores.damage_corroboration ?? '-'}</span>
                    <span style="color:${dotCol(scores.description_coherence)};">● Desc ${scores.description_coherence ?? '-'}</span>
                    <span style="color:${dotCol(scores.data_quality)};">● Data ${scores.data_quality ?? '-'}</span>
                </div>
            </div>` : ''}
        </div>
        <div class="fp-actions">
            ${((r.status === 'PENDING' || r.status === 'VERIFIED') && (r.reviewer_verdict || 'NOT_REVIEWED') !== 'REJECTED') ? `<button class="fp-act fp-act-dispatch" onclick="event.stopPropagation();patchReport('${r.id}','dispatch');hideIncidentPreview()"><i class="fa-solid fa-bell-concierge"></i> Notify Responders</button>` : ''}
            ${r.status !== 'FALSE_ALARM' ? `<button class="fp-act fp-act-false" onclick="event.stopPropagation();patchReport('${r.id}','false-alarm');hideIncidentPreview()"><i class="fa-solid fa-ban"></i> False</button>` : ''}
            <button class="fp-act fp-act-detail" onclick="event.stopPropagation();window.openIncident('${r.id}');hideIncidentPreview()"><i class="fa-solid fa-expand"></i></button>
        </div>
    `;

    // Position near cursor but within viewport
    const rect = event.target.getBoundingClientRect();
    const panelLeft = rect.right + 12;
    const maxLeft = window.innerWidth - 380;
    const maxTop = window.innerHeight - p.offsetHeight - 20;
    p.style.left = `${Math.min(panelLeft, maxLeft)}px`;
    p.style.top = `${Math.max(Math.min(rect.top - 20, maxTop), 10)}px`;
    clearTimeout(_hidePreviewTimer);   // re-entering cancels a pending hide
    p.style.display = 'flex';

    // Keep tooltip visible when hovering over it (for action buttons)
    p.onmouseenter = () => { p._hovered = true; };
    p.onmouseleave = () => { p._hovered = false; hideIncidentPreview(); };
}

let _hidePreviewTimer = null;
function hideIncidentPreview() {
    clearTimeout(_hidePreviewTimer);
    // Grace period so moving the cursor from the card across the gap onto the preview
    // (to use its action buttons) does NOT hide it; the preview's own onmouseenter sets
    // _hovered before this fires.
    _hidePreviewTimer = setTimeout(() => {
        const p = document.getElementById('fast-preview');
        if (p && !p._hovered) p.style.display = 'none';
    }, 260);
}
// Hover-intent: open the rich preview only after the cursor DWELLS on a card (~220ms),
// so a quick pass-over no longer flashes it open-and-shut. A mouseleave during the dwell
// cancels the pending show. Shared by every incident card (feed cards + op-tree leaves).
let _showPreviewTimer = null;
function _armIncidentPreview(r, el) {
    clearTimeout(_hidePreviewTimer);
    clearTimeout(_showPreviewTimer);
    _showPreviewTimer = setTimeout(() => { try { showIncidentPreview(r, { target: el }); } catch (_e) {} }, 220);
}
function _disarmIncidentPreview() {
    clearTimeout(_showPreviewTimer);
    hideIncidentPreview();
}

window.playPreviewAudio = function (url, btn) {
    if (currentAudio && !currentAudio.paused) {
        currentAudio.pause();
        if (currentAudio._btn) currentAudio._btn.innerHTML = '<i class="fa-solid fa-play"></i> Play Audio';
        if (currentAudio._url === url) { currentAudio = null; return; }
    }
    currentAudio = new Audio(url);
    currentAudio._btn = btn;
    currentAudio._url = url;
    btn.innerHTML = '<i class="fa-solid fa-pause"></i> Playing...';
    currentAudio.play();
    currentAudio.onended = () => { btn.innerHTML = '<i class="fa-solid fa-play"></i> Play Audio'; };
};

// ── Detail Panel ─────────────────────────────────────────────────────────────
// skipFly=true when called from poll loop - avoids jarring map movement on auto-refresh
// Detail-only report cache: lets the detail panel open a MERGED (feed-hidden)
// duplicate report WITHOUT re-adding it to allReports (which would un-collapse it
// in the feed). Backs the "switch to a duplicate report" affordance in the
// Related Duplicate Reports panel - the LEFT feed stays one collapsed card while
// the RIGHT detail flips between the primary and its duplicates.
let _detailOnlyReport = null;
async function _fetchReportByIdRaw(id) {
    try { const res = await fetch(`${API}/${encodeURIComponent(id)}`); if (res.ok) return await res.json(); } catch (_e) {}
    return null;
}
window._switchToReport = async (id) => {
    if (!id) return;
    let r = (allReports || []).find((x) => x && x.id === id);
    if (!r) r = await _fetchReportByIdRaw(id);   // merged/hidden report → fetch by id, do NOT add it to the feed
    if (!r) { showToast('Could not open report', 'error'); return; }
    _detailOnlyReport = r;
    try { window.selectReport(id); } catch (_e) {}
};

window.selectReport = (id, skipFly = false) => {
    const _prevSel = selectedId;
    selectedId = id;
    const r = allReports.find(x => x.id === id)
        || (_detailOnlyReport && _detailOnlyReport.id === id ? _detailOnlyReport : null);
    if (!r) return;

    // v111 lifecycle tabs + v64 deep-link reveal: a newly-selected incident may
    // live in a RESPONDING / RESOLVED tab while the feed shows another. The tab
    // filter would hide its card so CrispNav can't scroll to it. On a genuine NEW
    // selection (not a poll re-render), switch to its tab and re-render so the card
    // enters the DOM. Skipped while a queue owns the population (tabs neutralized)
    // and never fights a manual tab change for the already-open incident.
    if (!skipFly && id !== _prevSel && !_activeQueue) {
        // A rejected report lives in the Rejected tab (its status may still read
        // PENDING — rejection is a verdict, not a status), so target that tab.
        const wantTab = ((r.reviewer_verdict || 'NOT_REVIEWED') === 'REJECTED') ? 'rejected' : _statusTabFor(r.status);
        if (wantTab !== _activeStatusTab) {
            _activeStatusTab = wantTab;
            try { _syncStatusTabsEnabled(); renderFeed(); } catch (_e) {}
        }
    }

    const panel = document.getElementById('detail-panel');
    // The detail is a GLOBAL overlay - reparent it to <body> so it renders over
    // any context (it ships nested in the incidents view, which is display:none
    // on the operations route; a hidden ancestor would otherwise clip it).
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.style.display = 'flex';
    panel.classList.remove('detail-panel--building', 'detail-panel--operation');   // plain incident detail
    // D2: move focus into the panel so keyboard users can reach + Escape it.
    try { window.__dpPriorFocus = document.activeElement; panel.setAttribute('tabindex', '-1'); panel.focus({ preventScroll: true }); } catch (_e) {}

    // P1.5 - fire-and-forget tier-status refresh so the tier switcher /
    // gallery thumbs show post-poll-cycle fresh state instead of waiting
    // for the next listing poll (~4 s). Only fires once per open (not on
    // re-renders triggered by the refresh itself - `skipFly=true` is the
    // recursion guard since the refresh callback always passes true).
    if (!skipFly) {
        _refreshTierStatusForDetail(id);
    }

    const allImages = r.media?.filter(m => m.type === 'IMAGE') || [];
    // Guaranteed-delivery: each captured photo may have up to 3 Media rows
    // (SMALL/MEDIUM/LARGE) linked by photo_group_id. Fold them into groups
    // so the gallery shows one thumb per photo, and pick the best-available
    // variant for each group.
    const photoGroups = groupPhotos(allImages);
    const img = allImages[0] || null;  // kept for existing downstream refs
    const audio = r.media?.find(m => m.type === 'AUDIO');
    const loc   = r.location;
    const ai    = r.ai_analysis;
    const v     = r.verification;
    const sevColor = SEV_COLORS[r.severity] || '#64748b';
    const infraIcon = INFRA_ICONS[r.infrastructure_type] || 'fa-triangle-exclamation';
    const locName = loc?.user_location_name || loc?.device_location_name || null;
    const locLat  = loc?.latitude;
    const locLng  = loc?.longitude;

    // ── Urgency signals ──
    const nearbyCount = allReports.filter(rr => rr.id !== r.id && rr.location && loc &&
        haversineKm(loc.latitude, loc.longitude, rr.location.latitude, rr.location.longitude) < 5).length;
    const isCriticalInfra = ['HOSPITAL','POWER','POWER_PLANT','WATER','WATER_TREATMENT'].includes(r.infrastructure_type);
    const waitMs = Date.now() - new Date(ensureUTC(r.server_created_at)).getTime();
    const waitMin = Math.round(waitMs / 60000);

    // ── Image HTML (compact 160px) ──
    // Guaranteed-delivery: pick the best complete variant of the FIRST
    // photo group (main photo). Falls back to partial thumbnail if nothing
    // complete yet. Progressive-upgrade on subsequent polls is handled by
    // `_maybeUpgradeDetailImage` below, which swaps the <img src> without
    // rebuilding the DOM.
    const primaryGroup = photoGroups[0] || null;
    // Phase 2 (May 2026): default to the SMALLEST complete variant inline -
    // typical analyst flow is "skim 50 reports, pull 5 to lightbox", so
    // pre-fetching LARGE on every detail-panel render burned ~10× the
    // bandwidth analysts actually consumed. Honour any manual override
    // first, then fall back to `thumbVariant()` (smallest first). The
    // user can still click LARGE in the tier switcher to upgrade.
    let variantPick = primaryGroup ? thumbVariant(primaryGroup) : null;
    const overrideTier = _tierOverride.get(r.id);
    if (primaryGroup && overrideTier) {
        const manual = primaryGroup.members.find(
            m => m.resolution_tier === overrideTier &&
                 m.assembly_status === 'complete' && m.url
        );
        if (manual) {
            variantPick = {
                src: getMediaUrl(manual.url),
                tier: manual.resolution_tier,
                isFinal: true,
                mediaId: manual.id,
            };
        }
        // If the chosen tier isn't complete yet, fall through to bestVariant.
    }
    // Show the overall progress of the group (max across any variant) so
    // users see upload motion even before the SMALL variant completes.
    const imgPct = primaryGroup
        ? Math.max(0, ...primaryGroup.members.map(m => m.completion_pct || 0))
        : 0;
    const imgComplete = variantPick?.isFinal === true;
    const imgSrc = variantPick?.src || '';
    // Phase 2: 3-button tier switcher. Replaces the old read-only chip.
    // Each button is disabled when that tier hasn't finished assembly yet;
    // hovering shows the completion-pct of the pending tier.
    const tierSwitcher = primaryGroup ? _buildTierSwitcher(r.id, primaryGroup, variantPick?.tier) : '';
    // Phase 1.5: if nothing else is renderable yet, try the report's
    // blurhash for instant first-visual. Decoding is cached; returns null
    // when the hash is missing (legacy report) or malformed - in which case
    // we fall back to the original "awaiting media" icon placeholder.
    const blurDataUrl = !imgSrc ? blurhashToDataURL(r.blurhash) : null;
    // Phase 2 (May 2026): the lightbox is the explicit "I want HQ" trigger.
    // Even if the inline image is showing the LOW thumb, clicking opens the
    // HIGHEST complete variant - which is what the analyst means by "show
    // me the photo". If only LOW is uploaded so far, we just reuse that.
    const lightboxPick = primaryGroup ? highestCompleteVariant(primaryGroup) : null;
    const lightboxSrc = lightboxPick?.src || imgSrc;
    const imgHtml = primaryGroup ? (
        imgComplete
            ? `<div class="dp-img" data-group-id="${primaryGroup.group_id || ''}"
                   data-current-tier="${variantPick.tier}"
                   onclick="openGallery('${r.id}', 0)">
                   <img src="${imgSrc}" class="img-full-layer img-ready">
                   ${tierSwitcher}
               </div>`
            : imgSrc
                ? `<div class="dp-img dp-img-uploading" data-group-id="${primaryGroup.group_id || ''}">
                       <img src="${imgSrc}" class="img-thumb-bg">
                       <div class="img-progress-overlay">
                           <div class="chunk-progress-track"><div class="chunk-progress-fill" style="width:${imgPct}%"></div></div>
                           <span class="partial-img-label"><i class="fa-solid fa-cloud-arrow-up fa-pulse"></i> ${imgPct.toFixed(0)}%</span>
                       </div>
                       ${tierSwitcher}
                   </div>`
                : blurDataUrl
                    // Phase 1.5: blurhash placeholder - the <div> carries
                    // `data-group-id` so `_maybeUpgradeDetailImage` finds
                    // and hot-swaps this element once a real variant lands.
                    ? `<div class="dp-img dp-img-uploading" data-group-id="${primaryGroup.group_id || ''}">
                           <img src="${blurDataUrl}" class="img-thumb-bg" style="filter:blur(8px) saturate(1.1);">
                           <div class="img-progress-overlay">
                               <div class="chunk-progress-track"><div class="chunk-progress-fill" style="width:${imgPct}%"></div></div>
                               <span class="partial-img-label"><i class="fa-solid fa-cloud-arrow-up fa-pulse"></i> ${imgPct.toFixed(0)}%</span>
                           </div>
                           ${tierSwitcher}
                       </div>`
                    : imgPct > 0
                        ? `<div class="dp-img dp-img-placeholder"><div class="chunk-progress-track" style="width:80%"><div class="chunk-progress-fill" style="width:${imgPct}%"></div></div><span style="font-size:12px;color:#6b7280;">${imgPct.toFixed(0)}%</span></div>`
                        : `<div class="dp-img dp-img-placeholder"><i class="fa-solid fa-camera" style="font-size:18px;color:#334155;"></i></div>`
    ) : (
        // No media rows at all (meta POST landed but upload hasn't started):
        // if the report carries a blurhash, use it as the placeholder instead
        // of the "camera-slash" icon - gives the analyst an immediate sense
        // of the scene while the uploader negotiates the first chunk.
        blurDataUrl
            ? `<div class="dp-img dp-img-placeholder" style="padding:0;overflow:hidden;">
                   <img src="${blurDataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;filter:blur(8px) saturate(1.1);">
               </div>`
            : `<div class="dp-img dp-img-placeholder"><i class="fa-solid fa-camera-slash" style="font-size:16px;color:#334155;"></i></div>`
    );

    // Satellite imagery + verification analysis now render inside the Confidence
    // Assessment breakdown (window._renderSatelliteAnalysis), NOT in this Evidence
    // section - so credibility lives in one workspace. (Removed: the inline
    // satSrc/satHtml/imgMatchHtml/vGaugeHtml builders + the Photo/Satellite/Compare
    // view-toggle.)

    // ── Audio HTML (compact inline strip) ──
    const aPct = (audio?.completion_pct ?? 0);
    const aComplete = audio?.assembly_status === 'complete' && audio?.url;
    const aPartialUrl = audio?.thumbnail_url ? _withCacheBust(getMediaUrl(audio.thumbnail_url), '_cb', Math.round(aPct/5)*5) : '';
    const audioPlayUrl = aComplete ? getMediaUrl(audio.url) : aPartialUrl;


    // ── Build decision-first detail panel ──
    // Header: type + severity + status + confidence + time
    document.getElementById('detail-title').innerHTML = `
        <i class="fa-solid ${infraIcon}" style="color:${sevColor};"></i>
        ${infraDisplayLabel(r.infrastructure_type, r.infrastructure_sub_type)}
        <span class="detail-sev-badge detail-sev-${r.severity}">${r.severity}</span>
        ${(() => { const ds = _displayStatus(r); const _age = timeAgo(r.server_created_at); return `<span class="dp-display-status dp-ds-${ds.cls}" title="${ds.title}">${ds.label}${_age ? ` · ${_age}` : ''}</span>`; })()}
        ${(() => {
            // UX-B: the channel badge IS the source entry-point. Click reveals a popover
            // with full channel name + Report ID + submitted + media - replacing the
            // separate "Source Details" section. (The standalone time badge is gone too;
            // the age now lives on the status pill.)
            const src = r.source || 'APP';
            const SHORT = {APP:'<i class="fa-solid fa-mobile-screen-button"></i> App',ANDROID:'<i class="fa-solid fa-robot"></i> Android',WHATSAPP:'<i class="fa-brands fa-whatsapp"></i> WhatsApp',TELEGRAM:'<i class="fa-brands fa-telegram"></i> Telegram',SMS:'<i class="fa-solid fa-comment-sms"></i> SMS',IVR:'<i class="fa-solid fa-phone"></i> Call'};
            const FULL = {APP:'Progressive Web App',ANDROID:'Android App',WHATSAPP:'WhatsApp Bot',TELEGRAM:'Telegram Bot',SMS:'SMS Gateway',IVR:'IVR Voice Call'};
            const submitted = new Date(ensureUTC(r.server_created_at)).toLocaleString();
            return `<span class="dp-src-wrap">
                <button class="dp-source-badge dp-src-${src.toLowerCase()}" title="Source - click for details"
                        onclick="event.stopPropagation(); const p=this.nextElementSibling; const open=p.classList.toggle('open'); if(open){const c=ev=>{if(!this.parentElement.contains(ev.target)){p.classList.remove('open');document.removeEventListener('click',c);}}; setTimeout(()=>document.addEventListener('click',c),0);}">
                    ${SHORT[src]||SHORT.APP} <i class="fa-solid fa-angle-down dp-src-caret"></i></button>
                <div class="dp-src-pop">
                    <div class="dp-src-pop-row"><span class="dp-src-pop-k">Channel</span><span>${FULL[src]||FULL.APP}</span></div>
                    <div class="dp-src-pop-row"><span class="dp-src-pop-k">Report ID</span><span class="dp-src-pop-id">${r.id.substring(0,12)}… <button class="dp-copy-btn" onclick="event.stopPropagation();navigator.clipboard.writeText('${r.id}');showToast('Report ID copied','success')"><i class="fa-solid fa-copy"></i></button></span></div>
                    <div class="dp-src-pop-row"><span class="dp-src-pop-k">Media</span><span>${r.received_media}/${r.expected_media} received</span></div>
                    <div class="dp-src-pop-row"><span class="dp-src-pop-k">Submitted</span><span>${submitted}</span></div>
                </div>
            </span>`;
        })()}
    `;

    // Urgency alerts
    const urgencyHtml = (() => {
        const alerts = [];
        // Severity is shown ONCE on the header badge - no "CRITICAL SEVERITY" echo here.
        if (isCriticalInfra) alerts.push(`<span class="dp-urgency dp-urgency-red"><i class="fa-solid fa-building-shield"></i> Critical Infrastructure</span>`);
        if (nearbyCount > 0) alerts.push(`<button class="dp-urgency dp-urgency-amber dp-nearby-cta" onclick="event.stopPropagation();_showNearbyModal('${r.id}')" title="Show the nearby incidents"><i class="fa-solid fa-layer-group"></i> ${nearbyCount} more report${nearbyCount > 1 ? 's' : ''} nearby <i class="fa-solid fa-chevron-right dp-nearby-caret"></i></button>`);
        // UX-A: "Waiting Xm" removed - the status pill now carries the age
        // ("Needs review · 42m ago"), so this was a third copy of the same fact.
        return alerts.length ? `<div class="dp-urgency-bar">${alerts.join('')}</div>` : '';
    })();

    // Transcript with keyword highlighting
    const highlightKeywords = (text, truncate = true) => {
        if (!text) return '';
        // Escape HTML first to prevent XSS, then apply keyword highlighting
        let safe = escapeHtml(truncate && text.length > 150 ? text.substring(0, 150) : text);
        const keywords = ['help','stuck','trapped','injury','injured','flood','fire','collapse','damage','emergency','rescue','save','water','destroy'];
        keywords.forEach(k => {
            const re = new RegExp(`(${k})`, 'gi');
            safe = safe.replace(re, '<mark class="dp-keyword">$1</mark>');
        });
        return safe + (text.length > 150 ? '...' : '');
    };

    const rawTranscript = ai?.transcription || '';
    const aiSummary = ai?.ai_summary || '';
    const userDescription = r.description || '';
    // For display: AI summary takes priority, fallback to description, then raw transcript
    const primaryText = aiSummary || userDescription || rawTranscript;
    // Show raw transcript if it differs from AI summary (so admin sees both)
    const showRawTranscript = rawTranscript && rawTranscript !== aiSummary && rawTranscript !== userDescription;

    // Build audio players for ALL audio media (location + description recordings)
    const allAudioMedia = r.media?.filter(m => m.type === 'AUDIO') || [];

    // ── Conditional evidence visibility ──
    // Evidence is the CITIZEN'S media only (photo + audio). Satellite analysis
    // now lives entirely inside the Confidence Assessment breakdown, so the
    // operator never leaves the assessment to review satellite evidence.
    const hasVisualEvidence = !!img;
    const isVoiceOrText = ['IVR','SMS'].includes(r.source);

    // Quick summary text for top bar (for data-rich sources only)
    const displayText = userDescription || rawTranscript || aiSummary || '';
    // Use DB-persisted ai_assessment (survives refresh) or client-cached _aiAssessment
    const cachedAA = r.ai_assessment || r._aiAssessment || null;
    const aaScore = cachedAA?.confidence_score ?? cachedAA?.score ?? null;
    const aaAction = cachedAA?.suggested_action ?? cachedAA?.action ?? '';
    const aaSummary = cachedAA?.summary ?? '';
    const aaDetails = cachedAA?.details ?? '';

    // Phase J.2 (May 2026) - one-sentence operator headline.
    // Operators want to know "what happened / where / severity /
    // open status" without scanning chips. Derived from existing
    // fields; zero backend change.
    const _headline = (() => {
        const infraLbl = infraDisplayLabel(r.infrastructure_type, r.infrastructure_sub_type) || 'Incident';
        const sevLbl = r.severity || 'UNKNOWN';
        const locShort = (() => {
            const raw =
                (r.location && (r.location.user_location_name || r.location.device_location_name))
                || '';
            if (!raw) return '';
            // Last 1-2 comma segments - most-specific then city.
            const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
            if (parts.length >= 2) return `${parts[0]}, ${parts[parts.length - 1]}`;
            return parts[0] || '';
        })();
        const waitChunk = waitMin > 0 && (r.status === 'PENDING' || r.status === 'VERIFIED')
            ? ` · waiting ${waitMin >= 60 ? Math.floor(waitMin/60) + 'h ' + (waitMin%60) + 'm' : waitMin + 'm'}`
            : '';
        const respChunk =
            r.status === 'RESOLVED' ? ' · resolved'
            : r.status === 'RESPONDING' ? ' · responder on the way'
            : r.status === 'FALSE_ALARM' ? ' · false alarm'
            : '';
        // Header is IDENTITY-ONLY: severity lives on the header badge and elapsed
        // on the time badge / Waiting chip, so neither is repeated here (kills the
        // CRITICAL-3x / waiting-2x duplication). waitChunk/respChunk/sevLbl retained
        // above only as documentation of what used to live here.
        void sevLbl; void waitChunk; void respChunk;
        return `${infraLbl}${locShort ? ' at ' + locShort : ''}`;
    })();

    // Breadcrumb (P3b) - keeps the Global vs Operation context visible while the
    // incident is open: "Global › Incident" or "Global › Operations › {op} ›
    // Incident". Segments are clickable to step back out to that scope.
    const _bcArrow = '<i class="fa-solid fa-angle-right dp-bc-sep" aria-hidden="true"></i>';
    const _gSeg = '<a class="dp-bc-seg" onclick="window.__crispRouter&&window.__crispRouter.navigate(\'/incidents\')">Global</a>';
    // Full operational hierarchy, ALWAYS uniform: Global › Operation › Building ›
    // Incident › #id. The Operation/Building crumbs are real links when present and
    // muted, non-clickable placeholders ("No operation" / "Unmapped building") when a
    // level is genuinely absent - the spine never silently collapses to "Global › #id".
    const _idSeg = `<span class="dp-bc-cur" title="Incident report ${escapeHtml(r.id)}">#${escapeHtml(String(r.id).slice(0, 8))}</span>`;
    const _opSeg = r.crisis_event_id
        ? `<a class="dp-bc-seg dp-bc-op" onclick="window.openOperationSummary&&window.openOperationSummary('${r.crisis_event_id}')">${escapeHtml(_opCrumbName(r))}</a>` + _bcArrow
        : `<span class="dp-bc-seg dp-bc-absent" title="Not assigned to an operation">${_HIER_OP_ABSENT}</span>` + _bcArrow;
    const _bldgSeg = _hasBuildingLink(r)
        ? `<a class="dp-bc-seg dp-bc-bldg" title="Show this building's incidents in the feed" onclick="window.setBuildingScope&&window.setBuildingScope(decodeURIComponent('${encodeURIComponent(r.building_id)}'))">${escapeHtml(_bldgCrumbName(r))}</a>` + _bcArrow
        : `<span class="dp-bc-seg dp-bc-absent" title="No building tagged">${_HIER_BLDG_ABSENT}</span>` + _bcArrow;
    // Phase 2E: the report's parent INCIDENT is a clickable crumb → opens the
    // Incident Detail (sibling reports + merge/split). Only when assigned (every
    // report gets one at intake; legacy rows via the 0059 backfill).
    const _incSeg = r.incident_id
        ? `<a class="dp-bc-seg dp-bc-incident" title="View this incident — sibling reports, merge/split" onclick="window.openIncidentDetail&&window.openIncidentDetail(decodeURIComponent('${encodeURIComponent(r.incident_id)}'))">Incident</a>` + _bcArrow
        : '';
    const _bc = _gSeg + _bcArrow + _opSeg + _bldgSeg + _incSeg + _idSeg;

    document.getElementById('detail-body').innerHTML = `
        <!-- Phase J.2 - operator headline + 6-section restructure.
             Headline gives the analyst the at-a-glance answer to
             "what / where / severity / what's the open status?"
             without needing to scan the chip row. Sections that
             follow use the existing rendering blocks wrapped in
             <details> elements with the first two open by default
             (Incident Summary + Response Actions) per operator
             confirmation. -->
        <nav class="dp-breadcrumb" aria-label="Breadcrumb">${_bc}</nav>
        <!-- Dedup: the old dp-headline ("{type} at {place}") is REMOVED - the type
             lives once in the header title and the place lives once in the
             Location & Building section. -->
        ${(() => { const _sc = _incidentStatusChips(r); return _sc ? `<div class="dp-status-chips">${_sc}</div>` : ''; })()}
        <!-- Report Assessment: the ONE Confidence Score card. Clicking it opens
             the investigative workspace (composition · satellite · duplicates ·
             evidence · AI reasoning) - duplicate analysis lives there now, not as
             a separate panel section. -->
        ${_renderIncidentAssessment(r)}
        <!-- ① TOP: Credibility Check result OR "Credibility Check" button -->
        <div class="dp-action-bar">
            <!-- Credibility now lives in the single Incident Assessment section
                 above; PDF/ZIP export stays here until the Export & Share
                 section lands (Phase D). -->
            <!-- UX-I: single-incident Export menu - only the formats that apply to ONE
                 incident; the aggregate formats live in the full Export Center (link). -->
            <div class="dp-top-row dp-top-row-export">
                <div class="dp-export-wrap">
                    <button class="dp-export-btn" title="Export this incident"
                            onclick="event.stopPropagation(); const mn=this.nextElementSibling; const o=mn.classList.toggle('open'); if(o){const c=ev=>{if(!this.parentElement.contains(ev.target)){mn.classList.remove('open');document.removeEventListener('click',c);}};setTimeout(()=>document.addEventListener('click',c),0);}">
                        <i class="fa-solid fa-file-export"></i> Export <i class="fa-solid fa-angle-down dp-export-caret"></i></button>
                    <div class="dp-export-menu">
                        <div class="dp-export-grp">This incident</div>
                        <button onclick="exportPDF('${r.id}');this.closest('.dp-export-menu').classList.remove('open')"><i class="fa-regular fa-file-pdf"></i> Incident PDF</button>
                        <button onclick="downloadEvidenceBundle('${r.id}');this.closest('.dp-export-menu').classList.remove('open')"><i class="fa-solid fa-file-zipper"></i> Evidence bundle (ZIP)</button>
                        <button onclick="exportIncidentFormat('${r.id}','geojson');this.closest('.dp-export-menu').classList.remove('open')"><i class="fa-solid fa-earth-americas"></i> GeoJSON</button>
                        <button onclick="exportIncidentFormat('${r.id}','kml');this.closest('.dp-export-menu').classList.remove('open')"><i class="fa-solid fa-globe"></i> KML</button>
                        <button onclick="exportIncidentFormat('${r.id}','csv');this.closest('.dp-export-menu').classList.remove('open')"><i class="fa-solid fa-table-list"></i> CSV</button>
                        <div class="dp-export-div"></div>
                        <button class="dp-export-link" onclick="(window.__crispRouter&&window.__crispRouter.navigate)?window.__crispRouter.navigate('/exports'):(window.location.hash='#/exports');this.closest('.dp-export-menu').classList.remove('open')"><i class="fa-solid fa-arrow-up-right-from-square"></i> Open full Export Center…</button>
                    </div>
                </div>
            </div>
            <!-- Actions (Jun 2026 - state machine): the available actions depend on
                 the report's CURRENT decision state, so a settled report only offers
                 the reversal of that decision (not a fresh Reject/Delete).
                 • REJECTED (verdict)   → "Rejected" banner + Revert decision.
                 • RESPONDING (notified)→ "Response team notified" banner + Mark
                                          Resolved / Mark as False Alarm / Revert.
                                          (No Reject/Delete - the notice already went
                                          out; a false alarm is the follow-up.)
                 • RESOLVED / FALSE_ALARM → status banner + Reopen.
                 • OPEN (PENDING/VERIFIED) → Notify Response Team + Reject + Delete. -->
            <div class="dp-actions">
                ${(() => {
                    const rid = r.id;
                    if ((r.reviewer_verdict || 'NOT_REVIEWED') === 'REJECTED') {
                        return `<div class="dp-act-banner dp-act-banner-rejected"><i class="fa-solid fa-circle-xmark"></i> <span>Rejected</span>${r.action_taken ? ' · <span class="dp-act-reason">' + escapeHtml(r.action_taken) + '</span>' : ''}</div>`
                            + `<button class="dp-act-primary dp-act-revert" onclick="revertRejection('${rid}')"><i class="fa-solid fa-rotate-left"></i> Revert decision</button>`;
                    }
                    if (r.status === 'RESPONDING') {
                        return `<div class="dp-act-banner dp-act-banner-responding"><i class="fa-solid fa-tower-broadcast"></i> <span>Response team notified</span></div>`
                            + `<button class="dp-act-primary dp-act-resolve" onclick="patchReport('${rid}','resolve')"><i class="fa-solid fa-circle-check"></i> Mark Resolved</button>`
                            + `<div class="dp-actions-row2">`
                            + `<button class="dp-act-2 dp-act-false" onclick="patchReport('${rid}','false-alarm')"><i class="fa-solid fa-ban"></i> False Alarm</button>`
                            + `<button class="dp-act-2 dp-act-revert" onclick="reopenReport('${rid}')"><i class="fa-solid fa-rotate-left"></i> Revert</button>`
                            + `</div>`;
                    }
                    if (r.status === 'RESOLVED') {
                        return `<div class="dp-act-banner dp-act-banner-resolved"><i class="fa-solid fa-circle-check"></i> <span>Resolved</span></div>`
                            + `<button class="dp-act-2 dp-act-revert" onclick="reopenReport('${rid}')"><i class="fa-solid fa-rotate-left"></i> Reopen</button>`;
                    }
                    if (r.status === 'FALSE_ALARM') {
                        return `<div class="dp-act-banner dp-act-banner-false"><i class="fa-solid fa-ban"></i> <span>False alarm</span></div>`
                            + `<button class="dp-act-2 dp-act-revert" onclick="reopenReport('${rid}')"><i class="fa-solid fa-rotate-left"></i> Reopen</button>`;
                    }
                    // OPEN (PENDING / legacy VERIFIED, not rejected).
                    return `<button class="dp-act-primary dp-act-respond" onclick="notifyResponseTeam('${rid}')"><i class="fa-solid fa-tower-broadcast"></i> Notify Response Team</button>`
                        + `<div class="dp-actions-row2">`
                        + `<button class="dp-act-2 dp-act-reject" onclick="openRejectModal('${rid}')"><i class="fa-solid fa-circle-xmark"></i> Reject</button>`
                        + `<button class="dp-act-2 dp-act-delete" onclick="openDeleteModal('${rid}')"><i class="fa-solid fa-trash-can"></i> Delete</button>`
                        + `</div>`;
                })()}
            </div>
        </div>

        <!-- Phase F.2.a (May 2026) - Per-incident timeline. Surfaces the
             lifecycle audit data the backend already records (status
             transitions, media additions, satellite verdict, deletion
             grace) so operators have a clear chronological picture
             without leaving the detail panel. Collapsed by default to
             keep the panel compact on first open; click "Timeline" to
             expand. Pure dashboard-side render from the data the LIST
             endpoint already returns - no backend changes. -->
        <!-- UX-E: ONE "History" accordion = the lifecycle timeline + the admin
             audit ribbon (was two separate Timeline / Activity Log accordions -
             both are chronological "what happened + who acted"). The audit ribbon
             self-hides when empty (via _fetchReportAuditTrail); the timeline is
             always present, so the History section itself is never auto-hidden
             (no dp-section-activity id here). -->
        <details class="dp-section dp-section-history" open>
            <summary class="dp-section-header">
                <i class="fa-solid fa-clock-rotate-left"></i>
                <span data-i18n="detail_history">History</span>
                <i class="fa-solid fa-chevron-down dp-section-caret"></i>
            </summary>
            <div class="dp-section-body">
                ${_renderIncidentTimeline(r)}
                <div class="dp-audit-ribbon" id="dp-audit-ribbon-${r.id}" data-report-id="${r.id}">
                    <div class="dp-audit-loading"><i class="fa-regular fa-clock"></i> Loading admin actions…</div>
                </div>
            </div>
        </details>

        <!-- ② Urgency alerts -->
        ${urgencyHtml}

        <!-- ②b Incident attributes ONLY (crisis type / damage / debris / reporter /
             crisis-form). Building + location items (infrastructure_name, building
             history, version, needs-mapping) moved to the Location & Building
             section so each appears exactly once. -->
        ${r.crisis_type || r.damage_classification || r.debris_clearing_needed || r.service_status || r.form_pack_id || r.reporter_badge || r.reporter_tier ? `
        <!-- Wider panel: attributes are a calm, always-visible chip row in the Summary
             glance (no longer a collapsed accordion) - fewer clicks, less scroll. -->
        <div class="dp-attrs">
        <div class="dp-undp-fields" style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0;">
            <!-- UX-F: attribute chips are CALM-neutral. Saturated colour is reserved for
                 the two decision signals only - severity (header) + credibility (Assessment). -->
            ${r.crisis_type ? `<span class="dp-field-badge dp-attr"><i class="fa-solid fa-cloud-bolt"></i> ${crisisLabel(r.crisis_type)}</span>` : ''}
            ${r.damage_classification ? `<span class="dp-field-badge dp-attr"><i class="fa-solid fa-building-circle-xmark"></i> ${r.damage_classification.replace(/_/g,' ')}</span>` : ''}
            ${r.debris_clearing_needed ? `<span class="dp-field-badge dp-attr"><i class="fa-solid fa-truck-pickup"></i> Debris clearing</span>` : ''}
            <!-- masked reporter identity badge (neutral) + reporter TIER chip. The
                 reporter credibility SCORE stays in the Assessment "Reporter" segment;
                 the V4 reporter_tier is surfaced here as a calm always-visible chip
                 (a UNDP must-surface field) so it shows regardless of whether an
                 assessment has run - the Assessment is gated on a server-computed
                 credibility pass, the tier is known the moment the report arrives. -->
            ${r.reporter_badge ? `<span class="dp-field-badge dp-attr dp-reporter-badge" style="cursor:${r.user_id ? 'pointer' : 'default'};" ${r.user_id ? `onclick="openReporterProfile('${r.user_id}')"` : ''} title="${r.user_id ? 'Click to view reporter details (admin only)' : ''}"><i class="fa-solid fa-user-check"></i> ${escapeHtml(r.reporter_badge)}</span>` : ''}
            ${(r.reporter_tier && (window.CRISP_TIERS_BY_ID || {})[r.reporter_tier]) ? (() => {
                const _t = window.CRISP_TIERS_BY_ID[r.reporter_tier];
                return `<span class="dp-field-badge dp-attr dp-reporter-tier" data-tier="${r.reporter_tier}" title="Reporter tier: ${escapeHtml(_t.label)} - ${escapeHtml(_t.criterion)}">${_t.emoji} ${escapeHtml(_t.label)}</span>`;
            })() : ''}
            ${_isStaleArrival(r) ? `<span class="dp-field-badge dp-stale-arrival" title="Reporter captured this offline. The report was drained from the device's pending queue on reconnect ${timeAgo(r.server_created_at)}."><i class="fa-solid fa-cloud-arrow-up"></i> Offline-queued · Captured ${timeAgo(r.client_created_at)}</span>` : ''}
            <!-- Dedup: "Needs mapping" + the version ribbon moved to the
                 Location & Building section (the single home for building facts). -->
            <!-- B3 - Dynamic Crisis Form provenance tag. Shows when the report came
                 through a geo-gated crisis pack; the pack title + event name are
                 resolved asynchronously post-render (see selectReport). -->
            ${r.form_pack_id ? `<span id="dp-form-tag-${r.id}" class="dp-field-badge dp-attr dp-crisis-form-tag" title="Submitted via a Dynamic Crisis Form pack"><i class="fa-solid fa-clipboard-list"></i> Crisis form${r.form_pack_version ? ` · v${r.form_pack_version}` : ''}</span>` : ''}
        </div>
        ${r.service_status ? (() => {
            const ss = r.service_status;
            // Phase 1.6 (May 2026) - full UNDP Appendix-1 enum coverage.
            // The PWA V4 flow can now emit INTERMITTENT / LOAD_SHEDDING /
            // BLACKOUT (electricity) and FULLY_OPERATIONAL /
            // PARTIALLY_OPERATIONAL / NOT_OPERATIONAL (health). Map each
            // value to (color, icon, human label). Unknown values fall
            // through to the legacy "?" treatment so newer PWA enums
            // never break the old dashboard build.
            const SVC_META = {
                // Legacy compact 3-level scale
                'OPERATIONAL':          { c: '#4ade80', i: 'fa-circle-check',          label: 'Operational' },
                'DISRUPTED':            { c: '#fbbf24', i: 'fa-triangle-exclamation',  label: 'Disrupted' },
                'DESTROYED':            { c: '#f87171', i: 'fa-circle-xmark',          label: 'Destroyed' },
                'UNKNOWN':              { c: '#64748b', i: 'fa-circle-question',       label: 'Unknown' },
                // UNDP Appendix-1 electricity expansions
                'INTERMITTENT':         { c: '#fbbf24', i: 'fa-triangle-exclamation',  label: 'Intermittent' },
                'LOAD_SHEDDING':        { c: '#fb923c', i: 'fa-bolt-lightning',        label: 'Load shedding' },
                'BLACKOUT':             { c: '#f87171', i: 'fa-circle-xmark',          label: 'Blackout' },
                // UNDP Appendix-1 health expansions
                'FULLY_OPERATIONAL':    { c: '#4ade80', i: 'fa-circle-check',          label: 'Fully operational' },
                'PARTIALLY_OPERATIONAL':{ c: '#fbbf24', i: 'fa-triangle-exclamation',  label: 'Partially operational' },
                'NOT_OPERATIONAL':      { c: '#f87171', i: 'fa-circle-xmark',          label: 'Not operational' },
            };
            const meta = v => SVC_META[v] || { c: '#64748b', i: 'fa-circle-question', label: v };
            let html = '<div class="dp-svc-status" style="display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 8px;">';
            if (ss.electricity && ss.electricity !== 'UNKNOWN') {
                const m = meta(ss.electricity);
                html += `<span class="dp-field-badge dp-svc-electricity" data-value="${ss.electricity}" style="background:rgba(255,255,255,0.04);color:${m.c};"><i class="fa-solid ${m.i}"></i> ⚡ ${m.label}</span>`;
            }
            if (ss.water && ss.water !== 'UNKNOWN') {
                const m = meta(ss.water);
                html += `<span class="dp-field-badge dp-svc-water" data-value="${ss.water}" style="background:rgba(255,255,255,0.04);color:${m.c};"><i class="fa-solid ${m.i}"></i> 💧 ${m.label}</span>`;
            }
            if (ss.health && ss.health !== 'UNKNOWN') {
                const m = meta(ss.health);
                html += `<span class="dp-field-badge dp-svc-health" data-value="${ss.health}" style="background:rgba(255,255,255,0.04);color:${m.c};"><i class="fa-solid ${m.i}"></i> 🏥 ${m.label}</span>`;
            }
            // Phase 1.6 - humanize pressing_needs codes too. The PWA
            // emits raw codes (food_water, shelter, medical, ...).
            // Operators want a readable label; keep the raw code as
            // a data-attribute so filtering can still match exactly.
            if (ss.pressing_needs?.length) {
                const NEED_LABELS = {
                    'food_water':       'Food & water',
                    'shelter':          'Shelter',
                    'medical':          'Medical care',
                    'rescue':           'Rescue',
                    'evacuation':       'Evacuation',
                    'sanitation':       'Sanitation',
                    'communication':    'Communication',
                    'other':            'Other',
                };
                const needsHuman = ss.pressing_needs.map(n => NEED_LABELS[n] || n).join(', ');
                html += `<span class="dp-field-badge dp-svc-needs" data-needs="${ss.pressing_needs.join(',')}" style="background:rgba(239,68,68,0.1);color:#fca5a5;"><i class="fa-solid fa-exclamation-circle"></i> Needs: ${escapeHtml(needsHuman)}</span>`;
            }
            html += '</div>';
            return html;
        })() : ''}
        </div>
        ` : ''}

        <!-- ②c Crisis-pack curated answers (Report.form_data) -->
        ${_renderFormDataSection(r)}

        <!-- ③ Evidence: Images gallery + Satellite Verify -->
        ${hasVisualEvidence ? `
        <div class="dp-evidence-card">
            <div class="dp-img-view" id="dp-img-view-${r.id}" style="position:relative;">
                ${imgHtml}
                <div class="dp-pii-badge"><i class="fa-solid fa-shield-halved"></i> PII Protected</div>
                ${photoGroups.length > 1 ? `<div class="dp-img-count-badge" title="This report has ${photoGroups.length} captured photos - tap a thumbnail or the image to open the gallery.">
                    <i class="fa-solid fa-images"></i> Photo <span class="dp-img-count-active">1</span> of ${photoGroups.length}
                </div>` : ''}
            </div>
            ${photoGroups.length > 0 ? (() => {
                // May 2026 - render the strip even for single-photo reports
                // so operators get a consistent layout AND see at a glance
                // when more variants are still uploading. "+N originals
                // pending" reads off the LARGE tier's assembly_status across
                // every photo group - this surfaces the "Original may be
                // delayed by poor connectivity" case from the UNDP spec.
                const labelText = photoGroups.length === 1
                    ? 'Photo 1 of 1'
                    : `${photoGroups.length} Photos`;
                // Phase F image-reliability (May 2026) - tri-state chip
                // replaces the binary "complete vs pending" check that
                // pulsed forever on `failed` rows. Now each non-complete
                // group surfaces under its WORST-state chip and offers
                // an inline Reclaim button (routes to F3 endpoint
                // /api/v1/reports/media/{id}/reclaim).
                const _detailAgeMs = r.server_created_at
                    ? Date.now() - new Date(r.server_created_at).getTime()
                    : 0;
                let dpLost = 0, dpDelayed = 0, dpUploading = 0, dpMissingFresh = 0;
                // Collect HIGH media ids for the Reclaim button payload.
                const _reclaimables = [];
                for (const g of photoGroups) {
                    const st = _classifyHighTier(g, _detailAgeMs);
                    if (st === 'lost') dpLost++;
                    else if (st === 'delayed') dpDelayed++;
                    else if (st === 'uploading') dpUploading++;
                    else if (st === 'missing-fresh') dpMissingFresh++;
                    const hi = (g.members || []).find(m => m.resolution_tier === 'ORIGINAL');
                    if (hi && (st === 'lost' || st === 'delayed')) {
                        _reclaimables.push({ id: hi.id,
                            chunks: `${hi.received_chunks || 0}/${hi.chunk_count || 0}`,
                            state: st,
                            reason: hi.abandon_reason || '',
                        });
                    }
                }
                const origPending = dpLost + dpDelayed + dpUploading + dpMissingFresh;
                let dpChipState = 'uploading';
                if (dpLost > 0)          dpChipState = 'lost';
                else if (dpDelayed > 0)  dpChipState = 'delayed';
                else if (dpUploading > 0) dpChipState = 'uploading';
                else if (dpMissingFresh > 0) dpChipState = 'missing-fresh';
                const _dpChipIcon = {
                    lost:            'fa-solid fa-circle-xmark',
                    delayed:         'fa-solid fa-clock',
                    uploading:       'fa-solid fa-cloud-arrow-up fa-pulse',
                    'missing-fresh': 'fa-solid fa-cloud-arrow-up fa-pulse',
                }[dpChipState];
                const _dpChipLabel = {
                    lost:            `${dpLost} ${dpLost === 1 ? 'Original lost' : 'Originals lost'} (network timeout)`,
                    delayed:         `${dpDelayed} ${dpDelayed === 1 ? 'Original' : 'Originals'} delayed past 30 min`,
                    uploading:       `${origPending} ${origPending === 1 ? 'Original' : 'Originals'} uploading`,
                    'missing-fresh': `${dpMissingFresh} ${dpMissingFresh === 1 ? 'Original' : 'Originals'} not yet sent`,
                }[dpChipState];
                const _dpChipTitle = {
                    lost:    'The reporter\'s device never delivered the final chunks. Use Reclaim → Retry assembly if you believe the file is recoverable, or Reclaim → Mark abandoned to dismiss.',
                    delayed: 'These uploads are past the 30-minute freshness window. The next backend recovery tick will mark them lost; you can reclaim them in the meantime.',
                    uploading: 'These uploads are still inside the freshness window. They should appear automatically once the reporter\'s device finishes the chunk stream.',
                    'missing-fresh': 'The HIGH-tier variant hasn\'t been allocated yet - the reporter\'s device may be queueing it on slow connectivity. The PWA will retry for up to 14 days.',
                }[dpChipState];
                // Reclaim button only shown for `lost` + `delayed` states.
                // Embeds the reclaimable media list as a JSON-encoded data-*
                // attribute (escapeHtml-safe) so the click handler can pick
                // up the ids without a second fetch.
                const _reclaimBtn = _reclaimables.length > 0
                    ? `<button class="dp-gallery-reclaim-btn" type="button"
                               data-media-ids="${escapeHtml(JSON.stringify(_reclaimables))}"
                               onclick="_openMediaReclaimModal('${r.id}', this)"
                               title="Operator action: retry assembly or mark these originals as permanently lost.">
                        <i class="fa-solid fa-wrench"></i> Reclaim
                       </button>`
                    : '';
                const pendingChip = origPending > 0
                    ? `<span class="dp-gallery-pending-chip dp-gallery-pending-chip-${dpChipState}" title="${escapeHtml(_dpChipTitle)}"><i class="${_dpChipIcon}"></i> ${escapeHtml(_dpChipLabel)}</span> ${_reclaimBtn}`
                    : '';
                return `
            <div class="dp-gallery">
                <div class="dp-gallery-label"><i class="fa-solid fa-images"></i> ${labelText} ${pendingChip}</div>
                <div class="dp-gallery-strip">
                    ${photoGroups.map((g, idx) => {
                        // Guaranteed-delivery: pick the best complete variant
                        // per group so the thumb shows the highest-quality
                        // version available right now.
                        const pick = bestVariant(g);
                        if (!pick) return '';
                        // Progress bar shows the best completion_pct across
                        // the group so users see "60% uploading" for a
                        // partial upload.
                        const maxPct = Math.max(0, ...g.members.map(m => m.completion_pct || 0));
                        return `<div class="dp-gallery-thumb ${idx === 0 ? 'active' : ''}"
                                     data-group-id="${g.group_id || ''}"
                                     data-current-tier="${pick.tier}"
                                     onclick="dpShowGalleryImage('${r.id}',${idx},this)">
                            <img src="${pick.src}" alt="Photo ${idx+1}" loading="lazy" decoding="async">
                            ${!pick.isFinal ? `<span class="dp-gallery-pct">${maxPct.toFixed(0)}%</span>` : ''}
                        </div>`;
                    }).join('')}
                </div>
            </div>`;
            })() : ''}
        </div>` : ''}

        <!-- ④ Audio + User Transcription -->
        ${displayText || allAudioMedia.length ? `
        <div class="dp-transcript-card">
            ${allAudioMedia.length > 0 ? allAudioMedia.map((am, idx) => {
                const amComplete = am.assembly_status === 'complete' && am.url;
                const amPct = am.completion_pct ?? (amComplete ? 100 : 0);
                const amPartialUrl = am.thumbnail_url ? _withCacheBust(getMediaUrl(am.thumbnail_url), '_cb', Math.round(amPct/5)*5) : '';
                const amPlayUrl = amComplete ? getMediaUrl(am.url) : amPartialUrl;
                const label = allAudioMedia.length > 1 ? (idx === 0 ? 'Location' : 'Description') : 'Audio';
                return `<div class="dp-audio-row">
                    <button class="dp-audio-btn ${amComplete ? '' : 'uploading'}" onclick="playDetailAudio(this, '${amPlayUrl || ''}')">
                        <i class="fa-solid ${amComplete ? 'fa-play' : amPartialUrl ? 'fa-cloud-arrow-up fa-pulse' : 'fa-microphone'}"></i>
                    </button>
                    <span class="dp-audio-label">${label}</span>
                    <div class="dp-audio-bar-wrap">
                        <div class="audio-progress-bar" style="height:3px;"><div class="audio-progress-fill" id="detail-audio-fill-${idx}"></div></div>
                        <div class="audio-time" style="font-size:11px;"><span id="detail-audio-cur-${idx}">0:00</span><span id="detail-audio-dur-${idx}">${amComplete ? '0:00' : '--:--'}</span></div>
                    </div>
                    ${!amComplete && amPct > 0 ? `<span class="dp-upload-pct">${amPct.toFixed(0)}%</span>` : ''}
                </div>`;
            }).join('') : ''}

            ${displayText ? `
                <div class="dp-text-section">
                    <div class="dp-text-label"><i class="fa-solid fa-align-left"></i> ${isVoiceOrText ? 'User Report' : 'Description'}</div>
                    <div class="dp-transcript-text" id="dp-transcript-short">${highlightKeywords(displayText, true)}${displayText.length > 150 ? `<span class="dp-text-expand" onclick="document.getElementById('dp-transcript-short').style.display='none';document.getElementById('dp-transcript-full').style.display='block';">… read more</span>` : ''}</div>
                    ${displayText.length > 150 ? `<div class="dp-transcript-text dp-transcript-full" id="dp-transcript-full" style="display:none;">${highlightKeywords(displayText, false)}<span class="dp-text-expand" onclick="document.getElementById('dp-transcript-full').style.display='none';document.getElementById('dp-transcript-short').style.display='block';"> show less</span></div>` : ''}
                </div>
            ` : ''}
        </div>` : ''}

        <!-- ⑤ Location + Caller Info -->
        ${loc || r.caller_info ? (() => {
            const mismatch = loc?.is_user_corrected && loc?.device_latitude && loc?.device_longitude;
            const distKm = mismatch ? Math.round(haversineKm(loc.latitude, loc.longitude, loc.device_latitude, loc.device_longitude)) : 0;
            // Dedup: the place NAME (which used to live only in the deleted
            // headline) and the COORDS are shown TOGETHER here. Name = user-entered
            // else device reverse-geocoded; coords always shown beneath it.
            const placeName = loc ? (loc.user_location_name || loc.device_location_name || '') : '';
            const coordsStr = loc ? `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}` : '';
            const devName  = mismatch ? (loc.device_location_name || `${loc.device_latitude?.toFixed(4)}, ${loc.device_longitude?.toFixed(4)}`) : '';
            const ci = r.caller_info || {};
            const phone = ci.phone || '';
            const netLoc = ci.network_location || [ci.network_city, ci.network_state, ci.network_country].filter(Boolean).join(', ');
            const hasCallerInfo = phone || netLoc;
            // Phase 23 - geocoding confidence chip. Shown when the
            // location came from a text-only channel (IVR / SMS /
            // WhatsApp transcript) - the backend stores a float
            // confidence + source string on the Location row.
            const gcConf = (typeof loc?.geocoding_confidence === 'number') ? loc.geocoding_confidence : null;
            const gcSrc  = loc?.geocoding_source || '';
            const gcPct  = gcConf !== null ? Math.round(gcConf * 100) : null;
            const gcCls  = gcConf === null ? ''
                : gcConf >= 0.75 ? 'dp-geoconf-high'
                : gcConf >= 0.45 ? 'dp-geoconf-med'
                : 'dp-geoconf-low';
            return `<div class="dp-loc-card ${mismatch ? 'dp-loc-mismatch' : ''}">
                <div class="dp-section-label"><i class="fa-solid fa-location-dot"></i> Location &amp; Building${hasCallerInfo ? ' · Contact' : ''}</div>
                ${loc ? `
                ${placeName ? `<div class="dp-loc-row">
                    <i class="fa-solid fa-map-pin" style="color:${sevColor};"></i>
                    ${mismatch ? '<span class="dp-loc-tag" title="The reporter adjusted the pin; this is the location they submitted">Submitted incident location</span>' : ''}
                    <span class="dp-loc-name">${escapeHtml(placeName)}</span>
                    ${gcPct !== null ? `<span class="dp-geoconf ${gcCls}" title="Geocoded from voice/text via ${escapeHtml(gcSrc || 'unknown')} - ${gcPct}% confidence"><i class="fa-solid fa-wand-magic-sparkles"></i> ${gcPct}%${gcSrc ? ` · ${escapeHtml(gcSrc)}` : ''}</span>` : ''}
                </div>` : ''}
                <div class="dp-loc-row dp-loc-coords">
                    <i class="fa-solid fa-location-crosshairs" style="color:#94a3b8;"></i>
                    <span class="dp-loc-coordval">${coordsStr}</span>
                    <button class="dp-copy-btn" onclick="navigator.clipboard.writeText('${coordsStr}'); showToast('Coords copied','success')"><i class="fa-solid fa-copy"></i></button>
                </div>` : ''}
                ${mismatch ? `<div class="dp-loc-row dp-loc-device" title="The device's original GPS fix, before the reporter moved the pin. This is a review signal only - it does not change the Confidence Score.">
                    <i class="fa-solid fa-mobile-screen" style="color:#94a3b8;"></i>
                    <span class="dp-loc-tag">Device location</span>
                    <span class="dp-loc-name" style="color:var(--text-sub);">${devName}</span>
                    <span class="dp-loc-warn"><i class="fa-solid fa-triangle-exclamation"></i> ${distKm} km from submitted</span>
                </div>` : ''}
                ${(_hasBuildingLink(r) || r.needs_manual_mapping === true) ? `<div class="dp-loc-divider"></div>
                <div class="dp-loc-row dp-loc-building">
                    <i class="fa-solid fa-building" style="color:#93c5fd;"></i>
                    ${_hasBuildingLink(r)
                        ? `<button class="dp-loc-name dp-bldg-link" title="Open the Building Console - all reports for this building" onclick="window.openBuildingConsole&&window.openBuildingConsole(decodeURIComponent('${encodeURIComponent(r.building_id)}'))">${_taggedBuildingName(r) ? escapeHtml(r.infrastructure_name) : 'Building'} <i class="fa-solid fa-arrow-up-right-from-square dp-bldg-link-ic"></i></button>`
                        : `<span class="dp-loc-name">${r.infrastructure_name ? escapeHtml(r.infrastructure_name) : 'Building'}</span>`}
                    ${r.needs_manual_mapping === true ? `<span class="dp-loc-needsmap" title="Reporter typed the building name; resolve it to an OSM footprint."><i class="fa-solid fa-map-location-dot"></i> Needs mapping</span>` : ''}
                </div>` : ''}
                ${hasCallerInfo ? `<div class="dp-loc-divider"></div>` : ''}
                ${phone ? `<div class="dp-loc-row">
                    <i class="fa-solid fa-phone" style="color:#a855f7;"></i>
                    <a href="tel:${phone}" class="dp-caller-phone">${phone}</a>
                    <button class="dp-copy-btn" onclick="navigator.clipboard.writeText('${phone}'); showToast('Phone copied','success')"><i class="fa-solid fa-copy"></i></button>
                </div>` : ''}
                ${netLoc ? `<div class="dp-loc-row">
                    <i class="fa-solid fa-tower-cell" style="color:#94a3b8;"></i>
                    <span class="dp-caller-net">Telecom: ${netLoc}</span>
                </div>` : ''}
            </div>`;
        })() : ''}

        <!-- UX-B: the standalone "Source Details" section is REMOVED - its
             channel / Report ID / media / submitted metadata now lives in the
             header channel-badge popover (click the source badge). -->
    `;

    // ── Action dock hidden - actions now in top bar ──
    document.getElementById('dp-action-dock').innerHTML = '';

    // Phase F.2.b - async-load the admin-action ribbon for this report.
    _fetchReportAuditTrail(r.id);

    // The per-report "V N of M · Older" building-version ribbon was REMOVED from
    // the incident detail (operator feedback: version/duplicate state is a
    // BUILDING-level concern, not an incident-level one - it added cognitive load
    // here). Building versioning + the report stack now live in the Building
    // Console, reached by clicking the building name in the Location & Building row.

    // B3 - resolve the crisis-form pack title + event name for the detail tag +
    // answers header. Async (admin lists, cached); guarded against panel close.
    (async () => {
        if (!r.form_pack_id && !r.crisis_event_id) return;
        let idx;
        try { idx = await ensureCrisisFormsIndex(); } catch (_e) { return; }
        if (!idx) return;
        const pack = r.form_pack_id ? idx.packs[r.form_pack_id] : null;
        const ev = r.crisis_event_id ? idx.events[r.crisis_event_id] : null;
        const tag = document.getElementById(`dp-form-tag-${r.id}`);
        if (tag) {
            const name = (pack && pack.title) ? escapeHtml(pack.title) : 'Crisis form';
            const ver = r.form_pack_version ? ` · v${r.form_pack_version}` : '';
            tag.innerHTML = `<i class="fa-solid fa-clipboard-list"></i> ${name}${ver}`;
            tag.title = `Form: ${pack && pack.title ? pack.title : (r.form_pack_id || '-')}${ev && ev.name ? ` · Event: ${ev.name}` : ''}`;
        }
        const fn = document.getElementById(`dp-cf-formname-${r.id}`);
        if (fn) {
            const bits = [];
            if (pack && pack.title) bits.push(escapeHtml(pack.title));
            if (ev && ev.name) bits.push('· ' + escapeHtml(ev.name));
            if (bits.length) fn.innerHTML = bits.join(' ');
        }
        // Re-render the crisis-pack answers with VERBATIM question + option labels
        // (e.g. UNDP Appendix-1 wording) once the pack schema loads. Degrades to the
        // already-painted humanized codes on any failure.
        if (r.form_pack_id && r.form_data && typeof r.form_data === 'object' && !Array.isArray(r.form_data)) {
            try {
                const fmap = await ensurePackSchema(r.form_pack_id, r.form_pack_version);
                const body = document.getElementById(`dp-cf-body-${r.id}`);
                if (body && fmap) body.innerHTML = _fdRowsHtml(r.form_data, fmap);
            } catch (_e) { /* keep the humanized fallback */ }
        }
    })();

    if (loc && !skipFly) map.flyTo([loc.latitude, loc.longitude], 15);
    highlightMarker(id);   // reverse map↔feed sync: light up the selected marker
    renderFeed();
};

// ── Incident Intelligence P3 - duplicate surfacing in the detail panel ────────
function _ensureDupStyles() {
    if (document.getElementById('dp-dup-styles')) return;
    const s = document.createElement('style');
    s.id = 'dp-dup-styles';
    s.textContent = `
      .dp-duplicates{margin:6px 0}
      .dp-dup-box{background:rgba(148,163,184,.06);border:1px solid #233149;border-radius:10px;padding:6px 10px;margin:6px 0}
      .dp-dup-box>summary{cursor:pointer;font-size:12px;color:#cbd9ef;display:flex;align-items:center;gap:8px;list-style:none}
      .dp-dup-count{background:rgba(148,163,184,.2);border-radius:8px;padding:0 7px;font-size:11px}
      .dp-dup-row{display:flex;flex-direction:column;gap:3px;padding:6px 0;border-top:1px solid rgba(148,163,184,.12)}
      .dp-dup-main{display:flex;align-items:center;gap:8px}
      .dp-dup-sub{font-size:10px;color:#8aa0c0;padding-left:2px}
      .dp-dup-reasons{display:flex;flex-wrap:wrap;gap:4px;padding-left:2px}
      .dp-dup-reason{font-size:10px;color:#86efac;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.25);border-radius:5px;padding:0 5px}
      .dp-dup-conf{font-size:10px;font-weight:700;border:1px solid;border-radius:6px;padding:1px 6px;flex:none}
      .dp-dup-open{flex:1;min-width:0;color:#9fb3d1;font-size:12px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .dp-dup-open:hover{color:#e6eefb}
      .dp-dup-controls{display:flex;gap:4px;flex:none}
      .dp-dup-btn{background:#1b2942;border:1px solid #2b3b56;color:#cbd9ef;border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer}
      .dp-dup-btn:hover{background:#23314e}
      .dp-dup-yes{color:#86efac}
      .dp-dup-primary{margin-left:auto}
      .dp-dup-primary.is-primary{color:#fbbf24;border-color:#fbbf24}`;
    document.head.appendChild(s);
}
function _dupTitle(s) { s = String(s || ''); return s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : ''; }

// Fetch + render the within-cluster probable duplicates of report `r` into
// #dp-duplicates. No-op for singleton/no-building reports (no cluster peers).
async function _loadDuplicates(r) {
    const host = document.getElementById('dp-duplicates');
    if (!host) return;
    if (!r || !r.building_id) { host.innerHTML = ''; return; }
    _ensureDupStyles();
    let data;
    try {
        const res = await fetch(`${API}/${encodeURIComponent(r.id)}/duplicates`);
        if (!res.ok) { host.innerHTML = ''; return; }
        data = await res.json();
    } catch (_e) { host.innerHTML = ''; return; }
    if (selectedId !== r.id) return;   // a newer selection superseded this load
    const cands = (data && data.candidates) || [];
    if (!cands.length) { host.innerHTML = ''; return; }
    const chip = (lvl) => {
        const c = lvl === 'HIGH' ? '#f87171' : lvl === 'MEDIUM' ? '#fb923c' : '#9fb3d1';
        return `<span class="dp-dup-conf" style="color:${c};border-color:${c}">${lvl}</span>`;
    };
    // White-box "why": render the per-factor breakdown the engine returned so the
    // analyst sees exactly why two reports were flagged (no black-box scoring).
    const reasonsHtml = (reasons) => (reasons || []).map((x) =>
        `<span class="dp-dup-reason" title="+${x.weight} pts">✓ ${escapeHtml(x.label)}${x.detail ? ' (' + escapeHtml(x.detail) + ')' : ''}</span>`).join('');
    // READ-ONLY rows: confidence + white-box reasons + an open-to-see-evidence
    // link. The merge DECISIONS (confirm / not / set-primary / remove / unmerge)
    // moved to the Building Console - the incident stays a clean single-incident
    // view, while each report's unique evidence (photos / audio / description /
    // timestamp) is one click away.
    const rowHtml = (c) => {
        const meta = [_dupTitle(c.crisis_type), _dupTitle(c.infrastructure_type), c.location_name].filter(Boolean).join(' · ');
        const idJs = `decodeURIComponent('${encodeURIComponent(c.report_id)}')`;
        const sub = [c.reporter, c.server_created_at ? timeAgo(c.server_created_at) : '',
                     'Confidence ' + (c.score != null ? c.score + '%' : c.confidence)].filter(Boolean).join(' · ');
        const primaryTag = (data.primary_report_id && c.report_id === data.primary_report_id)
            ? '<span title="Primary report of this incident" style="color:#fbbf24;flex:none">⭐</span> ' : '';
        return `<div class="dp-dup-row"><div class="dp-dup-main">${chip(c.confidence)}${primaryTag}` +
            `<a class="dp-dup-open" onclick="window._switchToReport(${idJs})" title="Open this report to see its evidence (photos / audio / description)">${escapeHtml(meta || 'Report')} <span style="opacity:.6">↗</span></a></div>` +
            (sub ? `<div class="dp-dup-sub">${escapeHtml(sub)}</div>` : '') +
            (reasonsHtml(c.reasons) ? `<div class="dp-dup-reasons">${reasonsHtml(c.reasons)}</div>` : '') +
            `</div>`;
    };
    // Reports merged beneath this primary (corroborating) + unconfirmed candidates.
    // Both READ-ONLY here; the actual review/merge happens once, at the building.
    const _bidJs = `decodeURIComponent('${encodeURIComponent(r.building_id)}')`;
    const reviewBtn = `<button class="dp-dup-review" style="margin-left:auto" onclick="event.preventDefault();window.openBuildingConsole&&window.openBuildingConsole(${_bidJs})" title="Review + merge duplicates for this building"><i class="fa-solid fa-arrow-up-right-from-square"></i> Review &amp; merge in Building Console</button>`;
    const merged = cands.filter((c) => c.confirmed);
    const possible = cands.filter((c) => !c.confirmed);
    let html = '';
    if (merged.length) {
        html += `<details class="dp-dup-box" open><summary><i class="fa-solid fa-link"></i> Corroborating reports ` +
            `<span class="dp-dup-count">${merged.length}</span><span class="dp-dup-hint">evidence from each merged report</span>` +
            `</summary><div class="dp-dup-list">${merged.map((c) => rowHtml(c)).join('')}</div></details>`;
    }
    if (possible.length) {
        html += `<details class="dp-dup-box"${merged.length ? '' : ' open'}><summary><i class="fa-solid fa-clone"></i> Possible duplicates ` +
            `<span class="dp-dup-count">${possible.length}</span>${reviewBtn}` +
            `</summary><div class="dp-dup-list">${possible.map((c) => rowHtml(c)).join('')}</div></details>`;
    }
    host.innerHTML = html;
}
// Unmerge every confirmed duplicate under `reportId` - restores them all to the
// feed. Reversible (each was an undoable decision); nothing is deleted.
window._dupUnmergeAll = (reportId) => {
    // D6: capture the inline-onclick button so it disables during the multi-call
    // unmerge loop (no double-fire); null btn just runs the body unguarded.
    const _btn = (window.event && (window.event.currentTarget || window.event.target)) || null;
    return withBusy(_btn, async () => {
        try {
            const res = await fetch(`${API}/${encodeURIComponent(reportId)}/duplicates`);
            const data = res.ok ? await res.json() : { candidates: [] };
            const merged = ((data && data.candidates) || []).filter((c) => c.confirmed);
            for (const c of merged) {
                await fetch(`${API}/${encodeURIComponent(reportId)}/duplicate-decision`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ decision: 'UNDO', related_report_id: c.report_id }),
                });
            }
            showToast('Unmerged ' + merged.length + ' report' + (merged.length !== 1 ? 's' : ''), 'success');
            if (selectedId) _loadDuplicates({ id: selectedId, building_id: true });
            try { _lastServerTime = null; _lastReportsEtag = null; } catch (_e) {}
            try { fetchReports(); } catch (_e) {}
        } catch (_e) { showToast('Could not unmerge', 'error'); }
    });
};
window._dupDecision = (reportId, relatedId, decision) => {
    // D6: disable the clicked Merge/Not/Remove/Make-primary button for the round-trip.
    const _btn = (window.event && (window.event.currentTarget || window.event.target)) || null;
    return withBusy(_btn, async () => {
    try {
        const res = await fetch(`${API}/${encodeURIComponent(reportId)}/duplicate-decision`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision, related_report_id: relatedId || undefined }),
        });
        if (!res.ok) { showToast(res.status === 403 ? 'Not authorized (analyst required)' : 'Could not save decision', 'error'); return; }
        showToast(decision === 'UNDO' ? 'Reverted'
            : decision === 'SET_PRIMARY' ? 'Set as primary report'
            : decision === 'CONFIRMED_DUP' ? 'Marked as duplicate' : 'Marked not a duplicate', 'success');
        // Optimistic collapse: a just-confirmed duplicate vanishes from the feed/map
        // immediately (the next full refresh below makes it durable). Bump the
        // primary's merged badge so the count is right before the round-trip lands.
        if (decision === 'CONFIRMED_DUP' && relatedId) {
            const _i = allReports.findIndex(x => x.id === relatedId);
            if (_i >= 0) allReports.splice(_i, 1);
            const _p = allReports.find(x => x.id === reportId);
            if (_p) _p.duplicate_count = (_p.duplicate_count || 0) + 1;
            try { renderFeed(); } catch (_e) {}
            try { updateMapMarkers(); } catch (_e) {}
        }
        if (selectedId) _loadDuplicates({ id: selectedId, building_id: true });   // refresh against the open report
        try { _dupSummaryCache = { ts: 0, scope: undefined, data: null }; } catch (_e) {}   // refresh the awareness card
        // Reconcile the feed with the server's hidden-set authoritatively. Forcing a
        // full refresh (reset the delta cursor + ETag) re-collapses confirmed dups and
        // brings back any report an UNDO/Set-primary just un-hid - a delta poll can't
        // signal a removal, so this is the robust path for every decision type.
        try { _lastServerTime = null; _lastReportsEtag = null; } catch (_e) {}
        try { fetchReports(); } catch (_e) {}
    } catch (_e) { showToast('Could not save decision', 'error'); }
    });
};

// Highlight the selected incident's map marker (the reverse of marker→feed).
// Clears any prior highlight. Retries briefly because flyTo declustering may not
// have produced the marker's DOM icon yet. Pass null to clear all highlight.
function highlightMarker(id) {
    const prev = _highlightedMarkerId && _markerById[_highlightedMarkerId];
    if (prev && prev._icon) prev._icon.classList.remove('crisp-marker-sel');
    _highlightedMarkerId = id || null;
    const m = id && _markerById[id];
    if (!m) return;
    const mark = () => { if (m._icon) m._icon.classList.add('crisp-marker-sel'); };
    mark();
    setTimeout(mark, 350);
    setTimeout(mark, 800);
}
window.highlightMarker = highlightMarker;

// Image/Satellite view toggle in detail panel
window.dpSwitchView = (reportId, view, btn) => {
    const r = allReports.find(x => x.id === reportId);
    if (!r) return;
    const container = document.getElementById(`dp-img-view-${reportId}`);
    if (!container) return;
    const img = r.media?.find(m => m.type === 'IMAGE');
    const v = r.verification;
    btn.parentElement.querySelectorAll('.dp-vt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (view === 'compare') {
        // Open full-screen compare overlay
        dpOpenCompare(r);
        return;
    }
    // Reset to single view aspect ratio
    container.closest('.dp-evidence-card').querySelector('.dp-img-view .dp-img')?.style?.removeProperty?.('aspect-ratio');
    if (view === 'photo' && img?.url) {
        // May 2026 - main report photo uses `object-fit:contain` so a
        // portrait phone capture isn't stretched into the .dp-img's
        // 4:3 box. Letterbox bars use the parent's #0f1520 background.
        container.innerHTML = `<div class="dp-img" onclick="openGallery('${r.id}', 0)"><img src="${getMediaUrl(img.url)}" style="width:100%;height:100%;object-fit:contain;border-radius:8px;"></div>`;
    } else if (view === 'sat') {
        // Apr 2026 - multi-provider fan-out: render every successful
        // satellite source side-by-side (AWS Sentinel-2 / Microsoft
        // Planetary Computer / ESA Copernicus / Mapbox). Falls back to
        // single-image view for verifications that ran under the older
        // chain (single-source) path.
        const all = Array.isArray(v?.satellite_images) ? v.satellite_images : [];
        if (all.length >= 2) {
            // Compact label per source - keeps grid cells tight without
            // overflowing on small screens.
            const sourceShort = (s) => {
                if (!s) return 'Unknown';
                if (/AWS/i.test(s))   return 'AWS Sentinel-2';
                if (/Microsoft/i.test(s)) return 'Microsoft Planetary Computer';
                if (/ESA|Copernicus/i.test(s)) return 'ESA Copernicus';
                if (/Mapbox/i.test(s)) return 'Mapbox';
                return s.length > 30 ? s.slice(0, 30) + '…' : s;
            };
            const cells = all.slice(0, 4).map((entry, i) => {
                // May 2026 - getMediaUrl() handles both relative
                // `/api/v1/.../satellite/grid/<idx>` URLs and absolute
                // https. Previously hard-coded BACKEND_HOST concat.
                const src = entry.url ? getMediaUrl(entry.url) : '';
                const label = sourceShort(entry.source);
                const cloud = (entry.cloud_cover_pct == null) ? '' :
                    `<span class="dp-sat-meta">cloud ${Number(entry.cloud_cover_pct).toFixed(0)}%</span>`;
                const acq = entry.acquisition_date ?
                    `<span class="dp-sat-meta">${formatShortDate(entry.acquisition_date)}</span>` : '';
                return `<div class="dp-sat-cell" onclick="openLightbox('${src}','${label}')">
                    <img src="${src}" alt="${label}" />
                    <div class="dp-sat-overlay">
                        <span class="dp-sat-source">${label}</span>
                        ${acq}${cloud}
                    </div>
                </div>`;
            }).join('');
            container.innerHTML = `<div class="dp-sat-grid">${cells}</div>`;
            // Inject CSS once per session (idempotent)
            if (!document.getElementById('crisp-sat-grid-css')) {
                const st = document.createElement('style');
                st.id = 'crisp-sat-grid-css';
                st.textContent = `
                .dp-sat-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    grid-template-rows: 1fr 1fr;
                    gap: 6px;
                    width: 100%; height: 100%;
                    border-radius: 8px;
                    overflow: hidden;
                }
                .dp-sat-cell {
                    position: relative;
                    overflow: hidden;
                    border-radius: 6px;
                    cursor: pointer;
                    background: #0b0b0e;
                }
                .dp-sat-cell img {
                    width: 100%; height: 100%;
                    object-fit: cover;
                    display: block;
                }
                .dp-sat-overlay {
                    position: absolute;
                    bottom: 0; left: 0; right: 0;
                    padding: 6px 8px;
                    background: linear-gradient(180deg, transparent, rgba(0,0,0,0.75));
                    display: flex; flex-direction: column; gap: 2px;
                    font-size: 11px;
                    color: #fff;
                    text-shadow: 0 1px 2px rgba(0,0,0,0.6);
                    pointer-events: none;
                }
                .dp-sat-source { font-weight: 600; }
                .dp-sat-meta   { opacity: 0.85; font-size: 10px; }
                /* If only 3 succeeded: fill the 4th cell with a graceful
                   "source unavailable" placeholder so the grid stays 2x2. */
                .dp-sat-cell--empty {
                    display: flex; align-items: center; justify-content: center;
                    color: rgba(255,255,255,0.45);
                    font-size: 12px;
                    background: repeating-linear-gradient(45deg,
                        rgba(255,255,255,0.02) 0,
                        rgba(255,255,255,0.02) 8px,
                        transparent 8px, transparent 16px);
                }`;
                document.head.appendChild(st);
            }
        } else if (v?.satellite_image_url) {
            // Legacy single-image path (chain-era verifications)
            const src = getMediaUrl(v.satellite_image_url);
            container.innerHTML = `<div class="dp-img" onclick="openLightbox('${src}','Satellite')"><img src="${src}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;"></div>`;
        }
    } else if (view === 'alt' && v?.satellite_image_url_alt) {
        const src = getMediaUrl(v.satellite_image_url_alt);
        container.innerHTML = `<div class="dp-img" onclick="openLightbox('${src}','Alt Satellite')"><img src="${src}" style="width:100%;height:100%;object-fit:cover;border-radius:8px;"></div>`;
    }
};

// Gallery image switcher - click thumbnail to show in main view.
// groupIdx is the index into the photo-group list (one group per captured
// photo, regardless of how many Media variant rows it has on the server).
//
// Phase 2 (May 2026): switching gallery photos shows the THUMB inline,
// not the LARGE variant. The user clicked because they want to SEE the
// photo, not necessarily download all 500 KB of it. Lightbox click on
// the swapped image then escalates to LARGE on demand.
window.dpShowGalleryImage = (reportId, groupIdx, thumbEl) => {
    const r = allReports.find(x => x.id === reportId);
    if (!r) return;
    const images = r.media?.filter(m => m.type === 'IMAGE') || [];
    const groups = groupPhotos(images);
    const grp = groups[groupIdx];
    if (!grp) return;
    const pick = thumbVariant(grp);
    if (!pick || !pick.src) return;
    // Lightbox click opens the HIGHEST complete variant - explicit "show me HQ".
    const lightboxPick = highestCompleteVariant(grp);
    const lightboxSrc = lightboxPick?.src || pick.src;
    const container = document.getElementById(`dp-img-view-${reportId}`);
    if (!container) return;
    // Phase L (May 2026) - canonical tier values. Accept legacy LOW/HIGH
    // for any pre-rename Media rows that might still exist (alembic 0035
    // backfilled them but defensive).
    const tierLabel = (pick.tier === 'SMALL' || pick.tier === 'LOW') ? 'SMALL'
        : pick.tier === 'MEDIUM' ? 'MEDIUM'
        : (pick.tier === 'ORIGINAL' || pick.tier === 'HIGH') ? 'ORIGINAL'
        : pick.tier;
    // Preserve the PII badge (and any other overlay children) - only swap the
    // <div class="dp-img"> block. The old innerHTML= wipe lost the shield chip
    // on every thumbnail click.
    const imgWrap = container.querySelector('.dp-img');
    // May 2026 - `object-fit:contain` matches the .dp-img .img-full-layer
    // rule so swapping between cached/live image and gallery navigation
    // keeps the same letterbox treatment.
    const newImgHtml = `<div class="dp-img" data-group-id="${grp.groupId}" data-current-tier="${pick.tier}" onclick="openGallery('${reportId}', ${groupIdx})">
        <img src="${pick.src}" style="width:100%;height:100%;object-fit:contain;border-radius:8px;">
        <span class="dp-tier-chip dp-tier-${pick.tier.toLowerCase()}">${tierLabel}</span>
    </div>`;
    if (imgWrap) {
        imgWrap.outerHTML = newImgHtml;
    } else {
        container.insertAdjacentHTML('afterbegin', newImgHtml);
    }
    // Update active thumb
    thumbEl.parentElement.querySelectorAll('.dp-gallery-thumb').forEach(t => t.classList.remove('active'));
    thumbEl.classList.add('active');
    // Phase A - keep the "Photo X of N" count badge in sync with the active thumb
    // so the inline preview always advertises which photo of the multi-image
    // capture is currently on screen. Cheap one-line DOM update; no-op when
    // the badge isn't rendered (single-photo reports).
    const countActive = container.querySelector('.dp-img-count-active');
    if (countActive) countActive.textContent = String(groupIdx + 1);
};

// Full-screen multi-image compare overlay
window.dpOpenCompare = (r) => {
    const img = r.media?.find(m => m.type === 'IMAGE');
    const v = r.verification;
    const photoSrc = img?.url ? getMediaUrl(img.url) : '';
    const satSrc = v?.satellite_image_url ? getMediaUrl(v.satellite_image_url) : '';
    const altSrc = v?.satellite_image_url_alt ? getMediaUrl(v.satellite_image_url_alt) : '';
    const scores = v?.scores || {};
    const total = v?.total_score || 0;
    const damageMatch = scores.damage_corroboration ? Math.round((scores.damage_corroboration / 25) * 100) : 0;
    const locMatch = scores.location_authenticity ? Math.round((scores.location_authenticity / 25) * 100) : 0;
    const gc = (pct) => pct >= 70 ? '#22c55e' : pct >= 40 ? '#eab308' : '#ef4444';

    // Timestamps - satellite_acquisition_date is when the satellite CAPTURED the image (from provider API)
    const photoTime = r.server_created_at ? formatShortDate(r.server_created_at) : 'Unknown';
    const satAcqDate = v?.satellite_acquisition_date;
    const satTime = satAcqDate ? formatShortDate(satAcqDate) : 'Acq. date unavailable';
    const altAcqDate = v?.satellite_acquisition_date_alt;
    const altTime = altAcqDate ? formatShortDate(altAcqDate) : 'Acq. date unavailable';

    // Time gap between photo capture and satellite image capture
    const gapText = (acqDate) => {
        if (!acqDate || !r.server_created_at) return 'Date unknown - verify manually';
        const photoMs = new Date(ensureUTC(r.server_created_at)).getTime();
        const satMs = new Date(ensureUTC(acqDate)).getTime();
        const diffDays = Math.round((photoMs - satMs) / 86400000);
        if (diffDays === 0) return 'Same day as photo';
        if (diffDays > 0) return `Captured ${diffDays}d before incident`;
        return `Captured ${Math.abs(diffDays)}d after incident`;
    };

    // Build image panels with timestamps
    const panels = [];
    if (photoSrc) panels.push({ src: photoSrc, label: 'Reporter Photo', score: null, scoreLabel: 'Source', time: `Captured: ${photoTime}`, gap: '' });
    if (satSrc) panels.push({ src: satSrc, label: v?.satellite_source?.split('(')[0]?.trim() || 'Sentinel-2', score: damageMatch, scoreLabel: 'Damage Match', time: `Acquired: ${satTime}`, gap: gapText(satAcqDate) });
    if (altSrc) panels.push({ src: altSrc, label: v?.satellite_source_alt?.split('(')[0]?.trim() || 'Maxar', score: locMatch, scoreLabel: 'Location Match', time: `Acquired: ${altTime}`, gap: gapText(altAcqDate) });

    if (panels.length < 2) return;

    let overlay = document.getElementById('dp-compare-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'dp-compare-overlay';
        overlay.className = 'dp-compare-overlay';
        document.body.appendChild(overlay);
    }
    overlay.style.display = 'flex';

    overlay.innerHTML = `
        <div class="dp-compare-header">
            <div class="dp-compare-title"><i class="fa-solid fa-columns"></i> Image Comparison - ${infraDisplayLabel(r.infrastructure_type, r.infrastructure_sub_type)} · ${r.severity}</div>
            <div class="dp-compare-overall">Overall: <strong style="color:${gc(total)};">${total}/100</strong></div>
            <button class="dp-compare-close" onclick="document.getElementById('dp-compare-overlay').style.display='none'"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="dp-compare-grid" style="grid-template-columns:repeat(${panels.length},1fr);">
            ${panels.map(p => `
                <div class="dp-compare-panel">
                    <div class="dp-compare-label">${p.label}</div>
                    <div class="dp-compare-img-wrap">
                        <img src="${p.src}" class="dp-compare-img" onclick="this.classList.toggle('dp-zoomed')" title="Click to zoom">
                        ${p.score !== null ? `<div class="dp-compare-score" style="color:${gc(p.score)};">${p.scoreLabel}: ${p.score}%</div>` : ''}
                        <div class="dp-compare-time"><i class="fa-regular fa-clock"></i> ${p.time}${p.gap ? ` · ${p.gap}` : ''}</div>
                    </div>
                </div>
            `).join('')}
        </div>
    `;
};


window.switchSatSource = (reportId, which, btn, src) => {
    const img = document.getElementById(`dp-sat-img-${reportId}`);
    if (img) img.src = src;
    btn.parentElement.querySelectorAll('.dp-sat-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
};

// ── Building-centric Incident-Feed redesign Phase 2E - Incident Detail ──────
// A first-class Incident view (info + member reports + analyst merge/move/split/
// status). Deliberately SEPARATE from selectReport (the per-report detail) so the
// tested report-detail flow (47/38 specs) is untouched - both share #detail-panel
// (reparented to <body>) but render independently. Backed by the Phase-2D
// /api/v1/incidents endpoints. The global fetch wrapper injects auth.
const INCIDENTS_API = `${BACKEND_HOST}/api/v1/incidents`;
const _INC_STATUSES = ['OPEN', 'RESPONDING', 'RESOLVED', 'FALSE_ALARM'];
const _INC_SEVS = ['CRITICAL', 'SEVERE', 'MODERATE', 'MINOR', 'UNKNOWN'];

function _ensureIncidentDetailStyles() {
    if (document.getElementById('cc-incd-styles')) return;
    const s = document.createElement('style');
    s.id = 'cc-incd-styles';
    s.textContent = `
      .incd-wrap{display:flex;flex-direction:column;gap:14px;padding:6px 2px}
      .incd-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
      .incd-title{font-size:16px;font-weight:700;color:#e5e7eb;line-height:1.3}
      .incd-pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:3px 10px;font-size:11px;font-weight:700}
      .incd-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      .incd-chip{background:rgba(148,163,184,.14);color:#cbd5e1;border-radius:6px;padding:3px 8px;font-size:11px}
      .incd-chip b{color:#e5e7eb}
      .incd-sec-h{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#94a3b8;margin:6px 0 4px}
      .incd-mem{display:flex;align-items:center;gap:8px;padding:8px;border:1px solid rgba(148,163,184,.18);border-radius:8px;cursor:pointer;background:rgba(15,23,42,.4)}
      .incd-mem:hover{border-color:rgba(56,189,248,.5)}
      .incd-mem-dot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
      .incd-mem-body{flex:1;min-width:0}
      .incd-mem-t{font-size:12px;color:#e5e7eb;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .incd-mem-s{font-size:10px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .incd-mem-lead{font-size:9px;font-weight:700;color:#fbbf24;border:1px solid rgba(251,191,36,.4);border-radius:4px;padding:1px 4px;margin-left:4px}
      .incd-btn{background:rgba(148,163,184,.14);color:#cbd5e1;border:1px solid rgba(148,163,184,.3);border-radius:6px;padding:4px 9px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap}
      .incd-btn:hover{background:rgba(148,163,184,.24)}
      .incd-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      .incd-controls label{display:inline-flex;align-items:center;gap:5px}
      .incd-controls select{background:#0f172a;color:#e5e7eb;border:1px solid rgba(148,163,184,.3);border-radius:6px;padding:3px 6px;font-size:11px}
      .incd-merge-list{display:flex;flex-direction:column;gap:6px;margin-top:6px}
    `;
    document.head.appendChild(s);
}

async function _incJSON(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error('incident api ' + res.status);
    return res.json();
}

window.openIncidentDetail = async (incidentId) => {
    if (!incidentId) return;
    _ensureIncidentDetailStyles();
    const panel = document.getElementById('detail-panel');
    if (!panel) return;
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.style.display = 'flex';
    panel.classList.remove('detail-panel--building', 'detail-panel--operation');   // incident-group detail
    panel.setAttribute('data-mode', 'incident');
    const titleEl = document.getElementById('detail-title');
    const bodyEl = document.getElementById('detail-body');
    if (titleEl) titleEl.innerHTML = `<span class="incd-title">Incident</span>`;
    if (bodyEl) bodyEl.innerHTML = `<div class="incd-wrap"><div class="incd-sec-h">Loading incident…</div></div>`;
    let inc;
    try {
        inc = await _incJSON(`${INCIDENTS_API}/${encodeURIComponent(incidentId)}`);
    } catch (_e) {
        if (bodyEl) bodyEl.innerHTML = `<div class="incd-wrap"><div class="incd-sec-h">Could not load incident</div></div>`;
        return;
    }
    _renderIncidentDetail(inc);
};

function _renderIncidentDetail(inc) {
    const bodyEl = document.getElementById('detail-body');
    const titleEl = document.getElementById('detail-title');
    if (!bodyEl) return;
    const sevC = SEV_COLORS[inc.severity] || '#64748b';
    if (titleEl) titleEl.innerHTML = `<span class="incd-title">${escapeHtml(inc.title || 'Incident')}</span>`;
    const members = (inc.reports || []).map((m) => {
        const dot = SEV_COLORS[m.severity] || '#64748b';
        const lead = m.is_lead ? `<span class="incd-mem-lead">LEAD</span>` : '';
        const split = (inc.report_count > 1) ? `<button class="incd-btn" data-incd-split="${escapeHtml(m.id)}">Split</button>` : '';
        return `<div class="incd-mem" data-incd-open="${escapeHtml(m.id)}">
          <span class="incd-mem-dot" style="background:${dot}"></span>
          <div class="incd-mem-body">
            <div class="incd-mem-t">${escapeHtml(m.crisis_type || 'Report')} · ${escapeHtml(m.status || '')}${lead}</div>
            <div class="incd-mem-s">${escapeHtml((m.description || '').slice(0, 90))}</div>
          </div>${split}
        </div>`;
    }).join('');
    const bldg = inc.building_id
        ? `<span class="incd-chip" data-incd-bldg="${escapeHtml(inc.building_id)}" style="cursor:pointer"><b>🏢 Building</b></span>` : '';
    bodyEl.innerHTML = `<div class="incd-wrap" data-incident-id="${escapeHtml(inc.id)}">
      <div class="incd-head">
        <div class="incd-meta">
          <span class="incd-pill" style="background:${sevC}22;color:${sevC};border:1px solid ${sevC}55" data-incd-statuspill>${escapeHtml(inc.status)}</span>
          <span class="incd-chip"><b>${escapeHtml(inc.severity)}</b></span>
        </div>
        <button class="incd-btn" data-incd-close aria-label="Close">✕</button>
      </div>
      <div class="incd-meta">
        <span class="incd-chip"><b>${inc.report_count}</b> report${inc.report_count === 1 ? '' : 's'}</span>
        ${inc.incident_type ? `<span class="incd-chip">${escapeHtml(inc.incident_type)}</span>` : ''}
        ${bldg}
      </div>
      <div>
        <div class="incd-sec-h">Lifecycle</div>
        <div class="incd-controls">
          <label>Status <select data-incd-set-status>${_INC_STATUSES.map((x) => `<option ${x === inc.status ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
          <label>Severity <select data-incd-set-sev>${_INC_SEVS.map((x) => `<option ${x === inc.severity ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
          <button class="incd-btn" data-incd-merge>Merge…</button>
        </div>
        <div class="incd-merge-list" data-incd-merge-list style="display:none"></div>
      </div>
      <div>
        <div class="incd-sec-h">Reports (${inc.report_count})</div>
        ${members || '<div class="incd-mem-s">No member reports.</div>'}
      </div>
    </div>`;

    const $ = (sel) => bodyEl.querySelector(sel);
    $('[data-incd-close]')?.addEventListener('click', () => { try { window.closeDetail && window.closeDetail(); } catch (_e) {} });
    $('[data-incd-bldg]')?.addEventListener('click', (e) => {
        const b = e.currentTarget.getAttribute('data-incd-bldg');
        try { window.openBuildingConsole && window.openBuildingConsole(b); } catch (_e) {}
    });
    bodyEl.querySelectorAll('[data-incd-open]').forEach((el) => el.addEventListener('click', (e) => {
        if (e.target.closest('[data-incd-split]')) return;   // the Split button has its own handler
        const rid = el.getAttribute('data-incd-open');
        try { (window.openIncident || window.selectReport)(rid); } catch (_e) {}
    }));
    bodyEl.querySelectorAll('[data-incd-split]').forEach((el) => el.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
            await _incJSON(`${INCIDENTS_API}/split-report`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ report_id: el.getAttribute('data-incd-split') }),
            });
            showToast('Report split into a new incident', 'success');
            window.openIncidentDetail(inc.id);
        } catch (_e) { showToast('Split failed', 'error'); }
    }));
    $('[data-incd-set-status]')?.addEventListener('change', async (e) => {
        try { await _incidentPatch(inc.id, { status: e.target.value }); showToast('Incident status updated', 'success'); }
        catch (_e) { showToast('Update failed', 'error'); }
    });
    $('[data-incd-set-sev]')?.addEventListener('change', async (e) => {
        try { await _incidentPatch(inc.id, { severity: e.target.value }); showToast('Incident severity updated', 'success'); }
        catch (_e) { showToast('Update failed', 'error'); }
    });
    $('[data-incd-merge]')?.addEventListener('click', () => _incidentShowMergeList(inc));
}

async function _incidentPatch(id, body) {
    return _incJSON(`${INCIDENTS_API}/${encodeURIComponent(id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
}

async function _incidentShowMergeList(inc) {
    const box = document.querySelector('[data-incd-merge-list]');
    if (!box) return;
    if (box.style.display !== 'none') { box.style.display = 'none'; return; }
    box.style.display = 'flex';
    box.innerHTML = '<div class="incd-mem-s">Loading other incidents…</div>';
    let sibs = [];
    try {
        sibs = await _incJSON(`${INCIDENTS_API}?building_id=${encodeURIComponent(inc.building_id || '')}&limit=50`);
    } catch (_e) { sibs = []; }
    sibs = (sibs || []).filter((s) => s.id !== inc.id);
    if (!sibs.length) { box.innerHTML = '<div class="incd-mem-s">No other incidents in this building to merge into.</div>'; return; }
    box.innerHTML = sibs.map((s) => `<div class="incd-mem">
        <div class="incd-mem-body"><div class="incd-mem-t">${escapeHtml(s.title || 'Incident')}</div>
        <div class="incd-mem-s">${escapeHtml(s.severity)} · ${s.report_count} reports</div></div>
        <button class="incd-btn" data-incd-merge-into="${escapeHtml(s.id)}">Merge into</button></div>`).join('');
    box.querySelectorAll('[data-incd-merge-into]').forEach((el) => el.addEventListener('click', async () => {
        const target = el.getAttribute('data-incd-merge-into');
        try {
            // target absorbs THIS incident's reports; this incident is then deleted.
            await _incJSON(`${INCIDENTS_API}/${encodeURIComponent(target)}/merge`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ source_incident_id: inc.id }),
            });
            showToast('Incidents merged', 'success');
            window.openIncidentDetail(target);
        } catch (_e) { showToast('Merge failed', 'error'); }
    }));
}

window.closeDetail = () => {
    // Phase 2: clear tier override so the next time this report is opened
    // it defaults back to the best-complete variant.
    if (selectedId) _tierOverride.delete(selectedId);
    selectedId = null;
    highlightMarker(null);   // clear the reverse map↔feed marker highlight
    // Phase H.1.d - also clear any active Building Console state so
    // the next selectReport call doesn't paint over a stale console.
    if (typeof _selectedBuildingId !== 'undefined' && _selectedBuildingId) {
        _closeBuildingConsole({ skipFeedRender: true });
    }
    // Phase G.3 - drop the full-report max-modal class on close so the
    // next time the panel opens it starts in its docked size.
    document.body.classList.remove('dp-fullscreen');
    document.getElementById('detail-panel').style.display = 'none';
    // D2: restore focus to whatever was focused before the panel opened.
    try { const pf = window.__dpPriorFocus; window.__dpPriorFocus = null; if (pf && typeof pf.focus === 'function' && document.contains(pf)) pf.focus({ preventScroll: true }); } catch (_e) {}
    // Deep-link: strip ?incident= from the URL so a refresh/Back doesn't reopen
    // this just-closed detail. Suppressed when closeDetail is itself driven by
    // the router's Back restoration (the browser already changed the hash).
    if (!window.__crispNavSuppressHistory) {
        try { window.CrispNav && window.CrispNav.clearIncidentSeg && window.CrispNav.clearIncidentSeg(); } catch (_e) {}
    }
    renderFeed();
};

// ──────────────────────────────────────────────────────────────────────
// Phase F.2.b (May 2026) - Per-report admin-action ribbon
// ──────────────────────────────────────────────────────────────────────
// Async-fetches the last 8 REPORT_* AuthAuditLog entries for the
// currently-selected report and paints a compact strip above the
// per-incident timeline. Guarded against the panel closing /
// switching to a different report mid-fetch - the target element
// is replaced wholesale by the next selectReport.

async function _fetchReportAuditTrail(reportId) {
    const target = document.getElementById(`dp-audit-ribbon-${reportId}`);
    if (!target) return;
    // Phase J.2 - parent section is the wrapping <details> card. We
    // hide the whole section (via .is-empty) rather than just the
    // inner ribbon when there are no events, so the operator's panel
    // doesn't carry a useless "Activity Log" empty header.
    const sectionEl = document.getElementById(`dp-section-activity-${reportId}`);
    try {
        const res = await fetch(
            `${API}/${encodeURIComponent(reportId)}/audit?limit=8`,
            { headers: _authHeaders() }
        );
        if (!res.ok) {
            target.style.display = 'none';
            if (sectionEl) sectionEl.classList.add('is-empty');
            return;
        }
        const data = await res.json();
        // If a subsequent selectReport replaced the target, bail.
        const stillThere = document.getElementById(`dp-audit-ribbon-${reportId}`);
        if (!stillThere || stillThere !== target) return;
        const items = data.items || [];
        if (!items.length) {
            target.style.display = 'none';
            if (sectionEl) sectionEl.classList.add('is-empty');
            return;
        }
        if (sectionEl) sectionEl.classList.remove('is-empty');
        const iconForAction = {
            REPORT_DISPATCH:    'fa-truck-medical',
            REPORT_RESOLVE:     'fa-check',
            REPORT_FALSE_ALARM: 'fa-ban',
            REPORT_ACCEPT:      'fa-circle-check',
            REPORT_REJECT:      'fa-circle-xmark',
            REPORT_DELETE:      'fa-trash-can',
            REPORT_VERIFY:      'fa-satellite',
        };
        const labelForAction = {
            REPORT_DISPATCH:    'Dispatched',
            REPORT_RESOLVE:     'Resolved',
            REPORT_FALSE_ALARM: 'False alarm',
            REPORT_ACCEPT:      'Accepted',
            REPORT_REJECT:      'Rejected',
            REPORT_DELETE:      'Deleted',
            REPORT_VERIFY:      'Verified',
        };
        const colorForAction = {
            REPORT_DISPATCH:    '#a78bfa',
            REPORT_RESOLVE:     '#4ade80',
            REPORT_FALSE_ALARM: '#94a3b8',
            REPORT_ACCEPT:      '#4ade80',
            REPORT_REJECT:      '#f87171',
            REPORT_DELETE:      '#f87171',
            REPORT_VERIFY:      '#7dd3fc',
        };
        target.innerHTML = `
            <div class="dp-audit-head">
                <i class="fa-solid fa-user-shield"></i> Admin actions
                <span class="dp-audit-meta">${items.length} recent</span>
            </div>
            <ul class="dp-audit-list">
                ${items.map(e => {
                    const ic = iconForAction[e.action] || 'fa-circle';
                    const lb = labelForAction[e.action] || e.action;
                    const co = colorForAction[e.action] || '#94a3b8';
                    const who = e.user_email ? escapeHtml(e.user_email.split('@')[0]) : 'system';
                    const when = e.created_at ? timeAgo(e.created_at) : '';
                    const reason = (e.details && e.details.action_taken)
                        ? ` - <em>${escapeHtml(String(e.details.action_taken))}</em>` : '';
                    return `<li class="dp-audit-row">
                        <i class="fa-solid ${ic}" style="color:${co};"></i>
                        <span class="dp-audit-action" style="color:${co};">${lb}</span>
                        <span class="dp-audit-who">by ${who}</span>
                        <span class="dp-audit-when">${when}</span>
                        ${reason}
                    </li>`;
                }).join('')}
            </ul>
        `;
    } catch (e) {
        // Silent - the ribbon is best-effort.
        target.style.display = 'none';
    }
}

// ──────────────────────────────────────────────────────────────────────
// Phase G.3 (May 2026) - Full-report max-modal
// ──────────────────────────────────────────────────────────────────────
// The detail panel by default docks on the right (~380 px wide). For
// a distraction-free reading / printing pass an operator can max it
// to cover the feed + map. Implementation is purely CSS-driven -
// the `body.dp-fullscreen` class swells the detail panel and dims
// the rest. No content re-render needed.

window.toggleFullReportModal = () => {
    const expanding = !document.body.classList.contains('dp-fullscreen');
    document.body.classList.toggle('dp-fullscreen', expanding);
    // Swap the icon to telegraph the next action.
    const btn = document.getElementById('dp-fullscreen-btn');
    if (btn) {
        const icon = btn.querySelector('i');
        if (icon) {
            icon.className = expanding
                ? 'fa-solid fa-down-left-and-up-right-to-center'
                : 'fa-solid fa-up-right-and-down-left-from-center';
        }
        btn.title = expanding ? 'Restore docked panel' : 'Maximise / restore full report';
    }
    if (expanding) {
        // Push a history entry so the browser back-button collapses the
        // modal rather than navigating away. The popstate handler below
        // toggles back to docked mode.
        try { history.pushState({ crispFullReport: true }, '', '#full-report'); } catch (_) {}
        // ESC to dismiss.
        document.addEventListener('keydown', _crispFullReportKeyHandler);
    } else {
        document.removeEventListener('keydown', _crispFullReportKeyHandler);
        // If we got here via the close button, restore the hash.
        if ((window.location.hash || '').includes('full-report')) {
            try { history.back(); } catch (_) {}
        }
    }
};

function _crispFullReportKeyHandler(ev) {
    if (ev.key === 'Escape' && document.body.classList.contains('dp-fullscreen')) {
        toggleFullReportModal();
    }
}

window.addEventListener('popstate', (ev) => {
    // Collapse on back-button if the modal is up.
    if (document.body.classList.contains('dp-fullscreen')) {
        document.body.classList.remove('dp-fullscreen');
        document.removeEventListener('keydown', _crispFullReportKeyHandler);
        const btn = document.getElementById('dp-fullscreen-btn');
        if (btn) {
            const icon = btn.querySelector('i');
            if (icon) icon.className = 'fa-solid fa-up-right-and-down-left-from-center';
            btn.title = 'Maximise / restore full report';
        }
    }
});

// ══════════════════════════════════════════════════════════════════════
// Phase H.1.d (May 2026) - Building Intelligence Console.
//
// When a building is selected (URL hash, map polygon click, or the
// detail panel's "Building history" link), the right-side detail
// panel becomes the Building Console - a humanitarian-ops-grade
// surface that aggregates the building's reports + intelligence
// scores + crisis breakdown + responder status + satellite roll-up
// into one visual entity.
//
// The console fetches GET /api/v1/buildings/{id} (Phase H.1.c) and
// renders 6 sections in this commit:
//
//   1. Sticky header - name, state pill, scores summary, close
//   2. 5-score intelligence grid (severity / confidence / activity /
//      escalation_risk / humanitarian_priority)
//   3. Crisis-type breakdown + damage distribution + debris chip
//   4. Versioned report stack (latest-first)
//   5. Satellite verification roll-up
//   6. Footer with placeholders for H.2-H.6 surfaces (state actions,
//      responder panel, notes, AI summary, dossier export - wired in
//      subsequent commits without restructuring the console layout).
//
// State machine: a single `_selectedBuildingId` variable + URL hash
// listener keep the console in sync across reloads, deep links, and
// inter-operator URL sharing.
// ══════════════════════════════════════════════════════════════════════
let _selectedBuildingId = null;
let _buildingConsoleCache = {};  // id → BuildingDetail JSON, cached for the session

async function _fetchBuildingDetail(buildingId) {
    if (_buildingConsoleCache[buildingId]) {
        return _buildingConsoleCache[buildingId];
    }
    // Bounded fetch: a 500 / network drop / stalled backend must NOT leave the console
    // spinning forever (the caller renders a recoverable error state on null). 15s cap.
    const ctrl = new AbortController();
    const _to = setTimeout(() => { try { ctrl.abort(); } catch (_e) {} }, 15000);
    try {
        const res = await fetch(`${BUILDINGS_API}/${encodeURIComponent(buildingId)}`, { signal: ctrl.signal });
        if (!res.ok) return null;
        const detail = await res.json();
        _buildingConsoleCache[buildingId] = detail;
        return detail;
    } catch (_e) {
        return null;   // network error, timeout, or abort
    } finally {
        clearTimeout(_to);
    }
}

// Recoverable error state for the Building Console - shown instead of a stuck spinner
// when the fetch fails/times out or the render throws. Keeps the panel open + offers Retry.
function _renderBuildingConsoleError(buildingId, msg) {
    const title = document.getElementById('detail-title');
    const body = document.getElementById('detail-body');
    if (title) title.textContent = 'Building';
    if (body) body.innerHTML =
        '<div class="bc-error">' +
        '<i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>' +
        '<div class="bc-error-msg">' + escapeHtml(msg || "Couldn't load this building.") + '</div>' +
        '<button class="bc-retry" type="button" onclick="window.openBuildingConsole&&window.openBuildingConsole(decodeURIComponent(\'' +
        encodeURIComponent(buildingId) + '\'))">Retry</button>' +
        '</div>';
}

function _updateBuildingUrlHash(buildingId) {
    // Compose with the Phase G.1 chip-filter hash. Preserve existing
    // `chips=...` segment and add/replace the `building=...` segment.
    try {
        const hash = (window.location.hash || '').replace(/^#/, '');
        const parts = hash.split(';').filter(p => p && !p.startsWith('building='));
        // Append (route-first), NOT unshift: the route path must stay the first
        // segment so the hash is well-formed + routable, e.g.
        // `#/incidents;op=<id>;building=<bid>`. Prepending produced the malformed
        // `#building=<bid>;/incidents;...` that left the building deep-link unroutable.
        if (buildingId) parts.push(`building=${encodeURIComponent(buildingId)}`);
        const newHash = parts.length ? `#${parts.join(';')}` : '';
        if (window.location.hash !== newHash) {
            history.replaceState(null, '', window.location.pathname + window.location.search + newHash);
        }
    } catch (_) { /* defensive */ }
}

window.openBuildingConsole = async (buildingId) => {
    if (!buildingId) return;
    selectedId = null;  // close any open report-detail
    _tierOverride.clear();
    _selectedBuildingId = buildingId;
    _updateBuildingUrlHash(buildingId);

    const panel = document.getElementById('detail-panel');
    // Reparent to <body> so the console is a GLOBAL overlay (z 100000) visible
    // over any route overlay - the operations/home overlays (z 99990) included.
    // Mirrors selectReport(); without it the panel stays inside the hidden
    // #view-incidents container, so opening a building card off the Incidents
    // page silently did nothing (D1).
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.style.display = 'flex';
    panel.classList.remove('detail-panel--operation');
    panel.classList.add('detail-panel--building');
    // D2: move focus into the console so keyboard users can reach + Escape it.
    try { window.__dpPriorFocus = document.activeElement; panel.setAttribute('tabindex', '-1'); panel.focus({ preventScroll: true }); } catch (_e) {}

    // Show a loading placeholder while the fetch lands.
    document.getElementById('detail-title').textContent = 'Loading building…';
    document.getElementById('detail-body').innerHTML =
        '<div class="bc-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading…</div>';

    const b = await _fetchBuildingDetail(buildingId);
    // Guard against a stale click: if another building/report was opened while this
    // fetch was in flight, don't clobber the current panel.
    if (_selectedBuildingId !== buildingId) return;
    if (!b) {
        _renderBuildingConsoleError(buildingId, "Couldn't load this building. The server may be busy.");
        return;
    }

    // Map: highlight the selected building's polygon + fly to its
    // centroid. Both bounded by map readiness - silent no-op if the
    // map isn't initialised yet.
    try {
        if (window.map && typeof window.map.flyTo === 'function' &&
            typeof b.centroid_lat === 'number' && typeof b.centroid_lng === 'number') {
            window.map.flyTo([b.centroid_lat, b.centroid_lng], 17, { duration: 0.6 });
        }
        if (typeof window._highlightBuildingPolygon === 'function') {
            window._highlightBuildingPolygon(buildingId);
        }
    } catch (_) {}

    try {
        _renderBuildingConsole(_opScopeBuilding(b));
    } catch (e) {
        try { console.error('[building console] render failed', e); } catch (_) {}
        _renderBuildingConsoleError(buildingId, "Couldn't display this building.");
    }
};

// Operation node → the RIGHT PANEL (single-page Operations Console). Mirrors
// openBuildingConsole: reparent the global #detail-panel to <body>, scope the feed
// behind it to this operation, and render the SAME operation dashboard
// (cc-operations renderDetail) into the panel body — NO full-page #/operations/{id}
// transition. This is the keystone that makes Operations behave like Buildings/Incidents.
window.openOperationSummary = (opId) => {
    if (!opId) return;
    selectedId = null;                 // close any open report-detail
    _selectedBuildingId = null;        // and any building selection
    if (_opsRegMode) {
        // Registry mode: the LEFT stays the operations tree (the global working set) with
        // this op highlighted; only the RIGHT panel opens (it fetches its own per-op data).
        // Do NOT scope the feed — that would replace the registry with one op's incidents.
        _opsRegSelectedOp = opId;
        try { renderFeed(); } catch (_e) {}
    } else {
        // Scope the feed behind the panel to this operation + reflect it in the URL
        // (replaceState — no dispatch, the panel survives).
        try { if (window.setOperationScope) window.setOperationScope(opId); } catch (_e) {}
        try { _writeScopeHash(); } catch (_e) {}
    }

    const panel = document.getElementById('detail-panel');
    if (!panel) return;
    if (panel.parentElement !== document.body) document.body.appendChild(panel);
    panel.style.display = 'flex';
    panel.classList.remove('detail-panel--building');
    panel.classList.add('detail-panel--operation');
    try { window.__dpPriorFocus = document.activeElement; panel.setAttribute('tabindex', '-1'); panel.focus({ preventScroll: true }); } catch (_e) {}

    document.getElementById('detail-title').textContent = 'Operation';
    document.getElementById('detail-body').innerHTML =
        '<div class="bc-loading"><i class="fa-solid fa-spinner fa-spin"></i> Loading operation…</div>';
    try {
        if (window.__ccOperations && window.__ccOperations.renderInto) {
            window.__ccOperations.renderInto(document.getElementById('detail-body'), opId);
        } else {
            document.getElementById('detail-body').innerHTML = '<div class="bc-error">Operations module not ready.</div>';
        }
    } catch (e) {
        try { console.error('[op summary] render failed', e); } catch (_) {}
        document.getElementById('detail-body').innerHTML = "<div class=\"bc-error\">Couldn't display this operation.</div>";
    }
};

// Op-scope a building detail's incident LIST when the console was opened from inside
// an operation feed: show only that operation's reports (global feed → all reports).
// The building's roll-up header stays building-wide (its true overall state). MUST be
// applied at EVERY _renderBuildingConsole call site (incl. post-action re-renders) -
// otherwise an in-console action silently re-expands the list to all operations.
function _opScopeBuilding(b) {
    if (b && _activeCrisisEventId && Array.isArray(b.reports)) {
        const scoped = b.reports.filter((r) => r.crisis_event_id === _activeCrisisEventId);
        return Object.assign({}, b, { reports: scoped, _opScopedId: _activeCrisisEventId, _opScopedTotal: b.reports.length });
    }
    return b;
}

function _closeBuildingConsole(opts) {
    opts = opts || {};
    _selectedBuildingId = null;
    _updateBuildingUrlHash(null);
    const panel = document.getElementById('detail-panel');
    panel.classList.remove('detail-panel--building', 'detail-panel--operation');
    try {
        if (typeof window._highlightBuildingPolygon === 'function') {
            window._highlightBuildingPolygon(null);  // clear highlight
        }
    } catch (_) {}
    if (!opts.skipFeedRender) {
        panel.style.display = 'none';
        renderFeed();
    }
}
window.closeBuildingConsole = _closeBuildingConsole;

// ──────────────────────────────────────────────────────────────────────
// Phase H.5+ (May 2026) - Console header info derivation
// ──────────────────────────────────────────────────────────────────────
// Operator feedback: "OSM way 1243242 is unreadable as a building name."
// Instead, the header should carry:
//   - A human-readable building name (osm_name → most-common
//     infrastructure_name from reports → "Untitled building")
//   - The city / locality (parsed from constituent reports' location
//     names - the last comma-separated segment is usually the city
//     or region)
//   - The geographic coordinates (centroid)
//   - A small OSM-id hint at the bottom so the operator can still
//     correlate with raw OSM data when needed.

function _deriveBuildingHeaderInfo(b) {
    const reports = b.reports || [];
    // Find a useful building name from constituent reports — but ONLY from a report
    // whose name is an OSM-tagged building (_taggedBuildingName), the SAME gate the
    // Incident Feed / breadcrumb use. Without this gate the Console header used the
    // first report's RAW infrastructure_name, so a free-text "what was hit" answer
    // showed here as the building name while every gated surface showed "Unnamed
    // building" — the exact per-surface inconsistency the operator hit. One rule now.
    let inferredName = null;
    for (const r of reports) {
        if (_taggedBuildingName(r)) {
            inferredName = r.infrastructure_name.trim();
            break;
        }
    }
    const name =
        (b.osm_name && b.osm_name.trim())
        || inferredName
        || (b.osm_addr_full && b.osm_addr_full.trim())
        || 'Unmapped building';

    // City / locality - count location-name segments + pick the most
    // common one. The LAST segment of a comma-separated location name
    // is usually the city / state / country; we pick the most-distinctive
    // (i.e., the most common segment that isn't trivially short).
    const cityCounts = new Map();
    for (const r of reports) {
        const raw =
            (r.location && (r.location.user_location_name || r.location.device_location_name))
            || '';
        if (!raw) continue;
        const parts = raw.split(',').map(s => s.trim()).filter(s => s.length >= 3);
        // Take the LAST 1-2 parts (city, country) as the candidate
        // string; deduplicate same-string occurrences across reports.
        const candidate = parts.length >= 2
            ? `${parts[parts.length - 2]}, ${parts[parts.length - 1]}`
            : parts[parts.length - 1] || '';
        if (candidate) {
            cityCounts.set(candidate, (cityCounts.get(candidate) || 0) + 1);
        }
    }
    let city = null;
    if (cityCounts.size) {
        const sorted = [...cityCounts.entries()].sort((a, b) => b[1] - a[1]);
        city = sorted[0][0];
    }

    // Coords - 4-decimal precision is plenty for an operator console
    // (matches ~11 m). Centroid is the building's authoritative point.
    const coords = (b.centroid_lat != null && b.centroid_lng != null)
        ? `${b.centroid_lat.toFixed(4)}, ${b.centroid_lng.toFixed(4)}`
        : null;

    // Small OSM hint at the bottom of the subtitle row so the operator
    // can still correlate with OSM tools (but it's NOT the primary
    // surface).
    let osmHint = null;
    if (b.osm_way_id) {
        osmHint = `OSM way ${b.osm_way_id}`;
    } else if (b.id_source === 'PROXIMITY') {
        osmHint = `Proximity cluster ${b.id.slice(0, 8)}`;
    }

    return { name, city, coords, osmHint };
}

// The operation a building/cluster belongs to = the most common crisis_event_id
// among its constituent reports (named via the ops cache). null = unassigned.
function _buildingOperation(b) {
    const counts = {};
    for (const r of (b.reports || [])) {
        if (r.crisis_event_id) counts[r.crisis_event_id] = (counts[r.crisis_event_id] || 0) + 1;
    }
    let opId = null, max = 0;
    for (const k in counts) { if (counts[k] > max) { max = counts[k]; opId = k; } }
    if (!opId) return null;
    const meta = (typeof _opMeta === 'function') ? _opMeta(opId) : null;
    return { id: opId, name: (meta && meta.name) || 'Operation', count: max };
}

// Per-building duplicate scan for the Building Console - reuses the within-building
// engine scoped by building_id. Shows "Potential Duplicates: N" + Merge-All buttons;
// per-pair review (confidence + reasons + individual Merge/Unmerge) is done by opening
// a report in the building's report list (the shipped incident-detail duplicate UI).
async function _loadBuildingDuplicates(bid) {
    const body = document.getElementById('bc-dup-body-' + bid);
    const countEl = document.getElementById('bc-dup-count-' + bid);
    if (!body) return;
    let d;
    try {
        const res = await fetch(`${API}/duplicate-summary?building_id=${encodeURIComponent(bid)}`);
        if (!res.ok) { body.innerHTML = '<div class="bc-empty">Could not scan for duplicates.</div>'; if (countEl) countEl.textContent = '-'; return; }
        d = await res.json();
    } catch (_e) { body.innerHTML = '<div class="bc-empty">Could not scan for duplicates.</div>'; if (countEl) countEl.textContent = '-'; return; }
    const total = (d && d.total) || 0;
    if (countEl) countEl.textContent = total;
    if (!total) { body.innerHTML = '<div class="bc-empty">No potential duplicates in this building.</div>'; return; }
    let role = ''; try { role = (JSON.parse(localStorage.getItem('crisp_user') || '{}').role) || ''; } catch (_e) {}
    const canMerge = role === 'ANALYST' || role === 'ADMIN' || role === 'SUPER_ADMIN';
    const bidJs = `decodeURIComponent('${encodeURIComponent(bid)}')`;
    const btn = (lvl, n, label) => (n > 0 && canMerge)
        ? `<button class="dp-dup-btn dp-dup-yes" style="margin-right:6px" onclick="window._dupMergeAllBuilding(${bidJs},'${lvl}')">${label} (${n})</button>` : '';
    body.innerHTML =
        `<div style="font-size:12px;color:#cbd9ef;margin-bottom:6px">High <b>${d.high || 0}</b> · Medium <b>${d.medium || 0}</b> · Low <b>${d.low || 0}</b> · Total <b>${total}</b></div>` +
        `<div style="margin-bottom:6px">${btn('HIGH', d.high || 0, 'Merge All High')}${btn('MEDIUM', d.medium || 0, 'Merge All Medium')}</div>` +
        `<div style="font-size:10.5px;color:#8aa0bf">Open a report below to review each pair (confidence + reasons) and Merge / Unmerge individually.</div>`;
}
// Phase 2E - list this building's first-class incidents in the Building Console.
// Reuses the .bc-report row styling for visual consistency; each row opens the
// Incident Detail overlay (window.openIncidentDetail). This is the visible
// Building → Incidents → Reports navigation spine.
async function _loadBuildingIncidents(bid) {
    const body = document.getElementById('bc-inc-body-' + bid);
    const countEl = document.getElementById('bc-inc-count-' + bid);
    if (!body) return;
    let list;
    try {
        const res = await fetch(`${INCIDENTS_API}?building_id=${encodeURIComponent(bid)}&limit=100`);
        if (!res.ok) { body.innerHTML = '<div class="bc-empty">Could not load incidents.</div>'; if (countEl) countEl.textContent = '-'; return; }
        list = await res.json();
    } catch (_e) { body.innerHTML = '<div class="bc-empty">Could not load incidents.</div>'; if (countEl) countEl.textContent = '-'; return; }
    list = Array.isArray(list) ? list : [];
    if (countEl) countEl.textContent = list.length;
    if (!list.length) { body.innerHTML = '<div class="bc-empty">No incidents in this building yet.</div>'; return; }
    body.innerHTML = list.map((inc) => {
        const sev = inc.severity || 'UNKNOWN';
        const idJs = `decodeURIComponent('${encodeURIComponent(inc.id)}')`;
        return `<div class="bc-report" onclick="window.openIncidentDetail&&window.openIncidentDetail(${idJs})" title="Open incident detail">
            <span class="bc-r-strip" style="background:${SEV_COLORS[sev] || '#64748b'};"></span>
            <div class="bc-r-body">
                <div class="bc-r-line1">
                    <span class="bc-r-sev bc-r-sev-${sev}">${sev}</span>
                    <!-- Lead with the incident's OWN identity (crisis type), NOT inc.title:
                         the server builds inc.title as "{Crisis} - {building name}", and this
                         list sits under the Building Console header which already names the
                         building (feedback_no_redundant_parent_context). -->
                    <span class="bc-r-crisis">${escapeHtml(inc.incident_type ? crisisLabel(inc.incident_type) : 'Incident')}</span>
                </div>
                <div class="bc-r-line2">
                    <span class="bc-r-source">${escapeHtml(inc.status || 'OPEN')}</span>
                    <span class="bc-r-time">${inc.report_count} report${inc.report_count === 1 ? '' : 's'}</span>
                </div>
            </div>
        </div>`;
    }).join('');
}
window._dupMergeAllBuilding = async (bid, level) => {
    try {
        const res = await fetch(`${API}/duplicate-merge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('crisp_token') || '') },
            body: JSON.stringify({ confidence: level, building_id: bid }),
        });
        if (!res.ok) { showToast(res.status === 403 ? 'Not authorized (analyst required)' : 'Could not merge', 'error'); return; }
        const out = await res.json();
        const n = out.merged || 0;
        showToast('Merged ' + n + ' duplicate' + (n !== 1 ? 's' : ''), 'success');
        _loadBuildingDuplicates(bid);
        try { _dupSummaryCache = { ts: 0, scope: undefined, data: null }; } catch (_e) {}   // refresh the awareness card
        try { _lastServerTime = null; _lastReportsEtag = null; } catch (_e) {}
        try { fetchReports(); } catch (_e) {}
    } catch (_e) { showToast('Could not merge', 'error'); }
};

// A2 (Jun 2026): the Building Console is a flat collapsible stack in the
// incident-detail visual language (<details class="dp-section">) instead of
// Overview/Intelligence tabs - one consistent layout, lower cognitive load. This
// injects only the BC-specific tweaks; the dp-section base + the general .bc-*
// styling (header, chips, scores, reports) live in styles.css.
function _ensureBcStyles() {
    if (document.getElementById('bc-console-styles')) return;
    const s = document.createElement('style');
    s.id = 'bc-console-styles';
    s.textContent = `
      .bc-dps{margin:8px 0}
      .bc-dps .dp-section-body{padding:8px 10px 12px}
      .bc-tl-head{display:flex;align-items:center;justify-content:space-between;font-size:10.5px;color:#9fb3d1;margin:8px 0 4px;text-transform:uppercase;letter-spacing:.05em}
      .bc-timeline-wrap{margin-top:8px;border-top:1px solid rgba(148,163,184,.10);padding-top:4px}
      .bc-dps .bc-responder-add-btn,.bc-dps .bc-note-add-btn{margin-bottom:8px}`;
    document.head.appendChild(s);
}
// A2: a Building Console section in the incident-detail <details class="dp-section">
// language. `countBadge` is raw badge HTML (static number or an id-bearing span the
// async loaders update) or ''; `open` sets the default expanded state.
function _bcSection(icon, label, countBadge, open, bodyHtml, extraCls) {
    return `<details class="dp-section bc-dps ${extraCls || ''}"${open ? ' open' : ''}>
        <summary class="dp-section-header">
            <i class="fa-solid ${icon}"></i>
            <span>${label}</span>
            ${countBadge || ''}
            <i class="fa-solid fa-chevron-down dp-section-caret"></i>
        </summary>
        <div class="dp-section-body">${bodyHtml}</div>
    </details>`;
}
// _bcTab retired with the tabs (A2). Kept as a no-op so any stale onclick can't throw.
window._bcTab = () => {};

function _renderBuildingConsole(b) {
    // Helper formatters
    const scoreColor = (v) => {
        if (v == null) return '#64748b';
        if (v >= 80) return '#ef4444';
        if (v >= 60) return '#f97316';
        if (v >= 40) return '#eab308';
        if (v >= 20) return '#22c55e';
        return '#94a3b8';
    };
    const scoreVal = (v) => (v == null ? '-' : v.toFixed(0));
    const sevColor = SEV_COLORS[b.severity_max] || '#64748b';
    const stateColors = {
        ACTIVE:      { bg: 'rgba(148, 163, 184, 0.18)', fg: '#cbd5e1' },
        MONITORED:   { bg: 'rgba(70, 223, 177, 0.18)', fg: '#46DFB1' },
        RESPONDING:  { bg: 'rgba(167, 139, 250, 0.18)', fg: '#a78bfa' },
        ESCALATED:   { bg: 'rgba(239, 68, 68, 0.18)', fg: '#f87171' },
        RESOLVED:    { bg: 'rgba(34, 197, 94, 0.18)', fg: '#4ade80' },
        ARCHIVED:    { bg: 'rgba(100, 116, 139, 0.18)', fg: '#94a3b8' },
        FALSE_ALARM: { bg: 'rgba(100, 116, 139, 0.18)', fg: '#94a3b8' },
    };
    const stateCol = stateColors[b.state] || stateColors.ACTIVE;

    // Phase H.5+ (May 2026) - Header redesign per operator feedback:
    // "OSM way 1243242" is unreadable. Promote a human-friendly name
    // (osm_name → infrastructure_name from reports → "Untitled building"
    // with the OSM id as a small subtitle). Derive city/locality from
    // constituent report location names.
    const _bcInfo = _deriveBuildingHeaderInfo(b);
    // When opened from inside an operation, the incident LIST below is scoped to
    // that op; flag it so the operator knows the header roll-up is building-wide
    // but the reports are the operation's subset.
    let _opScopeNote = '';
    if (b._opScopedId) {
        const _opn = ((_opMeta(b._opScopedId) || {}).name) || 'this operation';
        _opScopeNote = ` <span class="bc-opscope" title="Showing only ${escapeHtml(_opn)}'s reports for this building (the header stats stay building-wide)">· ${escapeHtml(_opn)} (${(b.reports || []).length}/${b._opScopedTotal})</span>`;
    }
    document.getElementById('detail-title').innerHTML =
        `<i class="fa-solid fa-building" style="margin-right:6px;color:${sevColor};"></i>` +
        escapeHtml(_bcInfo.name) + _opScopeNote;

    // P2: the Building Console IS the Cluster View. Breadcrumb keeps the
    // Operation context visible (Global › [Operations › {op} ›] Cluster) + an
    // assigned-operation chip, both derived from the constituent reports.
    const _op = _buildingOperation(b);
    const _bcArrow = '<i class="fa-solid fa-angle-right dp-bc-sep" aria-hidden="true"></i>';
    // Canonical spine Global › Operation › Building (matches the incident-detail
    // breadcrumb - no extra static "Operations" crumb). Muted placeholder when the
    // building is under no operation. Building leaf is the OSM name (never free-text).
    const _consoleBc = '<a class="dp-bc-seg" onclick="window.__crispRouter&&window.__crispRouter.navigate(\'/incidents\')">Global</a>'
        + _bcArrow + (_op
            ? `<a class="dp-bc-seg dp-bc-op" onclick="window.openOperationSummary&&window.openOperationSummary('${_op.id}')">${escapeHtml(_op.name)}</a>`
            : `<span class="dp-bc-seg dp-bc-absent" title="Not under an operation">${_HIER_OP_ABSENT}</span>`)
        + _bcArrow + '<span class="dp-bc-cur">' + escapeHtml(b.osm_name || 'Building') + '</span>';

    // Crisis-type chips + damage distribution
    const crisisChips = (b.crisis_types_top3 || [])
        .map(ct => `<span class="bc-crisis-chip">${escapeHtml(crisisLabel(ct))}</span>`)
        .join('');
    const totalReports = b.report_count || 0;
    const dmgDistribution = (() => {
        // Compute from nested reports to avoid extra round-trips.
        const counts = { COMPLETE: 0, PARTIAL: 0, MINIMAL: 0, UNKNOWN: 0 };
        for (const r of (b.reports || [])) {
            const d = r.damage_classification || 'UNKNOWN';
            counts[d] = (counts[d] || 0) + 1;
        }
        return counts;
    })();
    const dmgPct = (n) => (totalReports ? Math.round((n / totalReports) * 100) : 0);

    // Build the console HTML.
    _ensureBcStyles();
    document.getElementById('detail-body').innerHTML = `
        <div class="bc">
            <nav class="dp-breadcrumb" aria-label="Breadcrumb">${_consoleBc}</nav>
            <!-- Top bar: Name · City · Location (coords) + explicit
                 export buttons (CSV · GeoJSON · PDF) + monitor +
                 state-machine actions. Matches operator request from
                 May 2026: "instead of 'OSM way N' as the name, show
                 Building name, City, Location on the Top Bar with
                 Export CSV, GeoJSON, PDF Report." -->
            <div class="bc-header">
                <div class="bc-header-titles">
                    <div class="bc-subtitle">
                        ${_bcInfo.city ? `<span class="bc-sub-city"><i class="fa-solid fa-location-dot"></i> ${escapeHtml(_bcInfo.city)}</span>` : ''}
                        ${_bcInfo.coords ? `<span class="bc-sub-coords" title="Centroid"><i class="fa-regular fa-compass"></i> ${escapeHtml(_bcInfo.coords)}</span>` : ''}
                        ${_bcInfo.osmHint ? `<span class="bc-sub-osm" title="OpenStreetMap source identifier">${escapeHtml(_bcInfo.osmHint)}</span>` : ''}
                    </div>
                </div>
                <div class="bc-header-row">
                    <span class="bc-state" style="background:${stateCol.bg};color:${stateCol.fg};">
                        ${escapeHtml(b.state)}
                    </span>
                    <span class="bc-count-chip" title="Total constituent reports">
                        <i class="fa-solid fa-flag"></i> ${totalReports}
                    </span>
                    <span class="bc-count-chip" title="Reports verified by an analyst">
                        <i class="fa-solid fa-circle-check"></i> ${b.verified_report_count || 0}
                    </span>
                    <span class="bc-count-chip" title="Reports with responder dispatched">
                        <i class="fa-solid fa-truck-medical"></i> ${b.responding_report_count || 0}
                    </span>
                    ${_op
                        ? `<span class="bc-count-chip" title="Assigned operation (${escapeHtml(String(_op.count))} report(s))" style="cursor:pointer" onclick="window.openOperationSummary&&window.openOperationSummary('${_op.id}')">
                               <i class="fa-solid fa-bullseye"></i> ${escapeHtml(_op.name)}
                           </span>`
                        : ''}
                    ${b.debris_clearing_needed_count
                        ? `<span class="bc-count-chip bc-count-chip-warn" title="Reports flagged as needing debris clearing">
                               <i class="fa-solid fa-broom"></i> ${b.debris_clearing_needed_count} debris
                           </span>`
                        : ''}
                </div>
                <div class="bc-export-row">
                    <button class="bc-export-direct bc-export-csv"
                            onclick="_downloadBuildingDossier('${b.id}', 'csv')"
                            title="Export building + reports as CSV">
                        <i class="fa-solid fa-file-csv"></i> CSV
                    </button>
                    <button class="bc-export-direct bc-export-geojson"
                            onclick="_downloadBuildingDossier('${b.id}', 'geojson')"
                            title="Export as GeoJSON (QGIS / ArcGIS compatible)">
                        <i class="fa-solid fa-map"></i> GeoJSON
                    </button>
                    <button class="bc-export-direct bc-export-pdf"
                            onclick="_downloadBuildingDossier('${b.id}', 'pdf')"
                            title="Export PDF report (full dossier)">
                        <i class="fa-regular fa-file-pdf"></i> PDF Report
                    </button>
                </div>
                <div class="bc-actions">
                    ${_renderBuildingActions(b)}
                    ${_renderBuildingMonitorToggle(b)}
                    ${_renderBuildingStateActions(b)}
                </div>
            </div>

            <!-- A2 (Jun 2026): flat collapsible stack in the incident-detail
                 visual language (<details class="dp-section">) - no Overview/
                 Intelligence tabs. Building Assessment + History + Incidents open
                 by default; analytics/evidence/coordination collapse below. Every
                 async-loader target id + cascade handler is preserved verbatim. -->

            <!-- Building Assessment card (mirrors the incident Confidence Score
                 card). Runs AI assessment across non-dup incidents; opens a modal. -->
            ${_renderBuildingAssessmentCard(b)}

            ${_bcSection('fa-timeline', 'History &amp; lifecycle', '', true, `
                <div class="bc-lifecycle" id="bc-lifecycle-${escapeHtml(b.id)}"><div class="bc-empty">Loading lifecycle…</div></div>
                <div class="bc-timeline-wrap">
                    <div class="bc-tl-head"><span>Event timeline</span>
                        <button class="bc-timeline-refresh" onclick="_refreshBuildingTimeline('${b.id}')" title="Refresh timeline"><i class="fa-solid fa-arrows-rotate"></i></button>
                    </div>
                    <div class="bc-timeline" id="bc-timeline-${escapeHtml(b.id)}"><div class="bc-empty">Loading timeline…</div></div>
                </div>
            `, 'bc-section-history')}

            ${_bcSection('fa-layer-group', 'Situation summary', '', false, `
                ${crisisChips
                    ? `<div class="bc-crisis-row">${crisisChips}</div>`
                    : '<div class="bc-empty">No crisis-type tagging yet</div>'}
                <div class="bc-damage-row">
                    <span class="bc-damage-cell bc-damage-COMPLETE"><strong>${dmgDistribution.COMPLETE}</strong> complete (${dmgPct(dmgDistribution.COMPLETE)}%)</span>
                    <span class="bc-damage-cell bc-damage-PARTIAL"><strong>${dmgDistribution.PARTIAL}</strong> partial (${dmgPct(dmgDistribution.PARTIAL)}%)</span>
                    <span class="bc-damage-cell bc-damage-MINIMAL"><strong>${dmgDistribution.MINIMAL}</strong> minimal (${dmgPct(dmgDistribution.MINIMAL)}%)</span>
                </div>
            `, '')}

            <!-- Jun 2026: the "Intelligence scores" 5-grid (severity/confidence/activity/
                 escalation/humanitarian_priority + "Why this priority"), the separate
                 "AI assessment" card, and the standalone "Satellite verification" score
                 were REMOVED — they competed with each other + the assessment. The ONE
                 Building Risk Score card above is now the single decision metric; its
                 breakdown modal carries the contributing incidents, evidence and reasoning.
                 (humanitarian_priority still drives the hot-list sort in the backend.) -->

            ${_bcSection('fa-triangle-exclamation', 'Incidents', `<span class="dp-cf-count" id="bc-inc-count-${escapeHtml(b.id)}">…</span>`, true, `
                <div id="bc-inc-body-${escapeHtml(b.id)}" class="bc-inc-body"><div class="bc-empty">Loading incidents…</div></div>
            `, '')}

            ${_bcSection('fa-list', 'Reports', `<span class="dp-cf-count">${(b.reports || []).length}</span>`, false, `
                <div class="bc-reports">
                    ${(b.reports || []).map(r => {
                        const sev = r.severity || 'UNKNOWN';
                        const damage = r.damage_classification || '';
                        const crisis = r.crisis_type ? crisisLabel(r.crisis_type) : '';
                        const verdictBadge = r.reviewer_verdict === 'ACCEPTED'
                            ? '<span class="bc-r-verdict bc-r-verdict-accepted">✓</span>'
                            : r.reviewer_verdict === 'REJECTED'
                                ? '<span class="bc-r-verdict bc-r-verdict-rejected">✕</span>'
                                : '';
                        return `<div class="bc-report" onclick="window.openIncident('${r.id}')">
                            <span class="bc-r-strip" style="background:${SEV_COLORS[sev]};"></span>
                            <div class="bc-r-body">
                                <div class="bc-r-line1">
                                    <span class="bc-r-sev bc-r-sev-${sev}">${sev}</span>
                                    ${damage ? `<span class="bc-r-dmg">${escapeHtml(damage.replace(/_/g, ' '))}</span>` : ''}
                                    ${crisis ? `<span class="bc-r-crisis">${escapeHtml(crisis)}</span>` : ''}
                                    ${verdictBadge}
                                </div>
                                <div class="bc-r-line2">
                                    <span class="bc-r-source"><i class="fa-solid fa-${({APP:'mobile-screen-button',TELEGRAM:'comments',WHATSAPP:'comment-dots',SMS:'comment-sms',IVR:'phone'})[r.source] || 'mobile-screen-button'}"></i> ${escapeHtml(r.source || 'APP')}</span>
                                    <span class="bc-r-time">${timeAgo(r.server_created_at)}</span>
                                    ${r.help_dispatched_at ? '<span class="bc-r-resp"><i class="fa-solid fa-truck-medical"></i> dispatched</span>' : ''}
                                    ${r.help_arrived_at ? '<span class="bc-r-resp"><i class="fa-solid fa-map-pin"></i> on-site</span>' : ''}
                                </div>
                            </div>
                        </div>`;
                    }).join('') || '<div class="bc-empty">No constituent reports</div>'}
                </div>
            `, '')}

            ${_bcSection('fa-link', 'Potential duplicates', `<span class="dp-cf-count" id="bc-dup-count-${escapeHtml(b.id)}">…</span>`, false, `
                <div id="bc-dup-body-${escapeHtml(b.id)}" class="bc-dup-body"><div class="bc-empty">Scanning for duplicates…</div></div>
            `, 'bc-section-duplicates')}

            ${_bcSection('fa-truck-medical', 'Responders', `<span class="dp-cf-count">${(b.responders || []).length}</span>`, false, `
                <button class="bc-responder-add-btn" onclick="_openResponderAssignForm('${b.id}')" title="Assign a responder to this building"><i class="fa-solid fa-plus"></i> Assign</button>
                <div id="bc-responder-form-${escapeHtml(b.id)}" class="bc-responder-form" style="display:none;"></div>
                <div class="bc-responders">${_renderResponderList(b)}</div>
            `, 'bc-section-responders')}

            ${_bcSection('fa-note-sticky', 'Operator notes', `<span class="dp-cf-count">${((b.notes || []).filter(n => !n.deleted_at)).length}</span>`, false, `
                <button class="bc-note-add-btn" onclick="_openNoteForm('${b.id}')" title="Add a note"><i class="fa-solid fa-plus"></i> Add</button>
                <div id="bc-note-form-${escapeHtml(b.id)}" class="bc-note-form" style="display:none;"></div>
                <div class="bc-notes" id="bc-notes-${escapeHtml(b.id)}">${_renderNoteList(b)}</div>
            `, 'bc-section-notes')}

            ${_bcSection('fa-link-slash', 'Related buildings', `<span class="dp-cf-count" id="bc-related-count-${escapeHtml(b.id)}">-</span>`, false, `
                <div class="bc-related" id="bc-related-${escapeHtml(b.id)}"><div class="bc-empty">Loading nearby buildings…</div></div>
            `, 'bc-section-related')}

        </div>
    `;
    // Phase H.2 - fetch the timeline async (decoupled from the
    // initial console paint so the user sees scores + reports
    // immediately, even while the timeline still loads).
    setTimeout(() => _refreshBuildingTimeline(b.id), 50);
    // Phase H.10 - fetch related buildings similarly. Independent
    // of the timeline fetch; either can fail without blocking the
    // other.
    setTimeout(() => _refreshRelatedBuildings(b.id), 80);
    // Per-building duplicate scan (async; reuses the within-building engine).
    setTimeout(() => _loadBuildingDuplicates(b.id), 30);
    // Phase 2E - the building's first-class incidents (async).
    setTimeout(() => _loadBuildingIncidents(b.id), 30);
    // Clear the bottom action dock (the building console manages its own
    // actions inside .bc-header / .bc-actions).
    const dock = document.getElementById('dp-action-dock');
    if (dock) dock.innerHTML = '';
}

// URL hash listener: on cold load + on hashchange, if `#building=<id>`
// is set, open the console for that building. Composes with the
// Phase G.1 chip filters in the same hash.
function _initBuildingHashListener() {
    const _readHashBuilding = () => {
        const hash = (window.location.hash || '').replace(/^#/, '');
        for (const seg of hash.split(';')) {
            const m = seg.match(/^building=(.+)$/);
            if (m) return decodeURIComponent(m[1]);
        }
        return null;
    };
    const _apply = () => {
        const hb = _readHashBuilding();
        if (hb && hb !== _selectedBuildingId) {
            window.openBuildingConsole(hb);
        } else if (!hb && _selectedBuildingId) {
            _closeBuildingConsole();
        }
    };
    window.addEventListener('hashchange', _apply);
    // Cold-load: defer the first read until allReports has loaded so
    // the per-report context (used by the console's nested rendering)
    // is available. _loadReports calls renderFeed at the end; we hook
    // into the polling loop instead.
    setTimeout(_apply, 800);
}

// ──────────────────────────────────────────────────────────────────────
// Phase H.2 - Building state actions + timeline
// ──────────────────────────────────────────────────────────────────────
// Allowed transitions mirror the backend's state machine. UI only
// shows buttons for legal transitions from the current state.
const _BUILDING_STATE_TRANSITIONS = {
    ACTIVE:      ['MONITORED', 'ESCALATED', 'FALSE_ALARM', 'RESOLVED'],
    MONITORED:   ['RESPONDING', 'ESCALATED', 'FALSE_ALARM', 'RESOLVED', 'ACTIVE'],
    RESPONDING:  ['RESOLVED', 'ESCALATED', 'FALSE_ALARM'],
    ESCALATED:   ['RESPONDING', 'RESOLVED', 'FALSE_ALARM'],
    RESOLVED:    ['ACTIVE', 'ARCHIVED'],
    ARCHIVED:    ['ACTIVE'],
    FALSE_ALARM: ['ACTIVE', 'ARCHIVED'],
};

const _STATE_ACTION_LABEL = {
    ACTIVE:      'Re-open',
    MONITORED:   'Monitor',
    RESPONDING:  'Mark responding',
    ESCALATED:   'Escalate',
    RESOLVED:    'Mark resolved',
    ARCHIVED:    'Archive',
    FALSE_ALARM: 'False alarm',
};

const _STATE_ACTION_ICON = {
    ACTIVE:      'fa-arrow-rotate-left',
    MONITORED:   'fa-binoculars',
    RESPONDING:  'fa-truck-medical',
    ESCALATED:   'fa-fire-flame-curved',
    RESOLVED:    'fa-check',
    ARCHIVED:    'fa-box-archive',
    FALSE_ALARM: 'fa-ban',
};

function _renderBuildingStateActions(b) {
    // Phase J.3 (May 2026) - State dropdown replaces 1-5 stacked
    // state buttons. Same data driver (_BUILDING_STATE_TRANSITIONS);
    // only the visual surface collapses. Reduces Building Console
    // header from 8 always-visible action buttons to 2.
    const targets = _BUILDING_STATE_TRANSITIONS[b.state] || [];
    if (targets.length === 0) {
        return `<span class="bc-action-placeholder">No transitions available from ${b.state}</span>`;
    }
    return `
        <div class="bc-state-dropdown" id="bc-state-dropdown-${escapeHtml(b.id)}">
            <button class="bc-state-trigger"
                    onclick="event.stopPropagation();this.parentElement.classList.toggle('open')"
                    title="Change building state">
                <i class="fa-solid fa-arrow-right-arrow-left"></i>
                <span>Change state</span>
                <i class="fa-solid fa-caret-down" style="font-size:9px;opacity:0.6;margin-left:4px;"></i>
            </button>
            <div class="bc-state-menu">
                ${targets.map(to => `
                    <button class="bc-state-menu-item bc-state-menu-item-${to}"
                            onclick="_changeBuildingState('${b.id}', '${to}');this.closest('.bc-state-dropdown').classList.remove('open')">
                        <i class="fa-solid ${_STATE_ACTION_ICON[to] || 'fa-arrow-right'}"></i>
                        <div class="bc-state-menu-text">
                            <span class="bc-state-menu-title">${escapeHtml(_STATE_ACTION_LABEL[to] || to)}</span>
                            <span class="bc-state-menu-sub">${escapeHtml(_STATE_ACTION_SUB[to] || '')}</span>
                        </div>
                    </button>
                `).join('')}
            </div>
        </div>
    `;
}

// Friendly subtitles for the state-menu items so the operator
// understands what each transition means without reading docs.
const _STATE_ACTION_SUB = {
    ACTIVE:      'Re-open for tracking',
    MONITORED:   'Watch without dispatching',
    RESPONDING:  'Responder en route or on-site',
    ESCALATED:   'Raise priority above scoring',
    RESOLVED:    'All reports handled',
    ARCHIVED:    'Move out of active queue',
    FALSE_ALARM: 'Mark as misinformation',
};

// Phase J.3 (May 2026) - Reason-prompt modal (replaces native prompt()).
// Resolves with the entered text (string), an empty string if the
// operator submitted blank, or `false` if they cancelled.
function _promptReasonModal({ title, hint, toState }) {
    return new Promise((resolve) => {
        // Build the modal element. Remove any existing reason modal
        // so multiple rapid state-change clicks don't stack overlays.
        document.querySelectorAll('.bc-reason-modal-overlay').forEach(el => el.remove());

        const overlay = document.createElement('div');
        overlay.className = 'bc-reason-modal-overlay';
        const accent = (toState === 'ESCALATED') ? '#f87171' : '#94a3b8';
        const icon = (toState === 'ESCALATED') ? 'fa-fire-flame-curved' : 'fa-ban';

        overlay.innerHTML = `
            <div class="bc-reason-modal" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
                <div class="bc-reason-modal-head">
                    <i class="fa-solid ${icon}" style="color:${accent};"></i>
                    <h3>${escapeHtml(title)}</h3>
                </div>
                <p class="bc-reason-modal-hint">${escapeHtml(hint)}</p>
                <textarea class="bc-reason-modal-input"
                          placeholder="Optional reason / notes…"
                          rows="3" maxlength="500" autofocus></textarea>
                <div class="bc-reason-modal-actions">
                    <button class="bc-reason-modal-cancel">Cancel</button>
                    <button class="bc-reason-modal-submit"
                            style="background:${accent}22;color:${accent};border-color:${accent}66;">
                        ${escapeHtml(title)}
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const ta = overlay.querySelector('.bc-reason-modal-input');
        const cancelBtn = overlay.querySelector('.bc-reason-modal-cancel');
        const submitBtn = overlay.querySelector('.bc-reason-modal-submit');
        setTimeout(() => ta && ta.focus(), 30);

        const close = (result) => {
            document.removeEventListener('keydown', keyHandler);
            overlay.classList.add('is-closing');
            setTimeout(() => overlay.remove(), 180);
            resolve(result);
        };
        const keyHandler = (ev) => {
            if (ev.key === 'Escape') close(false);
            if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
                close((ta.value || '').trim());
            }
        };
        document.addEventListener('keydown', keyHandler);
        cancelBtn.addEventListener('click', () => close(false));
        submitBtn.addEventListener('click', () => close((ta.value || '').trim()));
        overlay.addEventListener('click', (ev) => {
            if (ev.target === overlay) close(false);  // click backdrop = cancel
        });
    });
}

// Auth header builder - mirrors the pattern used by other authenticated
// fetches in this file (decoded JWT from localStorage).
function _authHeaders() {
    const t = (function () {
        try { return localStorage.getItem('crisp_token'); }
        catch (_) { return null; }
    })();
    return t ? { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' }
             : { 'Content-Type': 'application/json' };
}

window._changeBuildingState = async (buildingId, toState) => {
    // Phase J.3 (May 2026) - Reason modal replaces the ugly native
    // prompt() for ESCALATED + FALSE_ALARM transitions. Native
    // prompt() reads as "enterprise" against the calmer J.2 / J.3
    // surface; the modal matches the dashboard's design language.
    // For non-weight-bearing transitions (Monitored, Re-open, etc.)
    // we still skip the reason - those are one-click actions.
    let reason = null;
    if (toState === 'ESCALATED' || toState === 'FALSE_ALARM') {
        const action = toState === 'ESCALATED' ? 'Escalate' : 'Mark as false alarm';
        const hint = toState === 'ESCALATED'
            ? 'Why does this building need elevated priority? (optional but useful for the audit trail)'
            : 'Why are you marking this as misinformation? (optional but useful for the audit trail)';
        reason = await _promptReasonModal({ title: action, hint, toState });
        if (reason === false) return;  // operator cancelled
    }
    try {
        // Pick the convenience endpoint where one exists, otherwise
        // hit the generic /state endpoint.
        let url, body;
        if (toState === 'ESCALATED') {
            url = `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/escalate`;
            body = { to_state: 'ESCALATED', reason: reason || undefined };
        } else if (toState === 'FALSE_ALARM') {
            url = `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/false-alarm`;
            body = { to_state: 'FALSE_ALARM', reason: reason || undefined };
        } else {
            url = `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/state`;
            body = { to_state: toState, reason: reason || undefined };
        }
        const res = await fetch(url, {
            method: 'POST',
            headers: _authHeaders(),
            body: JSON.stringify(body),
        });
        if (res.status === 401 || res.status === 403) {
            showToast('You need analyst permissions to change a building\'s state.', 'error');
            return;
        }
        if (res.status === 409) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || 'Transition not allowed', 'error');
            return;
        }
        if (!res.ok) {
            const err = await res.text();
            showToast(`State change failed: ${err.slice(0, 80)}`, 'error');
            return;
        }
        showToast(`Building state → ${toState}`, 'success');
        // Invalidate console cache + re-render. The /state endpoint
        // returns the updated summary; for the console refresh we
        // also need the nested reports + satellite + timeline so
        // we re-fetch the full detail.
        delete _buildingConsoleCache[buildingId];
        const detail = await _fetchBuildingDetail(buildingId);
        if (detail) _renderBuildingConsole(_opScopeBuilding(detail));
    } catch (e) {
        showToast(`Network error: ${e.message}`, 'error');
    }
};

// ─── Building as a first-class operational entity (Jun 2026) ──────────────────
// Assessment card + workspace + cascade Actions, mirroring the incident-level
// Details/Assessment/Actions. Reuses _credBandMeta / withBusy / _authHeaders /
// _opScopeBuilding / _fetchBuildingDetail / _crispActionModal. NO incident-level
// function is modified - they are only called.
window.__bldgAssessCache = window.__bldgAssessCache || {};
window.__bldgAssessRunning = null;

// Jun 2026 — the building console shows ONE consolidated Building RISK score using the
// EXACT incident `.dp-assess` card + breakdown UX. The snapshot is the server `risk`
// block (score/band/assessed/factors/coverage) + per-incident + recommendation.
function _bldgAssessSnap(b) {
    const a = (b && b.assessment) || null;
    if (a && a.risk && (a.risk.score != null || a.risk.assessed)) {
        const snap = Object.assign({}, a.risk, {
            incidents: a.incidents || [], recommendation: a.recommendation,
            assessed_at: a.assessed_at, counts: a.counts || {},
        });
        window.__bldgAssessCache[b.id] = snap;
        return snap;
    }
    return (b && window.__bldgAssessCache[b.id]) || null;
}
// Risk bands — HIGH = URGENT (colours INVERT vs the incident confidence score, where
// high = green/good). Reuses the same --cred-color card/modal mechanism.
function _buildingRiskMeta(band) {
    const M = {
        CRITICAL:   { word: 'Critical priority', color: '#ef4444' },
        HIGH:       { word: 'High priority',     color: '#f97316' },
        MODERATE:   { word: 'Moderate',          color: '#eab308' },
        LOW:        { word: 'Low priority',      color: '#22c55e' },
        MINIMAL:    { word: 'Minimal',           color: '#64748b' },
        UNASSESSED: { word: 'Not yet assessed',  color: '#64748b' },
    };
    const m = M[band] || M.UNASSESSED;
    return { cls: (band || 'unassessed').toLowerCase(), word: m.word, color: m.color };
}
function _riskFactorChips(factors) {
    const short = { severity: 'Severity', incidents: 'Incidents', corroboration: 'Corroboration',
                    evidence: 'Evidence', recency: 'Recency' };
    return (factors || []).map(f => {
        const ok = f.ran && f.awarded > 0;
        const cls = ok ? 'ok' : (f.ran ? 'neutral' : 'off');
        const icon = ok ? 'fa-circle-check' : (f.ran ? 'fa-circle' : 'fa-circle-xmark');
        return `<span class="dp-contrib dp-contrib-${cls}"><i class="fa-solid ${icon}"></i> ${escapeHtml(short[f.key] || f.label)}</span>`;
    }).join('');
}
function _bldgAssessedAtLabel(snap) {
    try { return snap && snap.assessed_at ? ('Last assessed ' + timeAgo(snap.assessed_at)) : ''; }
    catch (_e) { return ''; }
}

function _renderBuildingAssessmentCard(b) {
    const snap = _bldgAssessSnap(b);
    // CTA state — mirrors the incident `.dp-assess-cta-state`.
    if (!snap || !snap.assessed) {
        return `<section class="dp-section dp-assess dp-assess-cta-state bc-risk-card">
            <div class="dp-assess-cta-head">
                <i class="fa-solid fa-gauge-high dp-assess-cta-icon"></i>
                <div><div class="dp-assess-title">Building Risk Score</div>
                <div class="dp-assess-cta-sub">Consolidate this building's incidents into ONE act-first risk score (0–100).</div></div>
            </div>
            <button class="dp-assess-cta" onclick="runBuildingAssessment('${b.id}')"><i class="fa-solid fa-wand-magic-sparkles"></i> Run Building Assessment</button>
            <div class="dp-assess-cta-note">Fuses severity &amp; damage, the per-incident credibility, corroboration, evidence and recency. High score = urgent. Analyst decisions never change the number.</div>
        </section>`;
    }
    // Scored state — mirrors the incident `.dp-assess-scored` (high = urgent / red).
    const meta = _buildingRiskMeta(snap.band);
    const sev = b && (b.severity_max || b.severity);
    const sevChip = sev ? `<span class="dp-assess-sevchip sev-${String(sev).toLowerCase()}">${escapeHtml(String(sev))}</span>` : '';
    const at = _bldgAssessedAtLabel(snap);
    const rec = snap.recommendation ? escapeHtml(snap.recommendation) : '';
    return `<section class="dp-section dp-assess dp-assess-scored bc-risk-${meta.cls}" style="--cred-color:${meta.color};">
        <div class="dp-assess-scorerow" role="button" tabindex="0" aria-label="Open the Building Risk Score breakdown"
             onclick="_showBuildingAssessmentModal('${b.id}')"
             onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();_showBuildingAssessmentModal('${b.id}')}">
            <div class="dp-assess-dial"><span class="dp-assess-num">${snap.score}</span><span class="dp-assess-den">/100</span></div>
            <div class="dp-assess-meta">
                <div class="dp-assess-title">Building Risk Score <span class="dp-assess-band">${meta.word}</span>${sevChip}</div>
                <div class="dp-assess-contribs">${_riskFactorChips(snap.factors)}</div>
                <div class="dp-assess-presence">${rec ? rec + ' · ' : ''}${at ? escapeHtml(at) : ((snap.coverage && snap.coverage.total || 0) + ' incident(s)')} <span class="dp-assess-link">View breakdown <i class="fa-solid fa-arrow-right"></i></span></div>
            </div>
        </div>
        <div class="bc-risk-actions">
          <button onclick="runBuildingAssessment('${b.id}', true)"><i class="fa-solid fa-rotate"></i> Re-run</button>
          <button onclick="_downloadBuildingAssessmentPdf('${b.id}')"><i class="fa-regular fa-file-pdf"></i> Report</button>
        </div>
    </section>`;
}

window.runBuildingAssessment = async (buildingId, force) => {
    if (window.__bldgAssessRunning === buildingId) return;
    window.__bldgAssessRunning = buildingId;
    const btn = document.querySelector('.bc-assess-cta, .bc-assess-rerun');
    const run = async () => {
        showToast('Assessing building incidents… this can take a few seconds', 'info');
        try {
            const res = await fetch(`${BUILDINGS_API}/${encodeURIComponent(buildingId)}/assess${force ? '?force=true' : ''}`,
                { method: 'POST', headers: _authHeaders() });
            if (res.status === 401 || res.status === 403) { showToast('Analyst permission required.', 'error'); return; }
            if (res.status === 503) { showToast('AI assessment is not configured on this server.', 'error'); return; }
            if (!res.ok) { showToast('Assessment failed: ' + (await res.text()).slice(0, 80), 'error'); return; }
            const data = await res.json();
            const rk = data.risk || {};
            window.__bldgAssessCache[buildingId] = Object.assign({}, rk, {
                incidents: data.incidents, counts: data.counts,
                recommendation: data.recommendation, assessed_at: data.assessed_at,
            });
            showToast(`Building Risk ${rk.score == null ? '—' : rk.score + '/100 · ' + _buildingRiskMeta(rk.band).word} · ${data.counts.assessed} assessed, ${data.counts.cached} cached`, 'success');
            delete _buildingConsoleCache[buildingId];
            const detail = await _fetchBuildingDetail(buildingId);
            if (detail) _renderBuildingConsole(_opScopeBuilding(detail));
            if (document.getElementById('bldg-assess-modal')) _showBuildingAssessmentModal(buildingId);
        } catch (e) { showToast('Network error: ' + e.message, 'error'); }
    };
    try { if (btn) { await withBusy(btn, run); } else { await run(); } }
    finally { window.__bldgAssessRunning = null; }
};

window._showBuildingAssessmentModal = (buildingId) => {
    const b = _buildingConsoleCache[buildingId];
    const snap = (b && _bldgAssessSnap(b)) || window.__bldgAssessCache[buildingId];
    if (!snap || !snap.assessed) { showToast('Run the building assessment first.', 'info'); return; }
    const meta = _buildingRiskMeta(snap.band);
    const factors = snap.factors || [];
    const incs = snap.incidents || [];

    // Section 1 — score composition (the 5 risk factors + the equation). Identical
    // markup/states to the incident breakdown (`.assess-factor-*`).
    const rowHtml = factors.map(f => {
        const pct = (f.ran && f.max) ? Math.max(2, Math.round((f.awarded / f.max) * 100)) : 0;
        const state = !f.ran ? 'skip' : (f.awarded >= f.max * 0.7 ? 'strong' : f.awarded > 0 ? 'partial' : 'none');
        return `<div class="assess-factor assess-factor-${state}">
            <div class="assess-factor-top">
                <span class="assess-factor-label">${escapeHtml(f.label)}</span>
                <span class="assess-factor-pts">${f.ran ? `+${f.awarded}` : '<i class="fa-solid fa-minus"></i>'}<span class="assess-factor-max"> / ${f.max}</span></span>
            </div>
            <div class="assess-factor-bar"><span style="width:${pct}%;"></span></div>
            <div class="assess-factor-reason">${escapeHtml(f.reason || '')}</div>
        </div>`;
    }).join('');
    const eqTerms = factors.filter(f => f.ran && f.awarded > 0).map(f => `<span class="assess-eq-term">+${f.awarded}</span>`).join('');
    const eqHtml = `<div class="assess-eq"><div class="assess-eq-row">${eqTerms || '<span class="assess-eq-term">+0</span>'}<span class="assess-eq-eq">=</span><span class="assess-eq-total">${snap.score}</span><span class="assess-eq-den">/ 100</span></div></div>`;

    // Section 2 — the CONTRIBUTING incidents (the key inputs), each opens its incident.
    const incRows = incs.map(p => {
        const m = _credBandMeta(p.band);
        const sc = p.score == null ? 'Unrated' : `${p.score} <small>${m.word}</small>`;
        const open = p.incident_id ? `window.openIncidentDetail&&window.openIncidentDetail('${p.incident_id}')`
            : (p.report_id ? `window.selectReport&&window.selectReport('${p.report_id}')` : '');
        return `<button class="bldg-inc-row" ${open ? `onclick="const o=document.getElementById('bldg-assess-modal');if(o)o.remove();${open}"` : ''} style="--cred-color:${m.color}">
            <span class="bldg-inc-sev sev-${String(p.severity || '').toLowerCase()}"></span>
            <span class="bldg-inc-title">${escapeHtml(p.title || 'Incident')}${p.cached ? ' <span class="bldg-inc-cached">cached</span>' : ''}</span>
            <span class="bldg-inc-conf" style="color:${m.color}">${sc}</span>
            <i class="fa-solid fa-chevron-right"></i></button>`;
    }).join('') || '<div class="bc-empty">No non-duplicate incidents in this building.</div>';

    const _f = (k) => factors.find(x => x.key === k) || {};
    const cov = snap.coverage || {};
    const at = _bldgAssessedAtLabel(snap);
    const _section = (key, icon, title, body, sub) =>
        `<details class="assess-sec" ${key === 'composition' || key === 'incidents' ? 'open' : ''}>
            <summary class="assess-sec-head"><i class="fa-solid ${icon}"></i> <span>${title}</span>${sub ? `<span class="assess-sec-sub">${sub}</span>` : ''}<i class="fa-solid fa-chevron-down assess-sec-caret"></i></summary>
            <div class="assess-sec-body">${body}</div>
        </details>`;

    const prev = document.getElementById('bldg-assess-modal');
    if (prev) prev.remove();
    const ov = document.createElement('div');
    ov.id = 'bldg-assess-modal';
    ov.className = 'assess-modal-overlay';
    ov.onclick = (e) => { if (e.target === ov) ov.remove(); };
    const onKey = (e) => { const o = document.getElementById('bldg-assess-modal'); if (!o) { document.removeEventListener('keydown', onKey); return; } if (e.key === 'Escape') { o.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    ov.innerHTML = `<div class="assess-modal assess-workspace" role="dialog" aria-modal="true" aria-label="Building Risk Score breakdown" style="--cred-color:${meta.color};">
        <div class="assess-head">
            <div class="assess-head-dial"><span class="assess-head-num">${snap.score}</span><span class="assess-head-den">/100</span></div>
            <div class="assess-head-meta">
                <div class="assess-head-title">Building Risk Score</div>
                <div class="assess-head-band">${meta.word} · ${cov.assessed || 0} of ${cov.total || 0} incidents assessed${at ? ' · ' + escapeHtml(at) : ''}</div>
            </div>
            <button class="assess-rerun-top" onclick="runBuildingAssessment('${buildingId}', true)" title="Re-run"><i class="fa-solid fa-rotate"></i> Re-run</button>
            <button class="assess-close" aria-label="Close" onclick="const o=document.getElementById('bldg-assess-modal');if(o)o.remove();"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="assess-intro">How urgently to act on this building — its constituent incidents fused with severity, corroboration, evidence and recency. Automated only; an analyst's verdict never changes the number.</div>
        <div class="assess-body">
            ${_section('composition', 'fa-calculator', 'Score composition', `<div class="assess-factors">${rowHtml}</div>${eqHtml}`)}
            ${_section('incidents', 'fa-triangle-exclamation', 'Contributing incidents', `<div class="bldg-inc-list">${incRows}</div>`, incs.length ? `${incs.length}` : '')}
            ${_section('evidence', 'fa-clipboard-check', 'Evidence & corroboration', `<div class="assess-factor-reason">${escapeHtml(_f('corroboration').reason || '')}</div><div class="assess-factor-reason">${escapeHtml(_f('evidence').reason || '')}</div><div class="assess-factor-reason">${escapeHtml(_f('recency').reason || '')}</div>`)}
            ${_section('reasoning', 'fa-lightbulb', 'Recommended action', `<div class="bldg-rec">${escapeHtml(snap.recommendation || '—')}</div><div class="assess-factor-reason">Strongest signals: ${(snap.reasons || []).map(escapeHtml).join(' · ') || '—'}</div>`)}
        </div>
        <div class="assess-method">
            <div class="assess-method-h"><i class="fa-solid fa-circle-info"></i> How this is calculated</div>
            <p>The Building Risk Score is the sum of independent weighted factors: <strong>Severity &amp; damage 30</strong> · <strong>Incident assessments 25</strong> · <strong>Corroboration &amp; volume 20</strong> · <strong>Evidence verification 15</strong> · <strong>Recency &amp; escalation 10</strong> = 100.</p>
            <p>It fuses the constituent <strong>incident Confidence Scores</strong> (the key inputs) with the building's severity, corroboration, evidence and recency into ONE act-first priority. <strong>High = urgent</strong> (the inverse of the incident Confidence Score, where high = trustworthy). The breakdown shows every contribution — nothing is hidden.</p>
        </div>
    </div>`;
    document.body.appendChild(ov);
};

window._downloadBuildingAssessmentPdf = async (buildingId) => {
    try {
        const res = await fetch(`${BUILDINGS_API}/${encodeURIComponent(buildingId)}/assessment.pdf`, { headers: _authHeaders() });
        if (res.status === 404) { showToast('Run the building assessment first.', 'info'); return; }
        if (!res.ok) { showToast('Report download failed.', 'error'); return; }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `building-assessment-${buildingId.replace(/[^a-z0-9]+/gi, '_').slice(0, 24)}.pdf`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { showToast('Network error: ' + e.message, 'error'); }
};

// Cascade Actions group (state-machine, mirrors the incident .dp-actions).
function _renderBuildingActions(b) {
    const st = b.state;
    const banner = (cls, txt) => `<div class="dp-act-banner dp-act-banner-${cls}">${txt}</div>`;
    const reopen = `<button class="dp-act-2 dp-act-revert" onclick="buildingReopen('${b.id}')"><i class="fa-solid fa-rotate-left"></i> Reopen building</button>`;
    if (st === 'RESOLVED') return `<div class="bc-act-group">${banner('resolved', 'Building resolved')}${reopen}</div>`;
    if (st === 'FALSE_ALARM') return `<div class="bc-act-group">${banner('false', 'Marked false alarm')}${reopen}</div>`;
    if (st === 'RESPONDING') return `<div class="bc-act-group">${banner('responding', 'Response team notified')}
        <button class="dp-act-primary" onclick="buildingResolve('${b.id}')"><i class="fa-solid fa-circle-check"></i> Resolve building</button>
        <div class="dp-act-row"><button class="dp-act-2 dp-act-false" onclick="buildingFalseAlarm('${b.id}')">False Alarm</button>${reopen}</div></div>`;
    return `<div class="bc-act-group">
        <button class="dp-act-primary" onclick="buildingNotify('${b.id}')"><i class="fa-solid fa-tower-broadcast"></i> Notify Response Team</button>
        <div class="dp-act-row"><button class="dp-act-2 dp-act-reject" onclick="buildingReject('${b.id}')">Reject</button>
        <button class="dp-act-2 dp-act-false" onclick="buildingFalseAlarm('${b.id}')">False Alarm</button></div></div>`;
}

async function _applyBuildingStatePatch(buildingId, action, body, okMsg) {
    try {
        const res = await fetch(`${BUILDINGS_API}/${encodeURIComponent(buildingId)}/cascade/${action}`,
            { method: 'POST', headers: _authHeaders(), body: JSON.stringify(body || {}) });
        if (res.status === 401 || res.status === 403) { showToast('Analyst permission required.', 'error'); return false; }
        if (res.status === 400) { showToast(((await res.json().catch(() => ({}))).detail) || 'A reason is required.', 'error'); return false; }
        if (!res.ok) { showToast('Action failed: ' + (await res.text()).slice(0, 80), 'error'); return false; }
        const data = await res.json();
        const cc = data.counts || {};
        showToast(`${okMsg} · ${cc.incidents_changed || 0} incident(s), ${cc.reports_changed || 0} report(s)`, 'success');
        delete _buildingConsoleCache[buildingId];
        const detail = await _fetchBuildingDetail(buildingId);
        if (detail) _renderBuildingConsole(_opScopeBuilding(detail));
        try { renderFeed(); } catch (_e) {}   // cascaded incident statuses repaint in the feed
        return true;
    } catch (e) { showToast('Network error: ' + e.message, 'error'); return false; }
}

function _bldgOpenCount(buildingId) {
    const b = _buildingConsoleCache[buildingId];
    return b ? (b.reports || []).filter(r => ['PENDING', 'VERIFIED', 'RESPONDING'].includes(String(r.status))).length : 0;
}

window.buildingResolve = (id) => _crispActionModal({
    title: 'Resolve building', icon: 'fa-circle-check', confirmLabel: 'Resolve building', confirmTone: 'primary',
    bodyHtml: `<p class="crisp-action-msg">This marks the building <strong>Resolved</strong> and resolves all ${_bldgOpenCount(id)} open incident(s) in it. Reversible via Reopen.</p>`,
    onConfirm: (ov, close) => { close(); _applyBuildingStatePatch(id, 'resolve', {}, 'Building resolved'); },
});
window.buildingNotify = (id) => _crispActionModal({
    title: 'Notify response team', icon: 'fa-tower-broadcast', confirmLabel: 'Notify', confirmTone: 'primary',
    bodyHtml: `<p class="crisp-action-msg">This notifies the response team and moves all ${_bldgOpenCount(id)} open incident(s) to <strong>Responding</strong>.</p>`,
    onConfirm: (ov, close) => { close(); _applyBuildingStatePatch(id, 'notify', {}, 'Response team notified'); },
});
window.buildingFalseAlarm = (id) => _crispActionModal({
    title: 'Mark building false alarm', icon: 'fa-flag', tone: 'warn', confirmLabel: 'Mark false alarm', confirmTone: 'warn',
    bodyHtml: `<p class="crisp-action-msg">This marks the building + its ${_bldgOpenCount(id)} open incident(s) as a <strong>false alarm</strong>. Reversible via Reopen.</p>
        <label class="crisp-action-label">Reason <span class="crisp-req">*</span></label>
        <textarea class="crisp-action-reason" id="crisp-bldg-fa-reason" rows="3" placeholder="Why is this misinformation?"></textarea>`,
    onConfirm: (ov, close) => {
        const ta = ov.querySelector('#crisp-bldg-fa-reason'); const reason = (ta.value || '').trim();
        if (!reason) { ta.classList.add('crisp-action-invalid'); ta.focus(); showToast('Reason required', 'error'); return; }
        close(); _applyBuildingStatePatch(id, 'false-alarm', { reason }, 'Marked false alarm');
    },
});
window.buildingReject = (id) => _crispActionModal({
    title: 'Reject building', icon: 'fa-ban', tone: 'danger', confirmLabel: 'Reject all reports', confirmTone: 'danger',
    bodyHtml: `<p class="crisp-action-msg crisp-action-msg-danger">This cascades verdict <strong>REJECTED</strong> to ALL reports in this building - they leave the active feed and exports. Reversible per report.</p>
        <label class="crisp-action-label">Reason <span class="crisp-req">*</span></label>
        <textarea class="crisp-action-reason" id="crisp-bldg-rej-reason" rows="3" placeholder="Why reject this building's reports?"></textarea>`,
    onConfirm: (ov, close) => {
        const ta = ov.querySelector('#crisp-bldg-rej-reason'); const reason = (ta.value || '').trim();
        if (!reason) { ta.classList.add('crisp-action-invalid'); ta.focus(); showToast('Reason required', 'error'); return; }
        close(); _applyBuildingStatePatch(id, 'reject', { reason }, 'Building rejected');
    },
});
window.buildingReopen = (id) => _crispActionModal({
    title: 'Reopen building', icon: 'fa-rotate-left', confirmLabel: 'Reopen', confirmTone: 'primary',
    bodyHtml: `<p class="crisp-action-msg">This reopens the building and its incidents back to active/pending.</p>`,
    onConfirm: (ov, close) => { close(); _applyBuildingStatePatch(id, 'reopen', {}, 'Building reopened'); },
});

window._refreshBuildingTimeline = async (buildingId) => {
    const el = document.getElementById(`bc-timeline-${buildingId}`);
    const lifeEl = document.getElementById(`bc-lifecycle-${buildingId}`);
    if (!el && !lifeEl) return;
    try {
        const res = await fetch(
            `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/timeline?limit=50`,
            { headers: _authHeaders() }
        );
        if (!res.ok) {
            if (el) el.innerHTML = '<div class="bc-empty">Could not load timeline.</div>';
            if (lifeEl) lifeEl.innerHTML = '';
            return;
        }
        const events = await res.json();
        // Always render the horizontal lifecycle stepper, even when
        // the vertical timeline below is empty - the stepper has
        // useful nodes from the building roll-up even with 0 events.
        if (lifeEl) {
            const detail = _buildingConsoleCache[buildingId] || null;
            lifeEl.innerHTML = _renderBuildingLifecycleStepper(events, detail);
        }
        if (!events.length) {
            if (el) el.innerHTML = '<div class="bc-empty">No events yet for this building.</div>';
            return;
        }
        el.innerHTML = events.map(e => {
            const kind = e.event_kind || 'UNKNOWN';
            const payload = e.payload || {};
            // Friendly label per event kind.
            let body = kind;
            if (kind === 'STATE_CHANGED') {
                body = `State: ${escapeHtml(payload.from_state || '?')} → <strong>${escapeHtml(payload.to_state || '?')}</strong>`;
                if (payload.reason) body += ` - <em>${escapeHtml(payload.reason)}</em>`;
            } else if (kind === 'ESCALATED') {
                body = `Operator escalated${payload.reason ? ' - <em>' + escapeHtml(payload.reason) + '</em>' : ''}`;
            } else if (kind === 'FALSE_ALARM_DECLARED') {
                body = `Marked as misinformation${payload.reason ? ' - <em>' + escapeHtml(payload.reason) + '</em>' : ''}`;
            } else if (kind === 'REPORT_LINKED') {
                body = `Report linked${payload.report_id ? ' (' + escapeHtml(String(payload.report_id).slice(0, 8)) + ')' : ''}`;
            } else if (kind === 'NOTE_ADDED') {
                body = 'Operator note added' + (payload.pinned ? ' (pinned)' : '');
                if (payload.preview) body += ` - <em>${escapeHtml(payload.preview)}…</em>`;
            } else if (kind === 'NOTE_EDITED') {
                body = 'Operator note edited';
            } else if (kind === 'NOTE_DELETED') {
                body = 'Operator note deleted';
            } else if (kind === 'DOSSIER_EXPORTED') {
                const fmt = payload.format || 'file';
                body = `Dossier exported (${escapeHtml(fmt)})`;
            }
            const iconByKind = {
                STATE_CHANGED:        'fa-arrow-right-arrow-left',
                ESCALATED:            'fa-fire-flame-curved',
                FALSE_ALARM_DECLARED: 'fa-ban',
                REPORT_LINKED:        'fa-link',
                MONITOR_STARTED:      'fa-binoculars',
                MONITOR_CLEARED:      'fa-eye-slash',
                NOTE_ADDED:           'fa-note-sticky',
                NOTE_EDITED:          'fa-pen',
                NOTE_DELETED:         'fa-trash-can',
                AI_SUMMARY_GENERATED: 'fa-robot',
                SATELLITE_VERIFIED:   'fa-satellite',
                RESPONDER_ASSIGNED:   'fa-user-plus',
                RESPONDER_DISPATCHED: 'fa-truck-medical',
                RESPONDER_ARRIVED:    'fa-map-pin',
                RESPONDER_CLEARED:    'fa-circle-check',
                ARCHIVED:             'fa-box-archive',
                DOSSIER_EXPORTED:     'fa-file-export',
            };
            const icon = iconByKind[kind] || 'fa-circle';
            return `<div class="bc-tl-row">
                <span class="bc-tl-icon"><i class="fa-solid ${icon}"></i></span>
                <div class="bc-tl-body">
                    <div class="bc-tl-line">${body}</div>
                    <div class="bc-tl-ts">${escapeHtml(fmtDateTime(e.occurred_at))} · ${timeAgo(e.occurred_at)}</div>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        if (el) el.innerHTML = `<div class="bc-empty">Error: ${escapeHtml(e.message)}</div>`;
        const lifeEl2 = document.getElementById(`bc-lifecycle-${buildingId}`);
        if (lifeEl2) lifeEl2.innerHTML = '';
    }
};

// ──────────────────────────────────────────────────────────────────────
// Phase H.5+ (May 2026) - Horizontal lifecycle stepper
// ──────────────────────────────────────────────────────────────────────
// Operator feedback: "Below the top bar we should have a timeline
// view with 1st report → 2nd report → 3 reports → AI summary
// generated → Report downloaded (CSV) → Building Safe, X Lives saved."
//
// This is a CONDENSED visual stepper that picks the operationally
// significant milestones from the full BuildingEvent log (which
// stays available below as the vertical timeline). The full audit
// trail is below; this is the at-a-glance lifecycle.

function _renderBuildingLifecycleStepper(events, detail) {
    // Events come newest-first from the API; reverse for chronological
    // left-to-right rendering.
    const chrono = (events || []).slice().reverse();

    // Pick the milestone nodes from the event stream. Cap at 4 reports
    // so the stepper stays visually parseable; collapse the rest into a
    // single "+N reports" badge.
    const reportEvents = chrono.filter(e => e.event_kind === 'REPORT_LINKED');
    const reportNodes = reportEvents.slice(0, 4).map((e, idx) => ({
        kind: 'REPORT',
        icon: 'fa-flag',
        title: `Report ${idx + 1}`,
        subtitle: (e.payload && e.payload.report_id)
            ? String(e.payload.report_id).slice(0, 8)
            : '',
        at: e.occurred_at,
        color: '#fbbf24',
    }));
    const moreReports = Math.max(0, reportEvents.length - 4);
    const aiEvent = chrono.find(e => e.event_kind === 'AI_SUMMARY_GENERATED');
    const escEvent = chrono.find(e => e.event_kind === 'ESCALATED');
    const respAssigned = chrono.find(e => e.event_kind === 'RESPONDER_ASSIGNED');
    const respArrived = chrono.find(e => e.event_kind === 'RESPONDER_ARRIVED');
    const exportEvents = chrono.filter(e => e.event_kind === 'DOSSIER_EXPORTED');
    const lastExport = exportEvents[exportEvents.length - 1];

    // Terminal state - derived from detail.state + lives saved roll-up.
    const state = detail ? detail.state : null;
    const reports = (detail && detail.reports) || [];
    const livesSaved = reports
        .filter(r => r.status === 'RESOLVED')
        .reduce((sum, r) => sum + (Number(r.lives_impacted) || 0), 0);
    const allResolved =
        state === 'RESOLVED'
        || ((detail && detail.report_count > 0 && detail.resolved_report_count === detail.report_count));

    // Assemble the node list in operationally-meaningful order:
    //   reports → escalation/AI/responder → exports → terminal state
    const nodes = [];
    for (const n of reportNodes) nodes.push(n);
    if (moreReports > 0) {
        nodes.push({
            kind: 'MORE',
            icon: 'fa-ellipsis',
            title: `+${moreReports} reports`,
            subtitle: 'additional',
            at: null,
            color: '#94a3b8',
        });
    }
    if (escEvent) {
        nodes.push({
            kind: 'ESCALATED',
            icon: 'fa-fire-flame-curved',
            title: 'Escalated',
            subtitle: (escEvent.payload && escEvent.payload.reason) || '',
            at: escEvent.occurred_at,
            color: '#f87171',
        });
    }
    if (aiEvent) {
        nodes.push({
            kind: 'AI',
            icon: 'fa-robot',
            title: 'AI summary',
            subtitle: 'generated',
            at: aiEvent.occurred_at,
            color: '#c4b5fd',
        });
    }
    if (respAssigned) {
        nodes.push({
            kind: 'RESPONDER',
            icon: 'fa-user-plus',
            title: 'Responder',
            subtitle: 'assigned',
            at: respAssigned.occurred_at,
            color: '#a78bfa',
        });
    }
    if (respArrived) {
        nodes.push({
            kind: 'ON_SITE',
            icon: 'fa-map-pin',
            title: 'On-site',
            subtitle: 'team arrived',
            at: respArrived.occurred_at,
            color: '#38bdf8',
        });
    }
    if (lastExport) {
        const fmt = (lastExport.payload && lastExport.payload.format) || 'file';
        nodes.push({
            kind: 'EXPORT',
            icon: 'fa-file-export',
            title: `Exported (${fmt})`,
            subtitle: exportEvents.length > 1 ? `+${exportEvents.length - 1} prior` : '',
            at: lastExport.occurred_at,
            color: '#7dd3fc',
        });
    }
    // Terminal state node - always last.
    if (allResolved) {
        nodes.push({
            kind: 'RESOLVED',
            icon: 'fa-shield-heart',
            title: 'Building safe',
            subtitle: livesSaved ? `${livesSaved} ${livesSaved === 1 ? 'life' : 'lives'} saved` : 'resolved',
            at: null,
            color: '#4ade80',
            terminal: true,
        });
    } else if (state === 'FALSE_ALARM') {
        nodes.push({
            kind: 'FALSE_ALARM',
            icon: 'fa-ban',
            title: 'False alarm',
            subtitle: 'misinformation',
            at: null,
            color: '#94a3b8',
            terminal: true,
        });
    } else if (state === 'ARCHIVED') {
        nodes.push({
            kind: 'ARCHIVED',
            icon: 'fa-box-archive',
            title: 'Archived',
            subtitle: '',
            at: null,
            color: '#64748b',
            terminal: true,
        });
    } else {
        // Active situation - show the current state as the trailing node.
        nodes.push({
            kind: 'STATE',
            icon: 'fa-circle',
            title: state || 'Active',
            subtitle: 'current state',
            at: null,
            color: '#fbbf24',
            terminal: false,
            inProgress: true,
        });
    }

    if (!nodes.length) {
        return '<div class="bc-empty">Lifecycle will appear here as events accumulate.</div>';
    }

    return `
        <div class="bc-life-strip">
            ${nodes.map((n, i) => `
                <div class="bc-life-node ${n.terminal ? 'bc-life-node-terminal' : ''} ${n.inProgress ? 'bc-life-node-progress' : ''}"
                     title="${n.at ? fmtDateTime(n.at) : ''}">
                    <div class="bc-life-icon" style="border-color:${n.color}55;background:${n.color}1a;color:${n.color};">
                        <i class="fa-solid ${n.icon}"></i>
                    </div>
                    <div class="bc-life-text">
                        <div class="bc-life-title" style="color:${n.color};">${escapeHtml(n.title)}</div>
                        ${n.subtitle ? `<div class="bc-life-sub">${escapeHtml(n.subtitle)}</div>` : ''}
                        ${n.at ? `<div class="bc-life-when">${timeAgo(n.at)}</div>` : ''}
                    </div>
                </div>
                ${i < nodes.length - 1 ? `<div class="bc-life-arrow" aria-hidden="true">
                    <i class="fa-solid fa-arrow-right"></i>
                </div>` : ''}
            `).join('')}
        </div>
    `;
}

// ──────────────────────────────────────────────────────────────────────
// Phase H.3 - Responder coordination + watch list (dashboard surface)
// ──────────────────────────────────────────────────────────────────────
// Each Building can have N responders (BuildingResponder rows) with a
// lifecycle: ASSIGNED → DISPATCHED → ARRIVED → CLEARED. Operators
// advance the lifecycle from the console. Separately, any operator
// can put a building on their personal watch list (MonitorResponse).

function _renderBuildingAiCard(b) {
    const ai = b.ai_summary;
    const generatedAt = b.ai_summary_at;
    // Empty state (no cached summary yet).
    if (!ai || !ai.summary) {
        return `
            <div class="bc-ai-card bc-ai-card-empty">
                <div class="bc-ai-head">
                    <span class="bc-ai-title"><i class="fa-solid fa-robot"></i> AI building summary</span>
                    <button class="bc-ai-refresh-btn"
                            onclick="_refreshBuildingAiSummary('${b.id}')"
                            title="Generate an AI brief">
                        <i class="fa-solid fa-wand-magic-sparkles"></i>
                        <span>Generate</span>
                    </button>
                </div>
                <div class="bc-ai-empty-body">
                    No AI brief yet. Click <em>Generate</em> for a AI synthesis of
                    constituent reports, responder activity, and operator notes.
                </div>
            </div>
        `;
    }

    const findings = (ai.key_findings || []).map(f => `<li>${escapeHtml(f)}</li>`).join('');
    const conflicts = (ai.conflicting_signals || []).map(f => `<li>${escapeHtml(f)}</li>`).join('');

    // Phase H.9 - trend chips + responder-type badges.
    const trends = ai.trends || {};
    const trendIcon = {
        RISING:     { icon: 'fa-arrow-trend-up',   color: '#ef4444', label: 'Severity rising' },
        FALLING:    { icon: 'fa-arrow-trend-down', color: '#4ade80', label: 'Severity falling' },
        STABLE:     { icon: 'fa-equals',           color: '#94a3b8', label: 'Severity stable' },
        INCREASING: { icon: 'fa-chart-line',       color: '#f97316', label: 'Activity increasing' },
        DECREASING: { icon: 'fa-chart-line fa-flip-vertical', color: '#4ade80', label: 'Activity decreasing' },
    };
    const sevTrend = trendIcon[trends.severity_trend];
    const actTrend = trendIcon[trends.activity_trend];
    const responseStateChip = {
        NO_RESPONSE: { color: '#f87171', label: 'No response' },
        ASSESSING:   { color: '#fbbf24', label: 'Assessing' },
        ON_SITE:     { color: '#a78bfa', label: 'Responding on-site' },
        CLEARED:     { color: '#4ade80', label: 'Cleared' },
    }[trends.response_state];
    const trendChips = [
        sevTrend && trends.severity_trend !== 'UNKNOWN'
            ? `<span class="bc-ai-trend" style="color:${sevTrend.color};border-color:${sevTrend.color}55;background:${sevTrend.color}1a;"><i class="fa-solid ${sevTrend.icon}"></i> ${sevTrend.label}</span>` : '',
        actTrend && trends.activity_trend !== 'UNKNOWN'
            ? `<span class="bc-ai-trend" style="color:${actTrend.color};border-color:${actTrend.color}55;background:${actTrend.color}1a;"><i class="fa-solid ${actTrend.icon}"></i> ${actTrend.label}</span>` : '',
        responseStateChip
            ? `<span class="bc-ai-trend" style="color:${responseStateChip.color};border-color:${responseStateChip.color}55;background:${responseStateChip.color}1a;"><i class="fa-solid fa-circle"></i> ${responseStateChip.label}</span>` : '',
    ].filter(Boolean).join('');

    const typeBadgeMap = {
        MEDICAL:       { color: '#ef4444', icon: 'fa-kit-medical',     label: 'Medical' },
        FIRE:          { color: '#f97316', icon: 'fa-fire',            label: 'Fire' },
        SEARCH_RESCUE: { color: '#a78bfa', icon: 'fa-person-shelter',  label: 'Search & rescue' },
        ENGINEERING:   { color: '#7dd3fc', icon: 'fa-helmet-safety',   label: 'Engineering' },
        POLICE:        { color: '#60a5fa', icon: 'fa-shield-halved',   label: 'Police' },
        LOGISTICS:     { color: '#facc15', icon: 'fa-truck-fast',      label: 'Logistics' },
        EVACUATION:    { color: '#fb923c', icon: 'fa-route',           label: 'Evacuation' },
        ASSESSMENT:    { color: '#94a3b8', icon: 'fa-clipboard-check', label: 'Assessment' },
        STAND_DOWN:    { color: '#4ade80', icon: 'fa-circle-check',    label: 'Stand down' },
    };
    const recTypes = (ai.recommended_responder_types || [])
        .map(t => typeBadgeMap[t])
        .filter(Boolean)
        .map(b => `<span class="bc-ai-resp-badge" style="color:${b.color};border-color:${b.color}66;background:${b.color}1a;">
            <i class="fa-solid ${b.icon}"></i> ${b.label}
        </span>`).join('');

    return `
        <div class="bc-ai-card">
            <div class="bc-ai-head">
                <span class="bc-ai-title"><i class="fa-solid fa-robot"></i> AI building summary</span>
                <span class="bc-ai-meta">
                    ${escapeHtml(ai.model || 'model')} · ${generatedAt ? timeAgo(generatedAt) : ''}
                </span>
                <button class="bc-ai-refresh-btn"
                        onclick="_refreshBuildingAiSummary('${b.id}')"
                        title="Refresh AI summary (rate-limited to 5 min per building)">
                    <i class="fa-solid fa-arrows-rotate"></i>
                    <span>Refresh</span>
                </button>
            </div>
            ${trendChips ? `<div class="bc-ai-trends">${trendChips}</div>` : ''}
            <div class="bc-ai-summary">${escapeHtml(ai.summary)}</div>
            ${findings ? `
                <div class="bc-ai-section">
                    <div class="bc-ai-section-title">Key findings</div>
                    <ul class="bc-ai-list">${findings}</ul>
                </div>
            ` : ''}
            ${conflicts ? `
                <div class="bc-ai-section bc-ai-section-warn">
                    <div class="bc-ai-section-title"><i class="fa-solid fa-triangle-exclamation"></i> Conflicting signals</div>
                    <ul class="bc-ai-list">${conflicts}</ul>
                </div>
            ` : ''}
            ${ai.responder_recommendation ? `
                <div class="bc-ai-section bc-ai-section-rec">
                    <div class="bc-ai-section-title"><i class="fa-solid fa-truck-medical"></i> Responder recommendation</div>
                    ${recTypes ? `<div class="bc-ai-resp-badges">${recTypes}</div>` : ''}
                    <div class="bc-ai-rec">${escapeHtml(ai.responder_recommendation)}</div>
                </div>
            ` : ''}
        </div>
    `;
}

window._refreshBuildingAiSummary = async (buildingId) => {
    showToast('Generating AI summary… (up to 25 s)', 'info');
    try {
        const res = await fetch(
            `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/ai-summary`,
            { method: 'POST', headers: _authHeaders() }
        );
        if (res.status === 401 || res.status === 403) {
            showToast('Analyst role required.', 'error');
            return;
        }
        if (res.status === 429) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || 'Cooldown active. Try again in a few minutes.', 'error');
            return;
        }
        if (res.status === 503) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || 'AI summary service unavailable.', 'error');
            return;
        }
        if (!res.ok) {
            const err = await res.text();
            showToast(`Generate failed: ${err.slice(0, 80)}`, 'error');
            return;
        }
        showToast('AI summary ready', 'success');
        delete _buildingConsoleCache[buildingId];
        const detail = await _fetchBuildingDetail(buildingId);
        if (detail) _renderBuildingConsole(_opScopeBuilding(detail));
    } catch (e) {
        showToast(`Network error: ${e.message}`, 'error');
    }
};

function _renderBuildingExportMenu(b) {
    // A compact dropdown - Export → PDF / GeoJSON. The endpoints
    // are analyst-gated; auth headers can't be set on a plain <a
    // download>, so we fetch as blob + trigger a virtual anchor click.
    return `
        <div class="bc-export-wrap" style="position:relative;display:inline-flex;">
            <button class="bc-export-btn"
                    onclick="_toggleBuildingExportMenu('${b.id}')"
                    title="Export dossier">
                <i class="fa-solid fa-file-export"></i>
                <span>Export</span>
                <i class="fa-solid fa-caret-down" style="font-size:8px;opacity:0.7;"></i>
            </button>
            <div class="bc-export-menu" id="bc-export-menu-${escapeHtml(b.id)}" style="display:none;">
                <button class="bc-export-menu-item"
                        onclick="_downloadBuildingDossier('${b.id}', 'csv')">
                    <i class="fa-solid fa-file-csv"></i> CSV
                </button>
                <button class="bc-export-menu-item"
                        onclick="_downloadBuildingDossier('${b.id}', 'geojson')">
                    <i class="fa-solid fa-map"></i> GeoJSON
                </button>
                <button class="bc-export-menu-item"
                        onclick="_downloadBuildingDossier('${b.id}', 'pdf')">
                    <i class="fa-regular fa-file-pdf"></i> PDF dossier
                </button>
            </div>
        </div>
    `;
}

window._toggleBuildingExportMenu = (buildingId) => {
    const el = document.getElementById(`bc-export-menu-${buildingId}`);
    if (!el) return;
    const open = el.style.display !== 'none';
    // Hide any other open menus first.
    document.querySelectorAll('.bc-export-menu').forEach(m => { m.style.display = 'none'; });
    el.style.display = open ? 'none' : 'block';
    if (!open) {
        // Click-outside-to-close.
        setTimeout(() => {
            const closer = (ev) => {
                if (!el.contains(ev.target)) {
                    el.style.display = 'none';
                    document.removeEventListener('click', closer);
                }
            };
            document.addEventListener('click', closer);
        }, 50);
    }
};

window._downloadBuildingDossier = async (buildingId, fmt) => {
    const menu = document.getElementById(`bc-export-menu-${buildingId}`);
    if (menu) menu.style.display = 'none';
    const path = fmt === 'pdf'
        ? 'dossier.pdf'
        : fmt === 'csv'
            ? 'dossier.csv'
            : 'dossier.geojson';
    showToast(`Generating ${fmt.toUpperCase()} dossier…`, 'info');
    try {
        const res = await fetch(
            `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/${path}`,
            { headers: _authHeaders() }
        );
        if (res.status === 401 || res.status === 403) {
            showToast('Analyst role required.', 'error');
            return;
        }
        if (!res.ok) {
            const err = await res.text();
            showToast(`Export failed: ${err.slice(0, 80)}`, 'error');
            return;
        }
        // Filename: extract from Content-Disposition; fall back to a default.
        const disp = res.headers.get('content-disposition') || '';
        let fname = `building-${buildingId.replace(/[:\/]/g, '_')}.${fmt === 'pdf' ? 'pdf' : 'geojson'}`;
        const m = disp.match(/filename="?([^";]+)"?/);
        if (m) fname = m[1];
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fname;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast(`${fmt.toUpperCase()} dossier downloaded`, 'success');
    } catch (e) {
        showToast(`Network error: ${e.message}`, 'error');
    }
};

function _renderBuildingMonitorToggle(b) {
    // Am I currently watching this building? `monitors` is the list of
    // ACTIVE watches (cleared_at IS NULL). We look up by user id.
    const myId = _crispUser && _crispUser.id;
    const watching = !!(myId && (b.monitors || []).some(m => m.user_id === myId));
    const label = watching ? 'Watching' : 'Watch';
    const icon = watching ? 'fa-eye' : 'fa-eye-slash';
    const cls = watching
        ? 'bc-monitor-btn bc-monitor-btn-active'
        : 'bc-monitor-btn';
    return `
        <button class="${cls}"
                onclick="_toggleBuildingMonitor('${b.id}', ${watching ? 'true' : 'false'})"
                title="${watching ? 'Stop watching this building' : 'Add this building to your watch list'}">
            <i class="fa-solid ${icon}"></i>
            <span>${label}</span>
        </button>
    `;
}

function _renderResponderList(b) {
    const responders = b.responders || [];
    if (!responders.length) {
        return '<div class="bc-empty">No responders assigned yet. Click "Assign" to dispatch a team.</div>';
    }
    return responders.map(r => {
        // Lifecycle phase (visual badge).
        const phase = r.cleared_at      ? 'CLEARED'
                    : r.arrived_at      ? 'ON_SITE'
                    : r.dispatched_at   ? 'DISPATCHED'
                    : 'ASSIGNED';
        // Which lifecycle advances are still available?
        const canDispatch = !r.dispatched_at && !r.cleared_at;
        const canArrive   = !!r.dispatched_at && !r.arrived_at && !r.cleared_at;
        const canClear    = !r.cleared_at;
        // ETA chip only meaningful before arrival.
        const etaChip = (r.eta_minutes != null && !r.arrived_at && !r.cleared_at)
            ? `<span class="bc-r-eta"><i class="fa-regular fa-clock"></i> ETA ${r.eta_minutes}m</span>`
            : '';
        return `<div class="bc-responder">
            <span class="bc-r-phase bc-r-phase-${phase}">${phase.replace('_', '-')}</span>
            <div class="bc-responder-body">
                <div class="bc-responder-line1">
                    <strong>${escapeHtml(r.responder_name || 'Responder')}</strong>
                    ${r.responder_org ? `<span class="bc-r-org">${escapeHtml(r.responder_org)}</span>` : ''}
                    ${r.responder_contact ? `<span class="bc-r-contact"><i class="fa-solid fa-phone"></i> ${escapeHtml(r.responder_contact)}</span>` : ''}
                    ${etaChip}
                </div>
                <div class="bc-responder-line2">
                    <span class="bc-r-time">Assigned ${timeAgo(r.assigned_at)}</span>
                    ${r.dispatched_at ? `<span class="bc-r-time">Dispatched ${timeAgo(r.dispatched_at)}</span>` : ''}
                    ${r.arrived_at ? `<span class="bc-r-time">On-site ${timeAgo(r.arrived_at)}</span>` : ''}
                    ${r.cleared_at ? `<span class="bc-r-time">Cleared ${timeAgo(r.cleared_at)}</span>` : ''}
                    ${r.notes ? `<span class="bc-r-notes" title="${escapeHtml(r.notes)}"><i class="fa-regular fa-note-sticky"></i> note</span>` : ''}
                </div>
            </div>
            <div class="bc-responder-actions">
                ${canDispatch ? `<button class="bc-resp-btn"
                        onclick="_advanceResponder('${b.id}', '${r.id}', 'dispatched')"
                        title="Mark dispatched"><i class="fa-solid fa-truck"></i></button>` : ''}
                ${canArrive ? `<button class="bc-resp-btn"
                        onclick="_advanceResponder('${b.id}', '${r.id}', 'arrived')"
                        title="Mark on-site"><i class="fa-solid fa-map-pin"></i></button>` : ''}
                ${canClear ? `<button class="bc-resp-btn bc-resp-btn-clear"
                        onclick="_advanceResponder('${b.id}', '${r.id}', 'cleared')"
                        title="Mark cleared / stand down"><i class="fa-solid fa-circle-check"></i></button>` : ''}
            </div>
        </div>`;
    }).join('');
}

window._openResponderAssignForm = (buildingId) => {
    // Reveal an inline form anchored under the section title. Stays
    // anchored in the console so the operator never loses building
    // context. Submits to POST /buildings/{id}/responders.
    const id = `bc-responder-form-${buildingId}`;
    const el = document.getElementById(id);
    if (!el) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = `
        <div class="bc-rf-row">
            <input class="bc-rf-input" id="bc-rf-name-${buildingId}"
                   type="text" placeholder="Responder / team name"
                   maxlength="200" autocomplete="off" autofocus />
        </div>
        <div class="bc-rf-row bc-rf-grid">
            <input class="bc-rf-input" id="bc-rf-org-${buildingId}"
                   type="text" placeholder="Organisation (optional)" maxlength="200" />
            <input class="bc-rf-input" id="bc-rf-contact-${buildingId}"
                   type="text" placeholder="Contact (phone / radio)" maxlength="200" />
        </div>
        <div class="bc-rf-row bc-rf-grid">
            <input class="bc-rf-input" id="bc-rf-eta-${buildingId}"
                   type="number" placeholder="ETA (minutes)" min="0" max="10080" />
            <input class="bc-rf-input" id="bc-rf-notes-${buildingId}"
                   type="text" placeholder="Notes (optional)" maxlength="200" />
        </div>
        <div class="bc-rf-row bc-rf-actions">
            <button class="bc-rf-submit"
                    onclick="_submitResponderAssign('${buildingId}')">
                <i class="fa-solid fa-paper-plane"></i> Assign
            </button>
            <button class="bc-rf-cancel"
                    onclick="document.getElementById('bc-responder-form-${buildingId}').style.display='none';">
                Cancel
            </button>
        </div>
    `;
};

window._submitResponderAssign = async (buildingId) => {
    const $ = (k) => document.getElementById(`bc-rf-${k}-${buildingId}`);
    const name = ($('name').value || '').trim();
    if (!name) {
        showToast('Responder name is required', 'error');
        $('name').focus();
        return;
    }
    const body = {
        responder_name: name,
        responder_org: ($('org').value || '').trim() || null,
        responder_contact: ($('contact').value || '').trim() || null,
        eta_minutes: $('eta').value ? Number($('eta').value) : null,
        notes: ($('notes').value || '').trim() || null,
    };
    try {
        const res = await fetch(
            `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/responders`,
            { method: 'POST', headers: _authHeaders(), body: JSON.stringify(body) }
        );
        if (res.status === 401 || res.status === 403) {
            showToast('Analyst role required to assign responders.', 'error');
            return;
        }
        if (!res.ok) {
            const err = await res.text();
            showToast(`Assignment failed: ${err.slice(0, 80)}`, 'error');
            return;
        }
        showToast(`Responder assigned: ${name}`, 'success');
        delete _buildingConsoleCache[buildingId];
        const detail = await _fetchBuildingDetail(buildingId);
        if (detail) _renderBuildingConsole(_opScopeBuilding(detail));
    } catch (e) {
        showToast(`Network error: ${e.message}`, 'error');
    }
};

window._advanceResponder = async (buildingId, responderId, action) => {
    // action ∈ {dispatched, arrived, cleared}. Backend enforces order +
    // emits the BuildingEvent.
    try {
        const res = await fetch(
            `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/responders/${encodeURIComponent(responderId)}`,
            { method: 'PATCH', headers: _authHeaders(), body: JSON.stringify({ action }) }
        );
        if (res.status === 401 || res.status === 403) {
            showToast('Analyst role required.', 'error');
            return;
        }
        if (res.status === 409) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || `Already ${action}`, 'error');
            return;
        }
        if (!res.ok) {
            const err = await res.text();
            showToast(`Update failed: ${err.slice(0, 80)}`, 'error');
            return;
        }
        const label = action === 'dispatched' ? 'Dispatched'
                    : action === 'arrived'    ? 'On-site'
                    : 'Cleared';
        showToast(`Responder → ${label}`, 'success');
        delete _buildingConsoleCache[buildingId];
        const detail = await _fetchBuildingDetail(buildingId);
        if (detail) _renderBuildingConsole(_opScopeBuilding(detail));
    } catch (e) {
        showToast(`Network error: ${e.message}`, 'error');
    }
};

// ──────────────────────────────────────────────────────────────────────
// Phase H.10 - Related buildings carousel (dashboard surface)
// ──────────────────────────────────────────────────────────────────────
window._refreshRelatedBuildings = async (buildingId) => {
    const el = document.getElementById(`bc-related-${buildingId}`);
    const countEl = document.getElementById(`bc-related-count-${buildingId}`);
    if (!el) return;
    try {
        const res = await fetch(
            `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/related?radius_m=600&limit=8`,
            { headers: _authHeaders() }
        );
        if (!res.ok) {
            el.innerHTML = '<div class="bc-empty">Could not load nearby buildings.</div>';
            if (countEl) countEl.textContent = '-';
            return;
        }
        const data = await res.json();
        const items = data.items || [];
        if (countEl) countEl.textContent = String(items.length);
        if (!items.length) {
            el.innerHTML = '<div class="bc-empty">No nearby buildings within 600 m.</div>';
            return;
        }
        const priorityColor = (v) => {
            if (v == null) return '#64748b';
            if (v >= 80) return '#ef4444';
            if (v >= 60) return '#f97316';
            if (v >= 40) return '#eab308';
            if (v >= 20) return '#22c55e';
            return '#94a3b8';
        };
        el.innerHTML = items.map(b => {
            const distance = b.distance_m < 1000
                ? `${b.distance_m} m`
                : `${(b.distance_m / 1000).toFixed(1)} km`;
            const stateColor = ({
                ACTIVE:      '#94a3b8',
                MONITORED:   '#46DFB1',
                RESPONDING:  '#a78bfa',
                ESCALATED:   '#f87171',
                RESOLVED:    '#4ade80',
                ARCHIVED:    '#64748b',
                FALSE_ALARM: '#94a3b8',
            })[b.state] || '#94a3b8';
            const name =
                b.osm_name
                || (b.osm_addr_full || '').trim()
                || (b.osm_way_id ? `OSM ${b.osm_way_id}` : null)
                || (b.id_source === 'PROXIMITY' ? `Cluster ${b.id.slice(0, 8)}` : b.id);
            return `<div class="bc-related-card" onclick="openBuildingConsole('${b.id}')">
                <div class="bc-related-name" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
                <div class="bc-related-meta">
                    <span class="bc-related-state" style="color:${stateColor};">${escapeHtml(b.state || 'ACTIVE')}</span>
                    <span class="bc-related-distance">${distance}</span>
                </div>
                <div class="bc-related-stats">
                    <span class="bc-related-stat">
                        <i class="fa-solid fa-flag"></i> ${b.report_count || 0}
                    </span>
                    <span class="bc-related-stat" style="color:${priorityColor(b.humanitarian_priority)};">
                        <i class="fa-solid fa-bullseye"></i> ${b.humanitarian_priority != null ? b.humanitarian_priority.toFixed(0) : '-'}
                    </span>
                </div>
            </div>`;
        }).join('');
    } catch (e) {
        el.innerHTML = `<div class="bc-empty">Error: ${escapeHtml(e.message)}</div>`;
    }
};

// ──────────────────────────────────────────────────────────────────────
// Phase H.4 - Operator notes thread (dashboard surface)
// ──────────────────────────────────────────────────────────────────────
// Notes are the long-form context channel that BuildingEvent and
// ai_summary don't try to be - free text, pinnable, edit + soft-delete.
// Console section renders newest-first, pinned-first; soft-deleted
// notes render as tombstones.

function _renderNoteList(b) {
    const notes = b.notes || [];
    if (!notes.length) {
        return '<div class="bc-empty">No operator notes yet. Capture situational context here for the next shift.</div>';
    }
    const myId = _crispUser && _crispUser.id;
    const myRole = (_crispUser && _crispUser.role) || '';
    const isAdmin = ['ADMIN', 'SUPER_ADMIN', 'admin', 'super_admin'].includes(myRole);

    return notes.map(n => {
        if (n.deleted_at) {
            return `<div class="bc-note bc-note-deleted">
                <div class="bc-note-body bc-note-tombstone">
                    <i class="fa-regular fa-trash-can"></i>
                    Note deleted ${timeAgo(n.deleted_at)}
                    ${n.author_email ? `· by ${escapeHtml(n.author_email)}` : ''}
                </div>
            </div>`;
        }
        const canEdit = isAdmin || (myId && n.author_user_id === myId);
        const canPin  = true; // any analyst can pin / unpin
        const author = n.author_name || n.author_email || 'Unknown';
        const isPinned = !!n.pinned;
        const isAdminOnly = n.visibility === 'ADMIN_ONLY';
        return `<div class="bc-note ${isPinned ? 'bc-note-pinned' : ''}">
            <div class="bc-note-header">
                <span class="bc-note-author"><i class="fa-solid fa-user"></i> ${escapeHtml(author)}</span>
                <span class="bc-note-time">${timeAgo(n.created_at)}${n.edited_at ? ' · edited' : ''}</span>
                ${isPinned ? '<span class="bc-note-flag bc-note-flag-pinned"><i class="fa-solid fa-thumbtack"></i> pinned</span>' : ''}
                ${isAdminOnly ? '<span class="bc-note-flag bc-note-flag-admin"><i class="fa-solid fa-lock"></i> admin-only</span>' : ''}
                <div class="bc-note-actions">
                    ${canPin ? `<button class="bc-note-btn" title="${isPinned ? 'Unpin' : 'Pin'}"
                                       onclick="_pinNote('${b.id}', '${n.id}', ${!isPinned})">
                        <i class="fa-solid fa-thumbtack"></i>
                    </button>` : ''}
                    ${canEdit ? `<button class="bc-note-btn" title="Edit"
                                       onclick="_editNote('${b.id}', '${n.id}')">
                        <i class="fa-solid fa-pen"></i>
                    </button>` : ''}
                    ${canEdit ? `<button class="bc-note-btn bc-note-btn-delete" title="Delete"
                                       onclick="_deleteNote('${b.id}', '${n.id}')">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>` : ''}
                </div>
            </div>
            <div class="bc-note-body" id="bc-note-body-${n.id}">${escapeHtml(n.body)}</div>
        </div>`;
    }).join('');
}

window._openNoteForm = (buildingId) => {
    const id = `bc-note-form-${buildingId}`;
    const el = document.getElementById(id);
    if (!el) return;
    if (el.style.display !== 'none') { el.style.display = 'none'; return; }
    el.style.display = 'block';
    // Admin-only visibility option is only shown to admins.
    const myRole = (_crispUser && _crispUser.role) || '';
    const isAdmin = ['ADMIN', 'SUPER_ADMIN', 'admin', 'super_admin'].includes(myRole);
    el.innerHTML = `
        <textarea class="bc-note-textarea"
                  id="bc-nf-body-${buildingId}"
                  placeholder="Share context for the next shift: what you saw, who you spoke to, what to watch for…"
                  rows="3" maxlength="4000" autofocus></textarea>
        <div class="bc-nf-controls">
            <label class="bc-nf-check">
                <input type="checkbox" id="bc-nf-pin-${buildingId}" />
                <span><i class="fa-solid fa-thumbtack"></i> Pin to top</span>
            </label>
            ${isAdmin ? `<label class="bc-nf-check">
                <input type="checkbox" id="bc-nf-admin-${buildingId}" />
                <span><i class="fa-solid fa-lock"></i> Admin-only</span>
            </label>` : ''}
            <div class="bc-nf-spacer"></div>
            <button class="bc-nf-submit"
                    onclick="_submitNote('${buildingId}')">
                <i class="fa-solid fa-paper-plane"></i> Post note
            </button>
            <button class="bc-nf-cancel"
                    onclick="document.getElementById('bc-note-form-${buildingId}').style.display='none';">
                Cancel
            </button>
        </div>
    `;
    document.getElementById(`bc-nf-body-${buildingId}`).focus();
};

window._submitNote = async (buildingId) => {
    const $ = (k) => document.getElementById(`bc-nf-${k}-${buildingId}`);
    const text = ($('body').value || '').trim();
    if (!text) {
        showToast('Note cannot be empty', 'error');
        $('body').focus();
        return;
    }
    const body = {
        body: text,
        visibility: $('admin') && $('admin').checked ? 'ADMIN_ONLY' : 'ALL_OPERATORS',
        pinned: $('pin') ? !!$('pin').checked : false,
    };
    try {
        const res = await fetch(
            `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/notes`,
            { method: 'POST', headers: _authHeaders(), body: JSON.stringify(body) }
        );
        if (res.status === 401 || res.status === 403) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || 'Analyst role required.', 'error');
            return;
        }
        if (!res.ok) {
            const err = await res.text();
            showToast(`Note failed: ${err.slice(0, 80)}`, 'error');
            return;
        }
        showToast('Note posted', 'success');
        delete _buildingConsoleCache[buildingId];
        const detail = await _fetchBuildingDetail(buildingId);
        if (detail) _renderBuildingConsole(_opScopeBuilding(detail));
    } catch (e) {
        showToast(`Network error: ${e.message}`, 'error');
    }
};

window._editNote = async (buildingId, noteId) => {
    // Inline edit - replace the rendered body div with a textarea +
    // Save / Cancel. Single-row mutation; no full re-render until
    // the patch completes.
    const bodyEl = document.getElementById(`bc-note-body-${noteId}`);
    if (!bodyEl) return;
    const current = bodyEl.textContent || '';
    bodyEl.innerHTML = `
        <textarea class="bc-note-textarea"
                  id="bc-ne-body-${noteId}"
                  rows="3" maxlength="4000">${escapeHtml(current)}</textarea>
        <div class="bc-nf-controls">
            <div class="bc-nf-spacer"></div>
            <button class="bc-nf-submit" onclick="_submitNoteEdit('${buildingId}','${noteId}')">
                <i class="fa-solid fa-check"></i> Save
            </button>
            <button class="bc-nf-cancel" onclick="_cancelNoteEdit('${buildingId}','${noteId}', this)">
                Cancel
            </button>
        </div>
    `;
    document.getElementById(`bc-ne-body-${noteId}`).focus();
};

window._cancelNoteEdit = async (buildingId) => {
    // Easiest path: re-render the console from cache so the original
    // body comes back.
    const detail = _buildingConsoleCache[buildingId]
        || await _fetchBuildingDetail(buildingId);
    if (detail) _renderBuildingConsole(_opScopeBuilding(detail));
};

window._submitNoteEdit = async (buildingId, noteId) => {
    const ta = document.getElementById(`bc-ne-body-${noteId}`);
    const text = ((ta && ta.value) || '').trim();
    if (!text) { showToast('Body cannot be empty (use Delete to remove)', 'error'); return; }
    try {
        const res = await fetch(
            `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/notes/${encodeURIComponent(noteId)}`,
            { method: 'PATCH', headers: _authHeaders(), body: JSON.stringify({ body: text }) }
        );
        if (!res.ok) {
            const err = await res.text();
            showToast(`Edit failed: ${err.slice(0, 80)}`, 'error');
            return;
        }
        showToast('Note updated', 'success');
        delete _buildingConsoleCache[buildingId];
        const detail = await _fetchBuildingDetail(buildingId);
        if (detail) _renderBuildingConsole(_opScopeBuilding(detail));
    } catch (e) {
        showToast(`Network error: ${e.message}`, 'error');
    }
};

window._pinNote = async (buildingId, noteId, pinned) => {
    try {
        const res = await fetch(
            `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/notes/${encodeURIComponent(noteId)}`,
            { method: 'PATCH', headers: _authHeaders(), body: JSON.stringify({ pinned }) }
        );
        if (!res.ok) {
            const err = await res.text();
            showToast(`Pin toggle failed: ${err.slice(0, 80)}`, 'error');
            return;
        }
        showToast(pinned ? 'Note pinned' : 'Note unpinned', 'success');
        delete _buildingConsoleCache[buildingId];
        const detail = await _fetchBuildingDetail(buildingId);
        if (detail) _renderBuildingConsole(_opScopeBuilding(detail));
    } catch (e) {
        showToast(`Network error: ${e.message}`, 'error');
    }
};

window._deleteNote = async (buildingId, noteId) => {
    if (!confirm('Delete this note? The tombstone remains in the audit log.')) return;
    try {
        const res = await fetch(
            `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/notes/${encodeURIComponent(noteId)}`,
            { method: 'DELETE', headers: _authHeaders() }
        );
        if (!res.ok) {
            const err = await res.text();
            showToast(`Delete failed: ${err.slice(0, 80)}`, 'error');
            return;
        }
        showToast('Note deleted', 'success');
        delete _buildingConsoleCache[buildingId];
        const detail = await _fetchBuildingDetail(buildingId);
        if (detail) _renderBuildingConsole(_opScopeBuilding(detail));
    } catch (e) {
        showToast(`Network error: ${e.message}`, 'error');
    }
};

window._toggleBuildingMonitor = async (buildingId, watching) => {
    // `watching` is the CURRENT state - if true, DELETE the monitor;
    // otherwise POST a new one.
    try {
        const method = watching ? 'DELETE' : 'POST';
        const res = await fetch(
            `${BUILDINGS_API}/${encodeURIComponent(buildingId)}/monitor`,
            { method, headers: _authHeaders() }
        );
        if (res.status === 401 || res.status === 403) {
            showToast('Analyst role required to monitor a building.', 'error');
            return;
        }
        if (!res.ok && res.status !== 204) {
            const err = await res.text();
            showToast(`Watch toggle failed: ${err.slice(0, 80)}`, 'error');
            return;
        }
        showToast(watching ? 'Stopped watching this building' : 'Added to your watch list', 'success');
        delete _buildingConsoleCache[buildingId];
        const detail = await _fetchBuildingDetail(buildingId);
        if (detail) _renderBuildingConsole(_opScopeBuilding(detail));
    } catch (e) {
        showToast(`Network error: ${e.message}`, 'error');
    }
};

// ── Phase 5 (Apr 2026) - Reviewer actions block ─────────────────────────────
// Renders a compact row showing the current verdict + two action buttons
// (Accept / Reject) + two timestamp buttons (Dispatched / Arrived).
// Response time displayed when both `reviewed_at` and a responder timestamp
// are set - value comes precomputed from the backend as `response_time_seconds`.

function _fmtDuration(secs) {
    if (!Number.isFinite(secs) || secs < 0) return '';
    if (secs < 60) return `${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm ? `${h}h ${mm}m` : `${h}h`;
}

function _fmtReviewAgo(iso) {
    if (!iso) return '';
    const t = new Date(ensureUTC(iso)).getTime();
    if (!Number.isFinite(t)) return '';
    const secs = Math.max(0, Math.round((Date.now() - t) / 1000));
    return _fmtDuration(secs) + ' ago';
}

// Phase F.2.a (May 2026) - Per-incident timeline renderer.
//
// Surfaces the lifecycle audit data the backend already records on
// the Report + related rows. NO new endpoint required - every event
// type below is sourced from a column already present in the LIST
// response.
//
// Event types rendered (ordered chronologically):
//   - Report received        ← server_created_at + .source
//   - Captured offline (F.8) ← client_created_at, only when delta>5min
//                              (placeholder for the F.8 commit; today
//                              just renders if the field happens to
//                              come through; harmless if absent)
//   - Photo / Audio added    ← media[i].created_at (per media row)
//   - Upload complete        ← media[i].updated_at when
//                              .assembly_status === 'complete'
//   - Analyst {verdict}      ← reviewed_at + reviewer_verdict
//   - Responder dispatched   ← help_dispatched_at
//   - Responder on-site      ← help_arrived_at
//   - AI verified            ← verification.scored_at + .verdict
//   - Deletion requested     ← deletion_requested_at + .grace_minutes
//
// Empty-state ("no events") is treated as "report just landed";
// the timeline still renders with the "Report received" row so the
// section is never blank.
function _renderIncidentTimeline(r) {
    const events = [];

    // Report received (always present unless server_created_at is null
    // - shouldn't happen but defensive).
    if (r.server_created_at) {
        events.push({
            ts: r.server_created_at,
            icon: 'fa-flag-checkered',
            color: '#94a3b8',
            label: `Report received via ${r.source || 'APP'}`,
        });
    }

    // Captured offline (F.8 surface). When client_created_at is set
    // AND meaningfully earlier than server_created_at, the report was
    // buffered in the PWA's offline queue. Threshold matches F.8.a's
    // 5-minute floor (anything tighter is clock skew, not offline).
    if (r.client_created_at && r.server_created_at) {
        const clientMs = new Date(r.client_created_at).getTime();
        const serverMs = new Date(r.server_created_at).getTime();
        if (clientMs > 0 && (serverMs - clientMs) > 5 * 60 * 1000) {
            events.push({
                ts: r.client_created_at,
                icon: 'fa-cloud-arrow-up',
                color: '#f59e0b',
                label: 'Captured offline (queued by PWA)',
            });
        }
    }

    // Media added (one row per media; order by .created_at).
    for (const m of (r.media || [])) {
        if (!m.created_at) continue;
        const isImage = m.type === 'IMAGE';
        events.push({
            ts: m.created_at,
            icon: isImage ? 'fa-camera' : 'fa-microphone',
            color: '#64748b',
            label: `${isImage ? 'Photo' : 'Audio'} added${m.resolution_tier ? ' (' + m.resolution_tier + ')' : ''}`,
        });
        // Upload complete (only when assembly flipped to complete and
        // the updated_at moved past the created_at - otherwise it's
        // the same instant, redundant row).
        if (m.assembly_status === 'complete' && m.updated_at && m.updated_at !== m.created_at) {
            events.push({
                ts: m.updated_at,
                icon: 'fa-check-double',
                color: '#22c55e',
                label: `${isImage ? 'Photo' : 'Audio'} upload complete`,
            });
        }
    }

    // Analyst review (verdict + timestamp).
    if (r.reviewed_at && r.reviewer_verdict) {
        const verdictLower = String(r.reviewer_verdict).toLowerCase();
        events.push({
            ts: r.reviewed_at,
            icon: verdictLower === 'accepted' ? 'fa-circle-check' : 'fa-circle-xmark',
            color:  verdictLower === 'accepted' ? '#22c55e' : '#ef4444',
            label: `Analyst ${verdictLower}`,
        });
    }

    // Dispatched / arrived (responder lifecycle).
    if (r.help_dispatched_at) {
        events.push({
            ts: r.help_dispatched_at,
            icon: 'fa-truck-medical',
            color: '#a78bfa',
            label: 'Responder dispatched',
        });
    }
    if (r.help_arrived_at) {
        events.push({
            ts: r.help_arrived_at,
            icon: 'fa-map-pin',
            color: '#22c55e',
            label: 'Responder on-site',
        });
    }

    // AI / satellite verification.
    if (r.verification && r.verification.scored_at) {
        const v = r.verification;
        const verdictTxt = String(v.verdict || '').replace(/_/g, ' ');
        events.push({
            ts: v.scored_at,
            icon: 'fa-satellite',
            color: v.total_score >= 60 ? '#22c55e' : v.total_score >= 40 ? '#eab308' : '#ef4444',
            label: `AI verified: ${verdictTxt} (${v.total_score}/100)`,
        });
    }

    // Deletion grace.
    if (r.deletion_requested_at) {
        const graceMin = r.deletion_grace_minutes || 1440;
        events.push({
            ts: r.deletion_requested_at,
            icon: 'fa-trash-clock',
            color: '#ef4444',
            label: `Deletion requested (${graceMin}m grace)`,
        });
    }

    // Sort chronologically.
    events.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    if (events.length === 0) {
        // Shouldn't normally happen - server_created_at is always set.
        // Render an explicit empty state rather than nothing so the
        // section's presence is consistent.
        return '';   // no events - History shows just the audit ribbon
    }

    const rows = events.map(e => `
        <li class="dp-timeline-row">
            <span class="dp-timeline-dot" style="color:${e.color};border-color:${e.color}88;">
                <i class="fa-solid ${e.icon}"></i>
            </span>
            <div class="dp-timeline-body">
                <div class="dp-timeline-label">${escapeHtml(e.label)}</div>
                <div class="dp-timeline-ts">${escapeHtml(fmtDateTime(e.ts))} · ${timeAgo(e.ts)}</div>
            </div>
        </li>
    `).join('');

    // No inner accordion / "Timeline" header - this renders directly inside the
    // History accordion (avoids a redundant accordion-in-an-accordion).
    return `<ul class="dp-timeline-list">${rows}</ul>`;
}

function _renderReviewerActions(r) {
    const verdict = (r.reviewer_verdict || 'NOT_REVIEWED');
    const verdictClass = verdict.toLowerCase();
    const verdictLabel = verdict === 'ACCEPTED' ? '✓ Accepted'
        : verdict === 'REJECTED' ? '✕ Rejected'
        : 'Not reviewed';
    const reviewedAgo = r.reviewed_at ? `Reviewed ${_fmtReviewAgo(r.reviewed_at)}` : '';
    const responseStr = Number.isFinite(r.response_time_seconds)
        ? `Response: ${_fmtDuration(r.response_time_seconds)}` : '';
    const dispatched = r.help_dispatched_at
        ? `Dispatched ${_fmtReviewAgo(r.help_dispatched_at)}` : '';
    const arrived = r.help_arrived_at
        ? `Arrived ${_fmtReviewAgo(r.help_arrived_at)}` : '';
    const actionTxt = (verdict === 'REJECTED' && r.action_taken)
        ? `<div class="dp-reviewer-note"><i class="fa-solid fa-comment-dots"></i> ${escapeHtml(r.action_taken)}</div>` : '';

    // May 2026 (operator-reported) - Lives helped input.
    //
    // The PWA home shows "Lives Saved" sourced from each report's
    // `lives_impacted` integer (analyst-only `PATCH /reports/{id}/impact`
    // endpoint, which has existed since April 2026). But no dashboard
    // UI exposed it - analysts had no way to set the number short of
    // a curl. Reporters' home cards therefore always showed "-".
    //
    // This input is gated by the same role pattern as the other
    // analyst actions: the buttons call /review, /dispatch, /resolve
    // (all `require_analyst` on the backend), so a non-analyst's
    // requests return 403. We don't hide the input client-side; we
    // rely on the server's gate. (Hiding would require a role check
    // we don't reliably have on every dashboard surface.)
    // Phase F.1.d (May 2026) - Lives Helped input moved to the
    // reviewer top row so it's discoverable without scrolling. The
    // hint text below the input is dropped from the sticky strip
    // (operator's onboarding tooltip surfaces the same info on
    // hover); the strip stays compact enough to pin to the top of
    // the detail-panel scroll container.
    const livesCurrent = Number.isFinite(r.lives_impacted) ? r.lives_impacted : 0;
    const livesInlineHtml = `
        <div class="dp-reviewer-lives-inline" title="Reporter's home shows this number under 'Lives Saved' once set.">
            <i class="fa-solid fa-heart-pulse dp-reviewer-lives-icon" aria-hidden="true"></i>
            <input type="number" min="0" max="100000" step="1"
                   class="dp-reviewer-lives-input"
                   id="dp-lives-input-${r.id}"
                   value="${livesCurrent}"
                   data-original="${livesCurrent}"
                   aria-label="Lives helped by this report" />
            <button type="button" class="dp-reviewer-btn dp-reviewer-lives-save"
                    onclick="setLivesImpacted('${r.id}')"
                    title="Save the lives-helped count">
                <i class="fa-solid fa-floppy-disk"></i>
            </button>
        </div>`;

    // Phase J.2 (May 2026) - Verdict dropdown replaces the Accept /
    // Reject / Dispatched / Arrived 4-button row. The dropdown
    // collapses three verdicts (Accept · Reject · False alarm) into
    // a single decision surface; once the verdict is set, the
    // dropdown shows the active verdict and the operator can change
    // it via the same control. Dispatched / Arrived stay as small
    // timestamp pills below - they're response-progress events,
    // not verdict actions.
    //
    // Operator confirmation (May 2026 working session): "Single
    // Verdict dropdown + Send Help CTA" was chosen as the maximum
    // simplification path. False Alarm now lives in this dropdown
    // (was previously a top-level button alongside Send Help).
    const verdictDropdownLabel = verdict === 'ACCEPTED' ? 'Accepted'
        : verdict === 'REJECTED' ? 'Rejected'
        : (r.status === 'FALSE_ALARM' ? 'False alarm'
            : 'Set verdict ▾');
    const verdictTriggerClass = verdict === 'ACCEPTED'
        ? 'dp-verdict-trigger dp-verdict-trigger-accepted'
        : verdict === 'REJECTED'
            ? 'dp-verdict-trigger dp-verdict-trigger-rejected'
            : (r.status === 'FALSE_ALARM'
                ? 'dp-verdict-trigger dp-verdict-trigger-false'
                : 'dp-verdict-trigger dp-verdict-trigger-pending');

    // Phase J.2 - response-progress chips. When the timestamp isn't
    // set, the chip is clickable ("Mark dispatched"); when set it's
    // a read-only timestamp pill ("Dispatched 12 min ago").
    const dispatchedChip = r.help_dispatched_at
        ? `<span class="dp-resp-chip dp-resp-chip-done"
                  title="Dispatched ${_fmtReviewAgo(r.help_dispatched_at)}">
              <i class="fa-solid fa-truck-medical"></i>
              <span>Dispatched · ${_fmtReviewAgo(r.help_dispatched_at)}</span>
           </span>`
        : `<button class="dp-resp-chip dp-resp-chip-action"
                   onclick="stampResponderTime('${r.id}','dispatched')"
                   title="Mark dispatched">
              <i class="fa-solid fa-truck-medical"></i>
              <span>Mark dispatched</span>
           </button>`;
    const arrivedChip = r.help_arrived_at
        ? `<span class="dp-resp-chip dp-resp-chip-done"
                  title="Arrived ${_fmtReviewAgo(r.help_arrived_at)}">
              <i class="fa-solid fa-map-pin"></i>
              <span>On-site · ${_fmtReviewAgo(r.help_arrived_at)}</span>
           </span>`
        : `<button class="dp-resp-chip dp-resp-chip-action"
                   ${r.help_dispatched_at ? '' : 'disabled title="Mark dispatched first"'}
                   onclick="stampResponderTime('${r.id}','arrived')">
              <i class="fa-solid fa-map-pin"></i>
              <span>Mark on-site</span>
           </button>`;

    // Dedup: the standalone verdict chip is REMOVED - the header's combined status
    // pill (_displayStatus: Needs review / Accepted / Rejected …) already states it,
    // and the "Set verdict" dropdown below is the control. void keeps the now-unused
    // builders honest without reintroducing the duplicate label.
    void verdictLabel; void verdictClass;
    return `<div class="dp-reviewer is-sticky">
        <div class="dp-reviewer-top">
            ${reviewedAgo ? `<span class="dp-reviewer-meta">${reviewedAgo}</span>` : ''}
            ${responseStr ? `<span class="dp-reviewer-meta dp-reviewer-response">${responseStr}</span>` : ''}
            ${livesInlineHtml}
        </div>
        ${actionTxt}
        <div class="dp-verdict-row">
            <div class="dp-verdict-dropdown" id="dp-verdict-dropdown-${r.id}">
                <button class="${verdictTriggerClass}"
                        onclick="event.stopPropagation();this.parentElement.classList.toggle('open')">
                    <i class="fa-solid ${
                        verdict === 'ACCEPTED' ? 'fa-circle-check'
                        : verdict === 'REJECTED' ? 'fa-circle-xmark'
                        : (r.status === 'FALSE_ALARM' ? 'fa-ban' : 'fa-gavel')
                    }"></i>
                    <span>${verdictDropdownLabel}</span>
                    <i class="fa-solid fa-caret-down" style="font-size:9px;opacity:0.6;margin-left:4px;"></i>
                </button>
                <div class="dp-verdict-menu">
                    <button class="dp-verdict-item dp-verdict-item-accept ${verdict === 'ACCEPTED' ? 'active' : ''}"
                            onclick="setReviewVerdict('${r.id}','ACCEPTED');this.closest('.dp-verdict-dropdown').classList.remove('open')">
                        <i class="fa-solid fa-circle-check"></i>
                        <div class="dp-verdict-item-text">
                            <span class="dp-verdict-item-title">Accept</span>
                            <span class="dp-verdict-item-sub">Confirmed real incident</span>
                        </div>
                    </button>
                    <button class="dp-verdict-item dp-verdict-item-reject ${verdict === 'REJECTED' ? 'active' : ''}"
                            onclick="openRejectModal('${r.id}');this.closest('.dp-verdict-dropdown').classList.remove('open')">
                        <i class="fa-solid fa-circle-xmark"></i>
                        <div class="dp-verdict-item-text">
                            <span class="dp-verdict-item-title">Reject</span>
                            <span class="dp-verdict-item-sub">Reason required</span>
                        </div>
                    </button>
                    <button class="dp-verdict-item dp-verdict-item-false ${r.status === 'FALSE_ALARM' ? 'active' : ''}"
                            onclick="patchReport('${r.id}','false-alarm');this.closest('.dp-verdict-dropdown').classList.remove('open')">
                        <i class="fa-solid fa-ban"></i>
                        <div class="dp-verdict-item-text">
                            <span class="dp-verdict-item-title">False alarm</span>
                            <span class="dp-verdict-item-sub">Marks misinformation</span>
                        </div>
                    </button>
                </div>
            </div>
            <div class="dp-response-chips">
                ${dispatchedChip}
                ${arrivedChip}
            </div>
        </div>
    </div>`;
}

// May 2026 (operator-reported) - analyst-side setter for the per-report
// `lives_impacted` integer. Backend gates the endpoint with
// `require_analyst`; the dashboard fetch carries the JWT cookie
// automatically. On 403 we surface a toast that explains why (helps
// new operators onboard without confusion).
window.setLivesImpacted = async (reportId) => {
    const input = document.getElementById(`dp-lives-input-${reportId}`);
    if (!input) return;
    const raw = input.value;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
        return showToast('Lives helped must be a non-negative number.', 'error');
    }
    const original = Number(input.getAttribute('data-original') || '0');
    if (n === original) {
        return showToast('No change to save.', 'info');
    }
    try {
        const res = await fetch(`${API}/${reportId}/impact`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ lives_impacted: n }),
        });
        if (res.status === 401 || res.status === 403) {
            return showToast('Only analysts can set "Lives helped". Sign in with an analyst account.', 'error');
        }
        if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try { detail = (await res.json()).detail || detail; } catch (_) {}
            return showToast(`Save failed: ${detail}`, 'error');
        }
        const body = await res.json();
        const idx = allReports.findIndex(x => x.id === reportId);
        if (idx >= 0) {
            allReports[idx].lives_impacted = body.lives_impacted;
        }
        input.setAttribute('data-original', String(body.lives_impacted));
        showToast(
            body.lives_impacted === 0
                ? 'Cleared lives-helped count.'
                : `Saved - ${body.lives_impacted} ${body.lives_impacted === 1 ? 'life' : 'lives'} helped.`,
            'success',
        );
        renderFeed();
    } catch (e) {
        showToast(`Save error: ${e.message}`, 'error');
    }
};

window.setReviewVerdict = async (reportId, verdict, actionTaken = null) => {
    try {
        const body = { verdict };
        if (actionTaken) body.action_taken = actionTaken;
        const res = await fetch(`${API}/${reportId}/review`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try { detail = (await res.json()).detail || detail; } catch (_) {}
            return showToast(`Review failed: ${detail}`, 'error');
        }
        const updated = await res.json();
        const idx = allReports.findIndex(x => x.id === reportId);
        if (idx >= 0) allReports[idx] = { ...allReports[idx], ...updated };
        showToast(verdict === 'ACCEPTED' ? 'Marked accepted' : 'Marked rejected', 'success');
        if (selectedId === reportId) selectReport(reportId, true);
        renderFeed();
    } catch (e) {
        showToast(`Review error: ${e.message}`, 'error');
    }
};

// ── Shared action-confirmation modal ──────────────────────────────────────────
// A single overlay used by Reject + Delete (and reusable for any confirm-with-
// reason flow). Closes on ×, Cancel, click-outside, or Escape. opts.onConfirm
// receives (overlay, close) so it can read inputs + validate before closing.
window._crispActionModal = (opts) => {
    document.querySelectorAll('.crisp-action-overlay').forEach(n => n.remove());
    const ov = document.createElement('div');
    ov.className = 'crisp-action-overlay';
    const onKey = (e) => { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    ov.onclick = (e) => { if (e.target === ov) close(); };
    ov.innerHTML = `<div class="crisp-action-modal crisp-action-${opts.tone || 'default'}" role="dialog" aria-modal="true" aria-label="${escapeHtml(opts.title || '')}">
        <div class="crisp-action-head"><i class="fa-solid ${opts.icon || 'fa-circle-question'}"></i><span>${escapeHtml(opts.title || '')}</span>
            <button class="crisp-action-x" aria-label="Close">&times;</button></div>
        <div class="crisp-action-body">${opts.bodyHtml || ''}</div>
        <div class="crisp-action-foot">
            <button class="crisp-action-cancel">Cancel</button>
            <button class="crisp-action-confirm crisp-action-confirm-${opts.confirmTone || 'primary'}">${escapeHtml(opts.confirmLabel || 'Confirm')}</button>
        </div>
    </div>`;
    ov.querySelector('.crisp-action-x').onclick = close;
    ov.querySelector('.crisp-action-cancel').onclick = close;
    ov.querySelector('.crisp-action-confirm').onclick = () => { try { opts.onConfirm(ov, close); } catch (_e) {} };
    document.body.appendChild(ov);
    const f = ov.querySelector('textarea, input:not([type=checkbox]), .crisp-action-confirm');
    if (f) { try { f.focus(); } catch (_e) {} }
    return ov;
};

window.openRejectModal = (reportId) => {
    _crispActionModal({
        title: 'Reject report', icon: 'fa-circle-xmark', tone: 'warn', confirmLabel: 'Reject report', confirmTone: 'warn',
        bodyHtml: `<p class="crisp-action-msg">Rejecting marks this report invalid and removes it from the active feed and the review/response queues. It stays accessible under the <strong>Rejected</strong> filter for audit.</p>
            <label class="crisp-action-label">Reason for rejection <span class="crisp-req">*</span></label>
            <textarea class="crisp-action-reason" id="crisp-reject-reason" rows="3" placeholder="e.g. Duplicate of an existing incident · spam · not actionable…"></textarea>`,
        onConfirm: (ov, close) => {
            const ta = ov.querySelector('#crisp-reject-reason');
            const reason = (ta.value || '').trim();
            if (!reason) { ta.classList.add('crisp-action-invalid'); ta.focus(); showToast('Rejection reason required', 'error'); return; }
            close();
            window.setReviewVerdict(reportId, 'REJECTED', reason);
        },
    });
};

window.openDeleteModal = (reportId) => {
    _crispActionModal({
        title: 'Delete report', icon: 'fa-triangle-exclamation', tone: 'danger', confirmLabel: 'Delete report', confirmTone: 'danger',
        bodyHtml: `<p class="crisp-action-msg crisp-action-msg-danger"><strong>This is a permanent administrative action.</strong> The report enters a 24-hour deletion grace window, then is permanently purged from all feeds, queues, and search. Use only for spam, test data, policy violations, or duplicate cleanup.</p>
            <label class="crisp-action-label">Reason for deletion <span class="crisp-req">*</span></label>
            <textarea class="crisp-action-reason" id="crisp-delete-reason" rows="3" placeholder="e.g. Spam / test submission · policy violation · duplicate cleanup…"></textarea>`,
        onConfirm: (ov, close) => {
            const ta = ov.querySelector('#crisp-delete-reason');
            const reason = (ta.value || '').trim();
            if (!reason) { ta.classList.add('crisp-action-invalid'); ta.focus(); showToast('Deletion reason required', 'error'); return; }
            close();
            window.deleteReport(reportId, reason);
        },
    });
};

// ── Notify Response Team ──────────────────────────────────────────────────────
// Opens a modal listing the responders linked to the incident (building +
// operation), lets the analyst multi-select + pick channels, then POSTs
// /notify-responders (SMS/Email + audit + Active Response + reporter push).
window.openNotifyModal = async (reportId) => {
    const ov = _crispActionModal({
        title: 'Notify Response Team', icon: 'fa-tower-broadcast', tone: 'default', confirmLabel: 'Notify responders', confirmTone: 'primary',
        bodyHtml: `<div id="crisp-notify-host"><div class="crisp-action-msg"><i class="fa-solid fa-spinner fa-spin"></i> Loading linked responders…</div></div>`,
        onConfirm: (ov2, close) => window._doNotifyResponders(reportId, ov2, close),
    });
    ov.querySelector('.crisp-action-confirm').disabled = true;
    try {
        const res = await fetch(`${API}/${encodeURIComponent(reportId)}/responders`);
        const data = res.ok ? await res.json() : { responders: [] };
        const host = ov.querySelector('#crisp-notify-host');
        if (!host) return;
        const rs = data.responders || [];
        if (!rs.length) {
            host.innerHTML = `<div class="notify-empty">
                <i class="fa-solid fa-user-plus notify-empty-icon"></i>
                <p>No responders are linked to this incident's ${data.building_id ? 'building' : 'location'} yet.</p>
                <p class="notify-empty-sub">Assign response organizations, responders, volunteers or emergency contacts${data.building_id ? ' in the Building Console' : ''}${data.crisis_event_id ? ' or the Operation' : ''}, then notify them here.</p>
                <div class="notify-empty-actions">
                    ${data.building_id ? `<button class="assess-mini-btn" onclick="document.querySelectorAll('.crisp-action-overlay').forEach(n=>n.remove());window.openBuildingConsole&&window.openBuildingConsole(decodeURIComponent('${encodeURIComponent(data.building_id)}'))"><i class="fa-solid fa-building"></i> Open Building Console</button>` : ''}
                    <button class="crisp-action-cancel" onclick="document.querySelectorAll('.crisp-action-overlay').forEach(n=>n.remove());patchReport('${reportId}','dispatch')"><i class="fa-solid fa-hand-holding-medical"></i> Mark responding anyway</button>
                </div>
            </div>`;
            return;
        }
        const chBadge = (ch) => ch === 'email' ? '<span class="notify-ch notify-ch-email"><i class="fa-solid fa-envelope"></i> Email</span>'
            : ch === 'sms' ? '<span class="notify-ch notify-ch-sms"><i class="fa-solid fa-comment-sms"></i> SMS</span>'
                : '<span class="notify-ch notify-ch-none">No contact</span>';
        host.innerHTML = `
            <p class="crisp-action-msg">Select responders to alert. Each is messaged on the channel its contact supports.</p>
            <div class="notify-list">${rs.map(rr => {
                const disabled = !rr.channel;
                const meta = [rr.org, (rr.org_type || '').replace(/_/g, ' ').toLowerCase()].filter(Boolean).join(' · ');
                return `<label class="notify-row ${disabled ? 'notify-row-disabled' : ''}">
                    <input type="checkbox" class="notify-cb" value="${rr.id}" data-ch="${rr.channel || ''}" ${disabled ? 'disabled' : 'checked'}>
                    <span class="notify-main"><span class="notify-name">${escapeHtml(rr.name)}</span>
                    <span class="notify-sub">${escapeHtml(meta)}${rr.contact ? (meta ? ' · ' : '') + escapeHtml(rr.contact) : ''}</span></span>
                    ${chBadge(rr.channel)}</label>`;
            }).join('')}</div>
            <div class="notify-channels"><span class="notify-channels-l">Send via:</span>
                <label class="notify-chk"><input type="checkbox" id="crisp-notify-sms" checked> SMS</label>
                <label class="notify-chk"><input type="checkbox" id="crisp-notify-email" checked> Email</label></div>`;
        ov.querySelector('.crisp-action-confirm').disabled = false;
    } catch (e) {
        const host = ov.querySelector('#crisp-notify-host');
        if (host) host.innerHTML = `<div class="crisp-action-msg">Could not load responders. ${escapeHtml(e.message || '')}</div>`;
    }
};

window._doNotifyResponders = async (reportId, ov, close) => {
    const ids = Array.from(ov.querySelectorAll('.notify-cb:checked')).map(cb => cb.value);
    if (!ids.length) { showToast('Select at least one responder', 'error'); return; }
    const channels = [];
    if (ov.querySelector('#crisp-notify-sms')?.checked) channels.push('sms');
    if (ov.querySelector('#crisp-notify-email')?.checked) channels.push('email');
    if (!channels.length) { showToast('Select at least one channel (SMS / Email)', 'error'); return; }
    const btn = ov.querySelector('.crisp-action-confirm');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Notifying…'; }
    try {
        const res = await fetch(`${API}/${encodeURIComponent(reportId)}/notify-responders`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ responder_ids: ids, channels }),
        });
        if (!res.ok) {
            const d = await res.json().catch(() => ({}));
            showToast(`Notify failed: ${d.detail || ('HTTP ' + res.status)}`, 'error');
            if (btn) { btn.disabled = false; btn.innerHTML = 'Notify responders'; }
            return;
        }
        const data = await res.json();
        const idx = allReports.findIndex(x => x.id === reportId);
        if (idx >= 0 && data.status) allReports[idx].status = data.status;
        if (_detailOnlyReport && _detailOnlyReport.id === reportId && data.status) _detailOnlyReport.status = data.status;
        close();
        const parts = [`${data.notified} responder${data.notified === 1 ? '' : 's'} notified`];
        if (data.sms) parts.push(`${data.sms} SMS`);
        if (data.email) parts.push(`${data.email} email`);
        showToast(`${parts.join(' · ')}. Reporter informed; incident now in Active Response.`, 'success');
        if ((data.failures || []).length) showToast(`${data.failures.length} responder(s) could not be reached on the selected channel.`, 'info');
        if (selectedId === reportId) selectReport(reportId, true);
        renderFeed();
    } catch (e) {
        showToast('Notify request failed - check connectivity', 'error');
        if (btn) { btn.disabled = false; btn.innerHTML = 'Notify responders'; }
    }
};

window.stampResponderTime = async (reportId, which) => {
    const body = which === 'arrived'
        ? { stamp_arrived_now: true }
        : { stamp_dispatched_now: true };
    try {
        const res = await fetch(`${API}/${reportId}/timestamps`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            let detail = `HTTP ${res.status}`;
            try { detail = (await res.json()).detail || detail; } catch (_) {}
            return showToast(`Timestamp failed: ${detail}`, 'error');
        }
        const updated = await res.json();
        const idx = allReports.findIndex(x => x.id === reportId);
        if (idx >= 0) allReports[idx] = { ...allReports[idx], ...updated };
        showToast(which === 'arrived' ? 'Marked arrived' : 'Marked dispatched', 'success');
        if (selectedId === reportId) selectReport(reportId, true);
        renderFeed();
    } catch (e) {
        showToast(`Timestamp error: ${e.message}`, 'error');
    }
};

// Phase 2: manual tier selection - swap the displayed variant in-place.
// Stamps `_tierOverride[reportId]` so subsequent polls / upgrades don't
// override the user's choice. Also updates the gallery thumb's active
// class + the tier switcher's active button state, and rewires the
// lightbox click handler to open the selected tier.
window.setDetailImageTier = (reportId, groupId, tier, btnEl) => {
    const r = allReports.find(x => x.id === reportId);
    if (!r) return;
    const images = r.media?.filter(m => m.type === 'IMAGE') || [];
    const group = groupPhotos(images).find(g => g.group_id === groupId) || groupPhotos(images)[0];
    if (!group) return;
    const m = group.members.find(x => x.resolution_tier === tier && x.assembly_status === 'complete' && x.url);
    if (!m) return;
    const src = getMediaUrl(m.url);
    _tierOverride.set(reportId, tier);

    // Swap <img src> on the main detail image.
    const wrap = document.querySelector(`#dp-img-view-${reportId} .dp-img[data-group-id]`);
    if (wrap) {
        const img = wrap.querySelector('img');
        if (img && img.src !== src) {
            img.src = src;
            img.classList.remove('img-thumb-bg');
            img.classList.add('img-full-layer', 'img-ready');
        }
        wrap.setAttribute('data-current-tier', tier);
        wrap.classList.remove('dp-img-uploading');
        wrap.setAttribute('onclick',
            `openGallery('${r.id}', 0)`);
    }

    // Update active button state inside the switcher.
    if (btnEl && btnEl.parentElement) {
        btnEl.parentElement.querySelectorAll('.dp-tier-btn').forEach(b => b.classList.remove('active'));
        btnEl.classList.add('active');
    }
};

// ──────────────────────────────────────────────────────────────────────
// Phase J.5 (May 2026) - Global keyboard shortcuts
// ──────────────────────────────────────────────────────────────────────
// `?` opens the shortcuts cheat-sheet modal.
// `Esc` closes any open modal / dropdown / detail panel.
// `j` / `k` move focus through the feed.
// `v` opens the Verdict dropdown on the currently-open report.
// `s` runs satellite Re-verify on the open report.
// `b` opens the Building Console for the report's building (if any).
// All shortcuts no-op when focus is in an input / textarea / select.
document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        _openKeyboardShortcutsModal();
        return;
    }

    // The remaining shortcuts require an open detail panel.
    if (!selectedId) return;

    if (e.key === 'v' || e.key === 'V') {
        const dd = document.getElementById(`dp-verdict-dropdown-${selectedId}`);
        if (dd) {
            e.preventDefault();
            dd.classList.toggle('open');
        }
        return;
    }
    if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        if (typeof runVerification === 'function') {
            runVerification(selectedId);
        }
        return;
    }
    if (e.key === 'b' || e.key === 'B') {
        const r = allReports.find(x => x.id === selectedId);
        if (r && r.building_id && typeof openBuildingConsole === 'function') {
            e.preventDefault();
            openBuildingConsole(r.building_id);
        }
        return;
    }
});

// ──────────────────────────────────────────────────────────────────────
// Phase J.5 - Onboarding tooltips
// ──────────────────────────────────────────────────────────────────────
// First few sessions per device, surface a one-line hint over the
// Verdict dropdown + the Send Help CTA + the Tools menu. Counter
// stored in localStorage. After 3 sessions we never show them again.
// Operator can also dismiss any tip with × on the tooltip itself.

const _ONBOARDING_LS_KEY = 'crisp_onboarded_v1';
const _ONBOARDING_SESSION_THRESHOLD = 3;

function _onboardingSessionCount() {
    try {
        const raw = localStorage.getItem(_ONBOARDING_LS_KEY);
        if (!raw) return 0;
        const data = JSON.parse(raw);
        return data.sessions || 0;
    } catch (_) { return 0; }
}

function _onboardingTipDismissed(id) {
    try {
        const raw = localStorage.getItem(_ONBOARDING_LS_KEY);
        if (!raw) return false;
        const data = JSON.parse(raw);
        return (data.dismissed || []).includes(id);
    } catch (_) { return false; }
}

function _onboardingMarkDismissed(id) {
    try {
        const raw = localStorage.getItem(_ONBOARDING_LS_KEY);
        const data = raw ? JSON.parse(raw) : { sessions: 0, dismissed: [] };
        if (!data.dismissed) data.dismissed = [];
        if (!data.dismissed.includes(id)) data.dismissed.push(id);
        localStorage.setItem(_ONBOARDING_LS_KEY, JSON.stringify(data));
    } catch (_) {}
}

function _onboardingBumpSession() {
    try {
        const raw = localStorage.getItem(_ONBOARDING_LS_KEY);
        const data = raw ? JSON.parse(raw) : { sessions: 0, dismissed: [] };
        data.sessions = (data.sessions || 0) + 1;
        localStorage.setItem(_ONBOARDING_LS_KEY, JSON.stringify(data));
    } catch (_) {}
}

// Show a tooltip over the given anchor element. id is used to skip
// once dismissed; placement is 'below' or 'above'.
function _showOnboardingTip({ id, anchor, text, placement = 'below' }) {
    if (!anchor) return;
    if (_onboardingTipDismissed(id)) return;
    if (_onboardingSessionCount() > _ONBOARDING_SESSION_THRESHOLD) return;

    // Don't double-attach to the same anchor.
    if (anchor.dataset && anchor.dataset.onboardingShown === '1') return;
    anchor.dataset.onboardingShown = '1';

    const tip = document.createElement('div');
    tip.className = `onboarding-tip onboarding-tip-${placement}`;
    tip.innerHTML = `
        <i class="fa-solid fa-circle-info"></i>
        <span>${escapeHtml(text)}</span>
        <button class="onboarding-tip-x" aria-label="Dismiss">&times;</button>
    `;

    const rect = anchor.getBoundingClientRect();
    tip.style.position = 'fixed';
    if (placement === 'above') {
        tip.style.top = `${rect.top - 8}px`;
        tip.style.left = `${rect.left + rect.width / 2}px`;
        tip.style.transform = 'translate(-50%, -100%)';
    } else {
        tip.style.top = `${rect.bottom + 8}px`;
        tip.style.left = `${rect.left + rect.width / 2}px`;
        tip.style.transform = 'translate(-50%, 0)';
    }
    tip.style.zIndex = '10300';

    document.body.appendChild(tip);
    tip.querySelector('.onboarding-tip-x').addEventListener('click', () => {
        _onboardingMarkDismissed(id);
        tip.remove();
    });
    // Auto-dismiss after 8s.
    setTimeout(() => { tip.remove(); }, 8000);
}

// Drive onboarding tips for the surfaces operators most need to find.
function _kickOnboardingTips() {
    if (_onboardingSessionCount() > _ONBOARDING_SESSION_THRESHOLD) return;
    // Tools menu - show 1.5 s after page idles so the operator's eye
    // is settled. Anchor by the Tools dropdown button.
    setTimeout(() => {
        const toolsBtn = document.querySelector('#cmd-tools-dropdown > button');
        _showOnboardingTip({
            id: 'tools-intro',
            anchor: toolsBtn,
            text: 'Analytics, exports and language are tucked under Tools - fewer buttons, same features.',
            placement: 'below',
        });
    }, 1500);
}

function _openKeyboardShortcutsModal() {
    // Bail if one is already open.
    if (document.getElementById('kbd-shortcuts-modal')) return;
    const overlay = document.createElement('div');
    overlay.id = 'kbd-shortcuts-modal';
    overlay.className = 'bc-reason-modal-overlay';   // reuse the J.3 modal overlay styles
    overlay.innerHTML = `
        <div class="bc-reason-modal kbd-shortcuts-modal" role="dialog" aria-modal="true">
            <div class="bc-reason-modal-head">
                <i class="fa-regular fa-keyboard" style="color:#a78bfa;"></i>
                <h3>Keyboard shortcuts</h3>
            </div>
            <div class="kbd-shortcuts-grid">
                <kbd>?</kbd><span>Show this cheat-sheet</span>
                <kbd>Esc</kbd><span>Close panel / dropdown / modal</span>
                <kbd>←</kbd><kbd>→</kbd><span>Cycle photo resolution (LOW / MED / HIGH)</span>
                <kbd>v</kbd><span>Open the verdict dropdown</span>
                <kbd>s</kbd><span>Run satellite verification</span>
                <kbd>b</kbd><span>Open the building console (if linked)</span>
                <kbd>Cmd/Ctrl + Enter</kbd><span>Submit a reason modal</span>
            </div>
            <div class="bc-reason-modal-actions">
                <button class="bc-reason-modal-submit"
                        style="background:rgba(167,139,250,0.18);color:#c4b5fd;border-color:rgba(167,139,250,0.45);"
                        onclick="document.getElementById('kbd-shortcuts-modal').remove()">
                    Got it
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (ev) => {
        if (ev.target === overlay) overlay.remove();
    });
    const escHandler = (ev) => {
        if (ev.key === 'Escape') {
            overlay.remove();
            document.removeEventListener('keydown', escHandler);
        }
    };
    document.addEventListener('keydown', escHandler);
}

// Phase 2: keyboard shortcuts (← / →) to cycle tiers when the detail panel
// is open and focused. Non-intrusive: falls through if focus is on an input.
document.addEventListener('keydown', (e) => {
    if (!selectedId) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const panel = document.getElementById('detail-panel');
    if (!panel || panel.style.display === 'none') return;
    const r = allReports.find(x => x.id === selectedId);
    if (!r) return;
    const images = r.media?.filter(m => m.type === 'IMAGE') || [];
    const group = groupPhotos(images)[0];
    if (!group) return;
    // Phase L (May 2026) - canonical SMALL/MEDIUM/ORIGINAL.
    const tiersInOrder = ['SMALL', 'MEDIUM', 'ORIGINAL'];
    const current = _tierOverride.get(selectedId) ||
        (bestVariant(group)?.tier) || 'ORIGINAL';
    const idx = tiersInOrder.indexOf(current);
    if (idx < 0) return;
    const nextIdx = e.key === 'ArrowRight'
        ? Math.min(tiersInOrder.length - 1, idx + 1)
        : Math.max(0, idx - 1);
    if (nextIdx === idx) return;
    const nextTier = tiersInOrder[nextIdx];
    // Only move if the target tier is complete.
    const m = group.members.find(x => x.resolution_tier === nextTier &&
                                       x.assembly_status === 'complete' && x.url);
    if (!m) return;
    const btn = document.querySelector(
        `#dp-img-view-${selectedId} .dp-tier-switcher .dp-tier-btn.dp-tier-${nextTier.toLowerCase()}`);
    window.setDetailImageTier(selectedId, group.group_id || '', nextTier, btn);
    e.preventDefault();
});

// ── Satellite Truth Verification ─────────────────────────────────────────────

/**
 * Render the verification result section inside the detail panel.
 * Called during detail-panel render if r.verification exists.
 */
function renderVerificationSection(r) {
    const v = r.verification;
    if (!v) return ''; // Not yet verified - section absent until user triggers it

    const scores   = v.scores || {};
    const total    = v.total_score || 0;
    const verdict  = v.verdict   || 'UNVERIFIED';
    const verdictLabels = {
        STRONGLY_CORROBORATED: 'Strongly Corroborated',
        LIKELY_AUTHENTIC:      'Likely Authentic',
        PARTIALLY_VERIFIED:    'Partially Verified',
        LOW_CONFIDENCE:        'Low Confidence',
        UNVERIFIED:            'Unverified',
    };

    // SVG gauge - circle r=30, circumference = 188.5
    const C      = 188.5;
    const offset = C - (total / 100) * C;
    const gaugeColor = total >= 80 ? '#22c55e'
                     : total >= 60 ? '#86efac'
                     : total >= 40 ? '#eab308'
                     : total >= 20 ? '#f97316'
                     :               '#ef4444';

    // Component bar colours (each out of 25)
    const barPct = (val) => Math.round(((val || 0) / 25) * 100);
    const barCol = (val) => val >= 20 ? '#22c55e' : val >= 13 ? '#eab308' : '#ef4444';

    // Temporal gap chip
    const gap       = v.satellite_days_gap;
    let gapChip = '';
    if (gap !== null && gap !== undefined) {
        if (gap < 0) {
            gapChip = `<span class="sat-meta-chip chip-good"><i class="fa-solid fa-calendar-check"></i> Post-incident (${Math.abs(gap)}d after)</span>`;
        } else if (gap === 0) {
            gapChip = `<span class="sat-meta-chip chip-good"><i class="fa-solid fa-calendar-day"></i> Same day</span>`;
        } else if (gap <= 7) {
            gapChip = `<span class="sat-meta-chip chip-warn"><i class="fa-solid fa-calendar"></i> ${gap}d before report</span>`;
        } else {
            gapChip = `<span class="sat-meta-chip chip-alert"><i class="fa-solid fa-calendar-xmark"></i> ${gap}d before report</span>`;
        }
    }

    // Cloud cover chip
    const cloud = v.satellite_cloud_cover_pct;
    let cloudChip = '';
    if (cloud !== null && cloud !== undefined) {
        const cls = cloud < 20 ? 'chip-good' : cloud < 50 ? 'chip-warn' : 'chip-alert';
        cloudChip = `<span class="sat-meta-chip ${cls}"><i class="fa-solid fa-cloud"></i> ${cloud}% cloud</span>`;
    } else {
        cloudChip = `<span class="sat-meta-chip chip-info"><i class="fa-solid fa-cloud"></i> Cloud: N/A</span>`;
    }

    // User photo src (first IMAGE media)
    const img = r.media?.find(m => m.type === 'IMAGE');
    const userImgSrc = img?.url ? getMediaUrl(img.url) : (img?.thumbnail_url ? getMediaUrl(img.thumbnail_url) : '');

    const satImgSrc = v.satellite_image_url ? getMediaUrl(v.satellite_image_url) : '';

    // Key findings
    const findings = (v.key_findings || []).map(f =>
        `<div class="sat-finding-item"><i class="fa-solid fa-circle-dot" style="color:var(--info);"></i>${f}</div>`
    ).join('');

    // Caveats
    const caveats = (v.caveats || []).map(c =>
        `<div class="sat-caveat-item"><i class="fa-solid fa-triangle-exclamation"></i>${c}</div>`
    ).join('');

    // Scored-at time
    const scoredAt = v.scored_at ? timeAgo(v.scored_at) : '';

    return `
    <div class="detail-section" id="sat-verify-section">
        <div class="detail-section-title">
            <i class="fa-solid fa-satellite" style="color:var(--info);"></i>
            Satellite Verification
            <span style="font-size:12px; color:var(--text-dim); font-weight:400; margin-left:4px;">${scoredAt}</span>
        </div>

        ${v.error && total === 0 ? `
        <div style="padding:10px; background:rgba(239,68,68,0.08); border:1px solid rgba(239,68,68,0.2); border-radius:8px; font-size:14px; color:#fca5a5; margin-bottom:10px;">
            <i class="fa-solid fa-triangle-exclamation"></i> ${v.error}
        </div>` : ''}

        <!-- Image comparison -->
        <div class="sat-compare-strip">
            <div class="sat-compare-frame">
                <div class="sat-compare-label"><i class="fa-solid fa-user"></i> Reporter Photo</div>
                ${userImgSrc
                    ? `<img src="${userImgSrc}" class="sat-compare-img" onclick="openGallery('${r.id}', 0)" title="Click to open gallery">`
                    : `<div class="sat-compare-img" style="display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-dim);">No photo</div>`
                }
            </div>
            <div class="sat-compare-frame">
                <div class="sat-compare-label"><i class="fa-solid fa-satellite"></i> Satellite View</div>
                ${satImgSrc
                    ? `<img src="${satImgSrc}" class="sat-compare-img" onclick="openLightbox('${satImgSrc}','Satellite')" title="Click to enlarge - ${v.satellite_source || ''}">`
                    : `<div class="sat-compare-img" style="display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text-dim);">Unavailable</div>`
                }
            </div>
        </div>

        <!-- Satellite metadata chips -->
        <div class="sat-meta-row">
            <span class="sat-meta-chip chip-info"><i class="fa-solid fa-satellite-dish"></i> ${v.satellite_source || 'Unknown source'}</span>
            ${gapChip}
            ${cloudChip}
            ${v.satellite_resolution_m ? `<span class="sat-meta-chip"><i class="fa-solid fa-ruler"></i> ${v.satellite_resolution_m}m/px</span>` : ''}
        </div>

        <!-- Score gauge + verdict -->
        <div class="sat-score-block">
            <div class="sat-gauge">
                <svg width="68" height="68" viewBox="0 0 68 68">
                    <circle class="sat-gauge-track" cx="34" cy="34" r="28"/>
                    <circle class="sat-gauge-fill"
                        cx="34" cy="34" r="28"
                        stroke="${gaugeColor}"
                        stroke-dasharray="${C}"
                        stroke-dashoffset="${offset.toFixed(1)}"/>
                </svg>
                <div class="sat-gauge-label">
                    <span class="sat-gauge-num" style="color:${gaugeColor};">${total}</span>
                    <span class="sat-gauge-denom">/100</span>
                </div>
            </div>
            <div class="sat-score-info">
                <div class="sat-verdict verdict-${verdict}">${verdictLabels[verdict] || verdict}</div>
                ${v.satellite_scene_description
                    ? `<div style="font-size:12px;color:var(--text-sub);line-height:1.4;">${v.satellite_scene_description}</div>`
                    : ''}
            </div>
        </div>

        <!-- Component breakdown bars -->
        <div class="sat-components">
            <div class="sat-comp-row">
                <span class="sat-comp-label">Location Match</span>
                <div class="sat-comp-bar"><div class="sat-comp-fill" style="width:${barPct(scores.location_authenticity)}%; background:${barCol(scores.location_authenticity)};"></div></div>
                <span class="sat-comp-val">${scores.location_authenticity ?? '-'}/25</span>
            </div>
            <div class="sat-comp-row">
                <span class="sat-comp-label">Damage Evidence</span>
                <div class="sat-comp-bar"><div class="sat-comp-fill" style="width:${barPct(scores.damage_corroboration)}%; background:${barCol(scores.damage_corroboration)};"></div></div>
                <span class="sat-comp-val">${scores.damage_corroboration ?? '-'}/25</span>
            </div>
            <div class="sat-comp-row">
                <span class="sat-comp-label">Description Match</span>
                <div class="sat-comp-bar"><div class="sat-comp-fill" style="width:${barPct(scores.description_coherence)}%; background:${barCol(scores.description_coherence)};"></div></div>
                <span class="sat-comp-val">${scores.description_coherence ?? '-'}/25</span>
            </div>
            <div class="sat-comp-row">
                <span class="sat-comp-label">Data Quality</span>
                <div class="sat-comp-bar"><div class="sat-comp-fill" style="width:${barPct(scores.data_quality)}%; background:${barCol(scores.data_quality)};"></div></div>
                <span class="sat-comp-val">${scores.data_quality ?? '-'}/25</span>
            </div>
        </div>

        ${findings ? `<div class="sat-findings">${findings}</div>` : ''}
        ${caveats  ? `<div class="sat-findings">${caveats}</div>` : ''}

        ${v.reasoning ? `<div class="sat-reasoning">${v.reasoning}</div>` : ''}
    </div>`;
}

/**
 * Trigger verification for a report - calls POST /api/v1/reports/{id}/verify.
 * Shows loading state on the button, then refreshes the detail panel on completion.
 */
window.runVerification = async (id) => {
    const btn = document.getElementById(`btn-verify-${id}`);
    if (btn) {
        btn.classList.add('verifying');
        btn.innerHTML = '<i class="fa-solid fa-satellite fa-spin"></i> Fetching satellite...';
        btn.disabled = true;
    }
    try {
        const res = await fetch(`${API}/${id}/verify`, { method: 'POST' });
        if (res.ok) {
            const verif = await res.json();
            // Merge verification result into allReports so re-render shows it
            const idx = allReports.findIndex(r => r.id === id);
            if (idx >= 0) allReports[idx] = { ...allReports[idx], verification: verif };
            showToast(`Truth score: ${verif.total_score}/100 - ${verif.verdict?.replace(/_/g,' ')}`, 'success');
            selectReport(id, true); // re-render detail panel, skip map fly
        } else {
            const err = await res.json().catch(() => ({}));
            const errMsg = err.detail || (res.status === 503 ? 'Satellite service unavailable - check API keys' : `Server error (${res.status})`);
            showToast(`Verification failed: ${errMsg}`, 'error');
            if (btn) {
                btn.classList.remove('verifying');
                btn.innerHTML = '<i class="fa-solid fa-satellite"></i> Verify with Satellite';
                btn.disabled = false;
            }
        }
    } catch (e) {
        showToast('Verification request failed - check internet connection', 'error');
        if (btn) {
            btn.classList.remove('verifying');
            btn.innerHTML = '<i class="fa-solid fa-satellite"></i> Verify with Satellite';
            btn.disabled = false;
        }
    }
};

// ── Phase F image-reliability (May 2026) - Reclaim modal + handler
//
// Operator clicks the Reclaim button on the detail-panel gallery chip
// (only present when at least one HIGH-tier variant is in `lost` or
// `delayed` state). This opens a small choice modal: Retry assembly
// vs Mark abandoned. Each mode POSTs to /api/v1/reports/media/{id}/reclaim
// in a small batch (one request per HIGH-tier media id; client-side
// concurrency 3 - keeps the backend's per-report audit log readable).
//
// Why a modal and not a one-click action: the wrong mode can lose a
// recoverable upload (if chunks WERE all there, mark_abandoned drops
// the row to terminal failed without trying to assemble) or surface
// a misleading "Retry assembly" 400 (if chunks weren't all there).
// The modal explains the difference + lets the operator pick the
// right mode given the per-media chunks_received counter.
window._openMediaReclaimModal = (reportId, triggerBtn) => {
    if (!triggerBtn) return;
    let _reclaimables;
    try {
        _reclaimables = JSON.parse(triggerBtn.getAttribute('data-media-ids') || '[]');
    } catch (e) {
        _reclaimables = [];
    }
    if (!_reclaimables.length) {
        showToast('No reclaimable media on this report.', 'info');
        return;
    }
    // Strip any prior reclaim modal - only one at a time.
    document.querySelectorAll('.reclaim-modal-backdrop').forEach(n => n.remove());
    const rows = _reclaimables.map(m => `
        <div class="reclaim-row">
            <code>${escapeHtml(m.id.slice(0, 8))}…</code>
            <span class="reclaim-row-state reclaim-row-state-${m.state}">${m.state}</span>
            <span class="reclaim-row-chunks">${escapeHtml(m.chunks)} chunks</span>
            ${m.reason ? `<span class="reclaim-row-reason">${escapeHtml(m.reason)}</span>` : ''}
        </div>
    `).join('');
    const backdrop = document.createElement('div');
    backdrop.className = 'reclaim-modal-backdrop';
    backdrop.innerHTML = `
        <div class="reclaim-modal">
            <h3><i class="fa-solid fa-wrench"></i> Reclaim stuck originals</h3>
            <p class="reclaim-modal-blurb">
                <strong>${_reclaimables.length}</strong> HIGH-tier upload(s) need operator action.
                <strong>Retry assembly</strong> only works when all chunks ARE on disk
                (the worker died); <strong>Mark abandoned</strong> is for uploads where the
                reporter's device never finished delivering chunks.
            </p>
            <div class="reclaim-rows">${rows}</div>
            <div class="reclaim-modal-actions">
                <button class="reclaim-modal-cancel" onclick="this.closest('.reclaim-modal-backdrop').remove()">
                    Cancel
                </button>
                <button class="reclaim-modal-retry"
                        onclick="_runMediaReclaim('${reportId}', 'retry_assembly', this)">
                    <i class="fa-solid fa-rotate"></i> Retry assembly
                </button>
                <button class="reclaim-modal-abandon"
                        onclick="_runMediaReclaim('${reportId}', 'mark_abandoned', this)">
                    <i class="fa-solid fa-circle-xmark"></i> Mark abandoned
                </button>
            </div>
        </div>`;
    backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.remove();
    });
    document.body.appendChild(backdrop);
    // Store the reclaimables on the modal so the action handlers can
    // pick them up without re-reading the trigger button (which may
    // have re-rendered between open + click).
    backdrop._reclaimables = _reclaimables;
};

// Operator clicked "Retry assembly" or "Mark abandoned" inside the modal.
// Fans out N POST requests in batches of 3 (client-side concurrency
// cap so the audit log stays readable). Surfaces per-item success/fail
// via toast; on completion, closes the modal and re-renders the
// detail panel via selectReport so the chip updates.
window._runMediaReclaim = async (reportId, mode, actionBtn) => {
    const backdrop = actionBtn.closest('.reclaim-modal-backdrop');
    if (!backdrop) return;
    const reclaimables = backdrop._reclaimables || [];
    if (!reclaimables.length) {
        backdrop.remove();
        return;
    }
    // Disable both action buttons during the run.
    backdrop.querySelectorAll('button').forEach(b => b.disabled = true);
    actionBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Running…';

    let ok = 0, fail = 0;
    const errors = [];
    // Run sequentially with a small await - the per-call backend cost
    // is cheap and serial keeps the order predictable for the audit log.
    for (const m of reclaimables) {
        try {
            const res = await fetch(`${API}/media/${m.id}/reclaim`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('crisp_token') || ''}`,
                },
                body: JSON.stringify({ mode }),
            });
            if (res.ok) {
                ok += 1;
            } else {
                fail += 1;
                const err = await res.json().catch(() => ({}));
                errors.push(`${m.id.slice(0, 8)}: ${err.detail || res.status}`);
            }
        } catch (e) {
            fail += 1;
            errors.push(`${m.id.slice(0, 8)}: ${e.message || 'network error'}`);
        }
    }
    const modeLabel = mode === 'retry_assembly' ? 'retry' : 'mark abandoned';
    if (ok > 0 && fail === 0) {
        showToast(`Reclaim ${modeLabel}: ${ok}/${reclaimables.length} succeeded`, 'success');
    } else if (ok > 0 && fail > 0) {
        showToast(`Reclaim ${modeLabel}: ${ok} OK, ${fail} failed - see console`, 'warning');
        console.warn('Reclaim errors:', errors);
    } else {
        showToast(`Reclaim ${modeLabel}: ${fail} failed - see console`, 'error');
        console.warn('Reclaim errors:', errors);
    }
    backdrop.remove();
    // Re-render the detail panel so the chip picks up the new state.
    // selectReport(reportId, true) skips the map fly + re-renders only
    // the right-side panel.
    try { selectReport(reportId, true); } catch (_) {}
    // Force a fresh /reports/ fetch on the next poll tick so the new
    // abandoned_at / abandon_reason fields land in allReports.
    if (typeof window.__crispFetchReports === 'function') {
        try { window.__crispFetchReports(); } catch (_) {}
    }
};


// Phase C.2 (May 2026, UNDP-grade rebuild) - copy a public, auth-free
// evidence URL to the clipboard. The verification panel exposes a
// "Share evidence" button that calls this. Resolves to a static
// page (web-dashboard/src/evidence.html) which fetches the public
// /api/v1/reports/<id>/evidence endpoint - no login needed.
//
// Trust model matches the existing presigned-URL behaviour: report_id
// is a UUID, unguessable. UNDP judges click the link and instantly see
// a clean truth-score card with photo + 4 satellite sources.
window.copyEvidenceLink = async (reportId) => {
    if (!reportId) return;
    // Compose the URL using the page's own origin so the link works
    // whether the dashboard is at undp.crisplabs.tech, localhost:8080,
    // or a staging host. The path mirrors the dashboard's static layout.
    const url = `${window.location.origin}${window.location.pathname.replace(/[^/]*$/, '')}evidence.html?id=${encodeURIComponent(reportId)}`;
    try {
        // Modern Async Clipboard API. Requires HTTPS (or localhost) +
        // user-gesture context - both satisfied here (button click).
        await navigator.clipboard.writeText(url);
        showToast('Evidence link copied - share with judges or partners', 'success');
    } catch (e) {
        // Fallback: surface the URL in a prompt so the analyst can
        // still grab it. Triggers when navigator.clipboard is missing
        // (older browsers, insecure origins) or permissions are denied.
        try {
            window.prompt('Copy this evidence link:', url);
        } catch (_) {
            showToast('Copy failed - paste manually: ' + url, 'error');
        }
    }
};

// ── Credibility Check (on-demand, full incident analysis) ────────────────────
window.runAIAssessment = async (id) => {
    const r = allReports.find(x => x.id === id);
    if (!r) return;

    // Block if already assessed - prevent duplicate API calls
    if (r.ai_assessment) {
        showToast('Credibility check already completed for this incident', 'info');
        return;
    }

    const topBtn = document.querySelector('.dp-run-ai-btn');
    if (topBtn) {
        topBtn.disabled = true;
        topBtn.innerHTML = '<i class="fa-solid fa-brain fa-spin"></i> Analyzing…';
    }

    // Build full multi-signal payload for AI (shared with runFullAssessment).
    const payload = _buildAiAssessPayload(r);

    try {
        const res = await fetch(`${BACKEND_HOST}/api/v1/reports/${id}/ai-assess`, {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
        });
        if (res.ok) {
            const data = await res.json();
            const summary = data.summary || 'No summary available.';
            const details = data.details || '';
            const action = data.suggested_action || '';
            const confScore = data.confidence_score ?? null;
            const actionColor = action.includes('Dispatch') ? '#22c55e' : action.includes('False') ? '#ef4444' : action.includes('Suspicious') ? '#f97316' : action.includes('Monitor') ? '#eab308' : '#94a3b8';
            // Store in report object and update classification from AI inference
            const idx = allReports.findIndex(x => x.id === id);
            if (idx >= 0) {
                allReports[idx].ai_assessment = data;
                // Update type/severity from AI (replaces old AI Extractor)
                if (data.inferred_type) allReports[idx].infrastructure_type = data.inferred_type;
                if (data.inferred_severity) allReports[idx].severity = data.inferred_severity;
            }
            // Re-render - top bar shows AI score, tree view updates type/severity
            selectReport(id, true);
            renderFeed();
            showToast(`Credibility: ${confScore}/100 - ${action}`, 'success');
        } else {
            showToast('Credibility check failed', 'error');
            if (topBtn) { topBtn.disabled = false; topBtn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Credibility Check'; }
        }
    } catch (e) {
        showToast('Credibility check request failed', 'error');
        if (topBtn) { topBtn.disabled = false; topBtn.innerHTML = '<i class="fa-solid fa-shield-halved"></i> Credibility Check'; }
    }
};

// ── PDF Export ────────────────────────────────────────────────────────────────
// Fetch an image URL and inline it as a data: URI so it is EMBEDDED in the
// printed / "Save as PDF" output at full quality with no load race. Falls back
// to the original URL if the fetch is blocked (e.g. S3 CORS in prod) - a plain
// <img src> still prints, just without the embed guarantee.
async function _imgToDataUrl(url) {
    if (!url) return '';
    if (url.startsWith('data:')) return url;
    try {
        const res = await fetch(url, { headers: _authHeaders() });
        if (!res.ok) return url;
        const blob = await res.blob();
        if (blob.size > 14 * 1024 * 1024) return url;   // don't inline huge originals
        return await new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result || url);
            fr.onerror = () => resolve(url);
            fr.readAsDataURL(blob);
        });
    } catch (_e) { return url; }
}

// Full, printable A4-portrait incident report. Captures 100% of the captured /
// generated / stored information section-by-section: overview, the Confidence
// Assessment (score + per-check breakdown), the AI dossier, full satellite
// analysis, location & building, description / transcript, crisis-pack answers,
// service status, evidence & metadata checks, corroboration / duplicates, all
// images (embedded), media summary, and the history / audit trail. Async: pulls
// the FULL report by id + the audit trail + duplicate candidates, and embeds
// images as data URIs before writing the document.
window.exportPDF = async (id) => {
    // Open the window synchronously to keep the click gesture (popup-blocker safe).
    const w = window.open('', '_blank', 'width=900,height=1200');
    if (w) { try { w.document.write('<!doctype html><meta charset="utf-8"><title>Generating…</title><body style="font-family:-apple-system,sans-serif;padding:48px;color:#475569;font-size:15px">Generating full incident report… one moment.</body>'); } catch (_e) {} }

    // Pull the FULL report (form_data, all media variants, ai_assessment,
    // verification, location detail…) so the PDF isn't limited to list-view fields.
    let r = allReports.find(x => x.id === id) || (_detailOnlyReport && _detailOnlyReport.id === id ? _detailOnlyReport : null);
    const full = await _fetchReportByIdRaw(id);
    if (full) r = Object.assign({}, r || {}, full);
    if (!r || !r.id) { if (w) w.close(); showToast('Could not load report for export', 'error'); return; }

    // Audit trail + duplicate candidates (best-effort).
    const [auditRes, dupRes] = await Promise.all([
        fetch(`${API}/${encodeURIComponent(id)}/audit?limit=50`, { headers: _authHeaders() }).then(x => x.ok ? x.json() : { items: [] }).catch(() => ({ items: [] })),
        r.building_id ? fetch(`${API}/${encodeURIComponent(id)}/duplicates`).then(x => x.ok ? x.json() : { candidates: [] }).catch(() => ({ candidates: [] })) : Promise.resolve({ candidates: [] }),
    ]);
    const auditItems = (auditRes && auditRes.items) || [];
    const dupCands = (dupRes && dupRes.candidates) || [];

    const loc = r.location, v = r.verification, aa = r.ai_assessment, ic = r.incident_credibility, ai = r.ai_analysis, ci = r.caller_info, ss = r.service_status || {};
    const srcLabel = { APP: 'Mobile App', ANDROID: 'Android App', WHATSAPP: 'WhatsApp', TELEGRAM: 'Telegram', SMS: 'SMS', IVR: 'Voice Call' }[r.source] || r.source || '';

    // Images: highest-quality complete variant per photo group + satellite, embedded.
    const photoGroups = groupPhotos((r.media || []).filter(m => m.type === 'IMAGE'));
    const photoSrcs = photoGroups.map(g => highestCompleteVariant(g)).filter(Boolean).map(x => x.src);
    const satMeta = [];
    if (v && v.satellite_image_url) satMeta.push({ src: getMediaUrl(v.satellite_image_url), label: (v.satellite_source || 'Satellite').split('(')[0].trim(), ts: v.satellite_acquisition_date ? fmtDateOnly(v.satellite_acquisition_date) : '' });
    if (v && v.satellite_image_url_alt) satMeta.push({ src: getMediaUrl(v.satellite_image_url_alt), label: (v.satellite_source_alt || 'Alt satellite').split('(')[0].trim(), ts: v.satellite_acquisition_date_alt ? fmtDateOnly(v.satellite_acquisition_date_alt) : '' });
    const [photoData, satData] = await Promise.all([
        Promise.all(photoSrcs.map(_imgToDataUrl)),
        Promise.all(satMeta.map(s => _imgToDataUrl(s.src))),
    ]);

    // ── builders ──
    const esc = escapeHtml;
    const row = (k, val) => (val !== '' && val != null) ? `<div class="row"><span class="k">${esc(k)}</span><span class="v">${val}</span></div>` : '';
    const sec = (title, body) => (body && String(body).trim()) ? `<div class="section"><div class="section-title">${esc(title)}</div>${body}</div>` : '';
    const ul = (arr) => (Array.isArray(arr) && arr.length) ? `<ul class="lst">${arr.map(x => `<li>${esc(String(x))}</li>`).join('')}</ul>` : '';
    const yn = (b) => b === true ? 'Yes' : (b === false ? 'No' : '');
    const ds = (typeof _displayStatus === 'function') ? _displayStatus(r) : { label: r.status };

    // 1 · Overview - lead with the hierarchy (Operation › Building) so the exported
    // report never loses its parent context. Building name is OSM-only (placeholders
    // when a level is absent), matching the on-screen breadcrumb.
    const overview =
        row('Operation', esc(_opCrumbName(r) || _HIER_OP_ABSENT))
        + row('Building', esc(_bldgCrumbName(r) || _HIER_BLDG_ABSENT))
        + row('Incident type', esc(infraDisplayLabel(r.infrastructure_type, r.infrastructure_sub_type)))
        + row('Severity', esc(r.severity || ''))
        + row('Status', esc(ds.label || r.status || ''))
        + (r.reviewer_verdict && r.reviewer_verdict !== 'NOT_REVIEWED' ? row('Review verdict', esc(r.reviewer_verdict)) : '')
        + row('Channel', esc(srcLabel))
        + (r.crisis_type ? row('Crisis type', esc(_dupTitle(r.crisis_type))) : '')
        + (r.damage_classification ? row('Damage classification', esc(_dupTitle(r.damage_classification))) : '')
        + (r.debris_clearing_needed != null ? row('Debris clearing needed', yn(r.debris_clearing_needed)) : '')
        + row('Reporter', esc(r.reporter_badge || r.reporter_tier || (r.user_id ? 'User ' + String(r.user_id).replace(/-/g, '').slice(0, 8) : 'Anonymous')))
        + row('Reported', esc(fmtDateTime(r.server_created_at)))
        + (r.client_created_at ? row('Captured on device', esc(fmtDateTime(r.client_created_at))) : '')
        + (r.reviewed_at ? row('Reviewed', esc(fmtDateTime(r.reviewed_at))) : '')
        + (r.reviewed_by ? row('Reviewer', esc(String(r.reviewed_by).replace(/-/g, '').slice(0, 8))) : '')
        + (Number.isFinite(r.response_time_seconds) ? row('Response time', esc(_fmtDuration(r.response_time_seconds))) : '')
        + (ci && ci.phone ? row('Caller', esc(ci.phone)) : '')
        + (ci && ci.network_location ? row('Telecom circle', esc(ci.network_location)) : '');

    // 2 · Confidence assessment (the system-only automated score)
    let assessHtml;
    if (ic && ic.assessed && ic.score != null) {
        const meta = _credBandMeta(ic.band);
        const fr = (ic.factors || []).map(f => `<tr><td>${esc(f.label)}</td><td class="num">${f.ran ? '+' + f.awarded : '—'} / ${f.max}</td><td class="rsn">${esc(f.reason || '')}</td></tr>`).join('');
        const eq = (ic.factors || []).filter(f => f.ran && f.awarded > 0).map(f => '+' + f.awarded).join('  ') || '+0';
        assessHtml =
            `<div class="score-hd"><span class="score-big" style="color:${meta.color}">${ic.score}<span class="score-den">/100</span></span><span class="score-band" style="color:${meta.color}">${esc(meta.word)}</span><span class="score-sub">${ic.ran_count} of ${ic.total_checks} checks ran${ic.assessed_at ? ' · assessed ' + esc(fmtDateTime(ic.assessed_at)) : ''}</span></div>`
            + `<table class="tbl"><thead><tr><th>Automated check</th><th class="num">Points</th><th>Evidence</th></tr></thead><tbody>${fr}</tbody></table>`
            + `<div class="eq">${eq} = <strong>${ic.score}</strong> / 100</div>`
            + `<div class="note">System-only automated score (AI content 30 · Satellite 25 · Location 15 · Corroboration 15 · Reporter 15 = 100). An analyst's accept/reject verdict never changes it.</div>`;
    } else {
        assessHtml = `<div class="muted">Not yet assessed — run "AI-Assisted Report Assessment" in the dashboard to compute the Confidence Score.</div>`;
    }

    // 3 · AI dossier
    let aiHtml = '';
    if (aa && (aa.summary || aa.confidence_score != null || aa.reasoning)) {
        const sb = aa.score_breakdown || {};
        const sbRows = Object.keys(sb).map(k => row(_humanizeFormKey(k), esc(String(sb[k])))).join('');
        aiHtml =
            (aa.confidence_score != null ? row('AI confidence', esc(aa.confidence_score + '/100')) : '')
            + (aa.priority_level ? row('Priority', esc(String(aa.priority_level).replace(/_/g, ' '))) : '')
            + (aa.suggested_action ? row('Suggested action', esc(aa.suggested_action)) : '')
            + (aa.lives_at_risk_estimate ? row('Lives at risk (est.)', esc(String(aa.lives_at_risk_estimate))) : '')
            + (aa.inferred_severity ? row('Inferred severity', esc(aa.inferred_severity)) : '')
            + (aa.inferred_crisis_type ? row('Inferred crisis type', esc(aa.inferred_crisis_type)) : '')
            + (aa.inferred_damage_class ? row('Inferred damage', esc(aa.inferred_damage_class)) : '')
            + (aa.summary ? `<div class="sub-t">Executive summary</div><div class="desc">${esc(aa.summary)}</div>` : '')
            + (aa.reasoning ? `<div class="sub-t">Reasoning</div><div class="desc">${esc(aa.reasoning)}</div>` : '')
            + (Array.isArray(aa.key_factors) && aa.key_factors.length ? `<div class="sub-t">Key factors</div>${ul(aa.key_factors)}` : '')
            + (Array.isArray(aa.risk_flags) && aa.risk_flags.length ? `<div class="sub-t">Risk flags</div>${ul(aa.risk_flags)}` : '')
            + (sbRows ? `<div class="sub-t">Score breakdown</div>${sbRows}` : '');
    }

    // 4 · Satellite verification (full)
    let satHtml = '';
    if (v) {
        if (v.error) satHtml = `<div class="muted">Could not run: ${esc(v.error)}</div>`;
        else {
            const sc = v.scores || {};
            const gapTxt = (typeof v.satellite_days_gap === 'number') ? (v.satellite_days_gap === 0 ? 'same day' : v.satellite_days_gap > 0 ? v.satellite_days_gap + 'd before' : Math.abs(v.satellite_days_gap) + 'd after') + ' incident' : '';
            satHtml =
                row('Truth score', esc((v.total_score ?? 0) + '/100'))
                + (v.verdict ? row('Verdict', esc(String(v.verdict).replace(/_/g, ' '))) : '')
                + (typeof sc.location_authenticity === 'number' ? row('Location authenticity', esc(sc.location_authenticity + '/25')) : '')
                + (typeof sc.damage_corroboration === 'number' ? row('Damage corroboration', esc(sc.damage_corroboration + '/25')) : '')
                + (typeof sc.description_coherence === 'number' ? row('Description coherence', esc(sc.description_coherence + '/25')) : '')
                + (typeof sc.data_quality === 'number' ? row('Data quality', esc(sc.data_quality + '/25')) : '')
                + (typeof v.satellite_cloud_cover_pct === 'number' ? row('Cloud cover', esc(v.satellite_cloud_cover_pct.toFixed(0) + '%')) : '')
                + (v.satellite_acquisition_date ? row('Imagery date', esc(fmtDateOnly(v.satellite_acquisition_date) + (gapTxt ? ' (' + gapTxt + ')' : ''))) : '')
                + (v.satellite_source ? row('Source', esc(v.satellite_source)) : '')
                + (v.satellite_scene_description ? `<div class="sub-t">Scene</div><div class="desc">${esc(v.satellite_scene_description)}</div>` : '')
                + (v.reasoning ? `<div class="sub-t">Analysis</div><div class="desc">${esc(v.reasoning)}</div>` : '')
                + (v.photo_analysis ? `<div class="sub-t">Photo vs satellite</div><div class="desc">${esc(v.photo_analysis)}</div>` : '')
                + (Array.isArray(v.key_findings) && v.key_findings.length ? `<div class="sub-t">Key findings</div>${ul(v.key_findings)}` : '')
                + (Array.isArray(v.caveats) && v.caveats.length ? `<div class="sub-t">Caveats</div>${ul(v.caveats)}` : '');
        }
    }

    // 5 · Location & building
    const locName = loc ? (loc.user_location_name || loc.device_location_name || ((loc.latitude != null) ? `${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)}` : 'Unknown')) : 'Unknown';
    const locHtml =
        row('Location name', esc(locName))
        + (loc && loc.latitude != null ? row('Coordinates', esc(loc.latitude.toFixed(5) + ', ' + loc.longitude.toFixed(5))) : '')
        + (loc && typeof loc.accuracy_meters === 'number' ? row('GPS accuracy', esc('±' + Math.round(loc.accuracy_meters) + ' m')) : '')
        + (loc && loc.device_location_name && loc.device_location_name !== loc.user_location_name ? row('Device GPS place', esc(loc.device_location_name)) : '')
        + (loc && loc.is_user_corrected ? row('Pin adjusted by reporter', 'Yes') : '')
        + (loc && typeof loc.geocoding_confidence === 'number' ? row('Geocoding confidence', esc(Math.round(loc.geocoding_confidence * 100) + '%' + (loc.geocoding_source ? ' · ' + loc.geocoding_source : ''))) : '')
        + (loc && loc.h3_idx ? row('H3 cell', esc(loc.h3_idx)) : '')
        + (_taggedBuildingName(r)
            ? row('Building / structure', esc(r.infrastructure_name))
            : (r.infrastructure_name ? row('Reported structure (unverified)', esc(r.infrastructure_name)) : ''))
        + (r.building_id ? row('Building ID', esc(String(r.building_id).slice(0, 12))) : '')
        + (r.infrastructure_name_from_osm === false ? row('Building mapping', 'Needs mapping (free-text, not OSM)') : '');

    // 6 · Description & transcript
    let descBody =
        (r.description ? `<div class="desc">${esc(r.description)}</div>` : '')
        + (ai && ai.transcription && ai.transcription !== r.description ? `<div class="sub-t">Voice transcription</div><div class="desc">${esc(ai.transcription)}</div>` : '')
        + (ai && ai.ai_summary ? `<div class="sub-t">AI summary</div><div class="desc">${esc(ai.ai_summary)}</div>` : '');
    if (!descBody.trim()) descBody = '<div class="muted">No description provided.</div>';

    // 7 · Crisis-pack answers (form_data) - rendered with VERBATIM question +
    // option labels resolved from the pack schema (falls back to humanized codes).
    let cfHtml = '';
    if (r.form_data && typeof r.form_data === 'object' && !Array.isArray(r.form_data)) {
        const ks = Object.keys(r.form_data);
        if (ks.length) {
            let _fmap = null;
            try { if (r.form_pack_id) _fmap = await ensurePackSchema(r.form_pack_id, r.form_pack_version); } catch (_e) {}
            cfHtml = ks.map(k => row(_fdKeyLabel(k, _fmap), _fdValLabeled(r.form_data[k], k, _fmap))).join('');
        }
    }

    // 8 · Service status (app-only)
    const ssHtml = (ss.electricity || ss.water || ss.health || (Array.isArray(ss.pressing_needs) && ss.pressing_needs.length))
        ? row('Electricity', esc(ss.electricity || '')) + row('Water', esc(ss.water || '')) + row('Health', esc(ss.health || ''))
          + (Array.isArray(ss.pressing_needs) && ss.pressing_needs.length ? row('Pressing needs', esc(ss.pressing_needs.join(', '))) : '')
        : '';

    // 9 · Evidence & metadata checks (real signals)
    let metaHtml = '';
    const im0 = (r.media || []).find(m => m.type === 'IMAGE');
    if (im0) {
        if (im0.assembly_status) metaHtml += row('Photo upload', esc(im0.assembly_status));
        if (im0.full_asset_checksum) metaHtml += row('Integrity checksum', 'Recorded (' + esc(String(im0.full_asset_checksum).slice(0, 12)) + '…)');
        if (im0.client_blur_applied) metaHtml += row('Client-side face blur', 'Applied on device');
        if (im0.pii_blur_status) metaHtml += row('PII redaction', esc(String(im0.pii_blur_status).replace(/_/g, ' ')));
    }
    if (r.client_created_at && r.server_created_at) {
        let delay = '';
        try { const dmin = (new Date(ensureUTC(r.server_created_at)) - new Date(ensureUTC(r.client_created_at))) / 60000; if (isFinite(dmin)) delay = dmin < 2 ? 'received in real time' : Math.round(dmin) + ' min capture → receipt'; } catch (_e) {}
        if (delay) metaHtml += row('Timing', esc(delay));
    }

    // 10 · Corroboration & duplicates
    let dupHtml = row('Corroborating reports merged', String(r.duplicate_count || 0));
    if (dupCands.length) {
        dupHtml += `<table class="tbl"><thead><tr><th>Related report</th><th class="num">Match</th><th>Why</th></tr></thead><tbody>`
            + dupCands.map(c => `<tr><td>${esc([_dupTitle(c.crisis_type), _dupTitle(c.infrastructure_type), c.location_name].filter(Boolean).join(' · ') || String(c.report_id).slice(0, 8))}</td><td class="num">${esc((c.score != null ? c.score + '% ' : '') + (c.confidence || ''))}</td><td class="rsn">${esc((c.reasons || []).map(x => x.label || x.factor).filter(Boolean).join(', '))}</td></tr>`).join('')
            + `</tbody></table>`;
    }

    // 11 · Visual evidence (embedded)
    let imgCards = '';
    photoData.forEach((src, i) => { imgCards += `<div class="img-card"><img src="${src}" alt="Reported photo"><div class="img-label">Reported photo${photoData.length > 1 ? ' ' + (i + 1) : ''}</div></div>`; });
    satData.forEach((src, i) => { const s = satMeta[i]; imgCards += `<div class="img-card"><img src="${src}" alt="Satellite"><div class="img-label">${esc(s.label)}</div>${s.ts ? `<div class="img-ts">${esc(s.ts)}</div>` : ''}</div>`; });
    const visualHtml = imgCards ? `<div class="img-grid">${imgCards}</div>` : '';

    // 12 · Media summary
    const imgs = (r.media || []).filter(m => m.type === 'IMAGE');
    const auds = (r.media || []).filter(m => m.type === 'AUDIO');
    const mediaHtml =
        row('Attachments', esc((r.received_media ?? '?') + ' of ' + (r.expected_media ?? '?') + ' received'))
        + row('Photos', String(imgs.length))
        + row('Audio recordings', String(auds.length))
        + (auds.length ? `<div class="sub-t">Audio (not embeddable in PDF)</div>` + auds.map((a, i) => row('Recording ' + (i + 1), esc((a.assembly_status || '') + (a.duration_seconds ? ' · ' + a.duration_seconds + 's' : '')))).join('') : '');

    // 13 · History & activity
    const tl = [];
    if (r.server_created_at) tl.push({ t: r.server_created_at, label: 'Reported via ' + srcLabel });
    if (r.reviewed_at) tl.push({ t: r.reviewed_at, label: 'Reviewed' + (r.reviewer_verdict && r.reviewer_verdict !== 'NOT_REVIEWED' ? ' (' + r.reviewer_verdict + ')' : '') });
    if (r.dispatched_at) tl.push({ t: r.dispatched_at, label: 'Help dispatched' });
    if (r.resolved_at) tl.push({ t: r.resolved_at, label: 'Resolved' });
    let histHtml = tl.length ? `<div class="sub-t">Lifecycle</div>` + tl.map(e => `<div class="row"><span class="k">${esc(fmtDateTime(e.t))}</span><span class="v">${esc(e.label)}</span></div>`).join('') : '';
    if (auditItems.length) {
        const lbl = { REPORT_DISPATCH: 'Dispatched', REPORT_RESOLVE: 'Resolved', REPORT_FALSE_ALARM: 'False alarm', REPORT_ACCEPT: 'Accepted', REPORT_REJECT: 'Rejected', REPORT_DELETE: 'Deleted', REPORT_VERIFY: 'Verified' };
        histHtml += `<div class="sub-t">Admin actions (audit trail)</div>` + auditItems.map(e => {
            const who = e.user_email ? String(e.user_email).split('@')[0] : 'system';
            const reason = (e.details && e.details.action_taken) ? ' — ' + e.details.action_taken : '';
            return `<div class="row"><span class="k">${esc(e.created_at ? fmtDateTime(e.created_at) : '')}</span><span class="v">${esc((lbl[e.action] || e.action) + ' by ' + who + reason)}</span></div>`;
        }).join('');
    }

    const body =
        sec('Incident overview', overview)
        + sec('Confidence assessment', assessHtml)
        + sec('AI dossier', aiHtml)
        + sec('Satellite verification', satHtml)
        + sec('Location & building', locHtml)
        + sec('Description & transcript', descBody)
        + sec('Crisis-pack answers', cfHtml)
        + sec('Service status', ssHtml)
        + sec('Evidence & metadata checks', metaHtml)
        + sec('Corroboration & duplicates', dupHtml)
        + sec('Visual evidence', visualHtml)
        + sec('Media summary', mediaHtml)
        + sec('History & activity', histHtml);

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>CRISP Incident Report - ${esc(String(r.id).substring(0, 8))}</title>
    <style>
      @page { size: A4 portrait; margin: 12mm; }
      *{margin:0;padding:0;box-sizing:border-box;}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1e293b;font-size:11.5px;line-height:1.5;background:#fff;}
      @media screen{body{max-width:820px;margin:0 auto;padding:24px;}}
      .hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #7c3aed;padding-bottom:12px;margin-bottom:16px;}
      .hdr h1{font-size:19px;color:#7c3aed;letter-spacing:-0.3px;}
      .hdr .rid{font-size:10px;color:#64748b;font-family:monospace;display:block;margin-top:2px;}
      .badge{display:inline-block;padding:3px 9px;border-radius:12px;font-size:10px;font-weight:700;margin-left:4px;}
      .sev-CRITICAL,.sev-SEVERE{background:#fef2f2;color:#dc2626;border:1px solid #fecaca;}
      .sev-MODERATE{background:#fffbeb;color:#d97706;border:1px solid #fde68a;}
      .sev-MINOR,.sev-MINIMAL{background:#f0fdf4;color:#16a34a;border:1px solid #bbf7d0;}
      .section{margin-bottom:11px;padding:10px 14px;border:1px solid #e2e8f0;border-radius:8px;break-inside:avoid;}
      .section-title{font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:0.6px;color:#7c3aed;margin-bottom:7px;border-bottom:1px solid #ede9fe;padding-bottom:4px;}
      .row{display:flex;justify-content:space-between;gap:16px;padding:2.5px 0;}
      .row .k{color:#64748b;font-weight:600;flex:0 0 auto;}
      .row .v{color:#1e293b;text-align:right;word-break:break-word;}
      .desc{white-space:pre-wrap;color:#334155;margin:2px 0 6px;}
      .sub-t{font-size:9.5px;font-weight:800;text-transform:uppercase;letter-spacing:0.4px;color:#475569;margin:9px 0 3px;}
      .muted{color:#94a3b8;font-style:italic;}
      .tbl{width:100%;border-collapse:collapse;margin-top:5px;font-size:10.5px;}
      .tbl th{text-align:left;color:#64748b;font-weight:700;border-bottom:1px solid #e2e8f0;padding:4px 6px;}
      .tbl td{border-bottom:1px solid #f1f5f9;padding:4px 6px;vertical-align:top;}
      .tbl td.num{white-space:nowrap;font-weight:700;text-align:right;}
      .tbl td.rsn{color:#475569;}
      .eq{margin-top:8px;font-weight:800;color:#1e293b;}
      .score-hd{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:6px;}
      .score-big{font-size:30px;font-weight:800;line-height:1;}
      .score-den{font-size:14px;opacity:.6;font-weight:700;}
      .score-band{font-size:13px;font-weight:800;text-transform:uppercase;}
      .score-sub{font-size:10px;color:#64748b;}
      .lst{margin:3px 0 4px 18px;}.lst li{margin:2px 0;}
      .note{margin-top:8px;font-size:9.5px;color:#5b21b6;background:#f5f3ff;border:1px solid #ede9fe;border-radius:6px;padding:6px 8px;}
      .img-grid{display:flex;flex-wrap:wrap;gap:10px;}
      .img-card{flex:1 1 46%;min-width:0;text-align:center;break-inside:avoid;}
      .img-card img{width:100%;max-height:115mm;object-fit:contain;border:1px solid #e2e8f0;border-radius:6px;background:#f8fafc;}
      .img-label{font-size:9.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#475569;margin-top:4px;}
      .img-ts{font-size:8.5px;color:#94a3b8;}
      .print-bar{display:flex;justify-content:flex-end;gap:8px;margin-bottom:16px;}
      .print-bar button{padding:8px 18px;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;}
      .btn-print{background:#7c3aed;color:#fff;}.btn-save{background:#f1f5f9;color:#334155;border:1px solid #cbd5e1;}
      .footer{margin-top:18px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:9.5px;color:#94a3b8;text-align:center;}
      @media print{.print-bar{display:none !important;}body{max-width:none;padding:0;}.section{break-inside:avoid;}}
    </style></head><body>

    <div class="print-bar">
      <button class="btn-save" onclick="document.title='CRISP-Incident-${esc(String(r.id).substring(0, 8))}';window.print();">Save as PDF</button>
      <button class="btn-print" onclick="window.print();">Print</button>
    </div>

    <div class="hdr">
      <div><h1>CRISP Incident Report</h1><span class="rid">ID: ${esc(r.id)}</span></div>
      <div style="text-align:right;"><div style="font-size:13px;font-weight:700;">${esc(infraDisplayLabel(r.infrastructure_type, r.infrastructure_sub_type))}</div><span class="badge sev-${esc(r.severity || '')}">${esc(r.severity || '')}</span><span class="badge" style="background:#f1f5f9;border:1px solid #cbd5e1;color:#334155;">${esc(ds.label || r.status || '')}</span></div>
    </div>

    ${body}

    <div class="footer">Generated by CRISP · Crisis Response Intelligence &amp; Situation Platform · ${esc(new Date().toLocaleString())}</div>
    </body></html>`;

    if (!w) { showToast('Allow pop-ups to export the incident PDF.', 'error'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
};

// ── Report Actions ───────────────────────────────────────────────────────────
window.patchReport = async (id, action) => {
    try {
        const res = await fetch(`${API}/${id}/${action}`, { method: 'PATCH' });
        if (res.ok) {
            const updated = await res.json();
            const idx = allReports.findIndex(r => r.id === id);
            if (idx >= 0) allReports[idx] = { ...allReports[idx], ...updated };
            // Merge into the out-of-feed detail cache too, so the detail panel of a
            // report not in the active working set (e.g. a closed/rejected report
            // opened from a queue) re-renders with the new state.
            if (_detailOnlyReport && _detailOnlyReport.id === id) _detailOnlyReport = { ..._detailOnlyReport, ...updated };
            showToast(`Report ${action}ed successfully`, 'success');
            if (selectedId === id) selectReport(id, true);
            renderFeed();
        }
    } catch (e) { showToast('Action failed - check internet connection', 'error'); }
};

// Jun 2026 - state-machine reversals on the incident detail. revertRejection
// clears the analyst's REJECTED verdict (back to NOT_REVIEWED → the report is OPEN
// again with Reject/Delete). reopenReport reverts a RESPONDING/RESOLVED/FALSE_ALARM
// status back to PENDING (the "undo notify" / "reopen" action). Both merge into the
// working set + the out-of-feed detail cache and re-render the open detail.
async function _applyReportStatePatch(id, path, body, okMsg) {
    try {
        const res = await fetch(`${API}/${id}/${path}`, {
            method: 'PATCH',
            headers: body ? { 'Content-Type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) { showToast('Action failed', 'error'); return; }
        const updated = await res.json();
        const idx = allReports.findIndex(r => r.id === id);
        if (idx >= 0) allReports[idx] = { ...allReports[idx], ...updated };
        if (_detailOnlyReport && _detailOnlyReport.id === id) _detailOnlyReport = { ..._detailOnlyReport, ...updated };
        showToast(okMsg, 'success');
        if (selectedId === id) selectReport(id, true);
        renderFeed();
    } catch (e) { showToast('Action failed - check internet connection', 'error'); }
}
window.revertRejection = (id) => _applyReportStatePatch(id, 'review', { verdict: 'NOT_REVIEWED' }, 'Rejection reverted - report is open again');
window.reopenReport = (id) => _applyReportStatePatch(id, 'reopen', null, 'Report reopened');

// Notify Response Team - the one-click "responding" action (dummy responder set):
// it always dispatches the response and notifies the reporter's PWA (the /dispatch
// endpoint sets RESPONDING + fires the reporter push). No responder-selection modal.
window.notifyResponseTeam = async (id) => {
    try {
        const res = await fetch(`${API}/${id}/dispatch`, { method: 'PATCH' });
        if (!res.ok) { showToast('Could not notify the response team', 'error'); return; }
        const updated = await res.json();
        const idx = allReports.findIndex(r => r.id === id);
        if (idx >= 0) allReports[idx] = { ...allReports[idx], ...updated };
        if (_detailOnlyReport && _detailOnlyReport.id === id) _detailOnlyReport = { ..._detailOnlyReport, ...updated };
        showToast('Response team notified · reporter informed in the app', 'success');
        if (selectedId === id) selectReport(id, true);
        renderFeed();
    } catch (e) { showToast('Notify failed - check internet connection', 'error'); }
};

window.deleteReport = async (id, reason) => {
    try {
        const qs = reason ? `?reason=${encodeURIComponent(reason)}` : '';
        const res = await fetch(`${API}/${id}${qs}`, { method: 'DELETE' });
        if (res.ok || res.status === 204) {
            allReports = allReports.filter(r => r.id !== id);
            knownIds.delete(id);
            // Phase 2: clear any tier override for the deleted report so
            // a later report with the same id (re-imported) starts fresh.
            _tierOverride.delete(id);
            if (selectedId === id) closeDetail();
            showToast('Report deleted', 'success');
            updateMapMarkers();
            renderFeed();
        }
    } catch (e) { showToast('Delete failed', 'error'); }
};

// ── Building History (Apr 2026 UI v2.1 W4) ─────────────────────────────────
// Endpoint response shape is now:
//   { building_id, total, latest_id, reports: [ ...ordinal-augmented... ] }
// Each report carries `building_version_ordinal` (1-based, 1=latest) and
// `building_is_latest` so the detail panel can paint the "V 2 of 3 · latest"
// ribbon. Legacy list-shaped responses are still accepted (older backends)
// via an Array.isArray branch, so we don't break during a rolling deploy.
// Phase 1 (Apr 2026 - Optional reporter login) - reporter-profile drawer.
// Calls `/auth/users/{user_id}` which is gated to ADMIN role on the
// server; ANALYST sessions get 403 and we show a short info toast.
// Masked "User abc12345" already rendered in the row badge for everyone;
// this drawer is the PII-unmask path for admins only.
window.openReporterProfile = async (userId) => {
    if (!userId) return;
    try {
        const res = await fetch(`${API}/auth/users/${userId}`, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' },
        });
        if (res.status === 403) {
            try { window.__toast && window.__toast('Only administrators can see reporter PII.', 'info'); } catch (_) {}
            return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const lines = [
            `User: ${data.id}`,
            data.email ? `Email: ${data.email}` : '',
            data.phone_number ? `Phone: ${data.phone_number}` : '',
            data.role ? `Role: ${data.role}` : '',
            data.last_login_at ? `Last login: ${data.last_login_at}` : '',
        ].filter(Boolean).join('\n');
        alert(lines || 'No reporter details available.');
    } catch (e) {
        console.warn('[Reporter] fetch failed:', e);
    }
};

// Phase H.1.d/e (May 2026) - filterByBuilding now ROUTES to the
// Building Intelligence Console instead of just opening map popups.
// The old per-marker popup behaviour was a navigator, not a filter;
// the console is the operator-facing surface that aggregates the
// building's reports + scores + crisis breakdown + responder status.
//
// Backward compatibility: the version-index cache is still populated
// from /api/v1/reports/building/{id} so the existing
// `dp-version-ribbon` renderer in the report-detail panel keeps
// showing "V N of M · Latest" without any further changes.
window.filterByBuilding = async (buildingId) => {
    try {
        const res = await fetch(`${API}/building/${buildingId}`);
        if (res.ok) {
            const body = await res.json();
            const reports = Array.isArray(body) ? body : (body.reports || []);
            const total = Array.isArray(body) ? reports.length : (body.total || reports.length);
            if (!window._buildingVersionIndex) window._buildingVersionIndex = {};
            reports.forEach(rep => {
                window._buildingVersionIndex[rep.id] = {
                    ordinal: rep.building_version_ordinal,
                    total: total,
                    is_latest: !!rep.building_is_latest,
                    building_id: buildingId,
                };
            });
        }
    } catch (_) { /* version cache best-effort */ }
    // Open the H.1.d Building Intelligence Console.
    if (typeof window.openBuildingConsole === 'function') {
        return window.openBuildingConsole(buildingId);
    }
};

/**
 * Fetch-and-cache the building version index for a report. Used by the
 * detail-panel render when it wants the ribbon but doesn't know the
 * building-history yet. Idempotent; subsequent calls return the cache.
 */
window.ensureBuildingVersionIndex = async (report) => {
    if (!report || !report.building_id) return null;
    const idx = window._buildingVersionIndex || {};
    if (idx[report.id]) return idx[report.id];
    try {
        const res = await fetch(`${API}/building/${report.building_id}`);
        if (!res.ok) return null;
        const body = await res.json();
        const reports = Array.isArray(body) ? body : (body.reports || []);
        const total = reports.length;
        if (!window._buildingVersionIndex) window._buildingVersionIndex = {};
        reports.forEach(rep => {
            window._buildingVersionIndex[rep.id] = {
                ordinal: rep.building_version_ordinal || (reports.indexOf(rep) + 1),
                total: total,
                is_latest: !!rep.building_is_latest || rep === reports[0],
                building_id: report.building_id,
            };
        });
        return window._buildingVersionIndex[report.id] || null;
    } catch (_) { return null; }
};

// ── AI Logic Transparency Modal ──────────────────────────────────────────────
window.showAILogic = function (reportId) {
    const r = allReports.find(rr => rr.id === reportId);
    if (!r || !r.ai_assessment) return;
    const aa = r.ai_assessment;
    const sb = aa.score_breakdown || {};

    const barHtml = (label, val, max = 100) => {
        const pct = Math.min(100, Math.max(0, (val / max) * 100));
        const color = val >= 70 ? '#22c55e' : val >= 50 ? '#eab308' : val >= 30 ? '#f97316' : '#ef4444';
        return `<div class="ai-logic-bar-row">
            <span class="ai-logic-label">${label}</span>
            <div class="ai-logic-bar"><div class="ai-logic-bar-fill" style="width:${pct}%;background:${color};"></div></div>
            <span class="ai-logic-val" style="color:${color};">${val}</span>
        </div>`;
    };

    const bonusHtml = (label, val) => {
        if (!val) return '';
        const color = val > 0 ? '#22c55e' : val < 0 ? '#ef4444' : '#64748b';
        return `<div class="ai-logic-bonus"><span>${label}</span><span style="color:${color};font-weight:700;">${val > 0 ? '+' : ''}${val}</span></div>`;
    };

    const modal = document.createElement('div');
    modal.className = 'ai-logic-overlay';
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    modal.innerHTML = `
        <div class="ai-logic-card">
            <div class="ai-logic-header">
                <h3><i class="fa-solid fa-shield-halved"></i> Credibility Assessment Logic</h3>
                <button onclick="this.closest('.ai-logic-overlay').remove()" class="ai-logic-close"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="ai-logic-body">
                <div class="ai-logic-section">
                    <h4>Score Breakdown</h4>
                    ${barHtml('Text & Voice', sb.text_voice_score || 0)}
                    ${barHtml('Visual Evidence', sb.visual_evidence_score || 0)}
                    ${barHtml('Satellite Verification', sb.satellite_score || 0)}
                    ${barHtml('Corroboration', sb.corroboration_score || 0)}
                    <div class="ai-logic-divider"></div>
                    ${bonusHtml('Reporter Credibility', sb.credibility_bonus)}
                    ${bonusHtml('Infrastructure Criticality', sb.criticality_bonus)}
                    ${bonusHtml('Penalties', sb.penalties)}
                    <div class="ai-logic-divider"></div>
                    <div class="ai-logic-total">
                        <span>Final Score</span>
                        <span style="font-size:24px;font-weight:800;color:${(sb.final_score || aa.confidence_score || 0) >= 70 ? '#22c55e' : '#f97316'};">
                            ${sb.final_score || aa.confidence_score || '?'}<small>/100</small>
                        </span>
                    </div>
                </div>
                ${(aa.key_factors || []).length ? `<div class="ai-logic-section"><h4>Key Factors</h4><ul>${aa.key_factors.map(f => `<li><i class="fa-solid fa-check" style="color:#22c55e;"></i> ${escapeHtml(f)}</li>`).join('')}</ul></div>` : ''}
                ${(aa.risk_flags || []).length ? `<div class="ai-logic-section"><h4>Risk Flags</h4><ul>${aa.risk_flags.map(f => `<li><i class="fa-solid fa-triangle-exclamation" style="color:#f97316;"></i> ${escapeHtml(f)}</li>`).join('')}</ul></div>` : ''}
                <div class="ai-logic-section"><h4>Full Reasoning</h4><p class="ai-logic-reasoning">${escapeHtml(aa.reasoning || aa.details || 'No detailed reasoning available.')}</p></div>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
};

// ── Audio Player ─────────────────────────────────────────────────────────────
window.playDetailAudio = function (btn, url) {
    if (currentAudio && !currentAudio.paused) {
        currentAudio.pause();
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        btn.classList.remove('playing');
        if (currentAudio._url === url) { currentAudio = null; return; }
    }
    // May 2026 - cache-bust on legacy /static/ URLs only. Presigned
    // S3 URLs already vary on every API poll (fresh X-Amz-Date +
    // Signature), and appending `&_t=…` would invalidate the SigV4
    // signature - S3 returns 403, browser surfaces it as
    // NotSupportedError ("no supported source was found").
    const fetchUrl = _withCacheBust(url, '_t', Date.now());
    currentAudio = new Audio(fetchUrl);
    currentAudio._url = url;
    btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
    btn.classList.add('playing');
    currentAudio.play();

    currentAudio.ontimeupdate = () => {
        const fill = document.getElementById('detail-audio-fill');
        const cur = document.getElementById('detail-audio-cur');
        if (fill && currentAudio.duration && isFinite(currentAudio.duration)) {
            fill.style.width = `${(currentAudio.currentTime / currentAudio.duration) * 100}%`;
        }
        if (cur) cur.textContent = formatTime(currentAudio.currentTime);
    };
    currentAudio.onloadedmetadata = () => {
        const dur = document.getElementById('detail-audio-dur');
        if (dur) dur.textContent = isFinite(currentAudio.duration) ? formatTime(currentAudio.duration) : '-:--';
    };
    currentAudio.onended = () => {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        btn.classList.remove('playing');
    };
};

function formatTime(s) {
    if (!s || !isFinite(s) || isNaN(s)) return '-:--';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ── Gallery (PhotoSwipe v5) ─────────────────────────────────────────────────
// May 2026 - replaces the original 6-line `openLightbox()` overlay. The old
// version showed one URL with no swipe / keyboard / zoom, so multi-image
// reports felt "stuck on the first photo" - exactly the UX problem behind
// the user's bug report. PhotoSwipe v5 brings:
//   · swipe navigation (touch + mouse)
//   · ←/→/Esc keyboard nav
//   · pinch + double-tap zoom
//   · responsive layout that fills available viewport
//
// On top of the stock lightbox we register a custom UI element ("tier-tabs")
// that lets the analyst toggle Small / Medium / Original variants from inside
// the gallery - implementing the user's "tabs/groups for Small / Medium /
// Original" requirement. The active tier highlights, disabled tiers carry an
// "uploading X%" tooltip so it's obvious why the analyst can't click it yet.
//
// Single-image satellite/comparison call sites still use `openLightbox(url,
// caption)` - kept as a shim that routes through PhotoSwipe single-slide
// mode so we never have two distinct lightbox UIs side by side.

// Phase L (May 2026) - canonical SMALL/MEDIUM/ORIGINAL tier values.
// The lightbox button labels stay user-friendly ("Small"/"Medium"/"Original")
// while the internal `tier` values match the Media row's resolution_tier.
const _TIER_BUTTONS = [
    { tier: 'SMALL',    label: 'Small'    },
    { tier: 'MEDIUM',   label: 'Medium'   },
    { tier: 'ORIGINAL', label: 'Original' },
];

// Tracks the currently-displayed tier per photo_group_id inside a live
// PhotoSwipe session, so when the analyst clicks "Original" we know what
// slide to swap. Cleared when the lightbox closes.
let _currentGalleryTiers = new Map(); // photo_group_id → 'LOW' | 'MEDIUM' | 'HIGH'

// Intrinsic-dimension cache (src → {w,h}). The Media schema carries no
// width/height, so the lightbox used to hardcode 1920×1440 - which fed
// PhotoSwipe the wrong fit geometry and STRETCHED portrait / panoramic /
// square photos. We read each image's real naturalWidth/Height once it
// loads and re-fit; cached per-src so re-opening is flash-free.
const _imgDimCache = new Map();

// Feed PhotoSwipe a slide's TRUE intrinsic size + re-fit it. Idempotent and
// never throws - a sizing refinement must never break the viewer.
function _applyRealDims(content, imgEl) {
    try {
        const img = imgEl
            || (content && content.element && content.element.tagName === 'IMG' ? content.element : null)
            || (content && content.element && content.element.querySelector ? content.element.querySelector('img') : null);
        if (!img || !img.naturalWidth || !img.naturalHeight) return;
        const w = img.naturalWidth, h = img.naturalHeight;
        _imgDimCache.set(img.currentSrc || img.src, { w, h });
        if (!content || (content.width === w && content.height === h)) return;
        content.width = w; content.height = h;
        if (content.data) { content.data.width = w; content.data.height = h; }
        if (content.slide) {
            if (content.slide.data) { content.slide.data.width = w; content.slide.data.height = h; }
            if (typeof content.slide.updateContentSize === 'function') content.slide.updateContentSize(true);
        }
    } catch (_) { /* best-effort sizing refinement */ }
}

// Pre-measure intrinsic dimensions so PhotoSwipe fits the TRUE aspect from the
// first frame (no 4:3 placeholder distortion - the schema has no width/height).
// Cache-first: cached / data-URI / already-shown images resolve instantly.
// Capped per-image so a slow uncached ORIGINAL never hangs the open; the
// `loadComplete` → _applyRealDims hook is the backstop for any timeout.
function _premeasureSlides(slides) {
    return Promise.all((slides || []).map((s) => new Promise((resolve) => {
        if (!s || !s.src) return resolve();
        const cached = _imgDimCache.get(s.src);
        if (cached) { s.width = cached.w; s.height = cached.h; return resolve(); }
        const im = new Image();
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        const to = setTimeout(done, 450);
        im.onload = () => {
            if (im.naturalWidth && im.naturalHeight) {
                s.width = im.naturalWidth; s.height = im.naturalHeight;
                _imgDimCache.set(s.src, { w: im.naturalWidth, h: im.naturalHeight });
            }
            clearTimeout(to); done();
        };
        im.onerror = () => { clearTimeout(to); done(); };
        im.src = s.src;
    })));
}

// ── Client-side rotation (non-destructive; no re-upload) ─────────────────────
// PhotoSwipe has no native rotation. We rotate the inner <img> via a CSS
// transform - PhotoSwipe owns the .pswp__zoom-wrap transform, so rotating the
// child <img> doesn't fight its zoom/pan - and on 90/270 scale it to re-fit the
// viewport (the bounding box swaps W↔H). Tracked per photo_group_id so nav
// preserves it; reset on close. Zoom is reset to fit on each rotate so the
// transform composes without a pan offset.
let _currentRotations = new Map(); // photo_group_id → degrees (0/90/180/270)

function _viewerImg(pswp) {
    const c = pswp && pswp.currSlide && pswp.currSlide.content;
    if (!c || !c.element) return null;
    return c.element.tagName === 'IMG' ? c.element
        : (c.element.querySelector ? c.element.querySelector('img') : null);
}

function _applyRotation(pswp) {
    try {
        const slide = pswp.currSlide, img = _viewerImg(pswp);
        if (!slide || !img) return;
        const gid = slide.data && slide.data._groupId;
        const deg = (gid && _currentRotations.get(gid)) || 0;
        let scale = 1;
        if (deg % 180 === 90) {
            // Fit the rotated bounding box (displayed H × W) into the viewport.
            const vp = pswp.viewportSize || { x: window.innerWidth, y: window.innerHeight };
            const fit = (slide.zoomLevels && slide.zoomLevels.fit) || 1;
            const dispW = (slide.width || img.naturalWidth || 1) * fit;
            const dispH = (slide.height || img.naturalHeight || 1) * fit;
            if (dispW && dispH) scale = Math.min(vp.x / dispH, vp.y / dispW);
        }
        img.style.transformOrigin = 'center center';
        img.style.transform = `rotate(${deg}deg) scale(${scale})`;
    } catch (_) { /* rotation is a view-only nicety; never break the viewer */ }
}

function _rotateViewer(pswp, delta) {
    const slide = pswp.currSlide, gid = slide && slide.data && slide.data._groupId;
    if (!gid) return;
    _currentRotations.set(gid, ((((_currentRotations.get(gid) || 0) + delta) % 360) + 360) % 360);
    try { if (slide && typeof slide.zoomTo === 'function') slide.zoomTo(slide.zoomLevels.initial, undefined, 0); } catch (_) {}
    _applyRotation(pswp);
}

function _resetViewerRotation(pswp) {
    const slide = pswp.currSlide, gid = slide && slide.data && slide.data._groupId;
    if (gid) _currentRotations.set(gid, 0);
    try { if (slide && typeof slide.zoomTo === 'function') slide.zoomTo(slide.zoomLevels.initial, undefined, 0); } catch (_) {}
    _applyRotation(pswp);
}

// ── Geo metadata overlay (top-right) + viewer preferences ────────────────────
// Location is per-REPORT (every image in a report shares one Location), so the
// overlay reflects the report's capture location - identical across that
// report's photos by design. Content + visibility are a localStorage
// user-preference (no per-user backend on v34).
const _VIEWER_PREFS_KEY = 'crisp_image_viewer_prefs';
const _OVERLAY_MODES = ['coords_building_time', 'coords_building', 'coords', 'off'];
const _OVERLAY_LABELS = { coords_building_time: 'coords + building + time', coords_building: 'coords + building', coords: 'coordinates', off: 'off' };
let _viewerPrefs = (() => { try { return JSON.parse(localStorage.getItem(_VIEWER_PREFS_KEY) || '{}'); } catch (_) { return {}; } })();
function _saveViewerPrefs() { try { localStorage.setItem(_VIEWER_PREFS_KEY, JSON.stringify(_viewerPrefs)); } catch (_) {} }
function _overlayMode() { return _OVERLAY_MODES.includes(_viewerPrefs.overlay) ? _viewerPrefs.overlay : 'coords_building_time'; }
function _pswpRoot(pswp) { return (pswp && (pswp.element || pswp.template)) || document.querySelector('.pswp'); }

function _renderGeoOverlay(el, pswp) {
    if (!el) return;
    const slide = pswp.currSlide && pswp.currSlide.data;
    const mode = _overlayMode();
    const rep = slide ? (typeof allReports !== 'undefined' ? allReports : []).find(x => x.id === slide._reportId) : null;
    const loc = rep && rep.location;
    if (mode === 'off' || !loc || loc.latitude == null || loc.longitude == null) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = '';
    const lat = Number(loc.latitude), lng = Number(loc.longitude);
    const coordTxt = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    const acc = loc.accuracy_meters;
    // Building label on the photo overlay = OSM building name ONLY; the reporter's
    // free-text "what was hit" (from_osm === false) is never shown as a building.
    const building = (mode !== 'coords' && _taggedBuildingName(rep)) ? rep.infrastructure_name : '';
    let timeTxt = '';
    if (mode === 'coords_building_time') {
        const iso = rep.client_created_at || rep.server_created_at;
        if (iso) { try {
            timeTxt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ensureUTC(iso)));
        } catch (_) {} }
    }
    el.innerHTML =
        `<button type="button" class="pgo-coords" title="Copy coordinates">` +
            `<i class="fa-solid fa-location-dot"></i> ${coordTxt}` +
            `${(acc != null && isFinite(acc)) ? ` <span class="pgo-acc">±${Math.round(acc)} m</span>` : ''}</button>` +
        (building ? `<div class="pgo-row pgo-building"><i class="fa-solid fa-building"></i> ${escapeHtml(building)}</div>` : '') +
        (timeTxt ? `<div class="pgo-row pgo-time"><i class="fa-regular fa-clock"></i> ${escapeHtml(timeTxt)}</div>` : '') +
        `<button type="button" class="pgo-map">Open on map <i class="fa-solid fa-arrow-up-right-from-square"></i></button>`;
    const cBtn = el.querySelector('.pgo-coords');
    if (cBtn) cBtn.onclick = (e) => { e.stopPropagation();
        try { navigator.clipboard && navigator.clipboard.writeText(`${lat.toFixed(6)}, ${lng.toFixed(6)}`); } catch (_) {}
        if (typeof showToast === 'function') showToast(`Copied ${coordTxt}`, 'info'); };
    const mBtn = el.querySelector('.pgo-map');
    if (mBtn) mBtn.onclick = (e) => { e.stopPropagation();
        try { pswp.close(); } catch (_) {}
        if (window.map && typeof window.map.flyTo === 'function') window.map.flyTo([lat, lng], 16, { duration: 0.6 }); };
}

function _cycleOverlay(pswp) {
    _viewerPrefs.overlay = _OVERLAY_MODES[(_OVERLAY_MODES.indexOf(_overlayMode()) + 1) % _OVERLAY_MODES.length];
    _saveViewerPrefs();
    const root = _pswpRoot(pswp);
    if (root) {
        _renderGeoOverlay(root.querySelector('.pswp-geo-overlay'), pswp);
        const btn = root.querySelector('.pswp__button--overlay-toggle');
        if (btn) btn.classList.toggle('pswp-toggle-on', _overlayMode() !== 'off');
    }
    if (typeof showToast === 'function') showToast(`Image info: ${_OVERLAY_LABELS[_overlayMode()]}`, 'info');
}

// ── Download current image (explicit user action; current tier) ──────────────
async function _downloadViewerImage(pswp) {
    try {
        const data = pswp.currSlide && pswp.currSlide.data;
        const url = (data && data.src) || '';
        if (!url) return;
        const name = `crisp-${String((data && data._reportId) || 'photo').slice(0, 8)}-photo${(data && (data._groupIdx + 1)) || 1}.jpg`;
        try {
            const resp = await fetch(url, { credentials: 'omit' });
            if (!resp.ok) throw new Error('fetch ' + resp.status);
            const obj = URL.createObjectURL(await resp.blob());
            const a = document.createElement('a');
            a.href = obj; a.download = name;
            document.body.appendChild(a); a.click(); a.remove();
            setTimeout(() => URL.revokeObjectURL(obj), 5000);
        } catch (_) {
            // Cross-origin S3 without CORS → can't blob it; open so the analyst
            // can save manually. Still an explicit, user-initiated action.
            window.open(url, '_blank', 'noopener');
        }
        if (typeof showToast === 'function') showToast('Download started', 'info');
    } catch (_) {}
}

function _buildGallerySlides(report, startGroupIdx) {
    const allImages = (report.media || []).filter(m => m.type === 'IMAGE');
    const groups = groupPhotos(allImages);
    const totalGroups = groups.length;
    return groups.map((g, idx) => {
        // Start at the highest complete variant so the gallery opens at full
        // fidelity. If the user hasn't picked an override yet, that's the
        // best behaviour. Fall back to whatever bestVariant() surfaces (which
        // includes partials/thumbnails for in-flight uploads).
        const pick = highestCompleteVariant(g) || bestVariant(g);
        _currentGalleryTiers.set(g.group_id || `loose-${idx}`, pick?.tier || 'ORIGINAL');
        // Seed from the per-src dimension cache when known (flash-free
        // re-opens); otherwise a neutral 4:3 placeholder. `_applyRealDims`
        // (registered on PhotoSwipe `loadComplete`) corrects each slide to
        // the image's true intrinsic size + re-fits - so no photo is stretched.
        const _cdim = _imgDimCache.get(pick?.src);
        return {
            src: pick?.src || '',
            width: _cdim?.w || 1920,
            height: _cdim?.h || 1440,
            alt: `Photo ${idx+1} of ${totalGroups}`,
            // Custom payload that the tier-tabs UI reads.
            _groupId: g.group_id || `loose-${idx}`,
            _groupIdx: idx,
            _totalGroups: totalGroups,
            _reportId: report.id,
            _members: g.members,
        };
    });
}

window.openGallery = async function (reportId, startGroupIdx) {
    if (typeof PhotoSwipe === 'undefined') {
        console.warn('[openGallery] PhotoSwipe not loaded - falling back to single-image overlay');
        const r0 = allReports.find(x => x.id === reportId);
        if (r0) {
            const groups0 = groupPhotos((r0.media || []).filter(m => m.type === 'IMAGE'));
            const pick0 = highestCompleteVariant(groups0[startGroupIdx || 0] || groups0[0]);
            if (pick0?.src) _openSingleOverlay(pick0.src, `Photo ${(startGroupIdx||0)+1} of ${groups0.length}`);
        }
        return;
    }
    const r = allReports.find(x => x.id === reportId);
    if (!r) return;
    const slides = _buildGallerySlides(r, startGroupIdx || 0);
    if (slides.length === 0) return;

    _currentGalleryTiers = new Map(); // reset for this session
    // Re-seed with each slide's chosen tier so the swatch reads correctly
    // when the user navigates between groups.
    slides.forEach(s => _currentGalleryTiers.set(s._groupId, s._members
        .filter(m => m.assembly_status === 'complete' && m.url)
        .sort((a,b) => (TIER_RANK[b.resolution_tier]||0) - (TIER_RANK[a.resolution_tier]||0))[0]?.resolution_tier || 'ORIGINAL'));

    // Give PhotoSwipe the TRUE intrinsic dims up front so it fits the real
    // aspect from the first frame (no 4:3 distortion).
    await _premeasureSlides(slides);

    const pswp = new PhotoSwipe({
        dataSource: slides,
        index: Math.max(0, Math.min(startGroupIdx || 0, slides.length - 1)),
        bgOpacity: 0.94,
        showHideAnimationType: 'fade',
        // Smooth Esc / outside-tap dismissal.
        closeOnVerticalDrag: true,
        // Disable pinch-to-close on iOS - collides with pinch-zoom.
        pinchToClose: false,
    });

    // Re-fit every slide to its TRUE intrinsic size once the image loads -
    // replaces the hardcoded 1920×1440 that stretched non-4:3 photos.
    pswp.on('loadComplete', (e) => { _applyRealDims(e.content); _applyRotation(pswp); });
    // Re-apply the per-group rotation when navigating between slides.
    pswp.on('change', () => _applyRotation(pswp));

    // Register the per-slide tier-tabs UI in the top-bar area. Runs once at
    // open; the element updates itself via the `change` event when the
    // analyst swipes / arrows to a new slide.
    pswp.on('uiRegister', () => {
        pswp.ui.registerElement({
            name: 'tier-tabs',
            order: 9,
            isButton: false,
            appendTo: 'bar',
            html: '<div class="pswp-tier-tabs" id="pswp-tier-tabs"></div>',
            onInit: (el, pswpInst) => {
                const render = () => {
                    const slide = pswpInst.currSlide?.data;
                    if (!slide || !slide._members) {
                        el.innerHTML = '';
                        return;
                    }
                    const activeTier = _currentGalleryTiers.get(slide._groupId) || 'ORIGINAL';
                    const byTier = Object.fromEntries(
                        slide._members.map(m => [m.resolution_tier, m])
                    );
                    const btns = _TIER_BUTTONS.map(({ tier, label }) => {
                        const m = byTier[tier];
                        const complete = m && m.assembly_status === 'complete' && m.url;
                        const pct = m ? Math.round(m.completion_pct || 0) : 0;
                        const isActive = tier === activeTier;
                        const title = complete
                            ? `Show ${label} variant`
                            : (m ? `${label} - uploading ${pct}%` : `${label} - not available`);
                        return `<button type="button"
                                    class="pswp-tier-tab ${isActive ? 'active' : ''} ${complete ? '' : 'disabled'}"
                                    data-tier="${tier}"
                                    ${complete ? '' : 'aria-disabled="true"'}
                                    title="${title}">${label}${!complete && m ? ` <span class="pswp-tier-pct">${pct}%</span>` : ''}</button>`;
                    }).join('');
                    const captionBits = [
                        `Photo ${slide._groupIdx + 1} of ${slide._totalGroups}`,
                        `group ${(slide._groupId || '').slice(0, 8)}`,
                    ];
                    el.innerHTML = `
                        <div class="pswp-tier-caption">${captionBits.join(' · ')}</div>
                        <div class="pswp-tier-buttons">${btns}</div>
                    `;
                    // Wire clicks. Re-bound every render - the inner HTML
                    // was just rewritten so prior listeners are gone.
                    el.querySelectorAll('.pswp-tier-tab').forEach(btn => {
                        btn.onclick = (e) => {
                            e.stopPropagation();
                            const tier = btn.getAttribute('data-tier');
                            const target = byTier[tier];
                            if (!target || target.assembly_status !== 'complete' || !target.url) return;
                            const newSrc = getMediaUrl(target.url);
                            // Update the in-memory slide so re-render uses
                            // the new src; PhotoSwipe doesn't re-query dataSource
                            // on its own.
                            slide.src = newSrc;
                            _currentGalleryTiers.set(slide._groupId, tier);
                            // Force the current slide's <img> to point at
                            // the new URL. We update the underlying
                            // dataSource AND swap the live <img> element so
                            // the swap is instant.
                            const currSlide = pswpInst.currSlide;
                            if (currSlide && currSlide.container) {
                                const img = currSlide.container.querySelector('img');
                                if (img) {
                                    // Tier swap sets src directly, so PhotoSwipe's
                                    // own loadComplete won't fire - re-fit to the
                                    // new tier's real dims once it decodes.
                                    img.addEventListener('load',
                                        () => _applyRealDims(currSlide.content, img), { once: true });
                                    img.src = newSrc;
                                }
                            }
                            render(); // refresh the active-state highlight
                        };
                    });
                };
                pswpInst.on('change', render);
                render();
            },
        });

        // Download the current image (current tier).
        pswp.ui.registerElement({ name: 'download', order: 5, isButton: true,
            title: 'Download image (d)', ariaLabel: 'Download image',
            html: '<i class="fa-solid fa-download"></i>',
            onClick: () => _downloadViewerImage(pswp) });

        // Rotation controls (client-side, non-destructive). FontAwesome is
        // already loaded globally, so the icons render inside the pswp buttons.
        pswp.ui.registerElement({ name: 'rotate-left', order: 6, isButton: true,
            title: 'Rotate left ([)', ariaLabel: 'Rotate left',
            html: '<i class="fa-solid fa-rotate-left"></i>',
            onClick: () => _rotateViewer(pswp, -90) });
        pswp.ui.registerElement({ name: 'rotate-right', order: 7, isButton: true,
            title: 'Rotate right (])', ariaLabel: 'Rotate right',
            html: '<i class="fa-solid fa-rotate-right"></i>',
            onClick: () => _rotateViewer(pswp, 90) });
        pswp.ui.registerElement({ name: 'rotate-reset', order: 8, isButton: true,
            title: 'Reset orientation (r)', ariaLabel: 'Reset orientation',
            html: '<i class="fa-solid fa-arrows-rotate"></i>',
            onClick: () => _resetViewerRotation(pswp) });

        // Top-right geo metadata overlay (lives in the root UI layer, so it
        // stays put during zoom/rotation) + its toggle button.
        pswp.ui.registerElement({ name: 'geo-overlay', className: 'pswp-geo-overlay',
            appendTo: 'root', isButton: false,
            onInit: (el, pswpInst) => {
                el.setAttribute('aria-live', 'polite');
                const render = () => _renderGeoOverlay(el, pswpInst);
                pswpInst.on('change', render);
                render();
            } });
        pswp.ui.registerElement({ name: 'overlay-toggle', order: 10, isButton: true,
            title: 'Toggle info overlay (i)', ariaLabel: 'Toggle info overlay',
            html: '<i class="fa-solid fa-circle-info"></i>',
            onInit: (el) => { el.classList.toggle('pswp-toggle-on', _overlayMode() !== 'off'); },
            onClick: () => _cycleOverlay(pswp) });
    });

    // Keyboard: PhotoSwipe owns ←/→/Esc; we add the rotation shortcuts.
    const _onKey = (e) => {
        if (e.key === '[') { _rotateViewer(pswp, -90); e.preventDefault(); }
        else if (e.key === ']') { _rotateViewer(pswp, 90); e.preventDefault(); }
        else if (e.key === 'r' || e.key === '0') { _resetViewerRotation(pswp); e.preventDefault(); }
        else if (e.key === 'i') { _cycleOverlay(pswp); e.preventDefault(); }
        else if (e.key === 'd') { _downloadViewerImage(pswp); e.preventDefault(); }
    };
    document.addEventListener('keydown', _onKey);

    pswp.on('close', () => {
        _currentGalleryTiers = new Map();
        _currentRotations = new Map();
    });
    pswp.on('destroy', () => document.removeEventListener('keydown', _onKey));

    pswp.init();
};

// Backward-compat shim. Old single-image call sites (satellite popups, sat
// compare panels) keep using openLightbox() - route them through PhotoSwipe
// so the user always sees the same lightbox UI. When PhotoSwipe isn't
// loaded, fall back to the original simple overlay.
window.openLightbox = function (url, caption) {
    if (typeof PhotoSwipe === 'undefined') { _openSingleOverlay(url, caption); return; }
    const _cd = _imgDimCache.get(url);
    const pswp = new PhotoSwipe({
        dataSource: [{ src: url, width: _cd?.w || 1920, height: _cd?.h || 1440, alt: caption || '' }],
        index: 0,
        bgOpacity: 0.94,
        showHideAnimationType: 'fade',
        closeOnVerticalDrag: true,
        pinchToClose: false,
    });
    pswp.on('loadComplete', (e) => _applyRealDims(e.content));
    pswp.init();
};

// Final-fallback simple overlay (used if PhotoSwipe failed to load - e.g.
// CDN blocked on a restrictive operator network). Mirrors the legacy
// behaviour so the worst case is "no swipe" rather than "image unviewable".
function _openSingleOverlay(url, caption) {
    const overlay = document.createElement('div');
    overlay.className = 'lightbox-overlay';
    overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML = `
        <button class="lightbox-close" onclick="this.parentElement.remove()"><i class="fa-solid fa-xmark"></i></button>
        <img src="${url}" alt="${caption || ''}">
        <div class="lightbox-caption">${caption || ''}</div>
    `;
    document.body.appendChild(overlay);
}

// ── Map ──────────────────────────────────────────────────────────────────────
let map;

function initMap() {
    map = L.map('crisis-map', {
        zoomControl: false,
        minZoom: 2,
        maxBounds: [[-85, -180], [85, 180]],
        maxBoundsViscosity: 1.0,
    }).setView([20, 0], 2);
    // Phase F.1.a (May 2026) - dark-mode tile fix.
    //
    // The previous single-layer `dark_all` style baked place labels into
    // the tile at low contrast, making city / district / region names
    // illegible at zoom 11-14 (exactly the operator's triage zoom level
    // inside a city). CARTO publishes the labels and the base map as
    // separate tilesets: `dark_nolabels` + `dark_only_labels`. We layer
    // them so we can boost the label-only layer's CSS opacity / filter
    // independently of the base, AND the labels render ABOVE everything
    // (markers, building footprints, heat) - which keeps city names
    // legible even when a cluster marker would otherwise overlap them.
    //
    // Fallback: if the labels layer fails to load (transient CARTO
    // outage), the base `dark_nolabels` stays usable on its own - same
    // imagery as `dark_all` minus the place names. Better than no map.
    //
    // CSP: `*.basemaps.cartocdn.com` is already whitelisted in
    // nginx.conf:88; both `dark_nolabels` and `dark_only_labels` are
    // served from the same host so no CSP update needed.
    const darkBaseTiles = L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png',
        {
            attribution: '&copy; OpenStreetMap &copy; CARTO',
            maxZoom: 19,
            noWrap: true,
        }
    );
    const darkLabelTiles = L.tileLayer(
        'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png',
        {
            attribution: '',           // attribution already on the base layer
            maxZoom: 19,
            noWrap: true,
            pane: 'overlayPane',       // sits above the base + below markers/popups
            // No `opacity` here - the .leaflet-tile-pane rule in
            // styles.css handles the contrast boost so we can tune it
            // without re-deploying app.js.
        }
    );
    // Compose into a single LayerGroup so the layer-switcher in the
    // top-right control treats "Dark" as one selectable option (UX:
    // operators don't need to know there are two tile sources behind
    // the dark theme).
    const darkTiles = L.layerGroup([darkBaseTiles, darkLabelTiles]);

    const satelliteTiles = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        attribution: '&copy; Esri World Imagery', maxZoom: 19, noWrap: true,
    });
    const streetTiles = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap', maxZoom: 19, noWrap: true,
    });
    darkTiles.addTo(map);

    // ── Phase H.8 - All-buildings priority-coloured overlay ────────
    // A togglable data layer (NOT a base map swap) that paints every
    // tracked Building as a polygon (when footprint cached) or a
    // circle at the centroid (when not). Colour scale follows the
    // humanitarian_priority score 0-100.
    //
    // Composable with whichever base tile the operator picked. Click
    // a building → opens the Intelligence Console. The layer fetches
    // on toggle-on, caches the response for the session, and
    // re-renders on subsequent toggles without a network round-trip.
    const buildingsPriorityLayer = L.layerGroup();
    let _allBuildingsCache = null;
    let _allBuildingsLoading = false;

    function _priorityColor(score) {
        if (score == null) return '#64748b';
        if (score >= 80) return '#ef4444';   // red - extreme
        if (score >= 60) return '#f97316';   // orange - high
        if (score >= 40) return '#eab308';   // yellow - moderate
        if (score >= 20) return '#22c55e';   // green - low
        return '#94a3b8';                    // grey - ~negligible
    }

    function _renderAllBuildingsLayer(buildings) {
        buildingsPriorityLayer.clearLayers();
        for (const b of buildings) {
            const color = _priorityColor(b.humanitarian_priority);
            const stateColor = ({
                ACTIVE:      color,
                MONITORED:   '#46DFB1',
                RESPONDING:  '#a78bfa',
                ESCALATED:   '#ef4444',
                RESOLVED:    '#22c55e',
                ARCHIVED:    '#64748b',
                FALSE_ALARM: '#64748b',
            })[b.state] || color;
            // Footprint geometry if cached; otherwise a centroid circle.
            let layer = null;
            const fg = b.footprint_geojson;
            if (fg && fg.geometry && fg.geometry.type === 'Polygon') {
                layer = L.geoJSON(fg, {
                    style: {
                        color: stateColor,
                        weight: 2,
                        fillColor: color,
                        fillOpacity: Math.min(0.55, 0.20 + (b.humanitarian_priority || 0) / 250),
                    },
                });
            } else if (b.centroid_lat != null && b.centroid_lng != null) {
                layer = L.circleMarker([b.centroid_lat, b.centroid_lng], {
                    radius: Math.max(5, Math.min(16, 5 + (b.humanitarian_priority || 0) / 8)),
                    color: stateColor,
                    weight: 1.5,
                    fillColor: color,
                    fillOpacity: Math.min(0.7, 0.30 + (b.humanitarian_priority || 0) / 200),
                });
            } else {
                continue;
            }
            const popup = `
                <div style="font-size:12px;line-height:1.5;min-width:200px;">
                    <div style="font-weight:700;color:#f1f5f9;margin-bottom:4px;">
                        ${escapeHtml(b.osm_name || b.id)}
                    </div>
                    <div style="color:#cbd5e1;">
                        <strong style="color:${stateColor};">${escapeHtml(b.state)}</strong> ·
                        ${b.report_count || 0} reports ·
                        Priority <strong>${b.humanitarian_priority != null ? b.humanitarian_priority.toFixed(0) : '-'}</strong>
                    </div>
                    <div style="color:#94a3b8;font-size:11px;margin-top:3px;">
                        Sev ${b.severity_score != null ? b.severity_score.toFixed(0) : '-'} ·
                        Conf ${b.confidence_score != null ? b.confidence_score.toFixed(0) : '-'} ·
                        Escal ${b.escalation_risk != null ? b.escalation_risk.toFixed(0) : '-'}
                    </div>
                    <button onclick="openBuildingConsole('${b.id}')"
                        style="margin-top:6px;padding:4px 10px;background:rgba(167,139,250,0.18);
                               color:#c4b5fd;border:1px solid rgba(167,139,250,0.45);
                               border-radius:4px;cursor:pointer;font-size:11px;font-weight:700;">
                        Open console
                    </button>
                </div>
            `;
            layer.bindPopup(popup);
            layer.on('click', () => {
                if (typeof window.openBuildingConsole === 'function') {
                    window.openBuildingConsole(b.id);
                }
            });
            buildingsPriorityLayer.addLayer(layer);
        }
    }

    async function _fetchAllBuildingsForMap() {
        if (_allBuildingsCache) return _allBuildingsCache;
        if (_allBuildingsLoading) return null;
        _allBuildingsLoading = true;
        try {
            // Sort by humanitarian_priority so the highest-impact buildings
            // render last (Leaflet draws in insertion order; this paints
            // hot buildings on top of cold ones).
            const res = await fetch(
                `${BUILDINGS_API}?limit=500&order_by=humanitarian_priority&order_dir=asc`,
                { headers: _authHeaders() }
            );
            if (!res.ok) {
                showToast(`Building layer failed: HTTP ${res.status}`, 'error');
                return null;
            }
            const data = await res.json();
            _allBuildingsCache = data.items || [];
            return _allBuildingsCache;
        } catch (e) {
            showToast(`Network error loading buildings layer: ${e.message}`, 'error');
            return null;
        } finally {
            _allBuildingsLoading = false;
        }
    }

    // Wire the overlay's add / remove events to lazy-fetch + render.
    buildingsPriorityLayer.on('add', async () => {
        const items = await _fetchAllBuildingsForMap();
        if (items && items.length) {
            _renderAllBuildingsLayer(items);
            showToast(`Showing ${items.length} buildings by priority`, 'info');
        } else if (items !== null) {
            showToast('No buildings to display yet', 'info');
        }
    });

    L.control.layers(
        { "Dark": darkTiles, "Satellite": satelliteTiles, "Street": streetTiles },
        // Overlays - the user can toggle buildings on top of any base map.
        { "Buildings (priority)": buildingsPriorityLayer },
        { position: 'topright' }
    ).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Compact map legend showing the priority-color scale. Appears
    // bottom-left, fades to 70% opacity when not hovered.
    const priorityLegend = L.control({ position: 'bottomleft' });
    priorityLegend.onAdd = function () {
        const div = L.DomUtil.create('div', 'map-priority-legend');
        div.innerHTML = `
            <div class="map-priority-title">
                <i class="fa-solid fa-bullseye"></i> Humanitarian priority
            </div>
            <div class="map-priority-scale">
                <span style="background:#ef4444;"></span>≥80
                <span style="background:#f97316;"></span>60-79
                <span style="background:#eab308;"></span>40-59
                <span style="background:#22c55e;"></span>20-39
                <span style="background:#94a3b8;"></span>&lt;20
            </div>
            <div class="map-priority-hint">
                Toggle <em>Buildings (priority)</em> overlay to view
            </div>
        `;
        return div;
    };
    priorityLegend.addTo(map);

    // Building footprints layer - loads from Overpass API at zoom >= 15.
    //
    // Phase H.1.e (May 2026) - polygons now:
    //   * click → openBuildingConsole(osm:way:<id>)
    //   * highlight when the operator's currently-selected building
    //     matches (via window._highlightBuildingPolygon set by the
    //     building-console workflow)
    //   * the existing hover tooltip with OSM name is preserved
    let _buildingLayer = null;
    let _buildingCache = {};
    let _buildingDebounce = null;
    // Phase H.1.e - map of `osm:way:<id>` → Leaflet layer so we can
    // re-style the selected polygon when the operator opens the console.
    const _buildingPolyById = new Map();

    function _styleForBuilding(id, isSelected) {
        return isSelected
            ? { color: '#fbbf24', weight: 3, fillColor: '#fbbf24', fillOpacity: 0.32 }
            : { color: '#7c3aed', weight: 1, fillColor: '#7c3aed', fillOpacity: 0.15 };
    }

    window._highlightBuildingPolygon = function (selectedId) {
        // Re-style every known polygon. selectedId may be null (no
        // selection) or `osm:way:<n>`.
        for (const [bid, layer] of _buildingPolyById.entries()) {
            const isSel = !!selectedId && bid === selectedId;
            try { layer.setStyle(_styleForBuilding(bid, isSel)); } catch (_) {}
        }
    };

    function loadBuildingFootprints() {
        if (map.getZoom() < 15) { if (_buildingLayer) { map.removeLayer(_buildingLayer); _buildingLayer = null; _buildingPolyById.clear(); } return; }
        const b = map.getBounds();
        const key = `${b.getSouth().toFixed(3)},${b.getWest().toFixed(3)},${b.getNorth().toFixed(3)},${b.getEast().toFixed(3)}`;
        if (_buildingCache[key]) return;
        const bbox = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
        const query = `[out:json][timeout:10];way["building"](${bbox});out geom;`;
        fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`)
            .then(r => r.json())
            .then(data => {
                _buildingCache[key] = true;
                const features = (data.elements || []).filter(e => e.geometry).map(e => ({
                    type: 'Feature',
                    geometry: { type: 'Polygon', coordinates: [e.geometry.map(p => [p.lon, p.lat])] },
                    // Carry the OSM id so we can compose `osm:way:<id>`
                    // building_id at click time (matches the PWA's
                    // building-select.js id format).
                    properties: { name: e.tags?.name || '', type: e.tags?.building || 'yes', osm_id: e.id },
                }));
                if (_buildingLayer) map.removeLayer(_buildingLayer);
                _buildingPolyById.clear();
                _buildingLayer = L.geoJSON({ type: 'FeatureCollection', features }, {
                    style: (f) => _styleForBuilding(
                        `osm:way:${f.properties.osm_id}`,
                        (typeof _selectedBuildingId !== 'undefined') &&
                            _selectedBuildingId === `osm:way:${f.properties.osm_id}`
                    ),
                    onEachFeature: (f, layer) => {
                        const bid = `osm:way:${f.properties.osm_id}`;
                        _buildingPolyById.set(bid, layer);
                        if (f.properties.name) {
                            layer.bindTooltip(f.properties.name, { sticky: true });
                        }
                        // Phase H.1.e - polygon click opens the Building
                        // Intelligence Console. We open even for buildings
                        // that don't yet have a Reports row - the console
                        // handles 404 by showing a toast + closing.
                        layer.on('click', (ev) => {
                            // Prevent the click from bubbling to the map
                            // (which has its own click handler that
                            // dismisses popups).
                            L.DomEvent.stopPropagation(ev);
                            if (typeof window.openBuildingConsole === 'function') {
                                window.openBuildingConsole(bid);
                            }
                        });
                    },
                }).addTo(map);
            })
            .catch(() => {});
    }
    map.on('moveend', () => { clearTimeout(_buildingDebounce); _buildingDebounce = setTimeout(loadBuildingFootprints, 600); });

    // Initialize cluster group - optimized for easy clicking on hotspots
    clusterGroup = L.markerClusterGroup({
        maxClusterRadius: 35,
        spiderfyOnMaxZoom: true,
        spiderfyDistanceMultiplier: 2.5,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: false,     // we handle click ourselves - spiderfy on click
        disableClusteringAtZoom: 16,
        iconCreateFunction: function (cluster) {
            const children = cluster.getAllChildMarkers();
            let maxSev = 'UNKNOWN';
            const sevOrder = ['UNKNOWN', 'MINOR', 'MODERATE', 'SEVERE', 'CRITICAL'];
            children.forEach(m => {
                if (m._crispReport && sevOrder.indexOf(m._crispReport.severity) > sevOrder.indexOf(maxSev)) {
                    maxSev = m._crispReport.severity;
                }
            });
            const color = SEV_COLORS[maxSev] || '#64748b';
            const count = children.length;
            const size = count > 50 ? 52 : count > 20 ? 44 : count > 5 ? 38 : 32;
            const hasCritical = children.some(m => m._crispReport?.severity === 'CRITICAL');
            const pulseClass = hasCritical ? 'crisp-cluster-pulse' : '';
            return L.divIcon({
                className: `crisp-cluster ${pulseClass}`,
                html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:3px solid rgba(255,255,255,0.9);display:flex;align-items:center;justify-content:center;font-size:${size > 40 ? 15 : 13}px;font-weight:800;color:#fff;box-shadow:0 2px 16px ${color}aa;cursor:pointer;">${count}</div>`,
                iconSize: [size, size]
            });
        }
    });
    map.addLayer(clusterGroup);

    // Cluster hover: show popup with incidents grouped by infrastructure type
    clusterGroup.on('clustermouseover', function (e) {
        const cluster = e.layer;
        const children = cluster.getAllChildMarkers();

        // Group by infrastructure type
        const groups = {};
        children.forEach(m => {
            const r = m._crispReport;
            if (!r) return;
            const type = r.infrastructure_type || 'OTHER';
            if (!groups[type]) groups[type] = { count: 0, maxSev: 'UNKNOWN', sevCounts: {} };
            groups[type].count++;
            groups[type].sevCounts[r.severity] = (groups[type].sevCounts[r.severity] || 0) + 1;
            const sevOrder = ['UNKNOWN', 'MINOR', 'MODERATE', 'SEVERE', 'CRITICAL'];
            if (sevOrder.indexOf(r.severity) > sevOrder.indexOf(groups[type].maxSev)) groups[type].maxSev = r.severity;
        });

        const rows = Object.entries(groups)
            .sort((a, b) => b[1].count - a[1].count)
            .map(([type, g]) => {
                const ic = INFRA_ICONS[type] || 'fa-circle';
                const col = SEV_COLORS[g.maxSev] || '#64748b';
                const sevDots = Object.entries(g.sevCounts).map(([s, c]) =>
                    `<span style="color:${SEV_COLORS[s] || '#64748b'};font-size:10px;" title="${s}: ${c}">${'●'.repeat(Math.min(c, 5))}</span>`
                ).join(' ');
                return `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);">
                    <i class="fa-solid ${ic}" style="color:${col};font-size:13px;width:16px;text-align:center;"></i>
                    <span style="font-size:12px;color:#f1f5f9;font-weight:600;flex:1;">${type.replace(/_/g,' ')}</span>
                    <span style="font-size:13px;font-weight:800;color:${col};min-width:18px;text-align:right;">${g.count}</span>
                </div>`;
            }).join('');

        const locName = children[0]?._crispReport?.location?.user_location_name || children[0]?._crispReport?.location?.device_location_name || '';
        cluster.bindPopup(`<div style="min-width:190px;max-width:260px;">
            <div style="font-size:13px;font-weight:800;color:#ffae00;margin-bottom:6px;">${children.length} Incidents${locName ? ' - ' + escapeHtml(locName) : ''}</div>
            ${rows}
            <div style="font-size:10px;color:#64748b;text-align:center;margin-top:6px;"><i class="fa-solid fa-hand-pointer"></i> Click to expand</div>
        </div>`, { className: 'cluster-popup', closeButton: false, autoPan: false }).openPopup();
    });

    clusterGroup.on('clustermouseout', function (e) {
        e.layer.closePopup();
    });

    // Track spiderfy state - exposed on window so updateMapMarkers can skip rebuild
    window._spiderfiedCluster = null;
    let _spiderfyLock = false;

    clusterGroup.on('clusterclick', function (e) {
        e.layer.closePopup();
        // If clicking the same cluster that's already spiderfied, close it
        if (window._spiderfiedCluster === e.layer) {
            e.layer.unspiderfy();
            window._spiderfiedCluster = null;
            return;
        }
        // Close any previously spiderfied cluster
        if (window._spiderfiedCluster) {
            try { window._spiderfiedCluster.unspiderfy(); } catch (_) {}
        }
        _spiderfyLock = true;
        window._spiderfiedCluster = e.layer;
        e.layer.spiderfy();
        setTimeout(() => { _spiderfyLock = false; }, 500);
    });

    // Click on map background: close spider
    map.on('click', function () {
        if (_spiderfyLock) return;
        if (window._spiderfiedCluster) {
            try { window._spiderfiedCluster.unspiderfy(); } catch (_) {}
            window._spiderfiedCluster = null;
        }
    });

    // When cluster unspiderfies (by any means), clear our reference
    clusterGroup.on('unspiderfied', function () {
        window._spiderfiedCluster = null;
    });
}

function updateMapMarkers() {
    // Skip full map rebuild while a spider is open - user is interacting with it
    if (window._spiderfiedCluster) return;

    clusterGroup.clearLayers();
    _markerById = {};   // rebuilt below; reverse map↔feed highlight relies on it
    if (heatLayer) { map.removeLayer(heatLayer); heatLayer = null; }

    const heatPoints = [];
    // C1-c: at scale, plotting the newest-N working set shows a non-representative
    // slice (SCALE-04). When the feed is truncated + unfiltered and we have the
    // full lean marker set, plot THAT (the honest Common Operating Picture);
    // otherwise plot the client-filtered working set (exact at small scale, and
    // the only set that reflects an active client filter).
    const filteredReports = (_scopeAggregatesActive() && Array.isArray(_scopeMarkers) && _scopeMarkers.length)
        ? _scopeMarkers
        : _getFilteredReports();

    filteredReports.forEach(r => {
        if (!r.location) return;
        const lat = r.location.latitude;
        const lng = r.location.longitude;
        const color = SEV_COLORS[r.severity] || '#64748b';

        // Marker with infrastructure category icon
        const infraIc = INFRA_ICONS[r.infrastructure_type] || 'fa-circle';
        // Duplicate collapse: ONE pin per incident. When duplicates are merged
        // beneath this primary, the pin wears a "N reports" count (primary + dups)
        // instead of N overlapping pins.
        const _dupN = r.duplicate_count || 0;
        const _dupBadge = _dupN > 0
            ? `<span class="crisp-marker-count" title="${_dupN + 1} corroborating reports (${_dupN} merged)" style="position:absolute;top:-6px;right:-6px;background:#0ea5e9;color:#fff;border:1.5px solid #0b1220;border-radius:9px;min-width:16px;height:16px;padding:0 3px;font-size:10px;font-weight:700;line-height:13px;text-align:center;">${_dupN + 1}</span>`
            : '';
        const markerIcon = L.divIcon({
            className: 'crisp-marker',
            html: `<div class="crisp-marker-pin" style="position:relative;background:${color};box-shadow:0 2px 12px ${color}aa;">
                <i class="fa-solid ${infraIc}"></i>${_dupBadge}
            </div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
        });
        const marker = L.marker([lat, lng], { icon: markerIcon });
        marker._crispReport = r;
        _markerById[r.id] = marker;   // registry for feed→marker highlight
        marker.on('click', () => window.openIncident(r.id, { operationId: r.crisis_event_id || null }));   // ROUTE-04: keep op context (incl. lean markers at scale)

        // Tooltip on hover
        marker.bindTooltip(() => {
            const img = r.media?.find(m => m.type === 'IMAGE');
            return `<div style="padding:8px;min-width:180px;">
                ${img ? `<img src="${getMediaUrl(img.url)}" style="width:100%;height:70px;object-fit:cover;border-radius:6px;margin-bottom:6px;">` : ''}
                <div style="font-weight:700;font-size:14px;color:${color};">${r.severity} - ${r.infrastructure_type}</div>
                <div style="font-size:13px;color:#94a3b8;margin-top:2px;">${(r.description || '').substring(0, 60)}</div>
                ${_dupN > 0 ? `<div style="font-size:12px;color:#7dd3fc;margin-top:4px;">🔗 ${_dupN + 1} corroborating reports (${_dupN} merged)</div>` : ''}
                <div style="font-size:12px;color:#475569;margin-top:4px;">${timeAgo(r.server_created_at)}</div>
            </div>`;
        }, { className: 'rich-tooltip', direction: 'top', offset: [0, -8] });

        clusterGroup.addLayer(marker);

        // Heat data
        const intensity = (SEV_SCORE[r.severity] || 1) / 10;
        heatPoints.push([lat, lng, intensity]);
    });

    // Heat layer - guard against zero-size canvas (can throw getImageData error)
    if (heatPoints.length > 0) {
        try {
            heatLayer = L.heatLayer(heatPoints, {
                radius: 30, blur: 20, maxZoom: 10,
                gradient: { 0.2: '#22c55e', 0.4: '#eab308', 0.6: '#f97316', 0.8: '#ef4444', 1.0: '#dc2626' }
            }).addTo(map);
        } catch (_) { /* map not fully sized yet - heat layer will be added on next update */ }
    }

    // Auto-zoom on first load
    if (!firstZoomDone && filteredReports.some(r => r.location)) {
        const pts = filteredReports.filter(r => r.location).map(r => [r.location.latitude, r.location.longitude]);
        map.flyToBounds(L.latLngBounds(pts), { padding: [80, 80], maxZoom: 10 });
        firstZoomDone = true;
    }
}

function focusMapOnNode(path) {
    // Clear old boundaries
    boundaryLayers.forEach(l => map.removeLayer(l));
    boundaryLayers = [];

    const parts = path.split('|');
    let cur = buildControlPanelTree(allReports);
    for (const p of parts) { if (cur && cur[p]) cur = cur[p]; else return; }

    const incs = collectIncidents(cur).filter(r => r.location);
    if (incs.length === 0) return;

    const latlngs = incs.map(r => [r.location.latitude, r.location.longitude]);
    const bounds = L.latLngBounds(latlngs);

    // Draw boundary circle/rectangle
    if (incs.length === 1) {
        const c = L.circle(latlngs[0], {
            radius: 1000, color: '#ffae00', fillColor: '#ffae00',
            fillOpacity: 0.08, weight: 2, dashArray: '6,4'
        }).addTo(map);
        boundaryLayers.push(c);
    } else {
        // Adaptive boundary
        const center = bounds.getCenter();
        const corner = bounds.getNorthEast();
        const radius = center.distanceTo(corner) * 1.2;
        const c = L.circle(center, {
            radius: Math.max(radius, 500), color: '#ffae00', fillColor: '#ffae00',
            fillOpacity: 0.06, weight: 2, dashArray: '8,5'
        }).addTo(map);
        boundaryLayers.push(c);
    }

    map.flyToBounds(bounds.pad(0.3), { maxZoom: 14 });
}

// ── Pending Deletions Admin View ─────────────────────────────────────────────
let _pendingDeletions = [];

async function _checkPendingDeletions() {
    try {
        // M15 (Phase-4): filter pending deletions SERVER-SIDE and read the true
        // total from X-Total-Count. The old `include_deleted=true` + client filter
        // ran over the newest-500 listing slice, so beyond 500 reports it silently
        // undercounted the deletion backlog. (Deletion governance is global by
        // design - it's an admin/privacy concern, not an op-scoped operational metric.)
        const res = await fetch(`${API}/?pending_deletion=true&limit=200`);
        if (!res.ok) return;
        const all = await res.json();
        _pendingDeletions = Array.isArray(all) ? all : [];
        const total = parseInt(res.headers.get('X-Total-Count') || String(_pendingDeletions.length), 10);
        const btn = document.getElementById('btn-pending-deletions');
        const badge = document.getElementById('deletion-count-badge');
        if (btn && badge) {
            btn.style.display = total > 0 ? 'inline-flex' : 'none';
            badge.textContent = total;
        }
    } catch (_) {}
}

window.showPendingDeletions = function () {
    const panel = document.getElementById('deletions-panel');
    const body = document.getElementById('del-panel-body');
    if (!panel || !body) return;
    if (window.__crispOpenExclusivePanel) window.__crispOpenExclusivePanel('deletions-panel');
    panel.style.display = 'flex';

    // Bug-fix: always clear the footer first so an empty list can't leave a
    // stale "Purge All (1)" button on screen from the previous render.
    const footerEl = document.getElementById('del-panel-footer');
    if (footerEl) footerEl.innerHTML = '';

    if (_pendingDeletions.length === 0) {
        body.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-dim);"><i class="fa-solid fa-circle-check" style="font-size:24px;color:#22c55e;"></i><br>No pending deletions</div>';
        return;
    }

    const expiredCount = _pendingDeletions.filter(r => {
        const delAt = new Date(ensureUTC(r.deletion_requested_at));
        return (Date.now() - delAt.getTime()) > 86400000;
    }).length;

    body.innerHTML = _pendingDeletions.map(r => {
        const delAt = new Date(ensureUTC(r.deletion_requested_at));
        const expiresAt = new Date(delAt.getTime() + 24 * 60 * 60 * 1000);
        const remaining = Math.max(0, expiresAt - Date.now());
        const hrs = Math.floor(remaining / 3600000);
        const mins = Math.floor((remaining % 3600000) / 60000);
        const countdown = remaining > 0 ? `${hrs}h ${mins}m remaining` : 'Expired - awaiting purge';
        const expired = remaining <= 0;
        const loc = r.location?.user_location_name || r.location?.device_location_name || 'Unknown';
        const sevColor = SEV_COLORS[r.severity] || '#64748b';

        return `<div class="del-item ${expired ? 'del-expired' : ''}">
            <div class="del-item-info">
                <div style="display:flex;align-items:center;gap:6px;">
                    <span style="color:${sevColor};font-weight:700;">${r.infrastructure_type}</span>
                    <span class="detail-sev-badge detail-sev-${r.severity}" style="font-size:12px;padding:1px 8px;">${r.severity}</span>
                </div>
                <div style="font-size:14px;color:var(--text-sub);margin-top:2px;">${loc} · ${timeAgo(r.server_created_at)}</div>
                <div style="font-size:13px;color:${expired ? '#ef4444' : '#f59e0b'};margin-top:4px;display:flex;align-items:center;gap:4px;">
                    <i class="fa-solid ${expired ? 'fa-clock' : 'fa-hourglass-half'}"></i>
                    Deletion requested ${timeAgo(r.deletion_requested_at)} · ${countdown}
                </div>
                <div style="font-size:12px;color:var(--text-dim);margin-top:2px;">Device: ${r.device_id?.substring(0, 8)}... · ID: ${r.id.substring(0, 8)}...</div>
            </div>
        </div>`;
    }).join('');

    // Footer with purge button
    const footer = document.getElementById('del-panel-footer');
    if (footer) {
        footer.innerHTML = `
            <div style="display:flex;gap:8px;padding:12px 14px;border-top:1px solid var(--border);">
                <button class="dp-dock-btn" style="background:rgba(239,68,68,0.15);color:#ef4444;border:1px solid rgba(239,68,68,0.3);flex:1;" onclick="purgeAllDeletions()">
                    <i class="fa-solid fa-trash"></i> Purge All (${_pendingDeletions.length})
                </button>
                ${expiredCount > 0 ? `<button class="dp-dock-btn" style="background:rgba(249,115,22,0.12);color:#f97316;border:1px solid rgba(249,115,22,0.25);flex:1;" onclick="purgeExpiredOnly()">
                    <i class="fa-solid fa-clock"></i> Purge Expired (${expiredCount})
                </button>` : ''}
            </div>
        `;
    }
};

window.closeDeletionsPanel = function () {
    const panel = document.getElementById('deletions-panel');
    if (panel) panel.style.display = 'none';
};

// Step-up ("sudo mode") for IRREVERSIBLE actions (the hard-purge). Replaces the
// old shared CRISP_ADMIN_KEY + window.prompt: we re-confirm the operator's
// identity ONCE via their authenticator (TOTP) code - or account password if no
// MFA - then cache a short-lived step-up token (~10 min) in sessionStorage. The
// server (POST /auth/step-up) issues + the purge endpoints enforce the real expiry.
const _STEPUP_TOKEN_KEY = 'crisp_stepup_token';
const _STEPUP_EXP_KEY = 'crisp_stepup_exp';

function _ensureStepUpStyles() {
    if (document.getElementById('stepup-styles')) return;
    const s = document.createElement('style');
    s.id = 'stepup-styles';
    s.textContent = `
      .stepup-overlay{position:fixed;inset:0;z-index:100048;display:flex;align-items:center;
        justify-content:center;background:rgba(4,10,20,.62);backdrop-filter:blur(2px)}
      .stepup-card{width:380px;max-width:92vw;background:#101a2e;border:1px solid #233149;
        border-radius:14px;padding:20px 22px;box-shadow:0 18px 60px rgba(0,0,0,.5);color:#e6eefb}
      .stepup-card h3{margin:0 0 8px;font-size:16px}
      .stepup-card p{margin:0 0 14px;font-size:13px;color:#9fb3d1;line-height:1.45}
      .stepup-hint{color:#6b7d99;font-size:12px}
      .stepup-card input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:9px;
        border:1px solid #2b3b56;background:#0b1422;color:#e6eefb;font-size:15px;letter-spacing:.04em}
      .stepup-card input:focus{outline:none;border-color:#418FDE}
      .stepup-err{color:#f87171;font-size:12px;min-height:16px;margin-top:6px}
      .stepup-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:8px}
      .stepup-actions button{padding:8px 16px;border-radius:9px;border:1px solid #2b3b56;
        background:#1b2942;color:#cbd9ef;font-size:13px;cursor:pointer}
      .stepup-actions .stepup-ok{background:#418FDE;border-color:#418FDE;color:#fff;font-weight:600}`;
    document.head.appendChild(s);
}

// Promise<string|null> - the entered code, or null on cancel. In-app modal (no
// native prompt()), focus-managed, Enter to confirm / Esc to cancel.
function _promptStepUp(errMsg) {
    _ensureStepUpStyles();
    return new Promise((resolve) => {
        const old = document.getElementById('stepup-overlay');
        if (old) old.remove();
        const ov = document.createElement('div');
        ov.id = 'stepup-overlay';
        ov.className = 'stepup-overlay';
        ov.innerHTML =
            '<div class="stepup-card" role="dialog" aria-modal="true" aria-label="Confirm your identity">' +
            '<h3>Confirm it’s you</h3>' +
            '<p>This permanently deletes report data and cannot be undone. Enter the ' +
            '6-digit code from your authenticator app to continue.</p>' +
            '<input id="stepup-input" type="password" inputmode="numeric" autocomplete="one-time-code" ' +
            'placeholder="6-digit authenticator code" />' +
            '<div class="stepup-err" id="stepup-err">' + (errMsg ? escapeHtml(errMsg) : '') + '</div>' +
            '<div class="stepup-actions"><button id="stepup-cancel">Cancel</button>' +
            '<button class="stepup-ok" id="stepup-ok">Confirm</button></div></div>';
        document.body.appendChild(ov);
        const input = ov.querySelector('#stepup-input');
        const done = (val) => { try { ov.remove(); } catch (_e) {} resolve(val); };
        ov.querySelector('#stepup-cancel').addEventListener('click', () => done(null));
        ov.addEventListener('click', (e) => { if (e.target === ov) done(null); });
        ov.querySelector('#stepup-ok').addEventListener('click', () => done((input.value || '').trim() || null));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); done((input.value || '').trim() || null); }
            else if (e.key === 'Escape') done(null);
        });
        setTimeout(() => { try { input.focus(); } catch (_e) {} }, 30);
    });
}

// Resolve a valid step-up token: reuse the cached one within its window, else
// re-confirm via the modal + POST /auth/step-up. Returns the token or null.
//
// NOTE: these calls deliberately use _origFetch (the raw, pre-interceptor fetch)
// and attach the JWT by hand. The global fetch wrapper (top of this file) treats
// ANY /api/ 401 as "session dead → wipe token + redirect to login". A wrong
// authenticator code (step-up POST → 401) or an expired step-up token (purge →
// 401) must NOT log the operator out - we want to re-prompt in place.
async function _ensureStepUp(forcePrompt = false, errMsg = '') {
    if (!forcePrompt) {
        try {
            const tok = sessionStorage.getItem(_STEPUP_TOKEN_KEY);
            const exp = parseInt(sessionStorage.getItem(_STEPUP_EXP_KEY) || '0', 10);
            if (tok && exp && Date.now() < exp - 15000) return tok;   // 15s safety buffer
        } catch (_e) {}
    }
    const base = API.replace('/api/v1/reports', '/api/v1/auth/step-up');
    for (let attempt = 0; attempt < 4; attempt++) {   // bounded so a persistent 401 can't loop forever
        const code = await _promptStepUp(errMsg);
        if (!code) return null;   // cancelled
        try {
            const res = await _origFetch(base, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem('crisp_token') || ''}`,
                },
                body: JSON.stringify({ code }),
            });
            if (res.ok) {
                const body = await res.json();
                const ttl = (Number(body.expires_in) || 600) * 1000;
                try {
                    sessionStorage.setItem(_STEPUP_TOKEN_KEY, body.step_up_token);
                    sessionStorage.setItem(_STEPUP_EXP_KEY, String(Date.now() + ttl));
                } catch (_e) {}
                return body.step_up_token;
            }
            errMsg = res.status === 401
                ? 'Incorrect code - please try again.'
                : 'Confirmation failed - please try again.';
        } catch (_e) {
            errMsg = 'Network error - please try again.';
        }
    }
    showToast('Too many attempts - identity not confirmed.', 'error');
    return null;
}

// Fetch wrapper for step-up-gated endpoints: attaches X-Step-Up (+ JWT) via the
// raw fetch; on a 401 it clears the cached step-up token and re-confirms once.
async function _stepUpFetch(url, init = {}) {
    let tok = await _ensureStepUp();
    if (!tok) return null;
    const go = (t) => _origFetch(url, Object.assign({}, init, {
        headers: Object.assign({}, init.headers || {}, {
            'X-Step-Up': t,
            'Authorization': `Bearer ${localStorage.getItem('crisp_token') || ''}`,
        }),
    }));
    let res = await go(tok);
    if (res.status === 401) {
        try { sessionStorage.removeItem(_STEPUP_TOKEN_KEY); sessionStorage.removeItem(_STEPUP_EXP_KEY); } catch (_e) {}
        tok = await _ensureStepUp(true, 'Your confirmation expired - please re-confirm.');
        if (!tok) return res;
        res = await go(tok);
    }
    return res;
}

window.purgeAllDeletions = async function () {
    if (!confirm(`Permanently delete all ${_pendingDeletions.length} pending deletion(s)? This cannot be undone.`)) return;
    try {
        const res = await _stepUpFetch(`${API}/purge-all-pending`, { method: 'POST' });
        if (!res) { showToast('Purge cancelled - identity not confirmed', 'error'); return; }
        if (res.ok) {
            const result = await res.json();
            showToast(`${result.purged} report(s) permanently deleted`, 'success');
            // Re-fetch from the server instead of trusting client state - the
            // previous "_pendingDeletions = []" was correct in theory but the
            // counter badge (driven by a separate poll) could have stayed
            // stale if the toggle button rendered from the old cache.
            _pendingDeletions = [];
            await _checkPendingDeletions();
            showPendingDeletions();
            fetchReports();
        } else if (res.status === 403) {
            showToast('Purge refused: your account is not authorized', 'error');
        } else if (res.status === 401) {
            showToast('Purge refused: identity confirmation required', 'error');
        } else {
            showToast(`Purge failed (HTTP ${res.status})`, 'error');
        }
    } catch (e) {
        showToast('Purge failed - check connection', 'error');
    }
};

window.purgeExpiredOnly = async function () {
    if (!confirm('Permanently delete all expired deletion requests?')) return;
    try {
        const res = await _stepUpFetch(`${API}/purge-expired`, { method: 'POST' });
        if (!res) { showToast('Purge cancelled - identity not confirmed', 'error'); return; }
        if (res.ok) {
            const result = await res.json();
            showToast(`Purged ${result.purged} expired report(s)`, 'success');
            _checkPendingDeletions();
            setTimeout(() => showPendingDeletions(), 1000);
            fetchReports();
        } else if (res.status === 403) {
            showToast('Purge refused: your account is not authorized', 'error');
        } else if (res.status === 401) {
            showToast('Purge refused: identity confirmation required', 'error');
        } else {
            showToast(`Purge failed (HTTP ${res.status})`, 'error');
        }
    } catch (e) {
        showToast('Purge failed - check connection', 'error');
    }
};

// Check on every poll cycle
const _origFetchReports = fetchReports;

// ── Export Functions ──────────────────────────────────────────────────────────
// Jun 2026 (export audit) - every format now downloads through the BACKEND
// export endpoints via an authenticated fetch -> blob:
//   * Shapefile/KML previously used window.open, which bypasses the fetch
//     auth interceptor -> guaranteed 401 in a new tab while the UI toasted
//     success (broken for every role).
//   * CSV/GeoJSON previously used client-side assembly that omitted the 6
//     satellite verification columns (UNDP must-have #11) and ignored the
//     backend's richer schema (HXL row, appended metadata columns).
// The on-screen status + time filters pass through as query params (the
// composite "Active" view maps to status=PENDING,VERIFIED - the backend
// accepts a comma list). Client-side assembly survives only as the offline
// fallback for CSV/GeoJSON, clearly labelled as degraded.
function _exportFilterParams() {
    const params = new URLSearchParams();
    // Status from the LIVE feed: the active lifecycle tab (when no queue owns the
    // population). `statusFilter` was retired with the flat queue (v111) - reading it
    // forced every export to PENDING,VERIFIED regardless of the visible tab, silently
    // dropping Responding/Resolved rows (must-have #11 export correctness).
    const _TAB_EXPORT_STATUS = { pending: 'PENDING,VERIFIED', responding: 'RESPONDING', resolved: 'RESOLVED,FALSE_ALARM' };
    if (!_activeQueue && _activeStatusTab === 'rejected') {
        // The Rejected tab is verdict-based (any status); the backend excludes REJECTED
        // by default, so an explicit reviewer_verdict is required to export them.
        params.set('reviewer_verdict', 'REJECTED');
    } else if (!_activeQueue && _TAB_EXPORT_STATUS[_activeStatusTab]) {
        params.set('status', _TAB_EXPORT_STATUS[_activeStatusTab]);
    }
    if (!_activeQueue && timeFilterHours > 0) {
        // Mirror the feed: a queue owns the population, so time is NOT applied under
        // a queue (else the export drops queue-matching rows the operator sees).
        params.set('since', new Date(Date.now() - timeFilterHours * 3600000).toISOString());
    }
    // C2 (Phase-0): exports MUST respect the active operation scope. When the
    // feed is scoped to an operation (#/incidents;op={id}), the Tools->Export
    // submenu and the Export Center "current filters" scope would otherwise
    // silently download the GLOBAL dataset. Thread the scope so every export
    // path that goes through this helper inherits it.
    if (_activeCrisisEventId) params.set('crisis_event_id', _activeCrisisEventId);
    return params;
}
// Read-only debug hook: the live export query string (so tests can assert exports
// follow the active status tab / scope - must-have #11).
window.__crispExportParams = function () { try { return _exportFilterParams().toString(); } catch (_e) { return ''; }
}
window._exportFilterParams = _exportFilterParams;

// Jun 2026 (export audit) - per-report evidence bundle: ZIP of evidence.json,
// completed media files, stored satellite snapshots and a README, so a
// verifier (or UNDP judge) can review one report fully OFFLINE.
window.downloadEvidenceBundle = async function (reportId) {
    showToast('Preparing evidence bundle…', 'info');
    try {
        const base = API.replace('/api/v1/reports', '/api/v1/exports');
        const res = await fetch(`${base}/evidence-bundle/${encodeURIComponent(reportId)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `crisp_evidence_${String(reportId).slice(0, 8)}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1500);
        showToast('Evidence bundle downloaded', 'success');
    } catch (e) {
        showToast(`Evidence bundle failed: ${e.message}`, 'error');
    }
};

// UX-I: single-incident export. Reuses the export endpoints scoped to one report
// (?report_id=) - only the formats that make sense for ONE incident (CSV/GeoJSON/
// KML; PDF + Evidence ZIP have their own per-report routes). The aggregate formats
// (Sitrep / Analytics summary / Shapefile / Data dictionary) are NOT offered here -
// they live in the full Export Center.
window.exportIncidentFormat = async function (id, fmt) {
    const base = API.replace('/api/v1/reports', '/api/v1/exports');
    const url = `${base}/${fmt}?report_id=${encodeURIComponent(id)}`;
    showToast(`Preparing ${fmt.toUpperCase()}…`, 'info');
    try {
        const res = await fetch(url);   // auth header injected by the fetch interceptor
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const cd = res.headers.get('content-disposition') || '';
        const m = /filename=([^;]+)/.exec(cd);
        const name = m ? m[1].trim().replace(/^"|"$/g, '') : `crisp_incident_${String(id).slice(0, 8)}.${fmt}`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1500);
        showToast(`${fmt.toUpperCase()} downloaded`, 'success');
    } catch (e) { showToast(`Export failed: ${e.message}`, 'error'); }
};

window.exportData = async function (format) {
    const fmt = ['csv', 'geojson', 'shapefile', 'kml', 'pdf'].includes(format) ? format : 'csv';
    const base = API.replace('/api/v1/reports', '/api/v1/exports');
    const qs = _exportFilterParams().toString();
    const url = `${base}/${fmt}${qs ? '?' + qs : ''}`;
    showToast(`Preparing ${fmt.toUpperCase()} export…`, 'info');
    try {
        const res = await fetch(url);   // auth header injected by the interceptor
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const cd = res.headers.get('content-disposition') || '';
        const m = /filename=([^;]+)/.exec(cd);
        const fallbackExt = fmt === 'shapefile' ? 'zip' : fmt;
        const name = m ? m[1].trim().replace(/^"|"$/g, '') : `crisp_reports.${fallbackExt}`;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1500);
        showToast(`${fmt.toUpperCase()} export downloaded`, 'success');
    } catch (e) {
        if (fmt === 'csv' || fmt === 'geojson') {
            // Degraded offline fallback over the already-loaded session
            // reports - explicitly labelled (no satellite columns).
            const filtered = getFilteredReports();
            if (fmt === 'geojson') exportGeoJSON(filtered); else exportCSV(filtered);
            showToast('Backend unreachable - exported the reports loaded in this session instead (no satellite columns).', 'warning');
        } else {
            showToast(`${fmt.toUpperCase()} export failed: ${e.message}`, 'error');
        }
    }
};


window.exportNodeData = function (path) {
    const parts = path.split('|');
    // Same source as the visible tree (filtered), not raw allReports.
    let cur = buildControlPanelTree(_lastTreeFiltered || allReports);
    for (const p of parts) { if (cur && cur[p]) cur = cur[p]; else return; }
    const incs = collectIncidents(cur);
    exportCSV(incs, `crisp_${path.replace(/\|/g, '_')}`);
};

window.exportNodeDataFromIncidents = function (ids) {
    const incs = allReports.filter(r => ids.includes(r.id));
    // Timestamped name - the old fixed 'crisp_hotspot' overwrote / (1)-suffixed
    // successive exports with no way to tell them apart.
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    exportCSV(incs, `crisp_hotspot_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`);
};

function getFilteredReports() {
    // Mirror the visible feed exactly (scope + queue + status tab + Critical/time/
    // search/chips) so the offline CSV/GeoJSON fallback matches what's on screen.
    // Was branching on the retired `statusFilter` (frozen at 'active').
    return _clusterFilteredReports();
}

function exportCSV(reports, filename = 'crisp_export') {
    const headers = ['ID', 'Severity', 'Infrastructure', 'Infrastructure_Name', 'Status', 'Crisis_Type', 'Damage_Classification', 'Debris_Clearing', 'Description', 'Latitude', 'Longitude', 'Time', 'Source', 'Building_ID', 'Country', 'Region'];
    const rows = reports.map(r => [
        r.id, r.severity, r.infrastructure_type, `"${(r.infrastructure_name || '').replace(/"/g, '""')}"`, r.status,
        r.crisis_type || '', r.damage_classification || '', r.debris_clearing_needed ?? '',
        `"${(r.description || '').replace(/"/g, '""')}"`,
        r.location?.latitude || '', r.location?.longitude || '',
        r.server_created_at, r.source, r.building_id || '', r._country || '', r._region || ''
    ]);
    const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    downloadFile(csv, `${filename}.csv`, 'text/csv');
    showToast(`Exported ${reports.length} reports as CSV`, 'success');
}

function exportGeoJSON(reports, filename = 'crisp_export') {
    const features = reports.filter(r => r.location).map(r => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [r.location.longitude, r.location.latitude] },
        properties: {
            id: r.id, severity: r.severity, infrastructure: r.infrastructure_type,
            infrastructure_name: r.infrastructure_name || '', crisis_type: r.crisis_type || '',
            damage_classification: r.damage_classification || '', debris_clearing: r.debris_clearing_needed ?? '',
            building_id: r.building_id || '',
            status: r.status, description: r.description, time: r.server_created_at,
            source: r.source, country: r._country, region: r._region
        }
    }));
    const geojson = JSON.stringify({ type: 'FeatureCollection', features }, null, 2);
    downloadFile(geojson, `${filename}.geojson`, 'application/geo+json');
    showToast(`Exported ${features.length} features as GeoJSON`, 'success');
}

function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ── Priority Zones ───────────────────────────────────────────────────────────
window.togglePriorityZone = function (path) {
    if (priorityZones.has(path)) {
        priorityZones.delete(path);
        showToast('Priority zone removed', 'info');
    } else {
        priorityZones.add(path);
        showToast('Marked as Priority Zone', 'success');
    }
    localStorage.setItem('crisp_priority_zones', JSON.stringify([...priorityZones]));
    renderFeed();
};

// ── State Changers ───────────────────────────────────────────────────────────
window.toggleTreeNode = (p) => { treeState[p] = !treeState[p]; renderFeed(); };

window.setStatusFilter = (f) => {
    statusFilter = f;
    document.querySelectorAll('.stab').forEach(btn => btn.classList.remove('active'));
    const tab = document.getElementById(`stab-${f}`);
    if (tab) tab.classList.add('active');
    renderFeed();
};

window.setTimeFilter = (h) => {
    timeFilterHours = h;
    document.querySelectorAll('.time-btn').forEach(b => b.classList.remove('active'));
    // K.5.b - guard the active-button bookkeeping behind the implicit
    // click `event` global since tests + programmatic callers don't
    // necessarily provide one. Falls through cleanly when called from
    // a non-click context (e.g. e2e test stubbing).
    try {
        if (typeof event !== 'undefined' && event && event.target && event.target.classList) {
            event.target.classList.add('active');
        }
    } catch (_) { /* no event in scope - programmatic call */ }
    renderFeed();
};
// K.5.b - test-only helper that bypasses the time-button DOM
// bookkeeping for e2e specs that drive the filter programmatically.
window.__crispSetTimeFilterHoursForTest = (h) => {
    timeFilterHours = h;
    renderFeed();
};

// ── Geocoding (Offline-First) ────────────────────────────────────────────────
let worldGeoJSON = null;
// v3.1: Clear old cache format (didn't store individual fields)
const _rawCache = JSON.parse(localStorage.getItem('crisp_geo_cache') || '{}');
const _firstVal = Object.values(_rawCache)[0];
const geoCache = (_firstVal && typeof _firstVal === 'object' && 'city' in _firstVal) ? _rawCache : {};
if (Object.keys(geoCache).length === 0 && Object.keys(_rawCache).length > 0) {
    localStorage.removeItem('crisp_geo_cache');
}

async function loadWorldData() {
    try {
        const res = await fetch('world.json');
        worldGeoJSON = await res.json();
        console.log('World GeoJSON loaded');
    } catch (e) { console.error('Failed to load world.json', e); }
}

function offlineGeocode(lat, lng) {
    if (!worldGeoJSON || !window.turf) return null;
    const pt = turf.point([lng, lat]);
    for (const f of worldGeoJSON.features) {
        if (turf.booleanPointInPolygon(pt, f)) {
            const cc = (f.id || '').toUpperCase();
            const countryName = f.properties.name || 'Unknown Country';
            return {
                country: countryName,
                country_code: cc,
                continent_code: COUNTRY_TO_CONTINENT[cc] || 'Global',
                region_fallback: `${countryName} Strategy Zone`
            };
        }
    }
    return null;
}

async function updateGeodata(reports) {
    let changed = false;
    const pendingGeoRequests = [];

    for (const r of reports) {
        if (!r.location) continue;
        // Skip if already fully geocoded (has a real city/town name)
        if (r._geo_city && r._country && r._continent_code) continue;

        const lat = r.location.latitude;
        const lng = r.location.longitude;
        const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;

        // 1. Offline geocode (country/continent)
        if (!r._continent_code) {
            const offline = offlineGeocode(lat, lng);
            if (offline) {
                r._country = offline.country;
                r._continent_code = offline.continent_code;
                changed = true;
            }
        }

        // 2. Cache check for detailed geo
        if (geoCache[cacheKey]) {
            const c = geoCache[cacheKey];
            r._geo_city = c.city;
            r._geo_town = c.town;
            r._geo_suburb = c.suburb;
            r._geo_state = c.state;
            r._region = c.city || c.town || c.suburb || c.state || r._region;
            r._country = c.co || r._country;
            r._continent_code = c.cc || r._continent_code;
            changed = true;
        } else if (!r._geo_requested) {
            r._geo_requested = true;
            pendingGeoRequests.push({ r, lat, lng, cacheKey });
        }
    }

    // Fire background geo requests (rate-limited, 1 per second)
    for (let i = 0; i < pendingGeoRequests.length; i++) {
        const { r, lat, lng, cacheKey } = pendingGeoRequests[i];
        // Stagger requests to avoid rate limits
        setTimeout(() => {
            reverseGeocode(r, lat, lng, cacheKey);
        }, i * 1100);
    }

    // Apply 15km spatial clustering for region grouping
    applyRegionClustering(reports);

    if (changed) renderFeed();
}

async function reverseGeocode(r, lat, lng, cacheKey) {
    // Reverse-geocode coords to a place-name label for the feed. geocode.maps.co
    // was the former primary, but it REQUIRES an API key we don't ship - every
    // call 401'd and fell straight through to the Nominatim fallback, so we were
    // making TWO requests per report (one always-doomed) for one result. Go
    // straight to OpenStreetMap Nominatim (no key; usage policy honored via the
    // page Referer). The browser ignores a custom User-Agent header, so it's
    // dropped. On failure the row keeps its coordinate label - never blocks.
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10`);
        if (res.ok) {
            const data = await res.json();
            if (data && data.address) {
                applyGeoResult(r, data.address, cacheKey);
            }
        }
    } catch (e) { /* offline / rate-limited - keep the coordinate label */ }
}

function applyGeoResult(r, address, cacheKey) {
    const a = address;
    const city = a.city || null;
    const town = a.town || null;
    const village = a.village || null;
    const suburb = a.suburb || null;
    const state = a.state || null;
    const cc = (a.country_code || '').toUpperCase();
    const iso3 = ISO2_TO_ISO3[cc] || cc;
    const continent = COUNTRY_TO_CONTINENT[iso3] || COUNTRY_TO_CONTINENT[cc] || r._continent_code || 'Global';

    // Store individual fields for clustering to use
    r._geo_city = city || town || village;
    r._geo_town = town || village;
    r._geo_suburb = suburb;
    r._geo_state = state;
    r._country = a.country || r._country;
    r._continent_code = continent;

    // Set region to best available name
    const regionName = city || town || village || suburb || state;
    if (regionName) r._region = regionName;

    // Cache with individual fields
    geoCache[cacheKey] = {
        city: city || town || village,
        town: town || village,
        suburb,
        state,
        co: a.country,
        cc: continent
    };
    // STALE-09 (Phase-5): cap the reverse-geocode cache (was unbounded - a
    // long-running session grew it in localStorage without limit). Keep the
    // newest ~2000 entries (object insertion order) and trim the oldest.
    try {
        const _gk = Object.keys(geoCache);
        if (_gk.length > 2000) for (const _k of _gk.slice(0, _gk.length - 2000)) delete geoCache[_k];
    } catch (_e) {}
    localStorage.setItem('crisp_geo_cache', JSON.stringify(geoCache));

    // Re-cluster and re-render
    applyRegionClustering(allReports);
    renderFeed();
}

// ── Data Fetching ────────────────────────────────────────────────────────────
const REPORTS_CACHE_KEY = 'crisp_reports_v1';

function _applyReportData(data) {
    let detailPanelNeedsRefresh = false;
    data.forEach(r => {
        if (!knownIds.has(r.id)) {
            knownIds.add(r.id);
            allReports.push(r);
            // Live notification ONLY for genuinely new incidents (not initial page load)
            if (_initialLoadDone && !_seenIds.has(r.id)) {
                _addNotification(r);
            } else {
                // Initial load - silently mark as seen, no flash
                _seenIds.add(r.id);
            }
        } else {
            const idx = allReports.findIndex(x => x.id === r.id);
            if (idx >= 0) {
                const geo = { _region: allReports[idx]._region, _country: allReports[idx]._country, _continent_code: allReports[idx]._continent_code };
                const prev = allReports[idx];
                // Preserve prior fields the incoming poll row may omit (e.g. a
                // transient response where `incident_credibility` serialized as
                // null) so a background poll never silently wipes the just-run
                // assessment. Present keys in `r` (incl. explicit values) still win.
                allReports[idx] = { ...prev, ...r, ...geo };
                if (r.id === selectedId) {
                    const prevImg = prev.media?.find(m => m.type === 'IMAGE');
                    const newImg  = r.media?.find(m => m.type === 'IMAGE');
                    if (newImg && (
                        !prevImg ||
                        prevImg.thumbnail_url    !== newImg.thumbnail_url   ||
                        prevImg.completion_pct   !== newImg.completion_pct  ||
                        prevImg.assembly_status  !== newImg.assembly_status
                    )) detailPanelNeedsRefresh = true;
                    // Audio progressive refresh
                    const prevAud = prev.media?.find(m => m.type === 'AUDIO');
                    const newAud  = r.media?.find(m => m.type === 'AUDIO');
                    if (newAud && (
                        !prevAud ||
                        prevAud.thumbnail_url    !== newAud.thumbnail_url   ||
                        prevAud.completion_pct   !== newAud.completion_pct  ||
                        prevAud.assembly_status  !== newAud.assembly_status
                    )) detailPanelNeedsRefresh = true;
                    if (prev.sync_status !== r.sync_status) detailPanelNeedsRefresh = true;
                }
            } else {
                // Known id but absent from allReports - e.g. setOperationScope
                // cleared allReports on an operation switch (knownIds is NOT
                // cleared, to avoid every report looking "new"). Re-insert here
                // WITHOUT a notification (it's a known report, not a fresh
                // arrival); without this the report is silently dropped and
                // selectReport / the detail deep-link can't find it.
                allReports.push(r);
            }
        }
    });
    updateGeodata(allReports);
    updateMapMarkers();
    renderFeed();
    if (detailPanelNeedsRefresh && selectedId) selectReport(selectedId, true);
    // Guaranteed-delivery: after the feed/map update, check whether any
    // currently-rendered photo group now has a BETTER variant available than
    // the one shown (SMALL → MEDIUM → LARGE). If so, hot-swap the <img src>
    // in-place so analysts see the upgrade without a full panel rebuild.
    _maybeUpgradeDetailImage();
}

// ── Progressive image upgrade on poll ─────────────────────────────────────
// Looks at every .dp-img[data-group-id] and .dp-gallery-thumb[data-group-id]
// in the open detail panel and swaps their <img src> if a better-but-still-
// thumb variant is now available. Zero-cost when no upgrade is available.
//
// May 2026 (HAR-driven, Phase 2): previously this called `bestVariant()`
// which would silently auto-upgrade to LARGE on the first poll where the
// HIGH variant landed - defeating the bandwidth savings. Now it calls
// `thumbVariant()` so the inline view stays small unless the user
// explicitly picks LARGE. If the user IS holding a manual override, we
// honour that (existing behaviour).
function _maybeUpgradeDetailImage() {
    if (!selectedId) return;
    // Phase 2: respect manual tier override - don't auto-upgrade when the
    // user has deliberately picked a tier. `setDetailImageTier` stamps the
    // override; `closeDetail` and report-delete clear it.
    if (_tierOverride.has(selectedId)) return;
    const r = allReports.find(x => x.id === selectedId);
    if (!r) return;
    const images = r.media?.filter(m => m.type === 'IMAGE') || [];
    if (!images.length) return;
    const groups = groupPhotos(images);
    // Build a groupId → pick lookup. Null-group entries are skipped - the
    // legacy single-media path never upgrades.
    // Use `thumbVariant` so polling never silently fetches the LARGE tier;
    // the user has to explicitly click LARGE to pull it.
    const groupMap = new Map();
    for (const g of groups) {
        if (!g.group_id) continue;
        const pick = thumbVariant(g);
        if (pick) groupMap.set(g.group_id, pick);
    }
    if (groupMap.size === 0) return;

    // Main image (primary photo)
    document.querySelectorAll(`#dp-img-view-${selectedId} .dp-img[data-group-id]`).forEach(el => {
        const gid = el.getAttribute('data-group-id');
        const pick = groupMap.get(gid);
        if (!pick || !pick.isFinal) return;
        const currentTier = el.getAttribute('data-current-tier');
        if (currentTier === pick.tier) return;   // already showing this variant
        const img = el.querySelector('img');
        if (img && img.src !== pick.src) {
            img.src = pick.src;
            img.classList.remove('img-thumb-bg');
            img.classList.add('img-full-layer', 'img-ready');
        }
        el.setAttribute('data-current-tier', pick.tier);
        el.classList.remove('dp-img-uploading');
        // Phase 2: sync tier-switcher active button + enable any tier that
        // has now finished assembly since the last render.
        const switcher = el.querySelector('.dp-tier-switcher');
        if (switcher) {
            switcher.querySelectorAll('.dp-tier-btn').forEach(b => {
                b.classList.remove('active');
                // Re-enable buttons whose tier is now complete.
                const tierClass = [...b.classList].find(c => c.startsWith('dp-tier-') && c !== 'dp-tier-btn');
                const tier = tierClass ? tierClass.replace('dp-tier-', '').toUpperCase() : null;
                if (tier) {
                    const g = groups.find(gg => gg.group_id === gid);
                    // 425-fallback: only enable a tier whose blur is done (else /file 425s).
                    const m = g && g.members.find(mm => mm.resolution_tier === tier && mm.assembly_status === 'complete' && mm.url && mm.pii_blur_status !== 'pending');
                    if (m) b.classList.remove('disabled');
                }
            });
            const activeBtn = switcher.querySelector(`.dp-tier-btn.dp-tier-${pick.tier.toLowerCase()}`);
            if (activeBtn) activeBtn.classList.add('active');
        }
        // Refresh the onclick handler so the gallery still opens at this
        // photo group when the analyst clicks the upgraded primary image.
        // groupIdx 0 = primary group; the gallery re-derives the full list
        // at open time so subsequently-added photos still appear.
        el.setAttribute('onclick', `openGallery('${r.id}', 0)`);
    });

    // Gallery strip thumbs (for reports with multiple photos)
    document.querySelectorAll(`#dp-img-view-${selectedId} ~ .dp-gallery .dp-gallery-thumb[data-group-id]`).forEach(el => {
        const gid = el.getAttribute('data-group-id');
        const pick = groupMap.get(gid);
        if (!pick) return;
        const currentTier = el.getAttribute('data-current-tier');
        if (currentTier === pick.tier) return;
        const img = el.querySelector('img');
        if (img && img.src !== pick.src) img.src = pick.src;
        el.setAttribute('data-current-tier', pick.tier);
        // Remove the % badge once the variant is final
        if (pick.isFinal) {
            const pctEl = el.querySelector('.dp-gallery-pct');
            if (pctEl) pctEl.remove();
        }
    });
}

// ── Testability + debug hooks ─────────────────────────────────────────────
// Apr 2026: expose read-only pointers to the module-scope state + the
// poll function so the Playwright E2E suite and ad-hoc DevTools debugging
// can inspect and kick the report list without a 4-second wait.
// NOT used by production code paths - safe to keep always-on.
Object.defineProperty(window, 'allReports', {
    get: () => allReports,
    configurable: true,
});
// Leaflet instances so the map-render spec can walk clusterGroup's layers
// without screen-scraping Leaflet's private DOM. Read-only getters -
// production code never mutates these via `window.*`.
Object.defineProperty(window, '__crispMap', {
    get: () => map,
    configurable: true,
});
Object.defineProperty(window, '__crispClusterGroup', {
    get: () => clusterGroup,
    configurable: true,
});
// Filter-state mirror for the filter spec.
Object.defineProperty(window, '__crispActivePillFilter', {
    get: () => _activePillFilter,
    configurable: true,
});
Object.defineProperty(window, '__crispTimeFilterHours', {
    get: () => timeFilterHours,
    configurable: true,
});
window.__crispFetchReports = () => fetchReports();

// May 2026 (operator-reported, post-iPhone-14 audit) - the listing
// endpoint's server-side `limit: int = 100` default was silently
// truncating the dashboard's view at 100 reports. Top-bar TOTAL pill
// reflected the truncated count, not the true `X-Total-Count`. Pass
// an explicit `?limit=DASHBOARD_PAGE_LIMIT` on every fetch so the
// dashboard sees the full set. 10 000 is the practical render ceiling
// for this dashboard's leaflet + DOM layout (beyond that the map +
// feed degrade regardless of any pagination story); the rare deploy
// that exceeds it logs a console warn so we know proper pagination
// is needed before it becomes a real ops issue.
const DASHBOARD_PAGE_LIMIT = 10000;

async function fetchReports() {
    try {
        const baseUrl = API.endsWith('/') ? API : API + '/';
        // Phase 3: send `?since=<X-Server-Time>` on subsequent polls.
        // First poll (no _lastServerTime) and every Nth poll skip it
        // for a full refresh - that's how deletions get reflected.
        const wantFullRefresh = !_lastServerTime
            || _pollsSinceFullRefresh >= _FULL_REFRESH_EVERY_N_POLLS;
        // Always pin a generous limit so the backend's default of 100
        // doesn't quietly truncate. `&` vs `?` depends on whether
        // `?since=` is already present.
        const limitParam = `limit=${DASHBOARD_PAGE_LIMIT}`;
        // Operations Phase 2 - when an operation is active, scope the feed to it
        // (the backend filters before X-Total-Count, so the count stays scoped).
        const scopeParam = _activeCrisisEventId
            ? '&crisis_event_id=' + encodeURIComponent(_activeCrisisEventId) : '';
        const fetchScope = _activeCrisisEventId;   // scope this request was issued for (validated on response)
        const listUrl = (wantFullRefresh
            ? baseUrl + '?' + limitParam
            : baseUrl + '?since=' + encodeURIComponent(_lastServerTime) + '&' + limitParam)
            + scopeParam;
        // Phase 4: echo back the previous ETag so the server can return
        // 304 if nothing changed. Skip on full-refresh polls so we always
        // get a fresh body to validate the local state against the server
        // truth (otherwise a 304 would short-circuit the deletion-catching
        // path the full-refresh poll exists to do).
        const fetchOpts = {};
        if (!wantFullRefresh && _lastReportsEtag) {
            fetchOpts.headers = { 'If-None-Match': _lastReportsEtag };
        }
        console.log('[CRISP] Fetching from:', listUrl, wantFullRefresh ? '(full refresh)' : '(delta)');
        const res = await fetch(listUrl, fetchOpts);
        console.log('[CRISP] Response:', res.status, res.url);
        // Phase 3: capture the server's clock for the NEXT poll's cursor.
        // Header is echoed back regardless of whether the body is empty -
        // an idle poll still advances the cursor so the window doesn't
        // grow unboundedly.
        const serverTime = res.headers.get('X-Server-Time');
        if (serverTime) _lastServerTime = serverTime;
        // Phase 4: capture the ETag for the next poll. The server echoes
        // the same ETag on a 304, so this works on both 200 and 304.
        const newEtag = res.headers.get('ETag');
        if (newEtag) _lastReportsEtag = newEtag;
        if (wantFullRefresh) {
            _pollsSinceFullRefresh = 0;
        } else {
            _pollsSinceFullRefresh += 1;
        }

        // Phase 4: 304 Not Modified - nothing to do. Local state is
        // already canonical. Skip body parsing + render entirely.
        if (res.status === 304) {
            console.log('[CRISP] 304 - no changes since last poll');
            _updateCacheBadge(false);
            _reschedulePoller();
            return;
        }

        const data = await res.json();
        console.log('[CRISP] Loaded', data.length, wantFullRefresh ? 'reports (full)' : 'delta updates');

        // Scope guard: if the operation scope CHANGED while this request was in
        // flight (e.g. a global poll started just before the operator opened an
        // operation), DISCARD it - applying it would paint the wrong-scope dataset
        // for a frame. The fresh scoped fetch that setOperationScope kicked owns
        // the correct data. This is what guarantees a SINGLE, correct render.
        if (fetchScope !== _activeCrisisEventId) {
            console.debug('[CRISP] discarding stale-scope reports response (scope changed mid-flight)');
            _reschedulePoller();
            return;
        }

        // Scale-out signal - if the backend says there are more rows
        // than the page-limit we asked for, log a warning so we know
        // proper pagination is needed BEFORE the truncation becomes an
        // ops issue. Idempotent; no-op when caught early.
        const xTotalCount = parseInt(res.headers.get('X-Total-Count') || '0', 10);
        // C1-a (Phase-0 hardening): the operator must know whenever the feed is
        // truncated, NOT only past the unreachable 10K client ceiling. The backend
        // caps a listing page at 500 rows, so the old `> DASHBOARD_PAGE_LIMIT`
        // test never fired in the real 501-10000 range and the truncation was
        // silent. Compare the true scope total (X-Total-Count) against what was
        // ACTUALLY returned this poll - any shortfall means hidden reports.
        const returnedCount = Array.isArray(data) ? data.length : 0;
        if (wantFullRefresh) {
            // C1-b: remember the TRUE scope size so counts/banner don't read the
            // truncated working-set length at scale.
            _scopeTotalCount = xTotalCount > 0 ? xTotalCount : returnedCount;
        }
        if (wantFullRefresh && xTotalCount > returnedCount) {
            console.warn(`[CRISP] Feed truncated: X-Total-Count=${xTotalCount} but only ${returnedCount} rows returned (backend page cap). Counts use /analytics/summary + the map uses /reports/markers; the feed list shows the newest ${returnedCount}.`);
            // Operator-visible banner at the top of the header chrome so anyone
            // looking at the dashboard knows what the FEED LIST is not showing.
            _showTruncationBanner(xTotalCount, returnedCount);
            // C1-b/c: pull the authoritative server summary (counts) + the full
            // lean marker set (map) for the active scope so the headline strip,
            // banner total, and Common Operating Picture reflect ALL reports, not
            // the newest N. Lazy - only when truncated (no extra request at small scale).
            try { _fetchScopeSummary(); } catch (_e) {}
            try { _fetchMapMarkers(); } catch (_e) {}
        } else if (typeof _hideTruncationBanner === 'function') {
            // No shortfall - clear the banner + drop the server aggregates so the
            // client compute (exact at small scale) drives the strip + map.
            if (wantFullRefresh) { _hideTruncationBanner(true); _scopeSummary = null; _scopeMarkers = null; }
        }

        try {
            // Phase 3: cache the FULL list (after merge) - the delta poll
            // body alone wouldn't be a useful offline snapshot. We only
            // overwrite the cache on full-refresh polls so a delta poll
            // doesn't shrink the offline cache to a single record.
            if (wantFullRefresh) {
                localStorage.setItem(REPORTS_CACHE_KEY,
                    JSON.stringify({ ts: Date.now(), data }));
            }
        } catch (_) {}
        _updateCacheBadge(false);
        // Apply rendering separately so UI errors don't look like network failures
        try {
            // For full-refresh polls, REPLACE allReports - that's how we
            // notice server-side deletions (the deleted id stops appearing).
            // For delta polls, keep merging into existing state (the
            // existing _applyReportData handles upsert by id).
            if (wantFullRefresh) {
                _replaceReportData(data);
            } else {
                _applyReportData(data);
            }
            _scopeLoading = false;   // data for the active scope has landed → loading state clears, real list renders
            try { window.__crispRouteTrace && window.__crispRouteTrace('dataset loaded', { scope: _activeCrisisEventId || 'GLOBAL', loaded: allReports.length, total: _scopeTotalCount }); } catch (_e) {}
            if (!_initialLoadDone) {
                _initialLoadDone = true;
                _persistSeenIds();  // K.5.c - LRU cap + safe persist
                console.log('[CRISP] Initial load complete - future reports will trigger notifications');
                // Once-per-session "since your last visit" summary instead of
                // replaying the boot batch as individual toasts.
                try { _maybeShowSessionSummary(); } catch (_e) {}
            }
            console.log('[CRISP] Rendered', allReports.length, 'reports on map');
        } catch (e) {
            console.error('[CRISP] RENDER ERROR:', e);
            // Show error visually so user can report it
            const feed = document.getElementById('report-feed-list');
            if (feed) feed.innerHTML = `<div style="padding:20px;color:#ef4444;font-size:13px;"><b>Render Error:</b> ${e.message}<br><br>Data loaded (${data.length} reports) but UI failed. Check console (Cmd+Option+J).</div>`;
        }
        // Apr 2026 - REMOVED `_checkPendingDeletions()` from per-poll cycle.
        // It made an extra GET /api/v1/reports/?include_deleted=true on
        // every cycle, doubling the network rate (~130k req/day per open
        // tab in active-poll mode). Pending-deletion metadata changes
        // infrequently (admin-only action) - checking it every 30 s via
        // the dedicated interval at init time is plenty.
        // Manual triggers (admin purge buttons) still call it directly.
    } catch (e) {
        console.error('[CRISP] FETCH ERROR:', e);
        _scopeLoading = false;   // don't spin forever on a failed fetch - fall through to the error/empty state
        _updateCacheBadge(true);
        const feed = document.getElementById('report-feed-list');
        if (feed && !allReports.length) feed.innerHTML = `<div style="padding:20px;color:#f59e0b;font-size:13px;"><b>Connection Error:</b> ${e.message}<br><br>API: ${API}<br>Check if backend is running on port 8000.</div>`;
    }
    _reschedulePoller();
}

// Phase 3 / May 2026 - full-refresh path. Reconciles allReports with the
// server-truth snapshot using a HONEST diff (deletions + insertions +
// updates) rather than the prior "clear knownIds + re-walk under a
// suppression flag" pattern.
//
// PRIOR REGRESSION: the previous implementation called `knownIds.clear()`
// before re-walking. Every report then looked "new" to `_applyReportData`,
// which would have re-fired _addNotification for ALL of them. To prevent
// the cascade, a `_suppressNewReportNotifications` flag suppressed the
// whole notify path for the duration. The bug: genuinely-new reports
// arriving during a full-refresh poll ALSO got suppressed - they landed
// in knownIds via the upsert but never reached _seenIds or _unseenReports.
// On any deployment where the dashboard couldn't read X-Server-Time
// (cross-origin dev where CORS hadn't exposed the header), EVERY poll
// was a full refresh, so EVERY operator notification was silently dropped.
//
// The honest diff has three buckets:
//   - DELETED  : id in knownIds but not in incoming snapshot  → drop
//   - UPDATED  : id in both                                    → update-in-place, NO notification
//   - INSERTED : id in incoming but not in knownIds            → insert, notify (subject to dedup)
//
// `_applyReportData` already implements the UPDATE / INSERT distinction
// correctly (the `knownIds.has(r.id)` branch). We just need to handle
// DELETIONS up front and then call `_applyReportData(data)` unmodified.
// No flag. No clear-and-rebuild. No silent drops.
function _replaceReportData(data) {
    const incomingIds = new Set(data.map(r => r.id));

    // ── 1. Handle DELETIONS. Ids known locally that the server no
    //    longer surfaces are soft-deletes / hard-purges; drop them from
    //    knownIds + allReports + tier-override, and close the detail
    //    panel if the selected report just disappeared.
    for (const id of [...knownIds]) {
        if (!incomingIds.has(id)) {
            knownIds.delete(id);
            _tierOverride.delete(id);
            if (selectedId === id) {
                try { window.closeDetail && window.closeDetail(); } catch (_) { /* fn may be hoisted later */ }
            }
        }
    }
    // Rebuild allReports by filtering to ids that survived (preserves
    // existing in-memory enrichment - region annotations etc).
    allReports = allReports.filter(r => incomingIds.has(r.id));

    // ── 2. Hand off to the existing upsert. Each row r:
    //    - knownIds.has(r.id) → UPDATE branch (no notification)
    //    - !knownIds.has(r.id) → INSERT branch
    //        - !_initialLoadDone  → silent _seenIds.add (boot-time)
    //        - _initialLoadDone   → _addNotification (subject to dedup)
    //    This is exactly the semantics we want. No suppression flag.
    _notifLog('replace-data', { incoming: data.length, deleted: 0 /* counted above */, initialLoadDone: _initialLoadDone });
    // A full refresh can surface a BACKLOG of historical-but-unseen reports - most
    // commonly when opening an Operation loads its hours-old reports into the
    // working set. Those are age-gated to silent bell entries (no per-card toasts);
    // if enough land at once, show ONE lightweight "since your last visit" banner
    // (auto-dismiss ~5s) instead of N pop-ups. Guarded on _initialLoadDone so the
    // first boot load (which silently seeds _seenIds, never notifies) shows nothing
    // here - the boot path has its own _maybeShowSessionSummary.
    const _silentBefore = _backlogSilent;
    _applyReportData(data);
    const _silentNew = _backlogSilent - _silentBefore;
    if (_initialLoadDone && _silentNew >= _BACKLOG_BANNER_MIN) {
        try {
            _showSessionSummaryBanner('+' + _silentNew + ' new report' + (_silentNew === 1 ? '' : 's') + ' received while you were away', false);
        } catch (_e) { /* banner is best-effort */ }
    }
}

// Operator-visible state inspector. Always available regardless of the
// `crisp_notif_debug` flag. Useful for "why didn't this report notify?"
// triage from DevTools: `__crispNotifDebug()`.
window.__crispNotifDebug = function () {
    return {
        initialLoadDone: _initialLoadDone,
        knownIds: knownIds.size,
        seenIds: _seenIds.size,
        unreadCount: _notifUnreadCount(),
        center: _notifCenter.map(n => ({ id: n.id, sev: n.severity, cat: n.cat, read: !!n.read, acknowledged: !!n.acknowledged, type: n.type, body: n.body })),
        stack: _notificationStack.map(n => ({ id: n.id, sev: n.severity, type: n.type, addedAt: n.addedAt, upgraded: !!n._upgraded })),
        burstArrivals: _burstArrivals.length,
        burstActive: _burstBannerActive,
        lastServerTime: _lastServerTime,
        pollsSinceFullRefresh: _pollsSinceFullRefresh,
        debugFlag: (function () {
            try { return localStorage.getItem('crisp_notif_debug') === '1'; } catch (_) { return false; }
        })(),
    };
};

function _hasActiveUploads() {
    return allReports.some(r => {
        return r.media?.some(m =>
            (m.type === 'IMAGE' || m.type === 'AUDIO') &&
            m.assembly_status !== 'complete' &&
            (m.completion_pct ?? 0) > 0
        );
    });
}

// Apr 2026 - cap active-poll mode to 60 s of wall-clock time. Without
// this cap, a single old report whose chunked upload was abandoned
// midway (legacy bug, now fixed at submit-time but historical rows
// remain) keeps `_hasActiveUploads()` returning true forever, which
// pegs the poller at the 1.2 s interval and floods /api/v1/reports/
// at ~130k requests/day per open dashboard tab. The cap means once we
// stop seeing the upload counter actually MOVE for 60 s, we drop back
// to the normal 4 s interval. If a fresh upload starts, the cap
// resets - fast polling resumes for the duration of that real upload.
let _lastActiveUploadProgressAt = 0;
let _lastActiveUploadFingerprint = '';

function _activePollAllowed() {
    if (!_hasActiveUploads()) return false;
    // Fingerprint = which media + how far along - captures whether
    // anything is actually progressing or we're just stuck.
    const fp = allReports
        .flatMap(r => (r.media || []).map(m => `${m.id || ''}:${m.completion_pct ?? 0}:${m.assembly_status || ''}`))
        .join('|');
    if (fp !== _lastActiveUploadFingerprint) {
        _lastActiveUploadFingerprint = fp;
        _lastActiveUploadProgressAt = Date.now();
    }
    // Stuck: no progress in 60 s → drop to normal poll.
    return (Date.now() - _lastActiveUploadProgressAt) < 60_000;
}

// Phase J.6 - track recent operator interaction. We treat any click /
// keydown inside the detail panel as a "still deciding" signal; if
// nothing has happened in 30 s the panel is just-open-but-idle and
// normal polling resumes.
let _lastDetailInteractionAt = 0;
document.addEventListener('click', (ev) => {
    if (ev.target && ev.target.closest && ev.target.closest('#detail-panel')) {
        _lastDetailInteractionAt = Date.now();
    }
}, true);

function _decisionModeActive() {
    if (!selectedId) return false;
    const panel = document.getElementById('detail-panel');
    if (!panel || panel.style.display === 'none') return false;
    if ((Date.now() - _lastDetailInteractionAt) > 30 * 1000) return false;
    const r = allReports.find(x => x.id === selectedId);
    if (!r) return false;
    // Already-decided reports don't need the slow-poll guard.
    const status = r.status || '';
    if (['RESOLVED', 'RESPONDING', 'FALSE_ALARM'].includes(status)) return false;
    return true;
}

// Phase F image-reliability (May 2026) - remember the current poll
// interval so `_updateCacheBadge` can pass it to the offline-banner
// bridge ("Retrying every Ns"). The banner reads this on every
// fail/success bridge call.
let _lastPollIntervalMs = null;

function _reschedulePoller() {
    if (_pollTimer) clearTimeout(_pollTimer);
    let interval;
    if (_activePollAllowed()) {
        interval = POLL_INTERVAL_ACTIVE;
    } else if (_decisionModeActive()) {
        // J.6 - operator is mid-decision; don't re-render under their hands.
        interval = POLL_INTERVAL_DECISION;
    } else {
        interval = POLL_INTERVAL;
    }
    _lastPollIntervalMs = interval;
    _pollTimer = setTimeout(fetchReports, interval);
}

function _updateCacheBadge(stale) {
    const badge = document.getElementById('cache-freshness-badge');
    // Apr 2026 fix: the bottom "Offline - showing cached data" banner used
    // to be driven by navigator.onLine (unreliable: gets stuck false after
    // transient network hiccups). Now it tracks ACTUAL fetch results via
    // the bridge `window.setDashboardOnline(ok)` defined in index.html.
    // Phase F image-reliability (May 2026) - pass the current poll
    // interval so the banner can render "Retrying every Ns".
    try {
        if (typeof window.setDashboardOnline === 'function') {
            // _pollIntervalMs is set by _reschedulePoller; default to
            // POLL_INTERVAL if it hasn't been assigned yet (first poll).
            const intervalMs = (typeof _lastPollIntervalMs === 'number')
                ? _lastPollIntervalMs : POLL_INTERVAL;
            window.setDashboardOnline(!stale, { intervalMs });
        }
    } catch (_) { /* never let banner logic break data rendering */ }

    if (!badge) return;
    if (stale) {
        badge.innerHTML = '<span class="live-dot" style="background:#f59e0b;box-shadow:0 0 6px #f59e0b;"></span>CACHED';
        badge.title = 'Showing cached data - reconnect to refresh';
        badge.style.borderColor = 'rgba(245,158,11,0.4)';
    } else {
        badge.innerHTML = '<span class="live-dot"></span>LIVE';
        badge.title = 'Data is live from server';
        badge.style.borderColor = '';
    }
}

function _loadCachedReports() {
    try {
        const raw = localStorage.getItem(REPORTS_CACHE_KEY);
        if (!raw) return false;
        const { ts, data } = JSON.parse(raw);
        if (!Array.isArray(data) || !data.length) return false;
        _applyReportData(data);
        // Show age of cache
        const ageMin = Math.round((Date.now() - ts) / 60000);
        const badge = document.getElementById('cache-freshness-badge');
        if (badge) {
            badge.textContent = `⚠ Cached ${ageMin}m ago`;
            badge.style.color = '#f59e0b';
        }
        return true;
    } catch (_) { return false; }
}

// ── Phase 5.1 (May 2026) - Admin Moderation overlay ──────────────────────────
// Backed by /api/v1/admin/observability/nearby/* + /api/v1/admin/appeals/*.
// Auth is JWT-based (require_admin → role ∈ {ADMIN, SUPER_ADMIN}); the
// global fetch wrapper at line ~33 adds Authorization automatically.
// Docs/NEARBY_REPORTS_PIPELINE.md §7 (admin workflows) + §17 (deferred
// follow-ups).
//
// Three subviews on the same overlay:
//   triage   → list of currently-acute clusters (HIGH first, then LOW)
//   appeals  → open + recent device-suspension appeals; decide inline
//   timeline → drill-down into a single group's lifecycle event history

let _modCurrentView = 'triage';        // 'triage' | 'appeals' | 'timeline'
let _modAcuteHigh = [];
let _modAcuteLow = [];
let _modAppealsCache = [];
let _modAppealsStatusFilter = 'open';  // 'open' | 'all'
let _modTimelineGroupId = null;
let _modLastBadgeRefreshAt = 0;

/** Reveal the admin-only account-menu items (Moderation + the User Management /
 *  Organisation Settings entries that moved out of the primary nav) to admins. */
function _maybeShowModerationButton() {
    const u = _crispUser;
    const role = (u && u.role) || '';
    const isAdmin = (role === 'ADMIN' || role === 'SUPER_ADMIN');
    const btn = document.getElementById('btn-moderation');
    if (btn && isAdmin) {
        btn.style.display = 'inline-flex';
    }
    // Admin config items relocated from the header nav into the account dropdown.
    if (isAdmin) {
        for (const id of ['btn-user-mgmt', 'btn-org-settings']) {
            const b = document.getElementById(id);
            if (b) b.style.display = 'inline-flex';
        }
    }
}
window._maybeShowModerationButton = _maybeShowModerationButton;

window.showModerationPanel = async function () {
    const panel = document.getElementById('moderation-panel');
    if (!panel) return;
    if (window.__crispOpenExclusivePanel) window.__crispOpenExclusivePanel('moderation-panel');
    panel.style.display = 'flex';
    // Default to triage on open. Force a refresh on every open so the
    // operator always sees current state (the periodic badge refresh
    // touches the cache but not the rendered DOM).
    await setModTab('triage');
};

window.closeModerationPanel = function () {
    const panel = document.getElementById('moderation-panel');
    if (panel) panel.style.display = 'none';
};

window.setModTab = async function (tab) {
    _modCurrentView = tab;
    document.querySelectorAll('.mod-tab').forEach(el => {
        el.classList.toggle('active', el.dataset.modTab === tab);
    });
    const body = document.getElementById('moderation-panel-body');
    if (!body) return;
    body.innerHTML = '<div class="mod-empty"><i class="fa-solid fa-spinner fa-spin mod-empty-icon" style="color:var(--info);"></i><div class="mod-empty-title">Loading…</div></div>';
    if (tab === 'triage') {
        await _modRenderTriage(body);
    } else if (tab === 'appeals') {
        await _modRenderAppeals(body);
    }
};

/**
 * Fetch + cache both lists (acute clusters, open appeals) and update
 * the tab badges + headline badge. Called on panel open + every
 * 90 seconds while the operator's tab is active.
 */
async function _refreshModerationCounts() {
    if (!_crispUser) return;
    const role = _crispUser.role || '';
    if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') return;
    _modLastBadgeRefreshAt = Date.now();
    try {
        const [acuteRes, appealsRes] = await Promise.all([
            fetch(`${BACKEND_HOST}/api/v1/admin/observability/nearby/acute`),
            fetch(`${BACKEND_HOST}/api/v1/admin/appeals?status=open&limit=100`),
        ]);
        if (acuteRes.ok) {
            const data = await acuteRes.json();
            _modAcuteHigh = data.high_confidence || [];
            _modAcuteLow  = data.low_confidence  || [];
        }
        if (appealsRes.ok) {
            _modAppealsCache = await appealsRes.json();
            if (!Array.isArray(_modAppealsCache)) _modAppealsCache = [];
        }
    } catch (_) { /* badges stay stale; non-blocking */ }
    const acuteTotal = _modAcuteHigh.length + _modAcuteLow.length;
    const appealsTotal = _modAppealsCache.length;
    const tBadge = document.getElementById('mod-tab-badge-triage');
    const aBadge = document.getElementById('mod-tab-badge-appeals');
    const totalBadge = document.getElementById('moderation-badge');
    if (tBadge) tBadge.textContent = String(acuteTotal);
    if (aBadge) aBadge.textContent = String(appealsTotal);
    const total = acuteTotal + appealsTotal;
    if (totalBadge) {
        totalBadge.textContent = String(total);
        totalBadge.style.display = total > 0 ? 'inline-block' : 'none';
    }
}
window._refreshModerationCounts = _refreshModerationCounts;

function _modEscape(s) {
    if (s == null) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
}

/** Escape a value for safe interpolation into an HTML on*-handler that
 *  embeds it as a JS single-quoted string literal - i.e. need to defeat
 *  both HTML AND JS-string injection vectors. IDs come from the server
 *  (UUIDs / building refs / geohashes) so the risk is theoretical, but
 *  the cost is zero. */
function _modAttrJs(s) {
    if (s == null) return '';
    return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function _modCardForCluster(e, grade) {
    const when = e.latest_at ? timeAgo(e.latest_at) : '';
    const types = (e.crisis_types || []).slice(0, 2).join(', ') || '-';
    const lat = (typeof e.centroid_lat === 'number') ? e.centroid_lat.toFixed(3) : '-';
    const lng = (typeof e.centroid_lng === 'number') ? e.centroid_lng.toFixed(3) : '-';
    const meta = [];
    if (e.kind)  meta.push(`kind=${e.kind}`);
    if (e.tier)  meta.push(`tier=${e.tier}`);
    if (typeof e.count === 'number') meta.push(`n=${e.count}`);
    if (e.severity_max) meta.push(`sev=${e.severity_max}`);
    const escId = _modEscape(e.id || '');
    const jsId = _modAttrJs(e.id || '');
    const label = _modEscape(e.label || '');
    return `<div class="mod-triage-card grade-${grade}">
        <div class="mod-tc-header">
            <span class="mod-tc-grade ${grade}">${grade}</span>
            <span class="mod-tc-id" title="${escId}">${escId || '-'}</span>
            <span class="mod-tc-when">${when}</span>
        </div>
        <div class="mod-tc-body">
            ${label ? `<strong>${label}</strong> · ` : ''}${_modEscape(types)}
            <div style="color:var(--text-dim);font-size:12px;margin-top:2px;">
                centroid ${lat}, ${lng}
            </div>
        </div>
        <div class="mod-tc-meta">${meta.map(_modEscape).join(' · ')}</div>
        <div class="mod-tc-actions">
            <button class="mod-ac-btn timeline" onclick="_modShowTimeline('${jsId}')">
                <i class="fa-solid fa-clock-rotate-left"></i> Cluster history
            </button>
        </div>
    </div>`;
}

async function _modRenderTriage(body) {
    // Fetch fresh + render. Calls _refreshModerationCounts to make sure
    // the cache + badges are aligned with what we're about to display.
    await _refreshModerationCounts();
    const total = _modAcuteHigh.length + _modAcuteLow.length;
    if (total === 0) {
        body.innerHTML = `<div class="mod-empty">
            <i class="fa-solid fa-circle-check mod-empty-icon"></i>
            <div class="mod-empty-title">No acute clusters</div>
            <div class="mod-empty-sub">
                A cluster becomes acute when ≥ 5 reports land within 15 min.<br>
                HIGH-confidence acute events trigger SW push to admins;<br>
                LOW-confidence appear here for triage only.
            </div>
        </div>`;
        return;
    }
    const sections = [];
    if (_modAcuteHigh.length) {
        sections.push(`<div style="font-size:11px;color:#fca5a5;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin:4px 0 6px;">
            <i class="fa-solid fa-bolt"></i> High confidence (${_modAcuteHigh.length})
        </div>`);
        sections.push(_modAcuteHigh.map(e => _modCardForCluster(e, 'high')).join(''));
    }
    if (_modAcuteLow.length) {
        sections.push(`<div style="font-size:11px;color:#fbbf24;text-transform:uppercase;letter-spacing:0.06em;font-weight:700;margin:12px 0 6px;">
            <i class="fa-solid fa-circle-info"></i> Low confidence (${_modAcuteLow.length})
        </div>`);
        sections.push(_modAcuteLow.map(e => _modCardForCluster(e, 'low')).join(''));
    }
    body.innerHTML = sections.join('');
}

function _modAppealCard(a) {
    const status = (a.status || 'open').toLowerCase();
    const decided = status !== 'open' && status !== 'under_review';
    const when = a.opened_at ? timeAgo(a.opened_at) : '';
    const signals = (a.original_signals || []).join(', ') || 'none';
    const claim = a.claim_text ? _modEscape(a.claim_text)
                               : '<em style="color:var(--text-dim);">no claim text supplied</em>';
    const dev = a.device_id ? `device ${a.device_id.slice(0, 12)}…`
                            : (a.user_id ? `user ${a.user_id.slice(0, 12)}…` : 'unknown');
    const score = (typeof a.original_spam_score === 'number')
        ? a.original_spam_score.toFixed(2) : '-';
    const jsId = _modAttrJs(a.id || '');
    const actions = decided ? `
        <div style="font-size:11px;color:var(--text-dim);margin-top:8px;font-family:var(--font-mono);">
            decided ${a.decided_at ? timeAgo(a.decided_at) : ''}
            ${a.decision_notes ? ` · ${_modEscape(a.decision_notes)}` : ''}
        </div>` : `
        <div class="mod-ac-actions">
            <button class="mod-ac-btn reinstate" onclick="_modDecideAppeal('${jsId}','reinstated')" title="Clear the device's spam_score + signals">
                <i class="fa-solid fa-check"></i> Reinstate
            </button>
            <button class="mod-ac-btn uphold" onclick="_modDecideAppeal('${jsId}','upheld')" title="Keep the suspension; device stays flagged">
                <i class="fa-solid fa-pause"></i> Uphold
            </button>
            <button class="mod-ac-btn ban" onclick="_modDecideAppeal('${jsId}','banned')" title="Permanent ban - requires note">
                <i class="fa-solid fa-ban"></i> Ban
            </button>
        </div>`;
    return `<div class="mod-appeal-card ${decided ? 'decided' : ''}">
        <div class="mod-ac-header">
            <span class="mod-ac-status ${status}">${status}</span>
            <span class="mod-tc-id">${_modEscape(dev)}</span>
            <span class="mod-tc-when">${when}</span>
        </div>
        <div class="mod-tc-body">${claim}</div>
        <div class="mod-tc-meta">
            signals: ${_modEscape(signals)} · score ${score}
        </div>
        ${actions}
    </div>`;
}

async function _modRenderAppeals(body) {
    await _refreshModerationCounts();
    const appeals = _modAppealsCache;
    if (!appeals.length) {
        body.innerHTML = `<div class="mod-empty">
            <i class="fa-solid fa-circle-check mod-empty-icon"></i>
            <div class="mod-empty-title">No open appeals</div>
            <div class="mod-empty-sub">
                Devices contesting suspension via Phase 4's appeal framework<br>
                appear here. Reinstate clears spam_score; uphold keeps it.
            </div>
        </div>`;
        return;
    }
    body.innerHTML = appeals.map(_modAppealCard).join('');
}

/**
 * Decide an appeal. 'banned' requires an explanatory note (per docs
 * §7.5, banning should be a deliberate decision with rationale).
 */
window._modDecideAppeal = async function (appealId, decision) {
    if (!appealId || !decision) return;
    let notes = null;
    if (decision === 'banned') {
        notes = prompt(
            'Permanent ban - please document the rationale.\n' +
            'This is logged in the appeal audit trail.'
        );
        if (notes === null) return;   // cancel
        if (!notes.trim()) {
            alert('Ban rationale is required.');
            return;
        }
    } else if (decision === 'upheld') {
        // Optional note for uphold; reinstate doesn't need one.
        notes = prompt('Optional note (e.g. "device confirmed as emulator"). Leave blank to skip.');
        if (notes === null) return;   // cancel
        notes = notes.trim() || null;
    }
    const payload = { decision };
    if (notes) payload.notes = notes;
    try {
        const res = await fetch(`${BACKEND_HOST}/api/v1/admin/appeals/${encodeURIComponent(appealId)}/decide`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            const txt = await res.text().catch(() => '');
            alert(`Decision failed (${res.status}). ${txt}`);
            return;
        }
        if (typeof showToast === 'function') {
            showToast(`Appeal ${decision}`, decision === 'reinstated' ? 'success' : 'info');
        }
        await setModTab('appeals');   // refresh list
    } catch (err) {
        alert(`Decision failed: ${err.message}`);
    }
};

/** Open the cluster-history timeline subview for a group_id. */
window._modShowTimeline = async function (groupId) {
    if (!groupId) return;
    _modCurrentView = 'timeline';
    _modTimelineGroupId = groupId;
    const body = document.getElementById('moderation-panel-body');
    if (!body) return;
    body.innerHTML = `
        <div class="mod-back-row">
            <button class="mod-back-btn" onclick="setModTab('triage')">
                <i class="fa-solid fa-arrow-left"></i> Back to triage
            </button>
            <span style="font-size:11px;color:var(--text-dim);font-family:var(--font-mono);">
                ${_modEscape(groupId)}
            </span>
        </div>
        <div style="padding:12px;" id="mod-timeline-body">
            <div class="mod-empty">
                <i class="fa-solid fa-spinner fa-spin mod-empty-icon" style="color:var(--info);"></i>
                <div class="mod-empty-title">Loading timeline…</div>
            </div>
        </div>`;
    try {
        const res = await fetch(
            `${BACKEND_HOST}/api/v1/admin/observability/nearby/events?group_id=${encodeURIComponent(groupId)}&limit=100`
        );
        const inner = document.getElementById('mod-timeline-body');
        if (!inner) return;
        if (!res.ok) {
            inner.innerHTML = `<div class="mod-empty"><i class="fa-solid fa-triangle-exclamation mod-empty-icon" style="color:#ef4444;"></i><div class="mod-empty-title">Timeline unavailable (${res.status})</div></div>`;
            return;
        }
        const data = await res.json();
        const events = data.events || [];
        if (!events.length) {
            inner.innerHTML = `<div class="mod-empty">
                <i class="fa-solid fa-clock-rotate-left mod-empty-icon" style="color:var(--text-dim);"></i>
                <div class="mod-empty-title">No lifecycle events yet</div>
                <div class="mod-empty-sub">
                    Events appear once the cluster sees a tier change,<br>
                    acute trigger, or status transition.
                </div>
            </div>`;
            return;
        }
        inner.innerHTML = events.map(ev => {
            const kind = (ev.event_kind || 'event');
            const when = ev.occurred_at ? timeAgo(ev.occurred_at) : '';
            const details = [];
            if (ev.from_tier && ev.to_tier) details.push(`tier ${ev.from_tier} → ${ev.to_tier}`);
            if (ev.from_count != null && ev.to_count != null) details.push(`count ${ev.from_count} → ${ev.to_count}`);
            const payloadStr = (ev.payload && Object.keys(ev.payload).length)
                ? JSON.stringify(ev.payload, null, 0)
                : '';
            return `<div class="mod-tl-ev kind-${_modEscape(kind)}">
                <div>
                    <span class="mod-tl-kind">${_modEscape(kind)}</span>
                    <span class="mod-tl-when">${when}</span>
                </div>
                ${details.length ? `<div class="mod-tl-detail">${details.map(_modEscape).join(' · ')}</div>` : ''}
                ${payloadStr ? `<div class="mod-tl-payload">${_modEscape(payloadStr)}</div>` : ''}
            </div>`;
        }).join('');
    } catch (err) {
        const inner = document.getElementById('mod-timeline-body');
        if (inner) {
            inner.innerHTML = `<div class="mod-empty"><i class="fa-solid fa-triangle-exclamation mod-empty-icon" style="color:#ef4444;"></i><div class="mod-empty-title">${_modEscape(err.message)}</div></div>`;
        }
    }
};

// Background refresh of badge counts. Slow enough not to spam the
// backend; fast enough that the operator's headline badge updates
// within ~1.5 min of a real change. Skipped silently for non-admins.
setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - _modLastBadgeRefreshAt < 60000) return;
    _refreshModerationCounts();
}, 90 * 1000);


// ── Init ─────────────────────────────────────────────────────────────────────
// ── Auth: Logout + User Menu ─────────────────────────────────────────────────
window.crispLogout = async () => {
    try { await fetch(`${BACKEND_HOST}/api/v1/auth/logout`, { method: 'POST' }); } catch (_) {}
    localStorage.removeItem('crisp_token');
    localStorage.removeItem('crisp_refresh');
    localStorage.removeItem('crisp_user');
    window.location.href = 'login.html';
};

function _initUserMenu() {
    const u = _crispUser;
    if (!u) return;
    const nameEl = document.getElementById('user-name-display');
    const roleEl = document.getElementById('user-role-badge');
    if (nameEl) nameEl.textContent = u.full_name || u.email?.split('@')[0] || '';
    if (roleEl) roleEl.textContent = u.role || 'VIEWER';
    // Phase 5.1 (May 2026): reveal Moderation button + kick the first
    // badge fetch so the headline count is correct within a few seconds
    // of page load, not on the next 90 s tick.
    if (typeof _maybeShowModerationButton === 'function') _maybeShowModerationButton();
    if (typeof _refreshModerationCounts === 'function') {
        // Non-blocking; ignore failures.
        setTimeout(() => _refreshModerationCounts(), 800);
    }
    // Phase J.1 - admin-divider visibility + dot indicator. The
    // divider only appears when at least one admin item is shown;
    // the dot fires when any admin item has a non-zero badge so the
    // operator's eye is drawn to the chip without us having to keep
    // 3 separate badges in the top bar.
    setTimeout(_refreshUserMenuAdminState, 1200);
    setInterval(_refreshUserMenuAdminState, 30 * 1000);
}

// ──────────────────────────────────────────────────────────────────────
// Phase J.1 (May 2026) - Header consolidation helpers
// ──────────────────────────────────────────────────────────────────────
// The user-chip dropdown holds admin actions. _refreshUserMenuAdminState
// keeps the divider + the red-dot indicator in sync with the existing
// per-button visibility/badge helpers (_maybeShowModerationButton,
// _checkPendingDeletions). Runs on init + every
// 30 s; cheap DOM-only.

function _refreshUserMenuAdminState() {
    const ids = ['btn-moderation', 'btn-pending-deletions', 'btn-user-mgmt', 'btn-org-settings'];
    const visible = ids.map(id => {
        const el = document.getElementById(id);
        return el && el.style.display !== 'none';
    });
    const anyVisible = visible.some(Boolean);
    const divider = document.getElementById('user-menu-admin-divider');
    if (divider) divider.style.display = anyVisible ? 'block' : 'none';

    // Aggregate badge totals across the admin items.
    let totalCount = 0;
    const mod = document.getElementById('moderation-badge');
    if (mod && mod.style.display !== 'none') {
        totalCount += parseInt(mod.textContent || '0', 10) || 0;
    }
    const del = document.getElementById('deletion-count-badge');
    if (del) {
        // deletion-count-badge is always present; only counts when >0.
        const n = parseInt(del.textContent || '0', 10) || 0;
        totalCount += n;
    }
    const dot = document.getElementById('user-menu-dot');
    if (dot) {
        dot.style.display = totalCount > 0 ? 'inline-block' : 'none';
        dot.title = totalCount > 0
            ? `${totalCount} admin item${totalCount === 1 ? '' : 's'} need attention`
            : '';
    }
}

window._toggleUserMenu = function (forceState) {
    const dd = document.getElementById('user-menu-dropdown');
    if (!dd) return;
    const wantOpen = (forceState === true)
        ? true
        : (forceState === false ? false : (dd.style.display === 'none'));
    dd.style.display = wantOpen ? 'block' : 'none';
    if (wantOpen) {
        // Refresh visibility right before opening so a freshly-granted
        // admin role surfaces immediately.
        _refreshUserMenuAdminState();
        setTimeout(() => {
            const closer = (ev) => {
                const host = document.getElementById('user-menu');
                if (!host || !host.contains(ev.target)) {
                    dd.style.display = 'none';
                    document.removeEventListener('click', closer);
                }
            };
            document.addEventListener('click', closer);
        }, 60);
    }
};

// Tools-active-dot indicator: fires whenever the Analytics or
// Predict overlay is currently open. Hooks into the existing
// toggleAnalytics / togglePredictions visibility states via a
// MutationObserver on the two panel elements.
function _initToolsActiveDot() {
    const dot = document.getElementById('cmd-tools-active-dot');
    if (!dot) return;
    const targets = [
        document.getElementById('analytics-panel'),
        document.getElementById('predictions-panel'),
    ].filter(Boolean);
    if (!targets.length) return;
    const recompute = () => {
        const anyOpen = targets.some(t => t && t.style.display && t.style.display !== 'none');
        dot.style.display = anyOpen ? 'inline-block' : 'none';
    };
    recompute();
    const mo = new MutationObserver(recompute);
    for (const t of targets) {
        mo.observe(t, { attributes: true, attributeFilter: ['style'] });
    }
}

// ── Token auto-refresh ───────────────────────────────────────────────────────
// PROACTIVE refresh, routed through the shared in-flight _tryRefreshToken (so it
// never races the reactive refresh-on-401 in the fetch wrapper). Access tokens
// live ~30 min; refresh well inside that. Also refresh when a BACKGROUNDED tab
// regains focus - browsers throttle/pause setInterval in hidden tabs, so a single
// long interval could fire AFTER the token already expired. The reactive
// refresh-on-401 is the real safety net; this just avoids the extra 401 round-trip.
const _autoRefreshToken = () => { try { _tryRefreshToken(); } catch (_e) {} };
setInterval(_autoRefreshToken, 10 * 60 * 1000);   // every 10 min (well under the ~30 min TTL)
try {
    document.addEventListener('visibilitychange', () => { if (!document.hidden) _autoRefreshToken(); });
} catch (_e) {}

document.addEventListener('DOMContentLoaded', async () => {
    _initUserMenu();
    // Phase J.1 - wire the Tools-menu active dot to the Analytics +
    // Predict panel visibility so the operator sees a small marker
    // when one of those overlays is currently open.
    _initToolsActiveDot();
    // Phase J.5 - bump session counter + show onboarding tips for
    // the first 3 sessions per device.
    _onboardingBumpSession();
    _kickOnboardingTips();
    // Close dropdowns on outside click. The toggle buttons stopPropagation, so
    // opening one never self-closes; item clicks remove `open` themselves. The
    // dp-overflow / dp-verdict / bc-state menus were previously absent here, so
    // they stayed open on an outside click (DASH-004).
    document.addEventListener('click', (e) => {
        document.querySelectorAll(
            '.export-dropdown.open, .sort-dropdown.open, .dp-overflow-wrap.open, .dp-verdict-dropdown.open, .bc-state-dropdown.open',
        ).forEach(d => {
            if (!d.contains(e.target)) d.classList.remove('open');
        });
    });
    // Phase G.1 (May 2026) - restore stacking chip filters from URL
    // hash or localStorage and paint the chip UI. Must run BEFORE the
    // first feed render so the active set is honoured on cold load
    // (deep-linked URLs land showing the right filter combo).
    _restoreChipFiltersFromStorage();
    _paintChipFilterUI();
    // Phase H.1.d (May 2026) - install the URL-hash listener so a
    // deep-linked `#building=osm:way:123` opens the Building
    // Intelligence Console on cold load.
    _initBuildingHashListener();
    initMap();
    await loadWorldData();

    // Determine context BEFORE the first fetch. If the URL already carries an
    // operation scope (deep-link / refresh of #/incidents;op=X), set it now so the
    // FIRST fetch is scoped - there is never a global fetch+render before the
    // router re-applies the scope (kills the global-first flash on refresh).
    const _bootOp = _scopeFromHash();
    if (_bootOp) { _activeCrisisEventId = _bootOp; _scopeLoading = true; }
    try { window.__crispRouteTrace && window.__crispRouteTrace('boot', { scope: _bootOp || 'GLOBAL', hash: location.hash }); } catch (_e) {}

    // Show the (scope-aware) loading state in the feed while data loads.
    const feedList = document.getElementById('report-feed-list');
    if (feedList && !allReports.length) {
        feedList.innerHTML = _loadingFeedHtml();
    }

    // Show cached data instantly (zero network) - but NOT for a scoped deep-link,
    // where the cache (a previous GLOBAL / other-scope session) is the WRONG
    // dataset and would flash the wrong incidents before the scoped fetch lands.
    if (!_bootOp) _loadCachedReports();

    // Fetch fresh data (scoped when _bootOp is set), then adaptive polling takes over.
    fetchReports();

    // Apr 2026 - pending-deletions check runs on its own slow timer
    // instead of riding the per-poll cycle (which doubled network rate
    // to ~130k req/day per tab in active-poll mode). Admin actions
    // that delete reports continue to call _checkPendingDeletions()
    // directly so the badge updates immediately on user action.
    _checkPendingDeletions();                                  // initial
    setInterval(_checkPendingDeletions, 30 * 1000);            // every 30 s
});
