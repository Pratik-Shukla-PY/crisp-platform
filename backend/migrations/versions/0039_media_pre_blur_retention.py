"""media_pre_blur_retention — Batch B-F retroactive-upgrade store

Revision ID: 0039_media_pre_blur_retention
Revises: 0038_media_client_face_boxes
Create Date: 2026-05-22

Adds two columns supporting Batch B-F's retroactive blur upgrade:

  - ``pre_blur_internal_key``: stable storage key (relative to the
    `pre_blur/` prefix used by storage.save_internal) pointing at
    the pre-blur assembled bytes. NULL when the row was already
    'complete_clean' (no PII detected, original bytes ARE the
    canonical public bytes — retention is unnecessary). NULL also
    when the retention window expired and the recovery sweep purged
    the bytes.
  - ``pre_blur_retained_until``: TIMESTAMP after which the internal
    bytes are eligible for purge by `_assembly_recovery_sweep`'s
    Action ⑤. Default at write time: now + 24 h.

How the retroactive upgrade works:
  1. SMALL arrives → blur worker detects 2 faces → blurs + publishes.
     ALSO writes pre_blur_internal_key + pre_blur_retained_until.
  2. MEDIUM arrives later (same photo_group_id) → blur worker
     detects 3 faces (third face was too small for SMALL detector
     to see). UNION = 3 boxes.
  3. Worker checks: does any SMALL row in the same photo_group_id
     have a retained pre-blur copy + a different box set than the
     new union? If yes, fetch pre_blur bytes, re-blur with union
     (scaled to SMALL dimensions), overwrite public storage, bump
     ?v= cache buster. SMALL is now redacted at MEDIUM-recall.
  4. After pre_blur_retained_until, sweep purges the internal bytes
     and nulls these columns. Retroactive upgrade is no longer
     possible — operator is told the tier is "sealed".

Retention rationale: 24 h covers the realistic MEDIUM/ORIGINAL
arrival window on operationally-slow networks. Longer retention
costs storage; shorter window risks losing the retroactive upgrade
on edge-case slow uploads.

Downgrade drops both columns. Loses retroactive-upgrade capability
for in-flight reports but doesn't affect already-published bytes.
"""

revision = "0039_media_pre_blur_retention"
down_revision = "0038_media_client_face_boxes"
branch_labels = None
depends_on = None

from alembic import op
import sqlalchemy as sa


def upgrade() -> None:
    op.add_column(
        "media",
        sa.Column(
            "pre_blur_internal_key",
            sa.String(length=255),
            nullable=True,
            comment=(
                "B-F: storage key (relative to pre_blur/ prefix) for "
                "the assembled pre-blur bytes. Retained for the "
                "duration of pre_blur_retained_until so a higher-tier "
                "arrival can re-blur this tier with the union. NULL "
                "after purge."
            ),
        ),
    )
    op.add_column(
        "media",
        sa.Column(
            "pre_blur_retained_until",
            sa.DateTime(timezone=True),
            nullable=True,
            comment=(
                "B-F: TIMESTAMP after which sweep Action ⑤ purges "
                "the pre-blur internal bytes. Default at write time: "
                "now + 24h. NULL after purge."
            ),
        ),
    )
    # Index for the sweep — query is `WHERE pre_blur_retained_until < now`
    # filtering to rows still holding pre-blur bytes.
    op.create_index(
        "ix_media_pre_blur_retained_until",
        "media",
        ["pre_blur_retained_until"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_media_pre_blur_retained_until", table_name="media")
    op.drop_column("media", "pre_blur_retained_until")
    op.drop_column("media", "pre_blur_internal_key")
