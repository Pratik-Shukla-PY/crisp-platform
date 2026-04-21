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
  InteractionManager,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from './constants/colors';
import { t, setLanguage, detectLanguage, getAvailableLanguages } from './services/i18n';
import { initDatabase, enqueueReport, getQueueCount } from './services/database';
import { processQueue } from './services/syncEngine';
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

// Phase 3 (Apr 2026): review collapsed from 3 screens to 2 (details + confirm).
// `review_incident` kept as an alias that redirects to `review_details` so any
// lingering push-notification or URL scheme referring to it still lands on a
// valid screen.
// Apr 2026 "My Reports" spec — `report_detail` is a new full-screen view
// with photo / timeline / metadata / feedback + per-report delete. Parity
// with PWA's stage-report-detail.
type Screen = 'home' | 'photo' | 'audio' | 'review_details' | 'review_confirm' | 'success' | 'history' | 'report_detail';

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
  return (
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
                fontSize: 10, fontWeight: st === 'active' ? '700' : '600',
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
  const [queueCount, setQueueCount] = useState(0);
  const [isOnline, setIsOnline] = useState(true);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [audioUri, setAudioUri] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [infraType, setInfraType] = useState('ROAD');
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
  // PR 6 note: RN's home screen already renders the full flag row from
  // getAvailableLanguages() inline, so no overlay is needed — the existing
  // UX already satisfies the "non-redundant EN + picker" goal that PR 6
  // brings to the PWA via the new #btn-lang-change overlay.
  const [location, setLocation] = useState<{ lat: number; lng: number; acc: number } | null>(null);
  const [locationName, setLocationName] = useState('');
  // Phase 4: parity with PWA. User-correction flag + manual location name.
  const [isLocationUserCorrected, setIsLocationUserCorrected] = useState(false);
  const [userLocationName, setUserLocationName] = useState<string>('');
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
    const groupId = crypto.randomUUID();
    const entry = { uri: rawUri, base64: rawB64, groupId, variants: null as PhotoVariants | null };
    setExtraPhotos((xs) => [...xs, entry]);
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

      const wantMore = await new Promise<boolean>((resolve) => {
        Alert.alert(
          'Photo added ✓',
          'Take another?',
          [
            { text: 'Done', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Yes', onPress: () => resolve(true) },
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

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: config.imageQuality,
      base64: true,
      allowsMultipleSelection: true,
      selectionLimit: 10,
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
    await detectNetworkTier();
    const config = getAdaptiveConfig();
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: config.imageQuality,
      base64: true,
      allowsMultipleSelection: true,
      selectionLimit: 10,
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
    } catch (e: any) {
      console.error('[Audio] Start failed:', e);
      Alert.alert('Error', `Could not start recording: ${e.message || 'unknown'}`);
    }
  };

  const stopRecording = async () => {
    try {
      await audioRecorder.stop();
      setIsRecording(false);
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
    } catch (e) { telemetrySwallow('getLocation', e); }
  };

  useEffect(() => {
    const detected = detectLanguage();
    setLanguage(detected);
    setLang(detected);
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
    setInfraType('ROAD'); setSeverity('MODERATE');
    setCrisisType('FLOOD'); setDamageClass('PARTIAL'); setInfraName(''); setDebrisClearing(false);
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
      Alert.alert('Error', 'Could not save report locally. Please try again.');
    }
    setIsSending(false);
  };

  // Phase 3: chip lists match docs/PARITY.md order + labels exactly.
  const types = [
    { key: 'ROAD', icon: '🛣', label: t('type_road') }, { key: 'HOSPITAL', icon: '🏥', label: t('type_hospital') },
    { key: 'HOUSE', icon: '🏠', label: t('type_house') }, { key: 'POWER', icon: '⚡', label: t('type_power') },
    { key: 'WATER', icon: '💧', label: t('type_water') }, { key: 'SCHOOL', icon: '🏫', label: 'School' },
    { key: 'TELECOM', icon: '📡', label: 'Telecom' }, { key: 'GOVERNMENT', icon: '🏛', label: 'Gov. Building' },
    { key: 'OTHER', icon: '❓', label: t('type_other') },
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
    { key: 'EARTHQUAKE',         icon: '🏚', label: 'Earthquake' },
    { key: 'FLOOD',              icon: '🌊', label: 'Flood' },
    { key: 'TSUNAMI',            icon: '🌊', label: 'Tsunami' },
    { key: 'CYCLONE',            icon: '🌪', label: 'Cyclone' },
    { key: 'LANDSLIDE',          icon: '🏔', label: 'Landslide' },
    { key: 'EXPLOSION',          icon: '💥', label: 'Explosion' },
    { key: 'CHEMICAL_INCIDENT',  icon: '☣️', label: 'Chemical' },
    { key: 'PANDEMIC',           icon: '🦠', label: 'Pandemic' },
    { key: 'CONFLICT',           icon: '⚔️', label: 'Conflict' },
    { key: 'CIVIL_UNREST',       icon: '🪧', label: 'Civil Unrest' },
    { key: 'OTHER',              icon: '❓', label: 'Other' },
  ];
  // UNDP Appendix-1 damage labels: "Minimal/No damage", "Partially damaged",
  // "Completely damaged". The canonical stored value is MINIMAL — the
  // backend normalises any legacy NO_DAMAGE payload on write.
  const damageOptions = [
    { key: 'MINIMAL',  icon: '✅', label: 'Minimal',  color: '#22c55e' },
    { key: 'PARTIAL',  icon: '⚠️', label: 'Partial',  color: '#f97316' },
    { key: 'COMPLETE', icon: '❌', label: 'Destroyed', color: '#ef4444' },
  ];

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
    <SafeAreaView style={s.container}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.bg} />

      {/* Phase 4 (Apr 2026) — Auto-submit timer banner, visible only during
           the capture flow (photo / audio / review / confirm) when the user's
           GPS is inside an enabled region. Tapping Cancel clears the
           activeRegion so the banner disappears and manual submit resumes. */}
      {activeRegion && (screen === 'photo' || screen === 'audio' ||
        screen === 'review_details' || screen === 'review_confirm') && (
        <AutoSubmitTimer
          region={activeRegion}
          onCancel={() => {
            setActiveRegion(null);
            setIsAutoSubmit(false);
          }}
          onFire={() => {
            // Guard: must have at least one piece of content to submit.
            if (!photoUri && !audioUri && !description?.trim()) {
              Alert.alert('Cannot auto-submit', 'Please add a photo, audio, or description before the timer expires.');
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
        <ScrollView style={{ flex: 1, backgroundColor: Colors.bg }} contentContainerStyle={{ padding: 24, paddingBottom: 40, alignItems: 'center' }}>
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
                <Text style={{ fontSize: 10, color: '#86efac', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4, textAlign: 'center' }}>
                  {t('home_metric_lives')}
                </Text>
              </View>
              <View style={{ width: 1, height: 36, backgroundColor: 'rgba(167,139,250,0.3)' }} />
              <View style={{ flex: 1, alignItems: 'center' }}>
                <Text style={{ fontSize: 28, fontWeight: '900', color: '#a78bfa', lineHeight: 32 }}>
                  {impactStats.resolvedCount}
                </Text>
                <Text style={{ fontSize: 10, color: '#c4b5fd', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4, textAlign: 'center' }}>
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
            setScreen('photo');
          }}>
            <Text style={s.bigBtnText}>{t('welcome_start')}</Text>
          </TouchableOpacity>

          {/* My Reports — single entry point for history + delete-all. */}
          <TouchableOpacity style={{ backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, paddingVertical: 14, borderRadius: 12, marginTop: 12, width: '100%', alignItems: 'center', flexDirection: 'row', justifyContent: 'center', gap: 8 }}
            onPress={() => { refreshHistory(); pollStatus(); setScreen('history'); }}>
            <Text style={{ color: Colors.text, fontSize: 15, fontWeight: '600' }}>📋 {t('my_reports')}</Text>
          </TouchableOpacity>

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

      {screen === 'photo' && (
        <View style={s.screen}>
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
                <TouchableOpacity
                  onPress={pickExtraImage}
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
            <TouchableOpacity onPress={() => setScreen('home')}><Text style={s.backText}>{t('back')}</Text></TouchableOpacity>
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
        <ScrollView style={{ flex: 1, backgroundColor: Colors.bg }} contentContainerStyle={{ padding: 24, paddingBottom: 48 }}>
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

          <TouchableOpacity style={[s.micBtn, isRecording && { backgroundColor: Colors.red }]}
            onPress={isRecording ? stopRecording : startRecording}>
            <Text style={{ fontSize: 40 }}>{isRecording ? '⏹' : '🎤'}</Text>
            <Text style={{ color: Colors.white, fontSize: 12, fontWeight: '600', marginTop: 4 }}>
              {isRecording ? t('stop') : t('tap_mic')}
            </Text>
          </TouchableOpacity>
          <Text style={{ color: '#9ca3af', fontSize: 12, textAlign: 'center', marginTop: 4, marginBottom: 8 }}>
            {t('audio_mic_lang')}
          </Text>

          {audioUri && <Text style={{ color: Colors.green, fontSize: 12, marginBottom: 8 }}>{t('audio_recorded')}</Text>}
          <TextInput style={s.textInput} placeholder={t('audio_placeholder')} placeholderTextColor={Colors.textDim} value={description} onChangeText={setDescription} multiline numberOfLines={4} returnKeyType="done" blurOnSubmit={true} onSubmitEditing={Keyboard.dismiss} />
          <View style={s.navRow}>
            <TouchableOpacity onPress={() => setScreen('photo')}><Text style={s.backText}>{t('back')}</Text></TouchableOpacity>
            <TouchableOpacity style={s.nextBtn} onPress={() => setScreen('review_details')}><Text style={s.nextBtnText}>{t('next')} →</Text></TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {/* Phase 6 — Review page 1/3: Incident (photo + description + crisis type) */}
      {/* Phase 3 (Apr 2026) — single consolidated Details screen.
           Merges the old review_incident + review_details into one
           scrollable form. Field order matches docs/PARITY.md exactly so
           the PWA and RN show the same progression top-to-bottom. */}
      {screen === 'review_details' && (
        <ScrollView style={{ flex: 1, backgroundColor: Colors.bg }} contentContainerStyle={{ padding: 24 }}>
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

          {/* 5b. Inline severity picker — visible under the damaged-infra grid.
                 Default PARTIAL preserved so submitters who skip produce a
                 valid payload. Same-chip tap on the infra row collapses this. */}
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

          {/* 4. What caused damage? (PR 6: renamed from "Type of Crisis") */}
          <Text style={s.label}>{t('crisis_label')}</Text>
          <View style={s.chipRow}>{crisisTypes.map(ct => <TouchableOpacity key={ct.key} style={[s.chip, crisisType === ct.key && s.chipActive]} onPress={() => setCrisisType(ct.key)}><Text style={s.chipText}>{ct.icon} {ct.label}</Text></TouchableOpacity>)}</View>

          {/* PR 6 (Apr 2026): "Damage Level" standalone, "Building/Road Name"
               input, and "Needs debris clearing" toggle all removed. Damage
               merged into the infra chip row above (5b); the name/debris
               fields were near-universally skipped and bloated the form.
               state.infraName / state.debrisClearing keep their defaults so
               the backend payload (infrastructure_name, debris_clearing_needed)
               remains unchanged. */}

          {/* 9. Service status — Phase 3 parity fix: enum now
               OPERATIONAL/DISRUPTED/DESTROYED/UNKNOWN (matches backend
               + PWA + docs/PARITY.md). Was NORMAL/DEGRADED/DOWN before. */}
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
                    const shortLabel = lvl === 'UNKNOWN' ? 'Unknown'
                      : lvl === 'OPERATIONAL' ? 'Working'
                      : lvl === 'DISRUPTED' ? 'Disrupted' : 'Destroyed';
                    return (
                      <TouchableOpacity key={lvl} style={[s.chip, val === lvl && s.chipActive, { paddingVertical: 4, paddingHorizontal: 8, marginRight: 4, marginBottom: 4 }]} onPress={() => set(lvl)}>
                        <Text style={[s.chipText, { fontSize: 11 }]}>{shortLabel}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            );
          })}

          {/* 10. Pressing needs — Phase 3 parity fix: lowercase values
               (PWA + backend JSON convention). Label remains capitalised. */}
          <Text style={[s.label, { marginTop: 8 }]}>{t('needs_label')}</Text>
          <View style={s.chipRow}>
            {[
              { k: 'food',     label: 'Food',     icon: '🍱' },
              { k: 'water',    label: 'Water',    icon: '🚰' },
              { k: 'shelter',  label: 'Shelter',  icon: '🏠' },
              { k: 'medical',  label: 'Medical',  icon: '⚕️' },
              { k: 'security', label: 'Security', icon: '🛡' },
            ].map(n => (
              <TouchableOpacity key={n.k} style={[s.chip, pressingNeeds.includes(n.k) && s.chipActive]} onPress={() => togglePressingNeed(n.k)}>
                <Text style={s.chipText}>{n.icon} {n.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* 11. Severity */}
          <Text style={s.label}>{t('severity_label')}</Text>
          <View style={s.chipRow}>{sevs.map(sv => <TouchableOpacity key={sv.key} style={[s.chip, severity === sv.key && s.chipActive]} onPress={() => setSeverity(sv.key)}><Text style={s.chipText}>{sv.icon} {sv.label}</Text></TouchableOpacity>)}</View>

          {/* 12. Location (from GPS; user-editable on a separate location flow) */}
          {locationName ? <Text style={{ color: Colors.textDim, marginTop: 8, fontSize: 12 }}>📍 {locationName}</Text> : null}

          <View style={s.navRow}>
            <TouchableOpacity onPress={() => setScreen('audio')}><Text style={s.backText}>{t('back')}</Text></TouchableOpacity>
            <TouchableOpacity style={s.nextBtn} onPress={() => setScreen('review_confirm')}><Text style={s.nextBtnText}>{t('next')} →</Text></TouchableOpacity>
          </View>
        </ScrollView>
      )}

      {/* Phase 3 (Apr 2026) — Confirm (summary + edit + Submit). Both Edit
           links point to review_details now since that's the single editable
           screen after the 3-page → 2-page collapse. */}
      {screen === 'review_confirm' && (
        <ScrollView style={{ flex: 1, backgroundColor: Colors.bg }} contentContainerStyle={{ padding: 24 }}>
          <FlowProgress step={4} have={{ photo: !!photoUri, details: !!(audioUri || description?.trim()) }} />
          <Text style={s.title}>{t('confirm_title')}</Text>

          <View style={s.summaryCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <Text style={[s.summaryRow, { fontWeight: '700' }]}>{t('incident_title')}</Text>
              <TouchableOpacity onPress={() => setScreen('review_details')}><Text style={{ color: Colors.accent }}>{t('edit')}</Text></TouchableOpacity>
            </View>
            <Text style={s.summaryRow}>🌪 {crisisType.replace(/_/g, ' ')}  📸 {photoUri ? '✅' : '❌'} + {extraPhotos.length} extra  🎤 {audioUri ? '✅' : '❌'}</Text>
            {description ? <Text style={s.summaryDesc} numberOfLines={3}>📝 {description}</Text> : null}
            {locationName ? <Text style={s.summaryRow}>📍 {locationName}</Text> : null}
          </View>

          <View style={s.summaryCard}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <Text style={[s.summaryRow, { fontWeight: '700' }]}>{t('details_title')}</Text>
              <TouchableOpacity onPress={() => setScreen('review_details')}><Text style={{ color: Colors.accent }}>{t('edit')}</Text></TouchableOpacity>
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
          <TouchableOpacity onPress={() => setScreen('review_details')}><Text style={s.backText}>{t('back')}</Text></TouchableOpacity>
        </ScrollView>
      )}

      {screen === 'success' && (
        <View style={s.screen}>
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
        <ScrollView style={{ flex: 1, backgroundColor: Colors.bg }} contentContainerStyle={{ padding: 20 }}>
          {/* Beefier Back button so it's impossible to miss / mistap. */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <TouchableOpacity
              onPress={() => setScreen('home')}
              style={{ backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 }}>
              <Text style={{ color: Colors.text, fontSize: 14, fontWeight: '700' }}>← Back</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => { pollStatus(); refreshHistory(); }}
              style={{ backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 10 }}>
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
                    <Text style={{ color: Colors.textDim, fontSize: 11, marginTop: 3 }}>
                      📸 {hasPhoto ? `${photoPct}%` : '—'}  🎤 {hasAudio ? `${audioPct}%` : '—'}  {p.retry_count ? `(retry ${p.retry_count})` : ''}
                    </Text>
                    {p.text_description ? <Text style={{ color: Colors.textDim, fontSize: 11, marginTop: 2 }} numberOfLines={1}>{p.text_description}</Text> : null}
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
                            Alert.alert('Delete queued report?',
                              'This will permanently remove it from the device. Your photo and audio will be lost.',
                              [
                                { text: 'Cancel', style: 'cancel' },
                                { text: 'Delete', style: 'destructive', onPress: async () => {
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
                        <Text style={{ color: st.color, fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                          {st.icon} {st.label}
                        </Text>
                      </View>
                    </View>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
                      {!!placeName && (
                        <Text style={{ color: Colors.textDim, fontSize: 11 }} numberOfLines={1}>📍 {placeName}</Text>
                      )}
                      {!!dateText && (
                        <Text style={{ color: Colors.textDim, fontSize: 11 }}>🕒 {dateText}</Text>
                      )}
                      {h.lives_impacted > 0 && (
                        <Text style={{ color: Colors.green, fontSize: 11, fontWeight: '600' }}>💚 {h.lives_impacted} lives</Text>
                      )}
                    </View>
                    {queued && (
                      <Text style={{ color: '#fbbf24', fontSize: 10, marginTop: 4 }}>🕒 Will be deleted when connected</Text>
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
                        { text: 'Cancel', style: 'cancel' },
                        { text: 'Delete All', style: 'destructive', onPress: async () => {
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
                <Text style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', marginTop: 8, lineHeight: 16 }}>
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
          <ScrollView style={{ flex: 1, backgroundColor: Colors.bg }} contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
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
                      fontSize: 10, fontWeight: '600',
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
                <Text style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                  Description
                </Text>
                <Text style={{ color: Colors.text, fontSize: 14, lineHeight: 20 }}>{r.description}</Text>
              </View>
            )}

            {/* Metadata */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
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
                    <Text style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.4 }}>
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
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete', style: 'destructive', onPress: async () => {
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
    </SafeAreaView>
    </TouchableWithoutFeedback>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
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
  navRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%', marginTop: 16 },
  backText: { color: Colors.textDim, fontSize: 15, fontWeight: '500', padding: 8 },
  nextBtn: { backgroundColor: Colors.accent, paddingVertical: 10, paddingHorizontal: 24, borderRadius: 10 },
  nextBtnText: { color: Colors.white, fontSize: 15, fontWeight: '700' },
  micBtn: { width: 160, height: 160, borderRadius: 80, backgroundColor: Colors.accent, justifyContent: 'center', alignItems: 'center', marginBottom: 24, elevation: 10 },
  textInput: { width: '100%', backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: 12, padding: 14, color: Colors.text, fontSize: 15, textAlignVertical: 'top', marginBottom: 16 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  chip: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 12, backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: Colors.border, alignItems: 'center' },
  chipActive: { borderColor: Colors.accent, backgroundColor: 'rgba(124,58,237,0.12)' },
  chipText: { color: Colors.text, fontSize: 14, fontWeight: '600' },
  summaryCard: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, borderRadius: 14, padding: 18, width: '100%', marginBottom: 16 },
  summaryRow: { color: Colors.text, fontSize: 14, marginBottom: 6 },
  summaryDesc: { color: Colors.textDim, fontSize: 13, fontStyle: 'italic', marginTop: 4 },
  queueBadge: { backgroundColor: 'rgba(245,158,11,0.1)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.25)', borderRadius: 8, padding: 8, marginTop: 16 },
  queueText: { color: '#f59e0b', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  offlineText: { color: Colors.textDim, fontSize: 12, marginTop: 8, textAlign: 'center' },
});
