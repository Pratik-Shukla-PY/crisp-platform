"""Configure CORS on the CRISP S3 media bucket.

Why we need CORS:
  - The dashboard at https://undp.crisplabs.tech fetches presigned
    media URLs from `<bucket>.s3.<region>.amazonaws.com` (different
    origin).
  - HTML5 <audio> uses byte-range requests for seeking/scrubbing. Range
    requests are subject to CORS preflight; without ALLOW headers the
    browser falls back to "no-cors" mode which works for play() but
    breaks any timeline read (currentTime, duration, seek).
  - <img> with `crossorigin="anonymous"` (used in some chart-export
    paths) also requires CORS to avoid the canvas-tainted error.

What this script writes:
  GET, HEAD on the configured bucket, scoped to known CRISP origins.
  Range + If-Range exposed so the audio player can read seek metadata.
  Cache the preflight for 1h so we don't re-OPTIONS every chunk.

Usage (locally with aws creds OR on EC2 with IAM instance profile):
    cd backend
    python scripts/configure_s3_cors.py                  # dry-run
    python scripts/configure_s3_cors.py --confirm        # apply

Idempotent — boto3 PutBucketCors REPLACES the rule set, so re-running
just resets the canonical config. To add a new origin, edit
ALLOWED_ORIGINS below and re-run.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("configure_s3_cors")

# Origins we serve the dashboard from. Add new prod / staging hosts
# here as they come online — bucket CORS is a deny-by-default config,
# so a missing origin manifests as audio scrubbing being broken in
# that environment only.
ALLOWED_ORIGINS = [
    "https://undp.crisplabs.tech",
    "https://crisplabs.tech",          # apex, in case of future migration
    "http://localhost:3000",           # local dev
    "http://localhost:8000",           # local fastapi serve
    "http://127.0.0.1:3000",
    "http://127.0.0.1:8000",
]

CORS_RULES = {
    "CORSRules": [
        {
            "AllowedMethods": ["GET", "HEAD"],
            "AllowedOrigins": ALLOWED_ORIGINS,
            # `*` is safe here because the bucket is private + every
            # request needs a valid presigned URL (signed query params).
            # The header allowlist matters for preflight — we let the
            # browser send Range, If-Range, etc.
            "AllowedHeaders": ["*"],
            "ExposeHeaders": [
                "Content-Length",
                "Content-Range",
                "Content-Type",
                "ETag",
                "Last-Modified",
                "Accept-Ranges",
                "x-amz-request-id",
                "x-amz-id-2",
            ],
            "MaxAgeSeconds": 3600,
        }
    ]
}


def main(dry_run: bool) -> int:
    bucket = os.getenv("AWS_S3_BUCKET", "").strip()
    region = os.getenv("AWS_REGION", "").strip()
    if not bucket or not region:
        logger.error(
            "AWS_S3_BUCKET and AWS_REGION must be set. "
            "On EC2 the .env.production already has them; locally use:\n"
            "  AWS_S3_BUCKET=crisp-uploads-prod-... AWS_REGION=ap-south-1 "
            "python scripts/configure_s3_cors.py"
        )
        return 2

    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError

    s3 = boto3.client(
        "s3",
        region_name=region,
        endpoint_url=f"https://s3.{region}.amazonaws.com",
        config=Config(signature_version="s3v4"),
    )

    # Read current config so the operator can diff against the new one.
    try:
        current = s3.get_bucket_cors(Bucket=bucket)
        logger.info("Current CORS rules:")
        logger.info(json.dumps(current.get("CORSRules", []), indent=2, default=str))
    except ClientError as e:
        if e.response["Error"]["Code"] == "NoSuchCORSConfiguration":
            logger.info("Current CORS: <none>")
        else:
            logger.warning(f"get_bucket_cors error (continuing): {e}")

    logger.info("Proposed CORS rules:")
    logger.info(json.dumps(CORS_RULES["CORSRules"], indent=2))

    if dry_run:
        logger.info("Dry run — pass --confirm to apply.")
        return 0

    s3.put_bucket_cors(Bucket=bucket, CORSConfiguration=CORS_RULES)
    logger.info(f"PutBucketCors OK on {bucket} ({region}).")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--confirm",
        action="store_true",
        help="Actually call PutBucketCors (default is dry-run).",
    )
    args = parser.parse_args()
    sys.exit(main(dry_run=not args.confirm))
