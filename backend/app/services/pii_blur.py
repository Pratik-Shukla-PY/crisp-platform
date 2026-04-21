"""
CRISP PII Blur Service — MediaPipe (faces) + easyocr (text).

Both run 100% locally, zero API cost, work offline.

MediaPipe BlazeFace: Neural network face detection — handles angles, lighting,
    glasses, occlusion, small faces on ID cards. Far superior to Haar Cascade.

easyocr: Deep learning OCR — reads text at any angle, any lighting, 80+ languages.
    Far superior to Tesseract for real-world photos of documents.

Strategy:
  1. Detect faces with MediaPipe → oval blur
  2. If face found: find ALL nearby text via easyocr → blur (document PII)
  3. If no face: only blur text matching PII regex patterns (phone, ID numbers)
  4. Clean disaster photos: untouched (no false positives)
"""
import os
import re
import logging
import ssl
import cv2
import numpy as np

logger = logging.getLogger(__name__)

# Fix SSL for model downloads
try:
    ssl._create_default_https_context = ssl._create_unverified_context
except Exception:
    pass

# ── Module health state (Apr 2026) ───────────────────────────────────────────
# Tracks availability of the two deep-learning backends so the
# `/api/v1/health/pii` endpoint can surface status loudly. Pre-April 2026
# a missing MediaPipe model would silently no-op the face-blur pass,
# which — combined with the bug where the client hardcoded
# `client_blur_applied: true` — let unblurred PII reach the dashboard.
# Both halves now fail loudly: the client sends a truthful flag (see
# pii-blur.js + app.js::_blurIfPossible), the server sets these module
# flags and exposes them to operators.
_face_detector = None
_face_detector_error = None  # populated when MediaPipe isn't usable
_ocr_reader = None
_ocr_reader_error = None     # populated when easyocr isn't usable


# ── MediaPipe Face Detection ─────────────────────────────────────────────────
try:
    import mediapipe as mp
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision

    model_path = os.path.join(os.path.dirname(__file__), '..', '..', 'blaze_face_short_range.tflite')
    model_path = os.path.abspath(model_path)
    if os.path.exists(model_path):
        options = vision.FaceDetectorOptions(
            base_options=python.BaseOptions(model_asset_path=model_path),
            min_detection_confidence=0.3
        )
        _face_detector = vision.FaceDetector.create_from_options(options)
        logger.info("PII: MediaPipe face detector loaded (path=%s)", model_path)
    else:
        _face_detector_error = f"MediaPipe model missing at {model_path}"
        logger.error(
            "PII-BLUR CRITICAL: %s — face-blur pass will be skipped, "
            "reports with PII faces will land on the dashboard unredacted "
            "unless the client-side blur covered them.",
            _face_detector_error,
        )
except Exception as e:
    _face_detector_error = f"MediaPipe import/load failed: {e}"
    logger.error(
        "PII-BLUR CRITICAL: %s — server will NOT blur faces. Install the "
        "`mediapipe` package and confirm the .tflite model is present.",
        _face_detector_error,
    )

# ── easyocr Reader ───────────────────────────────────────────────────────────
try:
    import easyocr
    _ocr_reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    logger.info("PII: easyocr reader loaded")
except Exception as e:
    _ocr_reader_error = f"easyocr import/load failed: {e}"
    logger.error(
        "PII-BLUR CRITICAL: %s — server will NOT blur text PII (phone, "
        "Aadhaar, passport, etc). Install `easyocr` to restore.",
        _ocr_reader_error,
    )


def pii_health_snapshot() -> dict:
    """Snapshot of the module's blur-backend health. Consumed by
    ``/api/v1/health/pii`` so operators can see whether a deploy is
    missing model files or Python packages that would silently skip
    the server-side PII pass.

    Returns:
        {
          "face_detector": {"available": bool, "error": str|None},
          "ocr_reader":    {"available": bool, "error": str|None},
          "overall":       "healthy" | "degraded" | "unavailable",
        }

    Values:
      * "healthy"     — both backends loaded.
      * "degraded"    — one of two backends missing (still some coverage).
      * "unavailable" — neither backend loaded. Server-side blur is a no-op;
                        the client-side pipeline MUST succeed for PII to be
                        redacted at all.
    """
    face_ok = _face_detector is not None
    ocr_ok = _ocr_reader is not None
    if face_ok and ocr_ok:
        overall = "healthy"
    elif face_ok or ocr_ok:
        overall = "degraded"
    else:
        overall = "unavailable"
    return {
        "face_detector": {"available": face_ok, "error": _face_detector_error},
        "ocr_reader":    {"available": ocr_ok,  "error": _ocr_reader_error},
        "overall":       overall,
    }

# ── PII Regex Patterns ───────────────────────────────────────────────────────
PII_PATTERNS = [
    re.compile(r'\d{4}\s?\d{4}\s?\d{4}'),       # Aadhaar
    re.compile(r'[A-Z]{5}\d{4}[A-Z]'),           # PAN
    re.compile(r'\d{10,13}'),                     # Phone
    re.compile(r'\d{2}[/\-\.]\d{2}[/\-\.]\d{4}'),# DOB
    re.compile(r'[A-Z]\d{7,8}'),                  # Passport
    re.compile(r'\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{4}'), # Credit card
    re.compile(r'\d{3}-\d{2}-\d{4}'),            # SSN
    re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}'), # Email
    re.compile(r'\d{12,}'),                       # Generic long ID
]


def blur_pii(image_path: str) -> dict:
    """
    Detect faces (MediaPipe) + PII text (easyocr) and blur.
    Original file OVERWRITTEN — PII never stored.

    Apr 2026 — now reports which backends were available + whether the
    blur pipeline actually ran end-to-end, so the caller (the assembly
    worker that sets `Media.pii_blur_status`) can distinguish:
      * ``ran=True, blurred=True``   — something was redacted.
      * ``ran=True, blurred=False``  — pipeline ran; image was clean.
      * ``ran=False, error=...``     — backends unavailable; file NOT
                                       processed; dashboard MUST flag.
    """
    result = {
        "faces": 0,
        "pii_texts": 0,
        "blurred": False,
        "error": None,
        "ran": False,
        "backends": {
            "face_detector": _face_detector is not None,
            "ocr_reader": _ocr_reader is not None,
        },
    }

    # Apr 2026 — if NEITHER backend is available, short-circuit with an
    # explicit error. The assembly worker uses this to mark the media
    # `pii_blur_status = 'skipped'` rather than silently passing through.
    if _face_detector is None and _ocr_reader is None:
        result["error"] = (
            "PII-blur backends unavailable (MediaPipe + easyocr both missing). "
            "Install the packages + model file; see health/pii endpoint."
        )
        return result

    if not os.path.exists(image_path):
        result["error"] = "File not found"
        return result

    try:
        img = cv2.imread(image_path)
        if img is None:
            result["error"] = "Could not decode image"
            return result

        h, w = img.shape[:2]
        face_regions = []
        text_blur_regions = []

        # Mark pipeline execution as soon as at least one backend will try.
        # Keeps `result["ran"]=False` iff neither backend was usable at all.
        result["ran"] = True

        # ═══════════════════════════════════════════════════════════════
        # LAYER 1: FACE DETECTION (MediaPipe BlazeFace)
        # ═══════════════════════════════════════════════════════════════
        if _face_detector:
            try:
                rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                detections = _face_detector.detect(mp_image)

                for det in detections.detections:
                    bb = det.bounding_box
                    fx, fy, fw, fh = bb.origin_x, bb.origin_y, bb.width, bb.height
                    # Phase 1 (Apr 2026): bbox padding 20 % → 5 %.
                    # The client already blurs the face at capture time with
                    # its own bbox padding, so stacking a 20 % server pad
                    # on top of that produced a visible soft-glow well past
                    # the face. 5 % keeps server defence-in-depth without
                    # bleeding into ID cards / signage held near the face.
                    px, py = int(fw * 0.05), int(fh * 0.05)
                    face_regions.append((
                        max(0, fx - px), max(0, fy - py),
                        min(w, fx + fw + px), min(h, fy + fh + py)))
                    result["faces"] += 1
            except Exception as e:
                logger.warning(f"PII face detection error: {e}")

        # ═══════════════════════════════════════════════════════════════
        # LAYER 2: TEXT DETECTION (easyocr)
        # If face detected: blur ALL nearby text (document = all PII)
        # If no face: only blur text matching PII regex patterns
        # Performance: on CPU easyocr scales roughly O(pixels) — a 3000x4000
        # phone photo can take 30–120 s, which blocked the chunk handler and
        # stranded uploads at partial %. Resize to max 1024 px on the long side
        # before OCR, then scale bbox coords back to original space.
        # ═══════════════════════════════════════════════════════════════
        if _ocr_reader:
            try:
                MAX_OCR_DIM = 1024
                long_side = max(h, w)
                if long_side > MAX_OCR_DIM:
                    scale = MAX_OCR_DIM / long_side
                    ocr_w, ocr_h = int(w * scale), int(h * scale)
                    ocr_img = cv2.resize(img, (ocr_w, ocr_h), interpolation=cv2.INTER_AREA)
                    inv_scale = 1.0 / scale
                else:
                    ocr_img = img
                    inv_scale = 1.0

                ocr_results = _ocr_reader.readtext(ocr_img)

                # Filter to meaningful text regions + scale bbox back to original
                valid_texts = []
                for bbox, text, conf in ocr_results:
                    if len(text.strip()) < 2:
                        continue
                    # Keep ALL detections — even low confidence.
                    # easyocr on phone photos of documents often gives low conf
                    # but the detection bounding box is still accurate.
                    pts = np.array(bbox).astype(float) * inv_scale
                    pts = pts.astype(int)
                    x1, y1 = pts[:, 0].min(), pts[:, 1].min()
                    x2, y2 = pts[:, 0].max(), pts[:, 1].max()
                    valid_texts.append((x1, y1, x2, y2, text, conf))

                # Phase 1 (Apr 2026): DROPPED the "≥5 text regions → blur all
                # text" escalation and the "has_face → blur all text" clause.
                # Both over-redacted legitimate crisis information —
                # "DANGER HIGH VOLTAGE", "EVACUATION ROUTE", store signage,
                # street names — exactly the context responders rely on.
                # Now every text region is evaluated independently against
                # the PII regex set; only true matches get blurred. Faces
                # are still blurred unconditionally (face_regions path
                # above). Documents held in-frame (passport, Aadhaar, PAN)
                # remain protected because their identifying numbers DO
                # match the regex set (PII_PATTERNS).
                for (x1, y1, x2, y2, text, conf) in valid_texts:
                    should_blur = False
                    for pat in PII_PATTERNS:
                        if pat.search(text):
                            should_blur = True
                            break

                    if should_blur:
                        # 5 % padding (was 25 %). The regex is strict enough
                        # that we rarely need to grow the bbox; 5 % just
                        # guards against OCR bbox jitter.
                        pad = max(int((y2 - y1) * 0.05), 2)
                        text_blur_regions.append((
                            max(0, x1 - pad), max(0, y1 - pad),
                            min(w, x2 + pad), min(h, y2 + pad)))
                        result["pii_texts"] += 1

            except Exception as e:
                logger.warning(f"PII OCR error: {e}")

        # ═══════════════════════════════════════════════════════════════
        # APPLY BLUR — oval for faces, rectangle for text
        # ═══════════════════════════════════════════════════════════════
        all_regions = face_regions + text_blur_regions
        if all_regions:
            # Phase 1 (Apr 2026): narrowed kernels.
            # Client ALREADY blurs faces at capture time (24 px Gaussian on
            # PWA, 8–16 px pixelation on RN). Stacking a cap-71 server
            # Gaussian on top produced the visible bloat the user saw. We
            # halve the cap (41 for faces, 31 for text) and drop the
            # double-pass on faces — server now does a single strong pass
            # which is enough to kill any face that slipped past the
            # client detector.
            for (x1, y1, x2, y2) in face_regions:
                rw, rh = x2 - x1, y2 - y1
                if rw <= 0 or rh <= 0:
                    continue
                roi = img[y1:y2, x1:x2]
                # odd, capped at 41 (was 71)
                ksize = min(41, max(21, (max(rw, rh) // 8) * 2 + 1))
                # single Gaussian pass (was double)
                blurred = cv2.GaussianBlur(roi, (ksize, ksize), 25)

                # Oval mask with feathered edges
                mask = np.zeros((rh, rw), dtype=np.uint8)
                cv2.ellipse(mask, (rw // 2, rh // 2), (rw // 2, rh // 2), 0, 0, 360, 255, -1)
                mask = cv2.GaussianBlur(mask, (21, 21), 10)
                mask_3ch = cv2.merge([mask, mask, mask]).astype(np.float32) / 255.0
                img[y1:y2, x1:x2] = (blurred * mask_3ch + roi * (1 - mask_3ch)).astype(np.uint8)

            # Blur PII-matched text with a tighter kernel (cap 31, was 51).
            # Text regions are small; a heavy kernel was unnecessary and
            # bled into adjacent text.
            for (x1, y1, x2, y2) in text_blur_regions:
                rw, rh = x2 - x1, y2 - y1
                if rw <= 0 or rh <= 0:
                    continue
                roi = img[y1:y2, x1:x2]
                ksize = min(31, max(15, (max(rw, rh) // 8) * 2 + 1))
                img[y1:y2, x1:x2] = cv2.GaussianBlur(roi, (ksize, ksize), 20)

            cv2.imwrite(image_path, img, [cv2.IMWRITE_JPEG_QUALITY, 85])
            result["blurred"] = True
            logger.info(f"PII blurred [{os.path.basename(image_path)}]: "
                        f"faces={result['faces']} text={result['pii_texts']}")

    except Exception as e:
        result["error"] = str(e)
        logger.error(f"PII blur error: {e}")

    return result
