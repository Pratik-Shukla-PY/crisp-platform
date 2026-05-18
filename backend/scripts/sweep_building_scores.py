#!/usr/bin/env python3
"""CRISP — Phase H.1.b initial-sweep: backfill Building roll-ups + scores.

Migration 0028 created the `buildings` table + 16 backfilled rows (one
per distinct Report.building_id) with cheap fields populated
(id_source, osm_way_id, report_count, first/latest_report_at,
centroid_lat/lng) but left the cached roll-ups (severity_max,
damage_class_max, crisis_types_top3, debris_clearing_needed_count)
and the 5 intelligence scores NULL.

This script walks every Building row + invokes the same
`_refresh_building_rollups` and `_compute_building_scores` helpers
that the runtime `_apply_building_link` hook calls — so the existing
data lands at the same state a fresh Report.after_insert would have
produced.

Idempotent: re-running just re-derives the same values from the same
underlying reports. Safe to run repeatedly during operator sanity
checks.

Invocation:

    cd backend && source venv/bin/activate
    python ../scripts/sweep_building_scores.py
"""
import os
import sys

# Mirror create_admin.py's pattern — backend root on sys.path so
# `from app.db.session import ...` resolves whether invoked as
# `python scripts/sweep_building_scores.py` or
# `python -m scripts.sweep_building_scores` from inside backend/.
_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_ROOT not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT)

os.environ.setdefault("APP_ENV", "dev")

from sqlalchemy import text  # noqa: E402

from app.db.session import SessionLocal  # noqa: E402
from app.models.report import (  # noqa: E402
    _compute_building_scores,
    _refresh_building_rollups,
)


GREEN = "\x1b[32m"
RED = "\x1b[31m"
YELLOW = "\x1b[33m"
RESET = "\x1b[0m"


def main() -> int:
    db = SessionLocal()
    try:
        # Snapshot all Building ids first so concurrent inserts during
        # the sweep don't extend the loop indefinitely.
        ids = [r[0] for r in db.execute(
            text("SELECT id FROM buildings ORDER BY report_count DESC")
        ).all()]
        if not ids:
            print(f"{YELLOW}No Building rows found. Did migration 0028 run?{RESET}")
            return 0

        print(f"Sweeping {len(ids)} building(s)…")
        print("─" * 70)

        # Reuse the session's connection across all helper calls. The
        # helpers expect a raw connection object (psycopg2/SQLAlchemy
        # Connection), and a Session yields one via `.connection()`.
        # We don't use `with db.connection() as conn:` because the
        # context-manager exit closes the underlying transaction; we
        # want the final db.commit() at the end to land all updates.
        conn = db.connection()
        for i, bid in enumerate(ids, 1):
            short = bid[:40]
            try:
                _refresh_building_rollups(conn, bid)
                scores = _compute_building_scores(conn, bid)
                if scores:
                    conn.execute(text("""
                        UPDATE buildings SET
                            severity_score = :sev,
                            confidence_score = :conf,
                            activity_score = :act,
                            escalation_risk = :esc,
                            humanitarian_priority = :prio
                        WHERE id = :bid
                    """), {
                        "bid": bid,
                        "sev": scores["severity_score"],
                        "conf": scores["confidence_score"],
                        "act": scores["activity_score"],
                        "esc": scores["escalation_risk"],
                        "prio": scores["humanitarian_priority"],
                    })
                label = f"{i:>2}/{len(ids)}  {short:<42}"
                if scores:
                    print(
                        f"{GREEN}✓{RESET} {label}  "
                        f"sev={scores['severity_score']:>5.1f} "
                        f"conf={scores['confidence_score']:>5.1f} "
                        f"act={scores['activity_score']:>5.1f} "
                        f"esc={scores['escalation_risk']:>5.1f} "
                        f"prio={scores['humanitarian_priority']:>5.1f}"
                    )
                else:
                    print(f"{YELLOW}-{RESET} {label}  (no constituent reports)")
            except Exception as e:
                print(f"{RED}✗{RESET} {bid[:40]}  failed: {e}")
        db.commit()
        print("─" * 70)
        print(f"{GREEN}Sweep complete.{RESET}")

        # Re-check: how many buildings have NULL scores?
        null_count = db.execute(text(
            "SELECT COUNT(*) FROM buildings WHERE severity_score IS NULL"
        )).scalar() or 0
        if null_count:
            print(f"{YELLOW}⚠{RESET}  {null_count} building(s) still have NULL "
                  f"severity_score (no constituent reports?)")
        else:
            print(f"{GREEN}✓{RESET}  All buildings have populated scores.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
