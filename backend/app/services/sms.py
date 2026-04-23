"""SMS sender abstraction — Twilio production, stub for dev.

Phase 1 (Apr 2026 — Optional reporter login) adds phone OTP as a first-
class channel alongside email. Delivery is pluggable via the
`SMS_PROVIDER` env var:

    stub      (default in dev) — logs the code to stdout; no network.
    twilio    — uses TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM.

Production-grade resilience:

  * Rate-limit layer sits ABOVE this (in the /auth/otp/request endpoint)
    so Twilio bills don't blow up on abuse.
  * All failures raise SMSSendError; endpoint translates to a generic
    "could not send code" response — we never surface provider details
    to the client (PII + cost leakage surface).
  * The stub path keeps tests hermetic (no Twilio key needed in CI).
  * E.164 validation is done at this layer — anything else raises
    ValueError before a single byte hits the provider.

Never log the OTP code at INFO or higher in production; stub-mode DOES
log it intentionally so dev loops don't need a real carrier.
"""
from __future__ import annotations

import logging
import os
import re
from typing import Optional

logger = logging.getLogger(__name__)


class SMSSendError(Exception):
    """Raised when the provider fails; endpoint catches + returns 502."""


# E.164 is "+" + country code + up to 15 digits. We keep it strict so an
# accidentally-pasted local number doesn't make it to the provider.
_E164_RE = re.compile(r"^\+[1-9]\d{6,14}$")


def validate_e164(phone: str) -> str:
    """Normalise + validate E.164; raises ValueError on malformed input."""
    if not isinstance(phone, str):
        raise ValueError("phone must be a string")
    p = phone.strip().replace(" ", "").replace("-", "")
    if not _E164_RE.match(p):
        raise ValueError(f"phone is not E.164: {phone!r}")
    return p


def _provider() -> str:
    return os.environ.get("SMS_PROVIDER", "stub").strip().lower()


def send_sms(to_e164: str, body: str) -> None:
    """Dispatch a single SMS. Validates + routes based on SMS_PROVIDER.

    Never raises on the stub path. Raises SMSSendError when a live
    provider call fails so the /auth/otp/request caller can emit
    a 502-class response + log without leaking provider internals.
    """
    to_e164 = validate_e164(to_e164)
    prov = _provider()

    if prov == "stub":
        # Dev / CI — log the body including the code so devs can drive
        # the flow end-to-end without a carrier. Prefixed so the grep is
        # obvious in mixed logs.
        logger.info("[SMS stub] → %s: %s", to_e164, body)
        return

    if prov == "twilio":
        try:
            # Lazy import — we don't want the `twilio` package to be a
            # hard runtime dep on deployments that only use email OTP.
            from twilio.rest import Client  # type: ignore
        except ImportError as e:
            raise SMSSendError(
                "twilio package not installed — pip install twilio or "
                "set SMS_PROVIDER=stub for dev"
            ) from e
        sid = os.environ.get("TWILIO_ACCOUNT_SID")
        tok = os.environ.get("TWILIO_AUTH_TOKEN")
        frm = os.environ.get("TWILIO_FROM")
        if not (sid and tok and frm):
            raise SMSSendError(
                "Twilio env vars missing: TWILIO_ACCOUNT_SID / "
                "TWILIO_AUTH_TOKEN / TWILIO_FROM"
            )
        try:
            client = Client(sid, tok)
            client.messages.create(to=to_e164, from_=frm, body=body)
        except Exception as e:  # twilio.base.exceptions.TwilioRestException etc.
            logger.error("[SMS twilio] send failed to %s: %s", to_e164, e.__class__.__name__)
            raise SMSSendError("SMS provider rejected the send") from e
        return

    raise SMSSendError(f"unknown SMS_PROVIDER: {prov!r}")


def send_otp_sms(to_e164: str, code: str, app_name: str = "CRISP") -> None:
    """Convenience wrapper — formats the OTP body + sends.

    Body is short, provider-friendly, free of localisation strings (the
    client-side app picks the language; this channel is delivery-only)."""
    body = f"{app_name}: Your verification code is {code}. It expires in 10 minutes. Do not share."
    send_sms(to_e164, body)
