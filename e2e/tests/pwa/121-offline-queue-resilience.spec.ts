/**
 * PWA — offline-queue resilience (Jun 2026): kill the "stuck at N%" wedge.
 *
 * Companion to 84-queue-orphan-self-heal. Where 84 covers the classic
 * orphan (serverId === null, no payload), THIS spec covers the genuine
 * sharp edge that prompted the resilience pass: a report whose meta/text
 * landed (serverId SET) but whose photo was intended yet has NO uploadable
 * bytes — `_buildVariantWork()` returns [] (no photoVariants) AND there is
 * no legacy `item.photo`. Pre-fix, `trySendQueuedReport`'s photo block fell
 * through with no trailing `else`, so `stages.photo` never flipped and the
 * drain looped forever ("stuck at N%").
 *
 * Verifies (live backend on :8000 + static on :8080):
 *   1. Backstop (Commit 2) — an OLD (>10 min) photo-intended-no-bytes row
 *      drives `_backstopPhotoIntendedNoBytes`: one mark-deferred POST with
 *      reason='orphan_no_source' for the photo group, and `stages.photo`
 *      flips true so the drain stops looping.
 *   2. Age gate — a YOUNG (<10 min) row of the same shape does NOT fire the
 *      backstop (a still-in-flight encode could yet populate bytes):
 *      no mark-deferred POST, `stages.photo` stays false.
 *   3. Calm "needs attention" badge (Commit 4) — an item carrying the soft
 *      `_needsAttention` flag renders the sync-badge in the calm `.attention`
 *      sub-state (NOT the red `.error`), never stopping delivery.
 *
 * The wedge-recovery + flaky-backend escalation are intentionally surfaced
 * WITHOUT a `status='failed'` writer — the report is delivered, just with an
 * honest note.
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
           && typeof (window as any).__crispTrySendQueuedReport === 'function'
           && typeof (window as any).__crispGoToStage === 'function',
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

// A photo-INTENDED report whose meta/text/audio landed (serverId set) but
// which has NO uploadable photo bytes: photoVariants === null (→
// _buildVariantWork() === []) AND item.photo === null. `text` is non-empty
// so the orphan self-heal predicate (84) does NOT claim it — this is a
// genuine, server-acknowledged report wedged ONLY on the absent photo.
function makeWedge(opts: { id: string; ageMinutes: number; groupId: string }): any {
    return {
        client_report_id: opts.id,
        timestamp: Date.now() - (opts.ageMinutes * 60 * 1000),
        serverId: '33333333-3333-3333-3333-333333333333',
        stages: { meta: true, text: true, photo: false, audio: true },
        text: 'East wall of the building collapsed; debris on the road.',
        audioBlob: null,
        photoVariants: null,          // → _buildVariantWork() === []
        extraPhotosVariants: [],
        photoGroupId: opts.groupId,   // backstop signals mark-deferred for this group
        photo: null,                  // no legacy fallback → backstop branch
        meta: { crisis_type: 'EARTHQUAKE' },
        sendAttempts: 0,
    };
}

test.describe('PWA — offline-queue resilience (stuck-at-N% wedge)', () => {

    test.beforeEach(async ({ page }) => {
        await bootV4(page);
        await clearQueue(page);
    });

    test.afterEach(async ({ page }) => {
        await clearQueue(page);
    });

    test('@smoke backstop: OLD photo-intended-no-bytes row → mark-deferred(orphan_no_source) + stages.photo flips', async ({ page }) => {
        // Capture (and satisfy) the backstop's mark-deferred POST.
        const deferredCalls: any[] = [];
        await page.route('**/media/mark-deferred', async (route) => {
            let body: any = null;
            try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
            deferredCalls.push(body);
            await route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ newly_stamped: 3, sync_status: 'PARTIAL' }),
            });
        });

        const wedge = makeWedge({ id: 'wedge-old', ageMinutes: 30, groupId: 'grp-old-1' });
        await page.evaluate(async (row) => {
            await (window as any).__crispEnqueueReport(row);
            await (window as any).__crispTrySendQueuedReport(row);
        }, wedge);

        // Exactly one mark-deferred POST, reason orphan_no_source, our group,
        // all three tiers signalled (no variant structure to enumerate).
        expect(deferredCalls.length).toBe(1);
        expect(deferredCalls[0].reason).toBe('orphan_no_source');
        expect(Object.keys(deferredCalls[0].tiers_by_group)).toContain('grp-old-1');
        expect(deferredCalls[0].tiers_by_group['grp-old-1'].sort())
            .toEqual(['MEDIUM', 'ORIGINAL', 'SMALL']);

        // stages.photo flipped true so the drain never re-enters the wedge.
        const rows = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const row = rows.find((r: any) => r.client_report_id === 'wedge-old');
        // Either still queued with stages.photo=true, or already dequeued —
        // both mean the loop is resolved. It must NOT remain photo=false.
        if (row) {
            expect(row.stages.photo).toBe(true);
            expect(row.photo).toBeFalsy();
        }
    });

    test('age gate: YOUNG (<10 min) row of the same shape does NOT fire the backstop', async ({ page }) => {
        const deferredCalls: any[] = [];
        await page.route('**/media/mark-deferred', async (route) => {
            deferredCalls.push(route.request().postData());
            await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        });

        const wedge = makeWedge({ id: 'wedge-young', ageMinutes: 2, groupId: 'grp-young-1' });
        await page.evaluate(async (row) => {
            await (window as any).__crispEnqueueReport(row);
            await (window as any).__crispTrySendQueuedReport(row);
        }, wedge);

        // No mark-deferred (transient/in-flight window protected).
        expect(deferredCalls.length).toBe(0);
        // stages.photo stays false — the row remains queued for a later drain.
        const rows = await page.evaluate(() => (window as any).__crispGetAllQueued());
        const row = rows.find((r: any) => r.client_report_id === 'wedge-young');
        expect(row).toBeTruthy();
        expect(row.stages.photo).toBe(false);
    });

    test('@smoke calm "needs attention" badge sub-state (NOT the red error pill)', async ({ page }) => {
        // Seed a visible queued item carrying the soft flaky-backend flag.
        await page.evaluate(async () => {
            await (window as any).__crispEnqueueReport({
                client_report_id: 'na-1',
                timestamp: Date.now(),
                serverId: '44444444-4444-4444-4444-444444444444',
                stages: { meta: true, text: true, photo: false, audio: true },
                text: 'Flooding on the ground floor.',
                audioBlob: null,
                photoVariants: null,
                extraPhotosVariants: [],
                photo: null,
                status: 'queued',
                _needsAttention: true,        // resilience #4 soft flag
                meta: { crisis_type: 'FLOOD' },
            });
            // Land on home so updateSyncBadge is allowed to render the pill.
            (window as any).__crispGoToStage('stage-home');
        });

        const badge = page.locator('#sync-badge');
        // Calm amber sub-state, never the red .error.
        await expect(badge).toHaveClass(/\battention\b/, { timeout: 6000 });
        await expect(badge).not.toHaveClass(/\berror\b/);
    });

    test('stuck-chunk: K consecutive hard 410s regenerate the media_id (Commit 5)', async ({ page }) => {
        // Deterministic but slow — the regen only fires after K (=3) calls,
        // each exhausting the FAST-tier retry backoff (~30 s). No network
        // flakiness: the chunk endpoint is stubbed to 410 instantly.
        test.setTimeout(180_000);

        // Hard-reject every chunk POST (both transports) with 410 Gone —
        // the "media hard-abandoned" signal the regen path is built for.
        await page.route('**/media/chunk-bin', (route) =>
            route.fulfill({ status: 410, contentType: 'application/json', body: '{"detail":"gone"}' }));
        await page.route('**/media/chunk', (route) =>
            route.fulfill({ status: 410, contentType: 'application/json', body: '{"detail":"gone"}' }));
        // The give-up path (not reached at K=3 / regen=1) would POST mark-deferred —
        // stub it harmlessly so nothing escapes to the live backend.
        await page.route('**/media/mark-deferred', (route) =>
            route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

        const TINY_JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==';
        const ORIG_ID = 'orig-media-id';

        // Seed a serverId-set, photo-intended report with ONE variant whose
        // chunk will be permanently rejected. Enqueue it so the drain owns it.
        await page.evaluate(async ({ serverId, groupId, dataUrl, origId }) => {
            try { (window as any).__crispSetPWATier && (window as any).__crispSetPWATier('FAST'); } catch (_) {}
            await (window as any).__crispEnqueueReport({
                client_report_id: 'sc-regen-1',
                serverId,
                timestamp: Date.now(),
                stages: { meta: true, text: true, photo: false, audio: true },
                text: 'Bridge support cracked.',
                photoGroupId: groupId,
                photoVariants: {
                    small: { dataUrl, mediaId: origId, chunkProgress: 0, complete: false, size: 0 },
                },
                extraPhotosVariants: [],
                photo: null,
                meta: { crisis_type: 'EARTHQUAKE' },
            });
        }, { serverId: '55555555-5555-5555-5555-555555555555', groupId: 'sc-grp-1', dataUrl: TINY_JPEG, origId: ORIG_ID });

        // Drive drain passes by re-reading the freshly-persisted row each
        // time (the drain re-enqueues it after every 410). Each pass = one
        // chunk attempt → one hard-410 → one fail-count tick; after K=3 the
        // media row regenerates. Re-pin FAST so a per-pass tier downgrade
        // can't balloon the retry backoff. Race-robust: whichever code path
        // (this nudge or a background drain) reaches K writes the
        // regenerated media_id back to IDB, which we then observe.
        await page.evaluate(async () => {
            for (let i = 0; i < 6; i++) {
                try { (window as any).__crispSetPWATier && (window as any).__crispSetPWATier('FAST'); } catch (_) {}
                const items = await (window as any).__crispGetAllQueued();
                const row = items.find((r: any) => r.client_report_id === 'sc-regen-1');
                if (!row) break;
                const mid = row.photoVariants?.small?.mediaId;
                if (mid && mid !== 'orig-media-id') break; // already regenerated
                try { await (window as any).__crispTrySendQueuedReport(row); } catch (_) { /* 410 expected */ }
            }
        });

        // Observe the regenerated media row from IDB (the source of truth).
        await page.waitForFunction(async () => {
            const items = await (window as any).__crispGetAllQueued();
            const row = items.find((r: any) => r.client_report_id === 'sc-regen-1');
            const v = row && row.photoVariants && row.photoVariants.small;
            return !!(v && v.mediaId && v.mediaId !== 'orig-media-id' && (v.mediaIdRegens || 0) >= 1);
        }, null, { timeout: 150_000, polling: 1500 });

        const row = await page.evaluate(async () => {
            const items = await (window as any).__crispGetAllQueued();
            const r = items.find((x: any) => x.client_report_id === 'sc-regen-1');
            return r ? r.photoVariants.small : null;
        });
        // Regenerated exactly once (fresh UUID, != original), chunkProgress
        // reset, tier NOT yet given up (give-up needs R=2 regens).
        expect(row).toBeTruthy();
        expect(row.mediaId).not.toBe(ORIG_ID);
        expect(row.mediaIdRegens).toBe(1);
        expect(row.chunkProgress).toBe(0);
        expect(!!row.chunkRejectedGiveUp).toBe(false);
    });
});
