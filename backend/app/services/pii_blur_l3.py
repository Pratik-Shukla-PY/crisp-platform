"""L3 — cross-tier consensus algorithm for face-detection FP reduction.

A real face is detected at multiple resolutions. A BlazeFace false
positive (light fixture, vegetation pattern, window grid) typically
appears at only one scale because the underlying luminance / edge
pattern that triggered it doesn't survive resampling.

After each tier (SMALL/MEDIUM/ORIGINAL) of a photo_group_id passes
the L1+L2+L4 gate stack and persists its post-gate accepted boxes in
``Media.final_face_boxes_normalized``, this module computes the
``cross_tier_consensus``: the set of boxes confirmed by at least
``min_tiers`` tiers via IoU ≥ ``iou_threshold``.

The consensus set is what should be blurred in the final assembled
output. Per-tier boxes that don't enter the consensus are false-positive
candidates — they can be either flagged for operator review (initial
deploy) or auto-un-blurred via the B-F retained pre-blur bytes (a
later commit ties the two together).

All boxes use the normalized [0, 1] coordinate space — independent of
the underlying tier resolution.
"""
from __future__ import annotations


def _box_iou(a: dict, b: dict) -> float:
    """Compute IoU on (x, y, w, h) normalized dicts. Both inputs must
    carry numeric x/y/w/h in the [0, 1] range. Returns 0.0 on degenerate
    boxes (zero width/height) or no overlap.
    """
    if a.get("w", 0) <= 0 or a.get("h", 0) <= 0:
        return 0.0
    if b.get("w", 0) <= 0 or b.get("h", 0) <= 0:
        return 0.0
    ax0, ay0 = a["x"], a["y"]
    ax1, ay1 = ax0 + a["w"], ay0 + a["h"]
    bx0, by0 = b["x"], b["y"]
    bx1, by1 = bx0 + b["w"], by0 + b["h"]
    ix0, iy0 = max(ax0, bx0), max(ay0, by0)
    ix1, iy1 = min(ax1, bx1), min(ay1, by1)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    union = (a["w"] * a["h"]) + (b["w"] * b["h"]) - inter
    if union <= 0:
        return 0.0
    return inter / union


def cross_tier_consensus(
    boxes_per_tier,
    *,
    min_tiers: int = 2,
    iou_threshold: float = 0.5,
):
    """Return the set of boxes confirmed across tiers.

    Parameters
    ----------
    boxes_per_tier : dict mapping tier label ('SMALL'|'MEDIUM'|'ORIGINAL')
        to a list of {x, y, w, h} dicts in normalized [0, 1] coords.
    min_tiers : int — the minimum number of tiers a box must appear in
        (with IoU >= iou_threshold) to count as confirmed. Default 2.
    iou_threshold : float — overlap threshold for treating two boxes as
        the same face. Default 0.5.

    Returns
    -------
    list of dict, each with x/y/w/h (the AVERAGE of the confirming
    tiers' boxes — slightly smoothes per-tier coord wobble). Empty
    list if no consensus.
    """
    flat = []
    for tier_label, boxes in boxes_per_tier.items():
        for b in boxes or []:
            if not isinstance(b, dict): continue
            if not all(k in b for k in ("x", "y", "w", "h")): continue
            flat.append((tier_label, b))

    n = len(flat)
    assigned = [False] * n
    clusters = []
    for i in range(n):
        if assigned[i]:
            continue
        cluster = [flat[i]]
        assigned[i] = True
        for j in range(i + 1, n):
            if assigned[j]:
                continue
            if _box_iou(flat[i][1], flat[j][1]) >= iou_threshold:
                cluster.append(flat[j])
                assigned[j] = True
        clusters.append(cluster)

    confirmed = []
    for cluster in clusters:
        tiers_in_cluster = {tier for (tier, _) in cluster}
        if len(tiers_in_cluster) >= min_tiers:
            n_boxes = len(cluster)
            avg = {
                "x": sum(b["x"] for (_, b) in cluster) / n_boxes,
                "y": sum(b["y"] for (_, b) in cluster) / n_boxes,
                "w": sum(b["w"] for (_, b) in cluster) / n_boxes,
                "h": sum(b["h"] for (_, b) in cluster) / n_boxes,
                "tiers_confirmed": sorted(list(tiers_in_cluster)),
            }
            confirmed.append(avg)

    return confirmed


def unconfirmed_per_tier(boxes_per_tier, *, iou_threshold: float = 0.5):
    """Return the per-tier set of boxes that did NOT enter the consensus.

    These are the false-positive candidates for each tier. The caller
    can either flag them for operator review (initial deploy) or
    drive a retroactive re-blur via B-F retained bytes (later commit).
    """
    consensus = cross_tier_consensus(
        boxes_per_tier, min_tiers=2, iou_threshold=iou_threshold,
    )
    out = {}
    for tier_label, boxes in boxes_per_tier.items():
        rejected = []
        for b in boxes or []:
            if not isinstance(b, dict): continue
            if not all(k in b for k in ("x", "y", "w", "h")): continue
            confirmed_match = any(
                _box_iou(b, c) >= iou_threshold for c in consensus
            )
            if not confirmed_match:
                rejected.append(b)
        out[tier_label] = rejected
    return out
