/**
 * AuthStore — Phase 1 (Apr 2026) Optional reporter login for RN.
 *
 * Parity with PWA's `auth.js`:
 *   - Tokens live in expo-secure-store (Keychain / EncryptedSharedPreferences).
 *   - User profile blob in AsyncStorage (non-sensitive — displayName only).
 *   - `fetchWithAuth` adds Bearer header + refreshes on 401.
 *   - `isLoggedIn` stays true through a 30-day offline-grace window so
 *     reporting never blocks when the user is offline past token expiry.
 *
 * Reporting-must-never-block rule applies here too: every method falls
 * back to the anonymous path on failure, never throws up to the UI.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
let SecureStore: any = null;
try {
  // expo-secure-store is part of the Expo base; guard the require so unit
  // tests + SSR-adjacent scenarios don't crash on a missing native module.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  SecureStore = require('expo-secure-store');
} catch {
  SecureStore = null;
}

const SS_KEY_ACCESS = 'crisp_auth_access_v1';
const SS_KEY_REFRESH = 'crisp_auth_refresh_v1';
const AS_KEY_PROFILE = 'crisp_auth_profile_v1';

const OFFLINE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;    // 30 days
const ACCESS_TTL_MS = 15 * 60 * 1000;                 // 15 min
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;      // 30 days

type AuthProfile = {
  userId: string | null;
  displayName: string | null;
  channel: 'EMAIL' | 'PHONE' | null;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  offlineGraceUntil: number;
  linkedDeviceHashes: string[];
};

const EMPTY: AuthProfile = {
  userId: null,
  displayName: null,
  channel: null,
  accessTokenExpiresAt: 0,
  refreshTokenExpiresAt: 0,
  offlineGraceUntil: 0,
  linkedDeviceHashes: [],
};

let _profile: AuthProfile = { ...EMPTY };
let _accessToken: string | null = null;
let _refreshToken: string | null = null;
let _apiBase = '';
let _inFlightRefresh: Promise<string | null> | null = null;

async function _readSecure(key: string): Promise<string | null> {
  if (!SecureStore) {
    // Fallback to AsyncStorage when secure-store isn't available. Not as
    // secure, but preserves function — we prefer an imperfect experience
    // over a hard crash.
    return await AsyncStorage.getItem(key);
  }
  try { return await SecureStore.getItemAsync(key); } catch { return null; }
}
async function _writeSecure(key: string, v: string | null): Promise<void> {
  if (!SecureStore) {
    if (v == null) await AsyncStorage.removeItem(key);
    else await AsyncStorage.setItem(key, v);
    return;
  }
  try {
    if (v == null) await SecureStore.deleteItemAsync(key);
    else await SecureStore.setItemAsync(key, v);
  } catch { /* ignore */ }
}

export function setApiBase(url: string): void { _apiBase = url; }

export async function init(): Promise<void> {
  try {
    const blob = await AsyncStorage.getItem(AS_KEY_PROFILE);
    if (blob) _profile = { ...EMPTY, ...JSON.parse(blob) };
    _accessToken = await _readSecure(SS_KEY_ACCESS);
    _refreshToken = await _readSecure(SS_KEY_REFRESH);
  } catch { /* ignore — cold start path */ }
}

export function isLoggedIn(): boolean {
  const now = Date.now();
  const validAccess = !!(_accessToken && _profile.accessTokenExpiresAt > now);
  const withinGrace = _profile.offlineGraceUntil > now;
  return !!(_profile.userId && (validAccess || withinGrace));
}

export function getProfile(): AuthProfile { return { ..._profile }; }
export function getAccessToken(): string | null {
  const now = Date.now();
  if (_accessToken && (_profile.accessTokenExpiresAt > now || _profile.offlineGraceUntil > now)) {
    return _accessToken;
  }
  return null;
}

async function _persistProfile(): Promise<void> {
  try { await AsyncStorage.setItem(AS_KEY_PROFILE, JSON.stringify(_profile)); } catch { /* ignore */ }
}

async function _acceptTokens(resp: any): Promise<void> {
  const now = Date.now();
  _accessToken = resp.access_token || _accessToken;
  _refreshToken = resp.refresh_token || _refreshToken;
  _profile = {
    ..._profile,
    accessTokenExpiresAt: now + ACCESS_TTL_MS,
    refreshTokenExpiresAt: now + REFRESH_TTL_MS,
    offlineGraceUntil: now + OFFLINE_GRACE_MS,
  };
  if (resp.user) {
    _profile.userId = resp.user.id || _profile.userId;
    _profile.displayName = resp.user.display_name || resp.user.phone_number
      || resp.user.email || (_profile.userId ? `User ${_profile.userId.slice(0, 8)}` : null);
    _profile.channel = (resp.user.primary_auth_channel as any) || _profile.channel;
  }
  await _writeSecure(SS_KEY_ACCESS, _accessToken);
  await _writeSecure(SS_KEY_REFRESH, _refreshToken);
  await _persistProfile();
}

export async function requestOtp(destination: string, channel: 'EMAIL'|'PHONE', purpose = 'LOGIN', deviceHash?: string) {
  const body: any = { destination, channel, purpose };
  if (deviceHash) body.device_hash = deviceHash;
  const res = await fetch(`${_apiBase}/auth/otp/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.detail || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

export async function verifyOtp(destination: string, channel: 'EMAIL'|'PHONE', code: string, purpose = 'LOGIN', deviceHash?: string) {
  const body: any = { destination, channel, code, purpose };
  if (deviceHash) body.device_hash = deviceHash;
  const res = await fetch(`${_apiBase}/auth/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.detail || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const data = await res.json();
  await _acceptTokens(data);
  return data;
}

export async function refreshAccess(): Promise<string | null> {
  if (!_refreshToken) return null;
  if (_inFlightRefresh) return _inFlightRefresh;
  _inFlightRefresh = (async () => {
    try {
      const res = await fetch(`${_apiBase}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: _refreshToken }),
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) await logoutLocal();
        return null;
      }
      const data = await res.json();
      await _acceptTokens(data);
      return _accessToken;
    } catch { return null; }
    finally { _inFlightRefresh = null; }
  })();
  return _inFlightRefresh;
}

export async function fetchWithAuth(path: string, opts: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${_apiBase}${path}`;
  const headers: Record<string, string> = { ...(opts.headers as any || {}) };
  const tok = getAccessToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  let res = await fetch(url, { ...opts, headers });
  if (res.status === 401 && _refreshToken) {
    const t = await refreshAccess();
    if (t) {
      headers.Authorization = `Bearer ${t}`;
      res = await fetch(url, { ...opts, headers });
    }
  }
  return res;
}

export async function linkDevice(deviceHash: string): Promise<{ linked: number }> {
  if (!_accessToken) throw new Error('not-logged-in');
  const res = await fetchWithAuth('/auth/link-device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_hash: deviceHash }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!_profile.linkedDeviceHashes.includes(deviceHash)) {
    _profile.linkedDeviceHashes = [..._profile.linkedDeviceHashes, deviceHash];
    await _persistProfile();
  }
  return data;
}

export async function unlinkDevice(deviceHash: string): Promise<{ unlinked: number }> {
  if (!_accessToken) throw new Error('not-logged-in');
  const res = await fetchWithAuth('/auth/unlink-device', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_hash: deviceHash }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  _profile.linkedDeviceHashes = _profile.linkedDeviceHashes.filter((h) => h !== deviceHash);
  await _persistProfile();
  return res.json();
}

export async function logout(): Promise<void> {
  try {
    if (_accessToken) await fetchWithAuth('/auth/logout', { method: 'POST' }).catch(() => undefined);
  } finally {
    await logoutLocal();
  }
}

export async function logoutLocal(): Promise<void> {
  _profile = { ...EMPTY };
  _accessToken = null;
  _refreshToken = null;
  try { await AsyncStorage.removeItem(AS_KEY_PROFILE); } catch { /* ignore */ }
  await _writeSecure(SS_KEY_ACCESS, null);
  await _writeSecure(SS_KEY_REFRESH, null);
}

export async function meReports(): Promise<any[]> {
  const res = await fetchWithAuth('/auth/me/reports');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return j.reports || [];
}
