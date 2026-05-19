/**
 * Apr 2026 — Image viewer + thumbnail-delete regression guards.
 *
 * Requirements this guards against regressing:
 *   · Full-screen image-viewer overlay exists in the DOM (hidden by
 *     default; opens when a thumb is tapped on stage-photo).
 *   · Viewer has Close + Delete controls + a confirmation dialog.
 *   · Every `.extra-photo-thumb` rendered with content has an
 *     `.extra-photo-remove` ❌ child.
 *   · Seeding `state.photoDataUrl` renders the primary thumb with a ❌.
 *
 * We don't drive the full capture flow here — just assert the scaffolding
 * that makes the feature possible. The end-to-end delete interaction is
 * validated via the existing 02-capture-flow + 06-multi-photo specs
 * transitively (they add photos, and this spec adds a thumb-exists check).
 */
import { test, expect } from '@playwright/test';

async function openClean(page) {
  await page.goto('index.html');
  await page.evaluate(() => {
    localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');  // Pre-v4 tests target the v3 capture flow.
  });
  await page.reload();
  await page.evaluate(() => {
    const c = document.getElementById('consent-overlay');
    if (c) c.style.display = 'none';
  });
}

test.describe('PWA image viewer + thumbnail-delete (Apr 2026)', () => {
  test.beforeEach(async ({ page }) => { await openClean(page); });

  test('@smoke viewer overlay + confirm-dialog are in the DOM (hidden by default)', async ({ page }) => {
    await expect(page.locator('#image-viewer-overlay')).toBeAttached();
    await expect(page.locator('#image-viewer-overlay')).toBeHidden();
    await expect(page.locator('#image-delete-confirm')).toBeAttached();
    await expect(page.locator('#image-delete-confirm')).toBeHidden();
    // Essential controls.
    await expect(page.locator('#btn-image-viewer-close')).toBeAttached();
    await expect(page.locator('#btn-image-viewer-delete')).toBeAttached();
    await expect(page.locator('#btn-idc-cancel')).toBeAttached();
    await expect(page.locator('#btn-idc-confirm')).toBeAttached();
  });

  // Phase F triage (May 2026): "primary photo thumb renders with ❌"
  // targeted V3's #extra-photos-strip + #extra-photos-scroll layout
  // on #stage-photo. V3 retired; V4 (stage-v4-capture) uses a
  // different captured-strip DOM. The remove-thumb invariant is now
  // covered by 30-v4-bug-fixes BUG 7 (state-clear) and
  // 27-v4-flow's photo-tile tests. Deleting this lone V3 assertion
  // here; the remaining 3 tests in this file (DOM scaffolding +
  // viewer open/close + delete-inside-viewer) still pass and cover
  // the cross-stage image-viewer surface.

  test('viewer opens via programmatic trigger + close dismisses', async ({ page }) => {
    await page.evaluate(() => {
      (window as any).__crispOpenImageViewer(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=',
        { kind: 'extra', index: 0 }
      );
    });
    await expect(page.locator('#image-viewer-overlay')).toBeVisible();
    await expect(page.locator('#image-viewer-img')).toHaveAttribute('src', /iVBOR/);
    // Close via the X button.
    await page.locator('#btn-image-viewer-close').click();
    await expect(page.locator('#image-viewer-overlay')).toBeHidden();
  });

  test('delete-inside-viewer opens confirm + cancel dismisses without delete', async ({ page }) => {
    await page.evaluate(() => {
      const s = (window as any).state;
      s.photoDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';
      s.extraPhotos.push({ dataUrl: s.photoDataUrl, blob: null, groupId: 'x', variants: null });
      if (typeof (window as any).__crispRefreshPhotoStrip === 'function') {
        (window as any).__crispRefreshPhotoStrip();
      }
      (window as any).__crispOpenImageViewer(s.extraPhotos[0].dataUrl, { kind: 'extra', index: 0 });
    });
    await expect(page.locator('#image-viewer-overlay')).toBeVisible();
    await page.locator('#btn-image-viewer-delete').click();
    await expect(page.locator('#image-delete-confirm')).toBeVisible();
    // Cancel.
    await page.locator('#btn-idc-cancel').click();
    await expect(page.locator('#image-delete-confirm')).toBeHidden();
    // Viewer still open (cancel didn't close it).
    await expect(page.locator('#image-viewer-overlay')).toBeVisible();
    // Extra NOT removed — state still has 1 entry.
    const stillThere = await page.evaluate(() => (window as any).state?.extraPhotos?.length);
    expect(stillThere).toBe(1);
  });
});
