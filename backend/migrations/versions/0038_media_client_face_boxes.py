"""media_client_face_boxes — Batch B-C client face-box hints

Revision ID: 0038_media_client_face_boxes
Revises: 0037_pii_blur_status_4state
Create Date: 2026-05-22

Adds a ``client_face_boxes_normalized`` JSON column on the ``media``
table. The PWA's pii-blur worker emits the face-box coordinates it
detected at capture time (normalized to 0.0–1.0 of W×H so they're
resolution-independent), and ships them with each chunk upload via
the ``X-Client-Face-Boxes`` header. The chunk handler stamps them
onto the Media row.

The server-side blur worker (``_run_server_pii_blur``) reads this
column and calls ``blur_pii_with_hints(image_path, client_boxes)``
which:
  1. Runs MediaPipe on the assembled bytes (safety net).
  2. Computes UNION of (client_boxes, server_boxes).
  3. Applies blur on the union. Privacy ratchets forward only —
     a box that any detector saw is honoured.

Column shape: JSON array of objects
   [{"x": float, "y": float, "w": float, "h": float}, ...]
   All four coords are in [0.0, 1.0] (fraction of W or H).

Why JSON not JSONB?
   The column is write-once / read-once per row. We never query
   inside it. JSON keeps round-trip text fidelity (preserves key
   ordering on round-trip — useful if we ever debug a coord
   mismatch). If high-volume querying becomes a need later, a
   migration to JSONB is one-line.

Backward compat: the column is nullable. Rows without client
boxes (pre-B-C uploads, non-PWA channels) leave NULL, and the
server blur path falls back to MediaPipe-only detection (its
existing behaviour).

Downgrade drops the column. No data loss concern — the column
is a HINT, not authoritative state.
"""

revision = "0038_media_client_face_boxes"
down_revision = "0037_pii_blur_status_4state"
branch_labels = None
depends_on = None

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


def upgrade() -> None:
    op.add_column(
        "media",
        sa.Column(
            "client_face_boxes_normalized",
            postgresql.JSON(astext_type=sa.Text()),
            nullable=True,
            comment=(
                "B-C: client-side face-box hints from the PWA's BlazeFace "
                "pass. JSON array of {x,y,w,h} in [0.0, 1.0] normalized "
                "coords. Server takes UNION with its own MediaPipe pass."
            ),
        ),
    )


def downgrade() -> None:
    op.drop_column("media", "client_face_boxes_normalized")
