"""heal OSM building names mis-flagged as non-OSM (the "Unnamed Building" bug)

Revision ID: 0063_heal_osm_building_names
Revises: 0062_building_risk
Create Date: 2026-06-22 (data-only heal of the pre-v135 PWA camelCase/snake_case desync)

A pre-v135 PWA bug shipped infrastructure_name_from_osm=false on reports where the
reporter had explicitly TAPPED an OSM building footprint, so the dashboard gate
(_taggedBuildingName) suppressed the real name and the building rendered as
"Unnamed Building". The name string itself was stored correctly.

A reports.building_id that starts with 'osm:' can ONLY come from an explicit OSM
footprint tap (free-text / category paths never set an osm: building_id), so such a
row with a non-empty infrastructure_name but from_osm=false is unambiguously the bug.
This heal:
  1. flips infrastructure_name_from_osm = true for those rows, and
  2. backfills Building.osm_name from a representative report where the buildings row
     has no name yet (so per-building surfaces — Console header, map popup, building
     PDFs/AI — show the name too).

Data-only + idempotent; downgrade is a no-op (we don't re-introduce the bug).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0063_heal_osm_building_names"
down_revision: Union[str, Sequence[str], None] = "0062_building_risk"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1) Heal the report provenance flag for explicit OSM footprint taps.
    op.execute(sa.text(
        """
        UPDATE reports
           SET infrastructure_name_from_osm = true
         WHERE building_id LIKE 'osm:%'
           AND infrastructure_name IS NOT NULL
           AND btrim(infrastructure_name) <> ''
           AND infrastructure_name_from_osm = false
           AND deletion_requested_at IS NULL
        """
    ))
    # 2) Backfill Building.osm_name from the earliest named report on that building,
    #    only where the buildings row currently has no name.
    op.execute(sa.text(
        """
        UPDATE buildings b
           SET osm_name = sub.nm
          FROM (
                SELECT DISTINCT ON (building_id)
                       building_id, btrim(infrastructure_name) AS nm
                  FROM reports
                 WHERE building_id LIKE 'osm:%'
                   AND infrastructure_name IS NOT NULL
                   AND btrim(infrastructure_name) <> ''
                   AND deletion_requested_at IS NULL
              ORDER BY building_id, server_created_at ASC
               ) AS sub
         WHERE b.id = sub.building_id
           AND (b.osm_name IS NULL OR btrim(b.osm_name) = '')
        """
    ))


def downgrade() -> None:
    # No-op: reversing the heal would re-introduce the "Unnamed Building" bug.
    pass
