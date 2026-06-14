"""devices: trust-score columns for the Nearby Reports trust-weighted pipeline

Revision ID: 0021_device_trust_columns
Revises: 0020_nearby_group_events
Create Date: 2026-05-16

Nearby Reports Pipeline - Phase 3 (docs/NEARBY_REPORTS_PIPELINE.md
§6.1) introduces trust-weighted device contribution. Replaces the
blanket per-device cap of 1 with a weighted model where verified
responders count 3.0, account-linked civilians 1.5, trusted
anonymous (≥ 5 prior clean reports) 1.2, new devices 1.0, and
suspicious devices 0.0 (dropped).

This migration adds:

  • devices.spam_score (float, default 0)        - accumulator
    incremented by sync hot signals (GPS spoof, impossible
    movement, rate burst) and the Phase-5 async batch worker
    (emulator fingerprint, narrative similarity).
  • devices.reports_count (int, default 0)       - total reports
    seen from this device. Maintained synchronously on every
    report POST.
  • devices.spam_signals (jsonb, default '[]')   - list of detected
    signal types per device, audit-readable: ["gps_spoof",
    "rate_burst", ...]. Used by §7's admin triage UI.

Indexed: composite (spam_score, reports_count) for the trust-tier
lookup used inside `aggregate_nearby` - wants to filter by
spam_score == 0 AND reports_count >= 5 to find the "trusted
anonymous" tier without a table scan.

Idempotent - inspector guard pattern from 0013/0015/0017/0018/0019/0020.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0021_device_trust_columns"
down_revision = "0020_nearby_group_events"
branch_labels = None
depends_on = None


_COL_SPAM_SCORE = "spam_score"
_COL_REPORTS_COUNT = "reports_count"
_COL_SPAM_SIGNALS = "spam_signals"
_IDX_TRUST = "ix_devices_trust"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("devices")}

    if _COL_SPAM_SCORE not in existing:
        op.add_column(
            "devices",
            sa.Column(_COL_SPAM_SCORE, sa.Float(), nullable=False,
                      server_default=sa.text("0.0")),
        )

    if _COL_REPORTS_COUNT not in existing:
        op.add_column(
            "devices",
            sa.Column(_COL_REPORTS_COUNT, sa.Integer(), nullable=False,
                      server_default=sa.text("0")),
        )

    if _COL_SPAM_SIGNALS not in existing:
        op.add_column(
            "devices",
            sa.Column(_COL_SPAM_SIGNALS,
                      postgresql.JSONB(astext_type=sa.Text()),
                      nullable=False,
                      server_default=sa.text("'[]'::jsonb")),
        )

    # Composite index for the trust-tier lookup.
    existing_idx = {idx["name"] for idx in inspector.get_indexes("devices")}
    if _IDX_TRUST not in existing_idx:
        op.create_index(
            _IDX_TRUST, "devices",
            [_COL_SPAM_SCORE, _COL_REPORTS_COUNT],
        )

    # Backfill reports_count from existing reports (one-shot).
    op.execute("""
        UPDATE devices d
        SET reports_count = (
            SELECT COUNT(*) FROM reports r WHERE r.device_id = d.id
        )
        WHERE reports_count = 0
    """)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_idx = {idx["name"] for idx in inspector.get_indexes("devices")}
    existing = {c["name"] for c in inspector.get_columns("devices")}
    if _IDX_TRUST in existing_idx:
        op.drop_index(_IDX_TRUST, table_name="devices")
    for col in (_COL_SPAM_SIGNALS, _COL_REPORTS_COUNT, _COL_SPAM_SCORE):
        if col in existing:
            op.drop_column("devices", col)
