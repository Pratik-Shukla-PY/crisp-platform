"""B6 — single-org identity/branding config (config-blob backed, no migration).

Covers GET /config org block, admin-gated PATCH, logo upload + serve, and
validation. Storage is the local test backend; the config blob + logo persist
in the internal (never-public) namespace.
"""
import base64

# 1x1 transparent PNG.
_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAen63NgAAAAASUVORK5CYII="
)


def _hdr(token):
    return {"Authorization": f"Bearer {token}"}


def test_get_config_includes_org_block(client):
    r = client.get("/api/v1/config/")
    assert r.status_code == 200
    org = r.json().get("org")
    assert isinstance(org, dict)
    for k in ("org_name", "org_public_name", "org_primary_color",
              "org_default_language", "org_logo_url"):
        assert k in org


def test_patch_org_requires_admin(client, viewer_token):
    r = client.patch("/api/v1/config/org", json={"org_name": "Nope"}, headers=_hdr(viewer_token))
    assert r.status_code == 403


def test_patch_org_unauthenticated_rejected(client):
    r = client.patch("/api/v1/config/org", json={"org_name": "Nope"})
    assert r.status_code in (401, 403)


def test_patch_org_updates_branding_and_reflects_publicly(client, admin_token):
    r = client.patch(
        "/api/v1/config/org",
        json={"org_public_name": "UNDP Geneva Test",
              "org_primary_color": "#112233", "org_region": "Geneva"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["org_public_name"] == "UNDP Geneva Test"
    assert body["org_primary_color"] == "#112233"
    # Reflected in the public (unauthenticated) GET /config org block.
    pub = client.get("/api/v1/config/").json()["org"]
    assert pub["org_public_name"] == "UNDP Geneva Test"
    assert pub["org_primary_color"] == "#112233"
    assert pub["org_region"] == "Geneva"


def test_patch_org_rejects_bad_color(client, admin_token):
    r = client.patch("/api/v1/config/org", json={"org_primary_color": "red"}, headers=_hdr(admin_token))
    assert r.status_code == 422


def test_admin_get_org_is_uncached(client, admin_token):
    r = client.get("/api/v1/config/org", headers=_hdr(admin_token))
    assert r.status_code == 200
    assert "no-store" in r.headers.get("cache-control", "")


def test_logo_upload_and_serve(client, admin_token):
    up = client.post(
        "/api/v1/config/org/logo",
        files={"file": ("logo.png", _PNG, "image/png")},
        headers=_hdr(admin_token),
    )
    assert up.status_code == 200, up.text
    assert up.json().get("org_logo_url")
    got = client.get("/api/v1/config/org/logo")
    assert got.status_code == 200
    assert got.headers["content-type"].startswith("image/png")
    assert got.content == _PNG


def test_logo_rejects_non_image(client, admin_token):
    r = client.post(
        "/api/v1/config/org/logo",
        files={"file": ("x.txt", b"hello", "text/plain")},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 400


def test_logo_upload_requires_admin(client, viewer_token):
    r = client.post(
        "/api/v1/config/org/logo",
        files={"file": ("logo.png", _PNG, "image/png")},
        headers=_hdr(viewer_token),
    )
    assert r.status_code == 403
