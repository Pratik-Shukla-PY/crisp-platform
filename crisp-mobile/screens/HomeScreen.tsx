/**
 * HomeScreen — RN port of the PWA home stage.
 *
 * May 2026 — Phase 2 of the 8-phase RN ↔ PWA parity plan (see
 * V4_PARITY_DEFERRED.md). Ports the PWA's redesigned home stage
 * (mobile-app/src/index.html lines ~530-895) into a single React
 * Native screen. Visual EQUIVALENCE not pixel parity — CSS
 * gradients / box-shadows / glow effects don't map 1:1 to RN, so
 * we use platform-native primitives (StyleSheet, react-native-svg,
 * react-native-safe-area-context, Linking).
 *
 * Layout sections (3-group flex per the May 2026 redesign):
 *   §A  Top         — brand row (logo + CRISP), lang pill, Lifekeeper inline pill
 *   §B  Hero        — consent toggle, BIG CTA "Report an Incident" with subtitle,
 *                     5-tile utility row (Download / Login / My Reports / Rewards / Audio)
 *   §C  Bottom      — "Other ways to report" 3×2 channels grid, Privacy footer,
 *                     device-ID pill
 *
 * Single 20-px horizontal gutter throughout. Safe-area insets respected
 * for notched devices. Tiles distribute via flex:1 so the row stays
 * symmetric when the Install tile hides on already-installed devices.
 *
 * Wiring: App.tsx passes navigation callbacks + state via props.
 * The component is intentionally PROPS-FIRST so it's easy to unit-test
 * without mocking the entire App.tsx tree.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  Linking,
  Animated,
  Easing,
  AccessibilityInfo,
} from 'react-native';
import Svg, { Rect, Circle, Defs, LinearGradient, RadialGradient, Stop } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Colors } from '../constants/colors';
import { t, getAvailableLanguages } from '../services/i18n';
import NearbyReports from '../components/NearbyReports';

// ── Deep navy bg gradient (Phase 2 v5 redesign) ────────────────────
// SVG full-screen rect with radial gradient — RN doesn't support CSS
// radial-gradient on Views so we paint an absolute-positioned SVG
// behind the ScrollView content. Matches the PWA's
// `radial-gradient(circle at top, #21466f 0%, #1a3b62 30%, #16365c 55%, #10284a 100%)`.
function BgRadial({ width, height }: { width: number; height: number }) {
  return (
    <Svg
      width={width}
      height={height}
      style={{ position: 'absolute', top: 0, left: 0 }}
      pointerEvents="none"
    >
      <Defs>
        <RadialGradient
          id="homeBgRadial"
          cx="50%" cy="0%"
          rx="100%" ry="80%"
          fx="50%" fy="0%"
          gradientUnits="userSpaceOnUse"
        >
          <Stop offset="0" stopColor="#21466f" stopOpacity="1" />
          <Stop offset="0.30" stopColor="#1a3b62" stopOpacity="1" />
          <Stop offset="0.55" stopColor="#16365c" stopOpacity="1" />
          <Stop offset="1" stopColor="#10284a" stopOpacity="1" />
        </RadialGradient>
      </Defs>
      <Rect width={width} height={height} fill="url(#homeBgRadial)" />
    </Svg>
  );
}

// ── Cyan glow blob (Phase 2 v5 — sits behind the hero card) ─────────
// Mock's hero card has a soft cyan radial bloom behind the top-right
// corner that suggests an HUD light source. RN port via an absolute-
// positioned SVG circle with a radial fade. PWA parity:
// `.home-stage .home-hero-card::before`.
function HeroGlowBlob() {
  return (
    <Svg
      width={240}
      height={240}
      style={{ position: 'absolute', top: -110, right: -50 }}
      pointerEvents="none"
    >
      <Defs>
        <RadialGradient
          id="heroGlow"
          cx="50%" cy="50%"
          rx="50%" ry="50%"
          fx="50%" fy="50%"
          gradientUnits="objectBoundingBox"
        >
          <Stop offset="0" stopColor="#46DFB1" stopOpacity="0.20" />
          <Stop offset="0.30" stopColor="#09D1C7" stopOpacity="0.10" />
          <Stop offset="0.70" stopColor="#09D1C7" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Circle cx={120} cy={120} r={120} fill="url(#heroGlow)" />
    </Svg>
  );
}

// ── Brand mark — port of mobile-app/src/favicon.svg ─────────────────
// 256×256 viewBox, dark-navy tile with 4 concentric response rings
// (faint outer → bright inner), cyan epicenter dot, coral responder
// dot on the second ring.
function CrispRippleLogo({ size = 32 }: { size?: number }) {
  return (
    <Svg viewBox="0 0 256 256" width={size} height={size}>
      <Defs>
        <LinearGradient id="crispTile" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor="#22455F" />
          <Stop offset="1" stopColor="#163349" />
        </LinearGradient>
      </Defs>
      <Rect width={256} height={256} rx={44} fill="url(#crispTile)" />
      <Circle cx={128} cy={128} r={106} fill="none" stroke="#5EEAD4" strokeWidth={4.5} opacity={0.3} />
      <Circle cx={128} cy={128} r={81} fill="none" stroke="#2DD4BF" strokeWidth={5.5} opacity={0.5} />
      <Circle cx={128} cy={128} r={56} fill="none" stroke="#22D3EE" strokeWidth={7} opacity={0.78} />
      <Circle cx={128} cy={128} r={31} fill="none" stroke="#67E8F9" strokeWidth={8} />
      <Circle cx={128} cy={128} r={13} fill="#67E8F9" />
      <Circle cx={184} cy={72} r={9} fill="#FB7185" />
    </Svg>
  );
}

// ── Tier ladder — Phase 2.1 (May 2026), sourced from shared canonical config.
// `crisp-mobile/shared/tier-config.ts` is auto-generated from
// `shared/tier-config.json`; see scripts/sync-tier-config.mjs.
import {
  TIERS_BY_ID as SHARED_TIERS_BY_ID,
  LEGACY_TIER_ALIASES,
  type TierId,
} from '../shared/tier-config';

const TIER_META: Record<string, { emoji: string; labelKey: string; color: string }> = (() => {
  const out: Record<string, { emoji: string; labelKey: string; color: string }> = {};
  for (const t of Object.values(SHARED_TIERS_BY_ID)) {
    out[t.id] = { emoji: t.emoji, labelKey: t.i18n_key, color: t.color };
  }
  // Re-project legacy aliases onto the same shape so backend rows
  // mid-rollout that still carry a legacy badge_level render with
  // the V4-equivalent emoji + colour.
  for (const [legacy, v4] of Object.entries(LEGACY_TIER_ALIASES)) {
    const m = SHARED_TIERS_BY_ID[v4 as TierId];
    if (m) {
      out[legacy] = { emoji: m.emoji, labelKey: m.i18n_key, color: m.color };
    }
  }
  return out;
})();

// ── Channel registry ───────────────────────────────────────────────
// Mirrors the PWA's home-screen.js _renderChannels(). Each tile gets
// an emoji icon + label key + live flag + deep-link URL + status
// subtitle key (matches the operator-supplied screenshot).
const CHANNELS: Array<{
  id: 'telegram' | 'whatsapp' | 'sms' | 'ivr' | 'android' | 'ios';
  emoji: string;
  labelKey: string;
  statusKey: string;     // i18n key resolved at render time
  live: boolean;
  url?: string;
}> = [
  // v168.1 — both live channels now use the live_now key ("Live")
  // for parity with the operator's "Live with glowing green" ask;
  // voice_reporting remains in the i18n bundle for future use.
  { id: 'telegram', emoji: '✈️', labelKey: 'channel_telegram', statusKey: 'live_now',      live: true,  url: 'https://t.me/CrispUNDPbot' },
  { id: 'whatsapp', emoji: '💬', labelKey: 'channel_whatsapp', statusKey: 'coming_soon',   live: false, url: 'https://wa.me/' },
  { id: 'sms',      emoji: '📩', labelKey: 'channel_sms',      statusKey: 'low_bandwidth', live: false, url: 'sms:' },
  { id: 'ivr',      emoji: '☎️', labelKey: 'channel_ivr',      statusKey: 'live_now',      live: true,  url: 'tel:' },
  { id: 'android',  emoji: '🤖', labelKey: 'channel_android',  statusKey: 'coming_soon',   live: false, url: 'market://details?id=org.undp.crisp' },
  { id: 'ios',      emoji: '🍎', labelKey: 'channel_ios',      statusKey: 'coming_soon',   live: false, url: 'https://apps.apple.com/' },
];

// ── Props ──────────────────────────────────────────────────────────
export interface HomeScreenProps {
  // Navigation callbacks (App.tsx wires these to setScreen / external links).
  onStartReport: () => void;
  onMyReports: () => void;
  onLogin: () => void;
  onSettings: () => void;
  onRewards?: () => void;
  onAudio?: () => void;
  onInstall?: () => void;
  onPrivacy?: () => void;
  onChannelPress?: (id: string, url?: string) => void;

  // Auth state
  authReady: boolean;
  authLoggedIn: boolean;
  authDisplay: string | null;

  // Connectivity + queue
  isOnline: boolean;
  queueCount: number;
  onQueueTap?: () => void;

  // Locale
  lang: string;
  onChangeLang: (code: string) => void;

  // Consent
  consentGiven: boolean;
  onConsentToggle: () => void;

  // Identity
  deviceId?: string;          // CRISP-XXXX-XXXX format. Hidden if empty.

  // Reward / tier
  badgeLevel?: string | null; // T1_SCOUT … T4_LIFEKEEPER or legacy
  badgeLivesSaved?: number;   // For T4 — shown inline in the pill

  // App version (footer)
  appVersion?: string;

  // "Verified Reports Nearby" — already-cached GPS from the v4
  // capture flow. NEVER prompted from the home stage. When either
  // is null, the NearbyReports module stays hidden.
  nearbyLat?: number | null;
  nearbyLng?: number | null;
}

export default function HomeScreen(props: HomeScreenProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const langs = useMemo(() => getAvailableLanguages(), []);

  // ── Phase 3 v5: pulse-stat motion gating ───────────────────────────
  // The lives-saved counter gets an animated halo. Loop is gated by
  // OS-level reduced-motion preference (same pattern as
  // V4ClassifyScreen's tile-pulse).
  const [reducedMotion, setReducedMotion] = useState(false);
  const pulseRing1 = useRef(new Animated.Value(0)).current;
  const pulseRing2 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReducedMotion).catch(() => {});
  }, []);

  useEffect(() => {
    if (reducedMotion) return undefined;
    // Two staggered loops — ring2 starts 1.6 s after ring1 so the
    // user always sees a ring expanding somewhere mid-cycle.
    const makeLoop = (v: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(v, {
            toValue: 1, duration: 3200,
            easing: Easing.out(Easing.ease), useNativeDriver: true,
          }),
          Animated.timing(v, {
            toValue: 0, duration: 0, useNativeDriver: true,
          }),
        ]),
      );
    const a = makeLoop(pulseRing1, 0);
    const b = makeLoop(pulseRing2, 1600);
    a.start(); b.start();
    return () => { a.stop(); b.stop(); };
  }, [reducedMotion, pulseRing1, pulseRing2]);
  const _t = (key: string, fallback?: string): string => {
    const v = t(key);
    return (v && v !== key) ? v : (fallback ?? key);
  };

  const tier = props.badgeLevel ? TIER_META[props.badgeLevel] : null;
  const isLifekeeper = props.badgeLevel === 'T4_LIFEKEEPER' || props.badgeLevel === 'HERO';

  // Lifekeeper pill stat line — for T4 reporters with lives_saved > 0
  // we render "{n} lives saved"; lower tiers show the tier progress hint.
  const tierStatLine = useMemo(() => {
    if (!tier) return '';
    if (isLifekeeper && props.badgeLivesSaved && props.badgeLivesSaved > 0) {
      return _t('badge_chip_lives_stat', '{n} lives saved')
        .replace('{n}', String(props.badgeLivesSaved));
    }
    // Map tier → progress key
    const progressKey =
      props.badgeLevel === 'T1_SCOUT' || props.badgeLevel === 'NEWCOMER'
        ? 'tier_progress_first_report'
        : props.badgeLevel === 'T2_SIGNAL' || props.badgeLevel === 'HELPER'
        ? 'tier_progress_verified_1'
        : props.badgeLevel === 'T3_CHANGEMAKER' || props.badgeLevel === 'GUARDIAN'
        ? 'tier_progress_lives_1'
        : 'tier_progress_top_share';
    return _t(progressKey, '');
  }, [tier, isLifekeeper, props.badgeLivesSaved, props.badgeLevel]);

  // Channel tile — single source of truth for deep-link dispatch.
  const handleChannel = (id: string, url?: string) => {
    if (props.onChannelPress) {
      props.onChannelPress(id, url);
      return;
    }
    if (url) {
      Linking.openURL(url).catch(() => { /* silently swallow; OS will toast */ });
    }
  };

  // Compact viewport detection — drops the channels-section title to
  // an eyebrow on the shortest phones (iPhone SE) so the page still
  // fits in 100dvh without scroll.
  const isShortViewport = width < 380;
  // (May 2026 — Fix-R4) — also compress the primary CTA's minHeight on
  // short viewports (iPhone SE: 568 dp tall; Galaxy S9+: ≈640 dp). The
  // original 110 dp ate 19 % of the viewport on iPhone SE, pushing the
  // utility tile row below the home indicator. 88 dp keeps the WCAG
  // 44 dp tap target comfortably (2× margin) while restoring space.
  const isShortHeightViewport = height < 700;
  const ctaMinHeight = isShortHeightViewport ? 88 : 110;

  return (
    <View style={{ flex: 1, backgroundColor: '#10284a' }}>
      {/* Phase 2 v5: deep-navy radial behind everything. SVG-painted so
          the gradient is consistent across iOS / Android (RN doesn't
          support CSS radial-gradient on Views). Sized to viewport. */}
      <BgRadial width={width} height={height} />

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingTop: Math.max(16, insets.top),
          paddingBottom: Math.max(12, insets.bottom),
          paddingHorizontal: 20,
          // (May 2026 — Fix-R1) flexGrow: 1 is the canonical RN
          // pattern for "content container fills the ScrollView's
          // visible area when content is shorter". `minHeight: '100%'`
          // (string percentage) is silently ignored by RN's flex
          // layout engine — was producing inconsistent heights on
          // notched phones (iPhone 12 vs 13 mini vs Pixel 6).
          flexGrow: 1,
        }}
        // Single-page no-scroll is the goal; ScrollView is here only as a
        // safety net for content overflow on very small landscape phones.
        showsVerticalScrollIndicator={false}
      >
      {/* ── §A.1 Header row — brand left, lang pill right ─────── */}
      <View style={styles.headerRow} testID="home-header">
        <View style={styles.brandWrap}>
          <View style={styles.brandLogo}>
            <CrispRippleLogo size={32} />
          </View>
          <Text style={styles.brandWordmark}>CRISP</Text>
        </View>

        {/* Lang pill — compact horizontal selector. Renders the current
            locale's flag emoji as the pill content; tapping cycles to
            the next locale in the picker order. */}
        <TouchableOpacity
          style={styles.langPill}
          onPress={() => {
            const idx = langs.findIndex(l => l.code === props.lang);
            const next = langs[(idx + 1) % langs.length];
            if (next) props.onChangeLang(next.code);
          }}
          accessibilityRole="button"
          accessibilityLabel={_t('aria_tap_change_language', 'Tap to change language')}
          testID="home-lang-pill"
        >
          <View style={[
            styles.connectivityDot,
            { backgroundColor: props.isOnline ? '#80EE98' : '#ef4444' },
          ]} />
          <Text style={styles.langPillText}>
            {langs.find(l => l.code === props.lang)?.flag ?? '🌐'} {props.lang.toUpperCase()}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ── §B HERO CARD ────────────────────────────────────────────
          Phase 1 v5 redesign (May 2026) — Lifekeeper pill + consent +
          primary CTA + offline-reassurance helper grouped into ONE
          glass card. Matches the PWA's .home-hero-card in
          mobile-app/src/index.html. Eliminates the "floating
          disconnected cards" feel and gives the viewport a single
          visual anchor. Phase 2 v5: cyan radial glow blob behind the
          card's top-right corner (HUD-light suggestion). */}
      <View style={styles.heroCard} testID="home-hero-card">

        {/* Cyan glow accent — sits BEHIND the card content via
            absolute positioning + parent overflow:hidden. PWA parity:
            .home-stage .home-hero-card::before. */}
        <HeroGlowBlob />

        {/* §B.1 Lifekeeper inline pill (top of card) */}
        {tier && (
          <View style={styles.rewardWrap} testID="home-reward-pill">
            <View style={[
              styles.rewardPill,
              { borderColor: 'transparent', backgroundColor: 'rgba(70, 223, 177, 0.10)' },
            ]}>
              <Text style={styles.rewardEmoji}>{tier.emoji}</Text>
              <View style={{ flexDirection: 'column' }}>
                <Text style={[styles.rewardLabel, { color: tier.color }]}>
                  {_t(tier.labelKey, '')}
                </Text>
                {tierStatLine ? (
                  <Text style={styles.rewardStat} numberOfLines={1}>{tierStatLine}</Text>
                ) : null}
              </View>
            </View>
          </View>
        )}

        {/* §B.2 Consent checkbox (inline within card) */}
        <Pressable
          style={styles.consentRow}
          onPress={props.onConsentToggle}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: props.consentGiven }}
          testID="home-consent"
        >
          <View style={[styles.consentBox, props.consentGiven && styles.consentBoxChecked]}>
            {props.consentGiven ? <Text style={styles.consentTick}>✓</Text> : null}
          </View>
          <Text style={styles.consentText}>
            {_t('home_consent_v2',
              'I consent to share my report. Faces are blurred on my phone before upload, and reports are linked only to my anonymous ID.')}
          </Text>
        </Pressable>

        {/* §B.3 PRIMARY CTA — the anchor */}
        <TouchableOpacity
          style={[
            styles.cta,
            { minHeight: ctaMinHeight },        // Fix-R4 — responsive
            !props.consentGiven && styles.ctaDisabled,
          ]}
          onPress={() => { if (props.consentGiven) props.onStartReport(); }}
          disabled={!props.consentGiven}
          accessibilityRole="button"
          accessibilityLabel={_t('home_cta_primary', 'Report an Incident')}
          accessibilityHint={_t('home_cta_sub', 'Capture · Verify · Help')}
          testID="home-cta-start"
        >
          <View style={styles.ctaRow}>
            <Text style={styles.ctaPlay}>▶</Text>
            <Text style={styles.ctaLabel}>
              {_t('home_cta_primary', 'Report an Incident')}
            </Text>
          </View>
          {/* v169.1 (May 2026, operator) — "CAPTURE · VERIFY · HELP"
              visible subtitle removed. accessibilityHint above still
              announces the value-prop for VoiceOver / TalkBack users.
              The home_cta_sub i18n key + ctaSub style stay as orphans. */}
        </TouchableOpacity>

        {/* §B.4 Reassurance helper — addresses operator ask for an
            "emotionally reassuring" CTA. Surfaces offline-first
            promise next to the action so disaster-zone reporters
            trust their tap. PWA parity: .home-hero-helper. */}
        <Text style={styles.heroHelper} testID="home-hero-helper">
          {_t('home_cta_helper',
            'Works offline and syncs automatically in low connectivity.')}
        </Text>
      </View>

      {/* ── §B.3 Utility tile row — 5 tiles distribute via flex:1 ─ */}
      <View style={styles.utilityRow} testID="home-utility-row">
        {/* Download App — visible only when not installed (RN: always
            hidden on actual install; we expose via prop) */}
        {props.onInstall ? (
          <UtilityTile
            icon="⬇"
            label={_t('action_tile_download', 'Download App')}
            onPress={props.onInstall}
            testID="home-tile-install"
          />
        ) : null}

        {/* Login — auth state dot */}
        <UtilityTile
          icon="👤"
          label={props.authLoggedIn
            ? _t('home_login_icon_signed_in', 'Account')
            : _t('action_tile_login', 'Login')}
          onPress={props.authLoggedIn ? props.onSettings : props.onLogin}
          statusDot={props.authReady
            ? (props.authLoggedIn ? 'online' : 'offline')
            : undefined}
          testID="home-tile-login"
        />

        <UtilityTile
          icon="📋"
          label={_t('my_reports', 'My Reports')}
          onPress={props.onMyReports}
          testID="home-tile-reports"
        />

        <UtilityTile
          icon="🏅"
          label={_t('rewards_btn', 'Rewards')}
          onPress={props.onRewards ?? props.onSettings}
          accent
          testID="home-tile-rewards"
        />

        <UtilityTile
          icon="🔊"
          label={_t('action_tile_audio', 'Audio')}
          onPress={props.onAudio ?? (() => {})}
          testID="home-tile-audio"
        />
      </View>

      {/* ── §C.0 "Verified Reports Nearby" intel module ──────────
          Phase 1 (May 2026) — replaces the static-24 pulse per the
          operator-approved design plan. The component itself:
            ✓ stays hidden when offline + no fresh cache
            ✓ never prompts for GPS on this screen
            ✓ shows grouped reports when fresh data available
            ✓ shows "Last seen X min ago" when serving 5-min cache
            ✓ shows reassuring "All clear" empty state when fresh
              data shows zero nearby reports
          The pulse animation machinery above (reducedMotion +
          pulseRing1/pulseRing2 refs) is kept in place for Phase 2 —
          a brief loading halo before the first list paint. */}
      <NearbyReports
        lat={props.nearbyLat ?? null}
        lng={props.nearbyLng ?? null}
        online={props.isOnline}
      />

      {/* ── §C.1 Channels — "Other ways to report" 3×2 grid ────── */}
      <View style={styles.channelsSection} testID="home-channels">
        <Text style={styles.channelsTitle}>
          {_t('home_channels_title', 'Other ways to report')}
        </Text>
        <View style={styles.channelsGrid}>
          {CHANNELS.map((c) => (
            <Pressable
              key={c.id}
              style={[
                styles.channelTile,
                c.live && styles.channelTileLive,
              ]}
              onPress={() => handleChannel(c.id, c.url)}
              accessibilityRole="button"
              accessibilityLabel={_t(c.labelKey, c.id)}
              testID={`home-channel-${c.id}`}
            >
              <Text style={styles.channelIcon}>{c.emoji}</Text>
              <Text style={styles.channelLabel} numberOfLines={1}>
                {_t(c.labelKey, c.id)}
              </Text>
              {/* v7 (May 2026, operator): live channels (Telegram +
                  IVR) drop the status text entirely and surface a
                  small solid green dot at top-right of the tile.
                  Non-live channels keep their status subtitle. */}
              {c.live ? (
                <View style={styles.channelLiveDot} pointerEvents="none" />
              ) : (
                <Text style={styles.channelStatus} numberOfLines={1}>
                  {_t(c.statusKey, c.statusKey)}
                </Text>
              )}
            </Pressable>
          ))}
        </View>
      </View>

      {/* ── §C.2 Queue badge (only when offline reports pending) ─ */}
      {props.queueCount > 0 && (
        <TouchableOpacity
          style={styles.queueBadge}
          onPress={props.onQueueTap}
          testID="home-queue-badge"
        >
          <Text style={styles.queueText}>
            {props.isOnline ? '🔄' : '📴'} {props.queueCount} {_t('sync_queued', 'queued')}
          </Text>
        </TouchableOpacity>
      )}

      {/* ── §C.3 Footer row — single horizontal line (v168.1) ─────
          Operator: "the bottom design (privacy, open Source etc) also
          match exactly with my previously shared image same as in
          that one." Links LEFT, device-ID pill RIGHT, separated by
          space-between. Order: Privacy · Help · Open source. */}
      <View style={styles.footerRow} testID="home-footer">
        <View style={styles.footerLinks}>
          <Text style={styles.footerLink} onPress={props.onPrivacy}>
            {_t('home_footer_privacy', 'Privacy')}
          </Text>
          <Text style={styles.footerDot}>•</Text>
          <Text style={styles.footerLink} onPress={props.onSettings}>
            {_t('home_footer_help', 'Help')}
          </Text>
          <Text style={styles.footerDot}>•</Text>
          <Text
            style={styles.footerLink}
            onPress={() => Linking.openURL('https://github.com/Pratik-Shukla-PY/crisp-platform').catch(() => {})}
          >
            {_t('home_footer_opensrc', 'Open source')}
          </Text>
        </View>

        {/* Device-ID pill — moved INTO the footer row. */}
        {props.deviceId ? (
          <View style={styles.devidBadge} testID="home-devid">
            <Text style={styles.devidText}>{props.deviceId}</Text>
          </View>
        ) : null}
      </View>
      </ScrollView>
    </View>
  );
}

/**
 * UtilityTile — single tile in the §B.3 utility row.
 * Vertical layout: icon top, label below. Optional auth-state dot
 * (top-right). Tiles flex:1 inside the parent row so they share width
 * evenly + redistribute when one is hidden.
 */
function UtilityTile(props: {
  icon: string;
  label: string;
  onPress: () => void;
  statusDot?: 'online' | 'offline';
  accent?: boolean;          // Tints icon green (e.g. Rewards)
  testID?: string;
}) {
  return (
    <Pressable
      style={styles.utilityTile}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      testID={props.testID}
    >
      <Text style={[
        styles.utilityIcon,
        props.accent && { color: '#80EE98' },
      ]}>
        {props.icon}
      </Text>
      <Text style={styles.utilityLabel} numberOfLines={2}>
        {props.label}
      </Text>
      {props.statusDot && (
        <View style={[
          styles.utilityStatusDot,
          { backgroundColor: props.statusDot === 'online' ? '#80EE98' : '#ef4444' },
        ]} />
      )}
    </Pressable>
  );
}

// ── Styles ──────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  // §A.1 Header
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 32,
    marginBottom: 8,
  },
  brandWrap: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandLogo: {
    width: 32, height: 32, borderRadius: 10, overflow: 'hidden',
    // Subtle cyan halo behind the SVG tile
    shadowColor: '#09D1C7', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  brandWordmark: {
    color: Colors.text, fontSize: 17, fontWeight: '800', letterSpacing: 0.5,
  },
  // Lang pill v6.1 (May 2026, operator screenshot pass 2) — navy
  // capsule + visible cyan ambient glow + grounding shadow. RN
  // can't replicate the PWA's linear-gradient on a plain View
  // without an extra dep, so we use a single navy shade (#152238
  // sits halfway between the PWA gradient's #1b2a44 / #0e1828
  // stops) plus a strong cyan shadow for elevation. The first pass
  // used shadowOpacity 0.30 / radius 12 which was perceptually
  // invisible against the dark home bg; v6.1 cranks both so the
  // halo actually reads as a live glow. borderRadius 24 → 999 for
  // full capsule regardless of content height. PWA parity at the
  // structural level — same ordering, same green dot, same flag +
  // code text.
  langPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 7,
    backgroundColor: '#152238',
    borderRadius: 999, borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
    shadowColor: '#09D1C7', shadowOpacity: 0.55, shadowRadius: 16, shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  connectivityDot: {
    width: 12, height: 12, borderRadius: 6,
    shadowColor: '#80EE98', shadowOpacity: 0.95, shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
    elevation: 6,
  },
  langPillText: {
    color: '#fff', fontSize: 12.5, fontWeight: '700', letterSpacing: 0.4,
  },

  // §B Hero card — Phase 1 v5 redesign (May 2026). Groups
  // Lifekeeper + consent + CTA + helper into one glass block.
  // Phase 2 v5: cyan glow blob lives inside (overflow:hidden clips
  // it to the card's rounded corners).
  heroCard: {
    marginTop: 8,
    padding: 18,
    borderRadius: 22,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.08)',
    gap: 12,
    // RN equivalent of the PWA's box-shadow: 0 12px 36px rgba(0,0,0,0.22)
    shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 14, shadowOffset: { width: 0, height: 8 },
    elevation: 6,
    overflow: 'hidden',
    position: 'relative',     // anchor for the absolute-positioned glow blob
  },
  heroHelper: {
    color: 'rgba(255, 255, 255, 0.62)',
    fontSize: 12, fontWeight: '500',
    textAlign: 'center', lineHeight: 16,
  },

  // §A.2 Lifekeeper pill (kept inside the hero card)
  rewardWrap: {
    alignItems: 'center',
    marginTop: 0, marginBottom: 0,
  },
  rewardPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: 999, borderWidth: 1,
  },
  rewardEmoji: { fontSize: 22, lineHeight: 26 },
  rewardLabel: { fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
  rewardStat: {
    fontSize: 11, fontWeight: '600',
    color: 'rgba(255,255,255,0.62)',
    marginTop: 1,
  },

  // §B.1 Consent — inside hero card, no top margin (card gap owns spacing)
  consentRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingVertical: 10,
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)',
    borderRadius: 10, marginTop: 0,
  },
  consentBox: {
    width: 18, height: 18, borderRadius: 4,
    borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.40)',
    backgroundColor: 'transparent', alignItems: 'center', justifyContent: 'center',
  },
  consentBoxChecked: {
    backgroundColor: '#09D1C7', borderColor: '#09D1C7',
  },
  consentTick: { color: '#0b1018', fontSize: 12, fontWeight: '900', lineHeight: 14 },
  consentText: {
    flex: 1, color: 'rgba(255,255,255,0.78)', fontSize: 12, lineHeight: 17,
  },

  // §B.2 CTA — the anchor (inside hero card, no top margin)
  cta: {
    marginTop: 0, paddingHorizontal: 24, paddingVertical: 22,
    minHeight: 110, borderRadius: 18,
    backgroundColor: '#09D1C7',
    alignItems: 'center', justifyContent: 'center', gap: 6,
    // Drop shadow + inset highlight — RN approximation of PWA's
    // mint-glow + 1px inner ring + 1px top highlight.
    shadowColor: '#09D1C7', shadowOpacity: 0.32, shadowRadius: 18, shadowOffset: { width: 0, height: 12 },
    elevation: 10,
  },
  ctaDisabled: {
    backgroundColor: 'rgba(9, 209, 199, 0.30)',
    shadowOpacity: 0.10,
  },
  ctaRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  ctaPlay: { color: '#062b1b', fontSize: 20, fontWeight: '900' },
  ctaLabel: {
    // Phase 1 v5: bumped from 22 to 24 to match the PWA's
    // clamp(1.2rem, 4.6vw, 1.7rem) — gives the CTA the dominant
    // visual weight the operator asked for ("make CTA dominant").
    color: '#062b1b', fontSize: 24, fontWeight: '800', letterSpacing: -0.005,
  },
  ctaSub: {
    color: 'rgba(6, 43, 27, 0.66)',
    fontSize: 11, fontWeight: '600',
    letterSpacing: 1.5, textTransform: 'uppercase',
  },

  // §B.3 Utility row — bottom-portion refresh: bigger frosted-glass tiles
  utilityRow: {
    flexDirection: 'row', alignItems: 'stretch', gap: 8,
    marginTop: 14, width: '100%',
  },
  utilityTile: {
    flex: 1, minHeight: 78,
    paddingHorizontal: 6, paddingVertical: 12,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 18,
    borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center', justifyContent: 'center', gap: 6,
    position: 'relative',
  },
  utilityIcon: { fontSize: 24, lineHeight: 28, color: '#09D1C7' },
  utilityLabel: {
    color: Colors.text, fontSize: 11, fontWeight: '700',
    textAlign: 'center', lineHeight: 14,
  },
  utilityStatusDot: {
    position: 'absolute', top: 6, right: 6,
    width: 8, height: 8, borderRadius: 4,
    borderWidth: 1.5, borderColor: Colors.bg,
  },

  // §C.0 Pulse stat block — Phase 3 v5 + bottom-portion refresh
  pulseBlock: {
    alignItems: 'center', justifyContent: 'center',
    paddingTop: 28, paddingBottom: 18,
    marginTop: 14, marginBottom: 10,
    position: 'relative',
    minHeight: 180,
  },
  // Bottom-portion refresh — single dominant halo (≈220 px) replacing
  // the prior dual-ring. Two `pulseRing` instances still render (one
  // animated, one slower) so the breath effect survives, but both
  // are now sized to dominate the centre. PWA parity:
  // .home-impact-reports-nearby .hi-cell-reports-nearby::before/::after.
  pulseRing: {
    position: 'absolute',
    width: 220, height: 220,
    top: '50%', left: '50%',
    marginTop: -110, marginLeft: -110,
    borderRadius: 110,
    borderWidth: 1, borderColor: 'rgba(70, 223, 177, 0.32)',
    backgroundColor: 'rgba(70, 223, 177, 0.08)',
  },
  pulseRingStatic: {
    opacity: 0.45,   // reduced-motion fallback
  },
  // May 2026 bottom-portion refresh — operator screenshot has a
  // dominant centre number with subtle teal halo + smaller dim
  // label below. Mirrors the PWA's .home-impact-reports-nearby
  // .hi-num-reports-nearby clamp.
  pulseNum: {
    fontSize: 60, fontWeight: '900', color: '#80EE98',
    lineHeight: 62, letterSpacing: -2,
    textShadowColor: 'rgba(128, 238, 152, 0.32)',
    textShadowRadius: 22,
    textShadowOffset: { width: 0, height: 0 },
  },
  pulseLabel: {
    fontSize: 13, fontWeight: '500',
    color: 'rgba(255, 255, 255, 0.62)',
    letterSpacing: 0.1, marginTop: 4,
    textAlign: 'center',
  },

  // §C.1 Channels
  channelsSection: { marginTop: 14, marginBottom: 8 },
  channelsTitle: {
    fontSize: 10, fontWeight: '700',
    letterSpacing: 1.6, textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.42)',
    textAlign: 'center', marginBottom: 6,
  },
  // Bottom-portion refresh — bigger tiles matching the operator
  // screenshot's premium proportions; 3-col grid via width: 31% + gap.
  channelsGrid: {
    flexDirection: 'row', flexWrap: 'wrap',
    gap: 10,
  },
  channelTile: {
    width: '31%',
    minHeight: 92, padding: 12, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)',
    alignItems: 'center', justifyContent: 'center', gap: 4,
    position: 'relative',
  },
  channelTileLive: {
    backgroundColor: 'rgba(70, 223, 177, 0.08)',
    borderColor: 'rgba(70, 223, 177, 0.36)',
  },
  channelIcon: { fontSize: 26, lineHeight: 30 },
  channelLabel: {
    fontSize: 14, fontWeight: '800',
    color: Colors.text, textAlign: 'center',
    letterSpacing: -0.1,
  },
  channelStatus: {
    fontSize: 11, fontWeight: '500',
    color: 'rgba(255, 255, 255, 0.48)',
    textAlign: 'center', marginTop: 2,
  },
  // v7 (May 2026, operator) — clean solid green dot at top-right of
  // .is-live channel tiles (Telegram, IVR). Replaces both:
  //   · the v168.1 glowing-green "Live" text (now hidden via the
  //     ternary in JSX above), and
  //   · the v168 dual-dot mess (one pip + one ::after were both
  //     showing pre-v168.1).
  // Plain disk, no glow, matches the v6.5 lang-pill dot treatment.
  channelLiveDot: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: '#80EE98',
  },
  // Kept as an orphan style for now (channelStatusLive) so any future
  // surface that wants the glowing-text variant can resurrect it.
  channelStatusLive: {
    color: '#80EE98',
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },

  // §C.2 Queue badge (kept for parity)
  queueBadge: {
    marginTop: 4, padding: 8, borderRadius: 8,
    backgroundColor: 'rgba(234, 179, 8, 0.08)',
    borderWidth: 1, borderColor: 'rgba(234, 179, 8, 0.30)',
    alignItems: 'center',
  },
  queueText: { color: '#fde047', fontSize: 12, fontWeight: '600' },

  // §C.3 Footer — v2 pass (May 2026, operator screenshot). Single
  // horizontal row, links left + pill right, separated by space-
  // between. The earlier values (font 12, dot ·, pill padding 14/6,
  // text alpha 0.78) read as faint vs the reference; v2 bumps to
  // visible weights and switches the separator from middle-dot to
  // bullet, matching the PWA twin. nowrap so the row stays a single
  // line at standard phone widths.
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'nowrap',
    gap: 12,
    marginTop: 12, paddingTop: 16,
    borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.08)',
  },
  footerLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flexWrap: 'nowrap',
    flexShrink: 1,
    minWidth: 0,
  },
  footerLink: {
    color: 'rgba(203, 213, 225, 0.75)', fontSize: 13, fontWeight: '500',
  },
  footerDot: { color: 'rgba(148, 163, 184, 0.55)', fontSize: 13 },
  footerVersion: { color: 'rgba(255,255,255,0.32)', fontSize: 11 },

  // §C.4 Device-ID — pill sits inline in the footer row now. v2:
  // roomier padding, slightly stronger bg + border, bigger / bolder
  // text to match the reference screenshot's capsule weight.
  devidWrap: { alignItems: 'center', marginTop: 4 },
  devidBadge: {
    paddingHorizontal: 18, paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
    borderRadius: 999,
  },
  devidText: {
    fontFamily: 'SpaceMono-Regular',
    color: '#fff', fontSize: 12.5, fontWeight: '700',
    letterSpacing: 1.0,
  },
});
