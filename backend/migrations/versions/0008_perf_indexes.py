"""performance indexes for 500k-scale crisis queries

Revision ID: 0008_perf
Revises: 0007_phash
Create Date: 2026-04-22

UNDP TRL-4 scale claim (up to 500 k reports/crisis, hundreds of crises/yr)
requires every dashboard + API filter to hit a Postgres index. Pre-this
migration the `reports` table carried indexes on `client_report_id`,
`infrastructure_sub_type`, and `building_id` only - which covers the
identity + dedup paths but NOT the time-range, status, crisis-type, or
device-id queries that the dashboard + status-since + exports endpoints
rely on.

Indexes added (all btree, default fillfactor):

    reports.server_created_at              - time-range feed + analytics
    reports.status                         - dashboard filter pills
    reports.crisis_type                    - crisis-category analytics
    reports.severity                       - heatmap + priority sort
    reports.damage_classification          - export filters
    reports.device_id                      - my-reports listing
    reports.reviewer_verdict               - verification / QA queue
    reports.deletion_requested_at          - purge-worker scan
    reports(status, server_created_at)     - composite: time-windowed feed
    reports(building_id, server_created_at) - composite: building history order
    reports(device_id, server_created_at)   - composite: my-reports order
    auth_audit_log.created_at              - audit log time-range
    media.created_at                       - pHash dedup time-window

Verified locally with:
    EXPLAIN ANALYZE SELECT * FROM reports
    WHERE server_created_at > now() - interval '24 hours'
    ORDER BY server_created_at DESC LIMIT 50;
→ `Index Scan Backward using ix_reports_server_created_at` (was Seq Scan).

Idempotent - every index created with `IF NOT EXISTS`. The downgrade
drops each individually with `IF EXISTS`.
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "0008_perf"
down_revision: Union[str, Sequence[str], None] = "0007_phash"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Single-column indexes: (table, column, index_name).
_SINGLE = [
    ("reports",        "server_created_at",      "ix_reports_server_created_at"),
    ("reports",        "status",                 "ix_reports_status"),
    ("reports",        "crisis_type",            "ix_reports_crisis_type"),
    ("reports",        "severity",               "ix_reports_severity"),
    ("reports",        "damage_classification",  "ix_reports_damage_classification"),
    ("reports",        "device_id",              "ix_reports_device_id"),
    ("reports",        "reviewer_verdict",       "ix_reports_reviewer_verdict"),
    ("reports",        "deletion_requested_at",  "ix_reports_deletion_requested_at"),
    ("auth_audit_log", "created_at",             "ix_auth_audit_log_created_at"),
    ("media",          "created_at",             "ix_media_created_at"),
]

# Composite indexes: (table, columns, index_name).
_COMPOSITE = [
    ("reports", ("status",      "server_created_at"), "ix_reports_status_created"),
    ("reports", ("building_id", "server_created_at"), "ix_reports_building_created"),
    ("reports", ("device_id",   "server_created_at"), "ix_reports_device_created"),
]


def upgrade() -> None:
    # Single-column indexes first - CREATE INDEX IF NOT EXISTS is idempotent
    # even on Postgres (since 9.5). We skip Alembic's DSL because it does
    # NOT emit the `IF NOT EXISTS` clause on index creation.
    for table, column, name in _SINGLE:
        op.execute(f'CREATE INDEX IF NOT EXISTS "{name}" ON "{table}" ("{column}")')
    for table, columns, name in _COMPOSITE:
        cols = ", ".join(f'"{c}"' for c in columns)
        op.execute(f'CREATE INDEX IF NOT EXISTS "{name}" ON "{table}" ({cols})')


def downgrade() -> None:
    for table, column, name in _SINGLE:
        op.execute(f'DROP INDEX IF EXISTS "{name}"')
    for table, columns, name in _COMPOSITE:
        op.execute(f'DROP INDEX IF EXISTS "{name}"')
