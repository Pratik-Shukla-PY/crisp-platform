/**
 * Inline pack coverage + integrity gate — AUDIT 2026-05-23.
 *
 * Builds on scripts/validate-home-i18n-packs.mjs but runs in the
 * Playwright @smoke suite so it's part of every PR's regression check
 * even if the developer skipped the pre-commit hook. Asserts:
 *   1. window.__crispHomeI18nPacks exists and parses as an object
 *   2. __meta block has buildTs, scriptVersion, locales[22]
 *   3. All 22 supported locales are present
 *   4. Every pack has __version + __checksum fields
 *   5. Every key in EN pack is present in every other pack
 *
 * Failure modes this catches:
 *   - Developer regenerated en.json but forgot to re-run gen-script
 *   - Pre-commit hook bypassed via --no-verify
 *   - CI artifact didn't include the generated inline block
 *   - HTML cache served stale block from a deploy mid-rollout
 */
import { test, expect } from '@playwright/test';

const SUPPORTED_LOCALES = [
    'en', 'zh', 'es', 'ar', 'fr', 'ru',
    'hi', 'pt', 'bn', 'ja', 'tr', 'vi', 'ko', 'id', 'ur',
    'kn', 'ta', 'te', 'ml', 'gu', 'mr', 'pa',
];

test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
    });
    await page.goto('index.html');
    await page.waitForLoadState('domcontentloaded');
});

test('@smoke window.__crispHomeI18nPacks present + __meta valid', async ({ page }) => {
    const meta = await page.evaluate(() => {
        const p = (window as any).__crispHomeI18nPacks;
        return p && p.__meta ? {
            buildTs: p.__meta.buildTs,
            scriptVersion: p.__meta.scriptVersion,
            localeCount: Array.isArray(p.__meta.locales) ? p.__meta.locales.length : null,
        } : null;
    });
    expect(meta).not.toBeNull();
    expect(meta!.buildTs).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta!.scriptVersion).toBeGreaterThanOrEqual(2);
    expect(meta!.localeCount).toBe(22);
});

test('all 22 locales present + carry __version + __checksum', async ({ page }) => {
    const packsInfo = await page.evaluate((locales) => {
        const p = (window as any).__crispHomeI18nPacks || {};
        return locales.map((code) => {
            const pack = p[code];
            return {
                code,
                exists: !!pack,
                hasVersion: !!(pack && pack.__version && /^[a-f0-9]{12}$/.test(pack.__version)),
                hasChecksum: !!(pack && pack.__checksum && /^[a-f0-9]{16}$/.test(pack.__checksum)),
                keyCount: pack ? Object.keys(pack).length - 2 : 0,  // minus __version, __checksum
            };
        });
    }, SUPPORTED_LOCALES);

    for (const info of packsInfo) {
        expect(info.exists, `pack ${info.code} missing`).toBe(true);
        expect(info.hasVersion, `pack ${info.code} __version malformed`).toBe(true);
        expect(info.hasChecksum, `pack ${info.code} __checksum malformed`).toBe(true);
    }
});

test('EN pack key set is mirrored in every other pack', async ({ page }) => {
    const diff = await page.evaluate((locales) => {
        const p = (window as any).__crispHomeI18nPacks || {};
        const enPack = p.en || {};
        const enKeys = Object.keys(enPack).filter(k => !k.startsWith('__'));
        const issues: Array<{ code: string; missing: string[] }> = [];
        for (const code of locales) {
            if (code === 'en') continue;
            const pack = p[code] || {};
            const missing = enKeys.filter(k => !Object.prototype.hasOwnProperty.call(pack, k));
            if (missing.length) issues.push({ code, missing });
        }
        return issues;
    }, SUPPORTED_LOCALES);

    expect(diff, `${diff.length} locale(s) missing keys vs EN: ` +
        diff.map(d => `${d.code}(${d.missing.length})`).join(', ')).toEqual([]);
});
