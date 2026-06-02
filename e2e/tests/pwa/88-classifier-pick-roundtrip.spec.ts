/**
 * PWA — Classifier pick roundtrip (v6.7, May 2026).
 *
 * REPORTER-BLOCKING bug surfaced by operator on May 19:
 *
 *   "I am reporting House damage, shops/market damage, everything
 *    lands as Roads and Bridges → Roads. Completely wrong."
 *
 * Confirmed via inspection of a real queued report whose `meta`
 * carried hardcoded defaults `ROAD / FLOOD / PARTIAL / MODERATE`
 * even though the user had selected different infra / crisis /
 * damage values in the v4 capture flow. Violated 3 of 13 UNDP
 * must-haves (damage / crisis / infrastructure-type taxonomies)
 * on every report submitted since the V3 → V4 capture-flow
 * transition.
 *
 * Root cause was state-field naming mismatch — v4-flow.js writes
 * user taps to snake_case fields, submitReport read camelCase
 * legacy fields, _clearCaptureState reset the legacy fields to
 * hardcoded defaults. Three-way collision documented in detail in
 * sw.js v224 comment + CLAUDE.md "Classifier-state field naming"
 * invariant.
 *
 * Fix (v6.7):
 *   1. submitReport reads v4 snake_case FIRST, legacy as fallback.
 *   2. _clearCaptureState resets to null (not hardcoded defaults).
 *
 * This spec pins the regression so it CANNOT come back. Five tests:
 *
 *   1. RESIDENTIAL + EARTHQUAKE + COMPLETE round-trips correctly
 *   2. COMMERCIAL + FLOOD + MINIMAL round-trips correctly
 *   3. OTHER infra + free-text infrastructure_name round-trips
 *   4. NEGATIVE — empty state submits as null (not ROAD/FLOOD/PARTIAL)
 *   5. State-bleed guard — _clearCaptureState wipes the legacy fields
 */
import { test, expect, Page } from '@playwright/test';

/**
 * Boot the PWA past landing / consent, then jump to stage-v4-classify
 * with a synthetic photo state so the gate is past. Mirrors the
 * proven boot pattern from 87-home-stage-invariants.spec.ts (the
 * `/?nocache=…` pattern from spec 83 was flaky with the v224 boot
 * order).
 */
async function openClassifyStage(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    // Stub the nearby endpoint so the home boot doesn't gate on a
    // live backend response.
    await page.route('**/api/v1/reports/nearby**', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ groups: [] }),
        }),
    );
    // Isolate the DEFAULT classify flow from any live crisis zone: a real
    // active event at the test coordinates would (correctly) skip the crisis
    // step, so stub /crisis-forms/active inactive for deterministic default-flow.
    await page.route('**/crisis-forms/active**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: false }) }),
    );
    await page.goto('index.html?ui=v4');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
        () => typeof (window as any).goToStage === 'function'
           && typeof (window as any).state === 'object'
           && typeof (window as any).__crispGetAllQueued === 'function',
        null,
        { timeout: 8000 },
    );
    await page.evaluate(() => {
        (window as any).state = (window as any).state || {};
        (window as any).state.photoDataUrl = 'data:image/png;base64,iVBORw0KGgo=';
        (window as any).state.v4Photos = [(window as any).state.photoDataUrl];
        // Seed a minimal location so submitReport can build queue meta.
        (window as any).state.location = {
            lat: 12.9716, lng: 77.5946, acc: 35,
        };
        (window as any).goToStage('stage-v4-classify');
    });
    await expect(page.locator('#stage-v4-classify.active')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('#v4-view-damage')).toBeVisible();
}

/**
 * Drain the queue so each test starts clean. Idempotent.
 */
async function clearQueue(page: Page) {
    await page.evaluate(async () => {
        const items = await (window as any).__crispGetAllQueued();
        for (const it of items) {
            try { await (window as any).__crispDequeueReport(it.client_report_id); } catch (_) {}
        }
    });
}

/**
 * Drive the three classify taps in sequence: damage → infra → crisis.
 * Each tile-tap auto-progresses to the next sub-view after a 200 ms
 * pulse (per the v4 classify auto-progress contract). We wait for
 * the next sub-view to become visible before the next tap.
 */
async function pickClassifiers(
    page: Page,
    damage: 'MINIMAL' | 'PARTIAL' | 'COMPLETE',
    // InfrastructureTypeEnum per CLAUDE.md — `SCHOOL` and `HOSPITAL`
    // replaced the legacy `EDUCATIONAL` and `HEALTHCARE` during the v3
    // sub-type expansion; this signature drifted until Sprint 1D.
    // Main types plus the granular sub-types the v4 picker also surfaces.
    infra: 'RESIDENTIAL' | 'COMMERCIAL' | 'GOVERNMENT' | 'UTILITY' | 'TRANSPORT_COMMUNICATION' | 'COMMUNITY' | 'PUBLIC_SPACES' | 'OTHER' | 'ROAD' | 'HOSPITAL' | 'HOUSE' | 'POWER' | 'WATER' | 'SCHOOL' | 'TELECOM',
    crisis: 'EARTHQUAKE' | 'FLOOD' | 'WILDFIRE' | 'EXPLOSION' | 'CONFLICT' | 'CIVIL_UNREST' | 'TSUNAMI' | 'HURRICANE' | 'CHEMICAL',
    opts?: { infraOtherText?: string },
) {
    // Damage → auto-progresses to infra
    await page.locator(`#v4-view-damage .v4-q-opt[data-value="${damage}"]`).click();
    await expect(page.locator('#v4-view-infra')).toBeVisible({ timeout: 1500 });

    // Infra
    await page.locator(`#v4-view-infra .v4-hit-tile[data-value="${infra}"]`).click();
    if (infra === 'OTHER' && opts?.infraOtherText) {
        // OTHER reveals a free-text input; type + press Enter to advance.
        await expect(page.locator('#v4-infra-other-prompt')).toBeVisible();
        await page.locator('#v4-infra-other-input').fill(opts.infraOtherText);
        await page.locator('#v4-infra-other-input').press('Enter');
    }
    await expect(page.locator('#v4-view-crisis')).toBeVisible({ timeout: 1500 });

    // Crisis grid is rendered at runtime; wait for the tile to exist.
    await page.waitForSelector(`#v4-cause-grid .v4-cause-tile[data-value="${crisis}"]`, { timeout: 3000 });
    await page.locator(`#v4-cause-grid .v4-cause-tile[data-value="${crisis}"]`).click();
    // After crisis tap, classify auto-advances to stage-v4-review.
    await expect(page.locator('#stage-v4-review.active')).toBeVisible({ timeout: 1500 });
}

/**
 * Drive submitReport via the test hook, then read the resulting queue
 * item's meta. Returns the meta object or null if no item enqueued.
 */
async function submitAndReadMeta(page: Page): Promise<any> {
    return await page.evaluate(async () => {
        // Block the network fetch in trySendQueuedReport so the queue
        // row stays put for us to inspect. The retry loop will attempt
        // the meta POST, fail at our blocked endpoint, and the row
        // stays at stages.meta=false with the local meta intact.
        try { await (window as any).__crispSubmitReport(); } catch (_) {}
        // Give enqueueReport one tick to flush to IndexedDB.
        await new Promise(r => setTimeout(r, 100));
        const items = await (window as any).__crispGetAllQueued();
        if (!items.length) return null;
        return items[0].meta || null;
    });
}

test.describe('PWA — classifier pick roundtrip (v6.7 reporter-blocking fix)', () => {

    test.beforeEach(async ({ page }) => {
        // Block the meta POST so the queue row stays put for inspection.
        await page.route('**/api/v1/reports/meta', (route) =>
            route.fulfill({ status: 503, body: '{"detail":"blocked-by-spec"}' }),
        );
        await openClassifyStage(page);
        await clearQueue(page);
    });

    // ── 1. Positive roundtrip — RESIDENTIAL + EARTHQUAKE + COMPLETE ────

    test('@smoke RESIDENTIAL + EARTHQUAKE + COMPLETE round-trips into queue meta', async ({ page }) => {
        await pickClassifiers(page, 'COMPLETE', 'RESIDENTIAL', 'EARTHQUAKE');
        const meta = await submitAndReadMeta(page);
        expect(meta).not.toBeNull();
        expect(meta.infrastructure_type,   'infra pick MUST round-trip').toBe('RESIDENTIAL');
        expect(meta.crisis_type,           'crisis pick MUST round-trip').toBe('EARTHQUAKE');
        expect(meta.damage_classification, 'damage pick MUST round-trip').toBe('COMPLETE');
        // Sanity — these MUST NOT be the legacy hardcoded defaults.
        expect(meta.infrastructure_type).not.toBe('ROAD');
        expect(meta.crisis_type).not.toBe('FLOOD');
        expect(meta.damage_classification).not.toBe('PARTIAL');
    });

    // ── 2. Positive roundtrip — COMMERCIAL + FLOOD + MINIMAL ──────────
    // FLOOD happens to MATCH the legacy default; this test ensures we
    // round-trip the USER's pick (correct), not because the field was
    // never updated (bug). Verified by also asserting damage + infra
    // differ from the other defaults in the same submission.

    test('@smoke COMMERCIAL + FLOOD + MINIMAL round-trips (FLOOD ≠ default-leak)', async ({ page }) => {
        await pickClassifiers(page, 'MINIMAL', 'COMMERCIAL', 'FLOOD');
        const meta = await submitAndReadMeta(page);
        expect(meta).not.toBeNull();
        expect(meta.infrastructure_type).toBe('COMMERCIAL');
        expect(meta.crisis_type).toBe('FLOOD');
        expect(meta.damage_classification).toBe('MINIMAL');
        // Damage + infra ARE different from the legacy defaults — so
        // FLOOD here is genuinely the user's pick, not a stale carry-
        // over. (If the bug were back, damage would be PARTIAL and
        // infra would be ROAD; both checks would fail.)
        expect(meta.infrastructure_type).not.toBe('ROAD');
        expect(meta.damage_classification).not.toBe('PARTIAL');
    });

    // ── 3. OTHER infra + free-text name round-trips ───────────────────

    test('OTHER + free-text infra_name round-trips both fields', async ({ page }) => {
        await pickClassifiers(page, 'PARTIAL', 'OTHER', 'WILDFIRE', { infraOtherText: 'cell tower base' });
        const meta = await submitAndReadMeta(page);
        expect(meta).not.toBeNull();
        expect(meta.infrastructure_type).toBe('OTHER');
        expect(meta.infrastructure_name, 'free-text MUST reach meta').toBe('cell tower base');
        expect(meta.crisis_type).toBe('WILDFIRE');
        expect(meta.damage_classification).toBe('PARTIAL');
    });

    // ── 4. Negative — empty state submits as null, not ROAD/FLOOD ─────
    // The most important test: proves the hardcoded legacy defaults
    // can NEVER reappear. If anyone re-introduces them, this test
    // will fail loudly.

    test('@smoke empty classifier state submits as null (NOT legacy ROAD/FLOOD/PARTIAL/MODERATE)', async ({ page }) => {
        // Explicitly clear every classifier field in state. No taps.
        await page.evaluate(() => {
            const s = (window as any).state;
            s.infrastructure_type = null;
            s.crisis_type = null;
            s.damage_classification = null;
            s.infrastructure_name = '';
            s.severity = null;
            // Legacy fields too — verify they aren't being defaulted by
            // _clearCaptureState anymore.
            s.infraType = null;
            s.crisisType = null;
            s.damageClass = null;
            s.infraName = '';
        });
        const meta = await submitAndReadMeta(page);
        expect(meta).not.toBeNull();
        // The critical assertions: NO hardcoded legacy defaults.
        expect(meta.infrastructure_type,
            'infrastructure_type MUST be null when user did not pick — NOT "ROAD"').toBeNull();
        expect(meta.crisis_type,
            'crisis_type MUST be null when user did not pick — NOT "FLOOD"').toBeNull();
        expect(meta.damage_classification,
            'damage_classification MUST be null when user did not pick — NOT "PARTIAL"').toBeNull();
        // severity gets a "UNKNOWN" fallback at submit time (app.js:8004)
        // when neither state.severity nor a derivable damage value is
        // available. SeverityEnum.UNKNOWN IS a valid backend enum value
        // (backend/app/schemas/report.py:98) — it's the canonical
        // "uncategorised" marker that lets the dashboard flag the
        // report for review. Accept null OR "UNKNOWN" — both mean
        // the same thing; the regression to guard against is the OLD
        // hardcoded "MODERATE" default that masked operator selections.
        expect(['UNKNOWN', null]).toContain(meta.severity);
    });

    // ── 5. State-bleed guard — _clearCaptureState resets correctly ────

    test('_clearCaptureState wipes both v4 snake_case AND legacy camelCase fields to null', async ({ page }) => {
        // Pick a full set first
        await pickClassifiers(page, 'COMPLETE', 'GOVERNMENT', 'EXPLOSION');
        // Confirm the v4 fields are set
        const before = await page.evaluate(() => ({
            v4_infra:  (window as any).state.infrastructure_type,
            v4_crisis: (window as any).state.crisis_type,
            v4_dmg:    (window as any).state.damage_classification,
        }));
        expect(before.v4_infra).toBe('GOVERNMENT');
        expect(before.v4_crisis).toBe('EXPLOSION');
        expect(before.v4_dmg).toBe('COMPLETE');

        // Run _clearCaptureState (exposed indirectly via the test hook).
        // app.js exposes it on window as `_clearCaptureState`.
        await page.evaluate(() => {
            if (typeof (window as any)._clearCaptureState === 'function') {
                (window as any)._clearCaptureState();
            }
        });

        // After reset — EVERY classifier field on EVERY name MUST be null
        // (or empty string for infraName). Hardcoded ROAD/FLOOD/PARTIAL/
        // MODERATE would fail these assertions.
        const after = await page.evaluate(() => {
            const s = (window as any).state;
            return {
                v4_infra:    s.infrastructure_type,
                v4_crisis:   s.crisis_type,
                v4_dmg:      s.damage_classification,
                v4_name:     s.infrastructure_name,
                legacy_infra:  s.infraType,
                legacy_crisis: s.crisisType,
                legacy_dmg:    s.damageClass,
                legacy_name:   s.infraName,
                severity:      s.severity,
            };
        });
        expect(after.v4_infra,    'v4 infrastructure_type MUST reset to null').toBeNull();
        expect(after.v4_crisis,   'v4 crisis_type MUST reset to null').toBeNull();
        expect(after.v4_dmg,      'v4 damage_classification MUST reset to null').toBeNull();
        expect(after.v4_name,     'v4 infrastructure_name MUST reset to ""').toBe('');
        expect(after.legacy_infra,  'legacy infraType MUST reset to null (NOT "ROAD")').toBeNull();
        expect(after.legacy_crisis, 'legacy crisisType MUST reset to null (NOT "FLOOD")').toBeNull();
        expect(after.legacy_dmg,    'legacy damageClass MUST reset to null (NOT "PARTIAL")').toBeNull();
        expect(after.legacy_name,   'legacy infraName MUST reset to ""').toBe('');
        expect(after.severity,      'severity MUST reset to null (NOT "MODERATE")').toBeNull();
    });
});
