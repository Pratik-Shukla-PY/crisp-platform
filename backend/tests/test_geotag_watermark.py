"""HC98 — server-side geotag embed: visible caption burn-in + GPS EXIF.

Two layers under test:

1. The pure service ``app.services.geotag_stamp`` — caption rendering (cv2
   Hershey), the tier gate, ASCII-safety for non-Latin building names, the
   decimal→DMS conversion, and GPS-EXIF round-trip via piexif. No DB, fully
   deterministic.

2. The blur-worker hook ``app.api.endpoints.reports._maybe_geotag_stamp`` —
   the integration glue that runs AFTER PII blur: it looks the report
   location up, archives a pristine ORIGINAL, burns the caption, writes GPS
   EXIF, ALWAYS re-uploads the stamped bytes (even on the clean path), and
   flips ``Media.watermark_applied``. These tests seed a Report+Location+Media
   in the test DB and call the hook directly against local storage.

Coverage matrix mirrors the plan's verification list:

| Invariant                                    | Where it's pinned                  |
|----------------------------------------------|------------------------------------|
| MEDIUM/ORIGINAL stamped, SMALL skipped       | tier-gate + hook skip-small        |
| caption band actually drawn (pixels change)  | stamp_image draws band             |
| GPS EXIF matches the report                  | write_gps_exif round-trip + hook   |
| null building/time lines omitted             | caption-lines omits null           |
| non-Latin building stripped (cv2 ASCII)      | ascii-safe strips unicode          |
| idempotent — 2nd run no-ops                  | hook idempotent when flag set      |
| clean archival retains un-stamped bytes      | hook archives pristine ORIGINAL    |
| flag off → no stamp                          | hook flag-off                      |
| no location → no stamp                       | hook skips when no location        |
| q95 (no dimension/quality regression)        | stamp preserves dims               |
"""
from __future__ import annotations

import cv2
import numpy as np
import pytest

from app.services import geotag_stamp

try:
    import piexif  # noqa: F401
    _HAVE_PIEXIF = geotag_stamp._PIEXIF_OK
except Exception:  # pragma: no cover
    _HAVE_PIEXIF = False


# ── helpers ─────────────────────────────────────────────────────────────────


def _solid_jpeg_path(tmp_path, w=800, h=600, color=(127, 127, 127), name="img.jpg"):
    """Write a uniform-colour JPEG so any drawn band is trivially detectable."""
    img = np.full((h, w, 3), color, dtype=np.uint8)
    p = str(tmp_path / name)
    cv2.imwrite(p, img, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    return p


def _read(p) -> bytes:
    with open(p, "rb") as f:
        return f.read()


def _norm_ref(v):
    """piexif returns ASCII GPS refs as bytes (b'N') — normalise to str."""
    return v.decode() if isinstance(v, (bytes, bytearray)) else v


# ── service: tier gate ───────────────────────────────────────────────────────


def test_watermark_tiers_gate():
    """MEDIUM/HIGH/ORIGINAL get the burn-in; SMALL (thumbnail) + legacy LOW do not."""
    assert "MEDIUM" in geotag_stamp.WATERMARK_TIERS
    assert "ORIGINAL" in geotag_stamp.WATERMARK_TIERS
    assert "HIGH" in geotag_stamp.WATERMARK_TIERS
    assert "SMALL" not in geotag_stamp.WATERMARK_TIERS
    assert "LOW" not in geotag_stamp.WATERMARK_TIERS


# ── service: caption rendering ───────────────────────────────────────────────


def test_stamp_image_draws_band(tmp_path):
    """A caption band is drawn bottom-left; the top of the image is untouched."""
    p = _solid_jpeg_path(tmp_path)
    before = cv2.imread(p)
    drew = geotag_stamp.stamp_image(p, lat=12.9716, lng=77.5946, accuracy_m=10)
    assert drew is True
    after = cv2.imread(p)
    assert after is not None and after.shape == before.shape
    h, w = after.shape[:2]
    # Bottom-left band region must have changed (darkened + text).
    band_before = before[h - 90:h - 10, 10:280]
    band_after = after[h - 90:h - 10, 10:280]
    assert not np.array_equal(band_before, band_after), "caption band was not drawn"
    # Top strip must be byte-for-byte identical (band is bottom-anchored).
    assert np.array_equal(before[0:80, :], after[0:80, :]), "top of image was modified"


def test_stamp_image_no_data_returns_false(tmp_path):
    """No coords + no building + no time → nothing to draw, file untouched."""
    p = _solid_jpeg_path(tmp_path)
    pre = _read(p)
    drew = geotag_stamp.stamp_image(p, lat=None, lng=None,
                                    accuracy_m=None, building=None, time_str=None)
    assert drew is False
    assert _read(p) == pre, "file must be byte-identical when nothing is drawn"


def test_stamp_preserves_dimensions_q95(tmp_path):
    """Re-encode must not resize and must stay a valid decodable JPEG (q95)."""
    p = _solid_jpeg_path(tmp_path, w=1024, h=768)
    geotag_stamp.stamp_image(p, lat=1.0, lng=2.0, building="X")
    img = cv2.imread(p)
    assert img is not None, "stamped output is not a valid JPEG"
    assert img.shape == (768, 1024, 3), "dimensions changed during stamping"


# ── service: caption-line construction ───────────────────────────────────────


def test_caption_lines_omits_null_building_and_time():
    lines = geotag_stamp._caption_lines(12.34, 56.78, None, None, None)
    assert len(lines) == 1
    assert lines[0].startswith("LAT/LNG")
    assert not any("BLDG" in ln for ln in lines)
    assert not any("TIME" in ln for ln in lines)


def test_caption_lines_includes_building_time_accuracy():
    lines = geotag_stamp._caption_lines(12.34, 56.78, 12.0, "Clinic A", "14:32 UTC")
    joined = "\n".join(lines)
    assert "LAT/LNG" in joined and "+/-12m" in joined
    assert "BLDG  Clinic A" in joined
    assert "TIME  14:32 UTC" in joined


def test_ascii_safe_strips_unicode_building():
    """cv2 Hershey can't render Arabic/CJK — the building line is dropped if
    nothing printable remains (coords/time always render)."""
    assert geotag_stamp._ascii_safe("مبنى") == ""
    assert geotag_stamp._ascii_safe("医院") == ""
    lines = geotag_stamp._caption_lines(1.0, 2.0, None, "مبنى", None)
    assert not any("BLDG" in ln for ln in lines), "unicode building must be omitted"
    # A mixed name keeps the ASCII part.
    assert geotag_stamp._ascii_safe("Clinic مبنى").startswith("Clinic")


def test_ascii_safe_truncates_long_name():
    out = geotag_stamp._ascii_safe("A" * 80, max_len=46)
    assert len(out) <= 46
    assert out.endswith("...")


# ── service: decimal → DMS + GPS EXIF round-trip ─────────────────────────────


def test_dms_rational_correctness():
    # 12.97° → 12°58'12.0"  (0.97*60 = 58.2′ → 58′ + 0.2*60 = 12.0″)
    assert geotag_stamp._dms_rational(12.97) == ((12, 1), (58, 1), (120000, 10000))
    # Sign is dropped (ref byte carries hemisphere) — abs value used.
    assert geotag_stamp._dms_rational(-12.97) == ((12, 1), (58, 1), (120000, 10000))


@pytest.mark.skipif(not _HAVE_PIEXIF, reason="piexif not installed")
def test_write_gps_exif_roundtrip_north_east(tmp_path):
    import piexif
    p = _solid_jpeg_path(tmp_path)
    assert geotag_stamp.write_gps_exif(p, 12.97, 77.59) is True
    gps = piexif.load(p)["GPS"]
    assert gps, "GPS IFD must be present after write"
    assert _norm_ref(gps[piexif.GPSIFD.GPSLatitudeRef]) == "N"
    assert _norm_ref(gps[piexif.GPSIFD.GPSLongitudeRef]) == "E"
    assert gps[piexif.GPSIFD.GPSLatitude][0] == (12, 1)
    assert gps[piexif.GPSIFD.GPSLongitude][0] == (77, 1)


@pytest.mark.skipif(not _HAVE_PIEXIF, reason="piexif not installed")
def test_write_gps_exif_south_west_refs(tmp_path):
    import piexif
    p = _solid_jpeg_path(tmp_path)
    assert geotag_stamp.write_gps_exif(p, -33.8688, -151.2093) is True
    gps = piexif.load(p)["GPS"]
    assert _norm_ref(gps[piexif.GPSIFD.GPSLatitudeRef]) == "S"
    assert _norm_ref(gps[piexif.GPSIFD.GPSLongitudeRef]) == "W"


@pytest.mark.skipif(not _HAVE_PIEXIF, reason="piexif not installed")
def test_embed_geotag_writes_caption_and_exif(tmp_path):
    import piexif
    p = _solid_jpeg_path(tmp_path)
    drew = geotag_stamp.embed_geotag(
        p, lat=12.97, lng=77.59, accuracy_m=8, building="Ward 3",
        time_str="09:15 UTC", write_exif=True)
    assert drew is True
    gps = piexif.load(p)["GPS"]
    assert gps and piexif.GPSIFD.GPSLatitude in gps


@pytest.mark.skipif(not _HAVE_PIEXIF, reason="piexif not installed")
def test_embed_geotag_no_exif_when_disabled(tmp_path):
    import piexif
    p = _solid_jpeg_path(tmp_path)
    drew = geotag_stamp.embed_geotag(
        p, lat=12.97, lng=77.59, building="Ward 3", write_exif=False)
    assert drew is True  # visible caption still drawn
    gps = piexif.load(p).get("GPS", {})
    assert not gps, "GPS EXIF must NOT be written when write_exif=False"


# ── integration: the blur-worker hook _maybe_geotag_stamp ────────────────────


class TestGeotagStampHook:
    """Drive the real hook against a seeded Report+Location+Media and local
    storage. The hook opens its own SessionLocal (bound to the same crisp_test
    DB via conftest's DATABASE_URL), so committed seed rows are visible."""

    def _mk_media(self, db, report_id, tier):
        from app.models.report import Media, MediaTypeEnum
        m = Media(
            report_id=report_id,
            type=MediaTypeEnum.IMAGE,
            resolution_tier=tier,
            url="",
            assembly_status="complete",
        )
        db.add(m)
        db.commit()
        return m.id

    def _enrich_report(self, db, report_id, *, building="Test Clinic", accuracy=12.0):
        from app.models.report import Report
        rep = db.query(Report).filter(Report.id == report_id).first()
        assert rep is not None and rep.location is not None
        rep.infrastructure_name = building
        rep.location.accuracy_meters = accuracy
        db.commit()

    def _reload_media(self, db, media_id):
        from app.models.report import Media
        db.expire_all()
        return db.query(Media).filter(Media.id == media_id).first()

    def test_hook_stamps_medium_and_sets_flag(self, db, sample_report, tmp_path):
        from app.api.endpoints.reports import _maybe_geotag_stamp
        from app.models.report import ResolutionEnum
        from app.services.storage import get_storage

        report_id = sample_report["id"]
        self._enrich_report(db, report_id)
        media_id = self._mk_media(db, report_id, ResolutionEnum.MEDIUM)

        fn = f"{media_id}_medium.jpg"
        tmp = _solid_jpeg_path(tmp_path, name=fn)
        pre = _read(tmp)

        _maybe_geotag_stamp(media_id, "unused-db-url", fn, tmp)

        post = _read(tmp)
        assert post != pre, "tmp file should be stamped in place"
        # Flag flipped (idempotency guard for future retries).
        assert self._reload_media(db, media_id).watermark_applied is True
        # The stamped bytes were re-uploaded (always — clean path included).
        assert get_storage().read(f"/static/{fn}") == post
        if _HAVE_PIEXIF:
            import piexif
            gps = piexif.load(tmp)["GPS"]
            assert gps, "GPS EXIF must be embedded by the hook"
            assert _norm_ref(gps[piexif.GPSIFD.GPSLatitudeRef]) == "N"  # 12.97 → N

    def test_hook_archives_pristine_original(self, db, sample_report, tmp_path):
        from app.api.endpoints.reports import _maybe_geotag_stamp
        from app.models.report import ResolutionEnum
        from app.services.storage import get_storage

        report_id = sample_report["id"]
        self._enrich_report(db, report_id)
        media_id = self._mk_media(db, report_id, ResolutionEnum.ORIGINAL)

        fn = f"{media_id}_original.jpg"
        tmp = _solid_jpeg_path(tmp_path, name=fn)
        pre = _read(tmp)

        _maybe_geotag_stamp(media_id, "unused", fn, tmp)

        post = _read(tmp)
        archived = get_storage().read_internal(f"archival/{media_id}")
        assert archived == pre, "archival must retain the pristine pre-stamp bytes"
        assert archived != post, "archival must differ from the stamped output"

    def test_hook_skips_small_tier(self, db, sample_report, tmp_path):
        from app.api.endpoints.reports import _maybe_geotag_stamp
        from app.models.report import ResolutionEnum

        report_id = sample_report["id"]
        self._enrich_report(db, report_id)
        media_id = self._mk_media(db, report_id, ResolutionEnum.SMALL)

        fn = f"{media_id}_small.jpg"
        tmp = _solid_jpeg_path(tmp_path, name=fn)
        pre = _read(tmp)

        _maybe_geotag_stamp(media_id, "unused", fn, tmp)

        assert _read(tmp) == pre, "SMALL thumbnail must NOT be stamped"
        assert self._reload_media(db, media_id).watermark_applied is False

    def test_hook_idempotent_when_already_applied(self, db, sample_report, tmp_path):
        from app.api.endpoints.reports import _maybe_geotag_stamp
        from app.models.report import Media, ResolutionEnum

        report_id = sample_report["id"]
        self._enrich_report(db, report_id)
        media_id = self._mk_media(db, report_id, ResolutionEnum.MEDIUM)
        db.query(Media).filter(Media.id == media_id).update(
            {"watermark_applied": True})
        db.commit()

        fn = f"{media_id}_idem.jpg"
        tmp = _solid_jpeg_path(tmp_path, name=fn)
        pre = _read(tmp)

        _maybe_geotag_stamp(media_id, "unused", fn, tmp)

        assert _read(tmp) == pre, "already-stamped media must be a no-op (no double-stamp)"

    def test_hook_flag_off_no_stamp(self, db, sample_report, tmp_path, monkeypatch):
        from app.core.config import settings
        from app.api.endpoints.reports import _maybe_geotag_stamp
        from app.models.report import ResolutionEnum

        monkeypatch.setattr(settings, "CRISP_GEOTAG_WATERMARK_ENABLED", False)

        report_id = sample_report["id"]
        self._enrich_report(db, report_id)
        media_id = self._mk_media(db, report_id, ResolutionEnum.MEDIUM)

        fn = f"{media_id}_off.jpg"
        tmp = _solid_jpeg_path(tmp_path, name=fn)
        pre = _read(tmp)

        _maybe_geotag_stamp(media_id, "unused", fn, tmp)

        assert _read(tmp) == pre, "flag off → no stamp"
        assert self._reload_media(db, media_id).watermark_applied is False

    def test_hook_skips_when_no_location(self, db, sample_report, tmp_path):
        from app.api.endpoints.reports import _maybe_geotag_stamp
        from app.models.report import Report, ResolutionEnum

        report_id = sample_report["id"]
        rep = db.query(Report).filter(Report.id == report_id).first()
        if rep.location is not None:
            db.delete(rep.location)
            db.commit()
        media_id = self._mk_media(db, report_id, ResolutionEnum.MEDIUM)

        fn = f"{media_id}_noloc.jpg"
        tmp = _solid_jpeg_path(tmp_path, name=fn)
        pre = _read(tmp)

        _maybe_geotag_stamp(media_id, "unused", fn, tmp)

        assert _read(tmp) == pre, "no location → nothing to embed"
        assert self._reload_media(db, media_id).watermark_applied is False
