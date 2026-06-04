#!/usr/bin/env node
/**
 * validate-crisis-pack-i18n.mjs — coverage gate for the geo-scoped crisis-pack
 * curated question labels + select options.
 *
 * The 6 stock crisis packs (web-dashboard/src/cc-crisis.js → CORE_BLOCKS +
 * STOCK_PACKS) ship English `label`/option strings only. The PWA pack renderer
 * (mobile-app/src/v4-flow.js) localizes each via a static i18n key:
 *     field label   → cp_<fieldkey>
 *     select option → cpopt_<fieldkey>_<VALUE>
 * (yes/no options reuse v4_yes / v4_no; the 3 chip-covered taxonomy selects —
 * crisis_type / infrastructure_type / damage_classification — are captured by
 * the PWA's already-translated hardcoded chips, NOT the pack renderer, so they
 * are excluded here.)
 *
 * This gate derives the expected cp_/cpopt_ keys from the stock-pack source and
 * asserts each exists in mobile-app/src/i18n/en.json. validate-i18n.mjs then
 * guarantees those keys are present in all 22 locales — together they make the
 * crisis-pack flow >99% translated and regression-proof: add a stock question
 * without a translation key and CI fails here.
 *
 * Usage: node scripts/validate-crisis-pack-i18n.mjs
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CC = join(ROOT, 'web-dashboard/src/cc-crisis.js');
const EN = join(ROOT, 'mobile-app/src/i18n/en.json');

// Taxonomy selects captured by the PWA's hardcoded (already-translated) classify
// chips — the pack renderer never draws them, so they need no cp_/cpopt_ keys.
const CHIP_COVERED = new Set(['crisis_type', 'infrastructure_type', 'damage_classification']);

function slicePackSource(src) {
  // Bound the scan to the block library + stock packs (CORE_BLOCKS … just before
  // CRISIS_TO_STOCK) so we don't pick up event-form / pack-metadata `key:` lines.
  const start = src.indexOf('const CORE_BLOCKS');
  const end = src.indexOf('const CRISIS_TO_STOCK');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('cc-crisis.js markers (CORE_BLOCKS … CRISIS_TO_STOCK) not found — update this gate.');
  }
  return src.slice(start, end);
}

// Returns [{ key, optionValues: [...] }] for every renderable pack field.
function extractFields(region) {
  const fields = [];
  const seen = new Set();
  const add = (key, optionValues) => {
    if (!key || CHIP_COVERED.has(key) || seen.has(key)) return;
    seen.add(key);
    fields.push({ key, optionValues });
  };

  for (const rawLine of region.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//')) continue;

    // ynStage('<key>', …) — crisis-specific yes/no question (no options).
    const yn = line.match(/ynStage\(\s*'([a-z0-9_]+)'/);
    if (yn) { add(yn[1], []); continue; }

    // Inline field object: { key: '<key>', type: '<type>', … options: opt([...]) }
    const fm = line.match(/key:\s*'([a-z0-9_]+)'\s*,\s*type:\s*'([a-z_]+)'/);
    if (fm) {
      const key = fm[1];
      let optionValues = [];
      const om = line.match(/options:\s*opt\(\[([\s\S]*?)\]\)/);  // inline opt([...]) only
      if (om) {
        optionValues = [...om[1].matchAll(/\[\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]);
      }
      add(key, optionValues);
    }
  }
  return fields;
}

function main() {
  const region = slicePackSource(readFileSync(CC, 'utf8'));
  const fields = extractFields(region);
  const en = JSON.parse(readFileSync(EN, 'utf8'));

  const expected = [];
  for (const f of fields) {
    expected.push('cp_' + f.key);
    for (const v of f.optionValues) expected.push('cpopt_' + f.key + '_' + v);
  }
  const uniqueExpected = [...new Set(expected)];
  const missing = uniqueExpected.filter((k) => !(k in en));

  console.log(`crisis-pack i18n: ${fields.length} renderable fields → ${uniqueExpected.length} expected keys`);
  if (missing.length) {
    console.error(`✘ ${missing.length} crisis-pack i18n key(s) missing from mobile-app/src/i18n/en.json:`);
    for (const k of missing) console.error('    ' + k);
    console.error('\nAdd the key(s) to all 22 locale files (mobile-app/src/i18n/*.json), then');
    console.error('re-run scripts/validate-i18n.mjs for full 22-locale parity.');
    process.exit(1);
  }
  console.log('✓ all crisis-pack labels + options have a cp_/cpopt_ key in en.json');
}

main();
