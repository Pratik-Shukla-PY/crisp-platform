# Optional Reporter Login - Operator Runbook

**Status:** Shipped April 2026. Phase 1 of the "Optional Login + Anonymous Reporting" initiative.

---

## TL;DR

- **Reporting never blocks on login.** Anonymous is always an option.
- **OTP channels**: Email + Phone (E.164). 6-digit code, 10 min expiry.
- **Tokens**: access 15 min, refresh 30 days rotating, offline-grace 30 days.
- **Linking**: on first login, the reporter can claim every anonymous report submitted from the same device.
- **Strong logout**: revokes ALL refresh tokens for the user on the server; other devices lose access on next refresh.

---

## Architecture

```
Mobile (PWA + RN)                  Backend
─────────────────                  ───────
AuthStore (singleton)              /auth/otp/request    {destination, channel, purpose, device_hash?}
  ├─ init()                        /auth/otp/verify     {destination, channel, code, purpose, device_hash?}
  ├─ requestOtp()                    → {access_token, refresh_token, user, linkable_report_count}
  ├─ verifyOtp()                   /auth/refresh        {refresh_token} → rotates
  ├─ linkDevice(hash)              /auth/logout         (strong revoke)
  ├─ unlinkDevice(hash)            /auth/link-device    {device_hash} → UPDATE reports SET user_id=me
  ├─ logout() / logoutLocal()      /auth/unlink-device  {device_hash}
  └─ fetchWithAuth(path,opts)      /auth/me/reports     → merged by user_id + user_device_link
                                   /reports/meta        optional Bearer; anonymous on expired token
```

### Storage

| Platform | Tokens | Profile |
|---|---|---|
| PWA | IndexedDB `crisp_auth_v1.state` | same |
| RN | `expo-secure-store` (Keychain / EncryptedSharedPreferences) | `AsyncStorage crisp_auth_profile_v1` |

### Data model

- `users.phone_number` (E.164, unique, nullable)
- `users.email` (now nullable - phone-only reporters)
- `users.phone_verified`, `users.primary_auth_channel`
- `otp_records.destination` + `otp_records.channel` (EMAIL | PHONE)
- `reports.user_id` (nullable FK → users, ON DELETE SET NULL)
- `reports.is_anonymous` (Postgres generated column = `user_id IS NULL`)
- `user_device_link(user_id, device_hash)` - join table, CASCADE on user delete

See migration `backend/migrations/versions/0010_optional_reporter_login.py`.

---

## Deployment

### Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `SMS_PROVIDER` | no | `stub` | `stub` logs codes to stdout; `twilio` sends real SMS |
| `TWILIO_ACCOUNT_SID` | if `SMS_PROVIDER=twilio` | - | |
| `TWILIO_AUTH_TOKEN` | if `SMS_PROVIDER=twilio` | - | |
| `TWILIO_FROM` | if `SMS_PROVIDER=twilio` | - | E.164 sender number |

Existing email OTP env vars from the dashboard flow (SMTP) stay unchanged.

### Migration

```bash
DATABASE_URL='postgresql+psycopg2://…/crisp' alembic upgrade head
```

The `0010_optional_reporter_login` revision is idempotent - safe to re-run.

---

## Operator Workflows

### Dashboard - identify a reporter

Every report card shows one of:
- 🟩 **"User abc12345"** - identified reporter (masked). ANALYST can see this.
- (no badge) - anonymous. The "Anonymous" filter pill surfaces these.

Click the badge → `openReporterProfile(user_id)` in the console; admin-only → 403 for ANALYST → infoToast "Only administrators can see reporter PII".

To unmask an identified reporter (ADMIN only):

```
GET /auth/users/{user_id}
→ { id, email, phone_number, role, last_login_at, ... }
```

### GDPR - reporter hits "Delete my data"

- Client: `POST /auth/me/delete-account`.
- Server: sets `gdpr_deletion_requested_at`, schedules cascade on a 24 h grace.
- On cascade:
  - `user_device_link(user_id)` rows CASCADE-delete.
  - `reports WHERE user_id=me` → `user_id = NULL` (ON DELETE SET NULL) - **reports stay visible to the crisis-response team; only the PII linkage is severed.** (User spec answer 3.)
- The user row is then deleted.

### Logout side-effects

Strong logout (user spec answer 7):

```
POST /auth/logout        → UPDATE user_sessions SET is_active=false WHERE user_id=me
```

- All refresh tokens for this user are now invalid.
- Other logged-in devices: their 15-min access token keeps working until expiry, then refresh returns 401 → client falls to `logoutLocal()` → anonymous again.
- Queued reports on other devices submitted with the old access token get stamped anonymous at meta-POST time if the token has already expired.

---

## Offline-grace Semantics (30 days)

Client-side:
- `AuthStore.isLoggedIn()` stays true for 30 days after the last successful refresh, even without network.
- `fetchWithAuth` attaches the cached access token to every call.
- UI stays in "logged-in" state (account pill on landing).

Server-side:
- `/reports/meta` accepts the request regardless of token state. Bearer valid → `user_id` stamped. Bearer expired or absent → `user_id = NULL` (anonymous). No 401 is ever raised from `/reports/meta`.

This is the key UX contract: **reporting never fails because of auth.**

---

## Rate limits

| Window | Limit | Scope |
|---|---|---|
| 10 min | 3 OTP requests | per `destination` |
| 60 min | 20 OTP requests | per IP |
| 30 min | 15 verify attempts (sum across records) | per `destination` |
| per OTP | 5 verify attempts | per record |

All return HTTP 429 with a friendly retry message.

---

## Development loop

```
# Run backend with email OTP logged to stdout (no real SMS):
export SMS_PROVIDER=stub
uvicorn app.main:app --reload

# Login from PWA:
#  1. Tap "Login / Sign up" on home
#  2. Pick Phone or Email, enter destination, tap "Send code"
#  3. Check the backend log - stub prints "[SMS stub] → +91…: CRISP: Your code is 123456"
#  4. Enter the code, tap Verify. Done.
```

---

## E2E

- `e2e/tests/pwa/25-optional-login.spec.ts` - 8 Playwright cases: AuthStore surface, skip path, channel picker, country-code default, Settings reachable, logout clears state.
- Full regression: `pytest backend/tests/` (expect new test modules for `/auth/otp` channel + `/auth/link-device` in the next sprint).
