# UNDP §3.2 - Building-Footprint Selector

*Shipped April 2026 for PWA.  RN parity design doc lives below.*

## The requirement

UNDP RAPIDA Problem Statement:

> "Buildings of interest shall be selected by users via ... buildings
> shall be made available for users to pick from a (satellite) map
> underlayer in the field app."

Up until April 2026 CRISP offered only:

  * A reporter-side **GPS pin** (state.location).
  * An **admin-side** Leaflet overlay on the dashboard that rendered
    OSM Buildings via Overpass at zoom ≥ 15.

That closed the "can the admin see the buildings" half of the
requirement but not the "reporter can pick a building" half - a hard
disqualifier in a strict UNDP read.

## PWA implementation

File layout:

| File | Responsibility |
|---|---|
| `mobile-app/src/index.html`        | Leaflet `<link>` + `<script>` CDN tags; `<details id=building-select-box>` on stage-review |
| `mobile-app/src/building-select.js`| `window.BuildingSelect = { ensureMap, getSelection }` |
| `mobile-app/src/styles.css`        | `.building-map`, `.building-select-hint`, `.building-selected-pill` |
| `mobile-app/src/app.js`            | New i18n keys, `building_id` in the POST /reports payload |
| `backend/app/schemas/report.py`    | `building_id` on `ReportMetaCreate` |

### Flow

1. User reaches stage-review with `state.location` populated.
2. Taps the collapsed `<details>` - on `toggle` the module fetches
   OSM buildings via Overpass API within a 200 m radius.
3. Each footprint becomes a tappable blue polygon; selection turns red.
4. Tapping a polygon writes `osm:way:<id>` into `state.buildingId`
   which the submit handler emits as `building_id`.
5. An IndexedDB (`crisp_buildings_v1 / tiles`) caches the Overpass
   response keyed to 3-decimal-place lat/lng - subsequent captures in
   the same neighbourhood work offline.
6. If Overpass is unreachable and the cache is cold, the map
   gracefully degrades to the OSM tile layer + location marker, and
   the existing GPS-only flow continues to work.

### Graceful degradation

  * No `navigator.geolocation` → selector stays collapsed, no map init.
  * Overpass 5xx / offline → cached tiles used; if none, pin-only map.
  * Leaflet CDN blocked → JS guards `typeof L === 'undefined'` and
    the feature is quietly inert. `state.buildingId` stays null and
    the backend's coarse-match `_auto_assign_building_id` fills in.

### Backend integration

`ReportMetaCreate.building_id` is optional. `_auto_assign_building_id`
(existing) only assigns a new id if the report doesn't already have
one - so an explicit pick always wins. The dashboard's
`/reports/building/{building_id}` endpoint groups reports by this id
for multi-report trajectory views.

## RN parity - design (deferred)

React Native parity is **deferred to the next sprint** because
react-native-maps requires a native build step that isn't viable
inside a single plan-mode session. The design below is the agreed
spec.

### Required packages

```bash
cd crisp-mobile
expo install react-native-maps
```

### File layout (when implementation lands)

| File | Change |
|---|---|
| `crisp-mobile/App.tsx` | Add `<MapView>` inside the review screen with `showsUserLocation` + Overpass tile source; store selection in `setBuildingId` |
| `crisp-mobile/services/osmBuildings.ts` | New helper: `fetchBuildingsNear(lat, lng)` → calls Overpass with the same query the PWA uses |
| `crisp-mobile/services/buildingCache.ts` | AsyncStorage-backed cache mirroring the PWA's IndexedDB tiles |

### Offline-first

Cache via `AsyncStorage` with the same 3-decimal-place key as the PWA
(see `mobile-app/src/building-select.js::_cacheKey`). Offline capture
works when the user has previously opened the review screen in this
neighbourhood.

### Submit payload parity

```ts
await fetch(`${API_BASE}/reports/meta`, {
  ...,
  body: JSON.stringify({
    ...,
    building_id: buildingId, // "osm:way:<id>" or null
  }),
});
```

The backend schema already accepts this field.

### Test strategy

Once the native module is wired, add a Detox / Maestro test that:

  1. Opens the review screen with a mock GPS fix.
  2. Waits for the map to render ≥ 1 building polygon.
  3. Taps a polygon; confirms the selection pill appears.
  4. Submits; confirms the POST payload carries `building_id`.

## Verification

PWA (ready today):

```bash
npx playwright test e2e/tests/pwa/12-building-footprint.spec.ts
```

Three checks:
  * Leaflet + BuildingSelect globals load before app.js.
  * `#building-select-box` exists and is collapsed by default.
  * `getSelection()` round-trips a synthetic pick through `state.buildingId`.

End-to-end (manual):

  1. Fire up the PWA on `https://<host>/`.
  2. Capture a photo at a real GPS fix.
  3. On review, expand "Optional: pick the exact building".
  4. Wait for the map; the reporter's GPS pin should be surrounded by
     building outlines.
  5. Tap one; confirm it turns red + the "Building selected" pill
     appears.
  6. Submit; check the dashboard - the new report should show under
     `/reports/building/osm:way:<id>`.
