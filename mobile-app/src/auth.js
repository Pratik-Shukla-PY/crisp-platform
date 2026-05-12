/* global API_BASE, showToast, t, state, goToStage */
// ─────────────────────────────────────────────────────────────────────────────
//  CRISP AuthStore — Phase 1 Optional reporter login.
//
//  Anonymous-first design:
//    * Reporting NEVER blocks on login.
//    * Auth state lives in an IndexedDB store (`crisp_auth_v1`) so an
//      XSS-style localStorage scrape can't lift the refresh token.
//    * Access token is cached in-memory + IDB. The `fetchWithAuth` helper
//      opportunistically refreshes on 401 and silently degrades to
//      anonymous on any persistent failure.
//    * All methods are offline-safe: they return cached identity without
//      touching the network when the user is offline.
//
//  Exposed via `window.AuthStore`:
//    init()                    — call once on boot; hydrates from IDB.
//    isLoggedIn()              — truthy when we have a non-expired session
//                                OR we're within the 30-day offline grace.
//    getUser()                 — { id, displayName, channel } | null
//    getAccessToken()          — current bearer or null (may be stale-but-
//                                usable within offline grace).
//    requestOtp(destination, channel, purpose)
//    verifyOtp(destination, channel, code, purpose)
//    linkDevice(deviceHash)    — claim anonymous reports.
//    unlinkDevice(deviceHash)
//    logout()                  — strong (server revokes + local clears).
//    fetchWithAuth(path, opts) — fetch wrapper; adds Bearer + refreshes on 401.
//
//  Dependencies: `API_BASE` (global from app.js), nothing else.
// ─────────────────────────────────────────────────────────────────────────────
(function () {
    'use strict';

    const IDB_NAME = 'crisp_auth_v1';
    const IDB_STORE = 'state';
    const IDB_KEY = 'current';
    const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days (user-approved)

    let _state = {
        userId: null,
        displayName: null,
        channel: null,                // EMAIL | PHONE
        accessToken: null,
        accessTokenExpiresAt: 0,
        refreshToken: null,
        refreshTokenExpiresAt: 0,
        offlineGraceUntil: 0,
        linkedDeviceHashes: [],
    };
    let _ready = false;
    let _inFlightRefresh = null;

    // ── IDB helpers ──────────────────────────────────────────────────
    function _open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE, { keyPath: 'id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    async function _read() {
        try {
            const db = await _open();
            return await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
                req.onsuccess = () => resolve(req.result && req.result.data);
                req.onerror = () => reject(req.error);
            });
        } catch (_) {
            return null;
        }
    }

    async function _write() {
        try {
            const db = await _open();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).put({ id: IDB_KEY, data: { ..._state } });
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (_) {
            // Best-effort; user's login state survives in memory until reload.
        }
    }

    async function _clear() {
        try {
            const db = await _open();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(IDB_STORE, 'readwrite');
                tx.objectStore(IDB_STORE).delete(IDB_KEY);
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });
        } catch (_) { /* ignore */ }
    }

    // ── Public API ───────────────────────────────────────────────────

    async function init() {
        if (_ready) return;
        const stored = await _read();
        if (stored && typeof stored === 'object') {
            _state = { ..._state, ...stored };
        }
        _ready = true;
        // Fire a ready event so app.js can paint the header pill.
        try { document.dispatchEvent(new CustomEvent('auth-ready', { detail: snapshot() })); } catch (_) {}
        // Fire-and-forget opportunistic refresh if we have a refresh token.
        if (_state.refreshToken && navigator.onLine !== false) {
            refreshAccess().catch(() => {});
        }
    }

    function snapshot() {
        const now = Date.now();
        return {
            userId: _state.userId,
            displayName: _state.displayName,
            channel: _state.channel,
            hasValidAccessToken: !!(_state.accessToken && _state.accessTokenExpiresAt > now),
            withinOfflineGrace: !!(_state.offlineGraceUntil && _state.offlineGraceUntil > now),
            linkedDeviceHashes: [..._state.linkedDeviceHashes],
        };
    }

    function isLoggedIn() {
        const s = snapshot();
        // Stay "logged-in" during offline grace even if the access token is stale.
        return !!(_state.userId && (s.hasValidAccessToken || s.withinOfflineGrace));
    }

    function getUser() {
        if (!_state.userId) return null;
        return {
            id: _state.userId,
            displayName: _state.displayName,
            channel: _state.channel,
        };
    }

    function getAccessToken() {
        const now = Date.now();
        if (_state.accessToken && (_state.accessTokenExpiresAt > now || (_state.offlineGraceUntil > now))) {
            return _state.accessToken;
        }
        return null;
    }

    // Internals — persist tokens from a verify/refresh response.
    async function _acceptTokens(resp) {
        const now = Date.now();
        const accessMs = 15 * 60 * 1000;           // 15 min (user spec)
        const refreshMs = 30 * 24 * 60 * 60 * 1000; // 30 days (user spec)
        _state.accessToken = resp.access_token || null;
        _state.accessTokenExpiresAt = now + accessMs;
        _state.refreshToken = resp.refresh_token || _state.refreshToken;
        _state.refreshTokenExpiresAt = now + refreshMs;
        _state.offlineGraceUntil = now + OFFLINE_GRACE_MS;
        if (resp.user) {
            _state.userId = resp.user.id;
            _state.displayName = resp.user.display_name
                || resp.user.phone_number
                || resp.user.email
                || `User ${String(resp.user.id).slice(0, 8)}`;
            _state.channel = resp.user.primary_auth_channel || _state.channel;
        }
        await _write();
        try { document.dispatchEvent(new CustomEvent('auth-changed', { detail: snapshot() })); } catch (_) {}
    }

    async function requestOtp(destination, channel, purpose = 'LOGIN') {
        const body = { destination, channel, purpose };
        // Stash the device_hash so server-side can compute linkable_report_count.
        try {
            const dh = localStorage.getItem('crisp_device_id_v2')
                    || localStorage.getItem('crisp_device_hash')
                    || localStorage.getItem('crisp_device_id');
            if (dh) body.device_hash = dh;
        } catch (_) {}
        const res = await fetch(`${API_BASE}/auth/otp/request`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        return res.json();
    }

    async function verifyOtp(destination, channel, code, purpose = 'LOGIN') {
        const body = { destination, channel, code, purpose };
        try {
            const dh = localStorage.getItem('crisp_device_id_v2')
                    || localStorage.getItem('crisp_device_hash')
                    || localStorage.getItem('crisp_device_id');
            if (dh) body.device_hash = dh;
        } catch (_) {}
        const res = await fetch(`${API_BASE}/auth/otp/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const data = await res.json();
        await _acceptTokens(data);
        return data;   // includes `linkable_report_count`, `is_new_user`
    }

    async function refreshAccess() {
        if (!_state.refreshToken) return null;
        if (_inFlightRefresh) return _inFlightRefresh;
        _inFlightRefresh = (async () => {
            try {
                const res = await fetch(`${API_BASE}/auth/refresh`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refresh_token: _state.refreshToken }),
                });
                if (!res.ok) {
                    if (res.status === 401 || res.status === 403) {
                        // Refresh token revoked or expired — silently degrade.
                        await logoutLocal();
                    }
                    return null;
                }
                const data = await res.json();
                await _acceptTokens(data);
                return data.access_token;
            } catch (_) {
                return null;
            } finally {
                _inFlightRefresh = null;
            }
        })();
        return _inFlightRefresh;
    }

    async function fetchWithAuth(path, opts = {}) {
        const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
        const headers = { ...(opts.headers || {}) };
        const tok = getAccessToken();
        if (tok) headers['Authorization'] = `Bearer ${tok}`;
        let res = await fetch(url, { ...opts, headers });
        if (res.status === 401 && _state.refreshToken) {
            const newTok = await refreshAccess();
            if (newTok) {
                headers['Authorization'] = `Bearer ${newTok}`;
                res = await fetch(url, { ...opts, headers });
            }
        }
        return res;
    }

    async function linkDevice(deviceHash) {
        if (!_state.accessToken) throw new Error('not-logged-in');
        const res = await fetchWithAuth('/auth/link-device', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_hash: deviceHash }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (deviceHash && !_state.linkedDeviceHashes.includes(deviceHash)) {
            _state.linkedDeviceHashes.push(deviceHash);
            await _write();
        }
        return data;
    }

    async function unlinkDevice(deviceHash) {
        if (!_state.accessToken) throw new Error('not-logged-in');
        const res = await fetchWithAuth('/auth/unlink-device', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_hash: deviceHash }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        _state.linkedDeviceHashes = _state.linkedDeviceHashes.filter((h) => h !== deviceHash);
        await _write();
        return res.json();
    }

    async function logout() {
        // Strong logout (user spec): try to hit the server so every
        // session is revoked. If offline, clear local state only; the
        // server refresh token dies on next refresh anyway.
        try {
            if (_state.accessToken && navigator.onLine !== false) {
                await fetchWithAuth('/auth/logout', { method: 'POST' }).catch(() => {});
            }
        } finally {
            await logoutLocal();
        }
    }

    async function logoutLocal() {
        _state = {
            userId: null, displayName: null, channel: null,
            accessToken: null, accessTokenExpiresAt: 0,
            refreshToken: null, refreshTokenExpiresAt: 0,
            offlineGraceUntil: 0,
            linkedDeviceHashes: [],
        };
        await _clear();
        try { document.dispatchEvent(new CustomEvent('auth-changed', { detail: snapshot() })); } catch (_) {}
    }

    async function meReports() {
        const res = await fetchWithAuth('/auth/me/reports');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    window.AuthStore = {
        init, snapshot, isLoggedIn, getUser, getAccessToken,
        requestOtp, verifyOtp, linkDevice, unlinkDevice,
        logout, logoutLocal, refreshAccess, fetchWithAuth, meReports,
    };
})();
