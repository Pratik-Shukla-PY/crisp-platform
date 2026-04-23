/**
 * i18n.ts — locale resolver + t() fallback chain (Apr 2026 Phase 4.5).
 *
 * The RN app has to pick a language on first launch without a network
 * round-trip. Four invariants this file pins:
 *
 *  (a) `detectLanguage()` returns a string that exists in `translations`
 *      — never returns a code that would make t() always fall back to EN.
 *  (b) `isRTLLocale('ar' | 'ur' | 'fa' | 'he')` is true; `'en'|'fr'|…`
 *      is false. RTL set matches the PWA (see RTL_LANGS constant).
 *  (c) `t(key)` falls back to EN when the active locale has no entry
 *      for that key, and falls back to the raw key when EN also misses.
 *  (d) `setLanguage()` persists via AsyncStorage (the mocked in-memory
 *      store) so `bootstrapLanguage()` round-trips the choice.
 *  (e) `getAvailableLanguages()` includes every UN language marked with
 *      `un: true` — pinned so the picker can't silently drop Arabic /
 *      Chinese / Russian in a refactor.
 */

jest.spyOn(console, 'log').mockImplementation(() => {});

// Mock expo-localization's getLocales() so tests are deterministic. The
// default mock returns a single EN locale.
jest.mock('expo-localization', () => ({
    getLocales: () => [{ languageCode: 'en', regionCode: 'US' }],
}));

import {
    detectLanguage,
    isRTLLocale,
    t,
    setLanguage,
    getLanguage,
    bootstrapLanguage,
    getAvailableLanguages,
} from '../services/i18n';
import { __resetAsyncStorageMock } from './__mocks__/async-storage';
import AsyncStorage from '@react-native-async-storage/async-storage';

describe('i18n.detectLanguage', () => {
    test('returns a known translation code (never an unsupported one)', () => {
        // With the default expo-localization mock returning 'en',
        // detectLanguage must return 'en'.
        expect(detectLanguage()).toBe('en');
    });
});

describe('i18n.isRTLLocale', () => {
    test.each([
        ['ar', true],
        ['ur', true],
        ['fa', true],
        ['he', true],
        ['ps', true],
        ['en', false],
        ['fr', false],
        ['zh', false],
        ['ru', false],
        ['XX-unknown', false],
    ])('isRTLLocale(%s) === %s', (code, expected) => {
        expect(isRTLLocale(code as string)).toBe(expected);
    });
});

describe('i18n.t() fallback chain', () => {
    beforeEach(() => { setLanguage('en'); });

    test('known EN key resolves', () => {
        // app_name is present in the EN translations object at module load.
        expect(t('app_name')).toBeTruthy();
        expect(typeof t('app_name')).toBe('string');
    });

    test('unknown key returns the key itself (last-resort fallback)', () => {
        const bogus = `__definitely_not_a_real_key_${Date.now()}`;
        expect(t(bogus)).toBe(bogus);
    });

    test('switching to a non-existent locale falls back to EN', () => {
        setLanguage('klingon-unsupported');
        // `setLanguage` resolves unknown codes back to 'en' internally;
        // t() therefore should hit the EN branch with a real string,
        // not return raw 'app_name'.
        expect(t('app_name')).not.toBe('app_name');
        expect(getLanguage()).toBe('en');
    });
});

describe('i18n.setLanguage persistence', () => {
    beforeEach(() => __resetAsyncStorageMock());

    test('setLanguage(code) writes crisp_lang_manual to AsyncStorage', async () => {
        setLanguage('fr');
        // setLanguage is fire-and-forget on AsyncStorage — give the
        // microtask a turn before asserting.
        await Promise.resolve();
        await Promise.resolve();
        const stored = await AsyncStorage.getItem('crisp_lang_manual');
        expect(stored).toBe('fr');
    });

    test('bootstrapLanguage() honours a previously stored choice', async () => {
        await AsyncStorage.setItem('crisp_lang_manual', 'es');
        const resolved = await bootstrapLanguage();
        expect(resolved).toBe('es');
        expect(getLanguage()).toBe('es');
    });
});

describe('i18n.getAvailableLanguages', () => {
    test('includes every UN official language with un:true', () => {
        const langs = getAvailableLanguages();
        const unCodes = new Set(
            langs.filter((l) => l.un).map((l) => l.code),
        );
        for (const expected of ['en', 'fr', 'es', 'ar', 'ru', 'zh']) {
            expect(unCodes.has(expected)).toBe(true);
        }
    });

    test('every emitted language has code + label + flag fields', () => {
        const langs = getAvailableLanguages();
        expect(langs.length).toBeGreaterThan(6);
        for (const l of langs) {
            expect(typeof l.code).toBe('string');
            expect(typeof l.label).toBe('string');
            // Flag can be empty string for minimally-metadata'd codes.
            expect(typeof l.flag).toBe('string');
            expect(typeof l.un).toBe('boolean');
        }
    });
});
