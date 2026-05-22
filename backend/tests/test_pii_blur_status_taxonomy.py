"""B-A — canonical 4-state pii_blur_status taxonomy.

The May 2026 blur rebuild collapsed the legacy 5-value vocabulary
(pending / complete / failed / skipped / not_needed) into a cleaner
4-state operator-visible set, plus 'not_needed' for non-image rows.

Alembic 0037_pii_blur_status_4state:
  - widens column from String(16) → String(32)
    (longest new value 'complete_with_redactions' = 26 chars)
  - migrates 'complete'    → 'complete_with_redactions'
  - migrates 'skipped'     → 'failed'
  - leaves 'pending', 'failed', 'not_needed', NULL untouched

This test exercises the post-0037 column directly: each of the 4
canonical values (plus 'not_needed' for audio) must round-trip
cleanly through the ORM. It also asserts that 'complete_with_redactions'
fits in the widened column (a String(16) column would silently
truncate it to 'complete_with_re').

Positive assertions:
  - Write 'pending'                    → row reads back 'pending'
  - Write 'complete_clean'             → reads back 'complete_clean'
  - Write 'complete_with_redactions'   → reads back EXACT 26-char value
  - Write 'failed'                     → reads back 'failed'
  - Write 'not_needed'                 → reads back 'not_needed'
  - Write NULL                         → reads back None
"""
from __future__ import annotations

import pytest

from app.models.report import (
    Device,
    Report,
    Media,
    MediaTypeEnum,
    ResolutionEnum,
    SourceEnum,
    SyncStatusEnum,
)


_CANONICAL_VALUES = (
    'pending',
    'complete_clean',
    'complete_with_redactions',
    'failed',
    'not_needed',
)


def _seed_media(db, *, status, device_hash, idx=0):
    """Create one Device + Report + Media row with the given pii_blur_status."""
    d = Device(device_hash=f"{device_hash}-{idx}")
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"taxonomy-{device_hash}-{idx}",
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=1,
        received_media=1,
    )
    db.add(r)
    db.flush()
    m = Media(
        report_id=r.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.SMALL,
        url=f"/static/test-{device_hash}-{idx}.jpg",
        pii_blur_status=status,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


# ── Round-trip each canonical value ──────────────────────────────────────────


@pytest.mark.parametrize("value", _CANONICAL_VALUES)
def test_canonical_status_value_roundtrips(db, value):
    """Each of the 5 canonical values writes + reads back exactly."""
    m = _seed_media(db, status=value, device_hash="rt", idx=hash(value) & 0xFFFF)
    db.expire_all()
    refreshed = db.query(Media).filter_by(id=m.id).first()
    assert refreshed is not None
    assert refreshed.pii_blur_status == value, (
        f"Round-trip failed for {value!r}: got {refreshed.pii_blur_status!r}"
    )


def test_null_status_is_acceptable(db):
    """NULL pii_blur_status must remain writable (legacy/test-fixture rows)."""
    m = _seed_media(db, status=None, device_hash="rt", idx=999)
    db.expire_all()
    refreshed = db.query(Media).filter_by(id=m.id).first()
    assert refreshed.pii_blur_status is None


# ── Column width ─────────────────────────────────────────────────────────────


def test_complete_with_redactions_not_truncated(db):
    """The 26-char 'complete_with_redactions' must fit fully — no silent
    truncation that would change semantics (e.g. to 'complete_with_re').

    Pre-0037 the column was String(16); writing this value would have
    truncated. After 0037 the column is String(32). This test guards
    against any future narrowing.
    """
    expected = 'complete_with_redactions'
    assert len(expected) == 24, (
        f"Test invariant: expected length 24, got {len(expected)}"
    )

    m = _seed_media(db, status=expected, device_hash="width", idx=1)
    db.expire_all()
    refreshed = db.query(Media).filter_by(id=m.id).first()
    assert refreshed.pii_blur_status == expected, (
        f"Column must hold the full {len(expected)}-char value without "
        f"truncation. Got: {refreshed.pii_blur_status!r}"
    )
    # Defensive: assert the stored value's length matches what we wrote.
    assert len(refreshed.pii_blur_status) == len(expected)


# ── Indexed column ───────────────────────────────────────────────────────────


def test_status_column_is_indexed_for_dashboard_filter(db):
    """The dashboard's PII-blur chip filter queries by pii_blur_status.
    Column MUST stay indexed (declared in models/report.py:550 as
    `Column(String(32), nullable=True, index=True)`)."""
    from sqlalchemy import inspect

    inspector = inspect(db.bind)
    indexes = inspector.get_indexes("media")
    # Look for any index on a single 'pii_blur_status' column.
    pii_indexes = [
        ix for ix in indexes
        if ix.get("column_names", []) == ["pii_blur_status"]
    ]
    assert pii_indexes, (
        f"pii_blur_status MUST be indexed for the dashboard chip filter. "
        f"Found indexes: {[ix['column_names'] for ix in indexes]}"
    )


# ── Migration vocabulary check (smoke) ───────────────────────────────────────


def test_canonical_value_count(db):
    """Sanity check: the 4-state taxonomy + 'not_needed' = 5 values."""
    assert len(_CANONICAL_VALUES) == 5
    assert set(_CANONICAL_VALUES) == {
        'pending',
        'complete_clean',
        'complete_with_redactions',
        'failed',
        'not_needed',
    }
    # Legacy values that B-A retired:
    legacy = {'complete', 'skipped'}
    assert legacy.isdisjoint(_CANONICAL_VALUES), (
        "Legacy values 'complete' and 'skipped' must NOT appear in the "
        "canonical set — alembic 0037 migrates them forward."
    )
