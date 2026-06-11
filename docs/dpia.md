# Data Protection Impact Assessment — CRISP

**Project:** Crisis Response Intelligence Smart Platform (CRISP)
**Submission:** UNDP InnoCentive Challenge (deadline 2026-06-23)
**Document owner:** project lead (privacy@crisplabs.tech)
**Last reviewed:** 2026-05-23

## 1. Purpose of this DPIA

UNDP's Personal Data Privacy Policy §43 requires a Data Protection Impact Assessment for processing activities that pose high risks to the rights and freedoms of data subjects, **especially where new technologies are used**. CRISP combines several such technologies — client-side biometric face detection (BlazeFace), AI multi-modal truth-scoring (Claude vision), multi-channel ingestion of victim-generated content, and satellite imagery cross-checks — applied to data submitted by people who are by definition vulnerable (active crisis victims). A DPIA is therefore mandatory.

## 2. Scope

This DPIA covers every channel through which a citizen report reaches CRISP:

| Channel | Surface | Sub-processors invoked |
|---|---|---|
| PWA (web) | `mobile-app/src/` | AWS S3 (storage), Anthropic Claude (truth-scoring), OpenStreetMap/Mapbox (building footprints), ESA Sentinel-2 / Microsoft Planetary Computer / ESA Copernicus (satellite verification) |
| Android (RN) | `crisp-mobile/` | same as PWA |
| WhatsApp / Telegram | `messaging-bot/{whatsapp,telegram}` | the respective chat platform, then same backend pipeline |
| SMS | `messaging-bot/sms/` | Twilio (carrier ingress), then backend pipeline |
| IVR (voice phone) | `messaging-bot/ivr/` | Twilio voice + speech-to-text, then backend pipeline |

## 3. Data flow

```
Citizen → channel → backend → {
    AWS S3        (media at rest, encrypted)
    Postgres      (report row, structured fields, soft-delete tombstones)
    Claude API    (photo + satellite tile fan-out, ephemeral)
    Satellite providers (bounding box only — never PII)
}
                ↓
Crisis analysts (dashboard, Bearer-auth) → exports (CSV / GeoJSON)
```

## 4. Personal data inventory

| Field | Source | Sensitivity | Notes |
|---|---|---|---|
| Photo / video | user capture | medium (faces blurred client-side before upload) | `client_blur_applied` flag + server safety-net MediaPipe pass |
| Voice note | user record | medium (transcribed; raw audio kept until grace expires) | transcription is server-side |
| Free-text description | user input | medium (user may include identifying detail — analyst training mitigates) | not redacted |
| GPS coordinates (incident) | user capture | low–medium ("location data can be an identifier" — UNDP Annex 1) | not the reporter's home location; tied to the **incident**. As of HC98 the incident coordinates are also burned into served MEDIUM / ORIGINAL photos (visible caption) **and** written as GPS EXIF on those copies — see R12 |
| Crisis / damage / infrastructure classification | user input | low | enums only, no free text |
| Device-fingerprint hash | client-side | low — one-way SHA-256, **pseudonymous** | never reversible |
| Email / phone (optional) | user opt-in (login) | high | only when user explicitly signs in; admin-only fields |

## 5. Identified risks

| # | Risk | Likelihood | Impact | Existing mitigation | Residual risk |
|---|---|---|---|---|---|
| R1 | Faces visible in uploaded photos | medium pre-mitigation | high | Client-side BlazeFace + Gaussian blur; server-side MediaPipe safety-net pass | low |
| R2 | Free-text description contains identifying info | medium | medium | Plain-language consent banner reminds user not to share identifying info; analyst training; reporter can edit before submit | medium |
| R3 | Re-identification via device-fingerprint hash | low — one-way SHA-256 | medium | Hash + salt; no fingerprint database joins | low |
| R4 | Claude API leak (third-party processor exposure) | low — vendor SOC2 + ToS | medium | Anthropic enterprise-grade DPA; only blurred photo + satellite tile sent (no device hash, no name) | low |
| R5 | S3 region drift (data leaving citizen's country) | low — region pinned at deploy time | medium | `AWS_REGION` env var defaults to `ap-south-1` for UNDP-India; disclosed to user in privacy notice | low |
| R6 | Reporter intercepted via metered SMS/IVR carriers | low | medium | Twilio enterprise contract; encrypted in transit; no PII in SMS body beyond what user wrote | low–medium |
| R7 | Cross-channel correlation (same device → multiple channels) | low — channels do not share device hash by default | low | Per-channel hashing; analyst joins are admin-only | low |
| R8 | Children submitting reports | medium — no age verification | high | Privacy notice asks children under 16 to report through a trusted adult; analyst escalation if visible in content | medium |
| R9 | Vulnerable subject re-identification via incident location + small population | medium in low-density regions | high | k-anonymity (≥3) on `/reports/nearby`; reports clustered to bounding boxes for public-facing maps | medium |
| R10 | Data retention drift — reports kept indefinitely | medium without policy | medium | Soft-delete + 24-hour grace on user request; analyst-driven close-out shortens default | medium |
| R11 | Breach (S3 misconfiguration, code exfiltration) | low — repo open source + reviewed | high | Server-side encryption at rest; IAM role narrowly scoped; gitleaks pre-commit; SENTRY error tracking | low–medium |
| R12 | Incident location embedded in downloadable / shareable image bytes — visible caption watermark **and** GPS EXIF — on served MEDIUM / ORIGINAL photos (HC98) | medium — by design, for responder traceability | medium | Incident-not-home location (same exposure as the on-screen overlay, now travelling with the file); a pristine **un-stamped** original is retained in the internal `pre_blur/archival/` namespace (never served publicly); burn-in runs **after** PII blur so redactions are never undone; SMALL thumbnails excluded; operator can disable per deployment via `CRISP_GEOTAG_WATERMARK_ENABLED` / `CRISP_GEOTAG_EXIF_ENABLED` | medium |
| R13 | Automated decision-making (Claude truth-scoring + AI-suggested classification on voice/SMS) without disclosure or a human-review right (Annex 2 (f)) | medium pre-mitigation | medium | The AI assessment is **advisory only** — it never blocks, rejects, or deletes a report, and a human analyst reviews reports before action. The privacy notice now discloses the automated processing and offers human review on request (`privacy_adm_title` / `privacy_adm_body` in the consent/privacy flow; contact `privacy@crisplabs.tech`) | low |

## 6. Mitigation roadmap (post-submission)

| # | Action | Owner | Target |
|---|---|---|---|
| M1 | Implement "Export my data" (user-side access — currently labelled "coming soon") | engineering | Q3 2026 |
| M2 | Implement in-place edit on submitted reports (correction without delete-and-resubmit) | engineering | Q3 2026 |
| M3 | Per-locale translation of HC48 privacy disclosures (currently EN-fallback) | i18n team | Q3 2026 |
| M4 | Annual DPIA review + retention-policy review (UNDP Annex 3 obligation) | project lead | every 12 months |
| M5 | k-anonymity threshold tunable by deployment region (currently fixed at 3) | engineering | Q4 2026 |
| M6 | Vulnerable-population analyst guidelines + escalation workflow | UNDP partnership | pre-deploy each crisis |

## 7. Outcome

The processing is **proportionate to the public-interest objective** (faster, more accurate crisis response). Residual risks have been documented and are individually low–medium with the mitigations in place. The processing is **lawful, fair, transparent, and necessary** under UNDP §15(d) ("UNDP legitimate interest in fulfilling its mandate"), supported by the user's explicit consent (§15(a)) as the additional lawful basis.

**Conclusion: cleared to proceed.** Reviewable annually or on material technology change (new sub-processor, new AI model class, new channel).

## 8. Sign-off

| Role | Name | Signature | Date |
|---|---|---|---|
| Project lead | Pratik Kumar Shukla | _to-sign_ | 2026-05-23 |
| UNDP partnership contact | _tbd_ | | |
| Data-protection reviewer | _tbd_ | | |
