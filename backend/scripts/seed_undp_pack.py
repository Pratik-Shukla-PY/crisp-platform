#!/usr/bin/env python3
"""Seed (idempotently) the published "UNDP Core Damage Assessment" crisis-form pack.

UNDP Appendix-1 mandates three core questions a reporter must answer to submit
damage-assessment images (electricity / health / pressing-needs). They are
delivered through the crisis-form-pack engine; this script publishes a ready-made
pack carrying them verbatim so the capability is demonstrable out-of-box. An
analyst then binds the pack to a crisis event (geo zone) - or composes their own
pack with these questions toggled in - via the dashboard.

Idempotent: re-running is safe.
  * If no pack with the canonical key exists -> create it + publish version 1.
  * If the pack exists but its active published version's schema differs from the
    canonical schema -> publish a NEW version (bumps active_version, archives the
    prior published one) so the seed self-heals after a copy update.
  * If it exists and already matches -> no-op.

Run inside the backend container / venv:

    python scripts/seed_undp_pack.py            # seed / update
    python scripts/seed_undp_pack.py --dry-run  # report what it WOULD do

Exit codes: 0 = success (created / updated / unchanged), 1 = error.
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone

_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_ROOT not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT)


def main() -> int:
    ap = argparse.ArgumentParser(description="Seed the UNDP Core Damage Assessment pack")
    ap.add_argument("--dry-run", action="store_true", help="report actions without writing")
    args = ap.parse_args()

    from app.db.session import SessionLocal
    from app.models.auth import User  # noqa: F401 - registers the FK target table 'users'
    from app.models.report import CrisisFormPack, CrisisFormPackVersion
    from app.services.crisis_form_schema import validate_pack_schema
    from app.services.undp_pack import UNDP_CORE_SCHEMA, UNDP_PACK_KEY, UNDP_PACK_TITLE

    schema = dict(UNDP_CORE_SCHEMA)
    schema["key"], schema["title"] = UNDP_PACK_KEY, UNDP_PACK_TITLE

    errs = validate_pack_schema(schema)
    if errs:
        print("✗ canonical UNDP schema failed validation:", file=sys.stderr)
        for e in errs:
            print(f"    - {e}", file=sys.stderr)
        return 1

    db = SessionLocal()
    try:
        pack = db.query(CrisisFormPack).filter(CrisisFormPack.key == UNDP_PACK_KEY).first()

        if pack is None:
            if args.dry_run:
                print(f"DRY-RUN: would CREATE pack '{UNDP_PACK_KEY}' + publish v1")
                return 0
            pack = CrisisFormPack(key=UNDP_PACK_KEY, title=UNDP_PACK_TITLE,
                                  crisis_type=None, created_by=None)
            db.add(pack); db.flush()
            ver = CrisisFormPackVersion(
                pack_id=pack.id, version=1, schema_json=schema, status="published",
                published_at=datetime.now(timezone.utc), created_by=None)
            db.add(ver); db.flush()
            pack.active_version = 1
            pack.is_archived = False
            db.commit()
            print(f"✓ created pack '{UNDP_PACK_KEY}' and published version 1 (id={pack.id})")
            return 0

        # Pack exists - compare the active published schema to the canonical one.
        active = None
        if pack.active_version:
            active = (db.query(CrisisFormPackVersion)
                      .filter(CrisisFormPackVersion.pack_id == pack.id,
                              CrisisFormPackVersion.version == pack.active_version)
                      .first())
        if active is not None and active.schema_json == schema:
            print(f"✓ pack '{UNDP_PACK_KEY}' already up to date (active v{pack.active_version}) - no change")
            return 0

        next_ver = (db.query(CrisisFormPackVersion)
                    .filter(CrisisFormPackVersion.pack_id == pack.id).count()) + 1
        if args.dry_run:
            print(f"DRY-RUN: would PUBLISH a new version v{next_ver} of '{UNDP_PACK_KEY}' (schema drift)")
            return 0
        for other in (db.query(CrisisFormPackVersion)
                      .filter(CrisisFormPackVersion.pack_id == pack.id,
                              CrisisFormPackVersion.status == "published").all()):
            other.status = "archived"
        ver = CrisisFormPackVersion(
            pack_id=pack.id, version=next_ver, schema_json=schema, status="published",
            published_at=datetime.now(timezone.utc), created_by=None)
        db.add(ver); db.flush()
        pack.active_version = next_ver
        pack.is_archived = False
        db.commit()
        print(f"✓ updated pack '{UNDP_PACK_KEY}': published version {next_ver} (schema refreshed)")
        return 0
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        print(f"✗ seed failed: {exc}", file=sys.stderr)
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
