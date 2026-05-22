"""pii_blur_status_4state — Batch B-A canonical status taxonomy

Revision ID: 0037_pii_blur_status_4state
Revises: 0036_drop_legacy_tier_values
Create Date: 2026-05-22

Migrates ``media.pii_blur_status`` from the legacy ad-hoc vocabulary
(pending / complete / failed / skipped / not_needed) to the 4-state
canonical vocabulary the May 2026 blur rebuild + dashboard chip
overhaul depends on:

    - pending                     blur in flight (assembly done,
                                  worker submitted to _ai_executor
                                  but not yet finished)
    - complete_clean              blur ran, NO PII detected
                                  (dashboard renders NO chip — the
                                   absence of a chip IS the signal)
    - complete_with_redactions    blur ran, PII detected + blurred
                                  (dashboard renders a green
                                   "Auto-redacted" chip)
    - failed                      blur attempted but raised, OR
                                  backends were unavailable
                                  (dashboard renders a red
                                   "Redaction failed — manual review")
    - not_needed                  media type doesn't go through blur
                                  (audio rows; dashboard renders no chip)

Legacy → canonical mapping:

    'complete'   → 'complete_with_redactions'
        Conservative migration: we don't have historical info on
        which legacy 'complete' rows actually had detections vs
        not. Treating all as redacted means every legacy report
        shows the redaction chip — safer than marking them clean
        when we can't verify.

    'skipped'    → 'failed'
        Operationally identical: file kept unblurred on disk,
        operator action required. 'skipped' was the old name for
        "MediaPipe + easyocr both unavailable"; 'failed' is the
        unified umbrella.

    'not_needed' → 'not_needed' (unchanged — audio bypass)
    'failed'     → 'failed' (unchanged)
    'pending'    → 'pending' (unchanged)
    NULL         → NULL (unchanged — legacy/test-fixture rows)

Also widens the column from String(16) to String(32). The longest
new value 'complete_with_redactions' is 26 chars; String(16) would
silently truncate to 'complete_with_re'.

Downgrade is LOSSY by definition: 'complete_with_redactions' and
'complete_clean' both reduce to 'complete' (the clean-vs-redacted
distinction is discarded). The migration documents this clearly so
operators understand a round-trip loses semantics.
"""

revision = "0037_pii_blur_status_4state"
down_revision = "0036_drop_legacy_tier_values"
branch_labels = None
depends_on = None

from alembic import op
import sqlalchemy as sa


def upgrade() -> None:
    # 1. Widen the column. The longest canonical value is
    #    'complete_with_redactions' = 26 chars. String(16) would
    #    truncate on insert. String(32) leaves headroom.
    op.alter_column(
        "media",
        "pii_blur_status",
        existing_type=sa.String(length=16),
        type_=sa.String(length=32),
        existing_nullable=True,
    )

    # 2. Migrate legacy 'complete' to 'complete_with_redactions'.
    #    Conservative — see the docstring on why.
    op.execute(
        "UPDATE media "
        "SET pii_blur_status = 'complete_with_redactions' "
        "WHERE pii_blur_status = 'complete'"
    )

    # 3. Migrate legacy 'skipped' to 'failed'.
    #    Operationally identical — both mean the operator must
    #    manually verify the file.
    op.execute(
        "UPDATE media "
        "SET pii_blur_status = 'failed' "
        "WHERE pii_blur_status = 'skipped'"
    )

    # 4. 'pending', 'failed', 'not_needed', NULL all stay as-is.
    #    No-op SQL; documented here for clarity.


def downgrade() -> None:
    # Collapse the 2 new "complete" states back to the single
    # legacy 'complete'. The distinction is irrecoverable — the
    # original code didn't persist whether detections were found,
    # so we can't reconstruct which rows were clean vs redacted.
    op.execute(
        "UPDATE media "
        "SET pii_blur_status = 'complete' "
        "WHERE pii_blur_status IN ('complete_with_redactions', "
        "'complete_clean')"
    )

    # Leave 'failed' as 'failed'. We CAN'T cleanly distinguish
    # migrated-from-'skipped' rows from genuine-'failed' rows
    # post-upgrade. Operator can re-investigate via worker logs
    # if a downgrade is needed for some reason.

    # Narrow the column back.
    op.alter_column(
        "media",
        "pii_blur_status",
        existing_type=sa.String(length=32),
        type_=sa.String(length=16),
        existing_nullable=True,
    )
