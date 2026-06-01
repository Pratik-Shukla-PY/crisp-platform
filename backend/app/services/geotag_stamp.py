"""Server-side geotag embedding for incident photos (HC98).

Burns a compact, legible caption (lat/long + accuracy, building, capture time)
into the image pixels AND writes GPS EXIF, so the capture location travels with
every downloaded / exported / shared copy — not just the dashboard overlay.

Runs server-side inside the PII-blur worker AFTER blur (so the caption is never
blurred) and only on the MEDIUM/ORIGINAL tiers (SMALL is a thumbnail — text
would be illegible). The stored image is re-encoded at q95 (near-lossless) so we
don't regress capture quality; a pristine un-stamped original is archived
separately by the caller.

Rendering uses **cv2** (Hershey font) so there is NO font-file dependency — it
works in the headless Docker image with zero extra assets. Limitation: cv2's
Hershey fonts are ASCII-only, so a non-Latin building name (Arabic / CJK) can't
be drawn — `_ascii_safe` strips it and the building line is omitted if nothing
printable remains. Coordinates + accuracy + time are always ASCII and always
render. (A future upgrade to PIL + a bundled Noto font would render full
Unicode building names — deferred.)

GPS EXIF is written via **piexif** AFTER the cv2 re-encode (cv2.imwrite emits a
fresh JPEG with no EXIF, so the GPS IFD must be inserted last).
"""
import logging

import cv2
import numpy as np

logger = logging.getLogger(__name__)

try:
    import piexif
    _PIEXIF_OK = True
except Exception as _e:  # pragma: no cover - import guard
    piexif = None
    _PIEXIF_OK = False
    logger.warning("piexif unavailable — GPS EXIF embedding disabled: %s", _e)

# Tiers that receive the visible burn-in. SMALL is a preview thumbnail; a legible
# caption would dominate it, so it's skipped (it still gets GPS EXIF if enabled).
WATERMARK_TIERS = {"MEDIUM", "HIGH", "ORIGINAL"}

_JPEG_QUALITY = 95  # near-lossless — must NOT regress the capture quality fix


def _ascii_safe(s, max_len=46):
    """Keep printable ASCII (cv2 Hershey can't render Unicode); trim long names."""
    if not s:
        return ""
    out = "".join(ch for ch in str(s) if 32 <= ord(ch) < 127).strip()
    if len(out) > max_len:
        # Reserve the 3 ellipsis chars INSIDE the budget so max_len is a true cap.
        out = out[: max_len - 3].rstrip() + "..."
    return out


def _caption_lines(lat, lng, accuracy_m, building, time_str):
    lines = []
    if lat is not None and lng is not None:
        try:
            coord = "LAT/LNG  {:.5f}, {:.5f}".format(float(lat), float(lng))
            if accuracy_m is not None and np.isfinite(float(accuracy_m)):
                coord += "   +/-{}m".format(int(round(float(accuracy_m))))
            lines.append(coord)
        except (TypeError, ValueError):
            pass
    b = _ascii_safe(building)
    if b:
        lines.append("BLDG  " + b)
    ts = _ascii_safe(time_str, max_len=40)
    if ts:
        lines.append("TIME  " + ts)
    return lines


def stamp_image(path, lat=None, lng=None, accuracy_m=None, building=None, time_str=None):
    """Burn a geotag caption band onto the JPEG at ``path`` in place (q95).

    Returns True if a caption was drawn, False otherwise (unreadable image or no
    data to show). Never raises — geotagging is best-effort, never blocks the
    upload.
    """
    try:
        lines = _caption_lines(lat, lng, accuracy_m, building, time_str)
        if not lines:
            return False
        img = cv2.imread(path)
        if img is None:
            logger.warning("geotag_stamp: cv2 could not read %s", path)
            return False
        h, w = img.shape[:2]
        # Scale to image width so MEDIUM (~800px) and ORIGINAL (~3000px) both read.
        scale = max(0.5, min(2.4, w / 1100.0))
        thickness = max(1, int(round(scale * 1.6)))
        font = cv2.FONT_HERSHEY_SIMPLEX
        pad = int(round(10 * scale))
        gap = int(round(8 * scale))
        sizes = [cv2.getTextSize(t, font, scale, thickness)[0] for t in lines]
        text_w = max(s[0] for s in sizes)
        line_h = max(s[1] for s in sizes)
        band_w = min(w, text_w + 2 * pad)
        band_h = len(lines) * line_h + (len(lines) - 1) * gap + 2 * pad
        margin = int(round(12 * scale))
        x0 = margin
        y1 = h - margin
        y0 = max(0, y1 - band_h)
        x1 = min(w, x0 + band_w)
        # Semi-transparent dark band for contrast over any photo.
        overlay = img.copy()
        cv2.rectangle(overlay, (x0, y0), (x1, y1), (0, 0, 0), -1)
        cv2.addWeighted(overlay, 0.45, img, 0.55, 0, img)
        # White text with a thin dark outline so it reads over bright + dark areas.
        ty = y0 + pad + line_h
        for t in lines:
            org = (x0 + pad, ty)
            cv2.putText(img, t, org, font, scale, (0, 0, 0), thickness + 2, cv2.LINE_AA)
            cv2.putText(img, t, org, font, scale, (255, 255, 255), thickness, cv2.LINE_AA)
            ty += line_h + gap
        cv2.imwrite(path, img, [int(cv2.IMWRITE_JPEG_QUALITY), _JPEG_QUALITY])
        return True
    except Exception as e:  # never block the pipeline on a cosmetic stamp
        logger.warning("geotag_stamp: stamp failed for %s: %s", path, e)
        return False


def _dms_rational(dec):
    """Decimal degrees -> EXIF (deg, min, sec) rationals."""
    dec = abs(float(dec))
    d = int(dec)
    m_full = (dec - d) * 60
    m = int(m_full)
    s = int(round((m_full - m) * 60 * 10000))
    return ((d, 1), (m, 1), (s, 10000))


def write_gps_exif(jpeg_path, lat, lng):
    """Insert a GPS IFD (lat/long) into the JPEG at ``jpeg_path``. Best-effort.

    MUST run AFTER ``stamp_image`` (cv2.imwrite emits EXIF-less JPEG)."""
    if not _PIEXIF_OK or lat is None or lng is None:
        return False
    try:
        lat = float(lat)
        lng = float(lng)
        gps = {
            piexif.GPSIFD.GPSVersionID: (2, 0, 0, 0),
            piexif.GPSIFD.GPSLatitudeRef: "N" if lat >= 0 else "S",
            piexif.GPSIFD.GPSLatitude: _dms_rational(lat),
            piexif.GPSIFD.GPSLongitudeRef: "E" if lng >= 0 else "W",
            piexif.GPSIFD.GPSLongitude: _dms_rational(lng),
        }
        try:
            exif_dict = piexif.load(jpeg_path)
        except Exception:
            exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}, "thumbnail": None}
        exif_dict["GPS"] = gps
        piexif.insert(piexif.dump(exif_dict), jpeg_path)
        return True
    except Exception as e:
        logger.warning("geotag_stamp: GPS EXIF write failed for %s: %s", jpeg_path, e)
        return False


def embed_geotag(path, *, lat, lng, accuracy_m=None, building=None,
                 time_str=None, write_exif=True):
    """Burn the visible caption + (optionally) GPS EXIF into ``path``, in place.

    Returns True if the visible caption was drawn. EXIF is written after the
    cv2 re-encode so it survives. Coordinates come from the report's Location
    (not image EXIF), so they're correct regardless of source orientation.
    """
    stamped = stamp_image(
        path, lat=lat, lng=lng, accuracy_m=accuracy_m,
        building=building, time_str=time_str,
    )
    if write_exif:
        write_gps_exif(path, lat, lng)
    return stamped
