"""Generate a VAPID keypair for Web Push (RFC 8292).

VAPID is "Voluntary Application Server Identification" - the mechanism
push providers (APNs, FCM, Mozilla autopush) use to verify that the
server sending a push is the same server that issued the subscription.
We generate ONE keypair per deployment; both halves get persisted to
secrets management.

  • The PUBLIC key gets returned by GET /api/v1/push/vapid-public so
    the PWA can pass it to PushManager.subscribe(). Browsers embed the
    public key into the subscription endpoint URL - so if you rotate
    the public key, every existing subscription becomes invalid.
  • The PRIVATE key signs the JWT we send to providers when delivering
    a push. Lives in env vars + AWS Secrets Manager, never the repo.

Run once per environment:
    cd backend && source venv/bin/activate
    python scripts/generate_vapid.py

Output is two `KEY=value` lines suitable for .env / Secrets Manager.
Append the third (VAPID_CONTACT_EMAIL) yourself - providers use it as
the abuse-contact for your push traffic per RFC 8292 §2.

Re-running this script invalidates every existing push subscription;
keep the original keypair safe and rotate only when forced (e.g.
the private key leaks).
"""
from __future__ import annotations

import base64
from cryptography.hazmat.primitives.asymmetric import ec


def b64u(b: bytes) -> str:
    """URL-safe base64 encode without padding (RFC 7515 §2)."""
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")


def main() -> None:
    private_key = ec.generate_private_key(ec.SECP256R1())
    public_key = private_key.public_key()

    # Public key: uncompressed point per SEC 1 §2.3.3 - `0x04 || X || Y`,
    # 65 bytes total. This is the format browsers expect inside the
    # `applicationServerKey` parameter of PushManager.subscribe().
    pub_numbers = public_key.public_numbers()
    pub_bytes = (
        b"\x04"
        + pub_numbers.x.to_bytes(32, "big")
        + pub_numbers.y.to_bytes(32, "big")
    )

    # Private key: 32-byte big-endian scalar (the "d" value in JWK terms).
    priv_bytes = private_key.private_numbers().private_value.to_bytes(32, "big")

    print(f"VAPID_PUBLIC_KEY={b64u(pub_bytes)}")
    print(f"VAPID_PRIVATE_KEY={b64u(priv_bytes)}")
    print()
    print("# Also set:")
    print("# VAPID_CONTACT_EMAIL=admin@yourdomain.example  # provider abuse-contact (RFC 8292 §2)")
    print()
    print("# Persist BOTH halves to AWS Secrets Manager / .env.production.")
    print("# The PUBLIC key alone is safe to ship to clients via /api/v1/push/vapid-public.")
    print("# Re-running this script invalidates every existing push subscription.")


if __name__ == "__main__":
    main()
