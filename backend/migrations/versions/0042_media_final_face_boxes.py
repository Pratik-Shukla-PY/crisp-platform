"""media_final_face_boxes_normalized — L3 cross-tier consistency persistence

Revision ID: 0042_media_final_face_boxes_normalized
Revises: 0041_media_upload_generation
Create Date: 2026-05-22

Adds the storage layer for L3 — cross-tier face-detection consistency
voting. After the L1+L2+L4 gate stack accepts a BlazeFace candidate
and the blur is applied to a tier, the post-gate accepted box list
is persisted on the Media row in normalized [0,1] coordinates
(x, y, w, h tuples). A reconciliation pass across sibling tiers
(same photo_group_id, type=IMAGE) can then identify boxes that only
appeared at one tier — the classic resolution-dependent false-positive
signature — and either flag for operator review or trigger a
retroactive re-blur via the B-F pre-blur retention bytes (a separate
follow-up commit).

Why JSON not jsonb? Consistent with existing client_face_boxes_normalized
column (migration 0038). Both are write-once-per-blur reads-only-once
patterns, so the indexability advantage of jsonb doesn't apply.

Downgrade drops the column; loses L3 audit visibility but doesn't
break the live blur path.
"""

revision = "0042_media_final_face_boxes"
down_revision = "0041_media_upload_generation"
branch_labels = None
depends_on = None

from alembic import op
import sqlalchemy as sa


def upgrade() -> None:
    op.add_column(
        "media",
        sa.Column(
            "final_face_boxes_normalized",
            sa.JSON,
            nullable=True,
            comment=(
                "L3 (May 2026): post-gate accepted BlazeFace box list "
                "in normalized [0,1] coordinates as a JSON array of "
                "{x, y, w, h, conf} objects. Persisted by the assembly "
                "worker after L1+L2+L4 gates pass and blur is applied. "
                "Used by the cross-tier consistency reconciler to "
                "spot resolution-dependent false positives (boxes "
                "detected at only one of SMALL/MEDIUM/ORIGINAL)."
            ),
        ),
    )


def downgrade() -> None:
    op.drop_column("media", "final_face_boxes_normalized")
