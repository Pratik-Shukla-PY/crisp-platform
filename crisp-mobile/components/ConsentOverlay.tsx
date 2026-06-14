/**
 * ConsentOverlay - first-launch privacy consent gate.
 *
 * React Native equivalent of the PWA `#consent-overlay`
 * (mobile-app/src/index.html:29–52). Blocks the render tree behind a
 * modal backdrop until the user ticks the checkbox and taps Accept.
 *
 * Pure component: persistence of the `crisp_privacy_consent` key is the
 * parent's responsibility (AsyncStorage write of `{ accepted: true, ts }`).
 * This keeps the overlay testable and reusable for re-prompt flows.
 *
 * Accessibility: honors `AccessibilityInfo.isReduceMotionEnabled()` by
 * disabling the fade animation when the OS setting is on. Read once on
 * mount - the value rarely changes mid-session and re-subscribing would
 * add a listener for a setting that only fires on OS toggle.
 */
import React, { useEffect, useState } from 'react';
import {
  AccessibilityInfo,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import FontAwesome5 from '@expo/vector-icons/FontAwesome5';

import { Colors } from '../constants/colors';
import { t } from '../services/i18n';

type Props = {
  visible: boolean;
  onAccept: () => void;
};

function ConsentOverlay({ visible, onAccept }: Props): React.ReactElement {
  const [checked, setChecked] = useState<boolean>(false);
  const [reduceMotion, setReduceMotion] = useState<boolean>(false);

  useEffect(() => {
    // Read once on mount - per-component listener not worth the overhead
    // for a gate that typically unmounts within seconds of first render.
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => setReduceMotion(enabled))
      .catch(() => {
        /* non-fatal - fall through with animations enabled */
      });
  }, []);

  const handleAccept = (): void => {
    if (!checked) return;
    onAccept();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      // Android back-button press is a no-op: the consent gate is
      // intentionally non-dismissable. Parity with the PWA, which has
      // no ✕ affordance on #consent-overlay.
      onRequestClose={() => {
        /* no-op - consent cannot be skipped */
      }}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <View style={styles.iconWrap}>
            <FontAwesome5 name="shield-alt" size={32} color={Colors.accent} />
          </View>

          <Text style={styles.title}>{t('consent_title')}</Text>
          <Text style={styles.desc}>{t('consent_desc')}</Text>

          <View style={styles.bullets}>
            <View style={styles.bulletRow}>
              <FontAwesome5
                name="map-marker-alt"
                size={14}
                color={Colors.accent}
                style={styles.bulletIcon}
              />
              <Text style={styles.bulletText}>{t('consent_loc')}</Text>
            </View>
            <View style={styles.bulletRow}>
              <FontAwesome5
                name="camera"
                size={14}
                color={Colors.accent}
                style={styles.bulletIcon}
              />
              <Text style={styles.bulletText}>{t('consent_photo')}</Text>
            </View>
            <View style={styles.bulletRow}>
              <FontAwesome5
                name="microphone"
                size={14}
                color={Colors.accent}
                style={styles.bulletIcon}
              />
              <Text style={styles.bulletText}>{t('consent_audio')}</Text>
            </View>
          </View>

          <View style={styles.assurances}>
            <View style={styles.bulletRow}>
              <FontAwesome5
                name="user-slash"
                size={13}
                color={Colors.green}
                style={styles.bulletIcon}
              />
              <Text style={styles.assuranceText}>{t('consent_no_pii')}</Text>
            </View>
            <View style={styles.bulletRow}>
              <FontAwesome5
                name="lock"
                size={13}
                color={Colors.green}
                style={styles.bulletIcon}
              />
              <Text style={styles.assuranceText}>{t('consent_shared')}</Text>
            </View>
            <View style={styles.bulletRow}>
              <FontAwesome5
                name="trash-alt"
                size={13}
                color={Colors.green}
                style={styles.bulletIcon}
              />
              <Text style={styles.assuranceText}>{t('consent_delete')}</Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.checkRow}
            onPress={() => setChecked((v) => !v)}
            activeOpacity={0.7}
            accessibilityRole="checkbox"
            accessibilityState={{ checked }}
          >
            <View style={[styles.checkbox, checked && styles.checkboxChecked]}>
              {checked ? (
                <FontAwesome5 name="check" size={12} color={Colors.white} />
              ) : null}
            </View>
            <Text style={styles.checkLabel}>{t('consent_check')}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.acceptBtn, !checked && styles.acceptBtnDisabled]}
            disabled={!checked}
            onPress={handleAccept}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityState={{ disabled: !checked }}
          >
            <FontAwesome5
              name="check"
              size={14}
              color={Colors.white}
              style={styles.acceptIcon}
            />
            <Text style={styles.acceptText}>{t('consent_accept')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    // 0.82 matches the PWA's rgba(10,14,26,0.82) backdrop tint.
    backgroundColor: 'rgba(10,14,26,0.82)',
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: Colors.surface2,
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  iconWrap: {
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.white,
    textAlign: 'center',
    marginBottom: 8,
  },
  desc: {
    fontSize: 14,
    color: Colors.textDim,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 16,
  },
  bullets: {
    marginBottom: 14,
  },
  bulletRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  bulletIcon: {
    marginRight: 8,
    width: 18,
    textAlign: 'center',
  },
  bulletText: {
    flex: 1,
    fontSize: 13,
    color: Colors.text,
    lineHeight: 18,
  },
  assurances: {
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: 12,
    marginBottom: 14,
  },
  assuranceText: {
    flex: 1,
    fontSize: 13,
    color: Colors.textDim,
    lineHeight: 18,
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 16,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 2,
    borderColor: Colors.textDim,
    marginRight: 10,
    marginTop: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  checkboxChecked: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  checkLabel: {
    flex: 1,
    fontSize: 13,
    color: Colors.text,
    lineHeight: 18,
  },
  acceptBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.accent,
    paddingVertical: 14,
    borderRadius: 12,
  },
  acceptBtnDisabled: {
    opacity: 0.35,
  },
  acceptIcon: {
    marginRight: 8,
  },
  acceptText: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.white,
  },
});

export default ConsentOverlay;
