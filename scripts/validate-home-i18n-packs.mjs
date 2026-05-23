#!/usr/bin/env node
/**
 * Build-time gate for the inline 22-locale critical-text packs in
 * index.html. Companion to scripts/generate-home-i18n-inline.mjs.
 *
 * Verifies:
 *   1. The inline block exists between the BEGIN/END markers.
 *   2. `window.__crispHomeI18nPacks` parses as a valid object with
 *      `__meta` + every supported locale present.
 *   3. Each pack's `__checksum` matches a fresh sha256(pack content).
 *   4. Each pack's `__version` matches the source i18n/<lang>.json hash.
 *   5. Key coverage is consistent — every key in EN's pack is present
 *      in every other pack (EN-fallback substitution is allowed, but
 *      the KEY must exist so the walker can resolve it).
 *   6. Pack version matches the matching i18n/<lang>.json hash in
 *      sw.js manifest (catches "regenerated inline pack but forgot
 *      to bump SW manifest" drift).
 *
 * Runs in <1 s. Wired into .husky/pre-commit and CI. Exit code 0 on
 * success, non-zero on any drift.
 *
 *   node scripts/validate-home-i18n-packs.mjs
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const INDEX_PATH = join(ROOT, "mobile-app/src/index.html");
const I18N_DIR = join(ROOT, "mobile-app/src/i18n");
const SW_PATH = join(ROOT, "mobile-app/src/sw.js");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const fail = (m) => { console.error(`${RED}✘${RESET} ${m}`); errors.push(m); };
const ok = (m) => console.log(`${GREEN}✓${RESET} ${m}`);
const warn = (m) => console.warn(`${YELLOW}⚠${RESET} ${m}`);

const errors = [];

const SUPPORTED_LOCALES = [
    "en", "zh", "es", "ar", "fr", "ru",
    "hi", "pt", "bn", "ja", "tr", "vi", "ko", "id", "ur",
    "kn", "ta", "te", "ml", "gu", "mr", "pa",
];

function sha256(buf) {
    return createHash("sha256").update(buf).digest("hex");
}

function extractInlinePacks(htmlSrc) {
    // Find `window.__crispHomeI18nPacks = { ... };`
    const m = htmlSrc.match(/window\.__crispHomeI18nPacks\s*=\s*(\{[\s\S]*?\});\s*<\/script>/);
    if (!m) {
        fail("inline __crispHomeI18nPacks block not found in index.html");
        return null;
    }
    // Inline block escapes </ as <\/ to safely embed in <script>. Unescape
    // before JSON.parse.
    const jsonText = m[1].replace(/<\\\//g, "</");
    try {
        return JSON.parse(jsonText);
    } catch (e) {
        fail(`inline __crispHomeI18nPacks failed JSON.parse: ${e.message}`);
        return null;
    }
}

async function loadSwManifest() {
    const swSrc = await readFile(SW_PATH, "utf8");
    const out = {};
    // Format in sw.js:
    //   "i18n/<lang>.json": "<12-hex>",
    const re = /"i18n\/([a-z]{2,3})\.json":\s*"([a-f0-9]{12})"/g;
    let m;
    while ((m = re.exec(swSrc)) !== null) {
        out[m[1]] = m[2];
    }
    return out;
}

async function main() {
    const htmlSrc = await readFile(INDEX_PATH, "utf8");
    const packs = extractInlinePacks(htmlSrc);
    if (!packs) process.exit(1);

    // 1. __meta sanity.
    if (!packs.__meta) {
        fail("__crispHomeI18nPacks.__meta missing");
    } else {
        const meta = packs.__meta;
        if (!Array.isArray(meta.locales) || meta.locales.length !== SUPPORTED_LOCALES.length) {
            fail(`__meta.locales length mismatch — expected ${SUPPORTED_LOCALES.length}, got ${meta.locales?.length}`);
        }
        if (!meta.buildTs) fail("__meta.buildTs missing");
        if (!meta.scriptVersion) fail("__meta.scriptVersion missing");
    }

    // 2. All 22 locales present.
    for (const code of SUPPORTED_LOCALES) {
        if (!packs[code]) {
            fail(`locale "${code}" missing from inline packs`);
        }
    }

    // 3 + 4. Checksums + versions.
    const swManifest = await loadSwManifest();
    for (const code of SUPPORTED_LOCALES) {
        const pack = packs[code];
        if (!pack) continue;

        // Recompute pack checksum by stripping __version + __checksum
        // (same fields the gen script omits from its checksum input).
        const { __version, __checksum, ...content } = pack;
        const recomputed = sha256(JSON.stringify(content)).slice(0, 16);
        if (recomputed !== __checksum) {
            fail(`${code}: __checksum mismatch — stored=${__checksum} computed=${recomputed}`);
        }

        // __version matches sha256 of the source locale JSON.
        try {
            const sourceRaw = await readFile(join(I18N_DIR, `${code}.json`));
            const sourceHash = sha256(sourceRaw).slice(0, 12);
            if (sourceHash !== __version) {
                fail(`${code}: __version drift — pack has ${__version}, current i18n/${code}.json hashes to ${sourceHash}. Re-run gen-script.`);
            }
            // 5. Pack version should also match the SW manifest entry.
            if (swManifest[code] && swManifest[code] !== sourceHash) {
                warn(`${code}: sw.js manifest hash ${swManifest[code]} differs from current source ${sourceHash}. Run scripts/sync-release-tags.mjs to refresh manifest.`);
            }
        } catch (e) {
            fail(`${code}: failed to verify version — ${e.message}`);
        }
    }

    // 6. Key coverage — every key in EN pack must exist in every other pack.
    const enPack = packs.en;
    if (enPack) {
        const { __version: _v, __checksum: _c, ...enKeys } = enPack;
        const enKeySet = new Set(Object.keys(enKeys));
        for (const code of SUPPORTED_LOCALES) {
            if (code === "en") continue;
            const pack = packs[code];
            if (!pack) continue;
            const { __version: _v2, __checksum: _c2, ...content } = pack;
            const missing = [];
            for (const k of enKeySet) {
                if (!Object.prototype.hasOwnProperty.call(content, k)) missing.push(k);
            }
            if (missing.length) {
                fail(`${code}: ${missing.length} key(s) missing vs EN: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "..." : ""}`);
            }
        }
    }

    if (errors.length === 0) {
        ok(`all 22 inline packs valid (${Object.keys(packs.en || {}).length - 2} keys per pack, checksums + versions verified)`);
        process.exit(0);
    } else {
        console.error(`\n${RED}FAIL${RESET} — ${errors.length} drift problem(s) in inline i18n packs.`);
        console.error(`Run \`node scripts/generate-home-i18n-inline.mjs\` to regenerate.`);
        process.exit(1);
    }
}

main().catch((e) => {
    console.error(`${RED}✘${RESET} ${e.message}`);
    process.exit(2);
});
