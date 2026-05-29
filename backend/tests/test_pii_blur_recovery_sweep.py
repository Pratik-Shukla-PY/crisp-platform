"""PII-blur recovery sweep (May 2026 OOM hotfix) — _run_pii_blur_recovery_sweep.

The OOM crash-loop orphaned in-flight server-PII-blur tasks, stranding Media
rows at pii_blur_status='pending'. The public GET /reports/media/{id}/file
gate returns 425 Too Early for as long as a row is 'pending', so those images
showed "Checking PII" forever. `_run_pii_blur_recovery_sweep` (app/main.py)
drains the backlog with two bounded, PII-SAFE actions keyed on updated_at age:

  ① give up   — client-blurred 'pending' rows past the WEDGED deadline
                (_PII_BLUR_WEDGED_MIN) flip to terminal 'failed'. This LIFTS
                the 425 (the client-side-blurred bytes are served, so no raw
                face is exposed) and bounds re-driving.
  ② re-drive  — client-blurred 'pending' rows stale past _PII_BLUR_STALE_MIN
                (but not yet wedged) are re-submitted to the blur executor.

PII-safety guard (UNDP must-have #7): rows with client_blur_applied=False
(server blur is their ONLY face protection) are NEVER auto-lifted — flipping
them to 'failed' would un-gate raw faces. They stay 'pending' (held), counted
for operator visibility.

These tests pin every branch + the guard so a regression flips red. They are
ML-free: `_ai_executor.submit` is mocked so the re-drive path records the call
without running MediaPipe/easyocr.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from app.models.report import (
    Device,
    Report,
    Media,
    MediaTypeEnum,
    ResolutionEnum,
    SourceEnum,
    SyncStatusEnum,
)

# Mirror the app/main.py defaults so the test windows line up with the sweep.
_STALE_MIN = 5
_WEDGED_MIN = 60


def _seed_media(
    db,
    *,
    blur_status,
    client_blur,
    age_min,
    assembly="complete",
    url="/static/sweep-test.jpg",
):
    """Create Device + Report + a single Media row with an explicit
    `updated_at` age (minutes in the past) so the sweep's STALE/WEDGED
    windows can be exercised deterministically. Committed so the sweep's
    own SessionLocal sees it."""
    d = Device(device_hash=f"sweep-{uuid.uuid4()}")
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=str(uuid.uuid4()),  # client_report_id is varchar(36)
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=1,
        received_media=0,
    )
    db.add(r)
    db.flush()
    media_id = str(uuid.uuid4())
    m = Media(
        id=media_id,
        report_id=r.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.MEDIUM,
        url=url,
        assembly_status=assembly,
        client_blur_applied=client_blur,
        pii_blur_status=blur_status,
        # onupdate fires only on UPDATE, so this explicit INSERT value sticks.
        updated_at=datetime.now(timezone.utc) - timedelta(minutes=age_min),
    )
    db.add(m)
    db.commit()
    return media_id


class _FakeExec:
    """Stand-in for reports._ai_executor — records submits, runs nothing."""

    def __init__(self):
        self.calls = []

    def submit(self, fn, *args, **kwargs):
        self.calls.append(args)  # (media_id, url, filename)
        return None


def test_sweep_all_branches_and_pii_guard(client, db, monkeypatch):
    # Patch the blur executor so re-drives are recorded, not executed. The
    # sweep does a function-local `from ...reports import _ai_executor`, which
    # re-reads the module attribute at call time → picks up this fake.
    import app.api.endpoints.reports as _reports

    fake = _FakeExec()
    monkeypatch.setattr(_reports, "_ai_executor", fake)

    mid = (_STALE_MIN + _WEDGED_MIN) // 2  # 32 min — inside the re-drive window

    wedged_cb = _seed_media(db, blur_status="pending", client_blur=True, age_min=_WEDGED_MIN + 30)
    wedged_ncb = _seed_media(db, blur_status="pending", client_blur=False, age_min=_WEDGED_MIN + 30)
    stale_cb = _seed_media(db, blur_status="pending", client_blur=True, age_min=mid)
    stale_ncb = _seed_media(db, blur_status="pending", client_blur=False, age_min=mid)
    fresh_cb = _seed_media(db, blur_status="pending", client_blur=True, age_min=1)
    terminal = _seed_media(db, blur_status="complete_clean", client_blur=True, age_min=_WEDGED_MIN + 30)
    assembling = _seed_media(
        db, blur_status="pending", client_blur=True, age_min=_WEDGED_MIN + 30, assembly="assembling"
    )

    from app.main import _run_pii_blur_recovery_sweep

    _run_pii_blur_recovery_sweep(boot=True)

    db.expire_all()

    def status(mid_):
        return db.query(Media).filter(Media.id == mid_).first().pii_blur_status

    submitted = {c[0] for c in fake.calls}

    # ① wedged + client-blurred → flipped to terminal 'failed' (425 lifts).
    assert status(wedged_cb) == "failed"
    assert wedged_cb not in submitted, "a flipped row must not also be re-driven"

    # GUARD: wedged + NOT-client-blurred → held at 'pending' (never un-gated).
    assert status(wedged_ncb) == "pending"
    assert wedged_ncb not in submitted

    # ② stale + client-blurred → re-driven, status stays 'pending'.
    assert stale_cb in submitted
    assert status(stale_cb) == "pending"

    # GUARD: stale + NOT-client-blurred → NOT re-driven, stays 'pending'.
    assert stale_ncb not in submitted
    assert status(stale_ncb) == "pending"

    # fresh (younger than STALE window) → untouched.
    assert fresh_cb not in submitted
    assert status(fresh_cb) == "pending"

    # already-terminal ('complete_clean') → untouched (sweep only acts on 'pending').
    assert status(terminal) == "complete_clean"

    # not-yet-assembled (assembly_status != 'complete') → untouched.
    assert status(assembling) == "pending"
    assert assembling not in submitted


def test_drainer_fail_mode_lifts_client_blurred_only(client, db, monkeypatch):
    """The one-shot drainer (scripts/drain_stuck_pii_blur.py) --mode fail must
    flip ONLY client-blurred stuck rows to 'failed', leaving NOT-client-blurred
    rows gated. min_age_min=0 so age doesn't gate the test rows."""
    import sys
    import os

    sys.path.insert(
        0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))
    )
    import drain_stuck_pii_blur as drainer

    cb = _seed_media(db, blur_status="pending", client_blur=True, age_min=30)
    ncb = _seed_media(db, blur_status="pending", client_blur=False, age_min=30)

    rc = drainer.main(
        dry_run=False, mode="fail", include_unblurred=False, min_age_min=0, report_id=None
    )
    assert rc == 0

    db.expire_all()

    def status(mid_):
        return db.query(Media).filter(Media.id == mid_).first().pii_blur_status

    assert status(cb) == "failed", "client-blurred stuck row should be un-gated"
    assert status(ncb) == "pending", "NOT-client-blurred row must stay gated by default"


def test_drainer_dry_run_changes_nothing(client, db):
    import sys
    import os

    sys.path.insert(
        0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scripts"))
    )
    import drain_stuck_pii_blur as drainer

    cb = _seed_media(db, blur_status="pending", client_blur=True, age_min=30)
    rc = drainer.main(
        dry_run=True, mode="fail", include_unblurred=False, min_age_min=0, report_id=None
    )
    assert rc == 0
    db.expire_all()
    m = db.query(Media).filter(Media.id == cb).first()
    assert m.pii_blur_status == "pending", "dry-run must not mutate anything"
