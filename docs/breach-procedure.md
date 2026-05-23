# Personal-Data Breach Procedure — CRISP

**Last updated:** 2026-05-23
**Owner:** project lead (breach@crisplabs.tech)

This procedure satisfies UNDP Personal Data Privacy Policy §44 ("personal data breach"), §44.3 (register of breaches + notifications), and Annex 3 (CIO + DMO responsibilities).

## 1. What counts as a breach

Per UNDP Annex 1, a **personal data breach** is the unauthorised destruction, loss, alteration, disclosure of, or access to **unencrypted or decryptable** personal data, *as well as* the unplanned loss of availability of such data. Examples that would trigger this procedure on CRISP:

| Category | Concrete example |
|---|---|
| **Confidentiality breach** | An S3 bucket misconfiguration makes uploaded photos publicly readable. |
| **Integrity breach** | An attacker modifies report rows in Postgres to misclassify damage. |
| **Availability breach** | A ransomware incident encrypts the backend database and we cannot restore for > 1 day. |
| **Sub-processor breach** | Anthropic / AWS / Twilio reports a breach affecting our data per their contractual notification obligations. |
| **Client-side leak** | A bug in the PWA exposes the device-fingerprint hash to a third-party analytics script (we do not run analytics — this is a hypothetical regression guard). |

## 2. Channels for reporting

| Channel | Audience | Where it lands |
|---|---|---|
| `breach@crisplabs.tech` | Anyone — internal, external, user | Project lead inbox; auto-CC of `privacy@crisplabs.tech` |
| In-app Privacy → "Contact us" section | End users | Same as above — surfaced in `#stage-privacy` and `#home-privacy-sheet` |
| GitHub Security Advisory | Security researchers (responsible disclosure) | `github.com/Pratik-Shukla-PY/crisp-platform/security/advisories` |
| Sub-processor breach notifications | Anthropic / AWS / Twilio / Mapbox per their DPAs | Direct to project lead via vendor escalation |

## 3. Initial response — first 24 hours

1. **Receive** the report (any channel above).
2. **Acknowledge** the reporter within 4 hours.
3. **Triage** — confirm or dismiss. False positives close here.
4. **Contain** — disable affected endpoints / rotate credentials / revoke leaked keys / freeze the affected S3 path.
5. **Preserve** — snapshot the affected DB rows + S3 prefix for forensics. Never delete evidence before investigation.
6. **Open** the breach register entry (see §6 below).
7. **Inform** UNDP partnership contact within 24 hours of confirmation.

## 4. Investigation — within 72 hours

Document:

- What data was affected (categories of personal data, categories of data subjects, approximate volume)
- How the breach occurred (root cause)
- Whether the data was encrypted in transit / at rest
- Whether the data was decryptable by the attacker
- What technical / organisational measures are now in place to prevent recurrence

Hand off the investigation summary to the UNDP Chief Data Officer per UNDP Annex 3 ("Chief Information Officer maintains a register of personal data breaches and notifications").

## 5. Notifications

Per UNDP Annex 3, the **Data Management Owner** decides whether to notify affected data subjects. The decision criteria:

| Criterion | Action |
|---|---|
| Likely high risk to rights and freedoms (e.g. faces visible, reporter identifiable, sensitive location exposed) | Notify affected data subjects directly. For CRISP this is hard because we are anonymous by design — we will publish a public notice on `undp.crisplabs.tech/breach` + a banner on the home stage for ≥ 14 days. |
| Low risk (e.g. encrypted at rest + decryption key not compromised) | No data-subject notification; logged in the register; UNDP notified. |
| Risk to vital interests | Direct notification + escalation to UNDP Country Representative. |

**Notification template** lives at `docs/templates/breach-notification.md` (placeholder — author when first incident occurs).

## 6. Breach register

The register lives at `docs/breach-register.md` (created on first incident). Each entry:

```
Date detected:
Date reported / by whom:
Channels affected:
Categories of personal data affected:
Approximate number of data subjects affected:
Root cause summary:
Containment actions:
Notification decision + audience:
Lessons learned + mitigations applied:
Closed date:
```

Register entries are kept for 5 years per UNDP DMO duty (Annex 3, "review every 5 years").

## 7. Post-incident review

Within 14 days of containment:

- File a `CHANGES.md` entry documenting the fix + new regression tests.
- Update `docs/dpia.md` risk register if the incident reveals an unmitigated risk.
- Update `docs/sub-processors.md` if a vendor relationship needs adjustment.
- Add a permanent test (E2E spec or backend test) preventing regression.

## 8. Contact

- **Initial reporting:** `breach@crisplabs.tech`
- **Privacy & data-subject questions:** `privacy@crisplabs.tech`
- **Public security advisories:** `github.com/Pratik-Shukla-PY/crisp-platform/security`
- **UNDP escalation:** UNDP Chief Data Officer via the transparency portal (`undp.org`)
