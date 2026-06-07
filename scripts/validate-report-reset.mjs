#!/usr/bin/env node
/**
 * validate-report-reset.mjs — permanent guard against the recurring
 * "stale report state leaks into the next report" bug.
 *
 * Every field written to the global PWA `state` object must be classified as
 * EITHER reset-per-report (returned by `_freshReportState()` in app.js) OR
 * preserved-across-reports (listed in `_PRESERVED_STATE_KEYS`). This script
 * statically extracts both sets, scans every write to `state.*` / `window.state.*`
 * / `_setState({...})` across the PWA source, and FAILS if any written field is
 * in neither set (or if the two sets overlap).
 *
 * Result: a future PR that adds a capture field (e.g. `state.newThing = …`)
 * without deciding whether it resets or persists CANNOT pass CI — so the leak
 * class cannot silently return. The reset itself stays correct because
 * `reportLifecycleReset()` does `Object.assign(state, _freshReportState())`.
 *
 *   node scripts/validate-report-reset.mjs
 *
 * Wired into the pre-commit hook + .github/workflows/ci.yml.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = 'mobile-app/src/app.js';
// Files that write the GLOBAL state (app.js owns `state`; v4-flow + building-select
// write it via window.state / _setState).
const SCAN = [APP, 'mobile-app/src/v4-flow.js', 'mobile-app/src/building-select.js'];

const RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', RESET = '\x1b[0m';
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// Top-level keys of the object literal beginning at the first `{` at/after `from`.
// Brace/bracket/paren + string aware; supports `key: val` and shorthand `key`.
function objectTopLevelKeys(src, from) {
    const open = src.indexOf('{', from);
    if (open < 0) return [];
    let i = open, depth = 0, str = null, end = -1;
    for (; i < src.length; i++) {
        const c = src[i], p = src[i - 1];
        if (str) { if (c === str && p !== '\\') str = null; continue; }
        if (c === '"' || c === "'" || c === '`') { str = c; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) return [];
    // Flatten: blank out everything nested deeper than the object's own level
    // (and all string contents) so only top-level `key:` / `key,` survive.
    const body = src.slice(open + 1, end);
    let flat = '', d = 0, str2 = null;
    for (let j = 0; j < body.length; j++) {
        const c = body[j], p = body[j - 1];
        if (str2) { if (c === str2 && p !== '\\') str2 = null; flat += ' '; continue; }
        if (c === '"' || c === "'" || c === '`') { str2 = c; flat += ' '; continue; }
        if (c === '{' || c === '[' || c === '(') { d++; flat += ' '; continue; }
        if (c === '}' || c === ']' || c === ')') { d--; flat += ' '; continue; }
        flat += (d === 0) ? c : ' ';
    }
    const keys = new Set();
    for (const m of flat.matchAll(/([A-Za-z_]\w*)\s*:/g)) keys.add(m[1]);          // key: value
    for (const m of flat.matchAll(/(?:^|,)\s*([A-Za-z_]\w*)\s*(?=,|$)/g)) keys.add(m[1]); // shorthand
    return [...keys];
}

const appSrc = read(APP);

// 1. Factory keys (reset-per-report). Anchor on the `return {` object literal,
// not the function-body brace.
const _facStart = appSrc.indexOf('function _freshReportState()');
const factoryKeys = new Set(objectTopLevelKeys(appSrc, appSrc.indexOf('return {', _facStart)));
// 2. Preserved keys.
const preserved = new Set();
const presMatch = appSrc.match(/_PRESERVED_STATE_KEYS\s*=\s*\[([\s\S]*?)\]/);
if (presMatch) for (const m of presMatch[1].matchAll(/['"]([A-Za-z_]\w*)['"]/g)) preserved.add(m[1]);

let problems = 0;
const fail = (msg) => { console.error(`${RED}✘${RESET} ${msg}`); problems++; };

if (factoryKeys.size === 0) fail('could not extract _freshReportState() keys — has the factory moved or changed shape?');
if (preserved.size === 0) fail('could not extract _PRESERVED_STATE_KEYS — has the array moved or changed shape?');

// 3. Overlap check.
for (const k of factoryKeys) if (preserved.has(k)) fail(`"${k}" is in BOTH _freshReportState() and _PRESERVED_STATE_KEYS — pick one.`);

// 4. Scan every write target.
const classified = new Set([...factoryKeys, ...preserved]);
const offenders = new Map(); // key -> Set(files)
const note = (k, f) => { if (!classified.has(k)) (offenders.get(k) || offenders.set(k, new Set()).get(k)).add(f); };

for (const rel of SCAN) {
    const src = read(rel);
    // window.state.X = ... (all files)
    for (const m of src.matchAll(/\bwindow\.state\.([A-Za-z_]\w*)\s*=(?!=)/g)) note(m[1], rel);
    // bare state.X = ... (app.js owns the global `state`)
    if (rel === APP) for (const m of src.matchAll(/(?<![.\w])state\.([A-Za-z_]\w*)\s*=(?!=)/g)) note(m[1], rel);
    // _setState({ ... }) top-level keys (v4-flow uses this to write window.state)
    for (const m of src.matchAll(/_setState\s*\(/g)) {
        for (const k of objectTopLevelKeys(src, m.index)) note(k, rel);
    }
}

for (const [k, files] of [...offenders].sort()) {
    fail(`state.${k} is WRITTEN (${[...files].map((f) => f.split('/').pop()).join(', ')}) but is in neither _freshReportState() nor _PRESERVED_STATE_KEYS.`);
}

console.log(`${YELLOW}report-reset audit${RESET}: ${factoryKeys.size} reset-per-report keys, ${preserved.size} preserved keys.`);
if (problems) {
    console.error(`\n${RED}FAIL${RESET} — ${problems} issue(s). Classify each field: add it to _freshReportState() in mobile-app/src/app.js (resets every report) OR to _PRESERVED_STATE_KEYS (survives across reports). This guard exists so report state can never silently leak between reports.`);
    process.exit(1);
}
console.log(`${GREEN}PASS${RESET} — every state.* field is classified reset-or-preserve.`);
