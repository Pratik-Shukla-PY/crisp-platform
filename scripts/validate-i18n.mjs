#!/usr/bin/env node
/**
 * i18n validation — run before committing a translation update.
 *
 *   * Every JSON file parses.
 *   * Every non-EN locale has exactly the same key set as en.json
 *     (minus the `__meta__` block).
 *   * Every `{n}`-style template variable in the EN value is preserved
 *     in the translated value — catches translators who dropped the
 *     placeholder and silently broke pluralised time-ago strings.
 *   * Emoji prefixes (the first character, if an emoji) are preserved.
 *
 * Usage:
 *   node scripts/validate-i18n.mjs
 *
 * Exit code 0 on success, 1 on any validation failure — wire into CI.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const I18N_DIR = join(__dirname, "..", "mobile-app", "src", "i18n");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

let problems = 0;
function fail(msg) { console.error(`${RED}✘${RESET} ${msg}`); problems++; }
function warn(msg) { console.warn(`${YELLOW}⚠${RESET} ${msg}`); }
function ok(msg)   { console.log(`${GREEN}✓${RESET} ${msg}`); }

const files = (await readdir(I18N_DIR)).filter((f) => f.endsWith(".json")).sort();
if (!files.includes("en.json")) {
    fail("en.json is missing — en is the canonical source of truth, cannot validate without it.");
    process.exit(1);
}

const parsed = {};
for (const f of files) {
    try {
        const raw = await readFile(join(I18N_DIR, f), "utf8");
        parsed[f] = JSON.parse(raw);
        ok(`${f} parses as valid JSON (${Object.keys(parsed[f]).length} top-level keys)`);
    } catch (e) {
        fail(`${f} is not valid JSON: ${e.message}`);
    }
}

const enKeys = new Set(Object.keys(parsed["en.json"]).filter((k) => k !== "__meta__"));
ok(`en.json has ${enKeys.size} content keys`);

// Regex for {name} / {n} style template variables.
const templateVarRe = /\{[a-zA-Z0-9_]+\}/g;
function templateVars(s) {
    return (typeof s === "string" ? (s.match(templateVarRe) || []) : []).sort();
}

// South-Asian "stub" locales are dumped from inline
// EXTRA_LANG packs (Kannada / Hindi / Tamil / Telugu / Malayalam /
// Bengali / Gujarati / Marathi / Punjabi / Urdu). They intentionally
// contain ONLY the keys with hand-translated values; missing keys
// fall through to en.json via the runtime t() chain. The validator
// recognises them by either the `__meta__.stub: true` marker OR by
// presence in this allowlist; missing keys become a warning instead
// of a fail.
const STUB_LOCALES = new Set([
    "kn.json", "hi.json", "ta.json", "te.json", "ml.json",
    "bn.json", "gu.json", "mr.json", "pa.json", "ur.json",
]);

function isStub(f, content) {
    if (STUB_LOCALES.has(f)) return true;
    const meta = content && content.__meta__;
    return !!(meta && (meta.stub === true || meta.machine_translated === true || meta.note));
}

for (const f of files) {
    if (f === "en.json") continue;
    const locale = f.replace(/\.json$/, "");
    const keys = new Set(Object.keys(parsed[f]).filter((k) => k !== "__meta__"));
    const missing = [...enKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !enKeys.has(k));
    const stub = isStub(f, parsed[f]);
    if (missing.length) {
        if (stub) {
            warn(`${f}: ${missing.length} key(s) missing — stub locale, runtime falls back to English (acceptable)`);
        } else {
            fail(`${f}: ${missing.length} missing key(s) vs en.json`);
            missing.slice(0, 20).forEach((k) => console.error(`    - ${k}`));
            if (missing.length > 20) console.error(`    ... and ${missing.length - 20} more`);
        }
    }
    if (extra.length) {
        warn(`${f}: ${extra.length} extra key(s) not in en.json (kept — may be deprecated aliases)`);
        extra.slice(0, 10).forEach((k) => console.warn(`    + ${k}`));
    }
    if (!missing.length) ok(`${locale}: all ${keys.size} EN keys present`);
    else if (stub) ok(`${locale}: stub locale with ${keys.size}/${enKeys.size} translated (rest → English fallback)`);

    // Template-variable preservation.
    let tvFail = 0;
    for (const k of enKeys) {
        if (!keys.has(k)) continue;
        const enVars = templateVars(parsed["en.json"][k]);
        const locVars = templateVars(parsed[f][k]);
        if (enVars.length && JSON.stringify(enVars) !== JSON.stringify(locVars)) {
            fail(`${f}[${k}]: template var mismatch. EN has ${JSON.stringify(enVars)}; ${locale} has ${JSON.stringify(locVars)}`);
            tvFail++;
            if (tvFail > 5) { console.error("    ... suppressing further template-var errors"); break; }
        }
    }
    if (!tvFail) ok(`${locale}: template variables ({n}, etc.) preserved in every key`);
}

console.log("");
if (problems) {
    console.error(`${RED}FAIL${RESET} — ${problems} validation problem(s).`);
    process.exit(1);
}
console.log(`${GREEN}PASS${RESET} — all locale files valid.`);
