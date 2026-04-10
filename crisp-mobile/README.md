# CRISP Mobile — React Native Android App

Offline-first crisis reporting app for the UNDP InnoCentive Challenge.

## Setup

```bash
cd crisp-mobile
npm install
npx expo start
```

## Run on Android
```bash
npx expo run:android
# OR scan QR code with Expo Go app
```

## Build APK
```bash
npx expo prebuild --platform android
cd android && ./gradlew assembleRelease
# APK at: android/app/build/outputs/apk/release/
```

## Architecture

- **Offline-first**: SQLite stores all reports locally. Sync engine uploads when online.
- **Chunked upload**: 1KB base64 chunks with DJB2 checksum (matches backend).
- **Background sync**: Auto-syncs every 30s when online. Exponential backoff on failure.
- **7 languages**: English, Chinese, Russian, Spanish, French, Arabic, Hindi.
- **PII warning**: Amber banner before photo capture.

## Screen Flow
1. **Home** — Language picker + START button
2. **Photo** — Camera/browse + PII warning
3. **Audio** — Mic recording + text input
4. **Review** — Type, severity, location, description
5. **Send** — Summary + submit
6. **Success** — Report ID + new report

## Backend API
Uses the same endpoints as the PWA:
- `POST /api/v1/reports/meta`
- `PATCH /api/v1/reports/{id}/description`
- `POST /api/v1/reports/{id}/media/chunk`
