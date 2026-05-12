/**
 * PWA — v4 multi-photo capture regression guard (May 2026).
 *
 * Reproduces the bug we just shipped to PROD:
 *
 *   1. v4-flow.js _handlePhoto invoked `__crispIngestFile(file, asExtra: false)`
 *      for EVERY browse-multi-select file. That made each successive file
 *      overwrite state.photoDataUrl + state.photoVariants, losing photos
 *      1..N-1 before submitReport built the queue item.
 *   2. v4-flow.js _modalCloseHandler called `_setState({ extraPhotos: [] })`
 *      right after the camera modal closed. submitReport reads from
 *      state.extraPhotos to build extraPhotosVariants — wipe meant zero
 *      extras queued no matter how many snaps were taken.
 *
 * DB census from the day: every recent APP-source report had
 * `media=3 groups=1` (one photo × three tiers) regardless of how many
 * photos the reporter actually captured.
 *
 * This spec locks down the fix by driving v4's browseInput with 3 files
 * and asserting state.extraPhotos.length === 2 with variants on each —
 * exactly what submitReport at app.js:7100 needs to build a 3-photo
 * queue item (3 photos × 3 tiers = 9 chunked uploads).
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

function writeTestJpeg(tag: string): string {
    const tmp = path.join(os.tmpdir(), `crisp-v4multi-${tag}-${Date.now()}.jpg`);
    // Minimal valid JPEG (same byte-perfect literal the v3 multi-photo
    // spec uses — see 06-multi-photo.spec.ts).
    const b64 =
        '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
        'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
        'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAKAAoDASIA' +
        'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
        'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
        'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
        'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB' +
        'AAIRAxEAPwD3+iiigD//2Q==';
    fs.writeFileSync(tmp, Buffer.from(b64, 'base64'));
    return tmp;
}

async function openV4Pwa(page) {
    await page.goto('index.html?ui=v4');
    await page.evaluate(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
    });
    await page.reload();
    const enBtn = page.locator('#btn-lang-en');
    if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
    await page.evaluate(() => {
        const c = document.getElementById('consent-overlay');
        if (c) c.style.display = 'none';
    });
    // Wait until the v4 flow has wired up its DOM. Different selector than
    // the v3 stage-photo container.
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function',
        null, { timeout: 8000 },
    );
}

test.describe('PWA v4 multi-photo capture (May 2026 bugfix)', () => {
    test.beforeEach(async ({ page }) => { await openV4Pwa(page); });

    test('browse multi-select: 3 files → 1 primary + 2 extras (with variants)', async ({ page }) => {
        // Navigate to the v4 capture stage. The "Start Report" button on
        // the v4 home is what kicks off the capture flow.
        await page.evaluate(() => {
            const fn = (window as any).__crispGoToStage;
            if (typeof fn === 'function') fn('photo');
        });

        // Locate the v4 browse input. v4 reuses the same #file-browse id
        // but adds its own change listener (v4-flow.js:779).
        const browseInput = page.locator('input[type="file"]').first();
        await expect(browseInput, 'browse file input not found in v4 flow').toBeAttached();

        const files = [writeTestJpeg('a'), writeTestJpeg('b'), writeTestJpeg('c')];
        await browseInput.setInputFiles(files);

        // Wait for the async variant pipeline to run for ALL THREE photos.
        // The v3 ingest helper schedules ImageVariants.generate via
        // _runWhenIdle, so each photo's variants land on a microtask
        // queue settle. Poll state until extras have variants on every
        // entry.
        await page.waitForFunction(() => {
            const s = (window as any).state;
            if (!s) return false;
            if (!s.photoDataUrl) return false;            // primary not set
            if (!s.photoVariants) return false;           // primary variants not set
            const extras = s.extraPhotos || [];
            if (extras.length !== 2) return false;        // exactly 2 extras
            // Each extra MUST have variants populated (async pipeline must
            // have settled). variants.small + .medium + .large all present.
            for (const e of extras) {
                if (!e || !e.variants) return false;
                if (!e.variants.small || !e.variants.medium || !e.variants.large) return false;
            }
            return true;
        }, null, { timeout: 15_000 });

        // Triple-verify the structural invariants the submit pipeline relies on.
        const snapshot = await page.evaluate(() => {
            const s = (window as any).state;
            return {
                v4Count: (s.v4Photos || []).length,
                hasPrimary: Boolean(s.photoDataUrl && s.photoVariants),
                extrasCount: (s.extraPhotos || []).length,
                extrasWithVariants: (s.extraPhotos || []).filter((e: any) => e && e.variants).length,
            };
        });
        expect(snapshot.v4Count, 'v4Photos array').toBe(3);
        expect(snapshot.hasPrimary, 'state.photoDataUrl + state.photoVariants set').toBe(true);
        expect(snapshot.extrasCount, 'state.extraPhotos.length').toBe(2);
        expect(snapshot.extrasWithVariants, 'extras with variants').toBe(2);
    });

    test('modal close handler does NOT clear state.extraPhotos', async ({ page }) => {
        // Direct unit-style assertion: seed state.extraPhotos, dispatch
        // the camera-modal-closed event v4-flow.js listens for, then
        // confirm state.extraPhotos is still populated.
        await page.evaluate(() => {
            const s = (window as any).state;
            // Seed two extras with the shape v4-flow's modal-close
            // handler would have seen from real snaps.
            s.extraPhotos = [
                {
                    dataUrl: 'data:image/jpeg;base64,/9j/seedA',
                    blob: new Blob(['a']),
                    groupId: 'grp-A',
                    variants: { small: { bytes: 100 }, medium: { bytes: 500 }, large: { bytes: 2000 } },
                },
                {
                    dataUrl: 'data:image/jpeg;base64,/9j/seedB',
                    blob: new Blob(['b']),
                    groupId: 'grp-B',
                    variants: { small: { bytes: 100 }, medium: { bytes: 500 }, large: { bytes: 2000 } },
                },
            ];
        });

        // Trigger the modal-close event the v4 flow's handler fires on.
        await page.evaluate(() => {
            document.dispatchEvent(new Event('camera-modal-closed'));
        });

        // Tiny settle window for the handler to run.
        await page.waitForTimeout(500);

        const extrasAfter = await page.evaluate(() => {
            const s = (window as any).state;
            return (s.extraPhotos || []).length;
        });
        expect(extrasAfter, 'state.extraPhotos must survive modal close').toBeGreaterThanOrEqual(2);
    });
});
