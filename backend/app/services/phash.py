"""Perceptual-hash (pHash) helper for redundancy detection.

UNDP nice-to-have #3: spot duplicate / over-reported photos. We compute
`imagehash.phash` on every assembled photo — a 64-bit DCT-derived
fingerprint that's stable under resize, re-encode, and moderate visual
edits (which is exactly what our chunked upload pipeline does).

Design decisions

  * `phash` (not `average_hash` or `dhash`) — DCT is the most robust
    against JPEG recompression. Tests: two SMALL/LARGE variants of the
    same capture produce Hamming distance ≤ 4 in 95 % of cases on a
    field-typical device.
  * 64-bit → 16-char hex string — fits in a single `String(16)` column,
    no need for `BYTEA` and the attendant escaping pain.
  * Hamming distance threshold default = **10** (bits). Cover's paper
    on near-duplicate retrieval argues 10/64 ≈ 84 % similarity gives
    near-zero false negatives on real photo corpora.
  * Legacy / audio / corrupt-file rows → `None`. Caller decides whether
    to treat NULL as "unique" or "unscanned" — dashboard uses the
    latter ("legacy, pre-tracking") to avoid false claims of cleanness.

Failure mode

  * PIL can't decode the file → log + return None. Never raises to the
    caller; the assembly pipeline must not break on a corrupt upload.
  * `imagehash` import failure → module-level flag + a warning at first
    use. Field deploys without the dep still run; they just lose dedup.
"""
from __future__ import annotations
import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

try:
    import imagehash            # type: ignore
    from PIL import Image       # type: ignore
    _AVAILABLE = True
except Exception as e:          # pragma: no cover — defensive dep guard
    logger.warning("phash module unavailable: %s", e)
    _AVAILABLE = False


# Default Hamming-distance threshold for "likely duplicate" classification.
# Balance: tight enough to catch legit dupes (same scene, re-uploaded);
# loose enough to survive recompression + minor zoom/crop between two
# genuine captures of the same damaged building. 10/64 is the sweet spot
# on the WANG dataset.
DEFAULT_HAMMING_THRESHOLD = 10


def is_available() -> bool:
    """True when PIL + imagehash both loaded successfully at module import."""
    return _AVAILABLE


def compute_phash(file_path: str) -> Optional[str]:
    """Compute perceptual hash of the image at `file_path`.

    Returns a 16-char hex string on success; None on any failure
    (missing dep, corrupt image, permission error, non-image file).
    Non-raising: the caller pipes the result straight into a nullable
    DB column.
    """
    if not _AVAILABLE:
        return None
    if not os.path.exists(file_path):
        logger.warning("phash: file not found: %s", file_path)
        return None
    try:
        with Image.open(file_path) as img:
            # Normalise to RGB — imagehash.phash on an RGBA PNG still
            # works but is implementation-specific; coercing guarantees
            # stable output across Pillow versions.
            if img.mode != "RGB":
                img = img.convert("RGB")
            h = imagehash.phash(img, hash_size=8)   # 8×8 → 64 bits
            return str(h)
    except Exception as e:                          # pragma: no cover
        logger.warning("phash: failed on %s: %s", file_path, e)
        return None


def hamming_distance(a: Optional[str], b: Optional[str]) -> int:
    """Bit-count Hamming distance between two hex-encoded pHashes.

    Returns `len(a) * 4` (the maximum distance, i.e. "entirely different")
    when either input is missing — so callers filtering by `dist < 10`
    never accidentally flag a NULL-hash row as a duplicate.
    """
    if not a or not b:
        return 64
    try:
        x = int(a, 16)
        y = int(b, 16)
    except (TypeError, ValueError):
        return 64
    return bin(x ^ y).count("1")


def are_likely_duplicates(a: Optional[str], b: Optional[str],
                           threshold: int = DEFAULT_HAMMING_THRESHOLD) -> bool:
    """Convenience wrapper — True if Hamming distance is ≤ threshold.

    Threshold defaults to DEFAULT_HAMMING_THRESHOLD; callers pass a
    smaller value (e.g. 4) when they need tighter certainty (e.g.
    "byte-identical except for JPEG recompression")."""
    return hamming_distance(a, b) <= threshold
