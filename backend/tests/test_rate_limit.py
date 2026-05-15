"""Tests for the distributed rate-limit module (Phase 1.8, May 2026).

The module has two paths:
  1. In-memory fallback (REDIS_URL unset OR Redis unreachable).
  2. Redis-backed atomic counter (REDIS_URL set + reachable).

These tests cover the in-memory fallback (the always-on path) plus
the Redis-backed path using a fakeredis stub to avoid requiring a
live Redis at CI time. The integration tests in
test_api_reports.py cover the legacy `check_rate_limit` callers
end-to-end; this file pins the new dual-backend module's behaviour.
"""
from __future__ import annotations

import time
from unittest.mock import patch

import pytest

from app.services import rate_limit as rl


@pytest.fixture(autouse=True)
def _reset_state():
    """Each test starts with a clean module state — empty in-memory
    bucket and reset Redis-init flags."""
    rl._reset_for_test()
    yield
    rl._reset_for_test()


class TestInMemoryFallback:
    """When REDIS_URL is empty the module falls back to the legacy
    in-process counter. Behaviour MUST be identical to the pre-
    Phase-1.8 `app.main.check_rate_limit` implementation."""

    def test_allows_below_limit(self, monkeypatch):
        # Force the no-Redis path by mocking the settings getter.
        from app.core.config import settings
        monkeypatch.setattr(settings, "REDIS_URL", "")
        # 30 hits at the default cap are all allowed.
        for i in range(30):
            assert rl.check_rate_limit("bucket-a", 30, 60) is True, (
                f"in-memory limiter rejected hit #{i+1} at cap=30"
            )

    def test_rejects_above_limit(self, monkeypatch):
        from app.core.config import settings
        monkeypatch.setattr(settings, "REDIS_URL", "")
        for _ in range(30):
            rl.check_rate_limit("bucket-b", 30, 60)
        # 31st hit MUST be rejected.
        assert rl.check_rate_limit("bucket-b", 30, 60) is False

    def test_keys_are_independent(self, monkeypatch):
        from app.core.config import settings
        monkeypatch.setattr(settings, "REDIS_URL", "")
        # Burn bucket-c to its cap.
        for _ in range(30):
            rl.check_rate_limit("bucket-c", 30, 60)
        assert rl.check_rate_limit("bucket-c", 30, 60) is False
        # bucket-d untouched — must still allow.
        assert rl.check_rate_limit("bucket-d", 30, 60) is True

    def test_window_expiry_resets_count(self, monkeypatch):
        """Old timestamps fall out of the sliding-window deque."""
        from app.core.config import settings
        monkeypatch.setattr(settings, "REDIS_URL", "")
        # Hit 30 times with timestamps that are already EXPIRED (the
        # in-memory backend uses time.time(); we monkeypatch to a
        # value 120 seconds ago).
        now = time.time()
        rl._inmemory_buckets["bucket-e"] = [now - 120 for _ in range(30)]
        # Next hit must be allowed — the prior 30 are outside the
        # 60s window.
        assert rl.check_rate_limit("bucket-e", 30, 60) is True


class TestRedisInitFallback:
    """Setting REDIS_URL doesn't crash the module if Redis is
    unreachable — we log a warning and fall back to in-memory."""

    def test_unreachable_redis_logs_and_falls_back(self, monkeypatch, caplog):
        from app.core.config import settings
        # Point at a port nobody listens on.
        monkeypatch.setattr(settings, "REDIS_URL", "redis://127.0.0.1:1/0")
        with caplog.at_level("WARNING"):
            # First call should attempt Redis, fail, log once, and
            # fall back to in-memory. Subsequent calls reuse the
            # fallback without re-trying Redis on every hit (lazy
            # init is one-shot).
            assert rl.check_rate_limit("unreachable", 1, 60) is True
            assert rl.check_rate_limit("unreachable", 1, 60) is False
        warns = [r for r in caplog.records if "Redis unreachable" in r.message]
        assert len(warns) == 1, (
            f"expected exactly one Redis-unreachable warning; got {len(warns)}"
        )

    def test_empty_redis_url_skips_redis_path(self, monkeypatch, caplog):
        from app.core.config import settings
        monkeypatch.setattr(settings, "REDIS_URL", "")
        with caplog.at_level("WARNING"):
            assert rl.check_rate_limit("noredis", 1, 60) is True
        # Empty URL should NOT log a Redis-unreachable warning —
        # that's the configured-skip path.
        warns = [r for r in caplog.records if "Redis unreachable" in r.message]
        assert warns == []


class TestRedisBackend:
    """Redis-backed path using a fake client. Pins the INCR/EXPIRE
    sequencing + cap behaviour without requiring a real Redis."""

    def test_redis_path_increments_atomically(self, monkeypatch):
        """Inject a fake Redis client whose pipeline.execute() mimics
        atomic INCR + EXPIRE so we exercise the Redis branch of
        check_rate_limit without standing up a server."""
        counters: dict[str, int] = {}

        class FakePipe:
            def __init__(self):
                self.ops = []
            def incr(self, key, amt):
                self.ops.append(("incr", key, amt))
                return self
            def expire(self, key, secs, nx=False):
                self.ops.append(("expire", key, secs, nx))
                return self
            def execute(self):
                results = []
                for op in self.ops:
                    if op[0] == "incr":
                        _, k, amt = op
                        counters[k] = counters.get(k, 0) + amt
                        results.append(counters[k])
                    elif op[0] == "expire":
                        results.append(True)
                return results

        class FakeClient:
            def pipeline(self):
                return FakePipe()
            def ping(self):
                return True

        # Force the lazy-init to return our fake.
        rl._reset_for_test()
        rl._redis_client = FakeClient()
        rl._redis_init_attempted = True

        # 5 hits at cap=5 all pass.
        for i in range(5):
            assert rl.check_rate_limit("redis-bucket", 5, 60) is True, (
                f"Redis path rejected hit #{i+1} at cap=5"
            )
        # 6th hit must be 429'd.
        assert rl.check_rate_limit("redis-bucket", 5, 60) is False
        assert counters["rl:redis-bucket"] == 6

    def test_redis_failure_mid_request_falls_back(self, monkeypatch, caplog):
        """If Redis was reachable at boot but then crashes mid-
        request, we must fall back to in-memory rather than 500."""

        class FlakyClient:
            def pipeline(self):
                raise RuntimeError("redis CLUSTERDOWN")
            def ping(self):
                return True

        rl._reset_for_test()
        rl._redis_client = FlakyClient()
        rl._redis_init_attempted = True

        with caplog.at_level("WARNING"):
            # Should NOT raise — falls back to in-memory.
            assert rl.check_rate_limit("flaky", 1, 60) is True
            assert rl.check_rate_limit("flaky", 1, 60) is False
        warns = [r for r in caplog.records if "mid-flight" in r.message]
        assert len(warns) == 1, "expected one mid-flight Redis warning"


class TestBackwardCompat:
    """The public function alias on `app.main.check_rate_limit` must
    keep working — existing call-sites import it from `app.main`,
    not from the new service module."""

    def test_app_main_check_rate_limit_routes_through_service(self):
        from app import main
        # The symbol on app.main is the SAME function as the one in
        # the service module. Both should hit the same bucket.
        main_fn = main.check_rate_limit
        svc_fn = rl.check_rate_limit
        assert main_fn is svc_fn, (
            "app.main.check_rate_limit must be the service-module alias; "
            "got distinct functions which would mean per-import counter drift"
        )
