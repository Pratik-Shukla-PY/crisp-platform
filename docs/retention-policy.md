# CRISP Data Retention Policy

Mapping to the **UNDP Personal Data Protection & Privacy Policy** §22-24
(limited retention) and **Annex 2 (c)** (notice of the anticipated retention
period). This is the operator-facing companion to the user-facing notice
(`privacy_retention_*` in the PWA privacy sheet).

## Principle

Personal data is kept only as long as necessary for the purpose it was
collected (faster, more accurate crisis response) plus a bounded
audit/verification window, after which it is **permanently deleted**.

## Retention periods

| Data | Retention | Anchor | Mechanism |
|---|---|---|---|
| **Reports** (incl. classifications, location, description) | While the crisis response is active, then **1 year** | Crisis `ended_at` for reports tied to an ENDED `CrisisEvent`; otherwise the report's `server_created_at` | `_enforce_retention_policy()` marks expired rows (DeletionAuditLog + grace=0); `_purge_expired_deletions()` hard-deletes them. Both run on the 15-min background sweep (`app.main._purge_loop`). |
| **Media** (photos, audio attached to a report) | Same as the parent report | Parent report | Cascade hard-delete with the report; files removed from S3/local. |
| **Raw audio bytes** (voice notes, pre-transcription) | **24 hours** after transcription | Transcription time | Transcription worker purge (`docs/SECURITY.md`). |
| **User-requested deletion** (per-report or "delete all my reports") | **24-hour** soft-delete grace, then permanent | `deletion_requested_at` | Undo within 24 h; then `_purge_expired_deletions()`. Mobile "delete now" uses a 30-min grace. |
| **Account deletion** (signed-in users) | **30-day** grace, then permanent | `gdpr_deletion_requested_at` | `POST /auth/me/delete-account`. |
| **Auth audit log** (login/logout/delete events) | **30 days** rolling | `created_at` | Scheduled purge. |
| **Deletion audit log** (anonymized forensic snapshot of purged reports) | Retained (non-personal: no raw PII, device hash only) | - | Accountability record; never contains photo/description. |
| **Geocode cache** | Transient (TTL) | - | Operational cache, not personal data. |
| **Anonymous aggregate statistics** (counts, regional totals) | Indefinite (non-personal) | - | Outside the scope of the privacy policy - never identifies an individual. |

## Configuration

`CRISP_RETENTION_AFTER_CLOSE_DAYS` (`backend/app/core/config.py`, default
**365**) sets the post-close / post-creation window in days. Set to **0** to
disable the automated retention sweep entirely (user-requested deletion still
applies). Operators may shorten the window per deployment via env without a
code change.

## Crisis-close semantics

A `CrisisEvent` has status `DRAFT | LIVE | ENDED`. Reports tied to a `LIVE`
(or `DRAFT`) crisis are **never** retention-purged - the response is still
active. Once an operator marks the crisis `ENDED` (stamping `ended_at`), the
1-year clock for its reports starts. Standalone reports (no crisis activation)
use their own creation date as the anchor, so a report older than the window
is purged even without an associated crisis event.

## Review

This policy and the DPIA are reviewed at least annually (UNDP Annex 3
obligation) - see `docs/dpia.md` M4. Risk R10 (retention drift) is mitigated
by the automated sweep documented here.
