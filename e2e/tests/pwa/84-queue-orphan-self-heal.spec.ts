/**
 * PWA — IndexedDB queue orphan self-heal (May 2026).
 *
 * Operator-reported, 2026-05-13: a submission was interrupted mid-flight
 * (page close or JS error) and left a row in `crisp-offline /
 * pending-reports` with `stages.meta = stages.text = stages.audio = true`
 * but `serverId = null` AND zero actual payload (description empty, no
 * audio blob, every photo variant at chunkProgress=0). The row sat ~24h:
 *
 *   · invisible to the soft-drain dequeue path — that branch gates on
 *     `stages.meta && text && photo && audio` and `stages.photo` was
 *     false, so the row never even entered the dequeue check.
 *   · skipped by the retry loop — the photo-upload call threw on null
 *     serverId before bumping retryCount, so the item ricocheted between
 *     "not ready" and "errored" with no forward progress.
 *
 * Self-heal rule: when stages claim ANY upload happened but there is
 *   (a) no server-side report id, AND
 *   (b) no local payload bytes for any stage,
 * the row cannot make forward progress — there is literally nothing to
 * send. The 10-minute age gate avoids racing a genuine in-flight
 * submission whose stages haven't fully populated yet.
 *
 * This spec verifies:
 *   1. Orphan row > 10 min old gets auto-dequeued
 *   2. Orphan row < 10 min old is preserved (could be in-flight)
 *   3. Row with serverId set is preserved (genuine in-flight)
 *   4. Row with stages.X=true AND matching payload (description text) is
 *      preserved
 *   5. Self-heal fires on syncQueueManual entry
 *   6. Self-heal fires on boot (re-load page with seeded orphan)
 */
import { test, expect, Page } from '@playwright/test';

async function bootV4(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', 'en');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispEnqueueReport === 'function'
           && typeof (window as any).__crispGetAllQueued === 'function'
           && typeof (window as any).__crispDequeueReport === 'function'
           && typeof (window as any).__crispSelfHealOrphans === 'function'
           && typeof (window as any).__crispIsOrphanQueueRow === 'function',
        null, { timeout: 8000 },
    );
}

async function clearQueue(page: Page) {
    await page.evaluate(async () => {
        const items = await (window as any).__crispGetAllQueued();
        for (const it of items) {
            try { await (window as any).__crispDequeueReport(it.client_report_id); } catch (_) {}
        }
    });
}

// Common orphan shape — stages claim sent, no serverId, no payload.
function makeOrphan(opts: { id: string; ageMinutes: number }): any {
    return {
        client_report_id: opts.id,
        timestamp: Date.now() - (opts.ageMinutes * 60 * 1000),
        stages: { meta: true, text: true, photo: false, audio: true },
        serverId: null,
        text: '',
        audioBlob: null,
        photoVariants: {
            small:  { dataUrl: null, mediaId: 'm1', chunkProgress: 0, complete: false, size: 0 },
            medium: { dataUrl: null, mediaId: 'm2', chunkProgress: 0, complete: false, size: 0 },
            large:  { dataUrl: null, mediaId: 'm3', chunkProgress: 0, complete: false, size: 0 },
        },
        extraPhotosVariants: [],
        photo: null,
        meta: { crisis_type: 'EARTHQUAKE' },
    };
}

test.describe('PWA — IndexedDB queue orphan self-heal', () => {

    test.beforeEach(async ({ page }) => {
        await bootV4(page);
        await clearQueue(page);
    });

    test.afterEach(async ({ page }) => {
        await clearQueue(page);
    });

    // ── _isOrphanQueueRow predicate ────────────────────────────────────

    test('@smoke predicate flags zero-payload row with stage claims as orphan when old', async ({ page }) => {
        const flagged = await page.evaluate((row) => {
            return (window as any).__crispIsOrphanQueueRow(row);
        }, makeOrphan({ id: 'r-orphan-old', ageMinutes: 30 }));
        expect(flagged).toBe(true);
    });

    test('predicate does NOT flag the same shape when younger than 10 min', async ({ page }) => {
        const flagged = await page.evaluate((row) => {
            return (window as any).__crispIsOrphanQueueRow(row);
        }, makeOrphan({ id: 'r-orphan-young', ageMinutes: 2 }));
        expect(flagged).toBe(false);
    });

    test('predicate does NOT flag a row with serverId set (genuine in-flight)', async ({ page }) => {
        const row = makeOrphan({ id: 'r-has-server-id', ageMinutes: 60 });
        row.serverId = '00000000-0000-0000-0000-000000000001';
        const flagged = await page.evaluate((r) => {
            return (window as any).__crispIsOrphanQueueRow(r);
        }, row);
        expect(flagged).toBe(false);
    });

    test('predicate does NOT flag a row with matching text payload', async ({ page }) => {
        const row = makeOrphan({ id: 'r-has-text', ageMinutes: 60 });
        row.text = 'Building partially collapsed on the east side';
        const flagged = await page.evaluate((r) => {
            return (window as any).__crispIsOrphanQueueRow(r);
        }, row);
        expect(flagged).toBe(false);
    });

    test('predicate does NOT flag a row with audio payload', async ({ page }) => {
        const row = makeOrphan({ id: 'r-has-audio', ageMinutes: 60 });
        row.audioBlob = 'data:audio/webm;base64,GkXfo0AgQoaB';
        const flagged = await page.evaluate((r) => {
            return (window as any).__crispIsOrphanQueueRow(r);
        }, row);
        expect(flagged).toBe(false);
    });

    test('predicate does NOT flag a row with photo bytes in progress', async ({ page }) => {
        const row = makeOrphan({ id: 'r-has-photo-bytes', ageMinutes: 60 });
        row.photoVariants.small.chunkProgress = 3;
        const flagged = await page.evaluate((r) => {
            return (window as any).__crispIsOrphanQueueRow(r);
        }, row);
        expect(flagged).toBe(false);
    });

    test('predicate does NOT flag a row whose stages are all false (never started)', async ({ page }) => {
        const row = makeOrphan({ id: 'r-never-started', ageMinutes: 60 });
        row.stages = { meta: false, text: false, photo: false, audio: false };
        const flagged = await page.evaluate((r) => {
            return (window as any).__crispIsOrphanQueueRow(r);
        }, row);
        expect(flagged).toBe(false);
    });

    // ── _selfHealOrphans driver ────────────────────────────────────────

    test('@smoke selfHealOrphans dequeues old orphan, leaves young orphan + valid row alone', async ({ page }) => {
        // Seed three rows: old orphan, young orphan, valid in-flight.
        await page.evaluate(async (rows) => {
            for (const r of rows) {
                await (window as any).__crispEnqueueReport(r);
            }
        }, [
            makeOrphan({ id: 'r-old-orphan', ageMinutes: 30 }),
            makeOrphan({ id: 'r-young-orphan', ageMinutes: 2 }),
            (() => {
                const r = makeOrphan({ id: 'r-valid-inflight', ageMinutes: 30 });
                r.serverId = '11111111-1111-1111-1111-111111111111';
                return r;
            })(),
        ]);
        // Sanity — all three landed.
        const before = await page.evaluate(() => (window as any).__crispGetAllQueued());
        expect(before.map((i: any) => i.client_report_id).sort()).toEqual(
            ['r-old-orphan', 'r-valid-inflight', 'r-young-orphan'],
        );

        const healed = await page.evaluate(() => (window as any).__crispSelfHealOrphans());
        expect(healed).toBe(1);

        const after = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const ids = after.map((i: any) => i.client_report_id).sort();
        expect(ids).toEqual(['r-valid-inflight', 'r-young-orphan']);
    });

    test('selfHealOrphans returns 0 when queue is empty', async ({ page }) => {
        const healed = await page.evaluate(() => (window as any).__crispSelfHealOrphans());
        expect(healed).toBe(0);
    });

    test('selfHealOrphans returns 0 when no rows match orphan shape', async ({ page }) => {
        await page.evaluate(async (row) => {
            await (window as any).__crispEnqueueReport(row);
        }, (() => {
            const r = makeOrphan({ id: 'r-only-valid', ageMinutes: 30 });
            r.serverId = '22222222-2222-2222-2222-222222222222';
            return r;
        })());
        const healed = await page.evaluate(() => (window as any).__crispSelfHealOrphans());
        expect(healed).toBe(0);
        const after = await page.evaluate(() => (window as any).__crispGetAllQueued());
        expect(after).toHaveLength(1);
    });

    // ── Wiring: syncQueueManual entry ──────────────────────────────────

    test('syncQueueManual drains an old orphan on entry', async ({ page }) => {
        await page.evaluate(async (row) => {
            await (window as any).__crispEnqueueReport(row);
        }, makeOrphan({ id: 'r-sync-entry-orphan', ageMinutes: 30 }));
        // Confirm seed landed.
        const before = await page.evaluate(() => (window as any).__crispGetAllQueued());
        expect(before).toHaveLength(1);

        await page.evaluate(() => (window as any).syncQueueManual({ showFeedback: false }));

        const after = await page.evaluate(() => (window as any).__crispGetAllQueued());
        expect(after).toHaveLength(0);
    });

    // ── Wiring: boot path ─────────────────────────────────────────────

    test('orphan seeded into IDB is drained on next page load', async ({ page }) => {
        // Seed the orphan directly into IDB BEFORE the next navigation,
        // then reload so the DOMContentLoaded boot path runs self-heal.
        await page.evaluate(async (row) => {
            await (window as any).__crispEnqueueReport(row);
        }, makeOrphan({ id: 'r-boot-orphan', ageMinutes: 30 }));
        const beforeReload = await page.evaluate(() => (window as any).__crispGetAllQueued());
        expect(beforeReload).toHaveLength(1);

        // Reload — boot path's _selfHealOrphans() call should drain.
        await page.reload();
        await page.waitForFunction(
            () => typeof (window as any).__crispGetAllQueued === 'function',
            null, { timeout: 8000 },
        );
        // Give the async boot orphan-sweep a beat to complete.
        await page.waitForFunction(async () => {
            const items = await (window as any).__crispGetAllQueued();
            return items.length === 0;
        }, null, { timeout: 5000 });

        const afterReload = await page.evaluate(() => (window as any).__crispGetAllQueued());
        expect(afterReload).toHaveLength(0);
    });

    test('young orphan seeded into IDB is PRESERVED across page load', async ({ page }) => {
        await page.evaluate(async (row) => {
            await (window as any).__crispEnqueueReport(row);
        }, makeOrphan({ id: 'r-boot-young', ageMinutes: 2 }));
        await page.reload();
        await page.waitForFunction(
            () => typeof (window as any).__crispGetAllQueued === 'function',
            null, { timeout: 8000 },
        );
        // Wait long enough for any boot-path sweep to have fired.
        await page.waitForTimeout(1500);
        const after = await page.evaluate(() => (window as any).__crispGetAllQueued());
        expect(after).toHaveLength(1);
        expect(after[0].client_report_id).toBe('r-boot-young');
    });
});
