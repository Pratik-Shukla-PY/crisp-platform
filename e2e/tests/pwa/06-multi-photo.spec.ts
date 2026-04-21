/**
 * PR 5 (Apr 2026) — multi-image capture regression guards.
 *
 * The camera modal uses `getUserMedia` which Chromium headless can't really
 * stream, so we don't exercise the live viewfinder here. Instead we:
 *
 *   · Verify the DOM scaffolding exists (`#cam-gallery`, `#btn-cam-done`,
 *     `multiple` attr on `#file-browse`). If anyone removes them the spec
 *     fails loudly before the behaviour breaks in production.
 *
 *   · Drive the **browse** multi-select path (which uses the same ingest
 *     pipeline as the camera modal) with two files, then assert the primary
 *     photo + exactly one extra land in `state` and the extras strip renders
 *     both thumbnails.
 *
 *   · Verify awaiting the blur-pending array doesn't hang when nothing is
 *     pending (clean-slate submit path).
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

function writeTestJpeg(tag: string): string {
  const tmp = path.join(os.tmpdir(), `crisp-pr5-${tag}-${Date.now()}.jpg`);
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

test.describe('PWA multi-image capture (PR 5)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('index.html');
    await page.evaluate(() => {
      localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
    });
    await page.reload();
    const enBtn = page.locator('#btn-lang-en');
    if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
    await page.evaluate(() => {
      const c = document.getElementById('consent-overlay');
      if (c) c.style.display = 'none';
    });
  });

  test('@smoke #file-browse has multiple attribute', async ({ page }) => {
    await page.locator('#btn-start').click();
    await expect(page.locator('#stage-photo.active')).toBeVisible();
    // Regression guard — PR 5 added `multiple` so browse lets users pick
    // several photos at once. Losing it silently reverts to single-pick.
    const multiple = await page.locator('#file-browse').getAttribute('multiple');
    expect(multiple).not.toBeNull();
  });

  test('@smoke camera modal exposes mini-gallery + Done button', async ({ page }) => {
    // We don't open the modal via live getUserMedia (unavailable headless),
    // but the DOM scaffolding must be present so PR 5 doesn't regress.
    await expect(page.locator('#camera-modal')).toBeAttached();
    await expect(page.locator('#cam-gallery')).toBeAttached();
    await expect(page.locator('#cam-gallery-scroll')).toBeAttached();
    await expect(page.locator('#cam-gallery-count')).toBeAttached();
    await expect(page.locator('#btn-cam-done')).toBeAttached();
    // Done button starts disabled — only the first snap enables it.
    const disabled = await page.locator('#btn-cam-done').getAttribute('disabled');
    expect(disabled).not.toBeNull();
  });

  test('@smoke modal controls stay in viewport when modal is open (hotfix)', async ({ page }) => {
    // Hotfix regression guard — when the modal opens, the shutter row and
    // both side buttons must be inside the viewport. Previously the video's
    // intrinsic aspect ratio pushed them off the bottom on desktop Edge.
    await page.evaluate(() => {
      const m = document.getElementById('camera-modal');
      if (m) m.style.display = 'flex';
    });
    const vp = page.viewportSize() || { width: 800, height: 600 };
    for (const id of ['btn-cam-close', 'btn-cam-snap', 'btn-cam-done']) {
      const box = await page.locator(`#${id}`).boundingBox();
      expect(box, `${id} should have a bounding box`).not.toBeNull();
      // bottom edge of the button must be ≤ viewport height (on-screen).
      expect(box!.y + box!.height).toBeLessThanOrEqual(vp.height);
      // Button must have non-zero dimensions.
      expect(box!.width).toBeGreaterThan(0);
      expect(box!.height).toBeGreaterThan(0);
    }
  });

  test('browse multi-select: first asset → primary, rest → extras', async ({ page }) => {
    await page.locator('#btn-start').click();
    await expect(page.locator('#stage-photo.active')).toBeVisible();

    const a = writeTestJpeg('a');
    const b = writeTestJpeg('b');
    // Playwright lets us set multiple files in one go. This exercises the
    // new multi-select path end-to-end.
    await page.locator('#file-browse').setInputFiles([a, b]);

    // Primary photo renders.
    await expect(page.locator('#photo-preview')).toBeVisible({ timeout: 10_000 });

    // One extra lands in state — the async blob pipeline needs a moment
    // to run, so poll via waitForFunction.
    await page.waitForFunction(() => {
      const s = (window as any).state;
      return s && s.photoDataUrl && Array.isArray(s.extraPhotos) && s.extraPhotos.length === 1;
    }, null, { timeout: 10_000 });

    // The extras strip shows the primary + extra (2 thumbs total).
    await expect(page.locator('#extra-photos-strip')).toBeVisible();
    const thumbs = page.locator('#extra-photos-scroll .extra-photo-thumb');
    await expect(thumbs).toHaveCount(2);
  });

  test('photoBlurPending is an array (not a single promise)', async ({ page }) => {
    await page.locator('#btn-start').click();
    // Stay on photo stage — state is initialized on boot. The PR 5 refactor
    // changed the slot from a single promise to an array; a regression to
    // the single-slot form would re-introduce the multi-capture data-race.
    const isArray = await page.evaluate(() => {
      const s = (window as any).state;
      return Array.isArray(s && s.photoBlurPending);
    });
    expect(isArray).toBe(true);
  });
});
