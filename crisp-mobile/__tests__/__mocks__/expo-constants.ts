/**
 * expo-constants stub for node-side jest. The real module is ESM-only.
 * `services/api.ts` reads `Constants.expoConfig?.extra?.BACKEND_URL` and
 * `Constants.manifest2?.extra?.expoClient?.hostUri` — return empty
 * surfaces so the fallback host-resolver branch fires.
 */
export default {
    expoConfig: { extra: {} },
    manifest2: { extra: { expoClient: {} } },
};
