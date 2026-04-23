/**
 * Minimal @react-native-community/netinfo mock for jest. The real module
 * throws at import time on node because RNCNetInfo is a native module.
 * Tests call `fetch()` directly via networkAdaptive; we return the most
 * conservative baseline (OFFLINE-equivalent) so tests never hit an
 * "online" code path they didn't opt into.
 */
export default {
    async fetch() {
        return {
            type: 'unknown',
            isConnected: false,
            isInternetReachable: null,
            details: {},
        };
    },
    addEventListener() { return () => {}; },
    useNetInfo() {
        return { type: 'unknown', isConnected: false };
    },
};
