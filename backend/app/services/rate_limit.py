"""Distributed rate-limit (Phase 1.8, May 2026).

Replaces the in-memory `_rate_limits` dict in ``app.main`` with a
two-tier counter that prefers Redis when available and degrades to
the legacy in-process dict when Redis is unset or unreachable.

Why this matters
================
Production runs N uvicorn workers behind nginx. The legacy in-memory
counter is per-PROCESS, so an attacker sending 30 req/min per worker
got 30·N req/min through the front door — defeating the rate-limit's
fairness story. A coordinated burst at N=8 workers gets ~240 req/min,
which is enough to drown a single device's submission flow.

The fix is a Redis INCR + EXPIRE counter keyed on the same string the
caller already passes (e.g. ``meta:DEV-ABC123``). Redis serialises the
increment, so the count is *correct* regardless of which worker the
request happens to land on.

Algorithm: **fixed-window counter** (not a true sliding window). We
INCR a key, set EXPIRE on the first hit, and bounce when the count
exceeds the cap. Boundary effect: a client can briefly burst 2× the
nominal rate at the window edge. Acceptable trade-off vs.
sliding-window-log complexity (O(N) per request, multi-roundtrip).

UNDP must-have #12 (scale to 500k reports per crisis) — this is the
mechanism that keeps a single misbehaving device from monopolising
the meta-create pipe during a crisis surge.

Backwards compat
================
Public signature unchanged. ``check_rate_limit(key, max_requests=30,
window=60) -> bool`` returns True when the request is allowed and
False when it should be 429'd. The in-memory fallback path is a
literal copy of the legacy implementation, so existing tests pass
unchanged.

Failure mode
============
* ``REDIS_URL`` unset → in-memory fallback (dev + CI + first deploy).
* ``REDIS_URL`` set but unreachable / auth-failed → log once, fall
  back to in-memory for that request. Never raise — a 500 here would
  break submission entirely.
"""
from __future__ import annotations

import logging
import time
from collections import defaultdict
from typing import Optional

logger = logging.getLogger(__name__)

# ── Module-level state ───────────────────────────────────────────────
# Legacy in-memory counter — kept as a fallback when Redis is unset
# or unreachable. defaultdict semantics mirror the original
# `app.main._rate_limits`.
_inmemory_buckets: dict[str, list[float]] = defaultdict(list)

# Cached Redis client (lazy-init on first call). None means "either
# disabled OR fall back to in-memory because of an earlier failure."
_redis_client: Optional[object] = None
_redis_init_attempted: bool = False
_redis_warning_logged: bool = False


def _get_redis():
    """Lazy-init the Redis client.

    Returns ``None`` if REDIS_URL is empty OR if the client failed to
    connect. The failure is logged once at WARNING — after that we
    silently fall back to in-memory until the process restarts.
    """
    global _redis_client, _redis_init_attempted, _redis_warning_logged

    if _redis_init_attempted:
        return _redis_client
    _redis_init_attempted = True

    # Import inside the function so the `redis` package is OPTIONAL.
    # If it's not installed, we skip the Redis path entirely without
    # blowing up at import time of `app.services.rate_limit`.
    try:
        from app.core.config import settings
    except Exception:
        # Config not loadable — only happens during a botched import.
        return None

    url = (settings.REDIS_URL or "").strip()
    if not url:
        # Not configured. The in-memory fallback is the intended path.
        return None

    try:
        import redis  # type: ignore[import-not-found]
        # decode_responses=True returns strings from INCR/GET so the
        # int(...) conversion below is trivial; without it we get
        # bytes and have to .decode() everywhere.
        client = redis.Redis.from_url(
            url,
            socket_connect_timeout=2,
            socket_timeout=2,
            decode_responses=True,
        )
        # Eagerly ping so a misconfigured DSN surfaces as a failure
        # NOW (logged once) instead of on every request. The ping
        # itself is one round-trip and runs at app boot.
        client.ping()
        logger.info("[rate-limit] Redis backend configured (url=%s)", _redact_url(url))
        _redis_client = client
        return client
    except Exception as e:
        if not _redis_warning_logged:
            logger.warning(
                "[rate-limit] Redis unreachable (%s) — falling back to in-memory "
                "counter. This means the rate-limit is per-WORKER instead of "
                "distributed; under multi-worker deploys an attacker effectively "
                "gets Nx the nominal rate. Fix REDIS_URL to restore distributed "
                "limiting.",
                e,
            )
            _redis_warning_logged = True
        _redis_client = None
        return None


def _redact_url(url: str) -> str:
    """Redact the credentials portion of a Redis DSN for logs."""
    try:
        if "@" in url:
            scheme_sep = url.split("://", 1)
            if len(scheme_sep) == 2:
                scheme, rest = scheme_sep
                if "@" in rest:
                    creds, host = rest.rsplit("@", 1)
                    if ":" in creds:
                        user = creds.split(":", 1)[0]
                        return f"{scheme}://{user}:***@{host}"
                    return f"{scheme}://***@{host}"
        return url
    except Exception:
        return "<redacted>"


def _inmemory_check(key: str, max_requests: int, window: int) -> bool:
    """Legacy in-memory rate limiter. Per-worker, NOT distributed.

    Kept as a fallback for tests + dev + when Redis is unreachable.
    Behaviour is identical to the pre-Phase-1.8 implementation.
    """
    now = time.time()
    _inmemory_buckets[key] = [t for t in _inmemory_buckets[key] if now - t < window]
    if len(_inmemory_buckets[key]) >= max_requests:
        return False
    _inmemory_buckets[key].append(now)
    return True


def _redis_check(client, key: str, max_requests: int, window: int) -> bool:
    """Redis-backed fixed-window counter.

    Uses INCR + EXPIRE. The first hit creates the key with TTL=window;
    subsequent hits within the window increment the counter. When
    the counter exceeds ``max_requests`` we return False. After the
    TTL elapses, Redis evicts the key and the next request starts a
    fresh window.

    Atomicity: we use a pipeline so INCR + EXPIRE land in one round-
    trip. EXPIRE is only set when the key is NEW (counter == 1) — if
    it already existed, the TTL is whatever the prior hit set, which
    is exactly what we want for fixed-window semantics.
    """
    prefixed = f"rl:{key}"
    try:
        pipe = client.pipeline()
        pipe.incr(prefixed, 1)
        pipe.expire(prefixed, window, nx=True)
        results = pipe.execute()
        count = int(results[0])
        return count <= max_requests
    except Exception as e:
        # Redis went down mid-request. Log once + fall back to
        # in-memory for THIS request — better degraded than 500.
        global _redis_warning_logged
        if not _redis_warning_logged:
            logger.warning(
                "[rate-limit] Redis request failed mid-flight (%s) — falling back "
                "to in-memory for this request. Counters may drift until Redis "
                "recovers.", e,
            )
            _redis_warning_logged = True
        return _inmemory_check(key, max_requests, window)


def check_rate_limit(key: str, max_requests: int = 30, window: int = 60) -> bool:
    """Returns ``True`` if the request is allowed, ``False`` if the
    caller should respond with HTTP 429.

    Phase 1.8 (May 2026) — backed by Redis when REDIS_URL is set, in-
    memory otherwise. Public signature unchanged from the legacy
    ``app.main.check_rate_limit``.

    Args:
      key: opaque string identifying the bucket (e.g.
        ``f"meta:{device_hash}"``). Two callers sharing a key share
        a counter.
      max_requests: how many requests are allowed inside ``window``
        seconds. Defaults to 30/min.
      window: window length in seconds. Defaults to 60.
    """
    client = _get_redis()
    if client is None:
        return _inmemory_check(key, max_requests, window)
    return _redis_check(client, key, max_requests, window)


def _reset_for_test() -> None:
    """Test-only hook: clear the in-memory bucket and reset the
    Redis-init state so a test can swap the REDIS_URL value and re-
    exercise the lazy-init path."""
    global _redis_client, _redis_init_attempted, _redis_warning_logged
    _inmemory_buckets.clear()
    _redis_client = None
    _redis_init_attempted = False
    _redis_warning_logged = False
