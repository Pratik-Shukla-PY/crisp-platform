/**
 * V4ReviewScreen — RN port of the PWA's #stage-v4-review.
 *
 * May 2026 — Phase 5 of the 8-phase RN ↔ PWA parity plan. Final
 * step (Step 3 of 3) before Send. Surfaces every captured field,
 * lets the user jump back to fix anything, and asks for the
 * UNDP-required follow-up details (debris / service status /
 * pressing needs) before submission.
 *
 *   §A Header        — back + 3-step progress (Step 3 of 3)
 *   §B Captured strip — 3 chips (Photo / Voice / Text) with status
 *   §C Summary card   — 4 tap-edit rows (Location / Infra /
 *                       Crisis / Damage) — taps fire callbacks
 *                       that route App.tsx back to the right
 *                       sub-step
 *   §D Building       — UNDP must-have #6 footprint picker mount
 *   §E Voice/text     — collapsed drawer with mic + textarea
 *   §F UNDP details   — EXPANDED by default per UNDP rubric:
 *                       Debris Y/N · Electricity · Water · Health
 *                       · Pressing needs (multi-select chips)
 *   §G Footer Send    — submits the report
 *
 * Props-first: all state values + setters flow from App.tsx. The
 * screen is RENDER-ONLY for state; behavioural logic (location
 * services, image picker, building-footprint loading, network
 * upload) stays in App.tsx via the existing handlers.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import Svg, { Path, Circle as SvgCircle, Polyline } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors } from '../constants/colors';
import { t } from '../services/i18n';

// ── ServiceLevel matches App.tsx's existing type ────────────────────
type ServiceLevel = 'OPERATIONAL' | 'DISRUPTED' | 'DESTROYED' | 'UNKNOWN';
const SERVICE_OPTIONS: { v: ServiceLevel; labelKey: string; fb: string }[] = [
  { v: 'OPERATIONAL', labelKey: 'v4_working',         fb: 'Working' },
  { v: 'DISRUPTED',   labelKey: 'v4_intermittent',    fb: 'Disrupted' },
  { v: 'DESTROYED',   labelKey: 'v4_not_op',          fb: 'Not operational' },
  { v: 'UNKNOWN',     labelKey: 'v4_unknown',         fb: 'Unknown' },
];

// ── Pressing-needs registry — EXACT mirror of the PWA's #v4-undp-sheet
//    pressing_needs chips (mobile-app/src/index.html data-value + undp_need_*
//    keys + order). Submitted values (food_water / shelter / medical / cash /
//    protection / services) match the dashboard humanizer + the canonical
//    Report row (UNDP must-have #1). Was a divergent 10-value HRP set;
//    reconciled to the PWA's 6 for V4 parity. ──────────────────────────────
const NEEDS_CHIPS = [
  { v: 'food_water', labelKey: 'undp_need_food',       fb: 'Food / water' },
  { v: 'shelter',    labelKey: 'undp_need_shelter',    fb: 'Shelter' },
  { v: 'medical',    labelKey: 'undp_need_medical',    fb: 'Medical' },
  { v: 'cash',       labelKey: 'undp_need_cash',       fb: 'Cash help' },
  { v: 'protection', labelKey: 'undp_need_protection', fb: 'Safety' },
  { v: 'services',   labelKey: 'undp_need_services',   fb: 'Services' },
];

// ── Helper ──────────────────────────────────────────────────────────
function ti(key: string, fallback: string): string {
  const v = t(key);
  return v && v !== key ? v : fallback;
}

// Pretty-prints an enum value (RESIDENTIAL → "Residential",
// CHEMICAL_INCIDENT → "Chemical incident") — used as a fallback
// when an i18n label isn't available.
function prettify(s: string): string {
  if (!s) return '—';
  return s
    .toLowerCase()
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Props ───────────────────────────────────────────────────────────
export interface V4ReviewScreenProps {
  // Captured state — surfaced as chips in the captured strip
  hasPhoto: boolean;
  hasVoice: boolean;
  hasText: boolean;

  // Summary rows. The classifier values are null until picked (RNV4-P4
  // null-first); the SummaryRow render already shows an em-dash for null.
  locationText: string;
  infraType: string | null;
  crisisType: string | null;
  damageClass: string | null;

  // Building footprint (UNDP must-have #6)
  buildingId: string | null;
  /** Render slot for the building picker. App.tsx owns the
   *  BuildingFootprintPicker component + its WebView lifecycle;
   *  pass the rendered ReactNode here and we mount it in §D. */
  buildingPickerNode?: React.ReactNode;

  // Voice/Text drawer
  audioUri: string | null;
  isRecording: boolean;
  onToggleRecording: () => void;
  descriptionValue: string;
  onChangeDescription: (v: string) => void;

  // UNDP details
  debrisClearing: boolean;
  onSetDebris: (v: boolean) => void;
  electricityStatus: ServiceLevel;
  onSetElectricity: (v: ServiceLevel) => void;
  waterStatus: ServiceLevel;
  onSetWater: (v: ServiceLevel) => void;
  healthStatus: ServiceLevel;
  onSetHealth: (v: ServiceLevel) => void;
  pressingNeeds: string[];
  onTogglePressingNeed: (v: string) => void;

  // Send state
  isSending: boolean;
  onSend: () => void;

  // Navigation
  onBack: () => void;
  onEditPhoto: () => void;
  onEditClassify: () => void;
  /** Called when user taps the summary's location row — App.tsx
   *  decides whether to open an inline editor or jump back to
   *  the location-picking surface. */
  onEditLocation: () => void;
}

export default function V4ReviewScreen(props: V4ReviewScreenProps) {
  const insets = useSafeAreaInsets();

  // §E Voice/text drawer is collapsed by default (matches PWA).
  // §F UNDP details drawer is EXPANDED by default per UNDP rubric
  // (the user wants reviewers to see the additional details by
  // default; collapsing would bury an important data dimension).
  const [voiceDrawerOpen, setVoiceDrawerOpen] = useState(false);
  const [undpDrawerOpen, setUndpDrawerOpen] = useState(true);

  // (May 2026 — Fix-R2) — measure footer height at runtime so the
  // ScrollView's bottom padding adapts to the actual rendered Send
  // button (previously hard-coded +88, broken under accessibility
  // font scaling on iOS / Android).
  const [footerHeight, setFooterHeight] = useState(88);

  return (
    // (May 2026 — Fix-R3) — KAV so the soft keyboard doesn't cover
    // the Voice/Text drawer's inline TextInput (line ~285) or the
    // Send button below it.
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: Colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
    <View style={[styles.stage, { backgroundColor: Colors.bg }]}>
      {/* §A Header */}
      <View style={[styles.header, { paddingTop: Math.max(8, insets.top) }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={props.onBack}
          accessibilityRole="button"
          accessibilityLabel={ti('aria_back', 'Back')}
          testID="v4rev-back"
        >
          <Svg viewBox="0 0 24 24" width={20} height={20}
            fill="none" stroke={Colors.text} strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round">
            <Path d="M19 12H5" />
            <Path d="M12 19l-7-7 7-7" />
          </Svg>
        </TouchableOpacity>
        <View style={styles.progressRow}>
          <View style={[styles.pip, styles.pipDone]} />
          <View style={[styles.pip, styles.pipDone]} />
          <View style={[styles.pip, styles.pipActive]} />
          <Text style={styles.stepLabel}>
            {ti('v4_step_3_of_3', 'Step 3 of 3')}
          </Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          // (Fix-R2) — runtime-measured footer height.
          paddingBottom: Math.max(12, insets.bottom) + footerHeight,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {/* §B Captured strip */}
        <View style={styles.capturedStrip} testID="v4rev-captured">
          <CapturedChip
            icon="📷"
            labelKey="v4_cap_photo"
            labelFb="Photo"
            captured={props.hasPhoto}
            onPress={props.onEditPhoto}
            testID="v4rev-cap-photo"
          />
          <CapturedChip
            icon="🎤"
            labelKey="v4_cap_voice"
            labelFb="Voice"
            captured={props.hasVoice}
            onPress={() => setVoiceDrawerOpen(true)}
            testID="v4rev-cap-voice"
          />
          <CapturedChip
            icon="✍️"
            labelKey="v4_cap_text"
            labelFb="Text"
            captured={props.hasText}
            onPress={() => setVoiceDrawerOpen(true)}
            testID="v4rev-cap-text"
          />
        </View>

        {/* §C Summary card */}
        <View style={styles.summary} testID="v4rev-summary">
          <SummaryRow
            icon="📍"
            text={props.locationText || ti('v4_locating', 'Locating…')}
            onPress={props.onEditLocation}
            testID="v4rev-row-location"
          />
          <SummaryRow
            icon="🏠"
            text={props.infraType
              ? ti(`infra_${props.infraType.toLowerCase()}`, prettify(props.infraType))
              : '—'}
            onPress={props.onEditClassify}
            testID="v4rev-row-infra"
          />
          <SummaryRow
            icon="🌪"
            text={props.crisisType
              ? ti(`crisis_${props.crisisType.toLowerCase()}`, prettify(props.crisisType))
              : '—'}
            onPress={props.onEditClassify}
            testID="v4rev-row-crisis"
          />
          <SummaryRow
            icon="⚠"
            text={props.damageClass
              ? ti(`damage_${props.damageClass.toLowerCase()}`, prettify(props.damageClass))
              : '—'}
            onPress={props.onEditClassify}
            isLast
            testID="v4rev-row-damage"
          />
        </View>

        {/* §D Building footprint mount */}
        {props.buildingPickerNode ? (
          <View style={styles.buildingMount} testID="v4rev-building">
            {props.buildingPickerNode}
          </View>
        ) : null}

        {/* §E Voice/Text drawer — collapsed by default */}
        <Drawer
          title={ti('v4_add_voice_text', 'Add voice or text (optional)')}
          open={voiceDrawerOpen}
          onToggle={() => setVoiceDrawerOpen((v) => !v)}
          icon="🎤"
          testID="v4rev-voice-drawer"
        >
          <TouchableOpacity
            style={[styles.micBtn, props.isRecording && styles.micBtnRecording]}
            onPress={props.onToggleRecording}
            testID="v4rev-mic"
          >
            <Svg viewBox="0 0 24 24" width={18} height={18}
              fill={props.isRecording ? '#fff' : 'none'}
              stroke={props.isRecording ? '#fff' : '#09D1C7'}
              strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              <Path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <Path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            </Svg>
            <Text style={[styles.micBtnLabel, props.isRecording && styles.micBtnLabelRecording]}>
              {props.isRecording ? ti('stop', 'Stop') : ti('v4_record', 'Record voice')}
            </Text>
          </TouchableOpacity>
          {props.audioUri ? (
            <Text style={styles.audioCapturedLabel}>
              {ti('audio_recorded', 'Audio recorded')}
            </Text>
          ) : null}
          <TextInput
            style={styles.textArea}
            value={props.descriptionValue}
            onChangeText={props.onChangeDescription}
            placeholder={ti('placeholder_short_description', '…or type a short description')}
            placeholderTextColor="rgba(255,255,255,0.32)"
            multiline
            numberOfLines={3}
            testID="v4rev-text-area"
          />
        </Drawer>

        {/* §F UNDP details drawer — EXPANDED by default */}
        <Drawer
          title={ti('v4_undp_modules', 'UNDP details')}
          open={undpDrawerOpen}
          onToggle={() => setUndpDrawerOpen((v) => !v)}
          icon="📋"
          testID="v4rev-undp-drawer"
        >
          {/* Debris Y/N */}
          <View style={styles.undpRow}>
            <Text style={styles.undpLabel}>
              {ti('v4_debris', 'Debris to clear?')}
            </Text>
            <View style={styles.ynRow}>
              <Pressable
                style={[styles.ynBtn, props.debrisClearing && styles.ynBtnActive]}
                onPress={() => props.onSetDebris(true)}
                testID="v4rev-debris-yes"
              >
                <Text style={[styles.ynLabel, props.debrisClearing && styles.ynLabelActive]}>
                  {ti('v4_yes', 'Yes')}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.ynBtn, !props.debrisClearing && styles.ynBtnActive]}
                onPress={() => props.onSetDebris(false)}
                testID="v4rev-debris-no"
              >
                <Text style={[styles.ynLabel, !props.debrisClearing && styles.ynLabelActive]}>
                  {ti('v4_no', 'No')}
                </Text>
              </Pressable>
            </View>
          </View>

          {/* Electricity / Water / Health — service-status pickers */}
          <ServicePicker
            label={ti('v4_electricity', 'Electricity')}
            value={props.electricityStatus}
            onChange={props.onSetElectricity}
            testID="v4rev-elec"
          />
          <ServicePicker
            label={ti('water_svc', 'Water')}
            value={props.waterStatus}
            onChange={props.onSetWater}
            testID="v4rev-water"
          />
          <ServicePicker
            label={ti('v4_health', 'Health services')}
            value={props.healthStatus}
            onChange={props.onSetHealth}
            testID="v4rev-health"
          />

          {/* Pressing needs — multi-select chips */}
          <View style={styles.undpRowNeeds}>
            <Text style={styles.undpLabel}>
              {ti('v4_needs', 'Pressing needs')}
            </Text>
            <View style={styles.needsRow}>
              {NEEDS_CHIPS.map((n) => {
                const active = props.pressingNeeds.includes(n.v);
                return (
                  <Pressable
                    key={n.v}
                    style={[styles.needChip, active && styles.needChipActive]}
                    onPress={() => props.onTogglePressingNeed(n.v)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: active }}
                    testID={`v4rev-need-${n.v}`}
                  >
                    <Text style={[styles.needLabel, active && styles.needLabelActive]}>
                      {ti(n.labelKey, n.fb)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </Drawer>
      </ScrollView>

      {/* §G Footer Send button */}
      <View
        onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}
        style={[
          styles.footer,
          { paddingBottom: Math.max(12, insets.bottom) },
        ]}
        testID="v4rev-footer"
      >
        <TouchableOpacity
          style={[styles.sendBtn, props.isSending && styles.sendBtnDisabled]}
          onPress={props.onSend}
          disabled={props.isSending}
          accessibilityRole="button"
          accessibilityLabel={ti('v4_send', 'Send to UNDP')}
          accessibilityState={{ disabled: props.isSending }}
          testID="v4rev-btn-send"
        >
          {props.isSending ? (
            <ActivityIndicator color="#062b1b" />
          ) : (
            <Svg viewBox="0 0 24 24" width={18} height={18}
              fill="#062b1b" stroke="#062b1b" strokeWidth={1}>
              <Path d="M2 21l21-9L2 3v7l15 2-15 2v7z" />
            </Svg>
          )}
          <Text style={styles.sendLabel}>
            {props.isSending
              ? ti('upload_sending', 'Sending report…')
              : ti('v4_send', 'Send to UNDP')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
    </KeyboardAvoidingView>
  );
}

// ── CapturedChip ──────────────────────────────────────────────────
function CapturedChip(props: {
  icon: string;
  labelKey: string;
  labelFb: string;
  captured: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      style={[styles.capChip, props.captured && styles.capChipActive]}
      onPress={props.onPress}
      accessibilityRole="button"
      testID={props.testID}
    >
      <Text style={styles.capChipIcon}>{props.icon}</Text>
      <Text style={[styles.capChipLabel, props.captured && styles.capChipLabelActive]}>
        {ti(props.labelKey, props.labelFb)}
      </Text>
      <Text style={[styles.capChipState, props.captured && styles.capChipStateActive]}>
        {props.captured
          ? ti('v4_cap_added', 'Added')
          : ti('v4_cap_none', 'Not added')}
      </Text>
    </Pressable>
  );
}

// ── SummaryRow ────────────────────────────────────────────────────
function SummaryRow(props: {
  icon: string;
  text: string;
  onPress: () => void;
  isLast?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      style={[styles.summaryRow, !props.isLast && styles.summaryRowBordered]}
      onPress={props.onPress}
      accessibilityRole="button"
      testID={props.testID}
    >
      <Text style={styles.summaryIcon}>{props.icon}</Text>
      <Text style={styles.summaryText} numberOfLines={1}>{props.text}</Text>
      <Svg viewBox="0 0 24 24" width={14} height={14}
        fill="none" stroke={Colors.textDim} strokeWidth={2}
        strokeLinecap="round" strokeLinejoin="round">
        <Path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <Path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
      </Svg>
    </Pressable>
  );
}

// ── Drawer (collapsible details panel) ────────────────────────────
function Drawer(props: {
  title: string;
  open: boolean;
  onToggle: () => void;
  icon: string;
  testID?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.drawer} testID={props.testID}>
      <Pressable style={styles.drawerSummary} onPress={props.onToggle}>
        <Text style={styles.drawerIcon}>{props.icon}</Text>
        <Text style={styles.drawerTitle}>{props.title}</Text>
        <Svg viewBox="0 0 24 24" width={14} height={14}
          fill="none" stroke={Colors.textDim} strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round"
          style={{ transform: [{ rotate: props.open ? '180deg' : '0deg' }] }}>
          <Polyline points="6 9 12 15 18 9" />
        </Svg>
      </Pressable>
      {props.open ? (
        <View style={styles.drawerBody}>{props.children}</View>
      ) : null}
    </View>
  );
}

// ── ServicePicker (4-option horizontal selector) ──────────────────
function ServicePicker(props: {
  label: string;
  value: ServiceLevel;
  onChange: (v: ServiceLevel) => void;
  testID?: string;
}) {
  return (
    <View style={styles.undpRow}>
      <Text style={styles.undpLabel}>{props.label}</Text>
      <View style={styles.servicePickerRow}>
        {SERVICE_OPTIONS.map((opt) => {
          const active = props.value === opt.v;
          return (
            <Pressable
              key={opt.v}
              style={[styles.servicePickerOpt, active && styles.servicePickerOptActive]}
              onPress={() => props.onChange(opt.v)}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              testID={`${props.testID}-${opt.v.toLowerCase()}`}
            >
              <Text style={[styles.servicePickerLabel, active && styles.servicePickerLabelActive]}>
                {ti(opt.labelKey, opt.fb)}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────
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
  pipDone:   { backgroundColor: '#46DFB1' },
  pipActive: { backgroundColor: '#09D1C7' },
  stepLabel: {
    marginLeft: 'auto',
    color: 'rgba(255,255,255,0.62)',
    fontSize: 11, fontWeight: '600',
    letterSpacing: 0.4, textTransform: 'uppercase',
  },

  // §B Captured strip
  capturedStrip: {
    flexDirection: 'row', gap: 6,
    marginTop: 8, marginBottom: 12,
  },
  capChip: {
    flex: 1, padding: 10, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
  },
  capChipActive: {
    backgroundColor: 'rgba(70, 223, 177, 0.10)',
    borderColor: 'rgba(70, 223, 177, 0.36)',
  },
  capChipIcon: { fontSize: 18, marginBottom: 2 },
  capChipLabel: { color: Colors.text, fontSize: 11, fontWeight: '700' },
  capChipLabelActive: { color: '#80EE98' },
  capChipState: {
    color: Colors.textDim, fontSize: 9.5,
    textTransform: 'uppercase', letterSpacing: 0.6,
    marginTop: 2,
  },
  capChipStateActive: { color: 'rgba(128, 238, 152, 0.78)' },

  // §C Summary card
  summary: {
    marginBottom: 12, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  summaryRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  summaryRowBordered: {
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  summaryIcon: { fontSize: 16, width: 24, textAlign: 'center' },
  summaryText: {
    flex: 1, minWidth: 0,
    color: Colors.text, fontSize: 13, fontWeight: '600',
  },

  // §D Building mount
  buildingMount: {
    marginBottom: 12, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },

  // §E + §F Drawers
  drawer: {
    marginBottom: 10, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
  },
  drawerSummary: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  drawerIcon: { fontSize: 16 },
  drawerTitle: { flex: 1, color: Colors.text, fontSize: 13, fontWeight: '700' },
  drawerBody: {
    paddingHorizontal: 14, paddingTop: 4, paddingBottom: 12, gap: 12,
    borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)',
  },

  // §E Voice/text
  micBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 12, borderRadius: 10,
    backgroundColor: 'rgba(9, 209, 199, 0.10)',
    borderWidth: 1, borderColor: 'rgba(9, 209, 199, 0.32)',
  },
  micBtnRecording: {
    backgroundColor: '#ef4444', borderColor: '#ef4444',
  },
  micBtnLabel: { color: '#80EE98', fontSize: 13, fontWeight: '700' },
  micBtnLabelRecording: { color: '#fff' },
  audioCapturedLabel: {
    color: '#80EE98', fontSize: 11.5, fontWeight: '600', textAlign: 'center',
  },
  textArea: {
    minHeight: 64,
    color: Colors.text, fontSize: 13, lineHeight: 19,
    padding: 10, borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.30)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
    textAlignVertical: 'top',
  },

  // §F UNDP rows
  undpRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 4,
  },
  undpRowNeeds: { paddingVertical: 4 },
  undpLabel: {
    flex: 1, color: Colors.text, fontSize: 12.5, fontWeight: '600',
  },

  // Yes/No
  ynRow: { flexDirection: 'row', gap: 6 },
  ynBtn: {
    paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  ynBtnActive: {
    backgroundColor: 'rgba(9, 209, 199, 0.14)',
    borderColor: '#09D1C7',
  },
  ynLabel: { color: Colors.textDim, fontSize: 12, fontWeight: '600' },
  ynLabelActive: { color: '#80EE98' },

  // Service picker (4-option row)
  servicePickerRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 4,
    flexShrink: 1,
  },
  servicePickerOpt: {
    paddingHorizontal: 8, paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  servicePickerOptActive: {
    backgroundColor: 'rgba(9, 209, 199, 0.14)',
    borderColor: '#09D1C7',
  },
  servicePickerLabel: { color: Colors.textDim, fontSize: 10.5, fontWeight: '600' },
  servicePickerLabelActive: { color: '#80EE98' },

  // Pressing-needs chips (multi-select)
  needsRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
    marginTop: 6,
  },
  needChip: {
    paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  needChipActive: {
    backgroundColor: 'rgba(70, 223, 177, 0.14)',
    borderColor: '#46DFB1',
  },
  needLabel: { color: Colors.textDim, fontSize: 11, fontWeight: '600' },
  needLabelActive: { color: '#80EE98' },

  // §G Footer Send
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 20, paddingTop: 10,
    backgroundColor: Colors.bg,
    borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.06)',
  },
  sendBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10, paddingVertical: 16, borderRadius: 14,
    backgroundColor: '#46DFB1',
    shadowColor: '#46DFB1', shadowOpacity: 0.38,
    shadowRadius: 14, shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  sendBtnDisabled: {
    backgroundColor: 'rgba(70, 223, 177, 0.30)',
    shadowOpacity: 0.10, elevation: 0,
  },
  sendLabel: { color: '#062b1b', fontSize: 16, fontWeight: '800' },
});
