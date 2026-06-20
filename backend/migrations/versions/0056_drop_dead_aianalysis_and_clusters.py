"""Incident redesign Phase E - drop dead AIAnalysis stub fields + legacy cluster tables

Revision ID: 0056_drop_dead_ai_clusters
Revises: 0055_report_reviewed_by
Create Date: 2026-06-19 (Incident redesign, Phase E - dead-data removal)

Two unrelated artifacts that no live code path reads:

1. ai_analysis.{damage_score, ai_severity, detected_labels, processing_time_ms}
   were populated only by a hardcoded image-analysis stub that FABRICATED a
   constant damage_score (0.5) and a constant label ('infrastructure_damage').
   Nothing ever read these four columns - the analyst-facing AI credibility
   verdict comes from reports.ai_assessment (POST /{id}/ai-assess), and the
   only fields the ai_analysis row still needs are the genuine Whisper
   transcription + AI-cleaned ai_summary. Drop the four stub columns.

2. incident_clusters + cluster_reports were a legacy geo-clustering scheme
   superseded by the building_id / h3 dedup keys + report_duplicate_decisions
   (migration 0054). The only importer (app/services/geo_clustering.py) had
   zero callers and has been removed. Drop both tables.

The shared `severityenum` type is left in place (still backs reports.severity);
only the `clusterstatusenum` type - used exclusively by incident_clusters - is
dropped. `infratypeenum` is likewise shared and kept.

downgrade() is best-effort: it recreates the four nullable columns and the two
tables (minimal shape) so the chain stays reversible. No data is restored - the
dropped columns held only fabricated values and the tables were unpopulated by
live code.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


revision: str = "0056_drop_dead_ai_clusters"
down_revision: Union[str, Sequence[str], None] = "0055_report_reviewed_by"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Drop the four fabricated AIAnalysis stub columns.
    op.drop_column("ai_analysis", "damage_score")
    op.drop_column("ai_analysis", "ai_severity")
    op.drop_column("ai_analysis", "detected_labels")
    op.drop_column("ai_analysis", "processing_time_ms")

    # 2. Drop the legacy cluster tables (child first for FK safety).
    op.drop_table("cluster_reports")
    op.drop_table("incident_clusters")

    # The clusterstatusenum type is now orphaned (no remaining column uses it).
    # severityenum / infratypeenum are shared with live columns - leave them.
    op.execute("DROP TYPE IF EXISTS clusterstatusenum")


def downgrade() -> None:
    # Raw DDL throughout: op.create_table / op.add_column auto-emit CREATE TYPE
    # for every Enum column, which collides with the SHARED severityenum /
    # infratypeenum types that are still live. Raw SQL lets us recreate only the
    # one type we actually dropped (clusterstatusenum) and reference the shared
    # types by name without re-issuing them.
    op.execute(
        "CREATE TYPE clusterstatusenum AS ENUM "
        "('ACTIVE', 'RESOLVED', 'FALSE_ALARM')"
    )
    op.execute(
        """
        CREATE TABLE incident_clusters (
            id VARCHAR(36) NOT NULL,
            center_lat FLOAT NOT NULL,
            center_lng FLOAT NOT NULL,
            radius_meters FLOAT NOT NULL,
            confidence_score FLOAT,
            status clusterstatusenum NOT NULL,
            primary_infrastructure_type infratypeenum,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT (CURRENT_TIMESTAMP),
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT (CURRENT_TIMESTAMP),
            PRIMARY KEY (id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE cluster_reports (
            cluster_id VARCHAR(36) NOT NULL,
            report_id VARCHAR(36) NOT NULL,
            added_at TIMESTAMP WITH TIME ZONE DEFAULT (CURRENT_TIMESTAMP),
            PRIMARY KEY (cluster_id, report_id),
            FOREIGN KEY(cluster_id) REFERENCES incident_clusters (id)
                ON DELETE CASCADE,
            FOREIGN KEY(report_id) REFERENCES reports (id) ON DELETE CASCADE
        )
        """
    )

    # Recreate the four AIAnalysis columns (all nullable). severityenum already
    # exists (backs reports.severity) - reference it by name, no CREATE TYPE.
    op.execute("ALTER TABLE ai_analysis ADD COLUMN damage_score FLOAT")
    op.execute("ALTER TABLE ai_analysis ADD COLUMN ai_severity severityenum")
    op.execute("ALTER TABLE ai_analysis ADD COLUMN detected_labels JSON")
    op.execute("ALTER TABLE ai_analysis ADD COLUMN processing_time_ms INTEGER")
