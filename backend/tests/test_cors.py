"""CORS policy regression guards.

Apr 2026 — we shipped two CORS hotfixes in a single sprint:
  (a) Stale hardcoded `192.168.1.38:8080` in `.env` made LAN testing
      break when DHCP rotated the Mac's IP to `.49`.
  (b) The dev-mode regex needed RFC 1918 coverage (10.x / 172.16–31.x /
      192.168.x) so same-LAN testers Just Work regardless of lease.

This file pins the dev-mode CORS policy so a future tightening-pass
can't silently narrow what's accepted without the tests going red.

Production CORS is NOT tested here — prod refuses to boot without
`CORS_ORIGINS` set explicitly, and the regex branch is skipped entirely
(`if APP_ENV != "production": _cors_regex = ...`). That behaviour is
covered via the app's boot guards, not by this file.
"""
import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def cors_client(client):
    """Alias for the existing client fixture — keeps test intent local."""
    return client


def _preflight(client: TestClient, origin: str, method: str = "POST", path: str = "/api/v1/auth/login"):
    """Send a CORS preflight and return the response. Cleaner than
    inlining the OPTIONS request shape across every test."""
    return client.options(
        path,
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": "Content-Type",
        },
    )


class TestCORSAllowedOrigins:
    """Dev-mode CORS must accept localhost + RFC 1918 LAN origins."""

    @pytest.mark.parametrize("origin", [
        "http://localhost:8080",
        "http://localhost:8000",
        "http://localhost:3000",
        "http://127.0.0.1:8080",
    ])
    def test_localhost_origins_accepted(self, cors_client, origin):
        res = _preflight(cors_client, origin)
        assert res.status_code == 200, \
            f"preflight from {origin} rejected with {res.status_code}: {res.text}"
        assert res.headers.get("access-control-allow-origin") == origin, \
            f"expected allow-origin header echoing {origin!r}, got " \
            f"{res.headers.get('access-control-allow-origin')!r}"

    @pytest.mark.parametrize("origin", [
        "http://192.168.1.49:8080",   # the Mac's actual DHCP lease during the fix
        "http://192.168.1.100:8000",  # another typical LAN
        "http://10.0.0.5:8080",       # corporate LAN
        "http://172.16.5.10:8080",    # Docker default bridge
        "http://172.31.99.99:3000",   # top of the 172.16-31 range
    ])
    def test_rfc1918_lan_origins_accepted_in_dev(self, cors_client, origin):
        res = _preflight(cors_client, origin)
        assert res.status_code == 200, \
            f"RFC 1918 origin {origin} rejected: {res.status_code}"
        assert res.headers.get("access-control-allow-origin") == origin


class TestCORSRejectedOrigins:
    """Origins OUTSIDE the dev regex must 400 (no CORS headers returned)."""

    @pytest.mark.parametrize("origin", [
        "http://evil.com",
        "http://8.8.8.8:8080",                  # public IP
        "https://malicious.example.com:443",
        "http://172.32.0.1:8080",               # just past the 172.16-31 range
        "http://172.15.0.1:8080",               # just below the range
    ])
    def test_public_and_out_of_range_origins_rejected(self, cors_client, origin):
        res = _preflight(cors_client, origin)
        # FastAPI's CORSMiddleware responds 400 on preflight failure AND
        # omits the allow-origin header. Orchestrators / browsers both
        # treat "no ACAO" as "blocked" regardless of status.
        assert res.status_code == 400, \
            f"expected 400 for {origin}, got {res.status_code}"
        acao = res.headers.get("access-control-allow-origin")
        assert acao is None or acao != origin, \
            f"{origin} should NOT be echoed in allow-origin; got {acao!r}"


class TestCORSConditionalGetHeaders:
    """May 2026 — preflight must allow `If-None-Match` (+ `If-Match`) so the
    dashboard's ETag-conditional delta polling doesn't 400.

    Found via manual local testing: dev cross-origin
    `localhost:8080 -> localhost:8000` fired a preflight that included
    `Access-Control-Request-Headers: if-none-match,authorization`. The
    CORS middleware's `allow_headers` listed only Content-Type, Authorization,
    X-Admin-Key — so the preflight 400'd with "Disallowed CORS headers",
    the browser blocked the actual GET, and the dashboard surfaced
    "Failed to fetch" / showed zero reports despite the backend being
    healthy.

    PROD (same-origin via nginx) doesn't hit this because no preflight
    fires for same-origin requests, but the moment dashboard + API
    diverge (CDN, separate deploys) it would break PROD too. This guard
    pins the dev-mode policy AND the prod-future-proofing.
    """

    @pytest.mark.parametrize("request_headers", [
        "if-none-match",
        "if-none-match,authorization",
        "if-match",
        "if-match,if-none-match,content-type,authorization",
    ])
    def test_conditional_get_headers_in_preflight(self, cors_client, request_headers):
        """Preflight from localhost:8080 listing If-None-Match / If-Match
        in Access-Control-Request-Headers must come back 200 with those
        names in Access-Control-Allow-Headers.
        """
        res = cors_client.options(
            "/api/v1/reports/",
            headers={
                "Origin": "http://localhost:8080",
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": request_headers,
            },
        )
        assert res.status_code == 200, (
            f"preflight with headers={request_headers!r} must succeed; "
            f"got {res.status_code} body={res.text!r}"
        )
        allow_headers = (res.headers.get("access-control-allow-headers") or "").lower()
        for h in [n.strip() for n in request_headers.split(",")]:
            assert h in allow_headers, (
                f"Access-Control-Allow-Headers missing {h!r}; got {allow_headers!r}"
            )
