/**
 * Minimal expo-localization mock for jest. Only `getLocales()` is read by
 * services/i18n.ts — no other surface needs covering. Individual tests can
 * override via `jest.mock('expo-localization', () => ({...}))` when they
 * need a non-EN default.
 */
export function getLocales() {
    return [{ languageCode: 'en', regionCode: 'US' }];
}
