"""
Phase A.2 (May 2026, satellite-verification rebuild) — verify endpoint
must load the user photo via the storage abstraction so MEDIA_BACKEND=s3
deployments still get ground-truth corroboration.

Background — the previous implementation hard-coded
`os.path.join(UPLOAD_DIR, img_media.url.replace("/static/", ""))` in
`verify_report` (around line 3444). That works for `/static/abc.jpg`
(LocalStorage) but FAILS for `s3://abc.jpg` (S3Storage) — the resulting
path is nonsensical, `os.path.exists` returns False, `user_image_path`
stays None, and Claude scores the satellite + text only with NO ground-
truth photo. Damage scores were silently unreliable on S3 PROD.

Fix — `verify_report` now calls `_get_media_storage().read(img_media.url)`
and writes the bytes to a temp file. Both backends supply photo bytes
the same way; the temp file is cleaned up after Claude returns.

Tested by stubbing `truth_scorer.score` and `satellite_fetcher.fetch`
so we don't need a real Anthropic API key or a real Sentinel scene.
"""
from __future__ import annotations

import base64
import os
import uuid
from unittest.mock import patch, AsyncMock
import pytest

from app.models.report import Media, MediaTypeEnum, ResolutionEnum
from tests.conftest import auth_header   # POST /verify now requires analyst+ auth (Phase-4 RBAC)


def _create_report_with_photo(client, db) -> tuple[str, str, bytes]:
    """Create a report via API + attach an IMAGE media row whose bytes
    live on disk (LocalStorage) so storage.read() can find them."""
    res = client.post("/api/v1/reports/meta", json={
        "device_hash": f"TEST-VERIFY-{uuid.uuid4().hex[:8]}",
        "client_report_id": f"verify-{uuid.uuid4().hex[:12]}",
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "description": "verify-endpoint test",
        "expected_media": 1,
        "location": {"latitude": 12.97, "longitude": 77.59},
    })
    assert res.status_code == 201, res.text
    rid = res.json()["id"]

    # Tiny valid JPEG bytes (1×1 pixel JFIF) — enough for storage.read().
    jpeg_bytes = bytes.fromhex(
        "ffd8ffe000104a46494600010101006000600000ffdb004300080606070605"
        "08070707090908090b0a0a0b0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"
        "0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0cffc00011080001000103012200021101031101ffd9"
    )

    # Write the bytes via the storage abstraction so the URL the Media
    # row gets matches what storage.read() will resolve.
    from app.api.endpoints.reports import _get_media_storage
    fname = f"verify-test-{uuid.uuid4().hex[:8]}.jpg"
    db_url = _get_media_storage().save(fname, jpeg_bytes, "image/jpeg")

    m_id = f"m-{uuid.uuid4().hex[:8]}"
    db.add(Media(
        id=m_id,
        report_id=rid,
        type=MediaTypeEnum.IMAGE,
        resolution_tier=ResolutionEnum.MEDIUM,
        url=db_url,
        is_synced=True,
        assembly_status="complete",
        completion_pct=100.0,
    ))
    db.commit()
    return rid, db_url, jpeg_bytes


# Fake satellite_fetcher response — minimum shape verify_report consumes.
def _fake_sat_data() -> dict:
    fake_png = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64
    fake_b64 = base64.b64encode(fake_png).decode()
    return {
        "image_b64": fake_b64,
        "image_media_type": "image/png",
        "source": "AWS Sentinel-2",
        "acquisition_date": "2026-05-08T00:00:00Z",
        "cloud_cover_pct": 12.0,
        "resolution_m": 10.0,
        "lat": 12.97,
        "lon": 77.59,
        "days_gap": 2,
        "images": [
            {
                "image_b64": fake_b64,
                "image_media_type": "image/png",
                "source": "AWS Sentinel-2",
                "acquisition_date": "2026-05-08T00:00:00Z",
                "cloud_cover_pct": 12.0,
                "resolution_m": 10.0,
            }
        ],
        "alt": None,
    }


def _fake_score_result() -> dict:
    return {
        "scores": {
            "location_authenticity": 22,
            "damage_corroboration": 18,
            "description_coherence": 21,
            "data_quality": 17,
            "total": 78,
        },
        "verdict": "LIKELY_AUTHENTIC",
        "reasoning": "test reasoning",
        "key_findings": ["finding-1"],
        "caveats": ["caveat-1"],
        "satellite_scene_description": "test scene",
        "photo_analysis": "test photo",
        "satellite_data": {
            "source": "AWS Sentinel-2",
            "acquisition_date": "2026-05-08T00:00:00Z",
            "cloud_cover_pct": 12.0,
            "days_gap": 2,
        },
    }


class TestVerifyEndpointUserPhoto:
    """Verify endpoint must materialise the user photo from any backend."""

    @pytest.mark.asyncio
    async def test_user_image_path_is_set_when_storage_can_read(
        self, client, db, admin_token
    ):
        """The fix: storage.read() loads bytes from local OR S3, then a
        temp file is created and passed to truth_scorer. Verifies that
        Claude actually receives a non-None user_image_path."""
        rid, _, jpeg_bytes = _create_report_with_photo(client, db)

        captured: dict = {}

        async def _capture_score(**kwargs):
            captured.update(kwargs)
            return _fake_score_result()

        with patch(
            "app.services.truth_scorer.truth_scorer.score",
            new=AsyncMock(side_effect=_capture_score),
        ), patch(
            "app.services.satellite_fetcher.satellite_fetcher.fetch",
            new=AsyncMock(return_value=_fake_sat_data()),
        ):
            res = client.post(f"/api/v1/reports/{rid}/verify", headers=auth_header(admin_token))
            assert res.status_code == 200, res.text

        # The fix: user_image_path was set, the file existed at the
        # moment truth_scorer was called, and the bytes match.
        assert captured.get("user_image_path") is not None, (
            "BUG REGRESSION: verify_report passed user_image_path=None "
            "even though the Media row had a readable URL. Claude would "
            "score satellite + text only — damage_corroboration scores "
            "are silently unreliable. See test docstring for context."
        )

    @pytest.mark.asyncio
    async def test_temp_file_is_cleaned_up_after_scoring(self, client, db, admin_token):
        """Temp files in /tmp would accumulate on every verify call.
        After scoring (success OR failure), the temp file must be gone."""
        rid, _, _ = _create_report_with_photo(client, db)

        captured_paths: list[str] = []

        async def _capture_score(**kwargs):
            p = kwargs.get("user_image_path")
            if p:
                captured_paths.append(p)
            return _fake_score_result()

        with patch(
            "app.services.truth_scorer.truth_scorer.score",
            new=AsyncMock(side_effect=_capture_score),
        ), patch(
            "app.services.satellite_fetcher.satellite_fetcher.fetch",
            new=AsyncMock(return_value=_fake_sat_data()),
        ):
            res = client.post(f"/api/v1/reports/{rid}/verify", headers=auth_header(admin_token))
            assert res.status_code == 200, res.text

        assert len(captured_paths) == 1
        # File existed during scoring, gone after.
        assert not os.path.exists(captured_paths[0]), (
            f"Temp file leaked: {captured_paths[0]} — verify_report's "
            f"finally-block cleanup must remove the temp file"
        )

    @pytest.mark.asyncio
    async def test_temp_file_cleaned_up_on_score_failure(self, client, db, admin_token):
        """Even when truth_scorer raises (Anthropic API down, rate-limited
        etc.), the temp file must NOT leak."""
        rid, _, _ = _create_report_with_photo(client, db)

        captured_paths: list[str] = []

        async def _failing_score(**kwargs):
            p = kwargs.get("user_image_path")
            if p:
                captured_paths.append(p)
            raise RuntimeError("simulated Claude API outage")

        with patch(
            "app.services.truth_scorer.truth_scorer.score",
            new=AsyncMock(side_effect=_failing_score),
        ), patch(
            "app.services.satellite_fetcher.satellite_fetcher.fetch",
            new=AsyncMock(return_value=_fake_sat_data()),
        ):
            # TestClient re-raises server exceptions by default. The
            # cleanup invariant we care about runs in `finally:` BEFORE
            # the exception propagates, so we wrap in pytest.raises.
            with pytest.raises(RuntimeError, match="simulated"):
                client.post(f"/api/v1/reports/{rid}/verify", headers=auth_header(admin_token))

        # File should have been captured (we got past the temp-file
        # creation) AND removed by the finally block.
        assert len(captured_paths) == 1, (
            "user_image_path was never captured — the storage.read() path "
            "didn't run. Check the verify_report fixture setup."
        )
        assert not os.path.exists(captured_paths[0]), (
            f"Temp file leaked on failure: {captured_paths[0]}"
        )

    @pytest.mark.asyncio
    async def test_missing_user_photo_does_not_block_verification(
        self, client, db, admin_token
    ):
        """If the report has no IMAGE media (audio-only report), the
        verify endpoint should still run, with user_image_path=None.
        Claude then scores satellite + text only (data_quality reflects
        the missing photo via has_photo input)."""
        # Create a report with NO media.
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": f"TEST-NOPHOTO-{uuid.uuid4().hex[:8]}",
            "client_report_id": f"nophoto-{uuid.uuid4().hex[:12]}",
            "source": "APP",
            "severity": "MODERATE",
            "infrastructure_type": "ROAD",
            "description": "no photo report",
            "expected_media": 0,
            "location": {"latitude": 12.97, "longitude": 77.59},
        })
        assert res.status_code == 201, res.text
        rid = res.json()["id"]

        captured: dict = {}

        async def _capture_score(**kwargs):
            captured.update(kwargs)
            return _fake_score_result()

        with patch(
            "app.services.truth_scorer.truth_scorer.score",
            new=AsyncMock(side_effect=_capture_score),
        ), patch(
            "app.services.satellite_fetcher.satellite_fetcher.fetch",
            new=AsyncMock(return_value=_fake_sat_data()),
        ):
            res = client.post(f"/api/v1/reports/{rid}/verify", headers=auth_header(admin_token))
            assert res.status_code == 200, res.text

        # No photo → user_image_path stays None.
        assert captured.get("user_image_path") is None
