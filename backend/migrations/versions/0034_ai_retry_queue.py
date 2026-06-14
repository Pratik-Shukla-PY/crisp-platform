"""ai_retry_queue - Phase K K.6.b

Revision ID: 0034_ai_retry_queue
Revises: 0033_report_anon_expired
Create Date: 2026-05-20

Adds a persistent retry queue for AI pipeline tasks (transcription,
image analysis, truth scoring). Pre-K.6.b a transient failure
(Anthropic 5xx, Whisper OOM, satellite provider timeout) left the
report's `ai_assessment` NULL forever - no automatic retry. K.6.b
adds:

  - `ai_retry_queue` table with the retry state machine
  - daemon thread `_ai_retry_loop` in app.main that polls every 60 s,
    picks rows ready to retry, and re-runs the AI service call with
    exponential backoff (1 min → 5 min → 30 min → 2 h → 12 h).
  - terminal-failed status after attempt #5; dashboard chip in K.5.a
    extends to render "AI analysis failed" (planned follow-up; this
    migration just establishes the schema).

Status enum:
  - pending         - waiting for next retry (next_attempt_at <= now)
  - in_progress     - daemon picked this row up + is running it now
  - complete        - AI call succeeded; row stays for audit history
  - terminal_failed - 5 attempts exhausted; manual operator action only
"""
from alembic import op
import sqlalchemy as sa


revision = "0034_ai_retry_queue"
down_revision = "0033_report_anon_expired"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ai_retry_queue",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "report_id", sa.String(36),
            sa.ForeignKey("reports.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # 'transcription' | 'image_analysis' | 'truth_scoring' | other
        sa.Column("kind", sa.String(40), nullable=False),
        # Reference to the asset being processed (Media.url for media-
        # bound retries; NULL for report-level retries like truth_scoring
        # that read multiple assets).
        sa.Column("file_url", sa.String, nullable=True),
        sa.Column("media_type", sa.String(10), nullable=True),  # IMAGE | AUDIO
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "next_attempt_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
        ),
        sa.Column("last_error", sa.Text, nullable=True),
        sa.Column(
            "status", sa.String(20),
            nullable=False, server_default="pending",
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True),
            nullable=False, server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
    )
    # The daemon's hot query: status='pending' AND next_attempt_at <= NOW().
    # An index on (status, next_attempt_at) lets Postgres do an index scan
    # instead of a seq scan once the queue grows past a few hundred rows.
    op.create_index(
        "ix_ai_retry_queue_status_next_attempt",
        "ai_retry_queue",
        ["status", "next_attempt_at"],
    )
    # Per-report query (cleanup on report soft-delete + the dashboard's
    # "show me the retry history for this report" surface, if added).
    op.create_index(
        "ix_ai_retry_queue_report_id",
        "ai_retry_queue",
        ["report_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_ai_retry_queue_report_id", table_name="ai_retry_queue")
    op.drop_index(
        "ix_ai_retry_queue_status_next_attempt",
        table_name="ai_retry_queue",
    )
    op.drop_table("ai_retry_queue")
