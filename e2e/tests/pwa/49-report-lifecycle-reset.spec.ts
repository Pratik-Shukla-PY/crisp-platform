/**
 * PWA — Report-lifecycle reset (permanent fix for the recurring
 * "stale state leaks into the next report" bug).
 *
 * Architecture under test (app.js + v4-flow.js):
 *  - `_freshReportState()` is the single source of truth for report-scoped state;
 *    `reportLifecycleReset()` (aka `_clearCaptureState`) does
 *    `Object.assign(state, _freshReportState())` so NO field can be missed.
 *  - The v4 capture/classify DOM is RENDER-FROM-STATE on entry + on
 *    `crisp-capture-state-cleared`, so a cleared `state` always yields a clean
 *    DOM (the description textarea, the recorder panel, and the damage/infra/
 *    crisis selections all derive from state — no imperative-paint drift).
 *  - `goToStage` does a GUARDED reset-on-entry: arriving at capture from a
 *    terminal stage (home/success/history/report-detail) starts a fresh report;
 *    arriving from within the flow (classify/review back-nav) preserves it.
 *  - Dev/test builds run `_assertReportStateClean()` after every reset; any
 *    un-reset field logs `[reset-leak] <field>`. These specs assert ZERO such
 *    errors, so a future un-reset field fails the suite by name.
 */
import { test, expect, Page } from '@playwright/test';

async function bootV4(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function'
           && typeof (window as any)._clearCaptureState === 'function'
           && typeof (window as any).reportLifecycleReset === 'function',
        null, { timeout: 8000 },
    );
}

// Collect any `[reset-leak] <field>` console.error emitted by the in-app
// dev/test self-check (_assertReportStateClean). Empty == every report field
// returned to its factory default on reset.
function trackResetLeaks(page: Page): string[] {
    const leaks: string[] = [];
    page.on('console', (m) => {
        if (m.type() === 'error' && m.text().includes('[reset-leak]')) leaks.push(m.text());
    });
    return leaks;
}

test.describe('PWA — report-lifecycle reset (no cross-report leakage)', () => {
    test.beforeEach(async ({ page }) => { await bootV4(page); });

    // ── Journey 7: many consecutive reports, no cumulative drift ─────────────
    test('20 sequential reset cycles → zero state + DOM leaks, zero [reset-leak]', async ({ page }) => {
        const leaks = trackResetLeaks(page);
        const failures = await page.evaluate((N: number) => {
            const out: Array<{ i: number; bad: string[] }> = [];
            const seedDirty = (i: number) => {
                const s = (window as any).state;
                s.description = 'Prev report ' + i;
                s.transcript = 'transcript ' + i;
                s.audioBlob = new Blob(['audio' + i], { type: 'audio/webm' });
                s.damage_classification = 'PARTIAL';
                s.infrastructure_type = 'ROAD';
                s.crisis_type = 'EXPLOSION';
                s.crisisStockAnswers = { q1: 'yes', q2: i };
                s.v4Photos = [{ url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' }];
                s.userLocationName = 'Typed place ' + i;
                s.location = { lat: 1, lng: 2, acc: 5, is_user_corrected: true };
                s.gpsErrorCode = 'timeout';
                s.applicableModules = [{ m: 1 }];
                s.nearbyBuildings = [{ b: 1 }];
                s.buildingId = 'osm:way:' + i;
                s.buildingOsmElement = { tags: { name: 'X' } };
                // DOM (painted imperatively, the leak surface):
                const ta = document.getElementById('v4-cap-text-area'); if (ta) (ta as HTMLTextAreaElement).value = s.description;
                const panel = document.getElementById('v4-cap-voice-panel'); if (panel) panel.classList.add('has-audio');
                const dmg = document.querySelector('#v4-view-damage .v4-q-opt'); if (dmg) dmg.classList.add('is-selected');
                const infra = document.querySelector('#v4-view-infra .v4-hit-tile'); if (infra) infra.classList.add('is-selected');
                const thumbs = document.getElementById('v4-thumbs');
                if (thumbs) { thumbs.style.display = 'flex'; thumbs.innerHTML = '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">'; }
            };
            const checkClean = () => {
                const s = (window as any).state; const bad: string[] = [];
                const eq = (k: string, want: any) => { if (JSON.stringify(s[k]) !== JSON.stringify(want)) bad.push(`state.${k}=${JSON.stringify(s[k])}`); };
                eq('description', ''); eq('transcript', ''); eq('audioBlob', null);
                eq('damage_classification', null); eq('infrastructure_type', null); eq('crisis_type', null);
                eq('crisisStockAnswers', {}); eq('v4Photos', []); eq('userLocationName', null);
                eq('gpsErrorCode', null); eq('applicableModules', []); eq('nearbyBuildings', []);
                eq('buildingId', null); eq('buildingOsmElement', null);
                if (s.location && s.location.is_user_corrected) bad.push('state.location.is_user_corrected');
                // DOM:
                const ta = document.getElementById('v4-cap-text-area') as HTMLTextAreaElement | null;
                if (ta && ta.value !== '') bad.push(`#v4-cap-text-area.value=${JSON.stringify(ta.value)}`);
                const panel = document.getElementById('v4-cap-voice-panel');
                if (panel && panel.classList.contains('has-audio')) bad.push('voice-panel.has-audio');
                if (document.querySelectorAll('#v4-view-damage .v4-q-opt.is-selected').length) bad.push('damage.is-selected');
                if (document.querySelectorAll('#v4-view-infra .v4-hit-tile.is-selected').length) bad.push('infra.is-selected');
                if (document.querySelectorAll('#v4-cause-grid .v4-cause-tile.is-selected').length) bad.push('cause.is-selected');
                if (document.querySelectorAll('#v4-thumbs img').length) bad.push('thumbs.img');
                return bad;
            };
            for (let i = 0; i < N; i++) {
                seedDirty(i);
                (window as any)._clearCaptureState();   // reset + render-from-state via the cleared event
                const bad = checkClean();
                if (bad.length) out.push({ i, bad });
            }
            return out;
        }, 20);

        expect(failures, `per-iteration leaks (state/DOM): ${JSON.stringify(failures, null, 2)}`).toEqual([]);
        expect(leaks, `[reset-leak] console errors: ${JSON.stringify(leaks)}`).toEqual([]);
    });

    // ── The two confirmed leaks, as targeted regressions ────────────────────
    test('description: #v4-cap-text-area DOM value clears (not just state)', async ({ page }) => {
        const leaks = trackResetLeaks(page);
        await page.evaluate(() => {
            (window as any).state.description = 'Road flooded, 3 people trapped';
            const ta = document.getElementById('v4-cap-text-area') as HTMLTextAreaElement;
            if (ta) ta.value = 'Road flooded, 3 people trapped';
        });
        await expect(page.locator('#v4-cap-text-area')).toHaveValue(/trapped/);
        await page.evaluate(() => (window as any)._clearCaptureState());
        await expect(page.locator('#v4-cap-text-area'), 'capture textarea must clear on reset').toHaveValue('');
        expect(await page.evaluate(() => (window as any).state.description)).toBe('');
        expect(leaks).toEqual([]);
    });

    test('audio: recorder panel returns to idle (no stale "recording exists" UI)', async ({ page }) => {
        const leaks = trackResetLeaks(page);
        await page.evaluate(() => {
            (window as any).state.audioBlob = new Blob(['x'], { type: 'audio/webm' });
            const panel = document.getElementById('v4-cap-voice-panel');
            if (panel) panel.classList.add('has-audio', 'is-recording');
            try { (window as any).__crispV4RenderCapRecorderState('stopped'); } catch (_) {}
        });
        await page.evaluate(() => (window as any)._clearCaptureState());
        const panelState = await page.evaluate(() => {
            const p = document.getElementById('v4-cap-voice-panel');
            return { hasAudio: !!p?.classList.contains('has-audio'), recording: !!p?.classList.contains('is-recording'), audioBlob: (window as any).state.audioBlob };
        });
        expect(panelState.hasAudio, 'voice panel must drop has-audio on reset').toBe(false);
        expect(panelState.recording, 'voice panel must drop is-recording on reset').toBe(false);
        expect(panelState.audioBlob, 'state.audioBlob must be null').toBeNull();
        expect(leaks).toEqual([]);
    });

    // ── Data-integrity: crisis-pack answers reset; zone schema preserved ─────
    test('crisis-pack: answers reset to {}, but crisisPack (zone schema) is preserved', async ({ page }) => {
        const leaks = trackResetLeaks(page);
        const r = await page.evaluate(() => {
            const s = (window as any).state;
            s.crisisStockAnswers = { homes_threatened: true, smoke_density: 'HEAVY' };
            s.crisisPack = { pack_id: 'wildfire-v3', crisis_type: 'WILDFIRE', schema: { fields: [] } };
            (window as any)._clearCaptureState();
            return {
                answers: s.crisisStockAnswers,
                packPreserved: !!(s.crisisPack && s.crisisPack.pack_id === 'wildfire-v3'),
            };
        });
        expect(r.answers, 'previous report pack answers must NOT carry over (data-integrity)').toEqual({});
        expect(r.packPreserved, 'crisisPack zone schema must survive reset (re-applies in-zone by design)').toBe(true);
        expect(leaks).toEqual([]);
    });

    // ── Journeys 1/2/3 + Step-5 guard: reset-on-entry from terminal stages ──
    test('guarded reset-on-entry: capture-from-home resets; capture-from-classify preserves', async ({ page }) => {
        const leaks = trackResetLeaks(page);
        // (a) Arriving at capture from HOME → fresh report (Journey 3/4).
        const fromHome = await page.evaluate(() => {
            (window as any).__crispGoToStage('stage-home');
            (window as any).state.description = 'leaked from a prior/abandoned report';
            const ta = document.getElementById('v4-cap-text-area') as HTMLTextAreaElement; if (ta) ta.value = 'leaked from a prior/abandoned report';
            (window as any).__crispGoToStage('stage-v4-capture');   // prev=home → guard resets
            const t = document.getElementById('v4-cap-text-area') as HTMLTextAreaElement;
            return { desc: (window as any).state.description, dom: t ? t.value : null };
        });
        expect(fromHome.desc, 'capture-from-home must start clean').toBe('');
        expect(fromHome.dom, 'capture textarea must be empty when entering from home').toBe('');

        // (b) Arriving at capture from CLASSIFY (back-nav) → preserve in-progress.
        const fromClassify = await page.evaluate(() => {
            (window as any).__crispGoToStage('stage-v4-classify');
            (window as any).state.description = 'in-progress report — keep me';
            (window as any).__crispGoToStage('stage-v4-capture');   // prev=classify → NO reset
            return (window as any).state.description;
        });
        expect(fromClassify, 'back-nav from classify must NOT wipe an in-progress capture').toBe('in-progress report — keep me');
        expect(leaks).toEqual([]);
    });

    // ── Journey 5: browser refresh → clean capture (state is in-memory only) ─
    test('browser refresh starts a clean capture', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).state.description = 'should not survive a reload';
            const ta = document.getElementById('v4-cap-text-area') as HTMLTextAreaElement; if (ta) ta.value = 'should not survive a reload';
        });
        await page.reload();
        await page.waitForFunction(() => typeof (window as any)._clearCaptureState === 'function', null, { timeout: 8000 });
        await page.evaluate(() => (window as any).__crispGoToStage('stage-v4-capture'));
        expect(await page.evaluate(() => (window as any).state.description), 'state is in-memory; reload yields a fresh report').toBe('');
        await expect(page.locator('#v4-cap-text-area')).toHaveValue('');
    });

    // ── Boundary: reset NEVER touches the IndexedDB queue (offline-first) ────
    // The fix clears in-memory `state` + capture DOM, but the `pending-reports`
    // IDB queue is sacred: queued offline reports MUST survive every reset
    // (UNDP must-have #3, offline-first). If a future over-zealous reset ever
    // drained or mutated the queue, real users would lose un-submitted reports.
    // This locks the boundary so that regression fails loudly here.
    test('IDB queue (pending-reports) survives reset untouched — depth + payloads intact', async ({ page }) => {
        const leaks = trackResetLeaks(page);
        const r = await page.evaluate(async () => {
            const enq = (window as any).__crispEnqueueReport;
            const all = (window as any).__crispGetAllQueued;
            const mine = (rows: any[]) => rows.filter((q) => String(q.client_report_id || '').startsWith('reset-boundary-'));
            // Seed 3 distinct queued (offline) reports.
            const seed = [
                { client_report_id: 'reset-boundary-A', meta: { description: 'offline A', location: { lat: 1, lng: 2 } } },
                { client_report_id: 'reset-boundary-B', meta: { description: 'offline B', location: { lat: 3, lng: 4 } } },
                { client_report_id: 'reset-boundary-C', meta: { description: 'offline C', location: { lat: 5, lng: 6 } } },
            ];
            for (const p of seed) await enq(p);
            const before = mine(await all());
            // Hammer reset 5× with a dirty capture each time — the queue must not move.
            for (let i = 0; i < 5; i++) {
                const s = (window as any).state;
                s.description = 'dirty ' + i;
                s.audioBlob = new Blob(['x' + i], { type: 'audio/webm' });
                s.crisisStockAnswers = { q: i };
                s.crisis_type = 'FLOOD';
                (window as any)._clearCaptureState();
            }
            const after = mine(await all());
            const key = (q: any) => `${q.client_report_id}|${q.meta?.description}|${q.meta?.location?.lat},${q.meta?.location?.lng}`;
            const s = (window as any).state;
            return {
                beforeCount: before.length,
                afterCount: after.length,
                beforeKeys: before.map(key).sort(),
                afterKeys: after.map(key).sort(),
                stateClean: s.description === '' && s.audioBlob === null && JSON.stringify(s.crisisStockAnswers) === '{}',
            };
        });
        expect(r.beforeCount, 'seeded 3 offline reports into the queue').toBe(3);
        expect(r.afterCount, 'all 3 queued reports survive 5 resets — queue never shrinks').toBe(3);
        expect(r.afterKeys, 'queued payloads identical after reset — queue never mutated').toEqual(r.beforeKeys);
        expect(r.stateClean, 'reset still cleared the in-memory capture state').toBe(true);
        expect(leaks).toEqual([]);
    });
});
