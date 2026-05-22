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

# ── Module health state ───────────────────────────────────────────
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
        # P1 multi-face fix (May 2026, operator-reported): BlazeFace
        # internally resizes input to ~128×128 — high-res photos with
        # distant / multiple faces get downscaled so much that small
        # faces fall below detection threshold. Mitigated by:
        #   1. Lower confidence threshold 0.3 → 0.2 (more permissive)
        #   2. Multi-scale tiled detection in blur_pii() — see below.
        options = vision.FaceDetectorOptions(
            base_options=python.BaseOptions(model_asset_path=model_path),
            min_detection_confidence=0.2
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

# ── P1 multi-face detection helpers ──────────────────────────────────────────


def _multiscale_face_detect(img, detector, mp_module):
    """Run BlazeFace at multiple scales + return all detections in
    ORIGINAL-image (x, y, w, h) coordinates.

    The full-image pass catches large/close faces. The 4 tile passes
    crop overlapping halves of the image so faces in any quadrant
    appear at relatively larger size to BlazeFace's small input,
    catching distant / group faces.

    Tile layout (60% × 60% each, 20% overlap with the centre):
       ┌──────────┬──────────┐
       │  tile 1  │  tile 2  │   tile 1: x=0..60%, y=0..60%
       │ (top-L)  │ (top-R)  │   tile 2: x=40..100%, y=0..60%
       ├──────────┼──────────┤   tile 3: x=0..60%, y=40..100%
       │  tile 3  │  tile 4  │   tile 4: x=40..100%, y=40..100%
       │ (bot-L)  │ (bot-R)  │   (centre region covered 4× — high
       └──────────┴──────────┘    recall for faces in middle)

    Returns: list of (fx, fy, fw, fh) tuples — duplicates expected;
    caller dedupes via NMS.
    """
    import cv2 as _cv2
    h, w = img.shape[:2]
    detections_xywh = []

    def _detect_on_region(region_img, x_offset, y_offset):
        rgb = _cv2.cvtColor(region_img, _cv2.COLOR_BGR2RGB)
        mp_image = mp_module.Image(
            image_format=mp_module.ImageFormat.SRGB, data=rgb,
        )
        dets = detector.detect(mp_image)
        for det in dets.detections:
            bb = det.bounding_box
            detections_xywh.append((
                bb.origin_x + x_offset,
                bb.origin_y + y_offset,
                bb.width,
                bb.height,
            ))

    # Pass 1 — full image
    _detect_on_region(img, 0, 0)

    # Passes 2..5 — 4 overlapping tiles at 60%×60% of the image.
    # Tile boundaries deliberately overlap by 20% so a face spanning
    # the centre isn't split.
    tile_w = int(w * 0.6)
    tile_h = int(h * 0.6)
    for x_off, y_off in [
        (0, 0),
        (w - tile_w, 0),
        (0, h - tile_h),
        (w - tile_w, h - tile_h),
    ]:
        # Skip degenerate tiles (image already smaller than 60%
        # threshold — Pass 1 already covered it).
        if tile_w >= w and tile_h >= h:
            break
        tile_img = img[y_off:y_off + tile_h, x_off:x_off + tile_w]
        if tile_img.size == 0:
            continue
        _detect_on_region(tile_img, x_off, y_off)

    return detections_xywh


def _nms_merge_faces(detections, iou_threshold=0.4, keep="smallest"):
    """Non-max suppression on face bounding boxes. Multi-scale passes
    produce duplicate detections for the same face (one per scale that
    saw it); collapse to a single bbox per face.

    keep:
      "smallest" (default, May 2026 operator review) — within each
          cluster of overlapping detections, keep the SMALLEST bbox.
          Gives a tighter fit to the actual face — blur stays
          localized. Larger duplicates from tile passes often include
          skin / clothing / background adjacent to the face.
      "largest" — keep the largest. Generous coverage, but blur
          ellipse can extend onto neck / shoulders / hair.

    Returns: deduped list of (fx, fy, fw, fh).
    """
    if not detections:
        return []

    # Convert (x, y, w, h) → (x1, y1, x2, y2) for IoU math.
    boxes = [(x, y, x + w, y + h) for (x, y, w, h) in detections]
    # Sort order depends on `keep` strategy. We always iterate
    # high-priority first + suppress lower-priority overlaps; the
    # priority for "smallest" is reverse of "largest".
    order = sorted(range(len(boxes)),
                   key=lambda i: (boxes[i][2] - boxes[i][0]) * (boxes[i][3] - boxes[i][1]),
                   reverse=(keep == "largest"))

    keep = []
    suppressed = set()
    for i in order:
        if i in suppressed:
            continue
        keep.append(i)
        x1i, y1i, x2i, y2i = boxes[i]
        for j in order:
            if j == i or j in suppressed:
                continue
            x1j, y1j, x2j, y2j = boxes[j]
            # IoU
            inter_x1 = max(x1i, x1j)
            inter_y1 = max(y1i, y1j)
            inter_x2 = min(x2i, x2j)
            inter_y2 = min(y2i, y2j)
            inter_w = max(0, inter_x2 - inter_x1)
            inter_h = max(0, inter_y2 - inter_y1)
            inter = inter_w * inter_h
            area_i = (x2i - x1i) * (y2i - y1i)
            area_j = (x2j - x1j) * (y2j - y1j)
            union = area_i + area_j - inter
            iou = inter / union if union > 0 else 0
            if iou >= iou_threshold:
                suppressed.add(j)

    return [detections[i] for i in keep]


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
    Detect faces (MediaPipe) + PII text (easyocr) and conditionally
    blur. Original file is OVERWRITTEN ONLY if at least one detection
    landed; clean images pass through byte-for-byte unchanged.

    Result vocabulary (May 2026, Batch B-B):
      * ``ran=True,  blurred=True,  clean=False`` — at least one face
        or PII-text region detected; image OVERWRITTEN with the blurred
        bytes (JPEG re-encode at q=85).
      * ``ran=True,  blurred=False, clean=True``  — pipeline ran end-
        to-end and found NOTHING. ``cv2.imwrite`` is NOT called; the
        file on disk is bit-identical to the input. Important for the
        70-80 % of crisis photos that legitimately have no PII —
        operator gets the full original JPEG quality, not a
        re-compressed copy.
      * ``ran=False, error=...``                   — backends were
        unavailable (MediaPipe + easyocr both missing); file NOT
        processed; dashboard MUST flag the row.

    The `clean` field is the explicit signal callers should branch on
    when deciding whether to skip a disk read-back (saves one round-
    trip on every clean image). `blurred` is the legacy field; it
    equals `not clean` when `ran=True`, but the explicit `clean`
    avoids the negation logic at every caller.
    """
    result = {
        "faces": 0,
        "pii_texts": 0,
        "blurred": False,
        # B-B (May 2026) — explicit "no detections, file unchanged"
        # signal. Mirrors the inverse of `blurred` when `ran=True`;
        # stays False when `ran=False` (we can't claim cleanliness if
        # we never inspected).
        "clean": False,
        "error": None,
        "ran": False,
        "backends": {
            "face_detector": _face_detector is not None,
            "ocr_reader": _ocr_reader is not None,
        },
    }

    # if NEITHER backend is available, short-circuit with an
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
                # P1 multi-face detection (May 2026):
                # Pass 1 — full image. Catches close-up / large faces.
                # Pass 2..5 — 4 overlapping tiles at 60% size each.
                #   Each tile crops a region of the image; faces in that
                #   region appear larger relative to BlazeFace's 128×128
                #   internal input → distant / group faces that were too
                #   small at full-image resolution become detectable.
                #   Tile detections are mapped back to original
                #   coordinates and merged via IoU-based NMS so we don't
                #   double-blur faces that span tile boundaries.
                #
                # Trade-off: 5× the inference cost. On a modern Mac
                # M-series this is ~150 ms total per image; on the
                # ec2 t3.medium PROD instance it's ~600 ms. Acceptable
                # because PII blur runs in the AI executor pool (off
                # the request hot path) and the privacy guarantee is
                # a UNDP must-have.
                raw_detections = _multiscale_face_detect(img, _face_detector, mp)
                # Sanity filter (operator-reviewed, May 2026):
                # tightened 0.30 → 0.15 of image area. Real human
                # faces in photos with > 1 person are < 15% of frame
                # individually (a portrait close-up is ~10–15%, group
                # photo faces ~1–5% each). Anything larger is either
                # a tile-detector hallucination (BlazeFace at conf 0.2
                # mis-labels skin/clothing patches) or a single
                # close-up where component scales already covered the
                # face. Filter conservatively to keep blur localized.
                image_area = w * h
                MAX_FACE_AREA_RATIO = 0.15
                # Also reject bboxes with wild aspect ratios — a face
                # is roughly square (h/w between 0.6 and 1.8). Tile
                # hallucinations often come back as very wide or
                # very tall bands.
                def _looks_like_face(d):
                    fx, fy, fw, fh = d
                    if (fw * fh) > image_area * MAX_FACE_AREA_RATIO:
                        return False
                    if fw < 20 or fh < 20:
                        return False  # too tiny to be a real face
                    ratio = fh / max(1, fw)
                    if ratio < 0.5 or ratio > 2.2:
                        return False  # not face-shaped
                    return True
                sanitized = [d for d in raw_detections if _looks_like_face(d)]
                # NMS now keeps the SMALLEST bbox among overlapping
                # detections, not the largest. The smallest fits the
                # actual face most tightly; the larger duplicates from
                # tile passes typically include skin / clothing
                # adjacent to the face. Tighter bbox → blur stays
                # localized to the face only.
                merged = _nms_merge_faces(sanitized, iou_threshold=0.4, keep="smallest")
                for fx, fy, fw, fh in merged:
                    # Padding tightened 15% → 5% (matches pre-Phase-L
                    # default). With smaller, tighter merged bboxes the
                    # extra padding is no longer needed to absorb
                    # multi-scale coordinate drift.
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

                # Phase 1: DROPPED the "≥5 text regions → blur all
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
            # Phase 1: narrowed kernels.
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
                # P1 follow-up (May 2026, operator-reported "no blur
                # detected"): kernel size now scales with face
                # dimensions. Pre-fix the cap was 41 — adequate for
                # the short-range model's typical 100–300 px faces,
                # but the multi-scale detector now returns regions
                # up to 2000+ px (faces in 12 MP phone photos). 41 px
                # blur on an 800 px face is visually negligible —
                # variance test on the operator's actual file
                # showed ratio 0.47 (face still recognizable, target
                # < 0.20).
                #
                # New: kernel ~= face_dim / 6, clamped [25, 199].
                # Sigma scales proportionally so the blur strength
                # tracks the kernel — without that, large kernels
                # with small sigma still leave faces recognizable.
                face_dim = max(rw, rh)
                ksize = max(25, min(199, (face_dim // 6) * 2 + 1))
                # sigma proportional to ksize for heavy blur (Gaussian
                # spreads only ~3σ before tapering; need σ large
                # enough to actually mix the face pixels into noise).
                sigma = max(15, ksize // 3)
                blurred = cv2.GaussianBlur(roi, (ksize, ksize), sigma)

                # Oval mask with feathered edges. Feather width also
                # scales with face size so the blur-to-clear transition
                # stays smooth on large faces (a 21 px feather on a
                # 2000 px face was effectively a hard edge).
                mask = np.zeros((rh, rw), dtype=np.uint8)
                cv2.ellipse(mask, (rw // 2, rh // 2), (rw // 2, rh // 2), 0, 0, 360, 255, -1)
                feather = max(21, min(101, (face_dim // 20) * 2 + 1))
                mask = cv2.GaussianBlur(mask, (feather, feather), feather // 3)
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
        else:
            # B-B (May 2026) — explicit clean path. The pipeline
            # examined the image and found no PII to redact. We do
            # NOT call cv2.imwrite here — the file on disk is bit-
            # identical to the input. Callers can use `clean=True`
            # to skip the read-back round-trip + save the original
            # bytes directly to storage (preserves full JPEG quality
            # for the 70-80 % of crisis photos that have no PII).
            result["clean"] = True
            logger.info(
                f"PII blur ran on [{os.path.basename(image_path)}]: "
                f"no PII detected — image unchanged (clean)"
            )

    except Exception as e:
        result["error"] = str(e)
        logger.error(f"PII blur error: {e}")

    return result
