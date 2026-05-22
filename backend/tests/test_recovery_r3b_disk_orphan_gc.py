"""R3.b (May 2026) — daemon Action ⑦ disk-orphan reconciliation.

storage.list_keys() lists objects under a given prefix with their
last-modified timestamp. The daemon's Action ⑦ walks the storage
backend, cross-references each key against live Media.url, and
deletes anything older than CRISP_HARD_ABANDON_DAYS with no live
referrer.

Tests cover:
  - list_keys returns (key, mtime) tuples for present files
  - list_keys skips the pre_blur/ namespace from a root-prefix scan
  - list_keys honours the older_than age gate
  - Action ⑦ deletes a disk orphan past the retention window AND
    leaves a live-referenced file alone
"""
from __future__ import annotations

import os
import time
import uuid

from app.services.storage import LocalStorage


def _clear_storage_singleton():
    import app.services.storage as s
    s._storage = None


def test_list_keys_returns_files_with_mtime(tmp_path):
    upload = tmp_path / "uploads"
    upload.mkdir()
    ls = LocalStorage(str(upload))
    ls.save("a.jpg", b"hello")
    ls.save("b.jpg", b"world")
    entries = ls.list_keys()
    keys = {e[0] for e in entries}
    assert keys == {"a.jpg", "b.jpg"}
    for key, mtime in entries:
        assert mtime > 0


def test_list_keys_skips_pre_blur_at_root(tmp_path):
    upload = tmp_path / "uploads"
    upload.mkdir()
    ls = LocalStorage(str(upload))
    ls.save("public.jpg", b"data")
    ls.save_internal("internal.jpg", b"data")
    keys = {k for (k, _) in ls.list_keys()}
    assert "public.jpg" in keys
    assert "internal.jpg" not in keys
    pre_keys = {k for (k, _) in ls.list_keys(prefix="pre_blur")}
    assert "internal.jpg" in pre_keys


def test_list_keys_age_gate(tmp_path):
    upload = tmp_path / "uploads"
    upload.mkdir()
    ls = LocalStorage(str(upload))
    ls.save("old.jpg", b"x")
    path = upload / "old.jpg"
    old_ts = time.time() - 35 * 86400
    os.utime(str(path), (old_ts, old_ts))
    ls.save("new.jpg", b"y")
    cutoff = time.time() - 30 * 86400
    entries = ls.list_keys(older_than_unix_ts=cutoff)
    keys = {k for (k, _) in entries}
    assert "old.jpg" in keys
    assert "new.jpg" not in keys


def test_action7_deletes_disk_orphan_past_retention(tmp_path, monkeypatch, client, db):
    """End-to-end: seed an orphan + a live file on disk, run the daemon,
    assert the orphan is gone and the live file remains.
    """
    from app.models.report import Media
    from app.services.storage import get_storage
    _clear_storage_singleton()
    monkeypatch.setenv("MEDIA_BACKEND", "local")
    monkeypatch.setenv("CRISP_UPLOAD_DIR", str(tmp_path / "uploads"))
    # Override the singleton with a fresh local backend rooted at tmp.
    import app.services.storage as _s
    _s._storage = LocalStorage(str(tmp_path / "uploads"))
    s = get_storage()
    s.save("orphan.jpg", b"orphan-bytes")
    s.save("live.jpg", b"live-bytes")
    for name in ("orphan.jpg", "live.jpg"):
        p = tmp_path / "uploads" / name
        old_ts = time.time() - 40 * 86400
        os.utime(str(p), (old_ts, old_ts))
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"R3B-{uuid.uuid4()}",
        "client_report_id": str(uuid.uuid4()),
        "source": "APP", "severity": "MODERATE",
        "infrastructure_type": "ROAD", "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        "location": {"latitude": 12.97, "longitude": 77.59},
        "expected_media": 1,
    })
    assert res.status_code == 201
    report_id = res.json()["id"]
    m = Media(
        id=str(uuid.uuid4()),
        report_id=report_id,
        type="IMAGE",
        resolution_tier="MEDIUM",
        url="/static/live.jpg",
        is_synced=True,
        chunk_count=1,
        received_chunks=1,
        completion_pct=100.0,
        assembly_status="complete",
    )
    db.add(m)
    db.commit()
    import app.main as _main
    _main._last_disk_orphan_gc_ts = 0.0
    _main._run_assembly_recovery_sweep(boot=False)
    assert not (tmp_path / "uploads" / "orphan.jpg").exists(), (
        "Action ⑦ must delete an unreferenced orphan past the retention window"
    )
    assert (tmp_path / "uploads" / "live.jpg").exists(), (
        "Action ⑦ must NOT delete files referenced by a live Media.url"
    )
    # Reset singleton so subsequent tests don't see the override.
    _s._storage = None
