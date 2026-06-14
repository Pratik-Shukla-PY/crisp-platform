#!/usr/bin/env node
// scripts/build-locale-skeletons.mjs
// ─────────────────────────────────────────────────────────────────────
// Builds (and refreshes) the i18n locale JSON files so every locale
// has 100 % key coverage versus en.json (the canonical source).
//
//   • Existing native translations are preserved.
//   • Missing keys are filled with the English value as a placeholder.
//   • Each locale gets a __meta__ block listing coverage stats and the
//     gap_keys array (keys pending native review).
//
// Idempotent. Safe to re-run after any en.json edit; gap_keys auto-
// recomputed every run. Tier 1 (UN) locales are touched only to refresh
// __meta__; their values are not changed.
//
// Usage:
//   node scripts/build-locale-skeletons.mjs            # write
//   node scripts/build-locale-skeletons.mjs --dry-run  # report only
//
// UNDP submission deliverable. See
// docs/i18n-workflow.md.

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const I18N_DIR = join(ROOT, 'mobile-app', 'src', 'i18n');
const DRY_RUN = process.argv.includes('--dry-run');

// Tier metadata. Order here also drives the picker render order
// downstream (UN tier-1 first, then tier-2, then tier-3).
const ALL_LOCALES = [
    // Tier 1 - UN official
    { code: 'ar', tier: 1, name: 'Arabic',     native: 'العربية' },
    { code: 'zh', tier: 1, name: 'Mandarin',   native: '中文' },
    { code: 'es', tier: 1, name: 'Spanish',    native: 'Español' },
    { code: 'fr', tier: 1, name: 'French',     native: 'Français' },
    { code: 'ru', tier: 1, name: 'Russian',    native: 'Русский' },
    // Tier 2 - UNDP submission set
    { code: 'hi', tier: 2, name: 'Hindi',      native: 'हिन्दी' },
    { code: 'pt', tier: 2, name: 'Portuguese', native: 'Português' },
    { code: 'bn', tier: 2, name: 'Bengali',    native: 'বাংলা' },
    { code: 'ja', tier: 2, name: 'Japanese',   native: '日本語' },
    { code: 'tr', tier: 2, name: 'Turkish',    native: 'Türkçe' },
    { code: 'vi', tier: 2, name: 'Vietnamese', native: 'Tiếng Việt' },
    { code: 'ko', tier: 2, name: 'Korean',     native: '한국어' },
    { code: 'id', tier: 2, name: 'Indonesian', native: 'Bahasa Indonesia' },
    { code: 'ur', tier: 2, name: 'Urdu',       native: 'اردو' },
    // Tier 3 - Indian sub-national
    { code: 'kn', tier: 3, name: 'Kannada',    native: 'ಕನ್ನಡ' },
    { code: 'ta', tier: 3, name: 'Tamil',      native: 'தமிழ்' },
    { code: 'te', tier: 3, name: 'Telugu',     native: 'తెలుగు' },
    { code: 'ml', tier: 3, name: 'Malayalam',  native: 'മലയാളം' },
    { code: 'gu', tier: 3, name: 'Gujarati',   native: 'ગુજરાતી' },
    { code: 'mr', tier: 3, name: 'Marathi',    native: 'मराठी' },
    { code: 'pa', tier: 3, name: 'Punjabi',    native: 'ਪੰਜਾਬੀ' },
];

// ── Load canonical en.json ─────────────────────────────────────────────
const enPath = join(I18N_DIR, 'en.json');
if (!existsSync(enPath)) {
    console.error(`[FATAL] ${enPath} not found`);
    process.exit(1);
}
const enRaw = JSON.parse(readFileSync(enPath, 'utf8'));
// en.json has its own __meta__ block; skip it when iterating keys.
const enKeys = Object.keys(enRaw).filter(k => k !== '__meta__');
const enLookup = {};
for (const k of enKeys) enLookup[k] = enRaw[k];
console.log(`canonical en.json: ${enKeys.length} keys`);

const now = new Date().toISOString();
const reports = [];

// ── Build / refresh each locale ────────────────────────────────────────
for (const loc of ALL_LOCALES) {
    const path = join(I18N_DIR, `${loc.code}.json`);
    let existing = {};
    let preexisting = false;
    if (existsSync(path)) {
        existing = JSON.parse(readFileSync(path, 'utf8'));
        preexisting = true;
    }
    // Strip any pre-existing __meta__ - we rebuild it below.
    delete existing.__meta__;

    // For each en-key:
    //   • if existing has a native value (!== English value), keep it.
    //   • if existing has the same value as English, treat as
    //     EN-placeholder (still counted in gap_keys).
    //   • if missing, fill with the English value.
    const merged = {};
    const gapKeys = [];
    const translated = [];
    for (const k of enKeys) {
        const enVal = enLookup[k];
        if (Object.prototype.hasOwnProperty.call(existing, k)) {
            const v = existing[k];
            if (typeof v === 'string' && v.length > 0 && v !== enVal) {
                merged[k] = v;
                translated.push(k);
            } else {
                merged[k] = enVal;
                gapKeys.push(k);
            }
        } else {
            merged[k] = enVal;
            gapKeys.push(k);
        }
    }

    const coverage = enKeys.length
        ? Math.round((translated.length / enKeys.length) * 1000) / 10
        : 0;

    const status = gapKeys.length === 0
        ? 'complete'
        : (gapKeys.length === enKeys.length ? 'skeleton-only' : 'partial');

    const source = gapKeys.length === 0
        ? 'native'
        : (gapKeys.length === enKeys.length
            ? 'en-placeholder (pending manual review)'
            : 'mixed (native + en-placeholder)');

    const meta = {
        generator: 'scripts/build-locale-skeletons.mjs',
        locale: loc.code,
        locale_name: loc.name,
        native_name: loc.native,
        tier: loc.tier,
        translation_status: status,
        translation_source: source,
        en_key_count: enKeys.length,
        translated_key_count: translated.length,
        gap_key_count: gapKeys.length,
        coverage_percent: coverage,
        generated_at: now,
        // gap_keys excluded from tier-1 (UN) when complete to keep diff
        // small; for partial / skeleton locales it's the actionable list
        // a translator works from.
        gap_keys: gapKeys,
    };

    if (!DRY_RUN) {
        const out = { __meta__: meta };
        for (const k of enKeys) out[k] = merged[k];
        writeFileSync(path, JSON.stringify(out, null, 2) + '\n', 'utf8');
    }

    reports.push({
        code: loc.code,
        tier: loc.tier,
        coverage,
        translated: translated.length,
        gap: gapKeys.length,
        preexisting,
        status,
    });
}

// ── Print report ───────────────────────────────────────────────────────
const banner = '─'.repeat(64);
console.log('\nLocale build report' + (DRY_RUN ? ' (DRY-RUN)' : ''));
console.log(banner);
console.log(
    'code  tier  translated/total   cov%    status'
);
console.log(banner);
for (const r of reports) {
    const cov = String(r.coverage).padStart(5);
    const tr = String(r.translated).padStart(3);
    const total = String(enKeys.length).padStart(3);
    console.log(
        `${r.code.padEnd(5)} T${r.tier}    ${tr}/${total}            ${cov}%   ${r.status}`
        + (r.preexisting ? '' : '   (new file)')
    );
}
console.log(banner);
const totalTranslated = reports.reduce((a, r) => a + r.translated, 0);
const totalCells = reports.length * enKeys.length;
const aggCov = Math.round((totalTranslated / totalCells) * 1000) / 10;
console.log(
    `Aggregate: ${totalTranslated}/${totalCells} cells translated `
    + `across ${reports.length} locales (${aggCov}% coverage)`
);
console.log();

if (DRY_RUN) {
    console.log('Dry run - no files written.');
}
