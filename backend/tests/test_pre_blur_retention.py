"""B-F — pre-blur internal-store retention + retroactive-upgrade.

Pins:

  1. LocalStorage.save_internal / read_internal / delete_internal
     round-trip works and writes to the `pre_blur/` subdir (NOT
     the public upload dir). Bytes are NEVER exposed via
     /static/ routes.
  2. Save-then-read-then-delete is idempotent under repeat.
  3. Media model columns persist correctly (`pre_blur_internal_key`,
     `pre_blur_retained_until`).
  4. Sweep Action ⑤ purges expired entries (mocked via a row with
     `pre_blur_retained_until` in the past).
  5. Active entries (retention in the future) are NOT purged.
"""
from __future__ import annotations

import os
import tempfile
from datetime import datetime, timedelta, timezone

import pytest

from app.models.report import (
    Device, Report, Media, MediaTypeEnum, ResolutionEnum,
    SourceEnum, SyncStatusEnum,
)


# ── LocalStorage internal-store unit tests ──────────────────────────────


def test_save_internal_writes_to_pre_blur_subdir(tmp_path):
    """LocalStorage.save_internal lands bytes in `<upload_dir>/pre_blur/`,
    NOT in the public-served upload_dir root. The subdir keeps them
    physically isolated from nginx's `/static/` alias."""
    from app.services.storage import LocalStorage

    storage = LocalStorage(str(tmp_path))
    key = "test_pre_blur_1"
    payload = b"the assembled bytes before blur"
    returned = storage.save_internal(key, payload)
    assert returned == key

    # The file MUST be under pre_blur/, NOT in the public root.
    public_path = tmp_path / key
    private_path = tmp_path / "pre_blur" / key
    assert not public_path.exists(), (
        f"save_internal must NOT write to public upload_dir; "
        f"file at {public_path} would be served by nginx /static/"
    )
    assert private_path.exists(), (
        f"save_internal MUST write to <upload_dir>/pre_blur/; "
        f"file missing at {private_path}"
    )
    assert private_path.read_bytes() == payload


def test_read_internal_roundtrips(tmp_path):
    from app.services.storage import LocalStorage

    storage = LocalStorage(str(tmp_path))
    payload = b"\x00\x01\x02\x03" * 100  # binary safe
    storage.save_internal("rt_key", payload)
    assert storage.read_internal("rt_key") == payload


def test_read_internal_missing_raises(tmp_path):
    from app.services.storage import LocalStorage

    storage = LocalStorage(str(tmp_path))
    with pytest.raises(FileNotFoundError):
        storage.read_internal("never_existed")


def test_delete_internal_idempotent(tmp_path):
    from app.services.storage import LocalStorage

    storage = LocalStorage(str(tmp_path))
    storage.save_internal("del_key", b"x")
    assert storage.delete_internal("del_key") is True
    # Second delete on a missing entry → False, but no exception.
    assert storage.delete_internal("del_key") is False
    assert storage.delete_internal("never_existed") is False


def test_save_internal_overwrites_existing(tmp_path):
    from app.services.storage import LocalStorage

    storage = LocalStorage(str(tmp_path))
    storage.save_internal("ow_key", b"first")
    storage.save_internal("ow_key", b"second")
    assert storage.read_internal("ow_key") == b"second"


# ── Media model column persistence ─────────────────────────────────────


def _seed_media_with_retention(db, *, retained_until, device_hash):
    """Helper: seed a Media row with the B-F retention columns set."""
    d = Device(device_hash=device_hash)
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"bf-{device_hash}",
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
        url="/static/test.jpg",
        pii_blur_status="complete_with_redactions",
        pre_blur_internal_key=f"{device_hash}__pre_blur",
        pre_blur_retained_until=retained_until,
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return m


def test_pre_blur_columns_roundtrip(db):
    """Both new columns write and read back."""
    retain = datetime.now(timezone.utc) + timedelta(hours=24)
    m = _seed_media_with_retention(
        db, retained_until=retain, device_hash="bf-rt"
    )
    db.expire_all()
    refreshed = db.query(Media).filter_by(id=m.id).first()
    assert refreshed.pre_blur_internal_key == "bf-rt__pre_blur"
    assert refreshed.pre_blur_retained_until is not None
    # tz-aware UTC
    assert refreshed.pre_blur_retained_until.tzinfo is not None


def test_pre_blur_retained_until_indexed(db):
    """Index is required for the sweep's WHERE clause performance."""
    from sqlalchemy import inspect

    inspector = inspect(db.bind)
    indexes = inspector.get_indexes("media")
    pre_blur_idx = [
        ix for ix in indexes
        if ix.get("column_names", []) == ["pre_blur_retained_until"]
    ]
    assert pre_blur_idx, (
        "pre_blur_retained_until MUST be indexed; sweep's "
        "`WHERE pre_blur_retained_until < now` will scan otherwise."
    )


# ── Sweep Action ⑤ purge behaviour ─────────────────────────────────────


def test_sweep_action5_purges_expired(db, monkeypatch, tmp_path):
    """Sweep purges Media rows whose pre_blur_retained_until is in
    the past."""
    from app.main import _run_assembly_recovery_sweep
    from app.services import storage as storage_mod

    # Point storage at our temp dir so save_internal lands somewhere
    # we control.
    storage_mod.reset_storage_for_tests()
    monkeypatch.setenv("CRISP_UPLOAD_DIR", str(tmp_path))
    monkeypatch.setenv("MEDIA_BACKEND", "local")

    # Seed: 1 expired + 1 still-valid + 1 with no pre-blur retention
    past = datetime.now(timezone.utc) - timedelta(hours=1)
    future = datetime.now(timezone.utc) + timedelta(hours=23)

    expired = _seed_media_with_retention(
        db, retained_until=past, device_hash="bf-expired"
    )
    valid = _seed_media_with_retention(
        db, retained_until=future, device_hash="bf-valid"
    )

    # Capture keys BEFORE the sweep nulls them on the Media rows.
    expired_key = expired.pre_blur_internal_key
    valid_key = valid.pre_blur_internal_key

    # Drop bytes into internal store so the delete has something to remove
    s = storage_mod.get_storage()
    s.save_internal(expired_key, b"expired bytes")
    s.save_internal(valid_key, b"valid bytes")

    # Run sweep
    _run_assembly_recovery_sweep(boot=False)

    db.expire_all()
    expired_after = db.query(Media).filter_by(id=expired.id).first()
    valid_after = db.query(Media).filter_by(id=valid.id).first()

    # Expired row's columns are nulled
    assert expired_after.pre_blur_internal_key is None
    assert expired_after.pre_blur_retained_until is None
    # Valid row untouched
    assert valid_after.pre_blur_internal_key == valid_key
    assert valid_after.pre_blur_retained_until is not None

    # Bytes for expired key should be gone; valid key still present.
    with pytest.raises(FileNotFoundError):
        s.read_internal(expired_key)
    assert s.read_internal(valid_key) == b"valid bytes"

    # Cleanup
    storage_mod.reset_storage_for_tests()


def test_sweep_action5_handles_missing_storage_entry(db, monkeypatch, tmp_path):
    """If the DB row says the bytes are retained but the file is
    already gone (manual cleanup, S3 lifecycle, etc.), the sweep
    must still null the columns — not crash."""
    from app.main import _run_assembly_recovery_sweep
    from app.services import storage as storage_mod

    storage_mod.reset_storage_for_tests()
    monkeypatch.setenv("CRISP_UPLOAD_DIR", str(tmp_path))
    monkeypatch.setenv("MEDIA_BACKEND", "local")

    past = datetime.now(timezone.utc) - timedelta(hours=1)
    m = _seed_media_with_retention(
        db, retained_until=past, device_hash="bf-no-bytes"
    )
    # DON'T save_internal anything — DB says retention exists, disk doesn't.

    _run_assembly_recovery_sweep(boot=False)

    db.expire_all()
    after = db.query(Media).filter_by(id=m.id).first()
    assert after.pre_blur_internal_key is None
    assert after.pre_blur_retained_until is None
    storage_mod.reset_storage_for_tests()


def test_sweep_action5_does_not_purge_future_retention(db, monkeypatch, tmp_path):
    """Rows whose pre_blur_retained_until is in the future stay
    untouched."""
    from app.main import _run_assembly_recovery_sweep
    from app.services import storage as storage_mod

    storage_mod.reset_storage_for_tests()
    monkeypatch.setenv("CRISP_UPLOAD_DIR", str(tmp_path))
    monkeypatch.setenv("MEDIA_BACKEND", "local")

    future = datetime.now(timezone.utc) + timedelta(hours=2)
    m = _seed_media_with_retention(
        db, retained_until=future, device_hash="bf-future"
    )

    _run_assembly_recovery_sweep(boot=False)

    db.expire_all()
    after = db.query(Media).filter_by(id=m.id).first()
    assert after.pre_blur_internal_key == "bf-future__pre_blur"
    assert after.pre_blur_retained_until is not None
    storage_mod.reset_storage_for_tests()
