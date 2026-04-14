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

# ── MediaPipe Face Detection ─────────────────────────────────────────────────
_face_detector = None
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
        logger.info("PII: MediaPipe face detector loaded")
    else:
        logger.warning(f"PII: MediaPipe model not found at {model_path}")
except Exception as e:
    logger.warning(f"PII: MediaPipe unavailable: {e}")

# ── easyocr Reader ───────────────────────────────────────────────────────────
_ocr_reader = None
try:
    import easyocr
    _ocr_reader = easyocr.Reader(['en'], gpu=False, verbose=False)
    logger.info("PII: easyocr reader loaded")
except Exception as e:
    logger.warning(f"PII: easyocr unavailable: {e}")

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
    """
    result = {"faces": 0, "pii_texts": 0, "blurred": False, "error": None}

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
                    # 20% padding
                    px, py = int(fw * 0.2), int(fh * 0.2)
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
        # ═══════════════════════════════════════════════════════════════
        if _ocr_reader:
            try:
                ocr_results = _ocr_reader.readtext(img)

                # Filter to meaningful text regions
                valid_texts = []
                for bbox, text, conf in ocr_results:
                    if len(text.strip()) < 2:
                        continue
                    # Keep ALL detections — even low confidence.
                    # easyocr on phone photos of documents often gives low conf
                    # but the detection bounding box is still accurate.
                    pts = np.array(bbox).astype(int)
                    x1, y1 = pts[:, 0].min(), pts[:, 1].min()
                    x2, y2 = pts[:, 0].max(), pts[:, 1].max()
                    valid_texts.append((x1, y1, x2, y2, text, conf))

                # KEY INSIGHT: Normal disaster photos have 0-3 text regions.
                # Documents (ID cards, licenses) have 5+ text regions.
                # If 5+ text found → likely a document → blur ALL text.
                all_text = ' '.join(t[4] for t in valid_texts)
                has_pii_pattern = any(pat.search(all_text) for pat in PII_PATTERNS)
                is_document = len(valid_texts) >= 5
                has_face = len(face_regions) > 0

                # Decide what to blur
                blur_all_text = is_document or has_face  # Document or ID card → blur everything

                for (x1, y1, x2, y2, text, conf) in valid_texts:
                    should_blur = False

                    if blur_all_text:
                        should_blur = True  # Document: blur ALL text
                    else:
                        # Standalone text: only blur if matches PII pattern
                        for pat in PII_PATTERNS:
                            if pat.search(text):
                                should_blur = True
                                break

                    if should_blur:
                        pad = max(int((y2 - y1) * 0.25), 4)
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
            # Blur faces with oval mask
            for (x1, y1, x2, y2) in face_regions:
                rw, rh = x2 - x1, y2 - y1
                if rw <= 0 or rh <= 0:
                    continue
                roi = img[y1:y2, x1:x2]
                ksize = max(71, (max(rw, rh) // 2) * 2 + 1)
                blurred = cv2.GaussianBlur(roi, (ksize, ksize), 35)
                blurred = cv2.GaussianBlur(blurred, (ksize, ksize), 35)

                # Oval mask with feathered edges
                mask = np.zeros((rh, rw), dtype=np.uint8)
                cv2.ellipse(mask, (rw // 2, rh // 2), (rw // 2, rh // 2), 0, 0, 360, 255, -1)
                mask = cv2.GaussianBlur(mask, (21, 21), 10)
                mask_3ch = cv2.merge([mask, mask, mask]).astype(np.float32) / 255.0
                img[y1:y2, x1:x2] = (blurred * mask_3ch + roi * (1 - mask_3ch)).astype(np.uint8)

            # Blur text with rectangle
            for (x1, y1, x2, y2) in text_blur_regions:
                rw, rh = x2 - x1, y2 - y1
                if rw <= 0 or rh <= 0:
                    continue
                roi = img[y1:y2, x1:x2]
                ksize = max(51, (max(rw, rh) // 2) * 2 + 1)
                img[y1:y2, x1:x2] = cv2.GaussianBlur(roi, (ksize, ksize), 30)

            cv2.imwrite(image_path, img, [cv2.IMWRITE_JPEG_QUALITY, 85])
            result["blurred"] = True
            logger.info(f"PII blurred [{os.path.basename(image_path)}]: "
                        f"faces={result['faces']} text={result['pii_texts']}")

    except Exception as e:
        result["error"] = str(e)
        logger.error(f"PII blur error: {e}")

    return result
