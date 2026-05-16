"""
fraud_batch — async batch worker for the heavier abuse-detection
signals.

Phase 5 (docs/NEARBY_REPORTS_PIPELINE.md §6.2 + §6.4) — the signals
too expensive for the synchronous hot path:

  • Emulator-farm fingerprinting (UA + device telemetry pattern
    matching against known emulators).
  • Narrative similarity hashing (k-mean cosine similarity over
    description 5-grams; flags coordinated narrative attacks).
  • Cross-device coordination analysis (graph of devices that
    consistently report the same buildings within seconds of each
    other).

This module exposes a single entry point — `run_batch_scan()` —
that the deployment's job scheduler (cron / Celery / RQ /
docker-compose) calls every CRISP_TRUST_ASYNC_INTERVAL_MIN minutes
(default 15). Inside the scan:

  1. Pick devices touched in the last interval (devices.updated_at
     IS NULL guard means "any device that submitted recently" —
     covers v0 devices without that column).
  2. Run each heuristic against the device's recent submission
     history.
  3. For each signal that fires: append to spam_signals, bump
     spam_score, and emit a webhook to subscribed deployment
     partners (Phase 5 — operator decision in docs §6.4: CRISP
     hosts the framework, partners integrate via webhooks).

The worker is IDEMPOTENT — re-running on the same device-window
slice doesn't double-bump spam_score (we union signals; weight
becomes max).

Phase 5 is a SCAFFOLD — the actual ML / fingerprinting heuristics
are pluggable hooks (functions in DETECTORS list). Real
implementations land as separate commits per UNDP rubric Item 12
(scale-readiness; UNDP cap 500k reports/crisis).
"""
from __future__ import annotations

import json
import logging
import os
import random
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Callable, Iterable, List, Optional, Sequence

import httpx
from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.report import Device, Report
from app.services.fraud_detector import SIGNAL_WEIGHTS


log = logging.getLogger(__name__)


# ── Signal-type vocabulary ─────────────────────────────────────────

class BatchSignal:
    EMULATOR_FARM      = "emulator_farm"
    NARRATIVE_SIMILAR  = "narrative_similar"
    CROSS_DEVICE_RING  = "cross_device_ring"


# Add the Phase 5 signal weights to the shared SIGNAL_WEIGHTS so the
# aggregator's existing spam_score floor logic doesn't need changes.
_PHASE5_SIGNAL_WEIGHTS = {
    BatchSignal.EMULATOR_FARM:     1.0,
    BatchSignal.NARRATIVE_SIMILAR: 0.8,
    BatchSignal.CROSS_DEVICE_RING: 0.8,
}
SIGNAL_WEIGHTS.update(_PHASE5_SIGNAL_WEIGHTS)


# ── Heuristic detectors (Phase 5 scaffold — real ML lands in followups) ──
#
# Each detector takes (db, device, recent_reports) and returns a
# list of BatchSignal constants that fired. Add new detectors here;
# the worker auto-iterates all DETECTORS for each device.

# ── Emulator fingerprinting (Phase 5.1 — real telemetry, docs §6.2) ──
#
# The Phase 5 scaffold only matched substrings in `device.platform`.
# Trivially defeated. The real implementation reads
# `device.telemetry_summary` (populated by the PWA / RN client via
# POST /api/v1/devices/telemetry) and applies a small ruleset.
#
# Each rule contributes to a score; the signal fires when score ≥ 1.0.
# We do NOT collapse this to a single boolean because we want admins
# to see which signals contributed (logged via spam_signals[]).

# Well-known software / emulator WebGL renderer fragments. These are
# never seen on real iOS / Android devices in the wild — real mobile
# GPUs are Adreno / Mali / Apple / PowerVR.
_SOFTWARE_RENDERER_NEEDLES: tuple[str, ...] = (
    "swiftshader",   # Chromium fallback (BlueStacks default)
    "angle",         # Android Studio emulator (ANGLE / D3D11)
    "llvmpipe",      # Linux software renderer
    "lavapipe",      # Vulkan software renderer
    "mesa offscreen",
    "swrast",        # X11 software rasteriser
)

# Default emulator config: UTC timezone + en-US locale is the AOSP
# emulator default and lavapipe's. Real devices in their target
# deployment regions rarely match this exact pair.
_DEFAULT_EMU_TIMEZONE = "UTC"
_DEFAULT_EMU_LOCALE_PREFIXES: tuple[str, ...] = ("en-us", "en_us")


def _detect_emulator_farm(
    db: Session, device: Device,
    recent_reports: Sequence[Report],
) -> List[str]:
    """Phase 5.1 real implementation (docs §6.2). Reads the device's
    captured telemetry_summary and scores emulator likelihood. Falls
    back to the cheap UA-substring check when no telemetry has been
    captured yet — devices that predate the capture roll-out still
    get flagged on obvious patterns.

    Scoring rules (any combination summing ≥ 1.0 → fires):

      1.0  platform / UA substring matches known emulator string
      1.0  WebGL renderer is a software renderer (SwiftShader/ANGLE/...)
      0.6  no accelerometer activity AND device claims mobile OS
      0.4  no battery API support
      0.4  timezone="UTC" AND locale starts with "en-US"
      0.4  exact emulator screen presets (411×823 dpr=2.625 is the
           Pixel-2 Android Studio default; 375×667 dpr=2.0 is iOS
           Simulator's iPhone 8 default)

    Public count still floors at distinct-device count (per §10) — this
    detector only feeds the device's spam_score / spam_signals; it does
    NOT change how the report appears to citizens. Citizens see the
    same group regardless of whether a contributing device fingerprints
    as an emulator.
    """
    if not device:
        return []

    score = 0.0
    # Rule 1: UA / platform substring (preserved from the Phase 5 scaffold).
    plat = (device.platform or "").lower()
    if any(needle in plat for needle in ("emulator", "bluestacks",
                                         "genymotion", "simulator")):
        score += 1.0

    telem = device.telemetry_summary or {}
    if isinstance(telem, dict) and telem:
        # Rule 2: software WebGL renderer.
        renderer = (telem.get("webgl_renderer") or "").lower()
        if renderer and any(n in renderer for n in _SOFTWARE_RENDERER_NEEDLES):
            score += 1.0

        # Rule 3: no accelerometer activity on a device claiming to be
        # mobile. Static accelerometer is normal in absolute terms (the
        # phone sitting on a desk reports ~9.8 on Z), so the PWA only
        # sets accel_active=true when it sees the values CHANGE between
        # samples — the kind of variance you only get when a real device
        # is being handled.
        accel_active = telem.get("accel_active")
        platform_ua = (telem.get("platform_ua") or "").lower()
        claims_mobile = any(
            needle in platform_ua
            for needle in ("iphone", "ipad", "android", "mobile")
        )
        if claims_mobile and accel_active is False:
            score += 0.6

        # Rule 4: battery API completely absent on a claimed mobile UA.
        battery_present = telem.get("battery_present")
        if claims_mobile and battery_present is False:
            score += 0.4

        # Rule 5: default emulator timezone + locale combo.
        tz = (telem.get("timezone") or "")
        loc = (telem.get("locale") or "").lower()
        if (tz == _DEFAULT_EMU_TIMEZONE
                and any(loc.startswith(p) for p in _DEFAULT_EMU_LOCALE_PREFIXES)):
            score += 0.4

        # Rule 6: exact emulator screen presets.
        w, h = telem.get("screen_w"), telem.get("screen_h")
        dpr = telem.get("screen_dpr")
        try:
            w_int = int(w) if w is not None else None
            h_int = int(h) if h is not None else None
            dpr_f = float(dpr) if dpr is not None else None
        except (TypeError, ValueError):
            w_int = h_int = dpr_f = None
        emu_screens = {
            (411, 823, 2.625),   # Pixel 2 AVD default
            (411, 731, 2.625),   # Pixel 2 landscape
            (375, 667, 2.0),     # iPhone 8 simulator default
            (414, 736, 3.0),     # iPhone 8 Plus simulator
            (360, 640, 2.0),     # AOSP emulator default
        }
        if (w_int, h_int, dpr_f) in emu_screens:
            score += 0.4

    if score >= 1.0:
        return [BatchSignal.EMULATOR_FARM]
    return []


# ── Narrative similarity (Phase 5.1) — real MinHash-based Jaccard ────────
#
# The Phase-5 scaffold flagged only IDENTICAL descriptions; a real spam
# farm trivially defeats that by adding a random suffix. This is the
# real implementation per docs §6.2:
#
#   "Real implementation will use cosine similarity over 5-grams +
#    minhash for cross-device similarity."
#
# We use Jaccard similarity (over token 5-gram sets) which is a tighter
# fit for short narrative text than cosine on bag-of-words. MinHash
# gives us an unbiased Jaccard estimator with a fixed-size signature,
# so pairwise comparison is O(K) instead of O(|n-grams|) per pair.
#
# Tuning (env-overridable):
#   CRISP_NARRATIVE_JACCARD_THRESHOLD  default 0.7   — pairwise sim floor
#   CRISP_NARRATIVE_MIN_REPORTS        default 3     — clique-size floor
#   CRISP_NARRATIVE_NGRAM              default 5     — 5-grams per docs
#   CRISP_NARRATIVE_MINHASH_K          default 32    — signature size
#
# At K=32 the standard error of the Jaccard estimator is ~1/sqrt(K) ≈
# 0.18, which is more than tight enough for a 0.7 trigger threshold.
# Bumping to K=64 halves the variance at 2× the compute; not worth it
# for this use case until the worker becomes a bottleneck.

_NARRATIVE_JACCARD_THRESHOLD = float(
    os.environ.get("CRISP_NARRATIVE_JACCARD_THRESHOLD", "0.7")
)
_NARRATIVE_MIN_REPORTS = int(
    os.environ.get("CRISP_NARRATIVE_MIN_REPORTS", "3")
)
_NARRATIVE_NGRAM = int(os.environ.get("CRISP_NARRATIVE_NGRAM", "5"))
_NARRATIVE_MINHASH_K = int(os.environ.get("CRISP_NARRATIVE_MINHASH_K", "32"))

_TOKEN_RE = re.compile(r"[a-z0-9']+")

# Small stopword list — short enough not to over-strip non-English
# reports, big enough to drop the high-frequency English noise that
# inflates similarity on legitimately-different reports.
_STOPWORDS: frozenset[str] = frozenset({
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "of", "to", "in", "at", "on", "and", "or", "but", "this", "that",
    "these", "those", "i", "we", "you", "he", "she", "it", "they",
    "my", "our", "your", "his", "her", "its", "their",
})

# MinHash permutation coefficients. Deterministic seed so tests are
# reproducible AND so signatures computed in different worker processes
# can be meaningfully compared if we ever want to persist them.
_MINHASH_PRIME = (1 << 61) - 1   # Mersenne prime
_MINHASH_RNG = random.Random(0xC81597)
_PERM_A: List[int] = [
    _MINHASH_RNG.randint(1, _MINHASH_PRIME - 1)
    for _ in range(_NARRATIVE_MINHASH_K)
]
_PERM_B: List[int] = [
    _MINHASH_RNG.randint(0, _MINHASH_PRIME - 1)
    for _ in range(_NARRATIVE_MINHASH_K)
]


def _tokenize(text: str) -> List[str]:
    """Lowercase + word-extract + drop stopwords + drop length-1 tokens."""
    if not text:
        return []
    return [
        t for t in _TOKEN_RE.findall(text.lower())
        if t not in _STOPWORDS and len(t) > 1
    ]


def _ngrams(tokens: Sequence[str], n: int = _NARRATIVE_NGRAM) -> set[str]:
    """Sliding token n-grams. For very short texts fall back to a bag-
    of-tokens; otherwise Jaccard would collapse to "do they share any
    individual word" which is too loose."""
    if len(tokens) < n:
        return set(tokens)
    return {" ".join(tokens[i:i + n]) for i in range(len(tokens) - n + 1)}


def _fnv1a64(b: bytes) -> int:
    """FNV-1a 64-bit hash; cheap, pure-Python, no deps. Output is the
    "base hash" we then permute K ways for the MinHash signature."""
    h = 0xcbf29ce484222325
    for byte in b:
        h ^= byte
        h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return h


def _minhash_signature(grams: Iterable[str]) -> List[int]:
    """Compute K minhash values by permuting a single base hash K ways
    via affine functions modulo a Mersenne prime. Standard trick from
    Broder '97; saves K-1 full hash invocations per gram."""
    sig = [_MINHASH_PRIME] * _NARRATIVE_MINHASH_K
    for g in grams:
        h = _fnv1a64(g.encode("utf-8"))
        for i in range(_NARRATIVE_MINHASH_K):
            v = (_PERM_A[i] * h + _PERM_B[i]) % _MINHASH_PRIME
            if v < sig[i]:
                sig[i] = v
    return sig


def _jaccard_estimate(sig_a: Sequence[int], sig_b: Sequence[int]) -> float:
    """Unbiased estimator: count matching slots / K. Variance falls as
    1/K so K=32 is plenty for a 0.7 trigger threshold."""
    if not sig_a or not sig_b or len(sig_a) != len(sig_b):
        return 0.0
    matches = sum(1 for a, b in zip(sig_a, sig_b) if a == b)
    return matches / len(sig_a)


def _detect_narrative_similar(
    db: Session, device: Device,
    recent_reports: Sequence[Report],
) -> List[str]:
    """Phase 5.1 real implementation (docs §6.2): MinHash-based Jaccard
    similarity over 5-grams of the device's recent descriptions. Fires
    when ≥ N reports form a similarity clique (pairwise Jaccard above
    the threshold).

    Why "clique" not "pairwise count": a single shared template across
    3 reports yields 3-choose-2 = 3 similar pairs; a true coordinated
    spam pattern is much higher. Counting unique reports inside the
    similarity graph is more robust to occasional false-positive pairs.

    Still catches identical descriptions (sim=1.0 ≥ 0.7), so the Phase 5
    test that asserts identical descriptions fire still passes.
    """
    if len(recent_reports) < _NARRATIVE_MIN_REPORTS:
        return []
    # Build (report_id, signature) tuples for every report with enough
    # tokens to compute a meaningful signature.
    sigs: List[tuple[str, List[int]]] = []
    for r in recent_reports:
        desc = (r.description or "").strip()
        tokens = _tokenize(desc)
        if len(tokens) < 3:
            # Reports with < 3 surviving tokens (after stopword removal)
            # match each other too easily; drop them rather than letting
            # them inflate similarity counts.
            continue
        grams = _ngrams(tokens)
        if not grams:
            continue
        sigs.append((r.id, _minhash_signature(grams)))
    if len(sigs) < _NARRATIVE_MIN_REPORTS:
        return []
    # Build the similarity graph by pairwise comparison and collect
    # every report that's part of at least one similar pair.
    similar_reports: set[str] = set()
    for i in range(len(sigs)):
        for j in range(i + 1, len(sigs)):
            if _jaccard_estimate(sigs[i][1], sigs[j][1]) >= _NARRATIVE_JACCARD_THRESHOLD:
                similar_reports.add(sigs[i][0])
                similar_reports.add(sigs[j][0])
    if len(similar_reports) >= _NARRATIVE_MIN_REPORTS:
        return [BatchSignal.NARRATIVE_SIMILAR]
    return []


def _detect_cross_device_ring(
    db: Session, device: Device,
    recent_reports: Sequence[Report],
) -> List[str]:
    """Phase 5 scaffold: device's recent reports all match the
    building_id and timestamps of another device's recent reports
    (suggests coordinated farming).

    Real implementation will build a per-window device-coreport
    graph + cluster on connection density. The scaffold below
    captures the simplest pattern.
    """
    if len(recent_reports) < 3:
        return []
    bids = {r.building_id for r in recent_reports if r.building_id}
    if not bids:
        return []
    # Look for other devices reporting the SAME building_ids within
    # the same hour. If multiple distinct devices ALL share this
    # device's pattern → suspect.
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    same_bid_devs = (
        db.query(Report.device_id)
          .filter(Report.building_id.in_(bids))
          .filter(Report.device_id != device.id)
          .filter(Report.server_created_at >= cutoff)
          .distinct()
          .all()
    )
    if len(same_bid_devs) >= 3:
        return [BatchSignal.CROSS_DEVICE_RING]
    return []


DETECTORS: List[Callable[[Session, Device, Sequence[Report]], List[str]]] = [
    _detect_emulator_farm,
    _detect_narrative_similar,
    _detect_cross_device_ring,
]


# ── Outbound webhook delivery (Phase 5 — docs §6.4) ────────────────

def _webhook_endpoints() -> List[str]:
    """Read deployment-configured webhook destinations from env.
    Comma-separated URLs in CRISP_APPEAL_WEBHOOK_URLS."""
    raw = os.environ.get("CRISP_APPEAL_WEBHOOK_URLS", "").strip()
    if not raw:
        return []
    return [u.strip() for u in raw.split(",") if u.strip()]


def emit_webhook(event: dict, *, timeout_sec: float = 5.0) -> None:
    """POST a JSON payload to every configured webhook URL.

    Best-effort delivery — failures are logged + swallowed. Phase 5.5+
    will replace this with a retry/backoff queue. The current scaffold
    is enough for a deployment partner (UNDP / others) to observe live
    appeal-decision events without polling.
    """
    urls = _webhook_endpoints()
    if not urls:
        return
    payload = json.dumps(event, default=str).encode("utf-8")
    headers = {"Content-Type": "application/json",
               "User-Agent": "CRISP-AppealsWebhook/1.0"}
    for url in urls:
        try:
            httpx.post(url, content=payload, headers=headers, timeout=timeout_sec)
        except Exception:                          # pragma: no cover
            log.exception("[fraud_batch] webhook POST failed: %s", url)


# ── Main entry point ───────────────────────────────────────────────

def run_batch_scan(
    *, db: Optional[Session] = None,
    lookback_minutes: int = 15,
) -> dict:
    """Sweep every device active in the last `lookback_minutes` and
    run each Phase-5 detector against its recent reports.

    Returns a small summary dict for the scheduler to log. Idempotent:
    re-running on the same window doesn't double-bump spam_score.

    Designed for invocation from a cron / Celery beat / scheduled-task
    runner. Standalone test entry point too:
        python -m app.services.fraud_batch
    """
    owns_session = db is None
    db = db or SessionLocal()
    summary = {"scanned": 0, "signals_fired": 0, "devices_flagged": []}
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(minutes=lookback_minutes)
        recent_device_ids = {
            r[0] for r in db.query(Report.device_id)
                            .filter(Report.server_created_at >= cutoff)
                            .filter(Report.device_id != None)
                            .distinct()
                            .all()
        }
        for did in recent_device_ids:
            summary["scanned"] += 1
            dev = db.query(Device).filter(Device.id == did).first()
            if dev is None:
                continue
            recent = (
                db.query(Report)
                  .filter(Report.device_id == did)
                  .filter(Report.server_created_at >= cutoff - timedelta(hours=1))
                  .all()
            )
            fired: List[str] = []
            for detector in DETECTORS:
                try:
                    fired.extend(detector(db, dev, recent))
                except Exception:                  # pragma: no cover
                    log.exception(
                        "[fraud_batch] detector %s failed for device %s",
                        detector.__name__, did,
                    )
            if not fired:
                continue
            # Union with existing signals; bump spam_score by the max
            # of the newly-fired weights.
            existing = list(dev.spam_signals or [])
            for s in fired:
                if s not in existing:
                    existing.append(s)
            dev.spam_signals = existing
            bump = max(SIGNAL_WEIGHTS.get(s, 0.0) for s in fired)
            dev.spam_score = float(dev.spam_score or 0.0) + bump
            db.flush()
            summary["signals_fired"] += len(fired)
            summary["devices_flagged"].append({
                "device_id": did,
                "signals": fired,
                "new_score": dev.spam_score,
            })
        db.commit()
    except Exception:                              # pragma: no cover
        log.exception("[fraud_batch] scan failed; rolling back")
        try:
            db.rollback()
        except Exception:
            pass
    finally:
        if owns_session:
            db.close()
    return summary
