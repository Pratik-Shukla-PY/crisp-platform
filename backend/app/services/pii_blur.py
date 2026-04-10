"""
CRISP PII Blur Service — Targeted face + PII text blur.

STRATEGY: Detect conservatively, blur generously.
  - Faces: Use MULTIPLE cascades but require minNeighbors=4 (reduces false positives)
           Then run a CONFIRMATION pass: if a face is detected by 2+ different cascades
           at the same location, it's definitely real → blur with 50% padding.
  - Text PII: OCR + regex patterns for ID numbers → blur only matching text lines.
  - Clean disaster photos: NO blur (no false positives on rubble/textures).

100% LOCAL. Zero API calls.
"""
import os
import re
import logging
import cv2
import numpy as np

logger = logging.getLogger(__name__)

# ── Tesseract OCR ────────────────────────────────────────────────────────────
_TESSERACT_CMD = None
for p in ['/opt/homebrew/bin/tesseract', '/usr/bin/tesseract', '/usr/local/bin/tesseract']:
    if os.path.exists(p):
        _TESSERACT_CMD = p
        break

_HAS_TESSERACT = False
try:
    import pytesseract
    if _TESSERACT_CMD:
        pytesseract.pytesseract.tesseract_cmd = _TESSERACT_CMD
    _HAS_TESSERACT = True
except ImportError:
    pass

# ── Face Cascades (3 different models for cross-validation) ──────────────────
_CASCADE_PATHS = {}
for name in ['haarcascade_frontalface_default.xml',
             'haarcascade_frontalface_alt2.xml',
             'haarcascade_profileface.xml']:
    path = os.path.join(cv2.data.haarcascades, name)
    if os.path.exists(path):
        _CASCADE_PATHS[name] = cv2.CascadeClassifier(path)

# ── PII Regex Patterns ───────────────────────────────────────────────────────
PII_PATTERNS = [
    re.compile(r'\b\d{4}\s\d{4}\s\d{4}\b'),                          # Aadhaar
    re.compile(r'\b[A-Z]{5}\d{4}[A-Z]\b'),                           # PAN
    re.compile(r'(?:\+\d{1,3}[-\s]?)?\(?\d{3,5}\)?[-\s]?\d{3,5}[-\s]?\d{4,6}'),  # Phone
    re.compile(r'\b\d{2}[/\-\.]\d{2}[/\-\.]\d{4}\b'),                # DOB
    re.compile(r'\b[A-Z]\d{7,8}\b'),                                  # Passport
    re.compile(r'\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{4}\b'),      # Credit card
    re.compile(r'\b\d{3}-\d{2}-\d{4}\b'),                            # SSN
    re.compile(r'\b[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}\b'),  # Email
    re.compile(r'\b\d{17}[\dXx]\b'),                                  # Chinese ID
    re.compile(r'\b\d{3}\.\d{3}\.\d{3}-\d{2}\b'),                   # Brazilian CPF
    re.compile(r'\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-Z]\b'),   # UK NI
    re.compile(r'\b\d{12,}\b'),                                       # Generic long ID
]


def blur_pii(image_path: str) -> dict:
    """
    Detect and blur faces + PII text. Original file OVERWRITTEN.
    Uses cross-validated face detection to avoid false positives.
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
        blur_regions = []

        # ═══════════════════════════════════════════════════════════════
        # LAYER 1: FACE DETECTION — Cross-validated to prevent false positives
        #
        # Strategy: Run each cascade with minNeighbors=4 (conservative).
        # A face is CONFIRMED if detected by at least 1 cascade.
        # For the default cascade (most reliable), trust it alone.
        # For alt/profile cascades, require overlap with another detection.
        # ═══════════════════════════════════════════════════════════════
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        gray_enhanced = clahe.apply(gray)

        # Collect candidate faces from each cascade
        candidates = {}  # cascade_name -> list of (x,y,w,h)
        for name, cascade in _CASCADE_PATHS.items():
            detections = []
            for g in [gray, gray_enhanced]:
                faces = cascade.detectMultiScale(
                    g,
                    scaleFactor=1.05,
                    minNeighbors=4,   # Conservative — reduces false positives
                    minSize=(int(w * 0.04), int(h * 0.04)),  # 4% min — ignores noise
                )
                if len(faces) > 0:
                    detections.extend(faces.tolist())
            candidates[name] = detections

        # Cross-validate: a face is confirmed if:
        # - Detected by the default cascade (most reliable), OR
        # - Detected by 2+ different cascades at overlapping locations
        confirmed_faces = []
        all_detections = []
        for name, dets in candidates.items():
            for (fx, fy, fw, fh) in dets:
                all_detections.append((fx, fy, fw, fh, name))

        # Default cascade detections are trusted directly
        default_name = 'haarcascade_frontalface_default.xml'
        for (fx, fy, fw, fh, name) in all_detections:
            cx, cy = fx + fw // 2, fy + fh // 2

            # Check if already confirmed at this location
            already = any(abs(cx - ex) < fw * 0.5 and abs(cy - ey) < fh * 0.5
                         for (ex, ey) in confirmed_faces)
            if already:
                continue

            if name == default_name:
                # Default cascade — trust directly (most reliable)
                confirmed_faces.append((cx, cy))
                px, py = int(fw * 0.5), int(fh * 0.5)
                blur_regions.append((max(0, fx-px), max(0, fy-py),
                                     min(w, fx+fw+px), min(h, fy+fh+py)))
                result["faces"] += 1
            else:
                # Alt/profile cascade — only trust if another cascade also detected nearby
                has_corroboration = False
                for (ox, oy, ow, oh, oname) in all_detections:
                    if oname == name:
                        continue  # Same cascade doesn't count
                    ocx, ocy = ox + ow // 2, oy + oh // 2
                    if abs(cx - ocx) < max(fw, ow) * 0.6 and abs(cy - ocy) < max(fh, oh) * 0.6:
                        has_corroboration = True
                        break

                if has_corroboration:
                    confirmed_faces.append((cx, cy))
                    px, py = int(fw * 0.5), int(fh * 0.5)
                    blur_regions.append((max(0, fx-px), max(0, fy-py),
                                         min(w, fx+fw+px), min(h, fy+fh+py)))
                    result["faces"] += 1

        # ═══════════════════════════════════════════════════════════════
        # LAYER 2: PII TEXT (OCR + regex — only blur text with PII patterns)
        # ═══════════════════════════════════════════════════════════════
        if _HAS_TESSERACT:
            try:
                ocr_img = img
                scale = 1.0
                if max(h, w) < 800:
                    scale = 1200 / max(h, w)
                    ocr_img = cv2.resize(img, None, fx=scale, fy=scale,
                                         interpolation=cv2.INTER_CUBIC)

                ocr = pytesseract.image_to_data(
                    ocr_img, output_type=pytesseract.Output.DICT,
                    config='--psm 11 --oem 3')

                n = len(ocr['text'])
                words = []
                for i in range(n):
                    txt = (ocr['text'][i] or '').strip()
                    conf = int(ocr['conf'][i]) if str(ocr['conf'][i]) != '-1' else 0
                    if conf > 20 and len(txt) > 0:
                        words.append({
                            'text': txt,
                            'x': int(ocr['left'][i] / scale),
                            'y': int(ocr['top'][i] / scale),
                            'w': int(ocr['width'][i] / scale),
                            'h': int(ocr['height'][i] / scale),
                        })

                if words:
                    words.sort(key=lambda wd: (wd['y'] // 15, wd['x']))
                    lines = []
                    current_line = [words[0]]
                    for wd in words[1:]:
                        if abs(wd['y'] - current_line[-1]['y']) < 15:
                            current_line.append(wd)
                        else:
                            lines.append(current_line)
                            current_line = [wd]
                    lines.append(current_line)

                    for line_words in lines:
                        line_text = ' '.join(wd['text'] for wd in line_words)
                        if any(p.search(line_text) for p in PII_PATTERNS):
                            x1 = min(wd['x'] for wd in line_words)
                            y1 = min(wd['y'] for wd in line_words)
                            x2 = max(wd['x'] + wd['w'] for wd in line_words)
                            y2 = max(wd['y'] + wd['h'] for wd in line_words)
                            pad = max(int((y2 - y1) * 0.3), 4)
                            blur_regions.append((max(0, x1-pad), max(0, y1-pad),
                                                 min(w, x2+pad), min(h, y2+pad)))
                            result["pii_texts"] += 1

            except Exception as e:
                logger.warning(f"PII OCR error: {e}")

        # ═══════════════════════════════════════════════════════════════
        # APPLY BLUR
        # ═══════════════════════════════════════════════════════════════
        if blur_regions:
            merged = _merge_regions(blur_regions)
            for (x1, y1, x2, y2) in merged:
                if x2 <= x1 or y2 <= y1:
                    continue
                roi = img[y1:y2, x1:x2]
                if roi.size == 0:
                    continue
                # Heavy double-blur — completely unrecognizable
                ksize = max(99, (max(x2-x1, y2-y1) // 2) * 2 + 1)
                blurred = cv2.GaussianBlur(roi, (ksize, ksize), 40)
                blurred = cv2.GaussianBlur(blurred, (ksize, ksize), 40)
                img[y1:y2, x1:x2] = blurred

            cv2.imwrite(image_path, img, [cv2.IMWRITE_JPEG_QUALITY, 85])
            result["blurred"] = True
            logger.info(f"PII blurred [{os.path.basename(image_path)}]: "
                        f"faces={result['faces']} pii={result['pii_texts']}")

    except Exception as e:
        result["error"] = str(e)
        logger.error(f"PII blur error: {e}")

    return result


def _merge_regions(regions):
    if not regions:
        return []
    regions.sort(key=lambda r: (r[2]-r[0])*(r[3]-r[1]), reverse=True)
    merged = []
    used = [False] * len(regions)
    for i in range(len(regions)):
        if used[i]: continue
        x1, y1, x2, y2 = regions[i]
        for j in range(i+1, len(regions)):
            if used[j]: continue
            jx1, jy1, jx2, jy2 = regions[j]
            if max(x1,jx1) < min(x2,jx2) and max(y1,jy1) < min(y2,jy2):
                x1, y1 = min(x1,jx1), min(y1,jy1)
                x2, y2 = max(x2,jx2), max(y2,jy2)
                used[j] = True
        merged.append((x1, y1, x2, y2))
        used[i] = True
    return merged
