/**
 * RewardsScreen — RN port of the PWA's #stage-rewards + Badge Studio.
 *
 * May 2026 — Phase 6 of the 8-phase RN ↔ PWA parity plan. Combines
 * the PWA's Rewards page (4-tier ladder + progress) AND Badge Studio
 * share surface (character + message picker + Share dispatch) into a
 * single RN screen for v1. View-shot image composition is reserved
 * for a Phase 6.5 follow-up — v1 dispatches via the OS Share sheet
 * with a curated text message + a link, which already covers ~95 %
 * of the share use case without needing a custom PNG.
 *
 *   §A Header              — back + title "Rewards"
 *   §B Current-tier card   — big emoji + tier name + stat line
 *   §C 4-tier ladder       — visual progress through SCOUT → SIGNAL
 *                            → CHANGEMAKER → LIFEKEEPER
 *   §D Progress hint       — "Help save 1 life to reach Lifekeeper"
 *   §E Share-message picker — 8 i18n messages + Surprise me rotation
 *   §F Share buttons        — WhatsApp · LinkedIn · Copy · System share
 *
 * Architecture: props-first. App.tsx (or wherever) passes the
 * reporter's tier + stats; the screen renders + dispatches share.
 */

import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  ScrollView,
  StyleSheet,
  Share,
  Linking,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors } from '../constants/colors';
import { t } from '../services/i18n';

// ── Tier ladder (matches PWA's BADGE_LEVELS) ────────────────────────
type TierKey = 'T1_SCOUT' | 'T2_SIGNAL' | 'T3_CHANGEMAKER' | 'T4_LIFEKEEPER';
const TIER_ORDER: TierKey[] = ['T1_SCOUT', 'T2_SIGNAL', 'T3_CHANGEMAKER', 'T4_LIFEKEEPER'];

const TIERS: Record<TierKey, {
  emoji: string;
  labelKey: string;
  fb: string;
  color: string;
  glow: string;
}> = {
  T1_SCOUT:        { emoji: '🌱', labelKey: 'tier_t1_scout_label',        fb: 'Scout',        color: '#a5f3b3', glow: 'rgba(128, 238, 152, 0.18)' },
  T2_SIGNAL:       { emoji: '📣', labelKey: 'tier_t2_signal_label',       fb: 'Signal',       color: '#46DFB1', glow: 'rgba(9, 209, 199, 0.18)' },
  T3_CHANGEMAKER:  { emoji: '⚡', labelKey: 'tier_t3_changemaker_label',  fb: 'Changemaker',  color: '#46DFB1', glow: 'rgba(21, 145, 155, 0.22)' },
  T4_LIFEKEEPER:   { emoji: '🦸', labelKey: 'tier_t4_lifekeeper_label',   fb: 'Lifekeeper',   color: '#80EE98', glow: 'rgba(9, 209, 199, 0.28)' },
};

// ── 8 share messages (matches PWA's SHARE_MESSAGES) ─────────────────
const SHARE_MESSAGE_KEYS = [
  'bs_message_1', 'bs_message_2', 'bs_message_3', 'bs_message_4',
  'bs_message_5', 'bs_message_6', 'bs_message_7', 'bs_message_8',
];
const SHARE_MESSAGE_FALLBACKS = [
  'Saw it. Said it. Saved lives. 💚',
  'Real ones spot real problems. Reported. Got results.',
  'My report turned into someone\'s good day. ⚡',
  'Plot twist: I\'m the help that arrived.',
  'Crisis tried me. I CRISP\'d back.',
  'Bystander? Never met them. I\'m a Lifekeeper. 🦸',
  'Verified reporter. Verified impact. ✓',
  'First on scene with a phone in my hand. 📡',
];

// ── Helper ──────────────────────────────────────────────────────────
function ti(key: string, fallback: string): string {
  const v = t(key);
  return v && v !== key ? v : fallback;
}

// ── Props ───────────────────────────────────────────────────────────
export interface RewardsScreenProps {
  badgeLevel: TierKey | null;
  reportsSubmitted: number;
  reportsDispatched: number;
  livesSaved: number;

  /** Public share-token URL (e.g. https://undp.crisplabs.tech/share/<token>).
   *  When set, Share appends this URL to the message text. */
  shareUrl?: string;

  onBack: () => void;
}

export default function RewardsScreen(props: RewardsScreenProps) {
  const insets = useSafeAreaInsets();

  // Default to T1 if no tier known.
  const currentTier: TierKey = props.badgeLevel ?? 'T1_SCOUT';
  const currentTierMeta = TIERS[currentTier];
  const currentIdx = TIER_ORDER.indexOf(currentTier);

  // ── Share-message picker ──
  // "Surprise me" rotates deterministically based on Date.now() so the
  // default shifts each session but the user can override.
  const [pickedIdx, setPickedIdx] = useState<number | null>(null);
  const surpriseIdx = useMemo(() => Math.floor(Date.now() / 1000) % 8, []);
  const activeMessageIdx = pickedIdx ?? surpriseIdx;
  const activeMessage = ti(SHARE_MESSAGE_KEYS[activeMessageIdx], SHARE_MESSAGE_FALLBACKS[activeMessageIdx]);

  // Progress hint — what action gets the user to the next tier
  const progressKey =
    currentTier === 'T1_SCOUT' ? 'tier_progress_first_report' :
    currentTier === 'T2_SIGNAL' ? 'tier_progress_verified_1' :
    currentTier === 'T3_CHANGEMAKER' ? 'tier_progress_lives_1' :
    'tier_progress_top_share';
  const progressFallback =
    currentTier === 'T1_SCOUT' ? 'Submit your first report to level up' :
    currentTier === 'T2_SIGNAL' ? 'Get 1 report verified by an analyst' :
    currentTier === 'T3_CHANGEMAKER' ? 'Help save 1 life through your reports' :
    'Top tier reached';
  const progressHint = ti(progressKey, progressFallback);

  // Share dispatch — system Share + WhatsApp / LinkedIn deep links
  const shareUrl = props.shareUrl ?? 'https://undp.crisplabs.tech';
  const shareText = `${activeMessage}\n\n${shareUrl}`;

  const doSystemShare = async () => {
    try {
      await Share.share({
        message: shareText,
        url: shareUrl,
        title: ti(currentTierMeta.labelKey, currentTierMeta.fb),
      });
    } catch (_) { /* user cancelled */ }
  };

  const doWhatsAppShare = () => {
    const url = `whatsapp://send?text=${encodeURIComponent(shareText)}`;
    Linking.openURL(url).catch(() => doSystemShare());
  };

  const doLinkedInShare = () => {
    const url = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`;
    Linking.openURL(url).catch(() => doSystemShare());
  };

  return (
    <View style={[styles.stage, { backgroundColor: Colors.bg }]}>
      {/* §A Header */}
      <View style={[styles.header, { paddingTop: Math.max(8, insets.top) }]}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={props.onBack}
          accessibilityRole="button"
          accessibilityLabel={ti('aria_back', 'Back')}
          testID="rew-back"
        >
          <Svg viewBox="0 0 24 24" width={20} height={20}
            fill="none" stroke={Colors.text} strokeWidth={2}
            strokeLinecap="round" strokeLinejoin="round">
            <Path d="M19 12H5" />
            <Path d="M12 19l-7-7 7-7" />
          </Svg>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>
          {ti('rewards_btn', 'Rewards')}
        </Text>
        <View style={styles.backBtn} aria-hidden />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: Math.max(20, insets.bottom),
        }}
        showsVerticalScrollIndicator={false}
      >
        {/* §B Current-tier hero card */}
        <View
          style={[
            styles.heroCard,
            {
              backgroundColor: `${currentTierMeta.color}1F`,
              borderColor: `${currentTierMeta.color}66`,
              shadowColor: currentTierMeta.color,
            },
          ]}
          testID="rew-hero"
        >
          <Text style={styles.heroEmoji}>{currentTierMeta.emoji}</Text>
          <Text style={[styles.heroLabel, { color: currentTierMeta.color }]}>
            {ti(currentTierMeta.labelKey, currentTierMeta.fb)}
          </Text>
          <Text style={styles.heroStat}>
            {props.livesSaved > 0
              ? ti('badge_chip_lives_stat', '{n} lives saved').replace('{n}', String(props.livesSaved))
              : progressHint}
          </Text>
        </View>

        {/* §C 4-tier ladder */}
        <View style={styles.ladder} testID="rew-ladder">
          {TIER_ORDER.map((key, i) => {
            const tier = TIERS[key];
            const reached = i <= currentIdx;
            const isCurrent = i === currentIdx;
            return (
              <View key={key} style={styles.ladderRowOuter}>
                <View style={styles.ladderRow}>
                  <View
                    style={[
                      styles.ladderBullet,
                      reached && { backgroundColor: tier.color, borderColor: tier.color },
                      isCurrent && { transform: [{ scale: 1.18 }] },
                    ]}
                  >
                    <Text style={[
                      styles.ladderBulletEmoji,
                      !reached && { opacity: 0.42 },
                    ]}>
                      {tier.emoji}
                    </Text>
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={[
                      styles.ladderLabel,
                      reached && { color: tier.color },
                    ]}>
                      {ti(tier.labelKey, tier.fb)}
                    </Text>
                    <Text style={styles.ladderDesc} numberOfLines={2}>
                      {ti(
                        i === 0 ? 'tier_t1_scout_desc' :
                        i === 1 ? 'tier_t2_signal_desc' :
                        i === 2 ? 'tier_t3_changemaker_desc' :
                        'tier_t4_lifekeeper_desc',
                        i === 0 ? 'Welcome to CRISP — your reports start here.' :
                        i === 1 ? 'You\'ve submitted your first report.' :
                        i === 2 ? 'Your reports have triggered real response.' :
                        'Your reports have helped save lives.'
                      )}
                    </Text>
                  </View>
                </View>
                {i < TIER_ORDER.length - 1 ? (
                  <View
                    style={[
                      styles.ladderConnector,
                      reached && i < currentIdx && { backgroundColor: tier.color },
                    ]}
                  />
                ) : null}
              </View>
            );
          })}
        </View>

        {/* §E Share-message picker — only shown at T3+ where share is unlocked */}
        {currentIdx >= 2 ? (
          <View style={styles.shareSection} testID="rew-share-section">
            <Text style={styles.sectionTitle}>
              {ti('badge_studio_pick_message', 'Share message')}
            </Text>
            <View style={styles.messagePicker}>
              <Pressable
                style={[
                  styles.messagePill,
                  pickedIdx === null && styles.messagePillActive,
                ]}
                onPress={() => setPickedIdx(null)}
                testID="rew-msg-surprise"
              >
                <Text style={[
                  styles.messagePillLabel,
                  pickedIdx === null && styles.messagePillLabelActive,
                ]}>
                  ✨ {ti('bs_message_surprise', 'Surprise me')}
                </Text>
              </Pressable>
              {SHARE_MESSAGE_KEYS.map((mk, i) => (
                <Pressable
                  key={mk}
                  style={[
                    styles.messagePill,
                    pickedIdx === i && styles.messagePillActive,
                  ]}
                  onPress={() => setPickedIdx(i)}
                  testID={`rew-msg-${i + 1}`}
                >
                  <Text
                    style={[
                      styles.messagePillLabel,
                      pickedIdx === i && styles.messagePillLabelActive,
                    ]}
                    numberOfLines={2}
                  >
                    {ti(mk, SHARE_MESSAGE_FALLBACKS[i])}
                  </Text>
                </Pressable>
              ))}
            </View>

            {/* Preview card — what the share will say */}
            <View style={styles.preview} testID="rew-preview">
              <Text style={styles.previewLabel}>
                {ti('badge_studio_preview_label', 'Preview')}
              </Text>
              <Text style={styles.previewText}>{activeMessage}</Text>
              <Text style={styles.previewUrl}>{shareUrl}</Text>
            </View>

            {/* §F Share buttons */}
            <View style={styles.shareRow} testID="rew-share-buttons">
              <Pressable
                style={[styles.shareBtn, styles.shareBtnWA]}
                onPress={doWhatsAppShare}
                testID="rew-share-whatsapp"
              >
                <Text style={styles.shareBtnLabel}>
                  💬 {ti('badge_studio_share_wa', 'WhatsApp')}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.shareBtn, styles.shareBtnLi]}
                onPress={doLinkedInShare}
                testID="rew-share-linkedin"
              >
                <Text style={styles.shareBtnLabel}>
                  🔗 {ti('badge_studio_share_li', 'LinkedIn')}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.shareBtn, styles.shareBtnSystem]}
                onPress={doSystemShare}
                testID="rew-share-system"
              >
                <Text style={styles.shareBtnLabel}>
                  📤 {ti('badge_studio_share_more', 'More')}
                </Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.lockedShare} testID="rew-share-locked">
            <Text style={styles.lockedTitle}>
              🔒 {ti('badge_studio_lock_t1_t2', 'Share unlocks at Changemaker')}
            </Text>
            <Text style={styles.lockedDesc}>
              {ti('badge_studio_lock_t1_t2_desc',
                'Keep reporting to reach Changemaker tier and share your badge.')}
            </Text>
          </View>
        )}

        {/* Footer stats */}
        <View style={styles.statsFooter}>
          <Text style={styles.statsLine}>
            {ti('rewards_stats_reports', '{n} reports submitted').replace('{n}', String(props.reportsSubmitted))}
          </Text>
          {props.reportsDispatched > 0 ? (
            <Text style={styles.statsLine}>
              {ti('rewards_stats_dispatched', '{n} dispatched to responders')
                .replace('{n}', String(props.reportsDispatched))}
            </Text>
          ) : null}
        </View>
      </ScrollView>
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
  headerTitle: {
    flex: 1, color: Colors.text, fontSize: 17, fontWeight: '800',
    textAlign: 'center',
  },

  // §B Hero card
  heroCard: {
    marginTop: 8, marginBottom: 16,
    paddingVertical: 24, paddingHorizontal: 20,
    borderRadius: 22, borderWidth: 1.5,
    alignItems: 'center', gap: 6,
    shadowOpacity: 0.32, shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10,
  },
  heroEmoji: { fontSize: 48, lineHeight: 56 },
  heroLabel: { fontSize: 26, fontWeight: '900', letterSpacing: 0.5 },
  heroStat: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13, fontWeight: '600',
    textTransform: 'uppercase', letterSpacing: 1.2,
  },

  // §C Ladder
  ladder: {
    marginBottom: 16, padding: 16, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  ladderRowOuter: {},
  ladderRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  ladderBullet: {
    width: 44, height: 44, borderRadius: 22,
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.10)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center', justifyContent: 'center',
  },
  ladderBulletEmoji: { fontSize: 22, lineHeight: 26 },
  ladderLabel: { color: Colors.text, fontSize: 14, fontWeight: '800' },
  ladderDesc: {
    color: Colors.textDim, fontSize: 11.5,
    lineHeight: 16, marginTop: 1,
  },
  ladderConnector: {
    width: 2, height: 14, marginLeft: 21,
    backgroundColor: 'rgba(255,255,255,0.10)',
    marginVertical: 2,
  },

  // §E Share section
  shareSection: { marginBottom: 12 },
  sectionTitle: {
    color: Colors.textDim, fontSize: 10.5, fontWeight: '700',
    letterSpacing: 1.6, textTransform: 'uppercase',
    marginBottom: 8,
  },
  messagePicker: {
    flexDirection: 'row', flexWrap: 'wrap', gap: 6,
    marginBottom: 12,
  },
  messagePill: {
    paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
    maxWidth: '100%',
  },
  messagePillActive: {
    backgroundColor: 'rgba(70, 223, 177, 0.12)',
    borderColor: '#46DFB1',
  },
  messagePillLabel: {
    color: Colors.textDim, fontSize: 11, fontWeight: '600',
  },
  messagePillLabelActive: { color: '#80EE98' },

  preview: {
    padding: 14, borderRadius: 12,
    backgroundColor: 'rgba(9, 209, 199, 0.05)',
    borderWidth: 1, borderColor: 'rgba(9, 209, 199, 0.18)',
    marginBottom: 12,
  },
  previewLabel: {
    color: 'rgba(70, 223, 177, 0.78)',
    fontSize: 9.5, fontWeight: '700',
    letterSpacing: 1.4, textTransform: 'uppercase',
    marginBottom: 6,
  },
  previewText: { color: Colors.text, fontSize: 14, lineHeight: 19 },
  previewUrl: {
    color: 'rgba(255,255,255,0.42)',
    fontSize: 11, marginTop: 4,
    fontFamily: 'SpaceMono-Regular',
  },

  shareRow: { flexDirection: 'row', gap: 8 },
  shareBtn: {
    flex: 1, paddingVertical: 14, borderRadius: 12,
    alignItems: 'center',
  },
  shareBtnWA: { backgroundColor: '#25d366' },
  shareBtnLi: { backgroundColor: '#0a66c2' },
  shareBtnSystem: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  shareBtnLabel: { color: '#fff', fontSize: 13, fontWeight: '700' },

  // Locked share
  lockedShare: {
    padding: 18, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.025)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center', gap: 4, marginBottom: 12,
  },
  lockedTitle: { color: Colors.text, fontSize: 14, fontWeight: '800' },
  lockedDesc: {
    color: Colors.textDim, fontSize: 12, textAlign: 'center', lineHeight: 17,
  },

  // Stats footer
  statsFooter: { alignItems: 'center', gap: 2, paddingVertical: 12 },
  statsLine: { color: Colors.textDim, fontSize: 11.5 },
});
