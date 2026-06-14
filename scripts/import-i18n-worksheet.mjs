#!/usr/bin/env node
// scripts/import-i18n-worksheet.mjs
// ─────────────────────────────────────────────────────────────────────
// Patches `mobile-app/src/i18n/{lang}.json` with the
// `suggested_translation` column from a filled
// `mobile-app/i18n-worksheets/{lang}.csv`, but ONLY for rows whose
// `status` column equals "approved" (case-insensitive). Other rows
// are skipped - translators can leave rows in `review` / blank /
// `skip` and re-run import after another review pass.
//
// After import, run `node scripts/build-locale-skeletons.mjs` to
// refresh the `__meta__` block (coverage stats, gap_keys array).
//
// Usage:
//   node scripts/import-i18n-worksheet.mjs <lang>          # e.g. pt
//   node scripts/import-i18n-worksheet.mjs --all           # all worksheets
//   node scripts/import-i18n-worksheet.mjs <lang> --dry-run
//
// UNDP submission deliverable. See
// docs/i18n-workflow.md.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const I18N_DIR = join(ROOT, 'mobile-app', 'src', 'i18n');
const WS_DIR = join(ROOT, 'mobile-app', 'i18n-worksheets');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ALL = args.includes('--all');
const langArg = args.find(a => !a.startsWith('--'));

if (!langArg && !ALL) {
    console.error('Usage: import-i18n-worksheet.mjs <lang>|--all [--dry-run]');
    process.exit(1);
}

// ── CSV parser (minimal RFC-4180-ish) ──────────────────────────────────
function parseCsv(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    let i = 0;
    while (i < text.length) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    cell += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i++;
                continue;
            }
            cell += c;
            i++;
            continue;
        }
        if (c === '"') {
            inQuotes = true;
            i++;
            continue;
        }
        if (c === ',') {
            row.push(cell);
            cell = '';
            i++;
            continue;
        }
        if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++;
            row.push(cell);
            cell = '';
            // Skip empty trailing newline.
            if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
                rows.push(row);
            }
            row = [];
            i++;
            continue;
        }
        cell += c;
        i++;
    }
    if (cell !== '' || row.length) {
        row.push(cell);
        rows.push(row);
    }
    return rows;
}

function processOne(code) {
    const csvPath = join(WS_DIR, `${code}.csv`);
    const jsonPath = join(I18N_DIR, `${code}.json`);
    if (!existsSync(csvPath)) {
        console.warn(`[skip] ${code}: no worksheet at ${csvPath}`);
        return { code, status: 'no-worksheet' };
    }
    if (!existsSync(jsonPath)) {
        console.warn(`[skip] ${code}: no locale JSON at ${jsonPath}`);
        return { code, status: 'no-locale-json' };
    }
    const rows = parseCsv(readFileSync(csvPath, 'utf8'));
    if (!rows.length) return { code, status: 'empty-csv' };
    const header = rows[0].map(h => h.trim());
    const idx = {
        key: header.indexOf('key'),
        english: header.indexOf('english'),
        suggested: header.indexOf('suggested_translation'),
        status: header.indexOf('status'),
    };
    if (idx.key < 0 || idx.suggested < 0 || idx.status < 0) {
        console.error(`[fail] ${code}: required CSV columns missing (key, suggested_translation, status)`);
        return { code, status: 'malformed-csv' };
    }
    const locale = JSON.parse(readFileSync(jsonPath, 'utf8'));
    let applied = 0;
    let skipped = 0;
    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row || !row[idx.key]) continue;
        const status = (row[idx.status] || '').trim().toLowerCase();
        if (status !== 'approved') { skipped++; continue; }
        const k = row[idx.key];
        const suggested = (row[idx.suggested] || '').trim();
        if (!suggested) { skipped++; continue; }
        if (locale[k] === suggested) { skipped++; continue; }
        locale[k] = suggested;
        applied++;
    }
    // Bump __meta__.last_imported (transparency).
    if (locale.__meta__) {
        locale.__meta__.last_imported = new Date().toISOString();
        locale.__meta__.last_import_applied = applied;
    }
    if (!DRY_RUN && applied > 0) {
        writeFileSync(jsonPath, JSON.stringify(locale, null, 2) + '\n', 'utf8');
    }
    return { code, applied, skipped, status: 'ok' };
}

const targets = ALL
    ? readdirSync(WS_DIR)
        .filter(f => f.endsWith('.csv'))
        .map(f => f.replace(/\.csv$/, ''))
    : [langArg];

const results = [];
for (const code of targets) {
    results.push(processOne(code));
}

console.log('\nImport report' + (DRY_RUN ? ' (DRY-RUN)' : ''));
console.log('─'.repeat(56));
let totalApplied = 0;
for (const r of results) {
    if (r.status === 'ok') {
        console.log(`  ${r.code.padEnd(5)} applied ${String(r.applied).padStart(3)}   skipped ${r.skipped}`);
        totalApplied += r.applied;
    } else {
        console.log(`  ${r.code.padEnd(5)} ${r.status}`);
    }
}
console.log('─'.repeat(56));
console.log(`Total applied: ${totalApplied}`);
if (!DRY_RUN && totalApplied > 0) {
    console.log('\nNext step: run `node scripts/build-locale-skeletons.mjs` '
        + 'to refresh __meta__ coverage stats and gap_keys.');
}
