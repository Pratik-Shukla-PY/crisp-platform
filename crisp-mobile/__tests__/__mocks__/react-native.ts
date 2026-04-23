/**
 * Minimal react-native mock for jest on node. Covers ONLY the surface the
 * service-layer files touch at import time (NativeModules + I18nManager).
 * UI components are never exercised in these tests — they belong to
 * integration/UI tests which need a real RN runtime.
 */
export const NativeModules: Record<string, any> = {
    DevSettings: { reload: () => { /* no-op */ } },
};

const _I18nManagerState = {
    isRTL: false,
    allowRTL(_v: boolean) { /* no-op */ },
    forceRTL(v: boolean) { _I18nManagerState.isRTL = !!v; },
    swapLeftAndRightInRTL(_v: boolean) { /* no-op */ },
};

export const I18nManager = _I18nManagerState;

// expo-image-manipulator and similar modules won't actually import in these
// pure-function tests; if a test ever needs them, add a stub here rather
// than pulling in the real jest-expo preset (which has been unreliable).
