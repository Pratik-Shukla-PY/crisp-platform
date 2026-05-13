"""Backend tests for the Badge Studio share endpoint (May 2026 reward v2).

Covers:
  * POST /api/v1/share/mint  — token minting + image-size cap
  * GET  /api/v1/share/<token> — share-page render with OG meta
  * Token signing + expiry semantics

The endpoint is public (no auth gate) — the token signature IS the
state. Tests verify a tampered token is rejected + a valid token
emits LinkedIn-scrapable og:* meta tags.
"""
import time
import pytest
from fastapi.testclient import TestClient


class TestMintEndpoint:
    """POST /share/mint accepts a tier + counts + optional image and
    returns a signed token. Validates input + image-size cap."""

    def test_mint_valid_payload_returns_token_and_url(self, client):
        res = client.post("/api/v1/share/mint", json={
            "tier": "T4_LIFEKEEPER",
            "lives": 3,
            "reports": 7,
        })
        assert res.status_code == 200, res.text
        body = res.json()
        assert "token" in body
        assert body["url"].startswith("/api/v1/share/")
        # The token must round-trip through verification.
        token = body["token"]
        gres = client.get(body["url"])
        assert gres.status_code == 200

    def test_mint_rejects_invalid_tier(self, client):
        res = client.post("/api/v1/share/mint", json={
            "tier": "GOLD_HERO",  # not in TIER_LABELS
            "lives": 1,
        })
        assert res.status_code == 400

    def test_mint_caps_image_size(self, client):
        # Build a fake data URL larger than 100 KB.
        big_b64 = "A" * 150_000
        res = client.post("/api/v1/share/mint", json={
            "tier": "T3_CHANGEMAKER",
            "img": f"data:image/png;base64,{big_b64}",
        })
        assert res.status_code == 413
        assert "too large" in res.json()["detail"].lower()

    def test_mint_accepts_small_image(self, client):
        # Small valid data URL — minted OK.
        small_b64 = "A" * 1000
        res = client.post("/api/v1/share/mint", json={
            "tier": "T3_CHANGEMAKER",
            "img": f"data:image/png;base64,{small_b64}",
            "lives": 1,
            "reports": 4,
        })
        assert res.status_code == 200


class TestSharePageRendering:
    """GET /share/<token> renders an HTML page with OG meta tags."""

    def _mint(self, client, **kwargs):
        payload = {"tier": "T4_LIFEKEEPER", "lives": 3, "reports": 7, **kwargs}
        res = client.post("/api/v1/share/mint", json=payload)
        assert res.status_code == 200
        return res.json()["token"]

    def test_render_returns_html_with_og_meta(self, client):
        token = self._mint(client)
        res = client.get(f"/api/v1/share/{token}")
        assert res.status_code == 200
        assert res.headers["content-type"].startswith("text/html")
        html = res.text
        # Tier label + counts must appear in the OG title/description.
        assert 'property="og:title"' in html
        assert 'property="og:description"' in html
        assert 'property="og:image"' in html
        assert "Lifekeeper" in html
        assert "7 reports" in html
        assert "3 lives" in html

    def test_render_with_embedded_image_data_url(self, client):
        # Minted with an image — the og:image content must carry the
        # data URL verbatim so LinkedIn's scraper can render it.
        small_b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII="
        token = self._mint(client, img=f"data:image/png;base64,{small_b64}")
        res = client.get(f"/api/v1/share/{token}")
        assert res.status_code == 200
        assert f"data:image/png;base64,{small_b64}" in res.text

    def test_render_rejects_tampered_token(self, client):
        token = self._mint(client)
        # Flip a character in the signature half — verification must fail.
        body_b64, sig = token.rsplit(".", 1)
        tampered_sig = "f" * len(sig) if sig[0] != "f" else "0" * len(sig)
        res = client.get(f"/api/v1/share/{body_b64}.{tampered_sig}")
        assert res.status_code == 404

    def test_render_rejects_garbage_token(self, client):
        res = client.get("/api/v1/share/totally-not-a-token")
        assert res.status_code == 404


class TestTokenExpiry:
    """Expired tokens (past their `exp` claim) must be rejected."""

    def test_expired_token_returns_404(self, client):
        # Use the helper directly so we can mint with ttl=0.
        from app.api.endpoints.share import mint_share_token
        token = mint_share_token({"tier": "T4_LIFEKEEPER"}, ttl_seconds=0)
        # Sleep enough to push exp into the past (mint sets exp=now+0=now).
        time.sleep(1.1)
        res = client.get(f"/api/v1/share/{token}")
        assert res.status_code == 404


class TestSecurityInvariants:
    """Defense-in-depth checks: no XSS via OG meta values, etc."""

    def test_html_escapes_in_og_meta(self, client):
        # Mint with a tier we know is sanitized (the endpoint only
        # accepts known TIER_LABELS), so we can't really inject via
        # tier. But the tier label values are statically defined in
        # share.py — we just confirm no raw `<script>` ever leaks
        # into output even when the image payload includes a script
        # tag in the data URL (shouldn't, but defensive).
        token_res = client.post("/api/v1/share/mint", json={
            "tier": "T2_SIGNAL",
            "img": "data:image/png;base64,abc<script>alert(1)</script>",
        })
        assert token_res.status_code == 200
        token = token_res.json()["token"]
        res = client.get(f"/api/v1/share/{token}")
        assert res.status_code == 200
        # The raw `<script>` must be HTML-escaped in the og:image meta.
        assert "<script>" not in res.text
        assert "&lt;script&gt;" in res.text
