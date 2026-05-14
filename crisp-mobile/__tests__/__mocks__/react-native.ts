/**
 * Minimal react-native mock for jest on node. Covers ONLY the surface the
 * service-layer files touch at import time (NativeModules + I18nManager).
 * UI components return null no-ops so screen modules can be imported in
 * pure-Node tests without throwing.
 *
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

// May 2026 — UI component stubs so screen modules (e.g.
// screens/HomeScreen.tsx) can `import { View, Text, ... } from
// 'react-native'` without crashing the Node test runtime. None of
// these actually render; the tests treat them as pure markers for
// structural assertions only.
const _Noop = (_props?: any) => null;
export const View = _Noop;
export const Text = _Noop;
export const ScrollView = _Noop;
export const TouchableOpacity = _Noop;
export const Pressable = _Noop;
export const Image = _Noop;
export const TextInput = _Noop;
export const Switch = _Noop;
export const ActivityIndicator = _Noop;
export const Modal = _Noop;
export const SafeAreaView = _Noop;
export const KeyboardAvoidingView = _Noop;
export const FlatList = _Noop;
export const SectionList = _Noop;
export const RefreshControl = _Noop;
export const StatusBar = _Noop;

// StyleSheet — only `.create` is needed; it's a pass-through that
// returns the input object untouched. Test code that pokes at a
// component's resolved styles can do so via the stylesheet object
// directly.
export const StyleSheet = {
    create: <T extends Record<string, any>>(s: T): T => s,
    flatten: <T>(s: T): T => s,
    hairlineWidth: 1,
    absoluteFill: {},
    absoluteFillObject: {},
};

// Animated / Easing — stubs so any `Animated.Value(...)` call at
// module load doesn't crash. Tests don't exercise animations.
export const Animated = {
    Value: function (v: number) { (this as any).__value = v; },
    timing: () => ({ start: (cb?: () => void) => { cb && cb(); } }),
    spring: () => ({ start: (cb?: () => void) => { cb && cb(); } }),
    parallel: (..._a: any[]) => ({ start: (cb?: () => void) => { cb && cb(); } }),
    sequence: (..._a: any[]) => ({ start: (cb?: () => void) => { cb && cb(); } }),
    View: _Noop,
    Text: _Noop,
    createAnimatedComponent: <T>(c: T): T => c,
};
export const Easing = {
    in:    (f: any) => f,
    out:   (f: any) => f,
    inOut: (f: any) => f,
    linear: (t: number) => t,
    ease: (t: number) => t,
    bezier: () => (t: number) => t,
};

// Linking — stubbed so deep-link calls in tests don't crash.
export const Linking = {
    openURL: () => Promise.resolve(),
    canOpenURL: () => Promise.resolve(true),
    addEventListener: () => ({ remove() {} }),
    removeEventListener: () => {},
    getInitialURL: () => Promise.resolve<string | null>(null),
};

// useWindowDimensions hook — returns a sensible iPhone 14 default.
export const useWindowDimensions = () => ({ width: 390, height: 844, scale: 3, fontScale: 1 });

// Platform — RN tests run as iOS by default.
export const Platform = {
    OS: 'ios' as 'ios' | 'android' | 'web',
    Version: 17,
    select: <T>(spec: { ios?: T; android?: T; default?: T }): T | undefined =>
        spec.ios ?? spec.default,
    isPad: false, isTV: false, isTesting: true,
};

// Alert + Dimensions — small stubs.
export const Alert = {
    alert: (..._a: any[]) => { /* no-op */ },
};
export const Dimensions = {
    get: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
    addEventListener: () => ({ remove() {} }),
};

// InteractionManager — used by App.tsx in a `runAfterInteractions`
// helper at module load.
export const InteractionManager = {
    runAfterInteractions: (cb: () => void) => { cb(); return { cancel() {} }; },
};

// expo-image-manipulator and similar modules won't actually import in these
// pure-function tests; if a test ever needs them, add a stub here rather
// than pulling in the real jest-expo preset (which has been unreliable).
