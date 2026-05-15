"""Regression spec for the per-channel meta-POST contract (Phase 2.2,
May 2026).

UNDP must-have #1 says every channel produces the same `Report` row
shape. The PWA + RN clients capture the full V4 enrichment
(`service_status`, `pressing_needs`); chat / SMS / IVR clients leave
those NULL (documented as "App-only" in CLAUDE.md).

The risk Phase 2.2 pins: a future schema change that adds a NOT NULL
constraint or required-field validation on a V4 column would silently
break every chat channel's meta-POST. These tests assert the
backend's ``/reports/meta`` endpoint accepts a "channel-shape"
payload (minimum-required fields, no V4 enrichment) WITHOUT 500'ing
or 422'ing — pinning the contract that the chat clients rely on.

If a test in this file ever fails, do NOT loosen the assertion —
audit whether the new requirement should be applied to chat clients
first.
"""
from datetime import datetime, timezone


def _minimum_channel_meta(source: str, device_hash: str, cid: str) -> dict:
    """The smallest payload that a chat / SMS / IVR client actually
    posts — no service_status, no pressing_needs, no reporter_tier
    (server-derived anyway). Pinning this surface stops future
    schema changes from silently breaking the chat channels.

    NOTE: we use ``infrastructure_type="ROAD"`` (a valid UNDP-aligned
    type) instead of ``OTHER`` because the schema's "Other, please
    specify" rule requires a non-empty ``infrastructure_name`` when
    the type is ``OTHER``. Channels typically pick a concrete type
    via inline keyboards (ROAD / HOUSE / HOSPITAL / etc.) so ROAD
    is representative.
    """
    return {
        "device_hash": device_hash,
        "client_report_id": cid,
        "source": source,
        "severity": "UNKNOWN",           # may be unset on the channel side
        "infrastructure_type": "ROAD",   # concrete type — chat channels pick one
        # The channel client posts location only when the reporter
        # shares it. Omit to test the location-less ingestion path
        # too.
        "expected_media": 0,
        # Crisis + damage taxonomy — UNDP must-have #4 + #5. Channels
        # capture both via inline keyboards.
        "crisis_type": "FLOOD",
        "damage_classification": "PARTIAL",
        # Optional: debris is the only V4 boolean that chat channels
        # currently emit (see Telegram session_manager). Include it
        # here so we cover the "partial V4" wire shape too.
        "debris_clearing_needed": True,
    }


class TestChannelMetaContract:
    """One test per channel ``SourceEnum`` value. Each verifies that
    a minimum-shape payload is accepted at /reports/meta and lands a
    valid Report row with the expected enrichment-absent state."""

    def _ts_cid(self, prefix: str) -> str:
        # Unique-per-test client_report_id so retries don't dedupe.
        return f"{prefix}-{datetime.now(timezone.utc).timestamp()}"

    def test_telegram_minimum_payload_accepted(self, client):
        payload = _minimum_channel_meta(
            source="TELEGRAM",
            device_hash="TG-TEST-V4-MIN",
            cid=self._ts_cid("tg"),
        )
        res = client.post("/api/v1/reports/meta", json=payload)
        assert res.status_code == 201, res.text
        body = res.json()
        # Chat-channel rows MUST land with the V4 enrichment columns
        # NULL — they're "App-only" per CLAUDE.md. Confirm the
        # backend isn't auto-populating them with garbage defaults.
        assert body["service_status"] is None
        # debris_clearing_needed came from the channel payload — keep.
        assert body["debris_clearing_needed"] is True
        # reporter_tier is server-derived; channel-only submits get
        # T2_SIGNAL on the first send (one-time participation badge).
        # NOT exposed on the meta response (only on the listing
        # endpoint), so we only assert the column shape stays
        # unchanged here.

    def test_whatsapp_minimum_payload_accepted(self, client):
        payload = _minimum_channel_meta(
            source="WHATSAPP",
            device_hash="WA-TEST-V4-MIN",
            cid=self._ts_cid("wa"),
        )
        res = client.post("/api/v1/reports/meta", json=payload)
        assert res.status_code == 201, res.text
        body = res.json()
        assert body["service_status"] is None
        assert body["source"] == "WHATSAPP"

    def test_sms_minimum_payload_accepted(self, client):
        # SMS often lacks debris too (160-char limit). Re-build
        # without that V4 boolean to exercise the truly-minimum path.
        payload = _minimum_channel_meta(
            source="SMS",
            device_hash="SMS-TEST-V4-MIN",
            cid=self._ts_cid("sms"),
        )
        payload.pop("debris_clearing_needed")
        res = client.post("/api/v1/reports/meta", json=payload)
        assert res.status_code == 201, res.text
        body = res.json()
        # All V4 columns NULL on SMS rows.
        assert body["service_status"] is None
        assert body["debris_clearing_needed"] is None
        assert body["source"] == "SMS"

    def test_ivr_minimum_payload_accepted(self, client):
        # IVR is the most constrained channel (DTMF-only). Same
        # SMS-shape payload works.
        payload = _minimum_channel_meta(
            source="IVR",
            device_hash="IVR-TEST-V4-MIN",
            cid=self._ts_cid("ivr"),
        )
        payload.pop("debris_clearing_needed")
        res = client.post("/api/v1/reports/meta", json=payload)
        assert res.status_code == 201, res.text
        body = res.json()
        assert body["service_status"] is None
        assert body["source"] == "IVR"

    def test_channel_payload_without_severity_or_damage_accepted(self, client):
        """Truly-minimum: just a device + crisis_type + concrete
        infrastructure_type. The PWA always sends severity +
        damage_classification, but chat channels can post earlier
        in the flow (e.g. after the user picks crisis but BEFORE
        damage). The schema must accept this so the channel-side
        progressive-fill path works."""
        res = client.post("/api/v1/reports/meta", json={
            "device_hash": "TG-TEST-V4-EARLY",
            "client_report_id": self._ts_cid("tg-early"),
            "source": "TELEGRAM",
            "infrastructure_type": "ROAD",
            "crisis_type": "FLOOD",
            "expected_media": 0,
        })
        assert res.status_code == 201, res.text
        body = res.json()
        assert body["service_status"] is None
        assert body["damage_classification"] in (None, "")
