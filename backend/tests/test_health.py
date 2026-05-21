"""Health endpoint contracts.

`/health` — global liveness (disk free + version).
`/api/v1/health` — mirror of /health under the nginx-proxied prefix (May 21 2026).
`/api/v1/health/pii` — PII-blur backend readiness.
`/api/v1/health/db` — DB connectivity + schema revision (Apr 2026).

The DB-health endpoint was the gap that motivated this file. Before it,
a Postgres outage + a booted uvicorn looked healthy to orchestrators:
`/health` only checked disk space. Now k8s / ECS / ALB can point a
readiness-probe at `/api/v1/health/db` and yank the pod when the
database goes away.

/api/v1/health was added in May 2026 because nginx in PROD only proxies
/api/v1/* to the backend — a browser fetch of /health (the legacy k8s
probe route) hits a 404 at the nginx layer. The mirror endpoint lets
the PWA version-pill resolve the backend version without an nginx
config change.
"""
import pytest


class TestHealthBasic:
    """The global `/health` endpoint (public, no auth)."""

    def test_health_returns_200_with_version(self, client):
        res = client.get("/health")
        assert res.status_code in (200, 503)  # 503 if disk is critical
        body = res.json()
        assert "version" in body
        assert "disk" in body

    def test_health_no_auth_required(self, client):
        """/health is a liveness probe — must never 401/403."""
        res = client.get("/health")
        assert res.status_code != 401
        assert res.status_code != 403


class TestHealthApiV1Mirror:
    """The /api/v1/health endpoint mirrors /health for nginx-proxied access.

    PROD nginx only forwards /api/v1/* to uvicorn. The root /health is
    fine for in-cluster k8s probes (which can target any path), but
    browser-side code reaching the backend through the public ingress
    needs a route under /api/v1/. This pair of tests pins:

      1. Status + shape parity with /health (same fields, same codes).
      2. Public — never 401/403, mirrors /health's no-auth policy.
    """

    def test_api_v1_health_returns_200_with_version(self, client):
        res = client.get("/api/v1/health")
        assert res.status_code in (200, 503)
        body = res.json()
        assert "version" in body
        assert "disk" in body
        assert "status" in body

    def test_api_v1_health_no_auth_required(self, client):
        res = client.get("/api/v1/health")
        assert res.status_code != 401
        assert res.status_code != 403

    def test_api_v1_health_shape_matches_root_health(self, client):
        """The two endpoints must return the same JSON shape so the PWA
        version-pill (which reads body.version) works against either."""
        root = client.get("/health")
        v1 = client.get("/api/v1/health")
        assert root.status_code == v1.status_code
        # Same set of top-level keys.
        assert set(root.json().keys()) == set(v1.json().keys())
        # version field equal — both come from settings.VERSION.
        assert root.json()["version"] == v1.json()["version"]


class TestHealthDB:
    """`/api/v1/health/db` — Apr 2026 explicit DB probe."""

    def test_db_health_returns_200_on_live_postgres(self, client):
        """A live Postgres returns 200. The test fixture creates tables via
        `Base.metadata.create_all()` WITHOUT stamping alembic, so the
        endpoint's status will be 'degraded' (DB reachable, alembic_version
        not populated). This is the intended behaviour — unstamped is not
        an outage. A real prod deployment runs `alembic upgrade head`
        before uvicorn boots and the status would be 'healthy'."""
        res = client.get("/api/v1/health/db")
        assert res.status_code == 200, res.text
        body = res.json()
        # Either 'healthy' (if alembic happens to be stamped) or 'degraded'.
        assert body["status"] in ("healthy", "degraded")
        assert body["driver"].startswith("postgresql"), \
            f"expected postgresql driver, got {body.get('driver')!r}"
        # Latency ≤ 1000 ms on a localhost connection — generous ceiling.
        assert isinstance(body["latency_ms"], (int, float))
        assert body["latency_ms"] < 1000
        # Head is always resolvable (it scans migrations/versions/ on disk).
        assert body["head"] is not None

    def test_db_health_no_auth_required(self, client):
        """Public readiness probe — no 401/403."""
        res = client.get("/api/v1/health/db")
        assert res.status_code not in (401, 403)

    def test_db_health_returns_503_when_db_unreachable(self, client, monkeypatch):
        """Simulate a DB outage by patching the engine to raise on connect.
        The endpoint should return 503 (not 500) so orchestrators can
        distinguish 'unavailable' from 'bug'."""
        import app.main as main_mod

        class _BrokenConn:
            def __enter__(self): raise RuntimeError("simulated DB down")
            def __exit__(self, *a): return False

        class _BrokenEngine:
            url = main_mod.engine.url
            def connect(self): return _BrokenConn()

        monkeypatch.setattr(main_mod, "engine", _BrokenEngine())
        res = client.get("/api/v1/health/db")
        assert res.status_code == 503, res.text
        body = res.json()
        assert body["status"] == "unavailable"
        assert "error" in body
        assert body["driver"].startswith("postgresql")
