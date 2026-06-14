#!/usr/bin/env python3
"""
CRISP - Phase F.3.c (May 2026) audit: legacy NULL / OTHER infrastructure_type
counts.

Read-only diagnostic. Quantifies the operator-reported "everything is
Transport & Communication on the dashboard" complaint at the data layer
BEFORE we decide whether F.3.b's backfill migration is worth running.

What it prints:

    Total reports                                 : 1234
    infrastructure_type IS NULL                   :    0     (0.0%)
    infrastructure_type = 'OTHER'                 :  640    (51.9%)
    Per-source breakdown (rows = source channel):
        APP        (PWA)                          :  XX / XX  ( YY% OTHER )
        ANDROID    (RN)                           :  XX / XX
        TELEGRAM                                  :  XX / XX
        WHATSAPP                                  :  XX / XX
        SMS                                       :  XX / XX
        IVR                                       :  XX / XX
    Age cohort breakdown (rows = age bucket of the OTHER-tagged set):
        < 7d        : NN
        7d - 30d    : NN
        > 30d       : NN

If most of the OTHER rows are chat-channel + recent (< 7d), the F.3.a
fix (chat extractor stopped silent-coercing OTHER, shipped in commit
2fcb761) already drives that number toward zero for new submissions -
so a backfill probably isn't worth the risk.

If most OTHER rows are old PWA submissions (legacy ROAD chip migrations
that landed pre-Phase-22) a different decision is appropriate: leave
them tagged, surface a "needs categorisation" chip on the dashboard
once F.3.b ships, let a moderator review.

Idempotent: runs an aggregate-only SELECT, never modifies data. Safe to
run repeatedly. Reads the active DATABASE_URL from `app.core.config`
the same way the seed_e2e_admin.py script does.

Invocation:

    cd backend && source venv/bin/activate
    python ../scripts/audit_infra_type_null.py
"""
import sys
import os
from datetime import datetime, timedelta, timezone

# Allow running from repo root or from backend/
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..', 'backend')))

os.environ.setdefault("APP_ENV", "dev")

from sqlalchemy import text  # noqa: E402
from app.db.session import SessionLocal  # noqa: E402


def _hr(s: str = "") -> None:
    print(s if s else "─" * 60)


def main() -> int:
    db = SessionLocal()
    try:
        # ── Totals ────────────────────────────────────────────────────
        total = db.execute(text("SELECT COUNT(*) FROM reports")).scalar() or 0
        null_count = db.execute(
            text("SELECT COUNT(*) FROM reports WHERE infrastructure_type IS NULL")
        ).scalar() or 0
        other_count = db.execute(
            text("SELECT COUNT(*) FROM reports WHERE infrastructure_type = 'OTHER'")
        ).scalar() or 0

        # Soft-deleted rows (deletion_requested_at past grace) probably
        # shouldn't count toward the operator's "what's visible on the
        # dashboard" question. The default visibility gate is:
        #   deletion_requested_at IS NULL
        #     OR now() < deletion_requested_at + (deletion_grace_minutes || ' minutes')
        # We mirror that here for a "visible to operators" sub-total.
        visible_total = db.execute(text("""
            SELECT COUNT(*)
            FROM reports
            WHERE deletion_requested_at IS NULL
               OR NOW() < deletion_requested_at + (COALESCE(deletion_grace_minutes, 1440) || ' minutes')::interval
        """)).scalar() or 0

        _hr()
        print("CRISP - infrastructure_type audit (Phase F.3.c)")
        _hr()
        print(f"Total reports in DB                      : {total:>8}")
        print(f"Visible (post-soft-delete-gate)          : {visible_total:>8}")
        print(f"  infrastructure_type IS NULL            : {null_count:>8}"
              f"  ({_pct(null_count, total)})")
        print(f"  infrastructure_type = 'OTHER'          : {other_count:>8}"
              f"  ({_pct(other_count, total)})")

        # ── Per-source breakdown ──────────────────────────────────────
        _hr()
        print("Per-source breakdown (rows where infra_type IN (NULL, 'OTHER')):")
        rows = db.execute(text("""
            SELECT
                source,
                COUNT(*) AS total_in_source,
                SUM(CASE WHEN infrastructure_type IS NULL THEN 1 ELSE 0 END) AS n_null,
                SUM(CASE WHEN infrastructure_type = 'OTHER' THEN 1 ELSE 0 END) AS n_other
            FROM reports
            GROUP BY source
            ORDER BY COUNT(*) DESC
        """)).fetchall()
        for source, src_total, n_null, n_other in rows:
            label = (source or "UNKNOWN").ljust(12)
            n_null = int(n_null or 0)
            n_other = int(n_other or 0)
            ambiguous = n_null + n_other
            print(f"  {label}: {ambiguous:>5} of {src_total:>5}"
                  f"  ({_pct(ambiguous, src_total):>5})"
                  f"   (NULL={n_null}, OTHER={n_other})")

        # ── Age cohort breakdown of the OTHER set ─────────────────────
        _hr()
        print("Age cohort of OTHER-tagged rows (server_created_at):")
        cohorts = [
            ("< 24h",     timedelta(hours=24)),
            ("24h - 7d",  timedelta(days=7)),
            ("7d - 30d",  timedelta(days=30)),
            ("> 30d",     None),
        ]
        now = datetime.now(timezone.utc)
        prev_cutoff = now
        for label, span in cohorts:
            if span is None:
                # everything older than the previous cutoff
                count = db.execute(text("""
                    SELECT COUNT(*) FROM reports
                    WHERE infrastructure_type = 'OTHER'
                      AND server_created_at < :cutoff
                """), {"cutoff": prev_cutoff}).scalar() or 0
            else:
                this_cutoff = now - span
                count = db.execute(text("""
                    SELECT COUNT(*) FROM reports
                    WHERE infrastructure_type = 'OTHER'
                      AND server_created_at >= :cutoff
                      AND server_created_at <= :upper
                """), {"cutoff": this_cutoff, "upper": prev_cutoff}).scalar() or 0
                prev_cutoff = this_cutoff
            print(f"  {label:<12}: {count:>5}")

        # ── Recommendation logic ──────────────────────────────────────
        _hr()
        print("Recommendation:")
        if total == 0:
            print("  (no data) - no action needed.")
        elif other_count == 0 and null_count == 0:
            print("  Clean. infrastructure_type is populated on every row.")
        elif other_count / max(total, 1) > 0.3:
            print(f"  HIGH NOISE - {other_count} of {total} rows tagged OTHER.")
            print("  Recommended action:")
            print("    1. Ship F.3.b (infrastructure_type_source enum)")
            print("       so the dashboard can distinguish AI-inferred OTHER")
            print("       from user-selected OTHER.")
            print("    2. Then optionally re-run the AI extractor against")
            print("       the chat-channel rows (TELEGRAM/WHATSAPP/SMS/IVR")
            print("       above) - they're the source most likely to have")
            print("       silent-coerced to OTHER before commit 2fcb761.")
        else:
            print(f"  Modest noise - {other_count} OTHER rows ({_pct(other_count, total)}).")
            print("  Recommended action:")
            print("    1. Ship F.3.b for distinguishing source going forward.")
            print("    2. Leave existing rows tagged OTHER; surface a")
            print("       'needs categorisation' chip on the dashboard so a")
            print("       moderator can review case-by-case.")
        _hr()
        return 0
    finally:
        db.close()


def _pct(n: int, total: int) -> str:
    if not total:
        return "0.0%"
    return f"{(n / total * 100):.1f}%"


if __name__ == "__main__":
    sys.exit(main())
