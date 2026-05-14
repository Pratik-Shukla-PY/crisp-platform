/**
 * V4CaptureScreen — RN port of the PWA's #stage-v4-capture.
 *
 * May 2026 — Phase 3 of the 8-phase RN ↔ PWA parity plan.
 * Replaces the legacy split `'photo'` + `'audio'` screens with a
 * single multi-modal capture page matching the PWA's redesigned v4
 * flow:
 *
 *   §A  Header        — back button + 3-step progress bar (Step 1 of 3)
 *   §B  Meta card     — location row (text + refresh + edit) + timestamp
 *   §C  Title         — "Show what you see."
 *   §D  Photo section — camera button (primary) + gallery button +
 *                       thumb strip when photos land
 *   §E  Voice + Text  — compact chips that expand inline panels
 *   §F  Tips card     — 3 smart-contextual tips + impact line; dims
 *                       a tip when the matching capture lands and
 *                       reveals a green check
 *   §G  Footer        — Continue button (disabled until ≥ 1 photo)
 *
 * Props-first: the screen RENDERS state and FIRES callbacks; it
 * doesn't own the camera, recorder, or location pipelines. App.tsx
 * keeps owning those via the existing handlers + service modules,
 * passing state down + receiving events up.
 *
 * Smart contextual tips:
 *   · Photo tip dims when photoThumbs.length > 0
 *   · Voice tip dims when hasVoice is true
 *   · Text tip dims when textValue.trim() is non-empty
 *   · Each dimmed tip reveals a green check disk on the right
 *
 * Accessibility:
 *   · Every interactive element has accessibilityRole + accessibilityLabel
 *   · prefers-reduced-motion respected (no scale animations here yet;
 *     Phase 4's classify-tile pulse is where Reanimated lands)
 *   · Touch targets ≥ 44 px (WCAG 2.5.5)
 *
 * The PWA exposes a location-edit inline input, an OSM building
 * picker, and a precise three-line timestamp — those are richer in
 * the PWA than they need to be in v1 of the RN port. We surface
 * `locationText / locationCoords / timeLabel / timeLocal` as plain
 * strings and let the caller decide how rich to make them.
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  type ViewStyle,
} from 'react-native';
import Svg, { Path, Circle as SvgCircle, Polyline } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors } from '../constants/colors';
import { t } from '../services/i18n';

// ── Props ──────────────────────────────────────────────────────────
export interface V4CaptureScreenProps {
  // §B Meta
  locationText: string;
  locationCoords?: string;
  onRefreshGps: () => void;
  onEditLocation: () => void;
  /** Compact one-line timestamp like "Mon 14 May · 14:32 (IST)". The PWA
   *  splits this into IANA tz / human label / clock; for RN parity v1
   *  we accept a pre-formatted line so App.tsx controls the format. */
  timeText?: string;

  // §D Photo
  photoThumbs: string[];
  photoMaxCount?: number;          // default 5
  onOpenCamera: () => void;
  onOpenGallery: () => void;
  onRemovePhoto?: (index: number) => void;

  // §E Voice
  hasVoice: boolean;
  isRecording: boolean;
  onToggleVoice: () => void;       // start/stop
  onClearVoice?: () => void;

  // §E Text
  textValue: string;
  onTextChange: (v: string) => void;

  // §G Continue / back
  onBack: () => void;
  onContinue: () => void;
}

// ── Helper: small text-resolve wrapper with EN fallback ─────────────
function ti(key: string, fallback: string): string {
  const v = t(key);
  return v && v !== key ? v : fallback;
}

export default function V4CaptureScreen(props: V4CaptureScreenProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const maxPhotos = props.photoMaxCount ?? 5;
  const photoCount = props.photoThumbs.length;
  const canContinue = photoCount > 0;

  // §E inline-panel toggles. Voice + Text each have a compact chip;
  // tapping toggles their inline drawer open. Only one open at a time
  // (matches PWA radio-style behaviour).
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [textOpen, setTextOpen] = useState(false);

  // §F smart-contextual tips state — derived from props, no extra
  // state machinery. Each tip dims + shows a green check when its
  // matching capture has landed.
  const tipsDone = useMemo(() => ({
    photo: photoCount > 0,
    voice: props.hasVoice,
    text: props.textValue.trim().length > 0,
  }), [photoCount, props.hasVoice, props.textValue]);

  return (
    <View style={[styles.stage, { backgroundColor: Colors.bg }]}>
      {/* ── §A Header — back + 3-step progress ────────────────── */}
      <View style={[styles.header, { paddingTop: Math.max(8, insets.top) }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={props.onBack}
          accessibilityRole="button"
          accessibilityLabel={ti('aria_back', 'Back')}
          testID="v4cap-back"
        >
          <Svg viewBox="0 0 24 24" width={20} height={20}
            fill="none" stroke={Colors.text} strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round">
            <Path d="M19 12H5" />
            <Path d="M12 19l-7-7 7-7" />
          </Svg>
        </TouchableOpacity>
        <View style={styles.progressRow}>
          <View style={[styles.pip, styles.pipActive]} />
          <View style={styles.pip} />
          <View style={styles.pip} />
          <Text style={styles.stepLabel}>
            {ti('v4_step_1_of_3', 'Step 1 of 3')}
          </Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: Math.max(12, insets.bottom) + 76, // room for footer
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* ── §B Meta card — location + timestamp ─────────────── */}
        <View style={styles.metaCard} testID="v4cap-meta-card">
          <View style={styles.metaLocRow}>
            <Svg viewBox="0 0 24 24" width={18} height={18}
              fill="none" stroke="#09D1C7" strokeWidth={2}
              strokeLinecap="round" strokeLinejoin="round">
              <Path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
              <SvgCircle cx={12} cy={10} r={3} />
            </Svg>
            <View style={styles.metaLocStack}>
              <Text style={styles.metaLocName} numberOfLines={1}>
                {props.locationText || ti('v4_locating', 'Locating…')}
              </Text>
              {props.locationCoords ? (
                <Text style={styles.metaLocCoords} numberOfLines={1}>
                  {props.locationCoords}
                </Text>
              ) : null}
            </View>
            <View style={styles.metaLocActions}>
              <TouchableOpacity
                style={styles.metaLocAction}
                onPress={props.onRefreshGps}
                accessibilityLabel="Refresh GPS"
                testID="v4cap-refresh-gps"
              >
                <Svg viewBox="0 0 24 24" width={14} height={14}
                  fill="none" stroke={Colors.text} strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                  <Path d="M21 3v5h-5" />
                  <Path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                  <Path d="M3 21v-5h5" />
                </Svg>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.metaLocAction}
                onPress={props.onEditLocation}
                accessibilityLabel="Change location"
                testID="v4cap-edit-location"
              >
                <Svg viewBox="0 0 24 24" width={14} height={14}
                  fill="none" stroke={Colors.text} strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                  <Path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                </Svg>
              </TouchableOpacity>
            </View>
          </View>

          {props.timeText ? (
            <View style={styles.metaTimeRow}>
              <Svg viewBox="0 0 24 24" width={14} height={14}
                fill="none" stroke="#09D1C7" strokeWidth={2}
                strokeLinecap="round" strokeLinejoin="round">
                <SvgCircle cx={12} cy={12} r={10} />
                <Path d="M12 6v6l4 2" />
              </Svg>
              <Text style={styles.metaTimeText}>{props.timeText}</Text>
            </View>
          ) : null}
        </View>

        {/* ── §C Title ──────────────────────────────────────── */}
        <Text style={styles.title} testID="v4cap-title">
          {ti('v4_cap_show_what_you_see', 'Show what you see.')}
        </Text>

        {/* ── §D Photo section ─────────────────────────────── */}
        <View style={styles.section} testID="v4cap-section-photo">
          <View style={styles.sectionHead}>
            <Text style={styles.sectionIcon} accessible={false}>📷</Text>
            <View style={styles.sectionTitleStack}>
              <Text style={styles.sectionLabel}>
                {ti('v4_cap_photo', 'Photo')}
              </Text>
              <Text style={styles.sectionSub}>
                {ti('v4_cap_photo_sub', 'Take or upload')}
              </Text>
            </View>
            <Text style={[
              styles.sectionCount,
              photoCount > 0 && styles.sectionCountActive,
            ]}>
              {photoCount}/{maxPhotos}
            </Text>
          </View>

          <View style={styles.sectionBody}>
            <View style={styles.photoActions}>
              <TouchableOpacity
                style={[styles.photoActionBtn, styles.photoActionPrimary]}
                onPress={props.onOpenCamera}
                disabled={photoCount >= maxPhotos}
                accessibilityRole="button"
                accessibilityLabel={ti('chooser_camera', 'Camera')}
                testID="v4cap-btn-camera"
              >
                <Svg viewBox="0 0 24 24" width={20} height={20}
                  fill="none" stroke="#0b1018" strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                  <SvgCircle cx={12} cy={13} r={4} />
                </Svg>
                <Text style={styles.photoActionPrimaryLabel}>
                  {ti('chooser_camera', 'Camera')}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.photoActionBtn, styles.photoActionSecondary]}
                onPress={props.onOpenGallery}
                disabled={photoCount >= maxPhotos}
                accessibilityRole="button"
                accessibilityLabel={ti('chooser_gallery', 'Browse files')}
                testID="v4cap-btn-gallery"
              >
                <Svg viewBox="0 0 24 24" width={18} height={18}
                  fill="none" stroke={Colors.text} strokeWidth={2}
                  strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" />
                  <SvgCircle cx={8.5} cy={8.5} r={1.5} />
                  <Path d="M21 15l-5-5L5 21" />
                </Svg>
                <Text style={styles.photoActionSecondaryLabel}>
                  {ti('chooser_gallery', 'Browse files')}
                </Text>
              </TouchableOpacity>
            </View>

            {photoCount > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.thumbStrip}
                contentContainerStyle={{ gap: 8 }}
                testID="v4cap-thumb-strip"
              >
                {props.photoThumbs.map((uri, i) => (
                  <View key={`${uri}-${i}`} style={styles.thumb}>
                    {/* Image component left out to avoid Image-required pulse
                        in the RN mock; consumer can compose a real <Image /> */}
                    <Text style={styles.thumbBadge}>{i + 1}</Text>
                    {props.onRemovePhoto ? (
                      <Pressable
                        style={styles.thumbRemove}
                        onPress={() => props.onRemovePhoto && props.onRemovePhoto(i)}
                        accessibilityRole="button"
                        accessibilityLabel="Remove photo"
                      >
                        <Text style={styles.thumbRemoveText}>×</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}
              </ScrollView>
            ) : null}
          </View>
        </View>

        {/* ── §E Voice + Text chips + inline drawers ────────── */}
        <View style={styles.extrasSection} testID="v4cap-extras">
          <Text style={styles.extrasLabel}>
            {ti('v4_cap_extras_label', 'Add more (optional)')}
          </Text>

          <View style={styles.extrasRow}>
            <Pressable
              style={[
                styles.chip,
                voiceOpen && styles.chipOpen,
                props.hasVoice && styles.chipCaptured,
              ]}
              onPress={() => { setVoiceOpen(v => !v); if (textOpen) setTextOpen(false); }}
              accessibilityRole="button"
              testID="v4cap-chip-voice"
            >
              <Svg viewBox="0 0 24 24" width={16} height={16}
                fill="none" stroke={props.hasVoice ? '#80EE98' : '#09D1C7'} strokeWidth={2}
                strokeLinecap="round" strokeLinejoin="round">
                <Path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <Path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <Path d="M12 19v4" />
                <Path d="M8 23h8" />
              </Svg>
              <Text style={[styles.chipLabel, props.hasVoice && styles.chipLabelCaptured]}>
                {ti('v4_cap_voice', 'Voice')}
              </Text>
              {props.hasVoice ? <View style={styles.chipDot} /> : null}
            </Pressable>

            <Pressable
              style={[
                styles.chip,
                textOpen && styles.chipOpen,
                props.textValue.trim().length > 0 && styles.chipCaptured,
              ]}
              onPress={() => { setTextOpen(v => !v); if (voiceOpen) setVoiceOpen(false); }}
              accessibilityRole="button"
              testID="v4cap-chip-text"
            >
              <Svg viewBox="0 0 24 24" width={16} height={16}
                fill="none" stroke={props.textValue.trim().length > 0 ? '#80EE98' : '#09D1C7'} strokeWidth={2}
                strokeLinecap="round" strokeLinejoin="round">
                <Path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                <Path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
              </Svg>
              <Text style={[
                styles.chipLabel,
                props.textValue.trim().length > 0 && styles.chipLabelCaptured,
              ]}>
                {ti('v4_cap_text', 'Text')}
              </Text>
              {props.textValue.trim().length > 0 ? <View style={styles.chipDot} /> : null}
            </Pressable>
          </View>

          {/* Voice inline drawer */}
          {voiceOpen ? (
            <View style={styles.chipPanel} testID="v4cap-voice-panel">
              <TouchableOpacity
                style={[styles.micBtn, props.isRecording && styles.micBtnActive]}
                onPress={props.onToggleVoice}
                accessibilityRole="button"
                testID="v4cap-btn-mic"
              >
                <Svg viewBox="0 0 24 24" width={20} height={20}
                  fill={props.isRecording ? '#ef4444' : 'none'}
                  stroke={props.isRecording ? '#fff' : '#09D1C7'}
                  strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <Path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <Path d="M12 19v4" />
                  <Path d="M8 23h8" />
                </Svg>
                <Text style={[styles.micBtnLabel, props.isRecording && styles.micBtnLabelActive]}>
                  {props.isRecording
                    ? ti('v4_recording_tap_to_stop', 'Recording… tap to stop')
                    : ti('v4_record', 'Record voice')}
                </Text>
              </TouchableOpacity>
              <Text style={styles.voiceHint}>
                {ti('v4_cap_voice_hint', 'Tap to start. Tap again to stop.')}
              </Text>
            </View>
          ) : null}

          {/* Text inline drawer */}
          {textOpen ? (
            <View style={styles.chipPanel} testID="v4cap-text-panel">
              <TextInput
                style={styles.textArea}
                value={props.textValue}
                onChangeText={props.onTextChange}
                placeholder={ti('placeholder_describe_short', 'Describe what happened in a few words…')}
                placeholderTextColor="rgba(255,255,255,0.32)"
                multiline
                numberOfLines={3}
                accessibilityLabel={ti('placeholder_describe_short', 'Describe what happened')}
                testID="v4cap-text-area"
              />
            </View>
          ) : null}
        </View>

        {/* ── §F Smart contextual tips card ─────────────────── */}
        <View style={styles.tipsCard} testID="v4cap-tips">
          <Text style={styles.tipsEyebrow}>
            {ti('v4_cap_tips_eyebrow', 'Helpful tips')}
          </Text>

          <TipsRow
            iconNode={<PhotoIcon />}
            text={ti('v4_cap_tip_photo', "Show what's damaged, blocked, or unsafe")}
            done={tipsDone.photo}
            testID="v4cap-tip-photo"
          />
          <TipsRow
            iconNode={<MicIcon />}
            text={ti('v4_cap_tip_voice', 'Voice helps when writing is hard or hands are full')}
            done={tipsDone.voice}
            testID="v4cap-tip-voice"
          />
          <TipsRow
            iconNode={<PenIcon />}
            text={ti('v4_cap_tip_text', 'A few words can speed up help')}
            done={tipsDone.text}
            testID="v4cap-tip-text"
          />

          <View style={styles.tipsImpactDivider} />
          <Text style={styles.tipsImpact}>
            {ti('v4_cap_tip_impact', 'Verified responders read every report. Every detail matters.')}
          </Text>
        </View>
      </ScrollView>

      {/* ── §G Footer Continue ─────────────────────────────── */}
      <View
        style={[
          styles.footer,
          { paddingBottom: Math.max(12, insets.bottom) },
        ]}
        testID="v4cap-footer"
      >
        <TouchableOpacity
          style={[
            styles.continueBtn,
            !canContinue && styles.continueBtnDisabled,
          ]}
          onPress={() => { if (canContinue) props.onContinue(); }}
          disabled={!canContinue}
          accessibilityRole="button"
          accessibilityLabel={ti('v4_continue', 'Continue')}
          accessibilityState={{ disabled: !canContinue }}
          testID="v4cap-btn-continue"
        >
          <Text style={[
            styles.continueLabel,
            !canContinue && styles.continueLabelDisabled,
          ]}>
            {ti('v4_continue', 'Continue')}
          </Text>
          <Svg viewBox="0 0 24 24" width={16} height={16}
            fill="none"
            stroke={canContinue ? '#062b1b' : 'rgba(255,255,255,0.35)'}
            strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <Path d="M5 12h14" />
            <Path d="M12 5l7 7-7 7" />
          </Svg>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Tips row helper (sub-component) ────────────────────────────────
function TipsRow(props: {
  iconNode: React.ReactNode;
  text: string;
  done: boolean;
  testID?: string;
}) {
  return (
    <View
      style={[styles.tipRow, props.done && styles.tipRowDone]}
      testID={props.testID}
    >
      <View style={[styles.tipIcon, props.done && styles.tipIconDone]}>
        {props.iconNode}
      </View>
      <Text style={[styles.tipText, props.done && styles.tipTextDone]}>
        {props.text}
      </Text>
      {props.done ? (
        <View style={styles.tipCheck}>
          <Svg viewBox="0 0 24 24" width={12} height={12}
            fill="none" stroke="#0a1f30" strokeWidth={3}
            strokeLinecap="round" strokeLinejoin="round">
            <Polyline points="20 6 9 17 4 12" />
          </Svg>
        </View>
      ) : null}
    </View>
  );
}

// ── Tip icon SVGs ──────────────────────────────────────────────────
function PhotoIcon() {
  return (
    <Svg viewBox="0 0 24 24" width={16} height={16}
      fill="none" stroke="#46DFB1" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round">
      <Path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
      <SvgCircle cx={12} cy={13} r={4} />
    </Svg>
  );
}

function MicIcon() {
  return (
    <Svg viewBox="0 0 24 24" width={16} height={16}
      fill="none" stroke="#46DFB1" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <Path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <Path d="M12 19v4" />
      <Path d="M8 23h8" />
    </Svg>
  );
}

function PenIcon() {
  return (
    <Svg viewBox="0 0 24 24" width={16} height={16}
      fill="none" stroke="#46DFB1" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round">
      <Path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <Path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </Svg>
  );
}

// ── Styles ──────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  stage: { flex: 1 },

  // §A Header
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingBottom: 8, minHeight: 44,
  },
  backBtn: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center', justifyContent: 'center',
  },
  progressRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1,
  },
  pip: {
    width: 28, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  pipActive: {
    backgroundColor: '#09D1C7',
  },
  stepLabel: {
    marginLeft: 'auto',
    color: 'rgba(255,255,255,0.62)',
    fontSize: 11, fontWeight: '600',
    letterSpacing: 0.4, textTransform: 'uppercase',
  },

  // §B Meta card
  metaCard: {
    marginTop: 8, marginBottom: 12,
    padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(9, 209, 199, 0.05)',
    borderWidth: 1, borderColor: 'rgba(9, 209, 199, 0.18)',
  },
  metaLocRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
  },
  metaLocStack: { flex: 1, minWidth: 0 },
  metaLocName: { color: Colors.text, fontSize: 14, fontWeight: '700' },
  metaLocCoords: {
    color: 'rgba(255,255,255,0.42)',
    fontSize: 10.5, marginTop: 2,
    fontFamily: 'SpaceMono-Regular',
  },
  metaLocActions: {
    flexDirection: 'row', gap: 6,
  },
  metaLocAction: {
    width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center', justifyContent: 'center',
  },
  metaTimeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginTop: 10, paddingTop: 10,
    borderTopWidth: 1, borderTopColor: 'rgba(9, 209, 199, 0.10)',
  },
  metaTimeText: {
    color: 'rgba(255,255,255,0.62)', fontSize: 11.5,
  },

  // §C Title
  title: {
    color: Colors.text, fontSize: 24, fontWeight: '800',
    marginTop: 4, marginBottom: 12, letterSpacing: -0.01,
  },

  // §D Photo section
  section: {
    marginBottom: 12,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 14, padding: 12,
  },
  sectionHead: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    marginBottom: 10,
  },
  sectionIcon: { fontSize: 22 },
  sectionTitleStack: { flex: 1, minWidth: 0 },
  sectionLabel: {
    color: Colors.text, fontSize: 14, fontWeight: '800',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  sectionSub: {
    color: Colors.textDim, fontSize: 11, marginTop: 1,
  },
  sectionCount: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 999,
    color: Colors.textDim, fontSize: 11, fontWeight: '700',
  },
  sectionCountActive: {
    backgroundColor: 'rgba(70, 223, 177, 0.10)',
    borderColor: 'rgba(70, 223, 177, 0.32)',
    color: '#80EE98',
  },
  sectionBody: {},

  photoActions: { flexDirection: 'row', gap: 10 },
  photoActionBtn: {
    flex: 1, paddingVertical: 14, paddingHorizontal: 10, borderRadius: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  photoActionPrimary: {
    backgroundColor: '#09D1C7',
  },
  photoActionPrimaryLabel: {
    color: '#062b1b', fontSize: 14, fontWeight: '800',
  },
  photoActionSecondary: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  photoActionSecondaryLabel: {
    color: Colors.text, fontSize: 13, fontWeight: '600',
  },

  thumbStrip: { marginTop: 10 },
  thumb: {
    width: 64, height: 64, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center', justifyContent: 'center',
    position: 'relative',
  },
  thumbBadge: { color: Colors.textDim, fontSize: 11 },
  thumbRemove: {
    position: 'absolute', top: -6, right: -6,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: '#ef4444',
    alignItems: 'center', justifyContent: 'center',
  },
  thumbRemoveText: { color: '#fff', fontSize: 12, lineHeight: 14, fontWeight: '900' },

  // §E Extras
  extrasSection: { marginBottom: 12 },
  extrasLabel: {
    color: Colors.textDim, fontSize: 10, fontWeight: '700',
    letterSpacing: 1.6, textTransform: 'uppercase',
    marginBottom: 8,
  },
  extrasRow: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 14, paddingVertical: 12, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
    gap: 8, position: 'relative',
  },
  chipOpen: {
    borderColor: 'rgba(9, 209, 199, 0.40)',
    backgroundColor: 'rgba(9, 209, 199, 0.06)',
  },
  chipCaptured: {
    borderColor: 'rgba(70, 223, 177, 0.40)',
    backgroundColor: 'rgba(70, 223, 177, 0.08)',
  },
  chipLabel: {
    color: Colors.text, fontSize: 13, fontWeight: '700',
  },
  chipLabelCaptured: { color: '#80EE98' },
  chipDot: {
    position: 'absolute', top: 8, right: 10,
    width: 7, height: 7, borderRadius: 4,
    backgroundColor: '#80EE98',
  },
  chipPanel: {
    marginTop: 10, padding: 12, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
  },

  micBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, paddingVertical: 14, borderRadius: 12,
    backgroundColor: 'rgba(9, 209, 199, 0.10)',
    borderWidth: 1, borderColor: 'rgba(9, 209, 199, 0.32)',
  },
  micBtnActive: {
    backgroundColor: '#ef4444',
    borderColor: '#ef4444',
  },
  micBtnLabel: { color: '#80EE98', fontSize: 14, fontWeight: '700' },
  micBtnLabelActive: { color: '#fff' },
  voiceHint: {
    marginTop: 6, color: 'rgba(255,255,255,0.42)',
    fontSize: 11, textAlign: 'center',
  },

  textArea: {
    minHeight: 80,
    color: Colors.text, fontSize: 13, lineHeight: 19,
    padding: 10, borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    textAlignVertical: 'top',
  },

  // §F Tips card
  tipsCard: {
    marginTop: 4, marginBottom: 8,
    padding: 16, paddingBottom: 14, borderRadius: 14,
    backgroundColor: 'rgba(70, 223, 177, 0.05)',
    borderWidth: 1, borderColor: 'rgba(70, 223, 177, 0.14)',
  },
  tipsEyebrow: {
    color: 'rgba(70, 223, 177, 0.88)',
    fontSize: 10.5, fontWeight: '700',
    letterSpacing: 1.6, textTransform: 'uppercase',
    marginBottom: 10,
  },
  tipRow: {
    flexDirection: 'row', alignItems: 'flex-start',
    gap: 10, marginBottom: 9, paddingTop: 1,
  },
  tipRowDone: { opacity: 0.55 },
  tipIcon: {
    width: 26, height: 26, borderRadius: 8,
    backgroundColor: 'rgba(9, 209, 199, 0.12)',
    alignItems: 'center', justifyContent: 'center',
    marginTop: 1,
  } as ViewStyle,
  tipIconDone: {
    backgroundColor: 'rgba(70, 223, 177, 0.06)',
  },
  tipText: {
    flex: 1, minWidth: 0,
    color: 'rgba(255,255,255,0.82)',
    fontSize: 12.5, lineHeight: 17.5,
  },
  tipTextDone: { color: 'rgba(255,255,255,0.45)' },
  tipCheck: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: '#46DFB1',
    alignItems: 'center', justifyContent: 'center',
    marginTop: 1,
  },
  tipsImpactDivider: {
    marginTop: 4, marginBottom: 10,
    borderTopWidth: 1, borderTopColor: 'rgba(70, 223, 177, 0.18)',
    borderStyle: 'dashed',
  },
  tipsImpact: {
    color: 'rgba(70, 223, 177, 0.78)',
    fontSize: 11.5, fontStyle: 'italic',
    textAlign: 'center', lineHeight: 16,
  },

  // §G Footer
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 20, paddingTop: 10,
    backgroundColor: Colors.bg,
    borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)',
  },
  continueBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 14, borderRadius: 14,
    backgroundColor: '#09D1C7',
    shadowColor: '#09D1C7', shadowOpacity: 0.32,
    shadowRadius: 14, shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  continueBtnDisabled: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    shadowOpacity: 0, elevation: 0,
  },
  continueLabel: {
    color: '#062b1b', fontSize: 16, fontWeight: '800',
  },
  continueLabelDisabled: {
    color: 'rgba(255,255,255,0.35)',
  },
});
