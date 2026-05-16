"""devices.telemetry_summary jsonb — emulator-fingerprint capture

Revision ID: 0024_device_telemetry_summary
Revises: 0023_postgis_geospatial
Create Date: 2026-05-16

Phase 5.1 (docs/NEARBY_REPORTS_PIPELINE.md §6.2) — upgrades the
emulator_farm detector from the Phase-5 UA-substring scaffold to a
real telemetry-driven check.

Adds a single nullable JSON column `devices.telemetry_summary` that
the PWA + RN clients POST to /api/v1/devices/telemetry on app boot.
The detector reads from this column when present and falls through
to the old UA-substring rule when absent (backward compatible).

WHY A NULLABLE JSON BLOB, NOT A NORMALISED TABLE?

  The shape is OPEN — we expect to add new probe values (e.g. canvas
  fingerprint, performance.memory) without rolling a migration each
  time. JSON also lets the detector evolve the scoring logic without
  having to teach the schema. The summary is small (< 1 KB / row) and
  query patterns are always "give me this device's summary" — no need
  to scan or aggregate across telemetry fields at the DB level.

WHY NULLABLE?

  - Pre-existing devices have no captured telemetry. NULL means "no
    data" not "no signals" — the detector treats NULL as inconclusive
    and falls back to the cheap UA-substring check.
  - The capture is best-effort client-side — if BatteryAPI / WebGL /
    DeviceMotion access is denied or fails, the client may post a
    partial summary or skip entirely. NULL is the cleanest sentinel.

PRIVACY NOTE (UNDP must-have #7):

  This column does NOT store PII or raw sensor streams. The summary
  is a boolean / coarse-numeric distillation:
      accel_active=true/false, battery_present=true/false,
      battery_level=int (10-percent buckets), screen_dpr=float,
      webgl_renderer=string (truncated to 64 chars), timezone=string,
      locale=string, platform_ua=string (truncated to 200 chars).
  These are device-behaviour signals, not user-identity signals. The
  WebGL renderer string is the most fingerprint-able value but is
  necessary to detect software renderers (SwiftShader/ANGLE/Mesa/
  lavapipe) that virtually only emulators use.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0024_device_telemetry_summary"
down_revision = "0023_postgis_geospatial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {c["name"] for c in inspector.get_columns("devices")}
    # Idempotent — re-runs in dev shouldn't error.
    if "telemetry_summary" not in existing:
        op.add_column(
            "devices",
            sa.Column(
                "telemetry_summary",
                postgresql.JSONB(astext_type=sa.Text()),
                nullable=True,
            ),
        )


def downgrade() -> None:
    op.drop_column("devices", "telemetry_summary")
