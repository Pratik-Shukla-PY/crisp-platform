"""Resolution-tier upgrade on chunk POST after thumbnail seeded the row.

Regression cover for the May 2026 bug where `/media/thumbnail` hard-coded
`ResolutionEnum.MEDIUM` when it created a fresh Media row, and the chunk
handlers' `else` branch (existing row) never touched the tier field.
Net effect: clients that posted the thumbnail BEFORE the first chunk
(messaging-bot fleet — WhatsApp / Telegram / IVR) ended up with every
photo tagged MEDIUM regardless of the tier the chunk POSTs declared.
That in turn broke the dashboard's "Originals pending" chip, which keys
on `resolution_tier === 'HIGH'`.

Two paths exercised here:

  1. ThumbnailPayload now carries an optional `resolution_tier`. New
     rows are stamped with the client-declared tier instead of the
     hard-coded MEDIUM.
  2. Chunk handlers' else branch upgrades LOW/MEDIUM → HIGH (never
     downgrades) when the chunk's declared tier is HIGH. Covers PWA
     uploads where the thumbnail predates the new field but the chunks
     still want to be tagged HIGH.

Both `/media/chunk` (JSON+base64, legacy) and `/media/chunk-bin`
(multipart, binary) carry the upgrade — the find-or-create-row logic
is shared.
"""
import base64
import io
import time

from app.api.endpoints.reports import djb2_bytes, djb2_checksum
from app.models.report import Media, ResolutionEnum


def _seed_report(client, device_hash: str = "TEST-TIER-OVERRIDE") -> str:
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": device_hash,
        "client_report_id": f"tier-{time.time_ns()}",
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "location": {"latitude": 12.97, "longitude": 77.59},
        "expected_media": 1,
    })
    assert res.status_code == 201, res.text
    return res.json()["id"]


def _post_thumbnail(client, report_id, media_id, *, tier=None):
    body = {
        "media_id": media_id,
        # 1x1 transparent gif as a data URL — keeps the payload tiny
        # and exercises the data: prefix decoding path.
        "thumbnail_data": (
            "data:image/gif;base64,"
            "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
        ),
    }
    if tier is not None:
        body["resolution_tier"] = tier
    res = client.post(
        f"/api/v1/reports/{report_id}/media/thumbnail",
        json=body,
    )
    assert res.status_code == 200, res.text


def _post_chunk_bin(client, report_id, media_id, *, tier="HIGH",
                    data=b"jpgbytes", seq=0, total=1):
    form = {
        "media_id": media_id,
        "seq_num": str(seq),
        "total_chunks": str(total),
        "type": "IMAGE",
        "resolution_tier": tier,
        "client_blur_applied": "false",
        "checksum": djb2_bytes(data),
    }
    files = {"data": ("chunk.bin", io.BytesIO(data), "application/octet-stream")}
    res = client.post(
        f"/api/v1/reports/{report_id}/media/chunk-bin",
        data=form, files=files,
    )
    assert res.status_code == 200, res.text


def _post_chunk_b64(client, report_id, media_id, *, tier="HIGH",
                    data=b"jpgbytes", seq=0, total=1):
    data_b64 = base64.b64encode(data).decode("ascii")
    res = client.post(
        f"/api/v1/reports/{report_id}/media/chunk",
        json={
            "media_id": media_id,
            "type": "IMAGE",
            "seq_num": seq,
            "total_chunks": total,
            "data": data_b64,
            "checksum": djb2_checksum(data_b64),
            "resolution_tier": tier,
        },
    )
    assert res.status_code == 200, res.text


class TestThumbnailTierField:
    """ThumbnailPayload.resolution_tier path — clients can now declare
    the tier up front instead of relying on the chunk-handler upgrade."""

    def test_default_tier_is_medium_for_backcompat(self, client, db):
        """Legacy clients that don't send the field still get MEDIUM —
        same behaviour the endpoint had before the field existed."""
        report_id = _seed_report(client)
        _post_thumbnail(client, report_id, "m-thumb-default")
        m = db.query(Media).filter(Media.id == "m-thumb-default").first()
        assert m is not None
        assert m.resolution_tier == ResolutionEnum.MEDIUM

    def test_thumbnail_with_explicit_low_tags_row_low(self, client, db):
        """Messaging-bot path: thumbnail declares LOW so the row reflects
        the single-tier transport instead of getting silently bumped
        to MEDIUM by the old hard-code."""
        report_id = _seed_report(client)
        _post_thumbnail(client, report_id, "m-thumb-low", tier="LOW")
        m = db.query(Media).filter(Media.id == "m-thumb-low").first()
        assert m is not None
        assert m.resolution_tier == ResolutionEnum.LOW

    def test_thumbnail_with_explicit_high_tags_row_high(self, client, db):
        """PWA full-quality variant — thumbnail can declare HIGH directly
        without waiting on the chunk-handler upgrade."""
        report_id = _seed_report(client)
        _post_thumbnail(client, report_id, "m-thumb-high", tier="HIGH")
        m = db.query(Media).filter(Media.id == "m-thumb-high").first()
        assert m is not None
        assert m.resolution_tier == ResolutionEnum.HIGH


class TestChunkBinTierUpgrade:
    """Chunk handler else-branch upgrade path. Covers PWA clients still
    on the old thumbnail format (no tier field) — the chunk POSTs do
    the upgrade after the fact."""

    def test_thumbnail_then_high_chunk_bin_ends_high(self, client, db):
        """Primary regression — thumbnail first (lands MEDIUM), then a
        chunk-bin POST with resolution_tier=HIGH; the row must end up
        HIGH so the dashboard 'Originals pending' chip can see it."""
        report_id = _seed_report(client)
        media_id = "m-upgrade-bin"

        _post_thumbnail(client, report_id, media_id)
        m = db.query(Media).filter(Media.id == media_id).first()
        assert m.resolution_tier == ResolutionEnum.MEDIUM, "thumbnail default"

        _post_chunk_bin(client, report_id, media_id, tier="HIGH")
        db.refresh(m)
        assert m.resolution_tier == ResolutionEnum.HIGH

    def test_thumbnail_then_high_chunk_b64_ends_high(self, client, db):
        """Same regression on the legacy JSON+base64 transport — the
        else-branch upgrade must apply on both endpoints since the
        thumbnail might predate either."""
        report_id = _seed_report(client)
        media_id = "m-upgrade-b64"

        _post_thumbnail(client, report_id, media_id)
        _post_chunk_b64(client, report_id, media_id, tier="HIGH")

        m = db.query(Media).filter(Media.id == media_id).first()
        assert m.resolution_tier == ResolutionEnum.HIGH

    def test_low_chunk_does_not_downgrade_medium_row(self, client, db):
        """Conservative rule: never downgrade. A MEDIUM thumbnail row
        followed by a LOW chunk stays MEDIUM — the chunk handler only
        upgrades toward HIGH."""
        report_id = _seed_report(client)
        media_id = "m-no-downgrade"

        _post_thumbnail(client, report_id, media_id)  # defaults to MEDIUM
        _post_chunk_bin(client, report_id, media_id, tier="LOW")

        m = db.query(Media).filter(Media.id == media_id).first()
        assert m.resolution_tier == ResolutionEnum.MEDIUM

    def test_high_thumbnail_not_downgraded_by_low_chunk(self, client, db):
        """If the thumbnail explicitly declared HIGH and a stray LOW
        chunk arrives (mixed-tier client bug), the row stays HIGH."""
        report_id = _seed_report(client)
        media_id = "m-high-stays-high"

        _post_thumbnail(client, report_id, media_id, tier="HIGH")
        _post_chunk_bin(client, report_id, media_id, tier="LOW")

        m = db.query(Media).filter(Media.id == media_id).first()
        assert m.resolution_tier == ResolutionEnum.HIGH

    def test_messaging_bot_low_thumbnail_plus_low_chunks_stays_low(self, client, db):
        """Smoke-verify mirror of messaging-bot/chunked_uploader.py —
        thumbnail and chunks both declare LOW; the row must end up LOW
        (not MEDIUM, which was the broken pre-fix behaviour)."""
        report_id = _seed_report(client)
        media_id = "m-msgbot-low"

        _post_thumbnail(client, report_id, media_id, tier="LOW")
        _post_chunk_bin(client, report_id, media_id, tier="LOW")

        m = db.query(Media).filter(Media.id == media_id).first()
        assert m.resolution_tier == ResolutionEnum.LOW
