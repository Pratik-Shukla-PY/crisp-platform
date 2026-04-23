"""optional reporter login — user_id on reports + user_device_link + OTP channel

Revision ID: 0010_auth
Revises: 0009_ifno
Create Date: 2026-04-23

Phase 1 of the "Optional Login + Anonymous Reporting" initiative.
Additive-only migration: no existing row's behaviour changes, every new
column is nullable, the `is_anonymous` generated column gives dashboards
a zero-cost filter axis, and the new `user_device_link` join table lets a
reporter bind multiple devices to one account.

Changes:

    users
      + phone_number                  VARCHAR(32)  UNIQUE  NULL
      + phone_verified                BOOLEAN      DEFAULT FALSE
      + primary_auth_channel          VARCHAR(10)  NULL
      email column becomes NULLABLE   (a phone-only reporter has no email)

    otp_records
      + destination                   VARCHAR(255) NOT NULL  (holds email OR phone)
      + channel                       VARCHAR(10)  NOT NULL  (EMAIL | PHONE)
      email column stays — backfilled into destination; legacy rows keep it
      so the dashboard audit trail doesn't lose the original source field.
      +compound index (destination, purpose, used, expires_at) for verify
      hot-path.

    reports
      + user_id                       VARCHAR(36)  NULL  FK users.id ON DELETE SET NULL
      + is_anonymous                  BOOLEAN      GENERATED ALWAYS AS (user_id IS NULL) STORED
      + index (user_id, server_created_at)

    user_device_link  (NEW)
      user_id       VARCHAR(36)  FK users.id ON DELETE CASCADE
      device_hash   VARCHAR(255)
      linked_at     TIMESTAMP    DEFAULT now()
      PRIMARY KEY (user_id, device_hash)

Rollback: every new column is nullable and the generated column is safe to
drop; downgrade() reverses the structural additions without data loss.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "0010_auth"
down_revision: Union[str, Sequence[str], None] = "0009_ifno"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table: str, column: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if table not in inspector.get_table_names():
        return False
    return any(c["name"] == column for c in inspector.get_columns(table))


def _has_index(table: str, name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return any(i["name"] == name for i in inspector.get_indexes(table))


def _has_table(name: str) -> bool:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return name in inspector.get_table_names()


def upgrade() -> None:
    # ── users ────────────────────────────────────────────────────────────
    if not _has_column("users", "phone_number"):
        with op.batch_alter_table("users") as batch_op:
            batch_op.add_column(sa.Column("phone_number", sa.String(length=32), nullable=True))
            batch_op.create_unique_constraint("uq_users_phone_number", ["phone_number"])
    if not _has_column("users", "phone_verified"):
        with op.batch_alter_table("users") as batch_op:
            batch_op.add_column(
                sa.Column("phone_verified", sa.Boolean(), nullable=False, server_default=sa.false())
            )
    if not _has_column("users", "primary_auth_channel"):
        with op.batch_alter_table("users") as batch_op:
            batch_op.add_column(
                sa.Column("primary_auth_channel", sa.String(length=10), nullable=True)
            )
    # Relax email NOT NULL — phone-only reporters are now a valid shape.
    try:
        with op.batch_alter_table("users") as batch_op:
            batch_op.alter_column("email", existing_type=sa.String(length=255), nullable=True)
    except Exception:
        pass  # already nullable on this DB

    # ── otp_records ──────────────────────────────────────────────────────
    if not _has_column("otp_records", "destination"):
        with op.batch_alter_table("otp_records") as batch_op:
            batch_op.add_column(sa.Column("destination", sa.String(length=255), nullable=True))
        # Backfill: email column → destination
        op.execute("UPDATE otp_records SET destination = email WHERE destination IS NULL")
        with op.batch_alter_table("otp_records") as batch_op:
            batch_op.alter_column("destination", existing_type=sa.String(length=255), nullable=False)
    if not _has_column("otp_records", "channel"):
        with op.batch_alter_table("otp_records") as batch_op:
            batch_op.add_column(
                sa.Column("channel", sa.String(length=10), nullable=False, server_default="EMAIL")
            )
    # Relax otp_records.email to nullable so new phone-only rows are clean.
    try:
        with op.batch_alter_table("otp_records") as batch_op:
            batch_op.alter_column("email", existing_type=sa.String(length=255), nullable=True)
    except Exception:
        pass
    if not _has_index("otp_records", "ix_otp_verify_hotpath"):
        op.create_index(
            "ix_otp_verify_hotpath",
            "otp_records",
            ["destination", "purpose", "used", "expires_at"],
        )

    # ── reports ──────────────────────────────────────────────────────────
    if not _has_column("reports", "user_id"):
        with op.batch_alter_table("reports") as batch_op:
            batch_op.add_column(sa.Column("user_id", sa.String(length=36), nullable=True))
            batch_op.create_foreign_key(
                "fk_reports_user_id",
                "users",
                ["user_id"],
                ["id"],
                ondelete="SET NULL",
            )
    if not _has_index("reports", "ix_reports_user_created"):
        op.create_index(
            "ix_reports_user_created",
            "reports",
            ["user_id", "server_created_at"],
        )
    # Generated column on Postgres; SQLite ignores it. Dashboard still works
    # (filters can use `user_id IS NULL` directly).
    bind = op.get_bind()
    dialect = bind.dialect.name if bind else ""
    if dialect == "postgresql" and not _has_column("reports", "is_anonymous"):
        op.execute(
            "ALTER TABLE reports ADD COLUMN is_anonymous BOOLEAN "
            "GENERATED ALWAYS AS (user_id IS NULL) STORED"
        )

    # ── user_device_link ────────────────────────────────────────────────
    if not _has_table("user_device_link"):
        op.create_table(
            "user_device_link",
            sa.Column("user_id", sa.String(length=36), nullable=False),
            sa.Column("device_hash", sa.String(length=255), nullable=False),
            sa.Column(
                "linked_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.PrimaryKeyConstraint("user_id", "device_hash"),
            sa.ForeignKeyConstraint(
                ["user_id"], ["users.id"], ondelete="CASCADE", name="fk_udl_user"
            ),
        )
        op.create_index("ix_udl_device_hash", "user_device_link", ["device_hash"])


def downgrade() -> None:
    if _has_table("user_device_link"):
        try:
            op.drop_index("ix_udl_device_hash", table_name="user_device_link")
        except Exception:
            pass
        op.drop_table("user_device_link")

    if _has_index("reports", "ix_reports_user_created"):
        op.drop_index("ix_reports_user_created", table_name="reports")
    if _has_column("reports", "is_anonymous"):
        with op.batch_alter_table("reports") as batch_op:
            batch_op.drop_column("is_anonymous")
    if _has_column("reports", "user_id"):
        with op.batch_alter_table("reports") as batch_op:
            try:
                batch_op.drop_constraint("fk_reports_user_id", type_="foreignkey")
            except Exception:
                pass
            batch_op.drop_column("user_id")

    if _has_index("otp_records", "ix_otp_verify_hotpath"):
        op.drop_index("ix_otp_verify_hotpath", table_name="otp_records")
    if _has_column("otp_records", "channel"):
        with op.batch_alter_table("otp_records") as batch_op:
            batch_op.drop_column("channel")
    if _has_column("otp_records", "destination"):
        with op.batch_alter_table("otp_records") as batch_op:
            batch_op.drop_column("destination")

    if _has_column("users", "primary_auth_channel"):
        with op.batch_alter_table("users") as batch_op:
            batch_op.drop_column("primary_auth_channel")
    if _has_column("users", "phone_verified"):
        with op.batch_alter_table("users") as batch_op:
            batch_op.drop_column("phone_verified")
    if _has_column("users", "phone_number"):
        with op.batch_alter_table("users") as batch_op:
            try:
                batch_op.drop_constraint("uq_users_phone_number", type_="unique")
            except Exception:
                pass
            batch_op.drop_column("phone_number")
