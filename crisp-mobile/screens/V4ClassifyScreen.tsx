/**
 * V4ClassifyScreen — RN port of the PWA's #stage-v4-classify.
 *
 * May 2026 — Phase 4 of the 8-phase RN ↔ PWA parity plan.
 * Three sub-views (damage → infra → crisis) on one screen, with
 * tile-tap auto-progress matching the PWA's 200 ms pulse + advance.
 *
 *   §A  Header        — back + 3-step progress (Step 2 of 3)
 *   §B  Sub-step bar  — "Step 2 — How bad · 1 of 3"
 *   §C  Question       — sub-view title (e.g. "How bad is the damage?")
 *   §D  Options grid   — sub-view-specific tile layout
 *
 * Sub-views:
 *   damage  — 3 radio rows (MINIMAL / PARTIAL / COMPLETE)
 *   infra   — 8-tile grid (RESIDENTIAL / COMMERCIAL / … / OTHER)
 *             OTHER reveals a free-text input + waits for blur/Enter
 *   crisis  — 9 tiles under 3 group headers (Natural / Tech / Human)
 *
 * Auto-progress (per PWA's _scheduleClassifyAdvance):
 *   t=0    tap → mark .is-selected + write parent state + pulse anim
 *   t=200  Animated.timing pulse completes → advance sub-view OR
 *          fire onContinue() if step === 'crisis'
 *   prefers-reduced-motion → t=80, no scale animation
 *
 * Race-condition guards:
 *   advancingRef.current flag blocks subsequent taps until the timer
 *   fires; cleared on each sub-step entry so re-selection after Back
 *   works smoothly.
 *
 * Back navigation:
 *   Within classify, walks backwards through ['damage','infra','crisis'].
 *   At 'damage' (first sub-view), fires the onBack callback so App.tsx
 *   can route to v4_capture (or wherever the caller chooses).
 *
 * Selection persistence:
 *   damageClass / infraType / crisisType / infraName are CONTROLLED
 *   props. App.tsx owns them; this screen sets the next value on tap
 *   via setters and renders the .is-selected state on every paint.
 *   So back-state preservation is automatic.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Pressable,
  ScrollView,
  StyleSheet,
  Animated,
  AccessibilityInfo,
  KeyboardAvoidingView,
  Platform,
  type ViewStyle,
} from 'react-native';
import Svg, { Path, Circle as SvgCircle, Line as SvgLine, Polygon } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors } from '../constants/colors';
import { t } from '../services/i18n';

// ── Sub-view ordering ─────────────────────────────────────────────
type ClassifyStep = 'damage' | 'infra' | 'crisis';
const CLASSIFY_ORDER: ClassifyStep[] = ['damage', 'infra', 'crisis'];

// ── Damage options (radio rows) ───────────────────────────────────
const DAMAGE_OPTIONS = [
  { v: 'MINIMAL',  labelKey: 'damage_minimal',  subKey: 'v4_damage_minimal_sub',  badge: '○', tone: 'good' as const },
  { v: 'PARTIAL',  labelKey: 'damage_partial',  subKey: 'v4_damage_partial_sub',  badge: '△', tone: 'warn' as const },
  { v: 'COMPLETE', labelKey: 'damage_complete', subKey: 'v4_damage_complete_sub', badge: '✕', tone: 'bad'  as const },
] as const;

// ── Infra tiles (8-tile grid) ─────────────────────────────────────
const INFRA_TILES = [
  { v: 'RESIDENTIAL',             icon: '🏠', labelKey: 'v4_infra_res_label',   subKey: 'v4_infra_res_sub' },
  { v: 'COMMERCIAL',              icon: '🏪', labelKey: 'v4_infra_com_label',   subKey: 'v4_infra_com_sub' },
  { v: 'GOVERNMENT',              icon: '🏛', labelKey: 'v4_infra_gov_label',   subKey: 'v4_infra_gov_sub' },
  { v: 'UTILITY',                 icon: '⚡', labelKey: 'v4_infra_util_label',  subKey: 'v4_infra_util_sub' },
  { v: 'TRANSPORT_COMMUNICATION', icon: '🛣', labelKey: 'v4_infra_trans_label', subKey: 'v4_infra_trans_sub' },
  { v: 'COMMUNITY',               icon: '⛑', labelKey: 'v4_infra_comm_label',  subKey: 'v4_infra_comm_sub' },
  { v: 'PUBLIC_SPACES',           icon: '🌳', labelKey: 'v4_infra_pub_label',   subKey: 'v4_infra_pub_sub' },
  { v: 'OTHER',                   icon: '⋯', labelKey: 'v4_infra_other_label', subKey: 'v4_infra_other_sub' },
] as const;

// ── Crisis groups (9 tiles in 3 visual sections) ──────────────────
// Matches PWA's CRISIS_GROUPS module-level dict in v4-flow.js.
type CrisisItem =
  | { v: string; emoji: string; k: string }
  | { v: string; svg: 'earthquake' | 'flood' | 'tsunami' | 'hurricane' | 'wildfire' | 'chemical' | 'conflict'; k: string };
const CRISIS_GROUPS: Record<'natural' | 'tech' | 'human', readonly CrisisItem[]> = {
  natural: [
    { v: 'EARTHQUAKE', svg: 'earthquake', k: 'crisis_earthquake' },
    { v: 'FLOOD',      svg: 'flood',      k: 'crisis_flood' },
    { v: 'TSUNAMI',    svg: 'tsunami',    k: 'crisis_tsunami' },
    { v: 'HURRICANE',  svg: 'hurricane',  k: 'crisis_hurricane' },
    { v: 'WILDFIRE',   svg: 'wildfire',   k: 'crisis_wildfire' },
  ],
  tech: [
    { v: 'EXPLOSION',         emoji: '💥', k: 'crisis_explosion' },
    { v: 'CHEMICAL_INCIDENT', svg: 'chemical', k: 'crisis_chemical' },
  ],
  human: [
    { v: 'CONFLICT',     svg: 'conflict', k: 'crisis_conflict' },
    { v: 'CIVIL_UNREST', emoji: '👥',     k: 'crisis_unrest' },
  ],
} as const;
const CRISIS_GROUP_ORDER = ['natural', 'tech', 'human'] as const;
const CRISIS_GROUP_TITLE: Record<string, string> = {
  natural: 'v4_cause_natural',
  tech:    'v4_cause_tech',
  human:   'v4_cause_human',
};

// ── Auto-progress timings ─────────────────────────────────────────
const ADVANCE_MS = 200;
const ADVANCE_MS_REDUCED = 80;

// ── Props ─────────────────────────────────────────────────────────
export interface V4ClassifyScreenProps {
  damageClass: string;
  infraType: string;
  crisisType: string;
  infraName: string;

  onSetDamage: (v: string) => void;
  onSetInfra: (v: string) => void;
  onSetCrisis: (v: string) => void;
  onSetInfraName: (v: string) => void;

  /** Called when the user taps Back AT the damage sub-view (first one). */
  onBack: () => void;

  /** Called when the user picks a crisis tile (terminal sub-view). */
  onContinue: () => void;
}

// ── Helper: small text-resolve wrapper with EN fallback ───────────
function ti(key: string, fallback: string): string {
  const v = t(key);
  return v && v !== key ? v : fallback;
}

export default function V4ClassifyScreen(props: V4ClassifyScreenProps) {
  const insets = useSafeAreaInsets();

  // ── Internal state — current sub-step + reduced-motion preference
  const [step, setStep] = useState<ClassifyStep>('damage');
  const [reducedMotion, setReducedMotion] = useState(false);
  const advancingRef = useRef<ClassifyStep | null>(null);

  // Detect reduced-motion once on mount; refresh on focus changes
  // (RN supports change events via AccessibilityInfo.addEventListener).
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion).catch(() => {});
  }, []);

  // Clear race guard whenever the visible sub-step changes — re-taps
  // after Back navigation work cleanly.
  useEffect(() => { advancingRef.current = null; }, [step]);

  // Per-tile Animated.Value pool. Each tile owns its own scale so
  // multiple visible pulses don't race. Keyed by `<step>:<value>`.
  const scaleMap = useRef<Map<string, Animated.Value>>(new Map());
  const getScale = (id: string) => {
    if (!scaleMap.current.has(id)) {
      scaleMap.current.set(id, new Animated.Value(1));
    }
    return scaleMap.current.get(id)!;
  };

  // Pulse + advance (with race guard + reduced-motion variant).
  const pulseAndAdvance = (tileId: string, fromStep: ClassifyStep, advance: () => void) => {
    if (advancingRef.current === fromStep) return;
    advancingRef.current = fromStep;

    const scale = getScale(tileId);
    const dur = reducedMotion ? ADVANCE_MS_REDUCED : ADVANCE_MS;

    if (reducedMotion) {
      // No scale animation; just hold the guard briefly then advance.
      setTimeout(() => {
        advancingRef.current = null;
        advance();
      }, dur);
      return;
    }

    Animated.sequence([
      Animated.timing(scale, {
        toValue: 1.04, duration: dur / 2, useNativeDriver: true,
      }),
      Animated.timing(scale, {
        toValue: 1, duration: dur / 2, useNativeDriver: true,
      }),
    ]).start(() => {
      advancingRef.current = null;
      advance();
    });
  };

  // Compute the next sub-step OR fire onContinue at terminal.
  const advanceFromStep = (fromStep: ClassifyStep) => {
    const idx = CLASSIFY_ORDER.indexOf(fromStep);
    if (idx === CLASSIFY_ORDER.length - 1) {
      props.onContinue();
      return;
    }
    setStep(CLASSIFY_ORDER[idx + 1]);
  };

  // Back — within classify or out to onBack.
  const goBack = () => {
    const idx = CLASSIFY_ORDER.indexOf(step);
    if (idx <= 0) {
      props.onBack();
      return;
    }
    setStep(CLASSIFY_ORDER[idx - 1]);
  };

  // OTHER infra tile — text-input blur trigger advances.
  const tryOtherAdvance = () => {
    if (props.infraType !== 'OTHER') return;
    const name = (props.infraName || '').trim();
    if (name.length === 0) return;
    advanceFromStep('infra');
  };

  // Sub-step counter (1-of-3 / 2-of-3 / 3-of-3 within classify).
  const subStepNum = CLASSIFY_ORDER.indexOf(step) + 1;
  const subStepKey = step === 'damage' ? 'v4_substep_how_bad'
                  : step === 'infra'  ? 'v4_substep_what_hit'
                  : 'v4_substep_what_caused';

  return (
    // (May 2026 — Fix-R3) — KAV so the soft keyboard doesn't cover
    // the "Other" infrastructure free-text input (line ~435) when
    // the user taps it on the infra sub-step.
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: Colors.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
    <View style={[styles.stage, { backgroundColor: Colors.bg }]}>
      {/* §A Header */}
      <View style={[styles.header, { paddingTop: Math.max(8, insets.top) }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={goBack}
          accessibilityRole="button"
          accessibilityLabel={ti('aria_back', 'Back')}
          testID="v4cl-back"
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
          <View style={[styles.pip, styles.pipActive]} />
          <View style={styles.pip} />
          <Text style={styles.stepLabel}>
            {ti('v4_step_2_of_3', 'Step 2 of 3')}
          </Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: Math.max(12, insets.bottom),
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* §B Sub-step bar */}
        <View style={styles.substepBar} accessibilityLiveRegion="polite" testID="v4cl-substep">
          <Text style={styles.substepLabel}>
            {ti(subStepKey, '')}
          </Text>
          <Text style={styles.substepOf}>{` · ${subStepNum} of 3`}</Text>
        </View>

        {/* §C + §D — switch by step */}
        {step === 'damage' && (
          <DamageView
            value={props.damageClass}
            getScale={getScale}
            onSelect={(v) => {
              props.onSetDamage(v);
              const tileId = `damage:${v}`;
              pulseAndAdvance(tileId, 'damage', () => advanceFromStep('damage'));
            }}
          />
        )}

        {step === 'infra' && (
          <InfraView
            value={props.infraType}
            infraName={props.infraName}
            getScale={getScale}
            onSelect={(v) => {
              props.onSetInfra(v);
              if (v === 'OTHER') {
                // Pulse but DON'T auto-advance — wait for text input
                // blur/Enter via tryOtherAdvance.
                const tileId = `infra:${v}`;
                const scale = getScale(tileId);
                Animated.sequence([
                  Animated.timing(scale, { toValue: 1.04, duration: 100, useNativeDriver: true }),
                  Animated.timing(scale, { toValue: 1,    duration: 100, useNativeDriver: true }),
                ]).start();
                return;
              }
              const tileId = `infra:${v}`;
              pulseAndAdvance(tileId, 'infra', () => advanceFromStep('infra'));
            }}
            onChangeInfraName={props.onSetInfraName}
            onCommitOther={tryOtherAdvance}
          />
        )}

        {step === 'crisis' && (
          <CrisisView
            value={props.crisisType}
            getScale={getScale}
            onSelect={(v) => {
              props.onSetCrisis(v);
              const tileId = `crisis:${v}`;
              pulseAndAdvance(tileId, 'crisis', () => advanceFromStep('crisis'));
            }}
          />
        )}
      </ScrollView>

      {/* §E — No Continue button. The PWA hides it on classify too —
          auto-progress carries the user through. Back-button only. */}
    </View>
    </KeyboardAvoidingView>
  );
}

// ── DamageView ────────────────────────────────────────────────────
function DamageView(props: {
  value: string;
  getScale: (id: string) => Animated.Value;
  onSelect: (v: string) => void;
}) {
  return (
    <>
      <Text style={styles.question}>
        {ti('v4_q_damage', 'How bad is the damage?')}
      </Text>
      <View style={styles.damageList} testID="v4cl-damage">
        {DAMAGE_OPTIONS.map((opt) => {
          const selected = props.value === opt.v;
          const tone = opt.tone === 'good' ? '#80EE98'
                    : opt.tone === 'warn' ? '#fbbf24'
                    : '#ef4444';
          return (
            <Animated.View
              key={opt.v}
              style={{ transform: [{ scale: props.getScale(`damage:${opt.v}`) }] }}
            >
              <Pressable
                style={[
                  styles.damageOpt,
                  selected && { borderColor: tone, backgroundColor: `${tone}14` },
                ]}
                onPress={() => props.onSelect(opt.v)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={ti(opt.labelKey, opt.v)}
                testID={`v4cl-damage-${opt.v}`}
              >
                <View style={[styles.damageBadge, { borderColor: tone, backgroundColor: `${tone}1f` }]}>
                  <Text style={[styles.damageBadgeText, { color: tone }]}>{opt.badge}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.damageTitle}>{ti(opt.labelKey, opt.v)}</Text>
                  <Text style={styles.damageSub}>{ti(opt.subKey, '')}</Text>
                </View>
                {selected ? <View style={[styles.damageCheck, { backgroundColor: tone }]} /> : null}
              </Pressable>
            </Animated.View>
          );
        })}
      </View>
    </>
  );
}

// ── InfraView ─────────────────────────────────────────────────────
function InfraView(props: {
  value: string;
  infraName: string;
  getScale: (id: string) => Animated.Value;
  onSelect: (v: string) => void;
  onChangeInfraName: (v: string) => void;
  onCommitOther: () => void;
}) {
  return (
    <>
      <Text style={styles.question}>{ti('v4_q_infra', 'What was hit?')}</Text>
      <View style={styles.infraGrid} testID="v4cl-infra">
        {INFRA_TILES.map((tile) => {
          const selected = props.value === tile.v;
          return (
            <Animated.View
              key={tile.v}
              style={[
                styles.infraTileWrap,
                { transform: [{ scale: props.getScale(`infra:${tile.v}`) }] },
              ]}
            >
              <Pressable
                style={[styles.infraTile, selected && styles.infraTileSelected]}
                onPress={() => props.onSelect(tile.v)}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={ti(tile.labelKey, tile.v)}
                testID={`v4cl-infra-${tile.v}`}
              >
                <Text style={styles.infraTileIcon}>{tile.icon}</Text>
                <Text style={styles.infraTileTitle} numberOfLines={2}>
                  {ti(tile.labelKey, tile.v)}
                </Text>
                <Text style={styles.infraTileSub} numberOfLines={1}>
                  {ti(tile.subKey, '')}
                </Text>
              </Pressable>
            </Animated.View>
          );
        })}
      </View>

      {props.value === 'OTHER' ? (
        <View style={styles.otherPrompt} testID="v4cl-infra-other">
          <Text style={styles.otherLabel}>
            {ti('v4_infra_other_prompt', 'Please describe what type of infrastructure')}
          </Text>
          <TextInput
            style={styles.otherInput}
            value={props.infraName}
            onChangeText={props.onChangeInfraName}
            onBlur={props.onCommitOther}
            onSubmitEditing={props.onCommitOther}
            returnKeyType="done"
            blurOnSubmit
            autoCapitalize="sentences"
            placeholder={ti('v4_infra_other_placeholder', 'e.g. cell tower, religious site, agricultural shed')}
            placeholderTextColor="rgba(255,255,255,0.32)"
            maxLength={120}
            testID="v4cl-infra-other-input"
          />
        </View>
      ) : null}
    </>
  );
}

// ── CrisisView ────────────────────────────────────────────────────
function CrisisView(props: {
  value: string;
  getScale: (id: string) => Animated.Value;
  onSelect: (v: string) => void;
}) {
  return (
    <>
      <Text style={styles.question}>{ti('v4_q_crisis', 'What caused it?')}</Text>
      <View style={styles.crisisGrid} testID="v4cl-crisis">
        {CRISIS_GROUP_ORDER.map((group) => {
          const items = CRISIS_GROUPS[group];
          if (!items.length) return null;
          return (
            <View key={group} style={styles.crisisGroup}>
              <Text style={styles.crisisGroupHeader}>
                {ti(CRISIS_GROUP_TITLE[group], group)}
              </Text>
              <View style={styles.crisisTiles}>
                {items.map((it) => {
                  const selected = props.value === it.v;
                  return (
                    <Animated.View
                      key={it.v}
                      style={[
                        styles.crisisTileWrap,
                        { transform: [{ scale: props.getScale(`crisis:${it.v}`) }] },
                      ]}
                    >
                      <Pressable
                        style={[styles.crisisTile, selected && styles.crisisTileSelected]}
                        onPress={() => props.onSelect(it.v)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        accessibilityLabel={ti(it.k, it.v)}
                        testID={`v4cl-crisis-${it.v}`}
                      >
                        <View style={styles.crisisIcon}>
                          {('emoji' in it) ? (
                            <Text style={styles.crisisIconEmoji}>{it.emoji}</Text>
                          ) : (
                            <CrisisGlyph kind={(it as any).svg} />
                          )}
                        </View>
                        <Text style={styles.crisisTileLabel} numberOfLines={2}>
                          {ti(it.k, it.v)}
                        </Text>
                      </Pressable>
                    </Animated.View>
                  );
                })}
              </View>
            </View>
          );
        })}
      </View>
    </>
  );
}

// ── Crisis SVG glyphs (matches PWA's inline Lucide-style icons) ──
function CrisisGlyph({ kind }: { kind: string }) {
  const COMMON = {
    width: 26, height: 26, fill: 'none' as const, stroke: '#09D1C7',
    strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  };
  switch (kind) {
    case 'earthquake':
      return (
        <Svg viewBox="0 0 24 24" {...COMMON}>
          <Path d="M2 12h3l2-6 4 12 3-8 3 6 2-2 3 0" />
        </Svg>
      );
    case 'flood':
      return (
        <Svg viewBox="0 0 24 24" {...COMMON}>
          <Path d="M2 12c2 0 4-2 6-2s4 2 6 2 4-2 6-2 2 1 2 1" />
          <Path d="M2 17c2 0 4-2 6-2s4 2 6 2 4-2 6-2 2 1 2 1" />
        </Svg>
      );
    case 'tsunami':
      return (
        <Svg viewBox="0 0 24 24" {...COMMON}>
          <Path d="M2 6c2 0 4 4 6 4s4-4 6-4 4 4 6 4" />
          <Path d="M2 12c2 0 4 4 6 4s4-4 6-4 4 4 6 4" />
          <Path d="M2 18c2 0 4 4 6 4s4-4 6-4 4 4 6 4" />
        </Svg>
      );
    case 'hurricane':
      return (
        <Svg viewBox="0 0 24 24" {...COMMON}>
          <SvgCircle cx={12} cy={12} r={2} />
          <Path d="M12 12c-4-4-10 0-10 6" />
          <Path d="M12 12c4 4 10 0 10-6" />
        </Svg>
      );
    case 'wildfire':
      return (
        <Svg viewBox="0 0 24 24" {...COMMON}>
          <Path d="M12 2s4 4 4 8a4 4 0 0 1-8 0c0-2 2-4 4-8z" />
          <Path d="M12 12s2 2 2 4a2 2 0 0 1-4 0c0-1 1-2 2-4z" />
        </Svg>
      );
    case 'chemical':
      return (
        <Svg viewBox="0 0 24 24" {...COMMON}>
          <Polygon points="12 3 2 21 22 21 12 3" />
          <SvgLine x1={12} y1={9} x2={12} y2={13} />
          <SvgCircle cx={12} cy={17} r={0.6} />
        </Svg>
      );
    case 'conflict':
      return (
        <Svg viewBox="0 0 24 24" {...COMMON}>
          <Path d="m14 4 6 6-2 2-6-6 2-2Z" />
          <Path d="m4 20 6-6 2 2-6 6-2-2Z" />
          <Path d="m20 14-6-6 2-2 6 6-2 2Z" />
          <Path d="m4 4 6 6-2 2-6-6 2-2Z" />
        </Svg>
      );
    default:
      return (
        <Svg viewBox="0 0 24 24" {...COMMON}>
          <SvgCircle cx={12} cy={12} r={3} />
        </Svg>
      );
  }
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

  // §B Substep bar
  substepBar: {
    flexDirection: 'row', alignItems: 'baseline', gap: 4,
    paddingBottom: 6, marginTop: 4,
  },
  substepLabel: {
    color: 'rgba(70, 223, 177, 0.88)',
    fontSize: 10.5, fontWeight: '700',
    letterSpacing: 1.6, textTransform: 'uppercase',
  },
  substepOf: { color: 'rgba(255,255,255,0.42)', fontSize: 10.5, fontWeight: '600' },

  // §C Question
  question: {
    color: Colors.text, fontSize: 22, fontWeight: '800',
    marginTop: 8, marginBottom: 14, letterSpacing: -0.01,
  },

  // §D Damage rows
  damageList: { gap: 10 },
  damageOpt: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.10)',
  },
  damageBadge: {
    width: 36, height: 36, borderRadius: 18,
    borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  } as ViewStyle,
  damageBadgeText: { fontSize: 16, fontWeight: '800' },
  damageTitle: { color: Colors.text, fontSize: 15, fontWeight: '700' },
  damageSub: { color: Colors.textDim, fontSize: 12, marginTop: 2 },
  damageCheck: {
    width: 12, height: 12, borderRadius: 6,
  },

  // §D Infra grid
  infraGrid: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
  },
  infraTileWrap: {
    width: '48.5%',
  },
  infraTile: {
    minHeight: 96, padding: 12, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  infraTileSelected: {
    borderColor: '#09D1C7',
    backgroundColor: 'rgba(9, 209, 199, 0.08)',
  },
  infraTileIcon: { fontSize: 28 },
  infraTileTitle: { color: Colors.text, fontSize: 12.5, fontWeight: '700', textAlign: 'center' },
  infraTileSub: { color: Colors.textDim, fontSize: 10.5, textAlign: 'center' },

  otherPrompt: {
    marginTop: 10, padding: 12, borderRadius: 12,
    backgroundColor: 'rgba(9, 209, 199, 0.05)',
    borderWidth: 1, borderColor: 'rgba(9, 209, 199, 0.20)',
  },
  otherLabel: { color: '#80EE98', fontSize: 12, fontWeight: '600', marginBottom: 6 },
  otherInput: {
    minHeight: 40,
    padding: 10, borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.30)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
    color: Colors.text, fontSize: 13,
  },

  // §D Crisis grid
  crisisGrid: { gap: 14 },
  crisisGroup: {},
  crisisGroupHeader: {
    color: 'rgba(255,255,255,0.42)',
    fontSize: 10, fontWeight: '700',
    letterSpacing: 1.4, textTransform: 'uppercase',
    marginBottom: 6,
  },
  crisisTiles: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 8,
  },
  crisisTileWrap: {
    width: '31%',
  },
  crisisTile: {
    minHeight: 92, padding: 10, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  crisisTileSelected: {
    borderColor: '#09D1C7',
    backgroundColor: 'rgba(9, 209, 199, 0.08)',
  },
  crisisIcon: {
    width: 32, height: 32, alignItems: 'center', justifyContent: 'center',
  },
  crisisIconEmoji: { fontSize: 24 },
  crisisTileLabel: {
    color: Colors.text, fontSize: 11, fontWeight: '600',
    textAlign: 'center', lineHeight: 13,
  },
});
