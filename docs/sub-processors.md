# Sub-processors — CRISP

**Last updated:** 2026-05-23
**Owner:** project lead (privacy@crisplabs.tech)

This document is the canonical list of every third-party service that processes CRISP user data, prepared in line with UNDP Personal Data Privacy Policy §13 / §14 ("processor and sub-processor") and Annex 2 (d) ("categories of third parties").

Citizens are informed of these categories — but not necessarily the brand names — in the in-app Privacy notice (`#stage-privacy` and the `#home-privacy-sheet`). This file is the operator-facing detail.

## Category 1 — Crisis responders & UNDP analysts

| Role | Receives | Region | Lawful basis | DPA / agreement |
|---|---|---|---|---|
| Crisis response teams (UN, partner NGOs, government agencies) | every report row + media after analyst verification | varies per deployment | UNDP legitimate interest §15(d) | per-crisis MoU |
| UNDP analysts | dashboard access, full report fields including admin-only PII fields when present | varies | UNDP legitimate interest §15(d) | UNDP staff regulations |

## Category 2 — Cloud infrastructure & storage

| Vendor | Service | Receives | Region | DPA |
|---|---|---|---|---|
| Amazon Web Services (AWS) | S3 (media at rest); EC2 (backend compute) | uploaded photos / audio / report rows | `ap-south-1` (Mumbai, India) default for UNDP deployments; configurable per `AWS_REGION` env | AWS Customer Agreement + GDPR DPA |
| PostgreSQL (self-hosted on EC2) | structured report fields | same region as compute | n/a — self-hosted |

## Category 3 — AI verification (truth-scoring)

| Vendor | Model | Receives | Region | DPA |
|---|---|---|---|---|
| Anthropic | Claude Sonnet 4.7 / Claude Haiku 4.5 | one redacted photo (face-blurred) + one satellite tile + structured location/damage metadata, per report | US (Anthropic processing region) | Anthropic Commercial Terms + Enterprise Agreement |

**Note:** the device-fingerprint hash, free-text description, email/phone are **never sent** to Anthropic. Anthropic does not retain inputs for training under our agreement.

## Category 4 — Maps & building footprints

| Vendor | Service | Receives | Region | DPA |
|---|---|---|---|---|
| OpenStreetMap Foundation | OSM tile + Overpass API | bounding box of the reporter's area (not the exact incident location) | EU (osm.org primary) | OSM ODbL |
| Mapbox | Building-footprint vector tiles + style sheet (PWA + RN) | bounding box; never device hash | US/EU | Mapbox Enterprise Terms |

## Category 5 — Messaging gateways

| Vendor | Service | Receives | Region | DPA |
|---|---|---|---|---|
| Twilio | SMS ingress + IVR voice + STT | SMS message body, phone number, voice recording (for IVR), transcribed text | US (Twilio core) | Twilio MSA + DPA |
| Telegram | Bot API ingestion | message body + Telegram user-id (Telegram's pseudonymous id, not ours) | global | Telegram Bot Terms |
| Meta (WhatsApp Business) | Cloud API ingestion | message body + WhatsApp phone number | US/EU | Meta Business Terms |

## Category 6 — Satellite imagery providers

These providers receive only the **bounding box around the reported incident** — never the photo, never the reporter's device code, never the free-text description.

| Vendor | Service | Receives | Region | Notes |
|---|---|---|---|---|
| ESA (Sentinel-2) | satellite imagery API | bounding box | EU | Copernicus open-data licence |
| Microsoft (Planetary Computer) | satellite imagery cache | bounding box | US/EU | Microsoft Open Data Use Agreement |
| ESA (Copernicus DataSpace) | satellite imagery API | bounding box | EU | Copernicus open-data licence |

## Category 7 — Client-side libraries (no data leaves the device)

For transparency: these libraries run **on the user's device** and do not transmit data anywhere. They appear here so the list is exhaustive.

| Library | Purpose | Data flow |
|---|---|---|
| TensorFlow.js + BlazeFace | client-side face detection for PII blur | runs in browser; never transmits |
| Service Worker (`sw.js`) | offline queue, retry on reconnect | local IndexedDB only |
| MediaPipe (server-side mirror) | server-side blur safety-net | runs inside our backend, not a third-party service |

## Change-control

Adding a new sub-processor requires:

1. Update this file with role / region / DPA reference.
2. Update the in-app Privacy notice (`#stage-privacy` section "Where your data goes" + `#home-privacy-sheet` point 6) to keep the categorisation accurate.
3. Update `i18n/en.json` `privacy_recipients_*` keys + backfill across the 14 non-stub locales.
4. Update `docs/dpia.md` risk register if the new vendor introduces a new risk.
5. Notify the project lead at `privacy@crisplabs.tech`.
