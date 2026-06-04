/**
 * CRISP Mobile — Crisis Response Intelligence & Situation Platform
 * React Native Android App — Offline-first crisis reporting.
 *
 * Screen flow: Home → Photo → Audio → Review → Send → Success
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, TextInput, Alert, Image, StatusBar, Platform,
  Keyboard, TouchableWithoutFeedback, KeyboardAvoidingView,
  Animated, Easing, AccessibilityInfo, Modal,
  InteractionManager, Dimensions, BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Sentry from '@sentry/react-native';
import { Colors } from './constants/colors';
import { t, setLanguage, detectLanguage, getAvailableLanguages, bootstrapLanguage, applyTextDirection } from './services/i18n';
import ConsentOverlay from './components/ConsentOverlay';
import BuildingFootprintPicker from './components/BuildingFootprintPicker';
import IconTile from './components/IconTile';
import { reviewReducer, type Page as ReviewPage } from './components/reviewReducer';

// ── Sentry init (May 2026 audit fix — RN observability) ──────────────
//
// CRISP product-readiness audit flagged "no Sentry on RN" as a
// CRITICAL ops gap. Without crash + error reporting, field-testing
// failures only surface if a user manually reports them.
//
// DSN is sourced from `EXPO_PUBLIC_SENTRY_DSN` (an Expo public env
// var — visible to the bundle, which is OK because the DSN is a
// write-only key by design). Empty/missing → Sentry stays inert
// (e.g. local dev without a configured DSN).
//
// Privacy posture matches the PWA's `sentry-init.js`:
//   · `beforeSend` strips any user-content keys from the payload
//     (description, transcript, lat/lng, tokens).
//   · UNDP §2.9 says faces blur on-device; we extend the same
//     caution to error-context metadata.
const _SENTRY_DSN = process.env.EXPO_PUBLIC_SENTRY_DSN || '';
const _SENTRY_RELEASE = process.env.EXPO_PUBLIC_SENTRY_RELEASE || 'crisp-rn@v195';
if (_SENTRY_DSN) {
  try {
    Sentry.init({
      dsn: _SENTRY_DSN,
      release: _SENTRY_RELEASE,
      environment: __DEV__ ? 'dev' : 'prod',
      tracesSampleRate: 0.05,                  // low — disaster zones, sparse bandwidth
      enableAutoSessionTracking: true,
      enableNativeCrashHandling: true,
      beforeSend: (event) => {
        try {
          const stripKeys = [
            'description', 'transcript', 'audio',
            'photoDataUrl', 'photoVariants',
            'building_free_text',
            'lat', 'lng', 'latitude', 'longitude',
            'phone', 'email', 'access_token', 'refresh_token',
          ];
          if (event.extra) {
            for (const k of stripKeys) {
              if (k in event.extra) delete (event.extra as Record<string, unknown>)[k];
            }
          }
          if (event.contexts && (event.contexts as Record<string, unknown>).state) {
            const state = (event.contexts as Record<string, Record<string, unknown>>).state;
            for (const k of stripKeys) {
              if (k in state) state[k] = '[stripped]';
            }
          }
        } catch (_) { /* never let filter break Sentry */ }
        return event;
      },
      // Skip noise that's not actionable.
      ignoreErrors: [
        /Non-Error promise rejection captured/,
        /Network request failed/,                  // offline state — handled by upload queue
      ],
    });
    Sentry.setTag('surface', 'rn');
    Sentry.setTag('platform_os', Platform.OS);
    Sentry.setTag('platform_version', String(Platform.Version));
    // eslint-disable-next-line no-console
    console.log('[Sentry] RN init OK · release=' + _SENTRY_RELEASE);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[Sentry] RN init failed:', e);
  }
}

/**
 * Apr 2026 UI v2 rollout flag.
 *
 * Default ON — every new install boots into the 3-page review flow with
 * SVG icons, SafeAreaView wrapping, responsive padding, and the rest of
 * the audit fixes below. Setting `crisp_ui_v2` to literal `"off"` in
 * AsyncStorage reverts to the pre-v2 monolithic review screen so we can
 * roll back without an app update if field testing surfaces a regression.
 *
 * Reasoning for default-on: the v2 flow is required for the 23 June UNDP
 * submission window, so we treat v1 as the escape hatch, not the baseline.
 * The flag is read ONCE at mount (no subscription) — we don't want the UI
 * to reshuffle mid-flow if someone flips the storage key from devtools.
 */
async function readUiV2Flag(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem('crisp_ui_v2');
    return raw === null ? true : raw === 'on';
  } catch {
    return true;
  }
}

/**
 * Phase B4 (Apr 2026) — UI v3 flag read. Same pattern as readUiV2Flag:
 * default on, opt-out via AsyncStorage key `crisp_ui_v3` = 'off'.
 * Drives the 8-stage capture flow (home → where → infra → crisis
 * → extras → photo → audio → review → success). When off, the RN app
 * keeps the v2 navigation (home → photo → audio → review → success).
 */
async function readUiV3Flag(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem('crisp_ui_v3');
    return raw === null ? true : raw === 'on';
  } catch {
    return true;
  }
}

/**
 * Responsive padding helper — replaces the fixed `padding:24` pattern
 * across the capture flow. At 360 px and above we stay at 24 px; on
 * smaller devices (280×480 low-end Android target) the padding scales
 * down to 6 % of viewport width so chip rows and button columns don't
 * overflow the safe drawable region. Audit issue R8.
 */
function responsivePad(): number {
  return Math.min(24, Dimensions.get('window').width * 0.06);
}
// NOTE on custom fonts: the PWA ships Inter + Outfit via Google Fonts;
// RN's expo-font can mirror this via @expo-google-fonts/inter + outfit
// packages. Deferred because the download gating adds 300–500ms of
// splash-screen time on cold start, and system fonts (Roboto / San
// Francisco, plus Noto fallbacks for non-Latin scripts on all recent
// devices) are already legible for the capture flow's short strings.
// Track the upgrade via the UNDP-ALIGNMENT-CHANGELOG typography entry.
import { initDatabase, enqueueReport, getQueueCount } from './services/database';
import { processQueue } from './services/syncEngine';
import { preCacheNearest as _bldgPreCacheNearest, type NearbyBuilding } from './services/buildingCache';
const preCacheNearest = _bldgPreCacheNearest;
// Phase 1 (Apr 2026 — Optional reporter login). Anonymous-first auth
// layer; imported lazily since the RN boot path mustn't block on auth.
import * as AuthStore from './services/auth';
import NetInfo from '@react-native-community/netinfo';
import * as crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import * as Location from 'expo-location';
import { File } from 'expo-file-system';
import { useAudioRecorder, AudioModule, IOSOutputFormat, AudioQuality } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { detectNetworkTier, getAdaptiveConfig, getCurrentTier } from './services/networkAdaptive';
import { getHistory, getImpactStats, markHistoryDeletionRequested, updateHistoryStatus, HistoryReport, getInFlightReports, QueuedReport, deleteReport as deleteQueuedReport, updateReportStatus } from './services/database';
import { getDeviceStatusSince, deleteReportFromServer, getApiBase } from './services/api';
import { blurFacesBase64, prewarm as prewarmPIIBlur } from './services/piiBlur';
import { generateVariants, PhotoVariants, TIER_TO_RESOLUTION } from './services/imageVariants';
import { swallow as telemetrySwallow } from './services/telemetry';
// Phase 4 (Apr 2026) — region-gated auto-submit timer.
import { getEnabledRegions, findActiveRegion, Region } from './services/regionCache';
// May 2026 — Phase 2 of RN ↔ PWA parity. New HomeScreen mirrors the
// PWA's redesigned home stage (3-section flex, CTA-anchored,
// quiet identity pill, channels grid). Replaces the old in-line
// home block. See V4_PARITY_DEFERRED.md for the staged plan.
import HomeScreen from './screens/HomeScreen';
// Phase 3 of RN ↔ PWA parity. V4CaptureScreen mirrors the PWA's
// #stage-v4-capture (meta card + photo section + voice/text chips
// + smart-contextual tips card + Continue). Gated behind
// UI_V4_ENABLED — flag stays OFF until Phases 4 + 5 (classify +
// review) land, then it flips per the v4 roadmap.
import V4CaptureScreen from './screens/V4CaptureScreen';
// Phase 4 of RN ↔ PWA parity. V4ClassifyScreen mirrors the PWA's
// #stage-v4-classify — 3 sub-views (damage / infra / crisis) on one
// screen with tile-tap 200ms auto-progress. Reanimated dep added in
// Phase 0 is reserved for future polish; v1 uses RN's built-in
// Animated for the scale pulse so it works under the existing
// jest mock layer.
import V4ClassifyScreen from './screens/V4ClassifyScreen';
// Phase 5 of RN ↔ PWA parity. V4ReviewScreen mirrors the PWA's
// #stage-v4-review — Step 3 of 3. Captured strip + summary card +
// building mount + voice/text drawer + UNDP details (debris /
// service status / pressing needs) + Send button. This is the
// App Store-submission gate per the v4 roadmap.
import V4ReviewScreen from './screens/V4ReviewScreen';
// Phase 6 of RN ↔ PWA parity. RewardsScreen combines the PWA's
// stage-rewards (4-tier ladder + progress) AND Badge Studio share
// surface (share-message picker + Share.share() dispatch) into a
// single RN screen. View-shot pixel-perfect badge composition is
// deferred to Phase 6.5; v1 relies on the OS Share sheet with a
// curated text + URL, which covers ~95 % of the share intent
// without binary bloat.
import RewardsScreen from './screens/RewardsScreen';

// Phase 3 (Apr 2026): review collapsed from 3 screens to 2 (details + confirm).
// `review_incident` kept as an alias that redirects to `review_details` so any
// lingering push-notification or URL scheme referring to it still lands on a
// valid screen.
// Apr 2026 "My Reports" spec — `report_detail` is a new full-screen view
// with photo / timeline / metadata / feedback + per-report delete. Parity
// with PWA's stage-report-detail.
// Phase B4 (Apr 2026 UI v3) — 4 new screen values for the 8-stage capture
// flow reorder (parity with PWA). Default ON via UI_V3_ENABLED below; flip
// to 'off' in AsyncStorage key `crisp_ui_v3` to revert.
//
//   v3 path: home → where → infra → crisis → extras → photo → audio
//          → review_confirm → success
//
//   v2 path: home → photo → audio → review_details → review_confirm → success
type Screen =
  | 'home'
  | 'legacy_home'                                   // May 2026 — fallback for the pre-redesign home block; kept behind a flag for one-flag rollback
  | 'where' | 'infra' | 'crisis' | 'extras'       // v3 additions
  | 'photo' | 'audio' | 'review_details' | 'review_confirm'
  | 'success' | 'history' | 'report_detail'
  // Phase 1 (Apr 2026 — Optional reporter login) — off-flow screens.
  | 'login' | 'settings'
  // May 2026 — UI v4 parity (DEFERRED). Screen values are reserved
  // here so the eventual port type-checks; the corresponding screen
  // components are tracked in crisp-mobile/V4_PARITY_DEFERRED.md.
  // No v4 navigation calls today — the flag check below prevents
  // routing to these stubs.
  | 'v4_landing' | 'v4_capture' | 'v4_classify' | 'v4_review'
  // Phase 6 — Rewards page + Badge Studio share surface.
  | 'v4_rewards';

// May 2026 v4 — flag check (default OFF on RN until V4_PARITY_DEFERRED
// roadmap completes). PWA defaults flag ON; RN companion defaults OFF
// so users get the existing v3 flow on the legacy 4-stage path. When
// the v4 RN screens ship (see V4_PARITY_DEFERRED.md), flip this to
// the same default-on pattern the PWA uses.
const UI_V4_ENABLED = false;

/**
 * Schedule heavy async work to run AFTER any user interaction (touch, scroll,
 * animation) has finished. InteractionManager.runAfterInteractions is React
 * Native's answer to the browser's requestIdleCallback — it ensures the JS
 * thread processes gestures first before yielding to background tasks.
 *
 * Capture-flow bug (Apr 2026): the PII blur + variant-generation pipeline
 * runs for 300–800 ms and — because JS is single-threaded — starves touch
 * events until it completes. Users reported the Next / shutter / Browse
 * buttons "doing nothing" immediately after a capture. Wrapping the
 * pipeline in runAfterInteractions fixes the perception of unresponsiveness
 * without changing any of the downstream upload logic.
 *
 * Returns a Promise so callers can `await` completion for things like
 * submitReport()'s `blurPromiseRef` gate.
 */
function _runAfterInteractions<T>(asyncFn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    InteractionManager.runAfterInteractions(() => {
      asyncFn().then(resolve, reject);
    });
  });
}

// Per-incident photo cap (PWA/RN parity, see mobile-app/src/app.js).
// 2 extras + 1 primary = 3 photos total — operator UX decision May 2026,
// reduced from 5. Guarded at every _ingestExtraFromUri call site so a
// future code path can't accidentally bypass. Enforced on the client
// AND on the server's chunked-upload ceiling — matches PWA behaviour.
const MAX_EXTRA_PHOTOS = 2;
const MAX_PHOTOS_TOTAL = MAX_EXTRA_PHOTOS + 1;   // main + extras

// Throttle ref for the cap-reached Alert — prevents 10 popups when the user
// selects 10 photos from the gallery while already at cap. First trigger in a
// 1200-ms window shows the alert; subsequent triggers skip it.
let _lastCapAlertAt = 0;
const _CAP_ALERT_MIN_MS = 1200;

const BADGE_ICONS: Record<string,string> = { NEWCOMER: '🌱', HELPER: '🤝', GUARDIAN: '🛡', HERO: '🦸' };
function BadgeCard({ deviceHash }: { deviceHash: string }) {
  const [badge, setBadge] = React.useState<{badge_level:string;report_count:number} | null>(null);
  React.useEffect(() => {
    if (!deviceHash) return;
    let cancelled = false;
    fetch(`${getApiBase()}/reports/profile/${deviceHash}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && d.badge_level && !cancelled) setBadge(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [deviceHash]);
  if (!badge) return null;
  return (
    <View style={{ backgroundColor: 'rgba(124,58,237,0.1)', borderWidth: 1, borderColor: 'rgba(124,58,237,0.3)', borderRadius: 14, padding: 14, marginBottom: 12, alignItems: 'center', width: '100%' }}>
      <Text style={{ fontSize: 32 }}>{BADGE_ICONS[badge.badge_level] || '🌱'}</Text>
      <Text style={{ color: '#a78bfa', fontSize: 16, fontWeight: '700', marginTop: 4 }}>{badge.badge_level}</Text>
      <Text style={{ color: '#9ca3af', fontSize: 12 }}>{badge.report_count} report{badge.report_count !== 1 ? 's' : ''} submitted</Text>
    </View>
  );
}

/**
 * FlowProgress — Apr 2026 UX rewrite.
 * Unified 4-step progress bar for the capture flow (Photo → Details → Review → Send).
 * Replaces per-screen step labels ("1/4", "2/4", …). Color-coded so the user
 * always knows where they are, what's done, what's left, and what's missing.
 *
 *   done     — green ✓  (step completed with required data)
 *   active   — accent ●  (currently on this step)
 *   missing  — red !    (past step with no required data)
 *   upcoming — grey ○    (future step)
 *
 * Parity with PWA's `#flow-progress` bar at mobile-app/src/index.html.
 */
type StepState = 'done' | 'active' | 'missing' | 'upcoming';
/**
 * HeartPulse — Apr 2026 PR 3.
 * Pulsing red heart that draws the eye to the "Lives Saved" stat on
 * the home impact card. Parity with the PWA's CSS `@keyframes heart-pulse`
 * at `mobile-app/src/styles.css`. Native-side implementation uses the
 * Animated API; honours AccessibilityInfo.isReduceMotionEnabled so
 * motion-sensitive users see a static heart.
 */
function HeartPulse() {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let looping: Animated.CompositeAnimation | null = null;
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce) return;  // static heart for users who opted out
      looping = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.2, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(scale, { toValue: 1,   duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ]),
      );
      looping.start();
    });
    return () => { if (looping) looping.stop(); };
  }, [scale]);
  return (
    <Animated.Text style={{
      fontSize: 18, color: '#4ade80',
      textShadowColor: 'rgba(34,197,94,0.7)',
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: 8,
      transform: [{ scale }],
    }}>❤</Animated.Text>
  );
}

/**
 * PR 7 (Apr 2026) — bigger, red-glowing heart for the success screen close.
 * Same 2-second scale/glow loop as PR 3's HeartPulse but red (heart emoji
 * 'as-is' rather than green-tinted) and sized to dominate the hero area.
 */
function SuccessHeart() {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    let looping: Animated.CompositeAnimation | null = null;
    AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
      if (reduce) return;
      looping = Animated.loop(
        Animated.sequence([
          Animated.timing(scale, { toValue: 1.12, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(scale, { toValue: 1,    duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ]),
      );
      looping.start();
    });
    return () => { if (looping) looping.stop(); };
  }, [scale]);
  return (
    <Animated.Text style={{
      fontSize: 72,
      lineHeight: 82,
      textShadowColor: 'rgba(239, 68, 68, 0.55)',
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: 18,
      transform: [{ scale }],
    }}>❤️</Animated.Text>
  );
}

function FlowProgress({ step, have }: {
  step: 1 | 2 | 3 | 4;                     // current step (1..4)
  have: { photo: boolean; details: boolean };
}) {
  const stateFor = (n: number): StepState => {
    if (n === step) return 'active';
    if (n < step) {
      // Past step — green if required data exists, red if missing.
      if (n === 1) return have.photo ? 'done' : 'missing';
      if (n === 2) return have.details ? 'done' : 'missing';
      return 'done';
    }
    return 'upcoming';
  };
  const COLORS: Record<StepState, { bg: string; border: string; fg: string; glyph: string }> = {
    done:     { bg: 'rgba(34,197,94,0.18)',  border: 'rgba(34,197,94,0.7)',  fg: '#22c55e', glyph: '✓' },
    active:   { bg: 'rgba(249,115,22,0.22)', border: '#f97316',              fg: '#fff',   glyph: '●' },
    missing:  { bg: 'rgba(239,68,68,0.18)',  border: 'rgba(239,68,68,0.7)',  fg: '#ef4444', glyph: '!' },
    upcoming: { bg: 'rgba(255,255,255,0.04)', border: 'rgba(255,255,255,0.18)', fg: 'rgba(255,255,255,0.45)', glyph: '' },
  };
  const LABELS = ['Photo', 'Details', 'Review', 'Send'];
  // PWA parity — 4px gradient bar showing overall completion, below the
  // badge row. Fills 25/50/75/100% for steps 1..4. Mirrors PWA .progress-bar-container.
  const fillPct = step <= 1 ? 25 : step === 2 ? 50 : step === 3 ? 75 : 100;
  return (
    <View accessibilityRole="progressbar" accessibilityLabel={`Step ${step} of 4 — ${LABELS[step - 1]}`}>
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingTop: 12, paddingBottom: 8 }}>
        {[1, 2, 3, 4].map((n, i) => {
          const st = stateFor(n);
          const c = COLORS[st];
          return (
            <React.Fragment key={n}>
              <View style={{ alignItems: 'center', minWidth: 48, flex: 0 }}>
                <View style={{
                  width: 24, height: 24, borderRadius: 12,
                  borderWidth: 2, borderColor: c.border, backgroundColor: c.bg,
                  alignItems: 'center', justifyContent: 'center',
                  ...(st === 'active' ? { shadowColor: '#f97316', shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } } : {}),
                }}>
                  <Text style={{ color: c.fg, fontSize: 12, fontWeight: '700' }}>{c.glyph}</Text>
                </View>
                <Text style={{
                  color: st === 'active' ? '#fb923c'
                       : st === 'done' ? '#4ade80'
                       : st === 'missing' ? '#f87171'
                       : 'rgba(255,255,255,0.5)',
                  // Apr 2026 UI v2 (R6): 10 → 13 legibility floor.
                  fontSize: 13, fontWeight: st === 'active' ? '700' : '600',
                  marginTop: 4, textTransform: 'uppercase', letterSpacing: 0.3,
                }}>{LABELS[n - 1]}</Text>
              </View>
              {i < 3 && (
                <View style={{ flex: 1, height: 2, backgroundColor: 'rgba(255,255,255,0.12)', marginHorizontal: 2, marginTop: -10 }} />
              )}
            </React.Fragment>
          );
        })}
      </View>
      {/* 4px gradient progress bar — PWA parity (.progress-bar-container).
          Uses a solid accent fill + a thin track. In RN the gradient
          effect is approximated with the accent color + reduced opacity
          on the remaining track, which reads the same on small screens. */}
      <View style={{ height: 4, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 2, marginHorizontal: 14, marginBottom: 8 }}>
        <View style={{
          height: '100%',
          width: `${fillPct}%`,
          backgroundColor: Colors.accent,
          borderRadius: 2,
        }} />
      </View>
    </View>
  );
}

/**
 * AutoSubmitTimer — Phase 4 (Apr 2026).
 * Sticky banner shown during capture flow when the user is inside an
 * admin-enabled auto-submit region. Counts down from 2:00. At T=0 calls
 * `onFire`; Cancel button calls `onCancel`.
 */
function AutoSubmitTimer({ region, onFire, onCancel }: {
  region: Region;
  onFire: () => void;
  onCancel: () => void;
}) {
  const [remaining, setRemaining] = React.useState(120); // 2 min in seconds
  const fired = React.useRef(false);
  React.useEffect(() => {
    const tick = setInterval(() => {
      setRemaining((r) => {
        const next = r - 1;
        if (next <= 0 && !fired.current) {
          fired.current = true;
          clearInterval(tick);
          onFire();
          return 0;
        }
        return next;
      });
    }, 1000);
    return () => clearInterval(tick);
  }, [onFire]);
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9999,
        backgroundColor: '#dc2626',
        paddingVertical: 10, paddingHorizontal: 14,
        flexDirection: 'row', alignItems: 'center', gap: 10,
      }}
    >
      <Text style={{ color: '#fff', fontSize: 18 }}>⏱</Text>
      <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700', flex: 1 }}>
        Auto-submitting in {mm}:{String(ss).padStart(2, '0')}  ·  <Text style={{ opacity: 0.8 }}>{region.name}</Text>
      </Text>
      <TouchableOpacity
        onPress={onCancel}
        accessibilityLabel="Cancel auto-submit"
        style={{ backgroundColor: '#fff', paddingVertical: 6, paddingHorizontal: 12, borderRadius: 6 }}
      >
        <Text style={{ color: '#dc2626', fontWeight: '700', fontSize: 13 }}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [lang, setLang] = useState('en');
  // Apr 2026 UI v2 flag — see readUiV2Flag() for rationale. Default true so
  // a missing storage key lands on the new flow; flip to 'off' to revert.
  const [uiV2, setUiV2] = useState<boolean>(true);
  // Apr 2026 UI v3 flag — Phase B4 8-stage capture flow. See readUiV3Flag().
  const [uiV3, setUiV3] = useState<boolean>(true);
  // Apr 2026 UI v2: 3-page review split state. `reviewPage` drives the
  // sub-screen inside `review_details`; the old single-page review remains
  // as the v1 fallback path when uiV2 is false. Starts at 1 — reset to 1
  // on stage entry so a resumed draft doesn't flash page 2 before
  // the user re-orients.
  const [reviewPage, setReviewPage] = useState<ReviewPage>(1);
  const [queueCount, setQueueCount] = useState(0);
  const [isOnline, setIsOnline] = useState(true);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  // Phase B4 (Apr 2026 UI v3) — default to the first UNDP super-type
  // chip (RESIDENTIAL). `ROAD` was the v2 default before the chip set
  // switched to UNDP Appendix-1 taxonomy. Backend accepts both enum
  // values so in-flight offline queues keep replaying cleanly.
  const [infraType, setInfraType] = useState('RESIDENTIAL');
  const [severity, setSeverity] = useState('MODERATE');
  const [crisisType, setCrisisType] = useState('FLOOD');
  const [damageClass, setDamageClass] = useState('PARTIAL');  // UNDP: MINIMAL / PARTIAL / COMPLETE
  // PR 6 (Apr 2026): damage level merged into the infra chip — same-chip
  // second tap collapses the severity row. Starts expanded so users see the
  // silent PARTIAL default before interacting.
  const [showInfraSeverity, setShowInfraSeverity] = useState(true);
  // PR 6: infra_name and debris_clearing fields dropped from the UI but
  // kept in state (empty / false defaults) so the backend payload is
  // unchanged. setInfraName / setDebrisClearing remain callable in case a
  // future feature wants to reintroduce the inputs.
  const [infraName, setInfraName] = useState('');
  const [debrisClearing, setDebrisClearing] = useState(false);
  // Apr 2026 UI v2.1 — tracks whether `infraName` was auto-filled from
  // an OSM tag vs typed manually. Only auto-cleared values when the
  // user clears the building selection; a manually-typed name survives.
  const [infraNameFromOsm, setInfraNameFromOsm] = useState(false);
  // Phase B2 (Apr 2026 UI v3) — cached nearest-building list populated by
  // preCacheNearest on GPS-ready. Non-authoritative; buildingId remains
  // the truth for any actual selection.
  const [nearbyBuildings, setNearbyBuildings] = useState<NearbyBuilding[]>([]);

  // Phase 1 (Apr 2026 — Optional reporter login). State is sourced from
  // AuthStore (services/auth.ts); these local copies exist so React
  // re-renders the Login/account pill when they change. Never blocks
  // the reporting flow — every call is best-effort.
  const [authReady, setAuthReady] = useState(false);
  const [authLoggedIn, setAuthLoggedIn] = useState(false);
  const [authDisplay, setAuthDisplay] = useState<string | null>(null);
  // Login screen state — simple in-place wizard (step 1 → 2 → 3).
  const [loginChannel, setLoginChannel] = useState<'PHONE'|'EMAIL'>('PHONE');
  const [loginCC, setLoginCC] = useState('+91');
  const [loginPhone, setLoginPhone] = useState('');
  const [loginEmail, setLoginEmail] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [loginStep, setLoginStep] = useState<1|2|3>(1);
  const [loginError, setLoginError] = useState('');
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginLinkable, setLoginLinkable] = useState(0);
  const [loginDestination, setLoginDestination] = useState('');
  // Phase B4 (Apr 2026 UI v3, Apr-23 spec-align) — auto date/time label
  // painted on stage-where. Ticks every 60 s via a useEffect hook below;
  // purely local (`new Date()`), zero network, zero wait.
  const [whereAutoTime, setWhereAutoTime] = useState<string>(() => {
    try {
      const now = new Date();
      return `${now.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' })} · ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    } catch {
      return new Date().toISOString().slice(0, 16).replace('T', ' ');
    }
  });
  useEffect(() => {
    const tick = () => {
      try {
        const now = new Date();
        setWhereAutoTime(`${now.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' })} · ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`);
      } catch {
        setWhereAutoTime(new Date().toISOString().slice(0, 16).replace('T', ' '));
      }
    };
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, []);
  // Phase B4 (Apr 2026 UI v3) — auto-derive severity from damage class so
  // stage-extras can drop the explicit severity chips.
  useEffect(() => {
    if (!uiV3) return;
    const map: Record<string, string> = { MINIMAL: 'MINOR', NO_DAMAGE: 'MINOR', PARTIAL: 'MODERATE', COMPLETE: 'SEVERE', DESTROYED: 'SEVERE' };
    const next = map[damageClass] || 'MODERATE';
    if (severity !== next) setSeverity(next);
  }, [damageClass, uiV3]);
  // PR 6 note: RN's home screen already renders the full flag row from
  // getAvailableLanguages() inline, so no overlay is needed — the existing
  // UX already satisfies the "non-redundant EN + picker" goal that PR 6
  // brings to the PWA via the new #btn-lang-change overlay.
  const [location, setLocation] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [locationName, setLocationName] = useState('');
  // Phase 4: parity with PWA. User-correction flag + manual location name.
  const [isLocationUserCorrected, setIsLocationUserCorrected] = useState(false);
  const [userLocationName, setUserLocationName] = useState<string>('');
  // UNDP Appendix 1 — optional OSM-way id for a specific building footprint
  // selected by the reporter via the map picker. `null` means "location as
  // GPS only". Submitted as `building_id` on the meta payload.
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [footprintPickerOpen, setFootprintPickerOpen] = useState(false);
  // Phase 4: service_status + pressing_needs (matches PWA meta).
  // Phase 3 (Apr 2026): parity fix — backend `ServiceStatusEnum` is
  // OPERATIONAL/DISRUPTED/DESTROYED/UNKNOWN (backend/app/models/report.py:57–61).
  // Previously RN sent NORMAL/DEGRADED/DOWN which the backend silently
  // dropped. PWA already used the correct enum; RN now matches.
  type ServiceLevel = 'OPERATIONAL' | 'DISRUPTED' | 'DESTROYED' | 'UNKNOWN';
  const [electricityStatus, setElectricityStatus] = useState<ServiceLevel>('UNKNOWN');
  const [waterStatus, setWaterStatus] = useState<ServiceLevel>('UNKNOWN');
  const [healthStatus, setHealthStatus] = useState<ServiceLevel>('UNKNOWN');
  // pressing_needs — lowercase to match PWA + docs/PARITY.md.
  const [pressingNeeds, setPressingNeeds] = useState<string[]>([]);
  // Phase 4: multi-photo support. Main photo stays in photoUri/photoBase64;
  // additional photos live here, each runs through the same blur pipeline.
  // Guaranteed-delivery pipeline adds per-extra variants + groupId so each
  // extra photo independently delivers SMALL → MEDIUM → LARGE.
  const [extraPhotos, setExtraPhotos] = useState<Array<{
    uri: string;
    base64: string;
    variants?: import('./services/imageVariants').PhotoVariants | null;
    groupId?: string;
  }>>([]);
  // Apr 2026 image viewer — full-screen preview with delete + confirm.
  // `kind: 'primary'` deletes photoUri (promoting the first extra if any);
  // `kind: 'extra'` deletes extraPhotos[index].
  const [viewerState, setViewerState] = useState<
    { uri: string; kind: 'primary' | 'extra'; index?: number } | null
  >(null);
  const [viewerConfirmOpen, setViewerConfirmOpen] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [reportId, setReportId] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  // Apr 2026 — PWA parity: show elapsed MM:SS during audio capture so
  // reporters know when their clip is getting long. PWA uses #rec-timer.
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [deviceHash, setDeviceHash] = useState('');
  // Phase 4 (Apr 2026) — region-gated auto-submit timer state.
  // `activeRegion` ≠ null ⇒ AutoSubmitTimer banner is visible. Set when the
  // user taps Start Report AND their GPS lies within an admin-enabled zone.
  // `isAutoSubmit` flags the in-flight report so the backend knows the
  // submission came from a timer expiry (for telemetry + provenance).
  const [activeRegion, setActiveRegion] = useState<Region | null>(null);
  const [isAutoSubmit, setIsAutoSubmit] = useState(false);
  const [history, setHistory] = useState<HistoryReport[]>([]);
  // In-flight (queued / syncing / failed) reports — merged with history in
  // the "My Reports" screen so users can see what hasn't shipped yet and
  // where each one is in its sync lifecycle.
  const [pendingReports, setPendingReports] = useState<QueuedReport[]>([]);
  const [impactStats, setImpactStats] = useState({ totalLives: 0, resolvedCount: 0 });
  // Apr 2026 "My Reports" spec — individual report detail view state.
  // selectedReport holds the row currently rendered in screen==='report_detail';
  // it's populated from the status-since response (fresher than local SQLite).
  const [selectedReport, setSelectedReport] = useState<any | null>(null);
  const [showAdvancedDelete, setShowAdvancedDelete] = useState(false);
  // Offline delete queue — IDs whose DELETE call we'll retry on reconnect.
  const [deleteQueue, setDeleteQueue] = useState<string[]>([]);
  // iOS gotcha: passing `outputFormat: 'aac'` produces a CAFF (Core Audio
  // Format) container that HTML5 <audio> cannot play. The iOS FourCC code
  // is `'aac '` WITH a trailing space (IOSOutputFormat.MPEG4AAC). We also
  // have to set the linearPCM* keys — without them AVAudioRecorder silently
  // falls back to CAFF even though the file extension is .m4a.
  const audioRecorder = useAudioRecorder({
    extension: '.m4a', sampleRate: 44100, numberOfChannels: 1, bitRate: 128000,
    android: { audioEncoder: 'aac' as any, outputFormat: 'mpeg4' as any },
    ios: {
      outputFormat: IOSOutputFormat.MPEG4AAC,
      audioQuality: AudioQuality.HIGH,
      linearPCMBitDepth: 16,
      linearPCMIsBigEndian: false,
      linearPCMIsFloat: false,
    },
    web: { mimeType: 'audio/webm', bitsPerSecond: 128000 },
  });

  // Store base64 separately from URI (URI for preview, base64 for upload).
  // Kept for the legacy single-variant path (e.g. the PII-blur-only fallback
  // when variant generation fails). New uploads prefer `photoVariants` below.
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  // Guaranteed-delivery pipeline — three JPEG variants of the main photo
  // sharing a `photoGroupId`. Populated by generateVariants() in the
  // background after capture. null ⇒ fall back to the single-variant path.
  const [photoVariants, setPhotoVariants] = useState<import('./services/imageVariants').PhotoVariants | null>(null);
  const [photoGroupId, setPhotoGroupId] = useState<string | null>(null);
  // Informative status flag only — DOES NOT block navigation. The Next button
  // is gated on "photo present?", not on "blur finished?". If the user taps
  // submit before blur completes, submitReport() awaits blurPromiseRef first.
  const [isBlurring, setIsBlurring] = useState(false);
  // Ref to the in-flight blur promise so submitReport can await it without
  // depending on React state timing. Nulled when blur completes.
  const blurPromiseRef = useRef<Promise<void> | null>(null);

  /**
   * PR 5 (Apr 2026): shared "add one photo to extraPhotos" pipeline.
   * Used by pickImage (non-first assets), pickExtraImage (all assets),
   * and takePhoto (subsequent captures in the multi-snap loop).
   *
   * Matches entries by object identity (not index) — multi-select fires
   * this call in rapid succession and stale indices from setState-in-
   * flight would otherwise corrupt neighbour entries' variants.
   */
  const _ingestExtraFromUri = (rawUri: string, rawB64: string) => {
    // Phase A1 (Apr 2026 UI v3) — enforce per-incident photo cap.
    // Create the entry up-front so the downstream variant closure can match
    // by object identity. Then atomically append inside a functional
    // setState, which is what guarantees a rapid multi-select can't race
    // past MAX_EXTRA_PHOTOS.
    const groupId = crypto.randomUUID();
    const entry = { uri: rawUri, base64: rawB64, groupId, variants: null as PhotoVariants | null };
    let pushed = false;
    setExtraPhotos((xs) => {
      if (xs.length >= MAX_EXTRA_PHOTOS) {
        return xs;
      }
      pushed = true;
      return [...xs, entry];
    });
    if (!pushed) {
      // User has hit the 5-photo limit. One localised alert regardless of
      // how many rejects happen in the same synchronous batch (10-photo
      // gallery pick → one popup, not ten). Matches the PWA's `photo_cap_reached`
      // toast added in the same April-2026 sprint.
      const now = Date.now();
      if (now - _lastCapAlertAt > _CAP_ALERT_MIN_MS) {
        _lastCapAlertAt = now;
        try {
          Alert.alert('', (t as any)('photo_cap_reached') || `Max ${MAX_PHOTOS_TOTAL} photos per report`);
        } catch (_) { /* best-effort */ }
      }
      return;
    }
    // Defer the blur+variants pipeline via InteractionManager so the UI
    // can finish handling the user's shutter/Done tap before TF.js / PII
    // blur saturates the JS thread. Without this, the Next / shutter
    // buttons feel "sticky" for 300–800ms after each capture.
    const p = _runAfterInteractions(async () => {
      try {
        const variants = await generateVariants(rawUri, rawB64);
        setExtraPhotos((xs) => xs.map((x) => x === entry
          ? { ...x, variants, uri: `data:image/jpeg;base64,${variants.small.base64}`, base64: variants.small.base64 }
          : x));
      } catch (e) {
        console.warn('[Capture-extra] variant generation failed, falling back:', e);
        try {
          const safe = await blurFacesBase64(rawB64);
          if (safe !== rawB64) {
            setExtraPhotos((xs) => xs.map((x) => x === entry
              ? { ...x, uri: `data:image/jpeg;base64,${safe}`, base64: safe }
              : x));
          }
        } catch (inner) {
          console.warn('[Capture-extra] single blur also failed, keeping raw:', inner);
        }
      } finally {
        blurPromiseRef.current = null;
      }
    });
    blurPromiseRef.current = p;
  };

  /**
   * PR 5: take a photo, then ask "Take another?" and loop until Done.
   * expo-image-picker doesn't support true multi-capture (returns one
   * asset per launch), so we loop the native picker. First snap fills
   * the primary slot if empty; each subsequent snap becomes an extra.
   * Documented as a PWA/RN asymmetry in docs/PARITY.md (PWA camera can
   * multi-snap without re-opening the picker).
   */
  const takePhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('permission_needed'), t('permission_camera'));
      return;
    }
    await detectNetworkTier();
    const config = getAdaptiveConfig();
    console.log(`[Camera] Network: ${config.tier}, quality: ${config.imageQuality}, maxWidth: ${config.imageMaxWidth}`);

    // Track primary-slot state locally — React state updates are async so the
    // closure value from `photoUri` would be stale mid-loop.
    let primaryFilled = !!photoUri;

    while (true) {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: config.imageQuality,
        base64: true,
      });
      if (result.canceled || !result.assets?.[0] || !result.assets[0].base64) break;
      const asset = result.assets[0];

      if (!primaryFilled) {
        setPhotoUri(asset.uri);
        _applyClientBlur(asset.base64!, asset.uri, config.tier);
        primaryFilled = true;
      } else {
        _ingestExtraFromUri(asset.uri, asset.base64!);
      }

      // Phase A1 (Apr 2026 UI v3) — if the cap has been reached after this
      // snap, short-circuit the "Take another?" prompt. We peek at the
      // current state via a functional update-noop (the only synchronous
      // way to read extras-length inside a while loop that might batch
      // setState callbacks).
      let currentExtrasLen = 0;
      setExtraPhotos((xs) => { currentExtrasLen = xs.length; return xs; });
      if (currentExtrasLen >= MAX_EXTRA_PHOTOS) {
        try {
          Alert.alert('', (t as any)('photo_cap_reached') || `Max ${MAX_PHOTOS_TOTAL} photos per report`);
        } catch (_) { /* best-effort */ }
        break;
      }

      const wantMore = await new Promise<boolean>((resolve) => {
        // Apr 2026 i18n sweep (R7) — alert title/body/buttons now route
        // through keys so field workers see prompts in their own locale.
        Alert.alert(
          t('take_another_title'),
          t('take_another_body'),
          [
            { text: t('btn_done'), style: 'cancel', onPress: () => resolve(false) },
            { text: t('take_another_yes'), onPress: () => resolve(true) },
          ],
          { cancelable: false, onDismiss: () => resolve(false) }
        );
      });
      if (!wantMore) break;
    }
  };

  /**
   * PR 5: multi-select from the gallery. First asset fills the primary
   * slot if empty; remaining assets become extras. expo-image-picker
   * supports `allowsMultipleSelection` for the library (unlike the camera).
   */
  const pickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('permission_needed'), t('permission_gallery'));
      return;
    }
    await detectNetworkTier();
    const config = getAdaptiveConfig();

    // Phase A1 (Apr 2026 UI v3) — cap the gallery picker's selectionLimit so
    // the user can't even see the ghost of a 6th photo. Accounts for the
    // primary slot: if it's empty, one of the picked assets fills it (no
    // drain on the extras quota); if it's taken, every pick is an extra.
    const primaryPresent = !!photoUri;
    const extrasLeft = Math.max(0, MAX_EXTRA_PHOTOS - extraPhotos.length);
    const selectionLimit = primaryPresent ? extrasLeft : extrasLeft + 1;
    if (selectionLimit <= 0) {
      const now = Date.now();
      if (now - _lastCapAlertAt > _CAP_ALERT_MIN_MS) {
        _lastCapAlertAt = now;
        Alert.alert('', (t as any)('photo_cap_reached') || `Max ${MAX_PHOTOS_TOTAL} photos per report`);
      }
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: config.imageQuality,
      base64: true,
      allowsMultipleSelection: true,
      selectionLimit,
    });
    if (result.canceled || !result.assets?.length) return;

    const startedWithPrimary = !!photoUri;
    result.assets.forEach((asset, i) => {
      if (!asset.base64) return;
      if (!startedWithPrimary && i === 0) {
        setPhotoUri(asset.uri);
        _applyClientBlur(asset.base64, asset.uri, config.tier);
      } else {
        _ingestExtraFromUri(asset.uri, asset.base64);
      }
    });
  };

  /**
   * Phase 4: add more photos to the extraPhotos array.
   * PR 5: now multi-select — all picked assets become extras.
   */
  const pickExtraImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(t('permission_needed'), t('permission_gallery'));
      return;
    }
    // Phase A1 (Apr 2026 UI v3) — narrow the gallery picker's selection
    // ceiling to the remaining capacity so the user never even sees the
    // 6th / 7th / … nth photo as a picked-ghost. Falls through to the
    // per-push guard in _ingestExtraFromUri for the primary-present race
    // (user picks before primary capture completes).
    const remaining = Math.max(0, MAX_EXTRA_PHOTOS - extraPhotos.length);
    if (remaining <= 0) {
      const now = Date.now();
      if (now - _lastCapAlertAt > _CAP_ALERT_MIN_MS) {
        _lastCapAlertAt = now;
        Alert.alert('', (t as any)('photo_cap_reached') || `Max ${MAX_PHOTOS_TOTAL} photos per report`);
      }
      return;
    }
    await detectNetworkTier();
    const config = getAdaptiveConfig();
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: config.imageQuality,
      base64: true,
      allowsMultipleSelection: true,
      selectionLimit: remaining,
    });
    if (result.canceled || !result.assets?.length) return;
    result.assets.forEach((asset) => {
      if (!asset.base64) return;
      _ingestExtraFromUri(asset.uri, asset.base64);
    });
  };

  const removeExtraPhoto = (i: number) => {
    setExtraPhotos((xs) => xs.filter((_, j) => j !== i));
  };

  // Apr 2026: delete the primary photo. If there are extras, the first extra
  // is promoted so the user still has at least one capture (photo is
  // mandatory downstream). Otherwise photoUri is cleared and the user sees
  // the empty-state capture buttons again.
  const deletePrimaryPhoto = () => {
    if (extraPhotos.length > 0) {
      const [first, ...rest] = extraPhotos;
      setPhotoUri(first.uri);
      setPhotoBase64(first.base64);
      setPhotoVariants(first.variants || null);
      setPhotoGroupId(first.groupId || '');
      setExtraPhotos(rest);
    } else {
      setPhotoUri(null);
      setPhotoBase64('');
      setPhotoVariants(null);
      setPhotoGroupId('');
    }
  };

  // Commit the pending delete from the image viewer. Branches on the
  // viewer's stored `kind` so primary and extras go through their
  // respective code paths.
  const confirmViewerDelete = () => {
    if (!viewerState) { setViewerConfirmOpen(false); return; }
    if (viewerState.kind === 'primary') {
      deletePrimaryPhoto();
    } else if (viewerState.kind === 'extra' && typeof viewerState.index === 'number') {
      removeExtraPhoto(viewerState.index);
    }
    setViewerConfirmOpen(false);
    setViewerState(null);
  };

  const togglePressingNeed = (need: string) => {
    setPressingNeeds((xs) => xs.includes(need) ? xs.filter(n => n !== need) : [...xs, need]);
  };

  /**
   * Shared post-capture hook: show the photo immediately, then generate
   * SMALL/MEDIUM/LARGE variants (each PII-blurred) in the background without
   * blocking navigation. submitReport() awaits `blurPromiseRef` before it
   * reads the variant state, so even a user who races through to Send ends
   * up with variants queued correctly.
   *
   * On any variant-generation failure we fall through to the original
   * single-blur path — guaranteed-delivery is an enhancement on top of the
   * existing pipeline, not a hard replacement.
   */
  const _applyClientBlur = (rawB64: string, rawUri: string, tier: string) => {
    setPhotoBase64(rawB64);           // raw immediately — user can proceed now
    setPhotoVariants(null);
    const groupId = crypto.randomUUID();
    setPhotoGroupId(groupId);
    setIsBlurring(true);
    // Defer the heavy blur+variants pipeline via InteractionManager so the
    // Next / shutter / Browse buttons stay responsive in the ~400ms window
    // right after capture (PWA mirrors this with requestIdleCallback; see
    // _runWhenIdle in mobile-app/src/app.js). submitReport() still awaits
    // blurPromiseRef before reading variants, so a user who races through
    // to Send ends up with everything correctly queued.
    const p = _runAfterInteractions(async () => {
      try {
        const variants = await generateVariants(rawUri, rawB64);
        setPhotoVariants(variants);
        // Update preview to the SMALL blurred variant — same bytes the
        // dashboard will see first, so what the user sees pre-submit and
        // what the analyst sees post-submit match.
        setPhotoBase64(variants.small.base64);
        setPhotoUri(`data:image/jpeg;base64,${variants.small.base64}`);
        console.log(
          `[Capture] Variants ready — small=${Math.round(variants.small.bytes / 1024)}KB ` +
          `medium=${Math.round(variants.medium.bytes / 1024)}KB ` +
          `large=${Math.round(variants.large.bytes / 1024)}KB (net=${tier}) groupId=${groupId.slice(0, 8)}`
        );
      } catch (e) {
        // Variant pipeline failed — fall back to the plain single-blur path
        // so the photo still uploads at full quality (just not progressively).
        console.warn('[Capture] variant generation failed, falling back to single blur:', e);
        try {
          const safe = await blurFacesBase64(rawB64);
          setPhotoBase64(safe);
          if (safe !== rawB64) setPhotoUri(`data:image/jpeg;base64,${safe}`);
        } catch (inner) {
          console.warn('[Capture] single blur also failed, keeping raw:', inner);
        }
      } finally {
        setIsBlurring(false);
        blurPromiseRef.current = null;
      }
    });
    blurPromiseRef.current = p;
  };

  const startRecording = async () => {
    try {
      const status = await AudioModule.requestRecordingPermissionsAsync();
      if (!status.granted) {
        Alert.alert(t('permission_needed'), t('permission_microphone'));
        return;
      }
      // iOS requires audio mode to be set before recording
      await AudioModule.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });

      // Adaptive audio bitrate based on network speed
      await detectNetworkTier();
      const config = getAdaptiveConfig();
      const adaptiveBitrate = config.audioBitrate * 1000; // kbps → bps
      console.log(`[Audio] Network: ${config.tier}, bitrate: ${config.audioBitrate}kbps`);
      await audioRecorder.prepareToRecordAsync({ bitRate: adaptiveBitrate });

      audioRecorder.record();
      setIsRecording(true);
      // Start the MM:SS elapsed-time ticker. We tick every 1 s — good
      // enough resolution for a crisis report and won't re-render too
      // aggressively. Ref is cleared on stop or unmount.
      setRecordingSeconds(0);
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = setInterval(() => {
        setRecordingSeconds((n) => n + 1);
      }, 1000);
    } catch (e: any) {
      console.error('[Audio] Start failed:', e);
      // Apr 2026 i18n sweep — localised error copy. The underlying
      // error string stays in English console logs above; the user-
      // visible alert body uses their active locale via t(). Title
      // falls back to a short English "Error" since we haven't spun
      // up a dedicated title key (most locales use "Error" verbatim).
      Alert.alert('Error', t('error_recording'));
    }
  };

  const stopRecording = async () => {
    try {
      await audioRecorder.stop();
      setIsRecording(false);
      // Drop the ticker reference; we keep the final elapsed value on
      // screen for the brief moment before the user taps Next so the
      // UX cue "you recorded X seconds" persists.
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
      const uri = audioRecorder.uri;
      if (uri) {
        setAudioUri(uri);
        console.log('[Audio] Recorded:', uri);
      }
      // Reset audio mode for playback
      await AudioModule.setAudioModeAsync({ allowsRecording: false });
    } catch (e: any) {
      console.error('[Audio] Stop failed:', e);
      setIsRecording(false);
    }
  };

  const getLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude, acc: loc.coords.accuracy || 0 });
      // Reverse geocode
      try {
        const geo = await Location.reverseGeocodeAsync({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
        if (geo[0]) {
          const parts = [geo[0].name, geo[0].city, geo[0].region].filter(Boolean);
          setLocationName(parts.join(', '));
        }
      } catch (e) { telemetrySwallow('reverseGeocode', e); }
      // Phase B2 (Apr 2026 UI v3) — warm the AsyncStorage building cache with
      // the 10 nearest footprints. Non-blocking; failures are silent. The
      // free-text fallback + future autocomplete consume this list.
      try {
        preCacheNearest(loc.coords.latitude, loc.coords.longitude, 10)
          .then((list) => {
            if (Array.isArray(list) && list.length > 0) {
              console.log(`[BuildingPreCache] ${list.length} buildings cached`);
              setNearbyBuildings(list);
            }
          })
          .catch(() => {});
      } catch (_) { /* best-effort */ }
    } catch (e) { telemetrySwallow('getLocation', e); }
  };

  // Consent-gate state — mirrors the PWA's _initConsentGate. The render
  // tree below is covered by <ConsentOverlay> until `consentGiven` flips
  // true, either because the user just accepted OR because a prior
  // launch already persisted acceptance in AsyncStorage.
  const [consentGiven, setConsentGiven] = useState<boolean | null>(null);

  // Recording-timer cleanup: if the component unmounts mid-record, kill
  // the interval to avoid setState-on-unmounted warnings + rogue ticks.
  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) {
        clearInterval(recordingTimerRef.current);
        recordingTimerRef.current = null;
      }
    };
  }, []);

  /**
   * Apr 2026 UI v2 — Android hardware-Back hook. When the review stage
   * is showing the 3-page split, pressing the OS back button should step
   * through the pages rather than punt the whole stage back to audio.
   * Only mounts on Android (BackHandler is a no-op on iOS); only fires
   * on pages 2–3 so page 1 still falls through to the audio screen.
   *
   * Returning `true` signals "handled" to the OS; `false` lets default
   * behaviour run. We gate on uiV2 so the old monolithic review flow
   * keeps its original system-back semantics when the flag is off.
   */
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    if (!uiV2) return;
    if (screen !== 'review_details') return;
    const onBack = () => {
      if (reviewPage > 1) {
        setReviewPage((p) => reviewReducer(p, { type: 'BACK' }));
        return true;
      }
      return false;  // let the OS pop to audio
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [uiV2, screen, reviewPage]);

  /**
   * Reset reviewPage back to 1 whenever the user (re)enters the review
   * stage. Without this a user who Back-navs to audio and then returns
   * would briefly see their previous page-2 state before the render
   * settled — disorienting for low-literacy field workers.
   */
  useEffect(() => {
    if (screen === 'review_details') {
      setReviewPage((p) => reviewReducer(p, { type: 'RESET' }));
    }
  }, [screen]);

  useEffect(() => {
    // Apr 2026 UI v2 flag read — fire-and-forget. See readUiV2Flag() for
    // rollback semantics. Runs in the same mount effect so no extra
    // render is triggered after the rest of the boot sequence settles.
    readUiV2Flag().then((on) => { setUiV2(on); }).catch(() => { /* keep default */ });
    readUiV3Flag().then((on) => { setUiV3(on); }).catch(() => { /* keep default */ });
    // Phase 1 (Apr 2026 — Optional reporter login). Initialise AuthStore
    // once — it hydrates from expo-secure-store + AsyncStorage. Failures
    // are swallowed; the UI just shows "Login / Sign up" as a fallback.
    try {
      AuthStore.setApiBase(getApiBase());
      AuthStore.init().then(() => {
        setAuthReady(true);
        setAuthLoggedIn(AuthStore.isLoggedIn());
        setAuthDisplay(AuthStore.getProfile().displayName);
      }).catch(() => { setAuthReady(true); });
    } catch { setAuthReady(true); }
    // Device-locale country-code default (user spec answer 4).
    try {
      const locale = (typeof navigator !== 'undefined' && (navigator as any).language) || 'en-IN';
      const region = ((locale as string).split('-')[1] || 'IN').toUpperCase();
      const map: Record<string, string> = {
        IN: '+91', US: '+1', CA: '+1', GB: '+44', KE: '+254', NG: '+234',
        BD: '+880', PK: '+92', LK: '+94', NP: '+977', ID: '+62', PH: '+63',
        EG: '+20', MA: '+212', AE: '+971', SA: '+966', RU: '+7', CN: '+86',
        JP: '+81', FR: '+33', DE: '+49', ES: '+34', BR: '+55', MX: '+52',
      };
      if (map[region]) setLoginCC(map[region]);
    } catch { /* leave default */ }
    // Language: honour stored manual choice, else auto-detect device locale.
    // This is async because AsyncStorage is async. applyTextDirection() fires
    // I18nManager.forceRTL internally for Arabic/Urdu/Hebrew/... and reloads
    // the bundle in dev mode so the flip takes effect without a manual
    // Ctrl-R. See services/i18n.ts for the full policy.
    bootstrapLanguage().then((resolved) => {
      setLang(resolved);
    }).catch(() => {
      // Any failure = fall back to auto-detected device lang.
      const detected = detectLanguage();
      setLanguage(detected);
      setLang(detected);
    });
    // Consent: read persisted acceptance; show the overlay if missing.
    AsyncStorage.getItem('crisp_privacy_consent').then((raw) => {
      if (!raw) { setConsentGiven(false); return; }
      try {
        const parsed = JSON.parse(raw);
        setConsentGiven(parsed?.accepted === true);
      } catch { setConsentGiven(false); }
    }).catch(() => setConsentGiven(false));
    initDatabase();
    updateQueueCount();
    getLocation();
    // Pre-load the BlazeFace model in the background so the first photo
    // capture pays ~0 ms of model-load latency. Swallows errors — if the
    // model can't load we'll just fall back to server-side PII blur.
    prewarmPIIBlur();
    // Stable device hash (persist across sessions for status tracking)
    AsyncStorage.getItem('crisp_device_hash').then(async (stored) => {
      if (stored) { setDeviceHash(stored); } else {
        const hash = `ANDROID-${crypto.randomUUID().substring(0, 12)}`;
        await AsyncStorage.setItem('crisp_device_hash', hash);
        setDeviceHash(hash);
      }
    });
    // Load history
    refreshHistory();
    // Network listener — sync silently in background, never show errors
    const unsub = NetInfo.addEventListener(state => {
      const online = !!(state.isConnected && state.isInternetReachable);
      setIsOnline(online);
      if (online) processQueue().then(updateQueueCount).catch(() => {});
    });
    const interval = setInterval(async () => {
      try {
        const net = await NetInfo.fetch();
        if (net.isConnected) { await processQueue(); await updateQueueCount(); }
      } catch (e) { telemetrySwallow('bg-sync-tick', e); }
    }, 30000);
    return () => { unsub(); clearInterval(interval); };
  }, []);

  const updateQueueCount = async () => setQueueCount(await getQueueCount());
  // ── Apr 2026 "My Reports" spec — shared helpers (parity with PWA) ──────
  //
  // 4-state user-facing status derived from the backend's two orthogonal
  // fields (status enum + reviewer_verdict). Verdict-first mapping — see
  // mobile-app/src/app.js:_mapReportStatus for the canonical spec.
  const mapReportStatus = (r: any): { state: string; color: string; icon: string; label: string } => {
    const verdict = r?.reviewer_verdict || 'NOT_REVIEWED';
    const status = String(r?.status || 'PENDING').toUpperCase();
    if (verdict === 'ACCEPTED') return { state: 'ACCEPTED', color: '#22c55e', icon: '🟢', label: 'Accepted' };
    if (verdict === 'REJECTED' || status === 'FALSE_ALARM') return { state: 'REJECTED', color: '#ef4444', icon: '🔴', label: 'Rejected' };
    if (status === 'RESPONDING') return { state: 'UNDER_REVIEW', color: '#eab308', icon: '🟡', label: 'Under Review' };
    return { state: 'SUBMITTED', color: '#9ca3af', icon: '⚪', label: 'Submitted' };
  };

  // Auto-derive the "Action taken" sentence from timestamps + verdict.
  const deriveActionTaken = (r: any): string[] => {
    const lines: string[] = [];
    if (r?.help_arrived_at) lines.push('Help arrived on scene');
    else if (r?.help_dispatched_at) lines.push('Help dispatched');
    else if ((r?.reviewer_verdict || '') === 'ACCEPTED') lines.push('Accepted — awaiting dispatch');
    if ((r?.reviewer_verdict || '') === 'ACCEPTED' && r?.action_taken && String(r.action_taken).trim()) {
      lines.push(String(r.action_taken).trim());
    }
    return lines;
  };

  const timeAgo = (iso?: string | null): string => {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return '';
    const diff = Math.max(0, (Date.now() - t) / 1000);
    if (diff < 60) return `${Math.round(diff)}s ago`;
    if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    const days = Math.round(diff / 86400);
    if (days === 1) return '1 day ago';
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
  };

  // ── Offline delete queue ────────────────────────────────────────────────
  const DELETE_QUEUE_KEY = 'crisp_report_delete_queue_v1';

  const _loadDeleteQueue = React.useCallback(async (): Promise<string[]> => {
    try {
      const raw = await AsyncStorage.getItem(DELETE_QUEUE_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }, []);

  const _saveDeleteQueue = React.useCallback(async (q: string[]) => {
    try { await AsyncStorage.setItem(DELETE_QUEUE_KEY, JSON.stringify(q)); } catch {}
  }, []);

  const enqueueDelete = React.useCallback(async (id: string) => {
    const q = await _loadDeleteQueue();
    if (!q.includes(id)) q.push(id);
    await _saveDeleteQueue(q);
    setDeleteQueue(q);
  }, [_loadDeleteQueue, _saveDeleteQueue]);

  const syncDeleteQueue = React.useCallback(async () => {
    if (!isOnline) return;
    const q = await _loadDeleteQueue();
    if (!q.length) return;
    const remaining: string[] = [];
    for (const id of q) {
      try {
        const res = await fetch(`${getApiBase()}/reports/${id}`, { method: 'DELETE' });
        if (!(res.ok || res.status === 204 || res.status === 404)) remaining.push(id);
      } catch {
        remaining.push(id);
      }
    }
    await _saveDeleteQueue(remaining);
    setDeleteQueue(remaining);
  }, [isOnline, _loadDeleteQueue, _saveDeleteQueue]);

  // Load the queue on mount + flush whenever we come back online.
  React.useEffect(() => {
    _loadDeleteQueue().then(setDeleteQueue);
  }, [_loadDeleteQueue]);
  React.useEffect(() => {
    if (isOnline) syncDeleteQueue().catch(() => {});
  }, [isOnline, syncDeleteQueue]);

  const refreshHistory = async () => {
    try {
      setHistory(await getHistory());
      setImpactStats(await getImpactStats());
      setPendingReports(await getInFlightReports());
    } catch (e) { telemetrySwallow('refreshHistory', e); }
  };

  /** Phase 5e (Apr 2026) — celebratory delta detection. Compares the current
   *  status-since response against a snapshot saved on the last refresh so
   *  we can surface "🎉 Your report was accepted!" or "💚 N lives helped"
   *  without spamming the user on every tick. */
  const checkCelebrationDelta = async (updates: any[]) => {
    if (!updates || updates.length === 0) return;
    try {
      const raw = await AsyncStorage.getItem('crisp_celebration_snapshot_v1');
      const prev: Record<string, { verdict: string; lives: number }> = raw ? JSON.parse(raw) : {};
      let acceptedN = 0;
      let livesDelta = 0;
      const next: Record<string, { verdict: string; lives: number }> = {};
      for (const u of updates) {
        const crid = u.client_report_id || u.id;
        const curVerdict = u.reviewer_verdict || 'NOT_REVIEWED';
        const curLives = Number.isFinite(u.lives_impacted) ? u.lives_impacted : 0;
        const prevEntry = prev[crid];
        if (prevEntry) {
          if (prevEntry.verdict !== 'ACCEPTED' && curVerdict === 'ACCEPTED') acceptedN++;
          if (curLives > (prevEntry.lives || 0)) livesDelta += (curLives - (prevEntry.lives || 0));
        }
        next[crid] = { verdict: curVerdict, lives: curLives };
      }
      await AsyncStorage.setItem('crisp_celebration_snapshot_v1', JSON.stringify(next));
      // Only fire alerts if we had a prior snapshot (avoid false positive on
      // the very first poll after app install).
      if (raw) {
        if (acceptedN > 0) {
          Alert.alert('🎉 Report accepted',
            `${acceptedN} of your report${acceptedN > 1 ? 's were' : ' was'} accepted by analysts. Thank you for helping.`);
        }
        if (livesDelta > 0) {
          Alert.alert('💚 Lives helped',
            `Your reports helped ${livesDelta} more ${livesDelta > 1 ? 'lives' : 'life'}!`);
        }
      }
    } catch (e) {
      telemetrySwallow('celebrationDelta', e);
    }
  };
  const pollStatus = async () => {
    if (!deviceHash || !isOnline) return;
    try {
      const lastPoll = await AsyncStorage.getItem('crisp_last_poll');
      const updates = await getDeviceStatusSince(deviceHash, lastPoll || undefined);
      // Phase 5e: check for newly-accepted / lives-delta moments BEFORE we
      // persist the new status, so the "was" state is still the cached snapshot.
      await checkCelebrationDelta(updates as any[]);
      for (const u of updates as any[]) {
        // Phase 5 (Apr 2026): mirror reviewer-workflow fields into the local
        // report_history table so My Reports renders verdict / response-time /
        // action-taken even when the device is offline next time.
        const toMs = (iso: any) => {
          if (!iso) return null;
          const ts = new Date(iso).getTime();
          return Number.isFinite(ts) ? ts : null;
        };
        const reviewer = {
          verdict: (u.reviewer_verdict !== undefined) ? u.reviewer_verdict : undefined,
          actionTaken: (u.action_taken !== undefined) ? u.action_taken : undefined,
          helpDispatchedAt: (u.help_dispatched_at !== undefined) ? toMs(u.help_dispatched_at) : undefined,
          helpArrivedAt: (u.help_arrived_at !== undefined) ? toMs(u.help_arrived_at) : undefined,
          responseTimeSeconds: (u.response_time_seconds !== undefined) ? u.response_time_seconds : undefined,
        };
        await updateHistoryStatus(u.id, u.status, u.lives_impacted, reviewer);
      }
      await AsyncStorage.setItem('crisp_last_poll', new Date().toISOString());
      await refreshHistory();
    } catch (e) { telemetrySwallow('pollStatus', e); }
  };
  const changeLang = (code: string) => { setLanguage(code); setLang(code); };
  const resetReport = () => {
    setPhotoUri(null); setPhotoBase64(null); setAudioUri(null); setDescription('');
    setInfraType('RESIDENTIAL'); setSeverity('MODERATE');
    setCrisisType('FLOOD'); setDamageClass('PARTIAL'); setInfraName(''); setInfraNameFromOsm(false); setDebrisClearing(false);
    setLocation(null); setLocationName(''); setIsSending(false); setReportId('');
    // Phase 4 — reset the new service/needs/extra-photos state too.
    setElectricityStatus('UNKNOWN'); setWaterStatus('UNKNOWN'); setHealthStatus('UNKNOWN');
    setPressingNeeds([]); setExtraPhotos([]);
    setIsLocationUserCorrected(false); setUserLocationName('');
    // Guaranteed-delivery — clear variant state so the next capture starts clean.
    setPhotoVariants(null); setPhotoGroupId(null);
    // Phase 4 — clear auto-submit state so the next Start Report evaluates
    // geofence fresh and the old region name doesn't bleed into a new flow.
    setActiveRegion(null); setIsAutoSubmit(false);
  };

  const submitReport = async () => {
    setIsSending(true);
    try {
      const clientId = crypto.randomUUID();

      // ── ALL LOCAL — no network calls here ──
      // If client-side PII blur is still in flight, wait for it before reading
      // photoBase64 — otherwise a fast user submits the raw unblurred bytes.
      if (blurPromiseRef.current) {
        try { await blurPromiseRef.current; } catch { /* fall through with raw */ }
      }
      // Photo: already captured as base64 from ImagePicker (no network needed)
      const photoData = photoBase64 ? `data:image/jpeg;base64,${photoBase64}` : null;

      // Audio: read local file as base64 (no network needed).
      // Expo SDK 54 removed the top-level FileSystem.readAsStringAsync — now
      // it throws at runtime. Use the new `new File(uri).base64()` API. This
      // was the bug causing audio to never reach the server: the old call
      // threw, the try/catch below swallowed it, and audioData stayed null.
      let audioData: string | null = null;
      if (audioUri) {
        try {
          const b64 = await new File(audioUri).base64();
          audioData = `data:audio/m4a;base64,${b64}`;
          console.log(`[Audio] Read ${Math.round(b64.length / 1024)}KB from ${audioUri}`);
        } catch (e) {
          console.warn('[Offline] Audio read failed (file may be gone):', e);
        }
      }

      // Serialise extra photos to data-URIs so syncEngine can chunk them
      // alongside the primary photo. Kept as a JSON-serialisable array.
      const extraPhotoDataUrls = extraPhotos.map(x => `data:image/jpeg;base64,${x.base64}`);

      // Phase 4: meta payload now mirrors the PWA shape — service_status,
      // pressing_needs, and the full set of location-correction fields.
      // Guaranteed-delivery: each photo with variants becomes 3 Media rows
      // on the backend. expected_media must reflect that so the report
      // eventually flips to SYNCED.
      const mainHasVariants = !!photoVariants;
      const extrasWithVariants = extraPhotos.filter(e => e.variants).length;
      const extrasWithoutVariants = extraPhotoDataUrls.length - extrasWithVariants;
      const expectedMedia =
        (photoData ? (mainHasVariants ? 3 : 1) : 0) +
        (extrasWithVariants * 3) + extrasWithoutVariants +
        (audioData ? 1 : 0);
      const meta = {
        device_hash: deviceHash || `ANDROID-${crypto.randomUUID().substring(0, 8)}`,
        client_report_id: clientId, source: 'ANDROID', severity, infrastructure_type: infraType,
        description: description || '', detected_language: lang,
        expected_media: expectedMedia,
        // Phase 4 (Apr 2026): flag region-timer-driven submissions so server
        // telemetry can distinguish manual vs auto-submit reports.
        is_auto_submitted: isAutoSubmit,
        crisis_type: crisisType, damage_classification: damageClass,
        infrastructure_name: infraName || null, debris_clearing_needed: debrisClearing,
        // Phase B2 (Apr 2026 UI v3) — distinguisher between OSM-auto-filled and
        // user-typed building names. See backend/app/schemas/report.py
        // ReportMetaCreate.infrastructure_name_from_osm for the full rationale.
        // Dashboard flags `building_id IS NULL AND infrastructure_name_from_osm
        // = false` as "needs mapping" so operators can resolve the free-text
        // entry to a real OSM footprint later.
        infrastructure_name_from_osm: Boolean(infraNameFromOsm),
        // UNDP Appendix 1 — pin to an OSM way id when the reporter picked
        // an exact building footprint. Backend expects `osm:way:<id>` or null.
        building_id: buildingId || null,
        // Phase-1 progressive-upload placeholder. Captured by
        // generateVariants() → jpeg-js decode → blurhash encode. Dashboard
        // renders this the instant the meta POST lands — BEFORE any media
        // chunk arrives. ~28–32-char string (~100 ms at 2 Kbps).
        blurhash: photoVariants?.blurhash || null,
        service_status: {
          electricity: electricityStatus,
          water: waterStatus,
          health: healthStatus,
          pressing_needs: pressingNeeds,
        },
        ...(location ? { location: {
          latitude: location.lat,
          longitude: location.lng,
          device_latitude: location.lat,
          device_longitude: location.lng,
          accuracy_meters: location.acc || 0,
          device_location_name: locationName || null,
          user_location_name: userLocationName || null,
          is_user_corrected: isLocationUserCorrected,
        } } : {}),
      };

      // Guaranteed-delivery — serialize variant payloads alongside the
      // legacy single-photo fields. syncEngine picks the variant path when
      // `photo_variants` is present, falling back to `photo` otherwise.
      const makeVariantRecord = (v: PhotoVariants) => ({
        small:  { mediaId: crypto.randomUUID(), base64: v.small.base64,  chunkProgress: 0, complete: false, bytes: v.small.bytes },
        medium: { mediaId: crypto.randomUUID(), base64: v.medium.base64, chunkProgress: 0, complete: false, bytes: v.medium.bytes },
        large:  { mediaId: crypto.randomUUID(), base64: v.large.base64,  chunkProgress: 0, complete: false, bytes: v.large.bytes },
      });
      const photoVariantsJson = photoVariants
        ? JSON.stringify(makeVariantRecord(photoVariants)) : null;
      const extraPhotosVariantsJson = extraPhotos.length && extraPhotos.some(e => e.variants)
        ? JSON.stringify(extraPhotos.map(e => e.variants ? ({
            groupId: e.groupId || crypto.randomUUID(),
            ...makeVariantRecord(e.variants),
          }) : null))
        : null;

      // Save to LOCAL SQLite — works 100% offline, no network needed.
      // extra_photos is a JSON blob so the sync engine can replay it.
      await enqueueReport({
        client_report_id: clientId,
        meta: JSON.stringify(meta),
        photo: photoData,
        audio: audioData,
        text_description: description,
        status: 'pending_sync',
        extra_photos: extraPhotoDataUrls.length ? JSON.stringify(extraPhotoDataUrls) : null,
        photo_variants: photoVariantsJson,
        photo_group_id: photoGroupId || null,
        extra_photos_variants: extraPhotosVariantsJson,
      } as any);
      setReportId(clientId.substring(0, 8));
      await updateQueueCount();

      // Show success immediately — data is safe in local DB
      setScreen('success');

      // Try background sync SILENTLY — never show errors to user
      // If offline, sync will happen automatically when network returns
      processQueue().then(updateQueueCount).catch(() => {});

    } catch (e: any) {
      console.error('[Submit] Local save error:', e);
      // Apr 2026 i18n sweep — localised error copy.
      Alert.alert('Error', t('error_save_local'));
    }
    setIsSending(false);
  };

  // Phase B4 (Apr 2026 UI v3, Apr-23 spec-align) — 8 UNDP Appendix-1
  // super-types replacing the 9 legacy chips. Enum values match
  // InfraTypeEnum on the backend so no client → server remap needed.
  // v2 fallback: when `uiV3` is false, the legacy `typesLegacy` array is
  // rendered instead.
  const types = [
    { key: 'RESIDENTIAL',           icon: '🏠',  label: (t as any)('residential') || 'Residential' },
    { key: 'COMMERCIAL',            icon: '🏢',  label: (t as any)('commercial') || 'Commercial' },
    { key: 'GOVERNMENT',            icon: '🏛',  label: (t as any)('government') || 'Government' },
    { key: 'UTILITY',               icon: '⚡',  label: (t as any)('utility') || 'Utility' },
    { key: 'TRANSPORT_COMMUNICATION', icon: '🛣', label: (t as any)('transport_communication') || 'Transport' },
    { key: 'COMMUNITY',             icon: '🏥',  label: (t as any)('community_infra') || 'Community' },
    { key: 'PUBLIC_SPACES',         icon: '🌳',  label: (t as any)('public_spaces') || 'Public Space' },
    { key: 'OTHER',                 icon: '❓',  label: t('type_other') || 'Other' },
  ];
  // Legacy chip set, kept for the v2 fallback path. Same `key` strings
  // the backend's UI_CHIP_TO_UNDP mapper normalises at write time.
  const typesLegacy = [
    { key: 'ROAD',       icon: '🛣', label: t('type_road') },
    { key: 'HOSPITAL',   icon: '🏥', label: t('type_hospital') },
    { key: 'HOUSE',      icon: '🏠', label: t('type_house') },
    { key: 'POWER',      icon: '⚡', label: t('type_power') },
    { key: 'WATER',      icon: '💧', label: t('type_water') },
    { key: 'SCHOOL',     icon: '🏫', label: 'School' },
    { key: 'TELECOM',    icon: '📡', label: 'Telecom' },
    { key: 'GOVERNMENT', icon: '🏛', label: 'Gov. Building' },
    { key: 'OTHER',      icon: '❓', label: t('type_other') },
  ];
  const sevs = [
    { key: 'MINOR', icon: '🟢', label: t('sev_minor') },
    { key: 'MODERATE', icon: '🟠', label: t('sev_moderate') },
    { key: 'SEVERE', icon: '🔴', label: t('sev_severe') },
  ];
  // Phase 3: added CYCLONE (was missing from RN — parity bug).
  const crisisTypes = [
    // UNDP Appendix-1 crisis taxonomy — Natural / Technological / Human-made.
    // HURRICANE + WILDFIRE removed from the user-visible chip list; the
    // backend still accepts them for historical rows.
    // `labelKey` routes the chip label through i18n (all 22 locales); the
    // hardcoded `label` stays as the EN fallback. Render: t(labelKey) || label.
    { key: 'EARTHQUAKE',         icon: '🏚', labelKey: 'crisis_earthquake', label: 'Earthquake' },
    { key: 'FLOOD',              icon: '🌊', labelKey: 'crisis_flood',      label: 'Flood' },
    { key: 'TSUNAMI',            icon: '🌊', labelKey: 'crisis_tsunami',    label: 'Tsunami' },
    { key: 'CYCLONE',            icon: '🌪', labelKey: 'crisis_cyclone',    label: 'Cyclone' },
    { key: 'LANDSLIDE',          icon: '🏔', labelKey: 'crisis_landslide',  label: 'Landslide' },
    { key: 'EXPLOSION',          icon: '💥', labelKey: 'crisis_explosion',  label: 'Explosion' },
    { key: 'CHEMICAL_INCIDENT',  icon: '☣️', labelKey: 'crisis_chemical',   label: 'Chemical' },
    { key: 'PANDEMIC',           icon: '🦠', labelKey: 'crisis_pandemic',   label: 'Pandemic' },
    { key: 'CONFLICT',           icon: '⚔️', labelKey: 'crisis_conflict',   label: 'Conflict' },
    { key: 'CIVIL_UNREST',       icon: '🪧', labelKey: 'crisis_unrest',     label: 'Civil Unrest' },
    { key: 'OTHER',              icon: '❓', labelKey: 'crisis_other',      label: 'Other' },
  ];
  // UNDP Appendix-1 damage labels (Apr 2026 UI v2.1) — verbatim phrasing
  // from the spec: "Minimal / No damage", "Partially damaged", "Completely
  // damaged". `labelKey` routes through i18n; hardcoded `label` left as
  // the last-resort fallback if t() can't resolve the key. The canonical
  // stored value is MINIMAL — the backend normalises any legacy
  // NO_DAMAGE payload on write.
  const damageOptions = [
    { key: 'MINIMAL',  icon: '✅', labelKey: 'minimal_damage', label: 'Minimal / No damage',  color: '#22c55e' },
    { key: 'PARTIAL',  icon: '⚠️', labelKey: 'partial_damage', label: 'Partially damaged',   color: '#f97316' },
    { key: 'COMPLETE', icon: '❌', labelKey: 'complete_damage', label: 'Completely damaged', color: '#ef4444' },
  ];

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
    {/* R10: SafeAreaView edges limited to left/right/bottom so the status
         bar can render edge-to-edge (the translucent header handles the
         top inset itself). On devices with a gesture-area / bottom
         notch (most Android 12+) this prevents overflow of the CTA row. */}
    <SafeAreaView style={s.container} edges={['left','right','bottom']}>
      {/* (May 2026 — Fix-R5) — explicit translucent={false} so older
          Android (API 21-23) doesn't render content under the status
          bar despite the SafeAreaView edges config. backgroundColor
          must be set alongside for the opaque-bar path; barStyle
          stays light-content for our dark theme. */}
      <StatusBar
        barStyle="light-content"
        backgroundColor={Colors.bg}
        translucent={false}
      />

      {/* Phase 4 (Apr 2026) — Auto-submit timer banner, visible only during
           the capture flow (photo / audio / review / confirm) when the user's
           GPS is inside an enabled region. Tapping Cancel clears the
           activeRegion so the banner disappears and manual submit resumes. */}
      {activeRegion && (screen === 'photo' || screen === 'audio' ||
        screen === 'review_details' || screen === 'review_confirm' ||
        // Phase B4 (Apr 2026 UI v3) — auto-submit stays armed through
        // the new v3 capture stages too.
        screen === 'where' || screen === 'infra' ||
        screen === 'crisis' || screen === 'extras') && (
        <AutoSubmitTimer
          region={activeRegion}
          onCancel={() => {
            setActiveRegion(null);
            setIsAutoSubmit(false);
          }}
          onFire={() => {
            // Guard: must have at least one piece of content to submit.
            if (!photoUri && !audioUri && !description?.trim()) {
              // Apr 2026 i18n sweep — localised auto-submit guard copy.
              Alert.alert('Error', t('error_cannot_autosubmit'));
              setActiveRegion(null);
              return;
            }
            setIsAutoSubmit(true);
            setActiveRegion(null);
            submitReport();
          }}
        />
      )}

      {/* Apr 2026 UX rewrite — landing screen simplified:
            · Hero title + short sub (no "4 easy steps" promise).
            · IMPACT METRICS card (reports submitted + lives impacted) gives
              social proof without overwhelming first-time users.
            · ONE primary CTA: "Start Reporting".
            · ONE secondary entry: "My Reports" — which now hosts per-report
              + delete-all functionality (was a separate bottom link before).
            · Badge card lives BELOW the primary actions so users who just
              want to report never see distracting gamification first.
          Parity with PWA `stage-home` at mobile-app/src/index.html. */}
      {screen === 'home' && (
        // May 2026 — Phase 2 of RN ↔ PWA parity. The new <HomeScreen>
        // component matches the PWA's redesigned home stage (brand
        // row + Lifekeeper inline pill + consent + dominant CTA +
        // 5-tile utility row + 3×2 channels grid + privacy footer +
        // device-ID pill). The OLD in-line block beneath is kept
        // BEHIND the `useLegacyHome` flag for a one-flag rollback if
        // a field-test surfaces a regression. Default flips ON for
        // the new HomeScreen.
        <HomeScreen
          authReady={authReady}
          authLoggedIn={authLoggedIn}
          authDisplay={authDisplay}
          isOnline={isOnline}
          queueCount={queueCount}
          lang={lang}
          onChangeLang={changeLang}
          consentGiven={!!consentGiven}
          onConsentToggle={() => setConsentGiven(!consentGiven)}
          deviceId={deviceHash ? `CRISP-${deviceHash.slice(0, 4).toUpperCase()}-${deviceHash.slice(4, 8).toUpperCase()}` : ''}
          badgeLevel={null /* TODO Phase 6 — fetch from /reports/profile */}
          badgeLivesSaved={impactStats.totalLives}
          appVersion="v0.7.44"
          /* Phase 1 "Verified Reports Nearby" — pass already-cached
             location from the v4 capture flow. NeverPrompt rule: this
             never triggers a permission prompt on the home screen.
             When `location` is null, the NearbyReports module stays
             hidden until the user completes their first capture. */
          nearbyLat={location?.lat ?? null}
          nearbyLng={location?.lng ?? null}
          onStartReport={async () => {
            try {
              const { status } = await Location.getForegroundPermissionsAsync();
              if (status === 'granted') {
                const pos = await Location.getCurrentPositionAsync({
                  accuracy: Location.Accuracy.Balanced,
                });
                const regions = await getEnabledRegions();
                const match = findActiveRegion(
                  pos.coords.latitude, pos.coords.longitude, regions,
                );
                if (match) {
                  setActiveRegion(match);
                  console.log(`[AutoSubmit] armed — region="${match.name}"`);
                }
              }
            } catch (e) {
              console.log('[AutoSubmit] geofence check skipped:', (e as Error)?.message || e);
            }
            // May 2026 — Phase 3 route. When UI_V4_ENABLED flips to true
            // (after Phases 4 + 5 land), CTA routes to the single-page
            // v4_capture screen. Until then, fall through to the v3 'where'
            // flow (or legacy 'photo' if v3 is also off).
            setScreen(UI_V4_ENABLED ? 'v4_capture' : (uiV3 ? 'where' : 'photo'));
          }}
          onMyReports={() => { refreshHistory(); pollStatus(); setScreen('history'); }}
          onLogin={() => {
            setLoginStep(1); setLoginCode(''); setLoginError(''); setLoginLinkable(0);
            setScreen('login');
          }}
          onSettings={() => setScreen('settings')}
          onPrivacy={() => setScreen('settings') /* TODO Phase 7 — dedicated privacy stage */}
          onAudio={() => { /* TODO Phase 3 — TTS read-aloud */ }}
          onRewards={() => setScreen('v4_rewards')}
          onQueueTap={async () => {
            const { clearAllQueuedReports } = await import('./services/database');
            const cleared = await clearAllQueuedReports();
            updateQueueCount();
            Alert.alert('Queue Cleared', `${cleared} queued report${cleared !== 1 ? 's' : ''} removed.`);
          }}
        />
      )}

      {/* ══════════════════════════════════════════════════════════════════
           Phase 3 (May 2026 — RN ↔ PWA parity) — v4 single-page capture.
           Multi-modal capture screen: photo (camera + gallery) + voice
           (mic) + text (textarea) + smart-contextual tips card. The
           Continue button gates on ≥ 1 photo present. Hidden behind
           UI_V4_ENABLED until Phases 4 + 5 land (classify + review
           ports). The PWA's #stage-v4-capture is the canonical source
           of truth for the visual hierarchy + handler contract.
      ══════════════════════════════════════════════════════════════════ */}
      {screen === 'v4_capture' && (
        <V4CaptureScreen
          locationText={locationName || ''}
          locationCoords={
            location && location.lat !== 0
              ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}`
              : undefined
          }
          onRefreshGps={async () => {
            try {
              const loc = await Location.getCurrentPositionAsync({
                accuracy: Location.Accuracy.High,
              });
              setLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude, acc: loc.coords.accuracy || 0 });
              const geo = await Location.reverseGeocodeAsync({
                latitude: loc.coords.latitude, longitude: loc.coords.longitude,
              });
              if (geo[0]) {
                const parts = [geo[0].city, geo[0].region, geo[0].country].filter(Boolean);
                setLocationName(parts.join(', '));
              }
            } catch (e) {
              console.log('[v4] GPS refresh failed:', (e as Error)?.message || e);
            }
          }}
          onEditLocation={() => { /* TODO Phase 3.5 — inline location editor */ }}
          timeText={new Date().toLocaleString(undefined, {
            weekday: 'short', day: '2-digit', month: 'short',
            hour: '2-digit', minute: '2-digit',
          })}
          photoThumbs={[
            ...(photoUri ? [photoUri] : []),
            ...extraPhotos.map(p => p.uri),
          ]}
          photoMaxCount={MAX_PHOTOS_TOTAL}
          onOpenCamera={takePhoto}
          onOpenGallery={pickImage}
          onRemovePhoto={(i) => {
            if (i === 0) {
              setPhotoUri(null);
              setPhotoBase64(null);
              setPhotoVariants(null);
            } else {
              const next = extraPhotos.slice();
              next.splice(i - 1, 1);
              setExtraPhotos(next);
            }
          }}
          hasVoice={!!audioUri}
          isRecording={isRecording}
          onToggleVoice={isRecording ? stopRecording : startRecording}
          onClearVoice={() => setAudioUri(null)}
          textValue={description}
          onTextChange={setDescription}
          onBack={() => setScreen('home')}
          onContinue={() => {
            // Phase 4 — route to v4_classify when its port has landed
            // (it has, as of this commit). Phase 5 will reroute the
            // classify onContinue to 'v4_review'.
            setScreen('v4_classify');
          }}
        />
      )}

      {/* ══════════════════════════════════════════════════════════════════
           Phase 4 (May 2026 — RN ↔ PWA parity) — v4 classify auto-progress.
           Three sub-views on one screen: damage → infra → crisis. Tile
           tap fires a 200 ms Animated.timing pulse then advances the
           sub-step. OTHER infra tile reveals a text input and waits for
           blur / Enter to advance. Selection is fully persistent via
           App.tsx-owned state (damageClass / infraType / crisisType /
           infraName), so Back navigation preserves prior picks
           automatically.
      ══════════════════════════════════════════════════════════════════ */}
      {screen === 'v4_classify' && (
        <V4ClassifyScreen
          damageClass={damageClass}
          infraType={infraType}
          crisisType={crisisType}
          infraName={infraName}
          onSetDamage={setDamageClass}
          onSetInfra={(v) => {
            // Match the PWA behaviour: clear stale infra_name when the
            // user moves OFF the OTHER tile.
            if (v !== 'OTHER') {
              if (infraNameFromOsm) { setInfraNameFromOsm(false); }
              if (infraName) setInfraName('');
            }
            setInfraType(v);
          }}
          onSetCrisis={setCrisisType}
          onSetInfraName={setInfraName}
          onBack={() => setScreen(UI_V4_ENABLED ? 'v4_capture' : 'home')}
          onContinue={() => {
            // Phase 5 landed — route to v4_review.
            setScreen('v4_review');
          }}
        />
      )}

      {/* ══════════════════════════════════════════════════════════════════
           Phase 5 (May 2026 — RN ↔ PWA parity) — v4 review + Send.
           Step 3 of 3. Captured strip · summary edit rows ·
           building footprint mount · voice/text drawer · UNDP
           details drawer (debris Y/N · service status × 3 ·
           pressing needs multi-select) · Send button.
           This commit closes the App-Store-submission gate per
           V4_PARITY_DEFERRED.md — v4 flow is now end-to-end.
      ══════════════════════════════════════════════════════════════════ */}
      {screen === 'v4_review' && (
        <V4ReviewScreen
          hasPhoto={!!photoUri}
          hasVoice={!!audioUri}
          hasText={!!(description && description.trim().length > 0)}

          locationText={locationName || ''}
          infraType={infraType}
          crisisType={crisisType}
          damageClass={damageClass}

          buildingId={buildingId}
          buildingPickerNode={
            // UNDP must-have #6 — render the open-trigger + selected-
            // state pill inside V4 review's §D mount. App.tsx still
            // owns the BuildingFootprintPicker modal (mounted at the
            // bottom of the tree); this node just toggles its
            // visibility via setFootprintPickerOpen. Mirrors the v3
            // pattern at App.tsx:2438-2470 so reporters see the same
            // affordance regardless of which flow they enter from.
            buildingId ? (
              <View style={[s.locSelectedPill, { margin: 14 }]}>
                <Text style={s.locSelectedPillIcon}>✓</Text>
                <Text style={s.locSelectedPillText} numberOfLines={1}>
                  {t('building_selected')}: {infraNameFromOsm && infraName ? infraName : buildingId.replace('osm:way:', '#')}
                </Text>
                <TouchableOpacity
                  onPress={() => {
                    setBuildingId(null);
                    if (infraNameFromOsm) { setInfraName(''); setInfraNameFromOsm(false); }
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={t('edit')}>
                  <Text style={{ color: Colors.accent, fontWeight: '600', fontSize: 12 }}>
                    {t('edit')}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={[s.locFootprintBtn, {
                  margin: 14, paddingVertical: 14,
                  borderWidth: 1.5, borderColor: Colors.accent,
                  backgroundColor: 'rgba(124,58,237,0.10)',
                }]}
                onPress={() => setFootprintPickerOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={t('building_select_title')}>
                <Text style={[s.locFootprintBtnText, { fontSize: 15, color: Colors.accent }]}>
                  🏢  {t('building_select_title')}
                </Text>
                {!location && (
                  <Text style={{ marginTop: 4, color: Colors.textDim, fontSize: 12, textAlign: 'center' }}>
                    {t('building_waiting_gps')}
                  </Text>
                )}
              </TouchableOpacity>
            )
          }

          audioUri={audioUri}
          isRecording={isRecording}
          onToggleRecording={isRecording ? stopRecording : startRecording}
          descriptionValue={description}
          onChangeDescription={setDescription}

          debrisClearing={debrisClearing}
          onSetDebris={setDebrisClearing}
          electricityStatus={electricityStatus}
          onSetElectricity={setElectricityStatus}
          waterStatus={waterStatus}
          onSetWater={setWaterStatus}
          healthStatus={healthStatus}
          onSetHealth={setHealthStatus}
          pressingNeeds={pressingNeeds}
          onTogglePressingNeed={(v) => {
            setPressingNeeds((prev) =>
              prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]
            );
          }}

          isSending={isSending}
          onSend={submitReport}

          onBack={() => setScreen('v4_classify')}
          onEditPhoto={() => setScreen('v4_capture')}
          onEditClassify={() => setScreen('v4_classify')}
          onEditLocation={() => setScreen('v4_capture') /* meta card */}
        />
      )}

      {/* ══════════════════════════════════════════════════════════════════
           Phase 6 (May 2026 — RN ↔ PWA parity) — Rewards + Badge Studio.
           Combined screen: 4-tier ladder + progress hint + share-message
           picker + Share.share() dispatch. Locked at T1/T2; share unlocks
           at Changemaker (T3+). Badge level is derived locally from
           backend impactStats — v6.5 will pull from the /reports/profile
           endpoint directly per the PWA's home-screen.js pattern.
      ══════════════════════════════════════════════════════════════════ */}
      {screen === 'v4_rewards' && (
        <RewardsScreen
          badgeLevel={
            impactStats.totalLives > 0
              ? 'T4_LIFEKEEPER'
              : impactStats.resolvedCount > 0
              ? 'T3_CHANGEMAKER'
              : (queueCount > 0 || history.length > 0)
              ? 'T2_SIGNAL'
              : 'T1_SCOUT'
          }
          reportsSubmitted={impactStats.resolvedCount}
          reportsDispatched={impactStats.resolvedCount}
          livesSaved={impactStats.totalLives}
          shareUrl={`https://undp.crisplabs.tech${deviceHash ? `/share?d=${deviceHash}` : ''}`}
          onBack={() => setScreen('home')}
        />
      )}

      {/* Legacy home block — hidden behind a flag for one-flag rollback
          in case the new HomeScreen surfaces a regression in field
          testing. Default OFF; flip via __crispUseLegacyHome global
          OR set screen to 'legacy_home' programmatically. */}
      {screen === ('legacy_home' as Screen) && (
        <ScrollView
          style={{ flex: 1, backgroundColor: Colors.bg }}
          nestedScrollEnabled
          scrollEventThrottle={16}
          contentContainerStyle={{ padding: responsivePad(), paddingBottom: 40, alignItems: 'center' }}>
          <Text style={s.emoji}>🆘</Text>
          <Text style={s.title}>{t('welcome_title')}</Text>
          {/* Apr 2026 PR 3 — removed the "Tap the button" sub-copy; render
              the <Text> only when welcome_sub has actual content so
              locales that keep the tutorial text still see it. */}
          {(() => { const sub = t('welcome_sub'); return sub ? (<Text style={s.subtitle}>{sub}</Text>) : null; })()}

          {/* Language row with inline 🟢/🔴 connectivity dot. Parity
              with the PWA's lang-switcher dot. Same visual placement. */}
          <View style={[s.langRow, { alignItems: 'center' }]}>
            <View
              accessibilityLabel={isOnline ? 'Online' : 'Offline — reports will queue'}
              style={{
                width: 10, height: 10, borderRadius: 5,
                marginRight: 8,
                backgroundColor: isOnline ? '#22c55e' : '#ef4444',
                shadowColor: isOnline ? '#22c55e' : '#ef4444',
                shadowOpacity: 0.6, shadowRadius: 3, shadowOffset: { width: 0, height: 0 },
              }}
            />
            {/* Apr 2026 §3.1 UX — UN official languages rendered first +
                visually enlarged. A thin divider then the non-UN locales
                at regular size. Parity with the PWA `.lpf-un` tile
                treatment in mobile-app/src/index.html. */}
            {getAvailableLanguages().filter((l) => l.un).map(l => (
              <TouchableOpacity
                key={l.code}
                style={[s.langBtn, s.langBtnUn, lang === l.code && s.langBtnActive]}
                onPress={() => changeLang(l.code)}
                accessibilityLabel={`${l.label} — UN official language`}
              >
                <Text style={[s.langFlag, s.langFlagUn]}>{l.flag}</Text>
              </TouchableOpacity>
            ))}
            {getAvailableLanguages().some((l) => !l.un) && (
              <View style={s.langDivider} />
            )}
            {getAvailableLanguages().filter((l) => !l.un).map(l => (
              <TouchableOpacity key={l.code} style={[s.langBtn, lang === l.code && s.langBtnActive]} onPress={() => changeLang(l.code)}>
                <Text style={s.langFlag}>{l.flag}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Apr 2026 PR 3 — Lives Saved FIRST (was second), with
              heart-pulse + green glow. Parity with PWA's .hi-cell-lives
              ordering in mobile-app/src/index.html. */}
          {(impactStats.totalLives > 0 || impactStats.resolvedCount > 0) && (
            <View style={{
              flexDirection: 'row', alignItems: 'center',
              backgroundColor: 'rgba(124,58,237,0.08)',
              borderWidth: 1, borderColor: 'rgba(124,58,237,0.3)',
              borderRadius: 14, paddingVertical: 14, width: '100%',
              marginTop: 16, marginBottom: 16,
            }}>
              {/* Lives Saved cell — animated heart + green glow. */}
              <View style={{ flex: 1, alignItems: 'center', position: 'relative' }}>
                <HeartPulse />
                <Text style={{
                  fontSize: 28, fontWeight: '900', color: '#4ade80', lineHeight: 32,
                  marginTop: 4,
                  textShadowColor: 'rgba(34,197,94,0.35)',
                  textShadowOffset: { width: 0, height: 0 }, textShadowRadius: 8,
                }}>
                  {impactStats.totalLives}
                </Text>
                <Text style={{ fontSize: 13, color: '#86efac', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4, textAlign: 'center' }}>
                  {t('home_metric_lives')}
                </Text>
              </View>
              <View style={{ width: 1, height: 36, backgroundColor: 'rgba(167,139,250,0.3)' }} />
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={{ fontSize: 28, fontWeight: '900', color: '#a78bfa', lineHeight: 32 }}>
                  {impactStats.resolvedCount}
                </Text>
                <Text style={{ fontSize: 13, color: '#c4b5fd', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4, textAlign: 'center' }}>
                  {t('home_metric_reports')}
                </Text>
              </View>
            </View>
          )}

          <TouchableOpacity style={s.bigBtn} onPress={async () => {
            // Phase 4: arm the 2-minute auto-submit timer iff the user's
            // GPS is inside an admin-enabled region. Silent no-op when
            // outside / GPS unavailable / config empty.
            try {
              const { status } = await Location.getForegroundPermissionsAsync();
              if (status === 'granted') {
                const pos = await Location.getCurrentPositionAsync({
                  accuracy: Location.Accuracy.Balanced,
                });
                const regions = await getEnabledRegions();
                const match = findActiveRegion(
                  pos.coords.latitude, pos.coords.longitude, regions,
                );
                if (match) {
                  setActiveRegion(match);
                  console.log(`[AutoSubmit] armed — region="${match.name}"`);
                }
              }
            } catch (e) {
              console.log('[AutoSubmit] geofence check skipped:', (e as Error)?.message || e);
            }
            // Phase B4 (Apr 2026 UI v3) — v3 flow opens on the "where"
            // stage (location + damage) before the reporter is asked
            // for evidence. When the flag is off (`crisp_ui_v3='off'`)
            // the legacy v2 flow opens straight to photo capture.
            setScreen(uiV3 ? 'where' : 'photo');
          }}>
            <Text style={s.bigBtnText}>{t('welcome_start')}</Text>
          </TouchableOpacity>

          {/* My Reports — single entry point for history + delete-all. */}
          <TouchableOpacity style={{ backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, paddingVertical: 14, borderRadius: 12, marginTop: 12, width: '100%', alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
            onPress={() => { refreshHistory(); pollStatus(); setScreen('history'); }}>
            <Text style={{ color: Colors.text, fontSize: 15, fontWeight: '600' }}>📋 {t('my_reports')}</Text>
          </TouchableOpacity>

          {/* Phase 1 (Apr 2026 — Optional reporter login). Tertiary CTA
              beneath My Reports so the primary Start button stays biggest.
              When logged in, shows an account pill with a Settings gear. */}
          {authReady && !authLoggedIn && (
            <TouchableOpacity
              style={{ backgroundColor: 'transparent', borderWidth: 1, borderColor: Colors.border, paddingVertical: 11, borderRadius: 10, marginTop: 10, width: '100%', alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
              onPress={() => {
                setLoginStep(1); setLoginCode(''); setLoginError(''); setLoginLinkable(0);
                setScreen('login');
              }}>
              <Text style={{ color: Colors.accent, fontSize: 14, fontWeight: '600' }}>🔑  {(t as any)('login_or_signup') || 'Login / Sign up'}</Text>
            </TouchableOpacity>
          )}
          {authReady && authLoggedIn && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, width: '100%', marginTop: 10, padding: 10, backgroundColor: 'rgba(34,197,94,0.08)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.25)', borderRadius: 10 }}>
              <Text style={{ color: '#4ade80' }}>✓</Text>
              <Text style={{ color: '#86efac', flex: 1, fontWeight: '600' }} numberOfLines={1}>
                {authDisplay || 'Signed in'}
              </Text>
              <TouchableOpacity onPress={() => setScreen('settings')}>
                <Text style={{ color: '#86efac', fontSize: 16 }}>⚙️</Text>
              </TouchableOpacity>
            </View>
          )}

          {queueCount > 0 && <TouchableOpacity style={s.queueBadge} onPress={async () => {
            const { clearAllQueuedReports } = await import('./services/database');
            const cleared = await clearAllQueuedReports();
            updateQueueCount();
            Alert.alert('Queue Cleared', `${cleared} queued report${cleared !== 1 ? 's' : ''} removed.`);
          }}><Text style={s.queueText}>{isOnline ? '🔄' : '📴'} {queueCount} {t('queued')} — Tap to clear</Text></TouchableOpacity>}
          {!isOnline && <Text style={s.offlineText}>{t('offline')}</Text>}

          {/* Gamification badge — demoted below primary actions so it doesn't
              distract first-time reporters. */}
          <View style={{ marginTop: 18, width: '100%' }}>
            <BadgeCard deviceHash={deviceHash} />
          </View>

          {/* Apr 2026 PR 3 — "Works offline" reassurance at the bottom of
              the home screen. Parity with PWA's .home-offline-hint. */}
          <View style={{
            marginTop: 24, paddingVertical: 10, paddingHorizontal: 14,
            borderWidth: 1, borderColor: 'rgba(56,189,248,0.25)',
            backgroundColor: 'rgba(56,189,248,0.06)', borderRadius: 10,
            width: '100%',
          }}>
            <Text style={{
              color: '#7dd3fc', fontSize: 12, textAlign: 'center', lineHeight: 17,
            }}>
              {t('home_offline_hint') || '📡 Works offline and in low internet connectivity.'}
            </Text>
          </View>
        </ScrollView>
      )}

      {/* ══════════════════════════════════════════════════════════════════
           Phase 1 (Apr 2026 — Optional reporter login). Single screen
           hosts all 3 wizard steps via `loginStep` local state. Every
           step's "back" path lands on 'home' so reporting is never a
           tap deeper than necessary.
      ══════════════════════════════════════════════════════════════════ */}
      {screen === 'login' && (
        <View style={[s.screen, { padding: responsivePad() }]}>
          <Text style={s.title}>{(t as any)('login_title') || 'Login or Sign up'}</Text>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
            {loginStep === 1 && (
              <>
                <Text style={{ color: Colors.textDim, fontSize: 13, marginBottom: 12, textAlign: 'center' }}>
                  {(t as any)('login_sub') || 'Track your reports across devices'}
                </Text>
                <View style={{ flexDirection: 'row', gap: 10, marginBottom: 12 }}>
                  <TouchableOpacity
                    style={[s.chip, loginChannel === 'PHONE' && s.chipActive, { flex: 1, paddingVertical: 14, justifyContent: 'center' }]}
                    onPress={() => setLoginChannel('PHONE')}>
                    <Text style={s.chipText}>📱 {(t as any)('login_channel_phone') || 'Phone'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.chip, loginChannel === 'EMAIL' && s.chipActive, { flex: 1, paddingVertical: 14, justifyContent: 'center' }]}
                    onPress={() => setLoginChannel('EMAIL')}>
                    <Text style={s.chipText}>📧 {(t as any)('login_channel_email') || 'Email'}</Text>
                  </TouchableOpacity>
                </View>
                {loginChannel === 'PHONE' ? (
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TextInput
                      style={[s.buildingFreeTextInput, { flex: 0, width: 90, textAlign: 'center' }]}
                      value={loginCC}
                      onChangeText={setLoginCC}
                      maxLength={5}
                      keyboardType="phone-pad"
                    />
                    <TextInput
                      style={[s.buildingFreeTextInput, { flex: 1 }]}
                      value={loginPhone}
                      onChangeText={(v) => setLoginPhone(v.replace(/\D/g, ''))}
                      placeholder="98765 43210"
                      placeholderTextColor={Colors.textDim}
                      keyboardType="phone-pad"
                      maxLength={15}
                    />
                  </View>
                ) : (
                  <TextInput
                    style={s.buildingFreeTextInput}
                    value={loginEmail}
                    onChangeText={setLoginEmail}
                    placeholder="you@example.com"
                    placeholderTextColor={Colors.textDim}
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                )}
                {loginError ? (
                  <Text style={{ color: '#fca5a5', marginTop: 10 }}>{loginError}</Text>
                ) : null}
                <TouchableOpacity
                  style={[s.bigBtn, { marginTop: 16 }, loginBusy && { opacity: 0.5 }]}
                  disabled={loginBusy}
                  onPress={async () => {
                    setLoginError('');
                    const destination = loginChannel === 'PHONE'
                      ? `${loginCC}${loginPhone}`
                      : loginEmail.trim().toLowerCase();
                    if (!destination || destination === loginCC) {
                      setLoginError((t as any)('login_err_missing_destination') || 'Please enter your phone or email.');
                      return;
                    }
                    setLoginBusy(true);
                    try {
                      await AuthStore.requestOtp(destination, loginChannel, 'LOGIN', deviceHash);
                      setLoginDestination(destination);
                      setLoginStep(2);
                    } catch (e: any) {
                      setLoginError(e?.message || 'Could not send code.');
                    } finally { setLoginBusy(false); }
                  }}>
                  <Text style={s.bigBtnText}>{(t as any)('login_send_code') || 'Send code'} →</Text>
                </TouchableOpacity>
                <TouchableOpacity style={{ marginTop: 12, alignItems: 'center' }} onPress={() => setScreen('home')}>
                  <Text style={{ color: Colors.accent, fontSize: 13 }}>{(t as any)('login_skip') || 'Skip & report anonymously'} ›</Text>
                </TouchableOpacity>
              </>
            )}

            {loginStep === 2 && (
              <>
                <Text style={{ color: Colors.text, fontSize: 14, textAlign: 'center' }}>
                  {(t as any)('login_code_sent_prefix') || 'We sent a 6-digit code to'}
                </Text>
                <Text style={{ color: Colors.accent, fontSize: 16, fontWeight: '700', textAlign: 'center', marginTop: 4, marginBottom: 16 }}>
                  {loginDestination}
                </Text>
                <TextInput
                  style={[s.buildingFreeTextInput, { textAlign: 'center', fontSize: 22, letterSpacing: 8 }]}
                  value={loginCode}
                  onChangeText={(v) => setLoginCode(v.replace(/\D/g, '').slice(0, 6))}
                  keyboardType="number-pad"
                  placeholder="••••••"
                  placeholderTextColor={Colors.textDim}
                  maxLength={6}
                  autoFocus
                />
                {loginError ? <Text style={{ color: '#fca5a5', marginTop: 10 }}>{loginError}</Text> : null}
                <TouchableOpacity
                  style={[s.bigBtn, { marginTop: 16 }, loginBusy && { opacity: 0.5 }]}
                  disabled={loginBusy}
                  onPress={async () => {
                    setLoginError('');
                    if (loginCode.length !== 6) {
                      setLoginError((t as any)('login_err_bad_code') || 'Please enter the 6-digit code.');
                      return;
                    }
                    setLoginBusy(true);
                    try {
                      const data = await AuthStore.verifyOtp(loginDestination, loginChannel, loginCode, 'LOGIN', deviceHash);
                      const linkable = Number((data as any)?.linkable_report_count) || 0;
                      setAuthLoggedIn(AuthStore.isLoggedIn());
                      setAuthDisplay(AuthStore.getProfile().displayName);
                      if (linkable > 0) { setLoginLinkable(linkable); setLoginStep(3); }
                      else {
                        Alert.alert('', (t as any)('login_welcome') || "You're in!");
                        setScreen('home');
                      }
                    } catch (e: any) {
                      setLoginError(e?.message || 'Could not verify code.');
                    } finally { setLoginBusy(false); }
                  }}>
                  <Text style={s.bigBtnText}>{(t as any)('login_verify') || 'Verify'} →</Text>
                </TouchableOpacity>
                <TouchableOpacity style={{ marginTop: 12, alignItems: 'center' }} onPress={() => setLoginStep(1)}>
                  <Text style={{ color: Colors.accent, fontSize: 13 }}>{(t as any)('login_wrong_destination') || 'Wrong number / email?'} ›</Text>
                </TouchableOpacity>
              </>
            )}

            {loginStep === 3 && (
              <>
                <View style={{ alignItems: 'center', marginTop: 20, marginBottom: 14 }}>
                  <View style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(34,197,94,0.15)', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 28, color: '#4ade80' }}>✓</Text>
                  </View>
                  <Text style={{ fontSize: 22, fontWeight: '700', color: Colors.text, marginTop: 10 }}>
                    {(t as any)('login_welcome') || "You're in!"}
                  </Text>
                </View>
                <Text style={{ color: Colors.text, fontSize: 14, textAlign: 'center', lineHeight: 20 }}>
                  {(t as any)('login_found_prefix') || 'We found'}{' '}
                  <Text style={{ color: Colors.accent, fontWeight: '700', fontSize: 18 }}>{loginLinkable}</Text>{' '}
                  {(t as any)('login_found_suffix') || 'anonymous reports on this device. Link them to your account?'}
                </Text>
                <TouchableOpacity
                  style={[s.bigBtn, { marginTop: 16 }]}
                  onPress={async () => {
                    try {
                      const r = await AuthStore.linkDevice(deviceHash);
                      Alert.alert('', `${(r as any)?.linked || 0} reports linked`);
                    } catch { /* swallow */ }
                    setScreen('home');
                  }}>
                  <Text style={s.bigBtnText}>🔗 {(t as any)('login_link_now') || 'Link reports'}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={{ marginTop: 12, alignItems: 'center', paddingVertical: 10 }}
                  onPress={() => setScreen('home')}>
                  <Text style={{ color: Colors.textDim, fontSize: 14 }}>{(t as any)('login_keep_anonymous') || 'Keep them anonymous'}</Text>
                </TouchableOpacity>
              </>
            )}
          </ScrollView>
        </View>
      )}

      {/* Phase 1 (Apr 2026 — Optional reporter login) — Settings screen. */}
      {screen === 'settings' && (
        <View style={[s.screen, { padding: responsivePad() }]}>
          <Text style={s.title}>{(t as any)('settings_title') || 'Settings'}</Text>
          <View style={{ backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: 10, padding: 12, marginTop: 12 }}>
            <Text style={{ color: Colors.textDim, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.05 }}>
              {(t as any)('settings_account') || 'Account'}
            </Text>
            <Text style={{ color: Colors.text, fontSize: 15, fontWeight: '600', marginTop: 4 }}>
              {authDisplay || '—'}
            </Text>
          </View>
          <TouchableOpacity
            style={{ marginTop: 16, padding: 14, borderWidth: 1, borderColor: Colors.border, borderRadius: 10, alignItems: 'center' }}
            onPress={async () => {
              try {
                const r = await AuthStore.unlinkDevice(deviceHash);
                Alert.alert('', `${(r as any)?.unlinked || 0} reports unlinked`);
              } catch { /* swallow */ }
            }}>
            <Text style={{ color: Colors.text, fontSize: 14 }}>🔗 {(t as any)('settings_unlink_device') || 'Unlink this device'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{ marginTop: 10, padding: 14, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)', borderRadius: 10, alignItems: 'center' }}
            onPress={async () => {
              await AuthStore.logout();
              setAuthLoggedIn(false);
              setAuthDisplay(null);
              setScreen('home');
            }}>
            <Text style={{ color: '#fca5a5', fontSize: 14 }}>🚪 {(t as any)('settings_logout') || 'Logout'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={{ marginTop: 16, alignItems: 'center' }} onPress={() => setScreen('home')}>
            <Text style={{ color: Colors.accent, fontSize: 13 }}>← {t('back')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ══════════════════════════════════════════════════════════════════
           UI v3 — 4 new capture-flow screens (Phase B4, Apr 2026).
           Each is a small chip-grid picker + Back/Continue row. Reuses the
           same `s.chipRow` / `s.chip` / `s.nextBtn` styles the legacy
           review_details screen uses, so no new styles needed.

           Navigation chain (v3):  home → where → infra → crisis → extras
                                   → photo → audio → review_confirm → success

           `uiV3` is read once at mount. When off, these blocks never render
           because the Start button routes straight to 'photo'.
      ══════════════════════════════════════════════════════════════════ */}
      {screen === 'where' && uiV3 && (
        <View style={[s.screen, { padding: responsivePad() }]}>
          <Text style={s.title}>{t('stage2_title') || 'Where and how bad?'}</Text>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
            {/* Phase B4 (Apr 2026 UI v3) — auto date/time panel. Rendered
                from `new Date()` on every mount, updated every 60 s via
                the `whereAutoTime` useState tick. Zero network, zero wait. */}
            <View style={{ marginBottom: 12, padding: 12, backgroundColor: 'rgba(124,58,237,0.06)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(124,58,237,0.22)' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Text style={{ color: Colors.accent, fontSize: 14 }}>⏰</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 10, color: Colors.textDim, textTransform: 'uppercase', letterSpacing: 0.05 }}>{t('auto_time_label') || 'Time (auto)'}</Text>
                  <Text style={{ fontSize: 13, color: Colors.text, fontWeight: '600' }}>{whereAutoTime}</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <Text style={{ color: Colors.accent, fontSize: 14 }}>📍</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 10, color: Colors.textDim, textTransform: 'uppercase', letterSpacing: 0.05 }}>{t('auto_loc_label') || 'Location (auto)'}</Text>
                  <Text style={{ fontSize: 13, color: Colors.text, fontWeight: '600' }} numberOfLines={1}>
                    {locationName || (location ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : t('loc_status') || 'Detecting...')}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => getLocation()}>
                  <Text style={{ color: Colors.accent, fontSize: 12, fontWeight: '600' }}>🔄</Text>
                </TouchableOpacity>
              </View>
            </View>

            <Text style={{ color: Colors.text, fontSize: 14, marginBottom: 8 }}>
              {t('severity_label') || 'How bad is the damage?'}
            </Text>
            <View style={s.chipRow}>
              {damageOptions.map((d) => (
                <TouchableOpacity
                  key={d.key}
                  style={[s.chip, damageClass === d.key && s.chipActive]}
                  onPress={() => setDamageClass(d.key)}
                  accessibilityRole="button">
                  <Text style={s.chipText}>{d.icon} {t(d.labelKey) || d.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Phase B4 (Apr 2026 UI v3) — building-footprint picker moved
                 from stage-crisis to stage-where per the user spec. Works
                 offline against the 10-nearest AsyncStorage pre-cache
                 warmed by getLocation(). If a building_id is already set,
                 show the "selected" pill with a clear button. */}
            {buildingId ? (
              <View style={[s.locSelectedPill, { marginTop: 14 }]}>
                <Text style={s.locSelectedPillIcon}>✓</Text>
                <Text style={s.locSelectedPillText} numberOfLines={1}>
                  {t('building_selected')}: {infraNameFromOsm && infraName ? infraName : buildingId.replace('osm:way:', '#')}
                </Text>
                <TouchableOpacity onPress={() => {
                  setBuildingId(null);
                  if (infraNameFromOsm) { setInfraName(''); setInfraNameFromOsm(false); }
                }}>
                  <Text style={{ color: Colors.accent, fontWeight: '600', fontSize: 12 }}>{t('edit')}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                style={[s.locFootprintBtn, {
                  marginTop: 14, paddingVertical: 14,
                  borderWidth: 1.5, borderColor: Colors.accent,
                  backgroundColor: 'rgba(124,58,237,0.10)',
                }]}
                onPress={() => setFootprintPickerOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={t('building_select_title')}>
                <Text style={[s.locFootprintBtnText, { fontSize: 15, color: Colors.accent }]}>
                  🏢  {t('building_select_title')}
                </Text>
                {!location && (
                  <Text style={{ marginTop: 4, color: Colors.textDim, fontSize: 12, textAlign: 'center' }}>
                    {t('building_waiting_gps')}
                  </Text>
                )}
              </TouchableOpacity>
            )}
          </ScrollView>
          <View style={s.navRow}>
            <TouchableOpacity style={s.backBtn} onPress={() => setScreen('home')}><Text style={s.backText}>{t('back')}</Text></TouchableOpacity>
            <TouchableOpacity style={s.nextBtn} onPress={() => setScreen('infra')}><Text style={s.nextBtnText}>{t('next')} →</Text></TouchableOpacity>
          </View>
        </View>
      )}

      {screen === 'infra' && uiV3 && (
        <View style={[s.screen, { padding: responsivePad() }]}>
          <Text style={s.title}>{t('stage3_title') || 'What was hit?'}</Text>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
            <Text style={{ color: Colors.text, fontSize: 14, marginBottom: 8 }}>
              {t('what_damaged') || 'What is damaged?'}
            </Text>
            <View style={s.chipRow}>
              {types.map((ty) => (
                <TouchableOpacity
                  key={ty.key}
                  style={[s.chip, infraType === ty.key && s.chipActive]}
                  onPress={() => setInfraType(ty.key)}
                  accessibilityRole="button">
                  <Text style={s.chipText}>{ty.icon} {ty.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </ScrollView>
          <View style={s.navRow}>
            <TouchableOpacity style={s.backBtn} onPress={() => setScreen('where')}><Text style={s.backText}>{t('back')}</Text></TouchableOpacity>
            <TouchableOpacity style={s.nextBtn} onPress={() => setScreen('crisis')}><Text style={s.nextBtnText}>{t('next')} →</Text></TouchableOpacity>
          </View>
        </View>
      )}

      {screen === 'crisis' && uiV3 && (
        <View style={[s.screen, { padding: responsivePad() }]}>
          <Text style={s.title}>{t('stage4_title') || 'What caused it?'}</Text>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
            {/* Phase B4 (Apr 2026 UI v3, Apr-23 spec-align) — crisis chips
                grouped into the three UNDP categories so the field matches
                the Appendix-1 taxonomy section-by-section. Flat grid was
                the Apr-22 shipping state; this sub-grouping mirrors the
                PWA `.crisis-grouped` layout. */}
            {[
              { labelKey: 'crisis_group_natural',       fallback: 'Natural',       keys: ['EARTHQUAKE', 'FLOOD', 'TSUNAMI', 'CYCLONE', 'LANDSLIDE'] },
              { labelKey: 'crisis_group_technological', fallback: 'Technological', keys: ['EXPLOSION', 'CHEMICAL_INCIDENT', 'PANDEMIC'] },
              { labelKey: 'crisis_group_human_made',    fallback: 'Human-made',    keys: ['CONFLICT', 'CIVIL_UNREST', 'OTHER'] },
            ].map((group) => (
              <View key={group.labelKey} style={{ marginBottom: 4 }}>
                <Text style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.08, color: Colors.textDim, fontWeight: '700', marginTop: 8, marginBottom: 4 }}>
                  {(t as any)(group.labelKey) || group.fallback}
                </Text>
                <View style={s.chipRow}>
                  {group.keys.map((k) => {
                    const ct = crisisTypes.find((c) => c.key === k);
                    if (!ct) return null;
                    return (
                      <TouchableOpacity
                        key={ct.key}
                        style={[s.chip, crisisType === ct.key && s.chipActive]}
                        onPress={() => setCrisisType(ct.key)}
                        accessibilityRole="button">
                        <Text style={s.chipText}>{ct.icon} {t(ct.labelKey) || ct.label}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            ))}

            {/* Infrastructure-name free-text input — stays on stage-crisis
                per the Apr-23 spec ("Crisis + name"). The building PICKER
                moved to stage-where; this textbox captures the reporter's
                native-language building name independently of an OSM tap. */}
            <View style={{ marginTop: 16, padding: 12, backgroundColor: 'rgba(37,99,235,0.06)', borderRadius: 10, borderWidth: 1, borderColor: 'rgba(37,99,235,0.22)' }}>
              <Text style={{ color: Colors.text, fontSize: 13, fontWeight: '600', marginBottom: 6 }}>
                ✍️  {t('bldg_offline_prompt') || 'Type the building name in your language'}
              </Text>
              <TextInput
                style={s.buildingFreeTextInput}
                placeholder="e.g. Kiambu High School / مدرسة الأمل"
                placeholderTextColor={Colors.textDim}
                value={infraName}
                onChangeText={(v) => { setInfraName(v); setInfraNameFromOsm(false); }}
                maxLength={120}
                returnKeyType="done"
              />
              <Text style={{ marginTop: 6, fontSize: 11, color: Colors.textDim }}>
                ℹ️  {t('bldg_offline_hint') || 'The team will map this to GPS later'}
              </Text>
            </View>
          </ScrollView>
          <View style={s.navRow}>
            <TouchableOpacity style={s.backBtn} onPress={() => setScreen('infra')}><Text style={s.backText}>{t('back')}</Text></TouchableOpacity>
            <TouchableOpacity style={s.nextBtn} onPress={() => setScreen('extras')}><Text style={s.nextBtnText}>{t('next')} →</Text></TouchableOpacity>
          </View>
        </View>
      )}

      {screen === 'extras' && uiV3 && (
        <View style={[s.screen, { padding: responsivePad() }]}>
          <Text style={s.title}>{t('stage5_title') || 'Service + needs'}</Text>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 24 }}>
            {/* Phase B4 (Apr 2026 UI v3, Apr-23 spec-align) — debris Yes/No
                toggle re-added per UNDP Appendix-1. Severity chips dropped;
                severity is auto-derived from damageClass on stage-where
                (MINIMAL→MINOR, PARTIAL→MODERATE, COMPLETE→SEVERE). */}
            <Text style={{ color: Colors.text, fontSize: 14, marginBottom: 8 }}>
              {(t as any)('debris_label') || 'Does this need debris clearing?'}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16 }}>
              <TouchableOpacity
                style={[s.chip, !debrisClearing && s.chipActive, { flex: 1, paddingVertical: 14, justifyContent: 'center' }]}
                onPress={() => setDebrisClearing(false)}
                accessibilityRole="button">
                <Text style={s.chipText}>✕ {(t as any)('debris_no') || 'No'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.chip, debrisClearing && s.chipActive, { flex: 1, paddingVertical: 14, justifyContent: 'center' }]}
                onPress={() => setDebrisClearing(true)}
                accessibilityRole="button">
                <Text style={s.chipText}>✓ {(t as any)('debris_yes') || 'Yes'}</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ color: Colors.text, fontSize: 14, marginTop: 4, marginBottom: 8 }}>
              {t('needs_label') || '🆘 Pressing needs'}
            </Text>
            <View style={s.chipRow}>
              {[
                { k: 'food',           l: t('food') || 'Food' },
                { k: 'water',          l: t('need_water') || 'Water' },
                { k: 'cash',           l: t('need_cash') || 'Cash' },
                { k: 'medical',        l: t('medical') || 'Medical' },
                { k: 'shelter',        l: t('shelter') || 'Shelter' },
                { k: 'protection',     l: t('need_protection') || 'Protection' },
              ].map((n) => {
                const active = (pressingNeeds || []).includes(n.k);
                return (
                  <TouchableOpacity
                    key={n.k}
                    style={[s.chip, active && s.chipActive]}
                    onPress={() => {
                      const cur = new Set(pressingNeeds || []);
                      if (cur.has(n.k)) cur.delete(n.k); else cur.add(n.k);
                      setPressingNeeds(Array.from(cur));
                    }}
                    accessibilityRole="button">
                    <Text style={s.chipText}>{n.l}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          </ScrollView>
          <View style={s.navRow}>
            <TouchableOpacity style={s.backBtn} onPress={() => setScreen('crisis')}><Text style={s.backText}>{t('back')}</Text></TouchableOpacity>
            <TouchableOpacity style={s.nextBtn} onPress={() => setScreen('photo')}><Text style={s.nextBtnText}>{t('next')} →</Text></TouchableOpacity>
          </View>
        </View>
      )}

      {screen === 'photo' && (
        // R8: responsive padding override — keeps 24 on ≥360 px, scales
        // down on smaller devices so the capture buttons don't clip.
        <View style={[s.screen, { padding: responsivePad() }]}>
          <FlowProgress step={1} have={{ photo: !!photoUri, details: !!(audioUri || description?.trim()) }} />
          <Text style={s.title}>{t('photo_title')}</Text>
          <View style={s.piiWarning}><Text style={s.piiText}>🛡 {t('pii_warning')}</Text></View>
          {photoUri ? (
            <View style={{ position: 'relative' }}>
              <TouchableOpacity activeOpacity={0.85} onPress={() => setViewerState({ uri: photoUri, kind: 'primary' })}>
                <Image source={{ uri: photoUri }} style={s.photoPreview} />
              </TouchableOpacity>
              {/* ❌ bottom-left (per UX spec) — quick-delete the primary. */}
              <TouchableOpacity
                onPress={deletePrimaryPhoto}
                accessibilityLabel={t('image_delete_btn')}
                style={{ position: 'absolute', bottom: 6, left: 6, backgroundColor: 'rgba(239,68,68,0.92)', width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>✕</Text>
              </TouchableOpacity>
            </View>
          ) : <View style={s.photoPlaceholder}><Text style={{ fontSize: 48 }}>📸</Text></View>}
          {isBlurring && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8 }}>
              <Text style={{ color: '#a78bfa', fontSize: 13, fontWeight: '600' }}>
                🛡 Protecting privacy…
              </Text>
            </View>
          )}
          <View style={s.row}>
            <TouchableOpacity style={s.choiceBtn} onPress={takePhoto}><Text style={s.choiceBtnText}>📷 {t('camera')}</Text></TouchableOpacity>
            <TouchableOpacity style={s.choiceBtn} onPress={pickImage}><Text style={s.choiceBtnText}>📁 {t('browse')}</Text></TouchableOpacity>
          </View>
          {/* Phase 4: multi-photo parity with PWA. Shown after the first photo
              is captured; each extra runs through the same PII-blur pipeline. */}
          {photoUri && (
            <View style={{ marginTop: 12, width: '100%' }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                {extraPhotos.map((p, i) => (
                  <View key={i} style={{ marginRight: 8, position: 'relative' }}>
                    <TouchableOpacity activeOpacity={0.85} onPress={() => setViewerState({ uri: p.uri, kind: 'extra', index: i })}>
                      <Image source={{ uri: p.uri }} style={{ width: 64, height: 64, borderRadius: 8, borderWidth: 1, borderColor: Colors.border }} />
                    </TouchableOpacity>
                    {/* Apr 2026: ❌ in bottom-LEFT (was top-right). Quick-delete;
                        the full-screen viewer has its own confirm-delete flow. */}
                    <TouchableOpacity
                      onPress={() => removeExtraPhoto(i)}
                      accessibilityLabel={t('image_delete_btn')}
                      style={{ position: 'absolute', bottom: 2, left: 2, backgroundColor: 'rgba(239,68,68,0.92)', width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ color: Colors.white, fontSize: 11, fontWeight: '700' }}>✕</Text>
                    </TouchableOpacity>
                  </View>
                ))}
                {/* Phase B4 (Apr 2026 UI v3, Apr-23 spec-align) — single
                    "Add more" button presenting a native action sheet
                    (iOS: ActionSheetIOS-style via Alert; Android: AlertDialog)
                    with Camera + Library options. Mirrors the PWA's single
                    Add-more button that opens the OS native chooser. */}
                <TouchableOpacity
                  onPress={() => {
                    Alert.alert(
                      (t as any)('add_more') || 'Add photo',
                      '',
                      [
                        { text: (t as any)('chooser_camera') || 'Camera', onPress: () => takePhoto() },
                        { text: (t as any)('chooser_gallery') || 'Gallery', onPress: () => pickExtraImage() },
                        { text: (t as any)('cancel') || 'Cancel', style: 'cancel' },
                      ],
                      { cancelable: true },
                    );
                  }}
                  style={{ width: 64, height: 64, borderRadius: 8, borderWidth: 1, borderColor: Colors.border, borderStyle: 'dashed', alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: Colors.textDim, fontSize: 24 }}>+</Text>
                </TouchableOpacity>
              </ScrollView>
            </View>
          )}
          {/* Phase 2: image is mandatory. Next disabled until at least one photo
              is attached. Blur no longer gates navigation — it runs in the
              background and submitReport awaits it if needed. */}
          {!photoUri && (
            <Text style={{ color: '#9ca3af', fontSize: 12, marginTop: 8 }}>
              📷 {t('photo_required')}
            </Text>
          )}
          <View style={s.navRow}>
            {/* Phase B4 (Apr 2026 UI v3) — Back routes to 'extras' when v3,
                home otherwise. Keeps the legacy one-tap-home behaviour on v2. */}
            <TouchableOpacity style={s.backBtn} onPress={() => setScreen(uiV3 ? 'extras' : 'home')}><Text style={s.backText}>{t('back')}</Text></TouchableOpacity>
            <TouchableOpacity
              style={[s.nextBtn, !photoUri && { opacity: 0.4 }]}
              onPress={() => { if (photoUri) setScreen('audio'); }}
              disabled={!photoUri}>
              <Text style={s.nextBtnText}>{t('next')} →</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Apr 2026 UX rewrite — parity with PWA stage-audio. Low-literacy
          crisis UX: bulleted prompts + worked example + language hint so
          the user knows they can speak in their own tongue. Button copy
          unified to "Continue →". Plan:
          /Users/pks/.claude/plans/swirling-forging-raccoon.md */}
      {screen === 'audio' && (
        <ScrollView
          style={{ flex: 1, backgroundColor: Colors.bg }}
          nestedScrollEnabled
          scrollEventThrottle={16}
          contentContainerStyle={{ padding: responsivePad(), paddingBottom: 48 }}>
          <FlowProgress step={2} have={{ photo: !!photoUri, details: !!(audioUri || description?.trim()) }} />
          <Text style={s.title}>{t('audio_title')}</Text>
          <Text style={{ color: '#cbd5e1', fontSize: 14, fontWeight: '600', marginTop: 4, marginBottom: 6 }}>
            {t('audio_sub')}
          </Text>
          <View style={{ marginBottom: 10 }}>
            <Text style={{ color: '#d1d5db', fontSize: 13, lineHeight: 20, marginLeft: 6 }}>{'\u2022  '}{t('audio_bullet_1')}</Text>
            <Text style={{ color: '#d1d5db', fontSize: 13, lineHeight: 20, marginLeft: 6 }}>{'\u2022  '}{t('audio_bullet_2')}</Text>
            <Text style={{ color: '#d1d5db', fontSize: 13, lineHeight: 20, marginLeft: 6 }}>{'\u2022  '}{t('audio_bullet_3')}</Text>
          </View>
          <View style={{ backgroundColor: 'rgba(34,197,94,0.06)', borderLeftWidth: 3, borderLeftColor: 'rgba(34,197,94,0.5)', borderRadius: 4, padding: 8, marginBottom: 16 }}>
            <Text style={{ color: '#86efac', fontSize: 12, fontStyle: 'italic', lineHeight: 18 }}>{t('audio_example')}</Text>
          </View>

          <TouchableOpacity
            style={[s.micBtn, isRecording && { backgroundColor: Colors.red }]}
            onPress={isRecording ? stopRecording : startRecording}
            accessibilityRole="button"
            accessibilityLabel={isRecording ? t('stop') : t('tap_mic')}
            accessibilityHint={isRecording ? 'Stops audio recording' : 'Starts audio recording'}
          >
            <Text style={{ fontSize: 40 }}>{isRecording ? '⏹' : '🎤'}</Text>
            <Text style={{ color: Colors.white, fontSize: 12, fontWeight: '600', marginTop: 4 }}>
              {isRecording ? t('stop') : t('tap_mic')}
            </Text>
          </TouchableOpacity>
          {/* Elapsed-time display during recording. Hidden when idle so the
              layout matches the pre-recording state. Red dot + MM:SS in
              monospace — mirrors the PWA's .rec-timer. */}
          {isRecording && (
            <View style={s.recTimer} accessibilityLiveRegion="polite">
              <View style={s.recTimerDot} />
              <Text style={s.recTimerText}>
                {String(Math.floor(recordingSeconds / 60)).padStart(2, '0')}
                :
                {String(recordingSeconds % 60).padStart(2, '0')}
              </Text>
            </View>
          )}
          <Text style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', marginTop: 4, marginBottom: 8 }}>
            {t('audio_mic_lang')}
          </Text>

          {audioUri && <Text style={{ color: Colors.green, fontSize: 12, marginBottom: 8 }}>{t('audio_recorded')}</Text>}
          <TextInput style={s.textInput} placeholder={t('audio_placeholder')} placeholderTextColor={Colors.textDim} value={description} onChangeText={setDescription} multiline numberOfLines={4} returnKeyType="done" blurOnSubmit={true} onSubmitEditing={Keyboard.dismiss} />
          <View style={s.navRow}>
            <TouchableOpacity style={s.backBtn} onPress={() => setScreen('photo')}><Text style={s.backText}>{t('back')}</Text></TouchableOpacity>
            {/* Phase B4 (Apr 2026 UI v3) — v3 skips the review_details
                multi-page chip picker (already collected on earlier stages)
                and jumps straight to review_confirm. Legacy v2 still visits
                review_details for the last-chance edit. */}
            <TouchableOpacity style={s.nextBtn} onPress={() => setScreen(uiV3 ? 'review_confirm' : 'review_details')}><Text style={s.nextBtnText}>{t('next')} →</Text></TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {/* Apr 2026 UI v2 — review-stage renderer. When the feature flag is
           ON (default), the review flow splits into 3 pages driven by
           `reviewPage`: (1) What happened (crisis type + damage class),
           (2) How bad + where (severity + infrastructure + location +
           optional service status), (3) Describe & send (description +
           optional building footprint + summary + Submit).
           When the flag is OFF (AsyncStorage `crisp_ui_v2` = 'off'), the
           monolithic single-ScrollView layout renders unchanged. */}
      {screen === 'review_details' && !uiV2 && (
        <ScrollView
          style={{ flex: 1, backgroundColor: Colors.bg }}
          nestedScrollEnabled
          scrollEventThrottle={16}
          contentContainerStyle={{ padding: responsivePad() }}>
          <FlowProgress step={3} have={{ photo: !!photoUri, details: !!(audioUri || description?.trim()) }} />
          <Text style={s.title}>{t('details_title')}</Text>

          {/* 1. Photo preview + extras */}
          {photoUri && <Image source={{ uri: photoUri }} style={[s.photoPreview, { height: 140 }]} />}
          {extraPhotos.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 8 }}>
              {extraPhotos.map((p, i) => (
                <Image key={i} source={{ uri: p.uri }} style={{ width: 56, height: 56, borderRadius: 6, marginRight: 6, borderWidth: 1, borderColor: Colors.border }} />
              ))}
            </ScrollView>
          )}

          {/* 3. Description (photo is #1, audio is #2 from previous screens) */}
          <Text style={s.label}>{t('description_label')}</Text>
          <TextInput style={s.textInput} value={description} onChangeText={setDescription} multiline numberOfLines={3} placeholderTextColor={Colors.textDim} placeholder={t('type_text')} />

          {/* 5. What is damaged? (PR 6: merged with inline severity) */}
          <Text style={s.label}>{t('type_label')}</Text>
          <View style={s.chipRow}>{types.map(tp => (
            <TouchableOpacity
              key={tp.key}
              style={[s.chip, infraType === tp.key && s.chipActive]}
              onPress={() => {
                if (infraType === tp.key && showInfraSeverity) {
                  setShowInfraSeverity(false); // same-chip toggle collapses
                } else {
                  setInfraType(tp.key);
                  setShowInfraSeverity(true);
                }
              }}
            >
              <Text style={s.chipText}>{tp.icon} {tp.label}</Text>
            </TouchableOpacity>
          ))}</View>

          {showInfraSeverity && (
            <View style={{ marginTop: 8, marginBottom: 8, padding: 10, borderRadius: 10, backgroundColor: 'rgba(99,102,241,0.08)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.2)' }}>
              <Text style={{ color: '#cbd5e1', fontSize: 13, marginBottom: 6 }}>
                {t('damage_label')}{' '}
                <Text style={{ color: '#c7d2fe', fontWeight: '700' }}>
                  {(types.find(tp => tp.key === infraType)?.label) || infraType}
                </Text>
              </Text>
              <View style={s.chipRow}>
                {damageOptions.map(d => (
                  <TouchableOpacity
                    key={d.key}
                    style={[s.chip, damageClass === d.key && { ...s.chipActive, borderColor: d.color }]}
                    onPress={() => setDamageClass(d.key)}
                  >
                    <Text style={s.chipText}>{d.icon} {d.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          <Text style={s.label}>{t('crisis_label')}</Text>
          <View style={s.chipRow}>{crisisTypes.map(ct => <TouchableOpacity key={ct.key} style={[s.chip, crisisType === ct.key && s.chipActive]} onPress={() => setCrisisType(ct.key)}><Text style={s.chipText}>{ct.icon} {t(ct.labelKey) || ct.label}</Text></TouchableOpacity>)}</View>

          <Text style={s.label}>{t('service_label')}</Text>
          {(['electricity', 'water', 'health'] as const).map((svc) => {
            const val = svc === 'electricity' ? electricityStatus : svc === 'water' ? waterStatus : healthStatus;
            const set = svc === 'electricity' ? setElectricityStatus : svc === 'water' ? setWaterStatus : setHealthStatus;
            const icon = svc === 'electricity' ? '⚡' : svc === 'water' ? '💧' : '🏥';
            return (
              <View key={svc} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                <Text style={{ color: Colors.text, width: 110, fontSize: 13 }}>{icon} {svc[0].toUpperCase() + svc.slice(1)}</Text>
                <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap' }}>
                  {(['UNKNOWN','OPERATIONAL','DISRUPTED','DESTROYED'] as const).map(lvl => {
                    const labelKey = lvl === 'UNKNOWN' ? 'service_unknown'
                      : lvl === 'OPERATIONAL' ? 'service_working'
                      : lvl === 'DISRUPTED' ? 'service_disrupted' : 'service_destroyed';
                    return (
                      <TouchableOpacity key={lvl} style={[s.chip, val === lvl && s.chipActive, { paddingVertical: 4, paddingHorizontal: 8, marginRight: 4, marginBottom: 4 }]} onPress={() => set(lvl)}>
                        <Text style={[s.chipText, { fontSize: 13 }]}>{t(labelKey)}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            );
          })}

          <Text style={[s.label, { marginTop: 8 }]}>{t('needs_label')}</Text>
          <View style={s.chipRow}>
            {[
              { k: 'food',     labelKey: 'needs_food',     icon: '🍱' },
              { k: 'water',    labelKey: 'needs_water',    icon: '🚰' },
              { k: 'shelter',  labelKey: 'needs_shelter',  icon: '🏠' },
              { k: 'medical',  labelKey: 'needs_medical',  icon: '⚕️' },
              { k: 'security', labelKey: 'needs_security', icon: '🛡' },
            ].map(n => (
              <TouchableOpacity key={n.k} style={[s.chip, pressingNeeds.includes(n.k) && s.chipActive]} onPress={() => togglePressingNeed(n.k)}>
                <Text style={s.chipText}>{n.icon} {t(n.labelKey)}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={s.label}>{t('severity_label')}</Text>
          <View style={s.chipRow}>{sevs.map(sv => <TouchableOpacity key={sv.key} style={[s.chip, severity === sv.key && s.chipActive]} onPress={() => setSeverity(sv.key)}><Text style={s.chipText}>{sv.icon} {sv.label}</Text></TouchableOpacity>)}</View>

          <View style={s.locVerifyBox}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 }}>
              <Text style={{ fontSize: 16 }}>📍</Text>
              <Text style={{ color: Colors.text, fontSize: 13, flex: 1 }} numberOfLines={2}>
                {locationName
                  ? locationName
                  : (location ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : t('loc_resolving'))}
              </Text>
              {location?.acc ? (
                <Text style={{ color: Colors.textDim, fontSize: 13 }}>
                  ±{Math.round(location.acc)}m
                </Text>
              ) : null}
            </View>
            <TextInput
              value={userLocationName}
              onChangeText={(txt) => {
                setUserLocationName(txt);
                setIsLocationUserCorrected(txt.trim().length > 0);
              }}
              placeholder={t('loc_search_placeholder')}
              placeholderTextColor={Colors.textDim}
              style={s.locSearchInput}
              accessibilityLabel={t('loc_search_placeholder')}
            />
            {buildingId ? (
              <View style={s.locSelectedPill}>
                <Text style={s.locSelectedPillIcon}>✓</Text>
                {/* Show the OSM name when we have one, else the short id.
                    The name gives the reporter confirmation of WHAT they
                    picked (e.g. "City Hospital") and is the same string
                    the backend + dashboard will now display. */}
                <Text style={s.locSelectedPillText} numberOfLines={1}>
                  {t('building_selected')}: {infraNameFromOsm && infraName ? infraName : buildingId.replace('osm:way:', '#')}
                </Text>
                <TouchableOpacity onPress={() => {
                  setBuildingId(null);
                  if (infraNameFromOsm) {
                    setInfraName('');
                    setInfraNameFromOsm(false);
                  }
                }}>
                  <Text style={{ color: Colors.accent, fontWeight: '600', fontSize: 12 }}>{t('edit')}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              // Apr 2026 UI v2.1 — no `disabled={!location}` gate. UNDP
              // requires the building selector to be always reachable;
              // the picker modal handles the "no GPS yet" state inline.
              <TouchableOpacity
                style={[s.locFootprintBtn, { paddingVertical: 14 }]}
                onPress={() => setFootprintPickerOpen(true)}
                accessibilityRole="button"
                accessibilityLabel={t('building_select_title')}>
                <Text style={s.locFootprintBtnText}>🏢  {t('building_select_title')}</Text>
                {!location && (
                  <Text style={{ marginTop: 4, color: Colors.textDim, fontSize: 12, textAlign: 'center' }}>
                    {t('building_waiting_gps')}
                  </Text>
                )}
              </TouchableOpacity>
            )}
          </View>

          <View style={s.navRow}>
            <TouchableOpacity style={[s.backBtn]} onPress={() => setScreen('audio')}><Text style={s.backText}>{t('back')}</Text></TouchableOpacity>
            <TouchableOpacity style={s.nextBtn} onPress={() => setScreen('review_confirm')}><Text style={s.nextBtnText}>{t('next')} →</Text></TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {/* ─── Apr 2026 UI v2 — 3-page review split ─────────────────────── */}
      {screen === 'review_details' && uiV2 && (
        <ScrollView
          // R3: outer scroll container delegates to nested WebViews (the
          // building-footprint picker lives inside its own full-screen Modal,
          // so the two never collide, but we set these defensively so any
          // future inline map also inherits safe behaviour on Android).
          style={{ flex: 1, backgroundColor: Colors.bg }}
          nestedScrollEnabled
          scrollEventThrottle={16}
          contentContainerStyle={{ padding: responsivePad(), paddingBottom: 40 }}
          keyboardShouldPersistTaps="handled"
        >
          <FlowProgress step={3} have={{ photo: !!photoUri, details: !!(audioUri || description?.trim()) }} />
          {/* Inline page-of-3 indicator — gives the user a "you are
              here" cue that's cheaper to read than the FlowProgress row. */}
          <Text style={{ color: Colors.textDim, fontSize: 13, fontWeight: '700', textAlign: 'center', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.6 }}>
            {reviewPage} / 3
          </Text>
          <Text style={s.title}>
            {reviewPage === 1 ? t('review_v2_title_what')
              : reviewPage === 2 ? t('review_v2_title_how')
              : t('review_v2_title_confirm')}
          </Text>

          {/* ── Page 1: What happened — crisis type + damage class ── */}
          {reviewPage === 1 && (
            <>
              <Text style={s.label}>{t('crisis_label')}</Text>
              {/* 2-column grid (roughly) — `width: 48%` on each tile lets
                  the wrap naturally land two per row at 360 px. */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {crisisTypes.map(ct => (
                  <TouchableOpacity
                    key={ct.key}
                    style={[
                      s.v2Tile,
                      crisisType === ct.key && s.v2TileActive,
                    ]}
                    onPress={() => setCrisisType(ct.key)}
                    accessibilityRole="button"
                    accessibilityLabel={ct.label}
                    accessibilityState={{ selected: crisisType === ct.key }}
                  >
                    <IconTile
                      name={ct.key}
                      color={crisisType === ct.key ? Colors.accent : Colors.text}
                      size={40}
                    />
                    <Text style={[s.v2TileLabel, crisisType === ct.key && { color: Colors.accent }]} numberOfLines={2}>
                      {ct.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={[s.label, { marginTop: 16 }]}>{t('damage_label')}</Text>
              {/* 3-dot row — one tile per severity. Fills / colour driven
                  by IconTile's `filled` prop so COMPLETE reads as the
                  filled red disc + white X glyph. */}
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {damageOptions.map(d => (
                  <TouchableOpacity
                    key={d.key}
                    style={[
                      s.v2Tile,
                      { flex: 1 },
                      damageClass === d.key && { ...s.v2TileActive, borderColor: d.color },
                    ]}
                    onPress={() => setDamageClass(d.key)}
                    accessibilityRole="button"
                    accessibilityLabel={t(d.labelKey) || d.label}
                    accessibilityState={{ selected: damageClass === d.key }}
                  >
                    <IconTile
                      name={d.key}
                      color={d.color}
                      size={36}
                      filled={d.key === 'COMPLETE'}
                    />
                    <Text style={[s.v2TileLabel, { color: d.color }]}>
                      {t(d.labelKey) || d.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
            </>
          )}

          {/* ── Page 2: How bad + where — severity / infra / location ── */}
          {reviewPage === 2 && (
            <>
              <Text style={s.label}>{t('severity_label')}</Text>
              <View style={s.chipRow}>
                {sevs.map(sv => (
                  <TouchableOpacity
                    key={sv.key}
                    style={[s.chip, severity === sv.key && s.chipActive]}
                    onPress={() => setSeverity(sv.key)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: severity === sv.key }}
                  >
                    <Text style={s.chipText}>{sv.icon} {sv.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={[s.label, { marginTop: 16 }]}>{t('type_label')}</Text>
              {/* 4 super-types + OTHER. IconTile renders each glyph in
                  its category colour so a FLOOD tile in infra reads
                  differently from a generic chip. */}
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {[
                  { key: 'RESIDENTIAL', label: t('type_house'),    color: '#fb923c' },
                  { key: 'UTILITY',     label: t('type_power'),    color: '#facc15' },
                  { key: 'TRANSPORT_COMMUNICATION', label: t('type_road'), color: '#60a5fa' },
                  { key: 'COMMUNITY',   label: t('type_hospital'), color: '#f472b6' },
                  { key: 'OTHER',       label: t('type_other'),    color: '#94a3b8' },
                ].map(st => (
                  <TouchableOpacity
                    key={st.key}
                    style={[s.v2Tile, infraType === st.key && s.v2TileActive]}
                    onPress={() => setInfraType(st.key)}
                    accessibilityRole="button"
                    accessibilityLabel={st.label}
                    accessibilityState={{ selected: infraType === st.key }}
                  >
                    <IconTile
                      name={st.key}
                      color={infraType === st.key ? Colors.accent : st.color}
                      size={40}
                    />
                    <Text style={[s.v2TileLabel, infraType === st.key && { color: Colors.accent }]}>{st.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* Location block — shrunk copy of v1 verify box. Keeps
                  the user editable text + "±acc" + footprint trigger
                  so page 2 can stand alone without jumping to page 3. */}
              <Text style={[s.label, { marginTop: 16 }]}>{t('location_label') || 'Location'}</Text>
              <View style={s.locVerifyBox}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10, gap: 8 }}>
                  <IconTile name="LOCATION" color={Colors.accent} size={20} />
                  <Text style={{ color: Colors.text, fontSize: 13, flex: 1 }} numberOfLines={2}>
                    {locationName
                      ? locationName
                      : (location ? `${location.lat.toFixed(4)}, ${location.lng.toFixed(4)}` : t('loc_resolving'))}
                  </Text>
                  {location?.acc ? (
                    <Text style={{ color: Colors.textDim, fontSize: 13 }}>
                      ±{Math.round(location.acc)}m
                    </Text>
                  ) : null}
                </View>
                <TextInput
                  value={userLocationName}
                  onChangeText={(txt) => {
                    setUserLocationName(txt);
                    setIsLocationUserCorrected(txt.trim().length > 0);
                  }}
                  placeholder={t('loc_search_placeholder')}
                  placeholderTextColor={Colors.textDim}
                  style={s.locSearchInput}
                  accessibilityLabel={t('loc_search_placeholder')}
                />
              </View>

              {/* Service status — always visible (Apr 2026 UI v2.1).
                  Was collapsible behind a chevron TouchableOpacity; field
                  testing showed uneducated users didn't tap to expand.
                  Flattened to a plain section header + always-rendered
                  content. Header styled identically to the PWA's flat
                  .service-details label (uppercase dim muted). */}
              <View
                style={{
                  marginTop: 14, paddingHorizontal: 12, paddingVertical: 12,
                  borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.03)',
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
                }}
              >
                <Text style={{
                  color: Colors.textDim, fontSize: 13, fontWeight: '700',
                  textTransform: 'uppercase', letterSpacing: 0.6,
                  marginBottom: 10,
                }}>
                  {t('service_label')}
                </Text>
                <View>{/* always-rendered; no conditional gate */}
                  {(['electricity', 'water', 'health'] as const).map((svc) => {
                    const val = svc === 'electricity' ? electricityStatus : svc === 'water' ? waterStatus : healthStatus;
                    const set = svc === 'electricity' ? setElectricityStatus : svc === 'water' ? setWaterStatus : setHealthStatus;
                    const icon = svc === 'electricity' ? '⚡' : svc === 'water' ? '💧' : '🏥';
                    return (
                      <View key={svc} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 6 }}>
                        <Text style={{ color: Colors.text, width: 110, fontSize: 13 }}>{icon} {svc[0].toUpperCase() + svc.slice(1)}</Text>
                        <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap' }}>
                          {(['UNKNOWN','OPERATIONAL','DISRUPTED','DESTROYED'] as const).map(lvl => {
                            const labelKey = lvl === 'UNKNOWN' ? 'service_unknown'
                              : lvl === 'OPERATIONAL' ? 'service_working'
                              : lvl === 'DISRUPTED' ? 'service_disrupted' : 'service_destroyed';
                            return (
                              <TouchableOpacity key={lvl} style={[s.chip, val === lvl && s.chipActive, { paddingVertical: 4, paddingHorizontal: 8, marginRight: 4, marginBottom: 4 }]} onPress={() => set(lvl)}>
                                <Text style={[s.chipText, { fontSize: 13 }]}>{t(labelKey)}</Text>
                              </TouchableOpacity>
                            );
                          })}
                        </View>
                      </View>
                    );
                  })}
                  <Text style={[s.label, { marginTop: 8 }]}>{t('needs_label')}</Text>
                  <View style={s.chipRow}>
                    {/* Apr 2026 UI v2.1 — chips expanded 5 → 10 to cover all
                        UNDP Appendix-1 pressing-needs categories + Other.
                        Order matches the UNDP doc. Old `security` legacy
                        value retained as `needs_security` i18n key for any
                        reports submitted before the expansion. */}
                    {[
                      { k: 'food',           labelKey: 'needs_food',           icon: '🍱' },
                      { k: 'water',          labelKey: 'needs_water',          icon: '🚰' },
                      { k: 'cash',           labelKey: 'need_cash',            icon: '💰' },
                      { k: 'medical',        labelKey: 'needs_medical',        icon: '⚕️' },
                      { k: 'shelter',        labelKey: 'needs_shelter',        icon: '🏠' },
                      { k: 'livelihoods',    labelKey: 'need_livelihoods',     icon: '💼' },
                      { k: 'wash',           labelKey: 'need_wash',            icon: '🚿' },
                      { k: 'basic_services', labelKey: 'need_basic_services',  icon: '⚡' },
                      { k: 'protection',     labelKey: 'need_protection',      icon: '🛡' },
                      { k: 'local_support',  labelKey: 'need_local_support',   icon: '🏛' },
                    ].map(n => (
                      <TouchableOpacity key={n.k} style={[s.chip, pressingNeeds.includes(n.k) && s.chipActive]} onPress={() => togglePressingNeed(n.k)}>
                        <Text style={s.chipText}>{n.icon} {t(n.labelKey)}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>
                </View>
            </>
          )}

          {/* ── Page 3: Describe & send — description + footprint + submit ── */}
          {reviewPage === 3 && (
            <>
              <Text style={s.label}>{t('description_label')}</Text>
              <TextInput
                style={s.textInput}
                value={description}
                onChangeText={setDescription}
                multiline
                numberOfLines={3}
                placeholderTextColor={Colors.textDim}
                placeholder={t('type_text')}
              />

              {/* UNDP-required building footprint selector (Apr 2026 UI v2.1).
                  WAS: disabled at opacity 0.4 until a GPS fix landed, so
                  the UNDP-mandated picker looked broken / missing to
                  field users who submitted before location resolved.
                  NOW: always interactive. If no GPS yet, the picker
                  modal itself shows a "Waiting for GPS" state and waits
                  for the fix to roll in — parity with the PWA's flat
                  map + placeholder pattern. */}
              {buildingId ? (
                <View style={[s.locSelectedPill, { marginBottom: 10 }]}>
                  <Text style={s.locSelectedPillIcon}>✓</Text>
                  <Text style={s.locSelectedPillText} numberOfLines={1}>
                    {t('building_selected')}: {infraNameFromOsm && infraName ? infraName : buildingId.replace('osm:way:', '#')}
                  </Text>
                  <TouchableOpacity onPress={() => {
                    setBuildingId(null);
                    if (infraNameFromOsm) {
                      setInfraName('');
                      setInfraNameFromOsm(false);
                    }
                  }}>
                    <Text style={{ color: Colors.accent, fontWeight: '600', fontSize: 12 }}>{t('edit')}</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  style={[
                    s.locFootprintBtn,
                    {
                      marginBottom: 10, paddingVertical: 14,
                      borderWidth: 1.5, borderColor: Colors.accent,
                      backgroundColor: 'rgba(124,58,237,0.10)',
                    },
                  ]}
                  onPress={() => setFootprintPickerOpen(true)}
                  accessibilityRole="button"
                  accessibilityLabel={t('building_select_title')}>
                  <Text style={[s.locFootprintBtnText, { fontSize: 15, color: Colors.accent }]}>
                    🏢  {t('building_select_title')}
                  </Text>
                  {!location && (
                    <Text style={{ marginTop: 4, color: Colors.textDim, fontSize: 12, textAlign: 'center' }}>
                      {t('building_waiting_gps')}
                    </Text>
                  )}
                </TouchableOpacity>
              )}

              {/* Phase B2 (Apr 2026 UI v3) — free-text building-name
                  fallback. Used when the BuildingFootprintPicker's Leaflet /
                  Overpass pipeline is unavailable (offline, WebView blocked,
                  Overpass rate-limit). The reporter types the name in their
                  native language; the backend stores it on
                  `infrastructure_name` with `building_id=NULL` and the
                  dashboard tags the row "needs mapping". Editing this input
                  clears `infraNameFromOsm` — user intent overrides any
                  prior OSM auto-fill. Always rendered (not behind a
                  conditional) so the path is discoverable; if the user
                  already picked a footprint, they see the typed name
                  reflected here. */}
              <View style={s.buildingFreeText}>
                <Text style={s.buildingFreeTextLabel}>
                  ✍️  {t('bldg_offline_prompt')}
                </Text>
                <TextInput
                  style={s.buildingFreeTextInput}
                  placeholder="e.g. Kiambu High School / مدرسة الأمل"
                  placeholderTextColor={Colors.textDim}
                  value={infraName}
                  onChangeText={(v) => {
                    setInfraName(v);
                    // User typed — the text is no longer OSM-authoritative.
                    // Match PWA's setupBuildingFreeText() behaviour.
                    setInfraNameFromOsm(false);
                  }}
                  maxLength={120}
                  returnKeyType="done"
                  accessibilityLabel={t('bldg_offline_prompt')}
                />
                <Text style={s.buildingFreeTextHint}>
                  ℹ️  {t('bldg_offline_hint')}
                </Text>
              </View>

              {/* Inline summary — one dense card that lets the user
                  sanity-check the most load-bearing fields before Submit. */}
              <View style={s.summaryCard}>
                <Text style={s.summaryRow}>🌪 {(crisisTypes.find(ct => ct.key === crisisType)?.label) || crisisType}</Text>
                <Text style={s.summaryRow}>🏗 {damageClass.replace(/_/g, ' ')}  ·  ⚠️ {severity}</Text>
                <Text style={s.summaryRow}>📋 {infraType.replace(/_/g, ' ')}</Text>
                {locationName ? <Text style={s.summaryRow}>📍 {locationName}</Text> : null}
                {pressingNeeds.length > 0 ? <Text style={s.summaryRow}>{t('needs_prefix')} {pressingNeeds.join(', ')}</Text> : null}
              </View>

              <TouchableOpacity
                style={[s.bigBtn, isSending && { opacity: 0.5 }]}
                onPress={submitReport}
                disabled={isSending}
                accessibilityRole="button">
                <Text style={s.bigBtnText}>{isSending ? t('sending') : t('submit')}</Text>
              </TouchableOpacity>
            </>
          )}

          {/* Nav footer — Back + Next on pages 1/2, Back-only on page 3
              (Submit is the primary CTA inline with the summary card). */}
          <View style={s.navRow}>
            <TouchableOpacity
              style={[s.backBtn]}
              onPress={() => {
                if (reviewPage === 1) {
                  setScreen('audio');
                } else {
                  setReviewPage((p) => reviewReducer(p, { type: 'BACK' }));
                }
              }}
              accessibilityRole="button">
              <Text style={s.backText}>{t('back')}</Text>
            </TouchableOpacity>
            {reviewPage < 3 && (
              <TouchableOpacity
                style={s.nextBtn}
                onPress={() => setReviewPage((p) => reviewReducer(p, { type: 'NEXT' }))}
                accessibilityRole="button">
                <Text style={s.nextBtnText}>{t('next')} →</Text>
              </TouchableOpacity>
            )}
          </View>
        </ScrollView>
      )}

      {/* Phase 3 (Apr 2026) — Confirm (summary + edit + Submit). Both Edit
           links point to review_details now since that's the single editable
           screen after the 3-page → 2-page collapse. */}
      {screen === 'review_confirm' && (
        <ScrollView
          style={{ flex: 1, backgroundColor: Colors.bg }}
          nestedScrollEnabled
          scrollEventThrottle={16}
          contentContainerStyle={{ padding: responsivePad() }}>
          <FlowProgress step={4} have={{ photo: !!photoUri, details: !!(audioUri || description?.trim()) }} />
          <Text style={s.title}>{t('confirm_title')}</Text>

          <View style={s.summaryCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <Text style={[s.summaryRow, { fontWeight: '700' }]}>{t('incident_title')}</Text>
              {/* Phase B4 (Apr 2026 UI v3) — edit pill deep-links to the
                  v3 crisis stage (where crisis + building name live). In v2
                  it returns to the legacy review_details screen. */}
              <TouchableOpacity onPress={() => setScreen(uiV3 ? 'crisis' : 'review_details')}><Text style={{ color: Colors.accent }}>{t('edit')}</Text></TouchableOpacity>
            </View>
            <Text style={s.summaryRow}>🌪 {crisisType.replace(/_/g, ' ')}  📸 {photoUri ? '✅' : '❌'} + {extraPhotos.length} extra  🎤 {audioUri ? '✅' : '❌'}</Text>
            {description ? <Text style={s.summaryDesc} numberOfLines={3}>📝 {description}</Text> : null}
            {locationName ? <Text style={s.summaryRow}>📍 {locationName}</Text> : null}
          </View>

          <View style={s.summaryCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <Text style={[s.summaryRow, { fontWeight: '700' }]}>{t('details_title')}</Text>
              {/* Phase B4 (Apr 2026 UI v3) — details-edit pill deep-links
                  to the v3 infra stage (what was hit + damage severity). */}
              <TouchableOpacity onPress={() => setScreen(uiV3 ? 'infra' : 'review_details')}><Text style={{ color: Colors.accent }}>{t('edit')}</Text></TouchableOpacity>
            </View>
            <Text style={s.summaryRow}>📋 {infraType} | ⚠️ {severity} | 🏗 {damageClass.replace(/_/g, ' ')}</Text>
            {infraName ? <Text style={s.summaryRow}>🏛 {infraName}</Text> : null}
            {debrisClearing ? <Text style={s.summaryRow}>{t('debris_needed')}</Text> : null}
            <Text style={s.summaryRow}>⚡ {electricityStatus} · 💧 {waterStatus} · 🏥 {healthStatus}</Text>
            {pressingNeeds.length > 0 ? <Text style={s.summaryRow}>{t('needs_prefix')} {pressingNeeds.join(', ')}</Text> : null}
          </View>

          {/* Phase 3: copy unified with PWA — "Submit" on both platforms. */}
          <TouchableOpacity style={[s.bigBtn, isSending && { opacity: 0.5 }]} onPress={submitReport} disabled={isSending}>
            <Text style={s.bigBtnText}>{isSending ? t('sending') : t('submit')}</Text>
          </TouchableOpacity>
          {/* Phase B4 (Apr 2026 UI v3) — v3 skipped review_details on the
              way forward, so Back here returns to 'audio'. Legacy v2 keeps
              its full back-nav through review_details. */}
          <TouchableOpacity onPress={() => setScreen(uiV3 ? 'audio' : 'review_details')}><Text style={s.backText}>{t('back')}</Text></TouchableOpacity>
        </ScrollView>
      )}

      {screen === 'success' && (
        <View style={[s.screen, { padding: responsivePad() }]}>
          {/* PR 7 (Apr 2026): glowing heart close — warmer framing, explicit
              two-action exit. Primary resets to a fresh report loop; secondary
              opens the just-submitted report's detail so the user can
              follow status without hunting in "My Reports". */}
          <View style={{ marginBottom: 12 }}>
            <SuccessHeart />
          </View>
          <Text style={s.title}>{t('success_title')}</Text>
          <Text style={s.subtitle}>{t('success_sub')}</Text>
          <Text style={{ color: Colors.accent, fontSize: 14, fontFamily: 'monospace', marginBottom: 12 }}>🆔 {reportId}...</Text>
          <BadgeCard deviceHash={deviceHash} />
          {!isOnline && <View style={s.queueBadge}><Text style={s.queueText}>📴 {t('offline')}</Text></View>}
          <TouchableOpacity style={s.bigBtn} onPress={() => { resetReport(); setScreen('home'); }}>
            <Text style={s.bigBtnText}>+ {t('add_another_report')}</Text>
          </TouchableOpacity>
          {/* PR 7 Track button — synthesises a minimal local row so the
              detail view renders immediately even before the next
              status-since poll refreshes `history`. */}
          <TouchableOpacity
            style={{
              marginTop: 10,
              paddingVertical: 12, paddingHorizontal: 16,
              backgroundColor: 'rgba(99,102,241,0.08)',
              borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)',
              borderRadius: 12,
              flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
            onPress={() => {
              // Synthesise the minimal shape expected by the detail view.
              const synth: any = {
                id: null,
                client_report_id: reportId || null,
                server_created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                infrastructure_type: infraType,
                crisis_type: crisisType,
                severity,
                damage_classification: damageClass,
                description: description || '',
                location_name: locationName || null,
                latitude: location?.lat ?? null,
                longitude: location?.lng ?? null,
                verdict: 'NOT_REVIEWED',
                status: 'SUBMITTED',
                __synthetic: true,
              };
              setSelectedReport(synth);
              setScreen('report_detail');
            }}
          >
            <Text style={{ color: '#a5b4fc', fontSize: 15, fontWeight: '700' }}>📍 {t('track_report')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {screen === 'history' && (
        <ScrollView
          style={{ flex: 1, backgroundColor: Colors.bg }}
          nestedScrollEnabled
          scrollEventThrottle={16}
          // R8: responsive horizontal padding — 20 px at 360 px, scales
          // down to ~17 px at 280 px so cards don't clip the right edge.
          contentContainerStyle={{ padding: Math.min(20, Dimensions.get('window').width * 0.055) }}>
          {/* R1: back/refresh row wraps on narrow screens with gap + flex:1
              + minWidth:120. No change to visible layout at ≥360 px — both
              buttons still sit on one line — but at 320 px the refresh
              button drops to its own row instead of overflowing. */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            <TouchableOpacity
              onPress={() => setScreen('home')}
              style={{ flex: 1, minWidth: 120, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center' }}>
              <Text style={{ color: Colors.text, fontSize: 14, fontWeight: '700' }}>← {t('back')}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { pollStatus(); refreshHistory(); }}
              style={{ flex: 1, minWidth: 120, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center' }}>
              <Text style={{ color: Colors.cyan, fontSize: 14, fontWeight: '700' }}>{t('refresh')}</Text>
            </TouchableOpacity>
          </View>

          {/* Sync status summary: how many synced, how many in flight */}
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
            <View style={{ flex: 1, backgroundColor: 'rgba(34,197,94,0.08)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.25)', borderRadius: 12, padding: 10, alignItems: 'center' }}>
              <Text style={{ fontSize: 22, fontWeight: '900', color: Colors.green }}>{history.length}</Text>
              <Text style={{ fontSize: 11, color: Colors.green, fontWeight: '600' }}>✅ Sent</Text>
            </View>
            <View style={{ flex: 1, backgroundColor: 'rgba(245,158,11,0.08)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.25)', borderRadius: 12, padding: 10, alignItems: 'center' }}>
              <Text style={{ fontSize: 22, fontWeight: '900', color: '#f59e0b' }}>{pendingReports.length}</Text>
              <Text style={{ fontSize: 11, color: '#f59e0b', fontWeight: '600' }}>⏳ In queue</Text>
            </View>
            {impactStats.totalLives > 0 && (
              <View style={{ flex: 1, backgroundColor: 'rgba(34,197,94,0.08)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.25)', borderRadius: 12, padding: 10, alignItems: 'center' }}>
                <Text style={{ fontSize: 22, fontWeight: '900', color: Colors.green }}>{impactStats.totalLives}</Text>
                <Text style={{ fontSize: 11, color: Colors.green, fontWeight: '600' }}>💚 Saved</Text>
              </View>
            )}
          </View>

          {/* In-flight / queued section — renders BEFORE synced so users see
              what still needs to upload. Each card shows its sync state and
              chunk-progress percentages so the user has real observability. */}
          {pendingReports.length > 0 && (
            <>
              <Text style={{ fontSize: 15, fontWeight: '800', color: Colors.text, marginBottom: 8 }}>⏳ Queued for sync</Text>
              {pendingReports.map((p) => {
                let meta: any = {};
                try { meta = JSON.parse(p.meta || '{}'); } catch {}
                const infra = meta.infrastructure_type || 'OTHER';
                const hasPhoto = !!p.photo;
                const hasAudio = !!p.audio;
                const photoPct = p.photo && p.photo_chunk_progress ? Math.min(100, Math.round((p.photo_chunk_progress / p.photo.length) * 100)) : 0;
                const audioPct = p.audio && p.audio_chunk_progress ? Math.min(100, Math.round((p.audio_chunk_progress / p.audio.length) * 100)) : 0;
                const statusLabel = p.status === 'syncing' ? '↑ Uploading'
                  : p.status === 'failed' ? '⚠ Failed'
                  : !isOnline ? '📴 Waiting for network' : '⌛ Pending';
                const statusColor = p.status === 'syncing' ? '#38bdf8' : p.status === 'failed' ? Colors.red : '#94a3b8';
                // P2.12 — failed reports get explicit Retry / Delete actions.
                // Before this, MAX_RETRIES reports stayed invisible in the
                // queue forever with no user recourse. Retry resets status to
                // `pending_sync` and zeroes retry_count; processQueue() picks
                // it back up. Delete removes the row from the local DB (no
                // server round-trip — the report was never successfully
                // registered there).
                const isFailed = p.status === 'failed';
                const borderColor = isFailed ? 'rgba(239,68,68,0.45)' : 'rgba(245,158,11,0.3)';
                return (
                  <View key={p.client_report_id} style={{ backgroundColor: Colors.surface, borderWidth: 1, borderColor: borderColor, borderRadius: 12, padding: 12, marginBottom: 8 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={{ color: Colors.text, fontSize: 13, fontWeight: '700' }}>
                        {infra.replace(/_/g, ' ')} · {meta.severity || 'MODERATE'}
                      </Text>
                      <Text style={{ color: statusColor, fontSize: 11, fontWeight: '700' }}>{statusLabel}</Text>
                    </View>
                    <Text style={{ color: Colors.textDim, fontSize: 13, marginTop: 3 }}>
                      📸 {hasPhoto ? `${photoPct}%` : '—'}  🎤 {hasAudio ? `${audioPct}%` : '—'}  {p.retry_count ? `(retry ${p.retry_count})` : ''}
                    </Text>
                    {p.text_description ? <Text style={{ color: Colors.textDim, fontSize: 13, marginTop: 2 }} numberOfLines={1}>{p.text_description}</Text> : null}
                    {isFailed && (
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                        <TouchableOpacity
                          onPress={async () => {
                            try {
                              // Reset the retry budget so syncEngine tries
                              // again from scratch on the next tick.
                              await updateReportStatus(p.client_report_id, 'pending_sync', { retry_count: 0 });
                              await refreshHistory();
                              processQueue().then(updateQueueCount).catch(() => {});
                            } catch (e) {
                              Alert.alert('Retry failed', 'Could not reset this report.');
                            }
                          }}
                          style={{ flex: 1, backgroundColor: 'rgba(56,189,248,0.15)', borderWidth: 1, borderColor: 'rgba(56,189,248,0.4)', borderRadius: 8, paddingVertical: 6, alignItems: 'center' }}>
                          <Text style={{ color: '#38bdf8', fontSize: 12, fontWeight: '700' }}>🔄 Retry</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => {
                            // Apr 2026 i18n sweep — localised button text via
                            // btn_cancel / btn_delete; title/body kept as
                            // English fall-through for now (no key yet).
                            Alert.alert('Delete queued report?',
                              'This will permanently remove it from the device. Your photo and audio will be lost.',
                              [
                                { text: t('btn_cancel'), style: 'cancel' },
                                { text: t('btn_delete'), style: 'destructive', onPress: async () => {
                                  try {
                                    await deleteQueuedReport(p.client_report_id);
                                    await refreshHistory();
                                    await updateQueueCount();
                                  } catch {
                                    Alert.alert('Delete failed', 'Try again.');
                                  }
                                }},
                              ]);
                          }}
                          style={{ flex: 1, backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.4)', borderRadius: 8, paddingVertical: 6, alignItems: 'center' }}>
                          <Text style={{ color: Colors.red, fontSize: 12, fontWeight: '700' }}>🗑 Delete</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                );
              })}
            </>
          )}

          <Text style={{ fontSize: 15, fontWeight: '800', color: Colors.text, marginBottom: 8, marginTop: pendingReports.length > 0 ? 12 : 0 }}>✅ Sent to dashboard</Text>

          {history.length === 0 ? (
            <View style={{ alignItems: 'center', padding: 32 }}>
              <Text style={{ fontSize: 48, marginBottom: 12 }}>📋</Text>
              <Text style={{ color: Colors.textDim, fontSize: 14, textAlign: 'center' }}>No reports yet.{'\n'}Your first report could save lives.</Text>
            </View>
          ) : (
            // Apr 2026 "My Reports" spec — redesigned card: thumbnail +
            // location + date + 4-state color-coded chip. Tap opens the
            // new screen === 'report_detail' view (parity with PWA's
            // stage-report-detail). Delete moved into the detail view so
            // users always confirm against the full report context.
            history.map((h: any) => {
              const st = mapReportStatus(h);
              const loc = h.location || {};
              const placeName = loc.user_location_name || loc.device_location_name || '';
              const dateText = timeAgo(h.server_created_at || h.synced_at ? new Date(h.synced_at).toISOString() : null);
              const thumbUri = h.thumbnail_url
                ? (String(h.thumbnail_url).startsWith('http') ? h.thumbnail_url
                    : `${getApiBase().replace(/\/api\/v1$/, '')}${String(h.thumbnail_url).startsWith('/') ? '' : '/'}${h.thumbnail_url}`)
                : null;
              const queued = deleteQueue.includes(h.server_id || h.client_report_id);
              const title = (h.crisis_type ? String(h.crisis_type).replace(/_/g, ' ') : '—') +
                  ' · ' + (h.infrastructure_type ? String(h.infrastructure_type).replace(/_/g, ' ') : '—');
              return (
                <TouchableOpacity
                  key={h.client_report_id}
                  onPress={() => {
                    setSelectedReport(h);
                    setScreen('report_detail');
                  }}
                  style={{
                    backgroundColor: Colors.surface,
                    borderWidth: 1, borderColor: Colors.border,
                    borderRadius: 10, marginBottom: 8,
                    padding: 10, flexDirection: 'row', gap: 12,
                  }}
                >
                  {thumbUri ? (
                    <Image source={{ uri: thumbUri }} style={{ width: 64, height: 64, borderRadius: 8 }} />
                  ) : (
                    <View style={{ width: 64, height: 64, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.04)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderStyle: 'dashed', borderColor: 'rgba(255,255,255,0.15)' }}>
                      <Text style={{ fontSize: 20, color: 'rgba(255,255,255,0.3)' }}>📸</Text>
                    </View>
                  )}
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                      <Text style={{ color: Colors.text, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.3, flex: 1 }} numberOfLines={1}>
                        {title}
                      </Text>
                      <View style={{
                        backgroundColor: st.color + '22',
                        borderColor: st.color + '55',
                        borderWidth: 1,
                        paddingHorizontal: 8, paddingVertical: 2,
                        borderRadius: 999,
                      }}>
                        <Text style={{ color: st.color, fontSize: 11, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                          {st.icon} {st.label}
                        </Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                      {!!placeName && (
                        <Text style={{ color: Colors.textDim, fontSize: 13 }} numberOfLines={1}>📍 {placeName}</Text>
                      )}
                      {!!dateText && (
                        <Text style={{ color: Colors.textDim, fontSize: 13 }}>🕒 {dateText}</Text>
                      )}
                      {h.lives_impacted > 0 && (
                        <Text style={{ color: Colors.green, fontSize: 13, fontWeight: '600' }}>💚 {h.lives_impacted} lives</Text>
                      )}
                    </View>
                    {queued && (
                      <Text style={{ color: '#fbbf24', fontSize: 13, marginTop: 4 }}>🕒 Will be deleted when connected</Text>
                    )}
                  </View>
                </TouchableOpacity>
              );
            })
          )}

          {/* Apr 2026 "My Reports" spec — bulk "Delete all my reports"
              hidden behind an Advanced accordion (primary path is
              individual delete from the detail view). */}
          <View style={{ paddingTop: 24, paddingBottom: 16, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)', marginTop: 16 }}>
            <TouchableOpacity
              onPress={() => setShowAdvancedDelete((x) => !x)}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 8,
                paddingHorizontal: 12, paddingVertical: 8,
                backgroundColor: 'rgba(255,255,255,0.02)', borderRadius: 8,
              }}
            >
              <Text style={{ fontSize: 12 }}>⚙️</Text>
              <Text style={{ color: '#94a3b8', fontSize: 12, fontWeight: '600', flex: 1, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {t('advanced') || 'Advanced'}
              </Text>
              <Text style={{ color: '#94a3b8', fontSize: 11 }}>{showAdvancedDelete ? '▲' : '▼'}</Text>
            </TouchableOpacity>
            {showAdvancedDelete && (
              <View style={{ paddingTop: 12 }}>
                <TouchableOpacity
                  style={{
                    paddingVertical: 12,
                    borderRadius: 10,
                    borderWidth: 1,
                    borderColor: 'rgba(239,68,68,0.45)',
                    alignItems: 'center',
                    flexDirection: 'row',
                    justifyContent: 'center',
                    gap: 8,
                  }}
                  onPress={async () => {
                    if (!deviceHash) {
                      Alert.alert('Nothing to delete', 'No reports on this device.');
                      return;
                    }
                    Alert.alert(
                      'Delete all my reports?',
                      'This removes every report you\'ve sent from this device. Your data will be permanently deleted within 24 hours. This cannot be undone.',
                      [
                        { text: t('btn_cancel'), style: 'cancel' },
                        { text: t('btn_delete'), style: 'destructive', onPress: async () => {
                          try {
                            await fetch(`${getApiBase()}/reports/device/${deviceHash}`, { method: 'DELETE' });
                            Alert.alert('Deletion requested', 'Your reports will be removed within 24 hours.');
                            await refreshHistory();
                          } catch (e) {
                            Alert.alert('Error', `Delete failed: ${(e as Error).message}`);
                          }
                        }},
                      ],
                    );
                  }}
                >
                  <Text style={{ color: '#f87171', fontSize: 14 }}>🗑</Text>
                  <Text style={{ color: '#f87171', fontSize: 14, fontWeight: '600' }}>{t('delete_all_my_reports') || 'Delete all my reports'}</Text>
                </TouchableOpacity>
                <Text style={{ fontSize: 13, color: '#94a3b8', textAlign: 'center', marginTop: 8, lineHeight: 18 }}>
                  {t('delete_all_note') || "This removes every report you've sent from this device. Your data will be permanently deleted within 24 hours."}
                </Text>
              </View>
            )}
          </View>
        </ScrollView>
      )}

      {/* Apr 2026 "My Reports" spec — individual report detail.
          Parity with PWA's stage-report-detail. Photo + timeline +
          metadata + feedback + per-report delete with offline queue. */}
      {screen === 'report_detail' && selectedReport && (() => {
        const r = selectedReport;
        const st = mapReportStatus(r);
        const loc = r.location || {};
        const placeName = loc.user_location_name || loc.device_location_name || '';
        const thumbUri = r.thumbnail_url
          ? (String(r.thumbnail_url).startsWith('http') ? r.thumbnail_url
              : `${getApiBase().replace(/\/api\/v1$/, '')}${String(r.thumbnail_url).startsWith('/') ? '' : '/'}${r.thumbnail_url}`)
          : null;
        const rejected = st.state === 'REJECTED';
        const reviewed = !!r.reviewed_at;
        const accepted = st.state === 'ACCEPTED';
        const dispatched = !!r.help_dispatched_at || !!r.help_arrived_at;
        const tlSteps = [
          { label: 'Submitted', done: !!r.server_created_at },
          { label: 'Under Review', done: reviewed || accepted || rejected || dispatched },
          { label: rejected ? 'Rejected' : 'Accepted', done: accepted || rejected, rejected },
          ...(!rejected ? [{ label: 'Help Sent', done: dispatched, rejected: false }] : []),
        ];
        const actions = deriveActionTaken(r);
        const idToDelete = r.server_id || r.id || r.client_report_id;
        const queued = deleteQueue.includes(idToDelete);
        const alreadyRequested = !!r.deletion_requested_at;

        return (
          <ScrollView
            style={{ flex: 1, backgroundColor: Colors.bg }}
            nestedScrollEnabled
            scrollEventThrottle={16}
            contentContainerStyle={{ padding: Math.min(16, Dimensions.get('window').width * 0.045), paddingBottom: 40 }}>
            {/* Header */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <TouchableOpacity onPress={() => { setScreen('history'); setSelectedReport(null); refreshHistory().catch(() => {}); }}>
                <Text style={{ color: Colors.text, fontSize: 20, paddingRight: 12 }}>←</Text>
              </TouchableOpacity>
              <Text style={{ color: Colors.text, fontSize: 17, fontWeight: '700', flex: 1 }}>
                📄 {t('report_detail') || 'Report'}
              </Text>
              <View style={{
                backgroundColor: st.color + '22',
                borderColor: st.color + '55', borderWidth: 1,
                paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999,
              }}>
                <Text style={{ color: st.color, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {st.icon} {st.label}
                </Text>
              </View>
            </View>

            {/* Timeline */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
              {tlSteps.map((s, i) => (
                <React.Fragment key={s.label}>
                  <View style={{ alignItems: 'center', minWidth: 64 }}>
                    <View style={{
                      width: 22, height: 22, borderRadius: 11,
                      borderWidth: 2,
                      borderColor: s.done
                        ? (s.rejected ? 'rgba(239,68,68,0.7)' : 'rgba(34,197,94,0.7)')
                        : 'rgba(255,255,255,0.18)',
                      backgroundColor: s.done
                        ? (s.rejected ? 'rgba(239,68,68,0.22)' : 'rgba(34,197,94,0.22)')
                        : 'rgba(255,255,255,0.04)',
                    }} />
                    <Text style={{
                      // Apr 2026 UI v2 (R6): 10 → 13 legibility floor.
                      fontSize: 13, fontWeight: '600',
                      marginTop: 4,
                      color: s.done
                        ? (s.rejected ? '#f87171' : '#4ade80')
                        : 'rgba(255,255,255,0.5)',
                      textAlign: 'center',
                      textTransform: 'uppercase', letterSpacing: 0.3,
                    }}>{s.label}</Text>
                  </View>
                  {i < tlSteps.length - 1 && (
                    <View style={{ flex: 1, height: 2, backgroundColor: 'rgba(255,255,255,0.12)', marginTop: -14, marginHorizontal: 2 }} />
                  )}
                </React.Fragment>
              ))}
            </View>

            {/* Photo */}
            {thumbUri && (
              <View style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 16, aspectRatio: 16 / 10, backgroundColor: 'rgba(255,255,255,0.03)' }}>
                <Image source={{ uri: thumbUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              </View>
            )}

            {/* Description */}
            {!!r.description && (
              <View style={{ marginBottom: 16 }}>
                <Text style={{ fontSize: 13, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                  Description
                </Text>
                <Text style={{ color: Colors.text, fontSize: 14, lineHeight: 20 }}>{r.description}</Text>
              </View>
            )}

            {/* Metadata */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 13, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                Details
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {[
                  placeName && { label: 'Location', value: placeName, icon: '📍' },
                  r.crisis_type && { label: 'Crisis', value: String(r.crisis_type).replace(/_/g, ' '), icon: '🌪' },
                  r.infrastructure_type && { label: 'What', value: String(r.infrastructure_type).replace(/_/g, ' '), icon: '🏢' },
                  r.damage_classification && { label: 'Damage', value: String(r.damage_classification).replace(/_/g, ' '), icon: '💥' },
                  r.severity && { label: 'Severity', value: String(r.severity).replace(/_/g, ' '), icon: '⚠️' },
                ].filter(Boolean).map((e: any) => (
                  <View key={e.label} style={{
                    width: '48%', padding: 10,
                    backgroundColor: 'rgba(255,255,255,0.03)',
                    borderRadius: 8,
                  }}>
                    <Text style={{ fontSize: 13, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                      {e.icon} {e.label}
                    </Text>
                    <Text style={{ fontSize: 13, color: Colors.text, fontWeight: '600', textTransform: 'capitalize', marginTop: 2 }}>
                      {e.value}
                    </Text>
                  </View>
                ))}
              </View>
            </View>

            {/* Feedback block (accepted) */}
            {accepted && (
              <View style={{
                flexDirection: 'row', gap: 12, alignItems: 'flex-start',
                padding: 14, borderRadius: 12,
                backgroundColor: 'rgba(34,197,94,0.1)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.3)',
                marginBottom: 16,
              }}>
                <Text style={{ fontSize: 26 }}>🟢</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#4ade80', marginBottom: 4 }}>
                    Your report helped respond quickly
                  </Text>
                  <Text style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 18 }}>
                    {[
                      actions.join(' · '),
                      r.lives_impacted > 0 ? `~${r.lives_impacted} ${r.lives_impacted === 1 ? 'person' : 'people'} helped` : '',
                    ].filter(Boolean).join(' · ') || 'Accepted — awaiting dispatch'}
                  </Text>
                </View>
              </View>
            )}

            {/* Rejection reason */}
            {rejected && (
              <View style={{
                flexDirection: 'row', gap: 12, alignItems: 'flex-start',
                padding: 14, borderRadius: 12,
                backgroundColor: 'rgba(239,68,68,0.08)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)',
                marginBottom: 16,
              }}>
                <Text style={{ fontSize: 26 }}>🔴</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: '#f87171', marginBottom: 4 }}>
                    {t('rejected_reason') || 'Not valid'}
                  </Text>
                  <Text style={{ fontSize: 12, color: '#cbd5e1', lineHeight: 18 }}>
                    {r.action_taken || 'This report was marked not valid by reviewers.'}
                  </Text>
                </View>
              </View>
            )}

            {/* Delete / queued state */}
            <View style={{ paddingTop: 16, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)', marginTop: 8 }}>
              {alreadyRequested ? (
                <View style={{
                  padding: 10, backgroundColor: 'rgba(245,158,11,0.08)',
                  borderLeftWidth: 3, borderLeftColor: 'rgba(245,158,11,0.5)', borderRadius: 4,
                }}>
                  <Text style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center' }}>
                    Deletion in progress. Removed within 24 hours.
                  </Text>
                </View>
              ) : queued ? (
                <View style={{
                  padding: 10, backgroundColor: 'rgba(245,158,11,0.08)',
                  borderLeftWidth: 3, borderLeftColor: 'rgba(245,158,11,0.5)', borderRadius: 4,
                }}>
                  <Text style={{ fontSize: 12, color: '#94a3b8', textAlign: 'center' }}>
                    🕒 Will be deleted when connected.
                  </Text>
                </View>
              ) : (
                <TouchableOpacity
                  style={{
                    paddingVertical: 12, borderRadius: 10, borderWidth: 1,
                    borderColor: 'rgba(239,68,68,0.45)',
                    alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8,
                  }}
                  onPress={() => {
                    Alert.alert(
                      'Delete this report?',
                      'Your data will be permanently removed within 24 hours. This cannot be undone.',
                      [
                        { text: t('btn_cancel'), style: 'cancel' },
                        {
                          text: t('btn_delete'), style: 'destructive', onPress: async () => {
                            try {
                              if (!isOnline) {
                                await enqueueDelete(idToDelete);
                                Alert.alert('Queued', 'Will be deleted when connected.');
                                setSelectedReport({ ...r });  // trigger re-render
                                return;
                              }
                              const res = await fetch(`${getApiBase()}/reports/${idToDelete}`, { method: 'DELETE' });
                              if (res.ok || res.status === 204 || res.status === 404) {
                                if (r.client_report_id) await markHistoryDeletionRequested(r.client_report_id);
                                Alert.alert('Deletion requested', 'Removed within 24 hours.');
                                await refreshHistory();
                                setScreen('history');
                                setSelectedReport(null);
                              } else {
                                throw new Error(`HTTP ${res.status}`);
                              }
                            } catch (e) {
                              await enqueueDelete(idToDelete);
                              Alert.alert('Offline', 'Will be deleted when connected.');
                            }
                          },
                        },
                      ],
                    );
                  }}
                >
                  <Text style={{ color: '#f87171', fontSize: 14 }}>🗑</Text>
                  <Text style={{ color: '#f87171', fontSize: 14, fontWeight: '600' }}>
                    {t('delete_this_report') || 'Delete this report'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          </ScrollView>
        );
      })()}
    {/* Apr 2026: Full-screen image viewer. Opens when the user taps a photo
         thumbnail (primary or extra) in the photo stage. Delete button
         raises a confirmation dialog; cancel dismisses. */}
    <Modal
      visible={!!viewerState}
      transparent
      animationType="fade"
      onRequestClose={() => { setViewerConfirmOpen(false); setViewerState(null); }}
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.95)', alignItems: 'center', justifyContent: 'center' }}>
        <TouchableOpacity
          onPress={() => { setViewerConfirmOpen(false); setViewerState(null); }}
          accessibilityLabel={t('image_close')}
          style={{ position: 'absolute', top: 44, right: 16, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}>
          <Text style={{ color: '#fff', fontSize: 18 }}>✕</Text>
        </TouchableOpacity>
        {viewerState && (
          <Image
            source={{ uri: viewerState.uri }}
            style={{ width: '96%', height: '80%' }}
            resizeMode="contain"
          />
        )}
        <TouchableOpacity
          onPress={() => setViewerConfirmOpen(true)}
          style={{ position: 'absolute', bottom: 32, alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 24, backgroundColor: '#ef4444', borderRadius: 12, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>🗑  {t('image_delete_btn')}</Text>
        </TouchableOpacity>
        {/* Confirm-delete sheet — nested inside the viewer Modal so its
            backdrop stacks above the image when visible. */}
        {viewerConfirmOpen && (
          <View style={{ position: 'absolute', inset: 0 as any, top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 3 }}>
            <View style={{ width: '100%', maxWidth: 340, backgroundColor: '#111827', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)', padding: 20, alignItems: 'center' }}>
              <Text style={{ color: '#f1f5f9', fontSize: 16, fontWeight: '700', textAlign: 'center', marginBottom: 8 }}>
                {t('image_delete_confirm_title')}
              </Text>
              <Text style={{ color: '#cbd5e1', fontSize: 13, textAlign: 'center', marginBottom: 18, lineHeight: 18 }}>
                {t('image_delete_confirm_body')}
              </Text>
              <View style={{ flexDirection: 'row', gap: 10, width: '100%' }}>
                <TouchableOpacity
                  onPress={() => setViewerConfirmOpen(false)}
                  style={{ flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center' }}>
                  <Text style={{ color: '#cbd5e1', fontWeight: '700' }}>{t('image_delete_cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={confirmViewerDelete}
                  style={{ flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: '#ef4444', alignItems: 'center' }}>
                  <Text style={{ color: '#fff', fontWeight: '700' }}>{t('image_delete_yes')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        )}
      </View>
    </Modal>
    {/* Building-footprint picker — WebView + Leaflet + Overpass. Opens
        from the review_details location box when the user taps "Select
        exact building". Only rendered when visible; the WebView boots
        lazily so we don't burn cycles when the user never opens it. */}
    {location ? (
      <BuildingFootprintPicker
        visible={footprintPickerOpen}
        onClose={() => setFootprintPickerOpen(false)}
        onSelect={(osmId, osmName) => {
          setBuildingId(osmId);
          // Auto-fill infrastructure_name from the OSM `name` tag so
          // the web-dashboard shows "City Hospital" next to the
          // indigo Building-history pill instead of the bare OSM id.
          // Respects a value the user has already typed — only
          // overwrites when the field is blank.
          if (osmName && !infraName.trim()) {
            setInfraName(osmName);
            setInfraNameFromOsm(true);
          }
        }}
        lat={location.lat}
        lng={location.lng}
      />
    ) : null}

    {/* Privacy consent gate — blocks first render until accepted. We
        show ONLY when consentGiven === false (explicit no); while it's
        still `null` we're still reading AsyncStorage and avoid a flash
        of the overlay. See PWA parity: mobile-app/src/index.html:29. */}
    <ConsentOverlay
      visible={consentGiven === false}
      onAccept={() => {
        AsyncStorage.setItem(
          'crisp_privacy_consent',
          JSON.stringify({ accepted: true, ts: Date.now() }),
        ).catch(() => { /* best-effort — user still gets to use the app */ });
        setConsentGiven(true);
      }}
    />
    </SafeAreaView>
    </TouchableWithoutFeedback>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  // Location verify box — parity with PWA .location-verify-box (styles.css:760).
  // Hosts GPS status + search input + optional building-footprint selector.
  locVerifyBox: {
    marginTop: 14,
    padding: 14,
    borderRadius: 14,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    gap: 10,
  },
  locSearchInput: {
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    color: Colors.text,
    fontSize: 13,
  },
  locSelectedPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: 'rgba(34,197,94,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.35)',
  },
  locSelectedPillIcon: { color: Colors.green, fontSize: 14, fontWeight: '700' },
  locSelectedPillText: { color: Colors.text, fontSize: 13, flex: 1 },
  locFootprintBtn: {
    height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(124,58,237,0.15)',
    borderWidth: 1,
    borderColor: 'rgba(124,58,237,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  locFootprintBtnText: { color: Colors.accent, fontSize: 13, fontWeight: '700' },
  // Phase B2 (Apr 2026 UI v3) — free-text building-name fallback styles.
  // Mirrors the PWA's `.building-free-text*` selectors in styles.css.
  buildingFreeText: {
    marginTop: 2,
    marginBottom: 10,
    padding: 12,
    backgroundColor: 'rgba(37,99,235,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(37,99,235,0.22)',
    borderRadius: 10,
  },
  buildingFreeTextLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.text,
    marginBottom: 6,
  },
  buildingFreeTextInput: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: Colors.text,
    backgroundColor: Colors.surface,
  },
  buildingFreeTextHint: {
    marginTop: 6,
    fontSize: 11,
    color: Colors.textDim,
  },
  // Audio recording timer — shown during active capture only. Red dot
  // + monospace MM:SS, mirrors the PWA's .rec-timer in styles.css.
  recTimer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: 'rgba(239,68,68,0.12)',
    alignSelf: 'center',
  },
  recTimerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.red,
  },
  recTimerText: {
    color: Colors.red,
    fontSize: 14,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  screen: { flex: 1, padding: 24, justifyContent: 'center', alignItems: 'center' },
  emoji: { fontSize: 96, marginBottom: 20 },
  title: { fontSize: 32, fontWeight: '900', color: Colors.text, textAlign: 'center', marginBottom: 8, letterSpacing: -0.5 },
  subtitle: { fontSize: 17, color: Colors.textDim, textAlign: 'center', marginBottom: 28, lineHeight: 24 },
  stepLabel: { fontSize: 12, fontWeight: '700', color: Colors.accent, textAlign: 'center', marginBottom: 8, letterSpacing: 1 },
  label: { fontSize: 13, fontWeight: '700', color: Colors.textDim, marginTop: 16, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  langRow: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'center', gap: 8, marginBottom: 32 },
  langBtn: { padding: 8, borderRadius: 8, borderWidth: 1, borderColor: Colors.border },
  langBtnActive: { borderColor: Colors.accent, backgroundColor: 'rgba(124,58,237,0.1)' },
  langFlag: { fontSize: 22 },
  // UN-language tiles — bigger tap target + enlarged flag to echo the
  // PWA's .lpf-un treatment. Tilts the visual weight toward UNDP's six
  // official languages on the home-screen language row.
  langBtnUn: {
    padding: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: 'rgba(99,102,241,0.32)',
    backgroundColor: 'rgba(99,102,241,0.10)',
  },
  langFlagUn: { fontSize: 30, lineHeight: 34 },
  // Vertical divider between UN and other flags.
  langDivider: {
    width: 1,
    height: 22,
    backgroundColor: Colors.border,
    marginHorizontal: 4,
    opacity: 0.6,
  },
  bigBtn: { backgroundColor: Colors.accent, paddingVertical: 20, paddingHorizontal: 48, borderRadius: 18, marginTop: 16, width: '100%', alignItems: 'center', elevation: 8, minHeight: 64 },
  bigBtnText: { color: Colors.white, fontSize: 20, fontWeight: '900', letterSpacing: 1.5 },
  piiWarning: { backgroundColor: 'rgba(234,179,8,0.1)', borderWidth: 1, borderColor: 'rgba(234,179,8,0.25)', borderRadius: 10, padding: 10, marginBottom: 12, width: '100%' },
  piiText: { color: '#d97706', fontSize: 12, textAlign: 'center' },
  photoPreview: { width: '100%', height: 240, borderRadius: 16, marginBottom: 16 },
  photoPlaceholder: { width: '100%', height: 200, borderRadius: 16, backgroundColor: Colors.surface, justifyContent: 'center', alignItems: 'center', marginBottom: 16, borderWidth: 2, borderColor: Colors.border, borderStyle: 'dashed' },
  row: { flexDirection: 'row', gap: 12, width: '100%', marginBottom: 16 },
  choiceBtn: { flex: 1, backgroundColor: Colors.surface, padding: 24, borderRadius: 16, alignItems: 'center', borderWidth: 1, borderColor: Colors.border, minHeight: 100, justifyContent: 'center' },
  choiceBtnText: { color: Colors.text, fontSize: 18, fontWeight: '700' },
  // Apr 2026 UI v2 (R1 audit): nav row wraps on narrow screens (≤320 px)
  // so the back/next pair don't overflow past the viewport edge. `flex:1`
  // + `minWidth:120` on each button ensures they share available width
  // but still look like tap targets; on ≥360 px the original two-up
  // layout holds because both fit above the wrap threshold.
  navRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, width: '100%', marginTop: 16, alignItems: 'center', justifyContent: 'space-between' },
  backText: { color: Colors.textDim, fontSize: 15, fontWeight: '500', padding: 8 },
  // R1 audit: back button keeps a minimum width so flex:1 can't squeeze
  // it below the 120-px tap-target floor on 280-px devices. The plain
  // `backText` stays for places where only the text label is rendered.
  backBtn: { minWidth: 120, paddingVertical: 8, paddingHorizontal: 8 },
  nextBtn: { backgroundColor: Colors.accent, paddingVertical: 10, paddingHorizontal: 24, borderRadius: 10, flex: 1, minWidth: 120, alignItems: 'center' },
  nextBtnText: { color: Colors.white, fontSize: 15, fontWeight: '700' },
  // Apr 2026 UI v2 — large icon tile used on review pages 1/2. 48 %
  // width lets the wrap land two-per-row at 360 px; on 280 px the tile
  // still fits with room to breathe. `minHeight` floor prevents short
  // labels from collapsing the tile below the 64-px accessibility guide.
  v2Tile: {
    width: '48%',
    minHeight: 88,
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 12,
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  v2TileActive: {
    borderColor: Colors.accent,
    backgroundColor: 'rgba(124,58,237,0.12)',
  },
  // R6: label sits at 13 — above the legibility floor for low-end
  // Android displays and the low-literacy field-worker persona.
  v2TileLabel: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    textTransform: 'capitalize',
  },
  micBtn: { width: 160, height: 160, borderRadius: 80, backgroundColor: Colors.accent, justifyContent: 'center', alignItems: 'center', marginBottom: 24, elevation: 10 },
  textInput: { width: '100%', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: 12, padding: 14, color: Colors.text, fontSize: 15, textAlignVertical: 'top', marginBottom: 16 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  chip: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: Colors.border, alignItems: 'center' },
  chipActive: { borderColor: Colors.accent, backgroundColor: 'rgba(124,58,237,0.12)' },
  // PWA parity — category chip labels use UPPERCASE with a subtle
  // letter-spacing for visual weight (.chip-btn in styles.css:517).
  chipText: { color: Colors.text, fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.5 },
  summaryCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: 14, padding: 18, width: '100%', marginBottom: 16 },
  summaryRow: { color: Colors.text, fontSize: 14, marginBottom: 6 },
  summaryDesc: { color: Colors.textDim, fontSize: 13, fontStyle: 'italic', marginTop: 4 },
  queueBadge: { backgroundColor: 'rgba(245,158,11,0.1)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.25)', borderRadius: 8, padding: 8, marginTop: 16 },
  queueText: { color: '#f59e0b', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  offlineText: { color: Colors.textDim, fontSize: 12, marginTop: 8, textAlign: 'center' },
});
