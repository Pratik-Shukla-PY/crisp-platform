#!/usr/bin/env node
// scripts/apply-translations.mjs
// ─────────────────────────────────────────────────────────────────────
// Applies a per-locale translation patch onto
// `mobile-app/src/i18n/{lang}.json`. Patches live at
// `scripts/translations/{lang}.json` and contain only the key →
// nativeValue pairs that need updating; the existing JSON's other
// keys are preserved.
//
// Usage:
//   node scripts/apply-translations.mjs <lang>         # apply one locale
//   node scripts/apply-translations.mjs --all          # apply every patch
//   node scripts/apply-translations.mjs <lang> --dry-run
//
// After applying, run `node scripts/build-locale-skeletons.mjs` to
// refresh the __meta__ block (coverage stats / gap_keys).
//
// Phase 25 (May 2026) — used to land native translations en-masse
// for the 22-locale UNDP submission set.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const I18N_DIR = join(ROOT, 'mobile-app', 'src', 'i18n');
const PATCH_DIR = join(__dirname, 'translations');

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const ALL = args.includes('--all');
const langArg = args.find(a => !a.startsWith('--'));

if (!langArg && !ALL) {
    console.error('Usage: apply-translations.mjs <lang>|--all [--dry-run]');
    process.exit(1);
}

const locales = ALL
    ? readdirSync(PATCH_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''))
    : [langArg];

const results = [];
for (const code of locales) {
    const patchPath = join(PATCH_DIR, `${code}.json`);
    const localePath = join(I18N_DIR, `${code}.json`);
    if (!existsSync(patchPath)) {
        results.push({ code, status: 'no-patch' });
        continue;
    }
    if (!existsSync(localePath)) {
        results.push({ code, status: 'no-locale-json' });
        continue;
    }
    const patch = JSON.parse(readFileSync(patchPath, 'utf8'));
    const locale = JSON.parse(readFileSync(localePath, 'utf8'));
    let applied = 0;
    let skipped = 0;
    for (const k of Object.keys(patch)) {
        if (k === '__meta__') continue;
        if (typeof patch[k] !== 'string') { skipped++; continue; }
        if (locale[k] === patch[k]) { skipped++; continue; }
        locale[k] = patch[k];
        applied++;
    }
    // Bump __meta__ for transparency.
    if (locale.__meta__) {
        locale.__meta__.last_translation_patch = new Date().toISOString();
        locale.__meta__.last_translation_patch_applied = applied;
    }
    if (!DRY && applied > 0) {
        writeFileSync(localePath, JSON.stringify(locale, null, 2) + '\n', 'utf8');
    }
    results.push({ code, applied, skipped, status: 'ok' });
}

console.log('Translation patch report' + (DRY ? ' (DRY-RUN)' : ''));
console.log('─'.repeat(48));
let totalApplied = 0;
for (const r of results) {
    if (r.status === 'ok') {
        console.log(`  ${r.code.padEnd(5)} applied ${String(r.applied).padStart(3)}   skipped ${r.skipped}`);
        totalApplied += r.applied;
    } else {
        console.log(`  ${r.code.padEnd(5)} ${r.status}`);
    }
}
console.log('─'.repeat(48));
console.log(`Total applied: ${totalApplied}`);
if (!DRY && totalApplied > 0) {
    console.log('\nNext: run `node scripts/build-locale-skeletons.mjs` '
        + 'to refresh __meta__ coverage stats and gap_keys.');
}
