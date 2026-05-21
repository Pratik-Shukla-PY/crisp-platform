"""May 21, 2026 — race-safe ReporterProfile auto-create on /profile/.

Bug discovered during cellular smoke 5 backend-log audit: the PWA's
home-screen polls `GET /api/v1/reports/profile/{device_hash}` every
~5 s. On the first poll for a brand-new device, the handler runs:

    profile = db.query(ReporterProfile).filter(...).first()
    if not profile:
        profile = ReporterProfile(...)
        db.add(profile)
        db.commit()

Two concurrent requests both observe `profile=None`, both attempt the
INSERT. The loser hits the unique constraint
`ix_reporter_profiles_device_hash` and raises IntegrityError → 500
Internal Server Error to the client. PWA retries on next poll cycle —
no data loss — but the 500s are real noise in the backend log.

Same family of fix as Phase K K.1.b (IntegrityError catch on duplicate
chunk): wrap the INSERT in try/except, re-SELECT the winning row on
conflict, return it.

Positive assertion: spawn 5 concurrent GETs against the same fresh
device_hash; assert all 5 return 200 with the same profile id, no 500s
emitted.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor


def test_concurrent_profile_create_on_fresh_device(client, db):
    """5 concurrent GET /profile/{hash} for a brand-new device → all
    200, all return the same profile row, no 500.

    Pre-fix this raced on the auto-create branch: 1-4 of the 5 requests
    would 500 with IntegrityError on
    `ix_reporter_profiles_device_hash`.
    """
    device_hash = "race-test-fresh-device-2026-05-21"

    def _fetch_profile() -> tuple[int, dict | None]:
        res = client.get(f"/api/v1/reports/profile/{device_hash}")
        try:
            body = res.json()
        except Exception:
            body = None
        return res.status_code, body

    with ThreadPoolExecutor(max_workers=5) as ex:
        futures = [ex.submit(_fetch_profile) for _ in range(5)]
        results = [f.result(timeout=15) for f in futures]

    # Assertion 1: every request returns 200 — no 500s from the dup-key.
    for i, (code, body) in enumerate(results):
        assert code == 200, (
            f"request {i} returned {code}; expected 200. "
            f"Body: {body}. "
            f"This is the pre-fix race: concurrent INSERTs to "
            f"reporter_profiles for the same device_hash."
        )

    # Assertion 2: every response references the same profile (same
    # device_hash, same badge_level — they observe the same row).
    badges = {body.get("badge_level") for _, body in results if body}
    assert badges == {"T1_SCOUT"}, (
        f"badge_level values diverged across concurrent reads: {badges}. "
        f"All should be T1_SCOUT for a fresh device."
    )

    # Assertion 3: exactly ONE ReporterProfile row exists for this hash
    # (no duplicate rows leaked).
    from app.models.report import ReporterProfile
    row_count = (
        db.query(ReporterProfile)
        .filter(ReporterProfile.device_hash == device_hash)
        .count()
    )
    assert row_count == 1, (
        f"row_count={row_count}; expected exactly 1 ReporterProfile row "
        f"for device_hash={device_hash}. Multiple rows means the unique "
        f"constraint isn't being honored (or the SELECT-then-INSERT race "
        f"escaped the catch)."
    )


def test_serial_profile_create_baseline(client, db):
    """Regression sentinel: serial GET /profile/ still creates one row.

    The race-fix must not break the single-threaded happy path.
    """
    device_hash = "serial-baseline-profile-2026-05-21"

    # First GET creates the profile.
    res1 = client.get(f"/api/v1/reports/profile/{device_hash}")
    assert res1.status_code == 200
    body1 = res1.json()
    assert body1.get("badge_level") == "T1_SCOUT"
    assert body1.get("report_count") == 0

    # Second GET reads the same row.
    res2 = client.get(f"/api/v1/reports/profile/{device_hash}")
    assert res2.status_code == 200
    body2 = res2.json()
    assert body2.get("badge_level") == "T1_SCOUT"

    # Exactly one row in DB.
    from app.models.report import ReporterProfile
    row_count = (
        db.query(ReporterProfile)
        .filter(ReporterProfile.device_hash == device_hash)
        .count()
    )
    assert row_count == 1, f"row_count={row_count}; expected 1"
