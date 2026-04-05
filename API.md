# CRISP API Reference

Base URL: `http://localhost:8000/api/v1`

Interactive Swagger docs: `http://localhost:8000/docs`

---

## Reports

### Create Report (Full)
```
POST /reports/
Content-Type: application/json

Body: {
  "device_hash": "DEV-XXXXXXXX",
  "client_report_id": "uuid",
  "source": "APP|WHATSAPP|TELEGRAM|SMS|IVR",
  "severity": "CRITICAL|SEVERE|MODERATE|MINOR|UNKNOWN",
  "infrastructure_type": "WATER|ROAD|HOSPITAL|HOUSE|POWER|OTHER",
  "description": "text",
  "location": { "latitude": 12.93, "longitude": 77.62 },
  "media": [{ "type": "IMAGE|AUDIO", "url": "base64...", "resolution_tier": "LOW" }]
}
```

### Create Report (Metadata Only — Progressive Upload Stage 1)
```
POST /reports/meta
Content-Type: application/json

Body: {
  "device_hash": "DEV-XXXXXXXX",
  "client_report_id": "uuid",
  "source": "IVR",
  "severity": "SEVERE",
  "infrastructure_type": "OTHER",
  "description": "text",
  "expected_media": 2,
  "caller_info": { "phone": "+91...", "network_city": "...", "network_state": "..." },
  "location": { "latitude": 12.93, "longitude": 77.62, "device_location_name": "..." }
}
```

### List Reports
```
GET /reports/?skip=0&limit=100&include_deleted=false
```

### Upload Media Chunk (Progressive Upload Stage 2)
```
POST /reports/{report_id}/chunk
Content-Type: application/json

Body: {
  "media_id": "uuid",
  "type": "IMAGE|AUDIO",
  "seq_num": 0,
  "total_chunks": 42,
  "data": "base64...",
  "checksum": "DJB2 hex (08x format)"
}
```

### Update Description
```
PATCH /reports/{report_id}/description
Body: { "description": "updated text" }
```

### Update Classification
```
PATCH /reports/{report_id}/classify
Body: { "infrastructure_type": "WATER", "severity": "SEVERE", "description": "..." }
```

### Update Location
```
PATCH /reports/{report_id}/location
Body: { "latitude": 12.93, "longitude": 77.62, "device_location_name": "..." }
```

### Update AI Summary
```
PATCH /reports/{report_id}/ai-summary
Body: { "ai_summary": "Clean English summary", "transcription": "raw Whisper output" }
```

---

## Verification & Assessment

### Satellite Verification (Admin-Triggered)
```
POST /reports/{report_id}/verify

Response: {
  "total_score": 72,
  "verdict": "LIKELY_AUTHENTIC",
  "scores": { "location_authenticity": 20, "damage_corroboration": 18, ... },
  "satellite_image_url": "/static/sat_xxx.png",
  "satellite_image_url_alt": "/static/sat_xxx_alt.png",
  "key_findings": ["..."],
  "caveats": ["..."],
  "photo_analysis": "...",
  "satellite_scene_description": "..."
}
```

### AI Assessment (Admin-Triggered, One-Time)
```
POST /reports/{report_id}/ai-assess
Content-Type: application/json

Body: {
  "infrastructure_type": "WATER",
  "severity": "SEVERE",
  "source": "IVR",
  "description": "...",
  "transcription": "...",
  "has_image": false,
  "has_audio": true,
  "media_count": 2,
  "location": { "lat": 25.88, "lng": 84.22, "name": "Bansdih, Ballia" },
  "verification": { "score": 72, "verdict": "...", "scores": {...} },
  "caller_info": { "phone": "+91..." },
  "nearby_reports": 3
}

Response: {
  "summary": "2-line assessment...",
  "suggested_action": "Dispatch Rescue Team",
  "confidence_score": 85,
  "inferred_type": "WATER",
  "inferred_severity": "SEVERE",
  "details": "Detailed cross-verification analysis..."
}
```
Result is stored in `reports.ai_assessment` JSON column permanently.

---

## Actions

### Dispatch Help
```
PATCH /reports/{report_id}/dispatch
```

### Mark False Alarm
```
PATCH /reports/{report_id}/false-alarm
```

### Delete Report (Soft Delete — 24h Grace Period)
```
DELETE /reports/{report_id}
```

### Undo Delete
```
POST /reports/{report_id}/undo-delete
```

### Purge All Pending Deletions
```
POST /reports/purge-all-pending
```

---

## Webhooks

### Telegram
```
GET/POST /telegram/           # Long-polling (auto-started on boot)
GET      /telegram/status     # Bot status
```

### WhatsApp
```
GET  /whatsapp/webhook        # Meta verification (hub.challenge)
POST /whatsapp/webhook        # Incoming messages
```

### SMS (Twilio)
```
POST /sms/webhook/{secret}    # Incoming SMS
GET  /sms/status              # Gateway status
```

### IVR (Twilio)
```
POST /ivr/webhook/{secret}           # Incoming call -> record location
POST /ivr/describe/{secret}          # Receive location -> record description
POST /ivr/done/{secret}              # Receive description -> thank you + hangup
GET  /ivr/status                     # Bot status
GET  /ivr/webhook-url                # Get configured webhook URLs (local only)
```

---

## Health
```
GET /health
Response: { "status": "ok" }
```
