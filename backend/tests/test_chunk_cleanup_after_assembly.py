"""Post-assembly media_chunks reclaim (May 2026).

Once a Media row reaches assembly_status='complete' with its assembled file in
storage, the media_chunks reassembly buffers are dead weight — the public
``GET /media/{id}/file`` route serves media.url from storage, never the chunks.
They were historically never deleted (DB bloat + original bytes at rest). This
suite locks down the three pieces of the reclaim:

  1. ``storage.exists()`` — the gate the inline reclaim trusts before deleting.
  2. The chunk-upload complete-guard — a late / duplicate chunk for an
     already-'complete' media gets an idempotent ack and inserts NO new row, so
     it can't re-seed the reclaimed table.
  3. ``scripts/purge_assembled_chunks.py`` — the one-shot backfill deletes
     chunks for complete media only; pending / assembling media keep theirs.

The inline reclaim inside ``_assemble_media_file`` (the [AssemblyBG] path) is
exercised end-to-end by the local live smoke (submit image → chunks→0 → /file
still 302s); the DELETE it performs is byte-identical to the backfill covered
here.
"""
from __future__ import annotations

import importlib.util
import pathlib
import uuid

from app.api.endpoints.reports import djb2_checksum
from app.models.report import (
    Device,
    Report,
    Media,
    MediaChunk,
    MediaTypeEnum,
    ResolutionEnum,
    SourceEnum,
    SyncStatusEnum,
)


# ── helpers ──────────────────────────────────────────────────────────────────

def _seed_report(db, *, tag: str) -> Report:
    d = Device(device_hash=f"chunkclean-{tag}-{uuid.uuid4().hex[:8]}")
    db.add(d)
    db.flush()
    r = Report(
        device_id=d.id,
        source=SourceEnum.APP,
        client_report_id=f"chunkclean-{tag}-{uuid.uuid4().hex[:8]}",
        sync_status=SyncStatusEnum.PARTIAL,
        expected_media=1,
        received_media=0,
    )
    db.add(r)
    db.commit()
    db.refresh(r)
    return r


def _add_media(db, report, *, status: str, n_chunks: int, url: str = "/static/x.jpg") -> str:
    mid = str(uuid.uuid4())
    db.add(Media(
        id=mid,
        report_id=report.id,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.SMALL,
        url=url,
        is_synced=(status == "complete"),
        chunk_count=n_chunks,
        received_chunks=n_chunks,
        completion_pct=100.0 if status == "complete" else 0.0,
        assembly_status=status,
        client_blur_applied=False,
    ))
    for i in range(n_chunks):
        db.add(MediaChunk(
            media_id=mid,
            seq_num=i,
            total_chunks=n_chunks,
            data_b64="ABCD" * 16,
            checksum="x",
        ))
    db.commit()
    return mid


def _chunk_count(db, mid: str) -> int:
    db.expire_all()
    return db.query(MediaChunk).filter(MediaChunk.media_id == mid).count()


def _load_purge_main():
    path = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "purge_assembled_chunks.py"
    spec = importlib.util.spec_from_file_location("purge_assembled_chunks", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.main


# ── 1. storage.exists() — the reclaim gate ────────────────────────────────────

def test_local_storage_exists(tmp_path):
    from app.services.storage import LocalStorage

    st = LocalStorage(str(tmp_path))
    url = st.save("foo.jpg", b"bytes")
    assert url == "/static/foo.jpg"
    assert st.exists(url) is True
    assert st.exists("/static/missing.jpg") is False
    assert st.exists("") is False
    # cross-backend s3:// row can't be confirmed by the local backend
    assert st.exists("s3://foo.jpg") is False


# ── 2. chunk-upload complete-guard ────────────────────────────────────────────

def test_late_chunk_for_complete_media_is_noop(client, db):
    """A chunk arriving for an already-'complete' media must not insert a row
    (which would re-seed the table the reclaim just emptied) — idempotent ack."""
    r = _seed_report(db, tag="guard")
    mid = _add_media(db, r, status="complete", n_chunks=0)
    before = _chunk_count(db, mid)

    payload = {
        "media_id": mid,
        "type": "IMAGE",
        "seq_num": 0,
        "total_chunks": 3,
        "data": "ABCD" * 64,
        "checksum": djb2_checksum("ABCD" * 64),
        "resolution_tier": "SMALL",
    }
    res = client.post(f"/api/v1/reports/{r.id}/media/chunk", json=payload)
    assert res.status_code == 200, res.text
    assert res.json().get("assembly_status") == "complete"
    assert _chunk_count(db, mid) == before  # guard inserted nothing


def test_late_chunk_bin_for_complete_media_is_noop(client, db):
    """Same guard on the binary-transport endpoint (multipart: Form fields +
    a `data` file part)."""
    r = _seed_report(db, tag="guard-bin")
    mid = _add_media(db, r, status="complete", n_chunks=0)
    before = _chunk_count(db, mid)

    res = client.post(
        f"/api/v1/reports/{r.id}/media/chunk-bin",
        data={
            "media_id": mid,
            "type": "IMAGE",
            "seq_num": "0",
            "total_chunks": "3",
            "resolution_tier": "SMALL",
        },
        files={"data": ("c0.bin", b"ABCDABCD", "application/octet-stream")},
    )
    assert res.status_code == 200, res.text
    assert res.json().get("assembly_status") == "complete"
    assert _chunk_count(db, mid) == before


# ── 3. backfill script — scripts/purge_assembled_chunks.py ────────────────────

def test_backfill_purges_complete_keeps_pending(db):
    r = _seed_report(db, tag="backfill")
    complete_mid = _add_media(db, r, status="complete", n_chunks=3)
    pending_mid = _add_media(db, r, status="pending", n_chunks=2)
    assert _chunk_count(db, complete_mid) == 3
    assert _chunk_count(db, pending_mid) == 2

    main = _load_purge_main()
    rc = main(dry_run=False, verify_storage=False, report_id=r.id)
    assert rc == 0

    assert _chunk_count(db, complete_mid) == 0   # reclaimed
    assert _chunk_count(db, pending_mid) == 2     # untouched (not complete)


def test_backfill_dry_run_changes_nothing(db):
    r = _seed_report(db, tag="dryrun")
    complete_mid = _add_media(db, r, status="complete", n_chunks=2)

    main = _load_purge_main()
    rc = main(dry_run=True, verify_storage=False, report_id=r.id)
    assert rc == 0
    assert _chunk_count(db, complete_mid) == 2   # dry-run deletes nothing
