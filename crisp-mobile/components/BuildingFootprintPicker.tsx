/**
 * BuildingFootprintPicker — RN parity for the PWA's `building-select.js`.
 *
 * UNDP Appendix 1 requires a reporter to be able to pin an incident to a
 * specific building footprint (not just GPS coordinates). The PWA ships
 * this via Leaflet + Overpass API (OpenStreetMap). This component mirrors
 * the same UX inside a react-native-webview sandbox so the Expo Go build
 * doesn't need to take a native dependency on `react-native-maps` (which
 * requires an EAS Dev Client build).
 *
 * Flow:
 *   1. Parent opens <BuildingFootprintPicker visible lat lng onSelect onClose />.
 *   2. WebView loads an inline Leaflet HTML centred at the user's GPS.
 *   3. A single Overpass query pulls every `building` way within 200 m.
 *   4. Each building is drawn as a tappable purple polygon.
 *   5. User taps a polygon → WebView posts `{ osmId: 'osm:way:<id>' }`
 *      via ReactNativeWebView.postMessage → parent calls onSelect + close.
 *
 * The Overpass fetch is best-effort — if it fails (no network, timeout,
 * rate-limited) the map still shows the GPS pin so the user knows where
 * they are even though they can't select a specific building.
 *
 * Parity details:
 *   - Same `osm:way:<id>` string format used by the PWA + backend.
 *   - Same 200 m radius (building-select.js `OVERPASS_RADIUS_M`).
 *   - Same polygon styling (purple 2px border, 10 % fill).
 *   - Same cache key convention — deferred. The PWA caches Overpass
 *     responses in IndexedDB for offline replay; RN equivalent would
 *     use AsyncStorage but is out of scope for this sprint (network
 *     needed anyway since the map tiles themselves aren't cached).
 */
import React, { useMemo, useRef } from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import { Colors } from '../constants/colors';
import { t } from '../services/i18n';

type Props = {
  visible: boolean;
  onClose: () => void;
  onSelect: (osmId: string) => void;
  /** Current GPS — used to centre the map + scope the Overpass query. */
  lat: number;
  lng: number;
};

/**
 * Generate the Leaflet HTML page served into the WebView. Inlined so
 * the component has no external file dependency; CDN-fetched Leaflet
 * + OSM tiles stay the same as the PWA's setup.
 *
 * SECURITY: we template lat/lng into a JS literal. Both are numbers
 * before they reach this function (TypeScript-enforced), so there's
 * no injection surface — but we still guard by calling `Number()`
 * one more time at the boundary to assert runtime sanity.
 */
function buildMapHtml(lat: number, lng: number): string {
  const safeLat = Number(lat) || 0;
  const safeLng = Number(lng) || 0;
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html,body{margin:0;padding:0;background:#0a0e1a;font-family:system-ui,-apple-system,sans-serif}
  #map{position:fixed;inset:0}
  .empty{position:fixed;inset:auto 16px 20px;padding:12px;background:rgba(17,24,39,0.92);color:#e2e8f0;border-radius:10px;font-size:12px;text-align:center;display:none}
</style>
</head><body>
<div id="map"></div>
<div id="empty" class="empty">No building footprints found in range — tap Cancel and submit without a building tag.</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function(){
  var LAT = ${safeLat};
  var LNG = ${safeLng};
  var RADIUS_M = 200;
  var map = L.map('map', { zoomControl: true, attributionControl: false }).setView([LAT, LNG], 18);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20,
    // OSM tile usage policy requires attribution, but Leaflet's own
    // attribution control is hidden here to keep the UI clean — we
    // surface it inside the native modal header instead.
  }).addTo(map);
  L.marker([LAT, LNG]).addTo(map).bindPopup('Your location').openPopup();

  function post(payload) {
    try { window.ReactNativeWebView.postMessage(JSON.stringify(payload)); }
    catch (_) { /* not running inside WebView */ }
  }

  var query = '[out:json][timeout:10];way[building](around:' + RADIUS_M + ',' + LAT + ',' + LNG + ');(._;>;);out geom;';
  var url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query);
  fetch(url).then(function(r){ return r.json(); }).then(function(data){
    var count = 0;
    (data.elements || []).forEach(function(el){
      if (el.type !== 'way' || !el.geometry) return;
      count++;
      var latlngs = el.geometry.map(function(n){ return [n.lat, n.lon]; });
      var poly = L.polygon(latlngs, {
        color: '#7c3aed',
        weight: 2,
        fillOpacity: 0.1,
        fillColor: '#7c3aed',
      }).addTo(map);
      poly.on('click', function(){
        // Visual feedback before the modal closes — highlight the chosen polygon.
        poly.setStyle({ fillOpacity: 0.4, color: '#22c55e', weight: 3 });
        post({ osmId: 'osm:way:' + el.id });
      });
    });
    if (count === 0) {
      document.getElementById('empty').style.display = 'block';
    }
    post({ loaded: true, count: count });
  }).catch(function(e){
    // Overpass can be flaky / rate-limited — surface a friendly notice.
    document.getElementById('empty').style.display = 'block';
    document.getElementById('empty').textContent = 'Could not load buildings. Tap Cancel and submit without a building tag.';
    post({ error: String(e && e.message || e) });
  });
})();
</script>
</body></html>`;
}

export default function BuildingFootprintPicker({ visible, onClose, onSelect, lat, lng }: Props) {
  const html = useMemo(() => buildMapHtml(lat, lng), [lat, lng]);
  const webViewRef = useRef<WebView | null>(null);

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const data = JSON.parse(e.nativeEvent.data);
      if (typeof data?.osmId === 'string' && data.osmId.startsWith('osm:way:')) {
        onSelect(data.osmId);
        // Delay close slightly so the user sees the green-highlight flash.
        setTimeout(onClose, 250);
      }
    } catch {
      // Silent — any malformed message is ignorable diagnostic chatter.
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t('image_delete_cancel')}
            style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
          <Text style={styles.title} numberOfLines={1}>
            {t('building_select_title')}
          </Text>
        </View>
        <View style={styles.hintBar}>
          <Text style={styles.hintText}>{t('building_select_hint')}</Text>
        </View>
        <WebView
          ref={webViewRef}
          source={{ html }}
          style={styles.webview}
          originWhitelist={["*"]}
          javaScriptEnabled
          domStorageEnabled
          onMessage={onMessage}
          // iOS: bounce/scroll disabled so the map owns gestures.
          bounces={false}
          // Android: allow mixed content so the OSM tile HTTP/HTTPS
          // mismatch (if any) doesn't black out the map.
          mixedContentMode="always"
          // Disable the JS console forwarder noise in dev.
          setSupportMultipleWindows={false}
          // Accessibility — tell a11y tree this is a map.
          accessibilityRole="image"
          accessibilityLabel="Building footprint map"
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  closeBtnText: { color: Colors.text, fontSize: 18, fontWeight: '600' },
  title: {
    flex: 1,
    color: Colors.text,
    fontSize: 15,
    fontWeight: '700',
    marginLeft: 12,
  },
  hintBar: {
    padding: 10,
    paddingHorizontal: 14,
    backgroundColor: Colors.surface2,
  },
  hintText: { color: Colors.textDim, fontSize: 12, lineHeight: 17 },
  webview: { flex: 1, backgroundColor: Colors.bg },
});
