# Offline outbox encryption at rest — design & decision (issue I6)

**Status:** Deferred (no runtime code shipped). This documents the threat model and the
only approaches that provide *real* protection, so a future implementation is principled
rather than security theater.

## What's at rest
The PWA offline outbox is IndexedDB `crisp-offline` › `pending-reports` (one row per queued
report). Sensitive fields: GPS (`meta.location`), free-text description, **photo Blobs**
(SMALL/MEDIUM/ORIGINAL, faces client-blurred), and **audio** (potential witness testimony).
As of v350 a report can persist up to **30 days** (I0), so the data lives on-device longer.
(The reporter auth token is **no longer** stored in the outbox — removed in I5.)

## Threat model — why naive encryption does NOT help
The realistic web threats are (a) **XSS / malicious script in the origin** and (b) **device
theft / disk forensics / cloud backup leak**.

- For **anonymous** reporters (the default — must-have #9) there is **no user secret** to
  derive a key from. Any key the app can use must itself live in the same origin
  (IndexedDB / localStorage / a non-extractable WebCrypto key persisted in IDB). An XSS
  payload running in the origin can read the data directly **or** call `crypto.subtle` with
  the same key the app uses — so encryption adds **no protection against (a)**.
- Non-extractable WebCrypto keys persisted in IDB stop `exportKey()`, but XSS can still
  `decrypt()` with them (or capture plaintext during encrypt/decrypt). Marginal.
- The only thing same-origin encryption meaningfully defends is **(b)** — and only if the
  key is **not** persisted in the origin.

Conclusion: shipping AES-with-a-stored-key for anonymous users would create a **false sense
of security** (and add complexity + a corruption/UX risk class) for ~no real gain. That is
worse than not shipping it.

## Approaches that DO provide real at-rest protection
1. **Passphrase-gated encryption (logged-in reporters only).** Derive an AES-GCM key via
   PBKDF2/Argon2 from a user-entered passphrase that is **never persisted**; re-prompt on
   SW/app resume. Protects against device theft + cloud-backup leak (not active XSS).
   Cost: a passphrase prompt + re-entry friction; only covers logged-in users; lost
   passphrase = unrecoverable queue. Gate behind optional login.
2. **OS keystore (React Native only).** RN can hold a non-extractable key in the iOS
   Keychain / Android Keystore (EncryptedSharedPreferences), inaccessible to web XSS.
   This is the strongest option but is **not available to the PWA** (no Web API). Track as
   an RN-side enhancement.

## Decision (operator-approved, Jun 2026)
**Defer.** Do not ship naive PWA encryption. Compensating controls today: HTTPS origin
isolation, a strict CSP, client-side PII face-blur before the bytes ever hit IDB, the I5
removal of the stored token, and the 24-hour soft-delete + server-side retention policy.
Revisit via approach (1) if/when login becomes a stronger part of the flow, and approach
(2) on the RN client. **I10** (confirm S3 bucket SSE/KMS for media at rest server-side) is
an ops task tracked separately.
