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
