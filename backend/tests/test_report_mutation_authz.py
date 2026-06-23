"""Authz gate for report-mutation endpoints (post-submission hardening).

A bare report_id leaks via /evidence share links, so an anonymous caller must
not be able to edit/relocate/reclassify a report once enforcement is on.
Allowed callers: the owning device (device_hash), an authenticated ANALYST+,
or a channel bot (X-Bot-Key == CRISP_BOT_KEY). Enforcement is gated by
CRISP_ENFORCE_REPORT_MUTATION_AUTH so the rollout is non-breaking by default.
"""
import pytest

BOT_KEY = "test-bot-key-123"


def _seed(client, device_hash):
    r = client.post("/api/v1/reports/meta", json={
        "device_hash": device_hash,
        "client_report_id": f"authz-{device_hash}",
        "source": "APP",
        "severity": "MODERATE",
        "infrastructure_type": "ROAD",
        "location": {"latitude": 12.97, "longitude": 77.59},
        "expected_media": 1,
    })
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.fixture(autouse=True)
def _enforce(monkeypatch):
    # This module asserts the gate, so run with enforcement ON by default.
    monkeypatch.setenv("CRISP_ENFORCE_REPORT_MUTATION_AUTH", "1")
    monkeypatch.setenv("CRISP_BOT_KEY", BOT_KEY)


def test_anon_mutation_rejected_when_enforced(client):
    rid = _seed(client, "authz-anon")
    r = client.patch(f"/api/v1/reports/{rid}/description",
                     json={"description": "edited by attacker"})
    assert r.status_code == 403, r.text


def test_owning_device_allowed(client):
    dh = "authz-owner"
    rid = _seed(client, dh)
    r = client.patch(f"/api/v1/reports/{rid}/description",
                     json={"description": "edited by owner", "device_hash": dh})
    assert r.status_code == 200, r.text


def test_analyst_allowed(client, analyst_token):
    rid = _seed(client, "authz-analyst")
    r = client.patch(f"/api/v1/reports/{rid}/description",
                     json={"description": "edited by analyst"},
                     headers={"Authorization": f"Bearer {analyst_token}"})
    assert r.status_code == 200, r.text


def test_bot_key_allowed_on_classify(client):
    rid = _seed(client, "authz-bot")
    r = client.patch(f"/api/v1/reports/{rid}/classify",
                     json={"severity": "SEVERE"},
                     headers={"X-Bot-Key": BOT_KEY})
    assert r.status_code == 200, r.text


def test_wrong_bot_key_rejected(client):
    rid = _seed(client, "authz-wrongbot")
    r = client.patch(f"/api/v1/reports/{rid}/classify",
                     json={"severity": "SEVERE"},
                     headers={"X-Bot-Key": "WRONG"})
    assert r.status_code == 403, r.text


def test_location_gate_enforced_then_owner(client):
    dh = "authz-loc"
    rid = _seed(client, dh)
    anon = client.patch(f"/api/v1/reports/{rid}/location",
                        json={"latitude": 1.0, "longitude": 2.0})
    assert anon.status_code == 403, anon.text
    owner = client.patch(f"/api/v1/reports/{rid}/location",
                         json={"latitude": 1.0, "longitude": 2.0, "device_hash": dh})
    assert owner.status_code == 200, owner.text


def test_disabled_enforcement_allows_anon(client, monkeypatch):
    monkeypatch.setenv("CRISP_ENFORCE_REPORT_MUTATION_AUTH", "0")
    rid = _seed(client, "authz-off")
    r = client.patch(f"/api/v1/reports/{rid}/description",
                     json={"description": "back-compat allowed while flag off"})
    assert r.status_code == 200, r.text
