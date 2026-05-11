#!/usr/bin/env node
// scripts/generate-i18n-worksheets.mjs
// ─────────────────────────────────────────────────────────────────────
// For each locale with translation gaps (status != "complete"), emit a
// CSV worksheet at `mobile-app/i18n-worksheets/{lang}.csv` that a
// translator (UNDP partner, native-speaker reviewer) can fill in.
//
// Columns:
//   key                    — i18n lookup key (e.g. "v4_record_voice_fallback")
//   english                — canonical English value from en.json
//   current_translation    — what's currently in {lang}.json (may be EN placeholder)
//   suggested_translation  — blank; the translator's deliverable
//   context_notes          — auto-populated hint about where this string appears
//   status                 — translator marks "approved" when their suggestion is ready
//                            for import. Anything else (blank, "review", "skip") is ignored
//                            by import-i18n-worksheet.mjs.
//
// Re-run anytime; existing worksheets are overwritten (a translator's
// in-progress work should live in a separate branch / sheet).
//
// Phase 25 (May 2026) — UNDP submission deliverable. See
// docs/i18n-workflow.md.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, '..');
const I18N_DIR = join(ROOT, 'mobile-app', 'src', 'i18n');
const OUT_DIR = join(ROOT, 'mobile-app', 'i18n-worksheets');
const DRY_RUN = process.argv.includes('--dry-run');

// ── Context-note rules ─────────────────────────────────────────────────
// Maps a key prefix or exact key name to a brief UI-context hint. The
// translator sees this in the CSV to disambiguate (e.g. "Submit" as a
// button label vs. "Submit" as a screen-reader announcement).
const CONTEXT_RULES = [
    // Exact-match — highest priority
    {
        exact: {
            'consent_title':        'Privacy consent dialog headline. Bold sentence-case.',
            'consent_accept':       'Primary button on consent dialog. ≤ 3 words.',
            'consent_check':        'Checkbox label on consent dialog.',
            'aria_back':            'Screen-reader label for back arrow. ≤ 4 words.',
            'aria_close':           'Screen-reader label for X close button. ≤ 3 words.',
            'aria_choose_language': 'Screen-reader label for the language picker overlay.',
            'aria_online_status':   'Screen-reader hint on the connectivity dot.',
            'aria_what_is_this':    'Screen-reader label for info "ⓘ" button.',
            'aria_copy_id':         'Screen-reader label for the device-ID copy button.',
            'aria_read_aloud':      'Screen-reader label for the 🔊 voice button.',
            'aria_retry_sync':      'Screen-reader label for the "Retry sync" button.',
            'aria_image_viewer':    'Screen-reader label for full-screen image viewer.',
            'aria_add_photo':       'Screen-reader label for the + add photo button.',
            'aria_close_camera':    'Screen-reader label for camera-close X button.',
            'aria_tap_change_language': 'Tooltip + screen-reader hint on the language pill.',
            'landing_title':        'Hero headline on landing/home screen. Short, motivating.',
            'landing_install_pwa':  'Install-app button label.',
            'big_cta':              'The primary orange "Report an Incident" button.',
            'v4_take_photo':        'Step-1 camera CTA on capture flow.',
            'v4_record':            'Mic button label when idle.',
            'v4_record_voice_fallback': 'Mic button fallback label. Should equal v4_record.',
            'v4_stop_recording':    'Mic button label while recording.',
            'v4_sending':           'Loading-state label on the Send button after tap.',
            'v4_gps_locating':      'Inline status next to GPS pin while resolving location.',
            'v4_gps_unavailable':   'Inline status next to GPS pin if location lookup fails.',
            'v4_photos_count_one':  'Singular form: "1 photo". Used in the captured-strip preview.',
            'v4_photos_count_many': 'Plural form. Use {n} placeholder for the count.',
            'v4_step_progress':     'Progress label across capture flow. Use {current} / {total} placeholders.',
        }
    },
    // Prefix-match — applied if no exact rule matches
    {
        prefix: {
            'consent_':       'Privacy consent dialog. Plain language; UNDP-rubric required item.',
            'aria_':          'Screen-reader label. Concise; describes the element\'s action.',
            'placeholder_':   'Form-field placeholder text (greyed). Shown in empty inputs as a hint.',
            'v4_':            'v4 capture flow (Report an Incident → photo → describe → review → send).',
            'landing_':       'Landing / home screen. Anonymous-friendly. Newcomer-safe vocabulary.',
            'error_':         'Error or failure-state message. Sympathetic, actionable.',
            'prompt_':        'Text-to-speech prompt read aloud by Twilio Polly (IVR + 🔊 button). Keep ≤ 12 words; avoid idioms.',
            'mr_':            '"My Reports" list / detail screen.',
            'history_':       'Submitted-reports history screen.',
            'building_':      'OSM building-footprint selector.',
            'undp_':           'UNDP-specific panel (about page, footer).',
            'btn_':           'Generic button label. Short, verb-led.',
            'rd_':            'Report-detail page.',
        }
    },
];

function contextFor(key) {
    for (const rule of CONTEXT_RULES) {
        if (rule.exact && rule.exact[key]) return rule.exact[key];
    }
    for (const rule of CONTEXT_RULES) {
        if (rule.prefix) {
            for (const pfx in rule.prefix) {
                if (key.startsWith(pfx)) return rule.prefix[pfx];
            }
        }
    }
    return 'General UI string. Match tone of surrounding screen.';
}

// ── CSV utilities ──────────────────────────────────────────────────────
function csvEscape(s) {
    if (s === null || s === undefined) return '';
    const str = String(s);
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function rowToCsv(cols) {
    return cols.map(csvEscape).join(',');
}

// ── Load en.json (canonical) ───────────────────────────────────────────
const enRaw = JSON.parse(readFileSync(join(I18N_DIR, 'en.json'), 'utf8'));
const enKeys = Object.keys(enRaw).filter(k => k !== '__meta__');

// ── Discover locales with gaps ─────────────────────────────────────────
const targets = [];
for (const f of readdirSync(I18N_DIR)) {
    if (!f.endsWith('.json')) continue;
    const code = f.replace(/\.json$/, '');
    if (code === 'en') continue;     // canonical, no worksheet
    const loc = JSON.parse(readFileSync(join(I18N_DIR, f), 'utf8'));
    const meta = loc.__meta__ || {};
    const status = meta.translation_status || 'unknown';
    if (status === 'complete') continue;
    targets.push({ code, loc, meta });
}

console.log(`Found ${targets.length} locale(s) with translation gaps.`);

// ── Ensure output dir ──────────────────────────────────────────────────
if (!DRY_RUN && !existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const summary = [];
for (const { code, loc, meta } of targets) {
    const rows = [
        rowToCsv([
            'key', 'english', 'current_translation',
            'suggested_translation', 'context_notes', 'status'
        ]),
    ];
    let gapCount = 0;
    for (const key of enKeys) {
        const enVal = enRaw[key];
        const cur = loc[key];
        const isGap = (!cur) || cur === enVal;
        if (!isGap) continue; // Only emit untranslated rows.
        gapCount++;
        rows.push(rowToCsv([
            key,
            enVal,
            cur || '',
            '',                       // suggested_translation (blank)
            contextFor(key),
            '',                       // status (translator fills "approved")
        ]));
    }
    const csv = rows.join('\n') + '\n';
    const path = join(OUT_DIR, `${code}.csv`);
    if (!DRY_RUN) writeFileSync(path, csv, 'utf8');
    summary.push({ code, gap: gapCount, tier: meta.tier || '?' });
}

// ── Report ─────────────────────────────────────────────────────────────
console.log('\nWorksheet generation report' + (DRY_RUN ? ' (DRY-RUN)' : ''));
console.log('─'.repeat(48));
for (const s of summary) {
    console.log(`  ${s.code.padEnd(5)} T${s.tier}   ${String(s.gap).padStart(3)} gap rows`);
}
console.log('─'.repeat(48));
console.log(`Output: ${OUT_DIR}`);
if (DRY_RUN) console.log('(Dry run — no files written.)');
