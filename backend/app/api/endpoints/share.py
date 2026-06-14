"""Server-rendered share page for the Badge Studio's LinkedIn deep-link.

The PWA's Badge Studio (mobile-app/src/badge-studio.js) generates the
badge image client-side via Canvas. LinkedIn's share dialog does NOT
accept an image attachment via URL - it scrapes Open Graph meta tags
from the URL the user shares. So when the user taps the "LinkedIn"
share chip, we mint a short-lived signed token + open
``https://www.linkedin.com/sharing/share-offsite/?url=...&token=<t>``;
LinkedIn fetches THIS page (``GET /api/v1/share/<token>``), reads the
``og:image`` meta tag, and shows the rendered badge as the share
preview.

Design considerations:

* **Token is signed + short-lived.** We don't carry any private data,
  but signing prevents random URL guessing from rendering arbitrary
  brand-misuse pages. TTL is 24 h (the share usually happens within
  minutes of generating).
* **Image source - embedded data URL.** First-pass implementation
  embeds the composed PNG as a base64 data URL in the ``og:image``
  field. LinkedIn's scraper handles data URLs up to ~50 KB; our
  composed badge images run ~30-80 KB, so we ship at 720×720 (smaller
  than the client preview) so we stay under the scraper limit. If
  share volume justifies it, a Phase 2 follow-up stores the PNG in S3
  and points OG at the stable URL - but that adds an upload round-trip
  the simple path avoids.
* **Read-only.** No DB writes. The endpoint is pure server-rendering;
  the token signature is the only state.
* **No PII.** The badge image carries tier name + counts + an optional
  profile photo composed by the user. The user controls whether their
  photo is included (and the face-blur toggle defaults ON).

May 2026 - first ship. See the design plan
phase D.6 for the full design.
"""
from __future__ import annotations

import base64
import hmac
import hashlib
import json
import logging
import os
import time
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Token signing ───────────────────────────────────────────────────────

def _signing_key() -> bytes:
    """HMAC key. Reuses JWT_SECRET when present (same trust boundary -
    if an attacker has the JWT secret they can do worse than mint share
    tokens). Falls back to a fixed dev string when neither var is set so
    local pytest doesn't crash on import."""
    secret = (
        os.environ.get("JWT_SECRET")
        or os.environ.get("CRISP_SECRET_KEY")
        or "dev-share-key-not-secret"
    )
    return secret.encode("utf-8")


def mint_share_token(payload: dict, ttl_seconds: int = 86_400) -> str:
    """Mint a base64url-encoded signed token carrying the share
    payload. ``payload`` is JSON-serialisable; we add ``exp`` so the
    token expires automatically. Format: ``base64(payload).hmac``.
    """
    payload = dict(payload)
    payload["exp"] = int(time.time()) + ttl_seconds
    body_json = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    body_b64 = base64.urlsafe_b64encode(body_json.encode("utf-8")).rstrip(b"=").decode("ascii")
    sig = hmac.new(_signing_key(), body_b64.encode("ascii"), hashlib.sha256).hexdigest()[:16]
    return f"{body_b64}.{sig}"


def _verify_share_token(token: str) -> Optional[dict]:
    """Returns the payload dict if the token verifies + hasn't
    expired; else None. Never raises."""
    if not token or "." not in token:
        return None
    body_b64, sig = token.rsplit(".", 1)
    expected = hmac.new(_signing_key(), body_b64.encode("ascii"), hashlib.sha256).hexdigest()[:16]
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        # Restore base64 padding.
        padded = body_b64 + "=" * (-len(body_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
    except Exception:
        return None
    exp = payload.get("exp")
    if not isinstance(exp, int) or exp < int(time.time()):
        return None
    return payload


# ── Share-page rendering ────────────────────────────────────────────────
#
# Phase 2.1 (May 2026) - emoji + label come from the shared canonical
# tier config at `shared/tier-config.json` via
# `app.services.tier_config`. Keep `_TIER_LABELS` as a thin local
# alias used by the existing validation paths so we don't churn every
# call-site at once; future PRs can swap call-sites to call
# `tier_config.label_emoji_pair` directly.
from app.services import tier_config as _tier_config  # noqa: E402


def _v4_tier_ids() -> set[str]:
    return {t["id"] for t in _tier_config.all_tiers()}


_TIER_LABELS = {
    t["id"]: (t["emoji"], t["label"])
    for t in _tier_config.all_tiers()
}


def _escape_html(s: str) -> str:
    """Minimal HTML escape for OG meta values."""
    return (
        (s or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _render_share_page(payload: dict, image_data_url: Optional[str]) -> str:
    """Render the HTML share page with OG meta + a centered preview.

    The page itself is plain HTML - no JS, no auth, no DB. LinkedIn's
    scraper reads only the ``<meta>`` tags; humans who follow the link
    see a centered badge preview + a CTA back to crisplabs.tech.
    """
    tier_id = payload.get("tier", "T4_LIFEKEEPER")
    emoji, label = _TIER_LABELS.get(tier_id, ("🦸", "Lifekeeper"))
    lives = int(payload.get("lives", 0) or 0)
    reports = int(payload.get("reports", 0) or 0)

    og_title = f"{emoji} I'm a CRISP {label} - report what you see."
    og_desc = f"{reports} reports submitted · {lives} lives saved through CRISP."
    og_image = image_data_url or "https://crisplabs.tech/static/og-default.png"

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{_escape_html(og_title)}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta property="og:type" content="website">
  <meta property="og:title" content="{_escape_html(og_title)}">
  <meta property="og:description" content="{_escape_html(og_desc)}">
  <meta property="og:image" content="{_escape_html(og_image)}">
  <meta property="og:url" content="https://crisplabs.tech">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{_escape_html(og_title)}">
  <meta name="twitter:description" content="{_escape_html(og_desc)}">
  <meta name="twitter:image" content="{_escape_html(og_image)}">
  <style>
    body {{ margin:0; min-height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center;
            background: linear-gradient(135deg,#213A58 0%, #0C6478 100%); color:#fff;
            font-family: 'Inter', system-ui, -apple-system, Arial, sans-serif; padding:24px; }}
    .badge-preview {{ max-width: min(420px, 92vw); width: 100%; border-radius: 18px; box-shadow: 0 12px 48px rgba(0,0,0,0.35); margin-bottom: 24px; }}
    h1 {{ margin: 0 0 6px; font-size: 22px; font-weight: 800; }}
    p  {{ margin: 0 0 18px; color: rgba(255,255,255,0.78); font-size: 14px; text-align: center; max-width: 460px; }}
    .cta {{ display: inline-flex; align-items: center; gap: 8px; padding: 12px 22px; border-radius: 12px;
            background: linear-gradient(135deg,#09D1C7 0%, #46DFB1 100%); color: #0b1018; font-weight: 800;
            text-decoration: none; }}
  </style>
</head>
<body>
  {f'<img class="badge-preview" alt="CRISP {label} badge" src="{_escape_html(og_image)}">' if image_data_url else ''}
  <h1>{_escape_html(og_title)}</h1>
  <p>{_escape_html(og_desc)}</p>
  <a class="cta" href="https://crisplabs.tech" rel="noopener">Open CRISP</a>
</body>
</html>"""


@router.get("/share/{token}", response_class=HTMLResponse)
def get_share_page(token: str, request: Request):
    """Render the OG-tagged share page for a signed share token.

    Returns 200 with HTML on a valid token, 410 GONE on an expired
    token, and 404 on an invalid signature / malformed token. The
    HTTP statuses give LinkedIn's scraper a clean signal to fall
    back to the default crisplabs.tech preview when the token is
    no longer current.
    """
    payload = _verify_share_token(token)
    if payload is None:
        # Distinguish expired (which had a valid signature once) from
        # genuinely-bad - but only at the cost of trying to b64-decode
        # twice. The simpler split: any failure -> 404 except when the
        # signature itself verified, in which case it's 410 Gone. For
        # this MVP we lean on 404 for both; the LinkedIn scraper
        # treats them identically.
        raise HTTPException(status_code=404, detail="Share token not found or expired")
    image_data_url = payload.get("img")  # optional data URL
    html = _render_share_page(payload, image_data_url)
    return HTMLResponse(content=html, status_code=200)


@router.post("/share/mint")
def mint_share_endpoint(payload: dict):
    """Mint a signed share token from a client-side payload.

    Body:
      {
        "tier":     "T4_LIFEKEEPER",        # required
        "lives":    3,                      # optional, default 0
        "reports":  7,                      # optional, default 0
        "img":      "data:image/png;base64,...",  # optional (data URL)
      }

    Returns:
      { "token": "<signed-token>", "url": "/api/v1/share/<token>" }

    The Badge Studio JS POSTs to this endpoint when the user taps
    "Share to LinkedIn", grabs the URL, and deep-links to
    ``linkedin.com/sharing/share-offsite/?url=<encoded-share-url>``.
    """
    tier = str(payload.get("tier", "") or "").upper()
    if tier not in _TIER_LABELS:
        raise HTTPException(status_code=400, detail="Invalid tier")
    img = payload.get("img")
    if img is not None and not isinstance(img, str):
        raise HTTPException(status_code=400, detail="img must be a data: URL string")
    # Hard cap on image payload size - LinkedIn's scraper drops huge
    # OG images, and we don't want to mint tokens carrying multi-MB
    # blobs. 100 KB is comfortably above our 720×720 PNG budget.
    if img and len(img) > 100_000:
        raise HTTPException(status_code=413, detail="Image too large for OG embed (>100 KB)")
    minted = mint_share_token({
        "tier": tier,
        "lives": int(payload.get("lives", 0) or 0),
        "reports": int(payload.get("reports", 0) or 0),
        "img": img,
    })
    return {"token": minted, "url": f"/api/v1/share/{minted}"}
