/**
 * UNDP §15 — Truthful client_blur_applied flag (Apr 2026).
 *
 * Regression guard for a real field bug: the PWA was hardcoding
 * `client_blur_applied: true` at every upload call-site regardless of
 * whether BlazeFace actually ran. Combined with the server's "skip
 * blur if client_blur_applied=true" rule, silent client-side failures
 * (CDN blocked, paint crash, model missing) let unblurred PII reach
 * the dashboard through BOTH blur passes.
 *
 * After the fix:
 *   - `PIIBlur.blurFaces(blob)` returns an object: { blob, blurred,
 *     facesDetected, skipped, error? }.
 *   - `_blurIfPossible(blob)` returns the same shape even if PIIBlur
 *     is unavailable — `blurred: false` when the pipeline can't run.
 *   - Callers destructure and thread the truthful flag onto
 *     `state.photoClientBlurApplied` / `entry.clientBlurApplied` →
 *     `photoVariants.clientBlurApplied` → each upload request body.
 *
 * We test at the module level via `page.evaluate` rather than driving
 * the full capture-flow UI: the truthful signal is a helper-function
 * contract, not a rendered behaviour. Three cases.
 */
import { test, expect } from '@playwright/test';

async function openPwa(page) {
  await page.goto('index.html');
  await page.evaluate(() => {
    localStorage.setItem(
      'crisp_privacy_consent',
      JSON.stringify({ accepted: true, ts: Date.now() }),
    );
  });
  await page.reload();
  const enBtn = page.locator('#btn-lang-en');
  if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
  await page.evaluate(() => {
    const c = document.getElementById('consent-overlay');
    if (c) c.style.display = 'none';
  });
}

// Minimal JPEG (1x1 red pixel, ~125 bytes). Valid enough that
// `createImageBitmap()` succeeds in headless Chromium.
const TINY_RED_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcU' +
  'FhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgo' +
  'KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
  'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
  'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
  'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB' +
  'AAIRAxEAPwD9U6KKKAP/2Q==';

function _bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

test.describe('PWA truthful client_blur_applied flag', () => {
  test.beforeEach(async ({ page }) => { await openPwa(page); });

  test('PIIBlur.blurFaces returns the new {blob, blurred, facesDetected, skipped} shape', async ({ page }) => {
    // Wait for BlazeFace to finish loading before calling blurFaces;
    // without this the first call hits the in-flight promise path.
    await page.waitForFunction(
      () => typeof (window as any).PIIBlur === 'object'
            && typeof (window as any).PIIBlur.blurFaces === 'function',
      { timeout: 15000 },
    );

    const tinyJpeg = _bytesFromBase64(TINY_RED_JPEG_B64);
    const result = await page.evaluate(async (bytesArr) => {
      const blob = new Blob([new Uint8Array(bytesArr)], { type: 'image/jpeg' });
      const out = await (window as any).PIIBlur.blurFaces(blob);
      // Serialise — Blobs don't cross the evaluate boundary intact.
      return {
        hasBlob: out && out.blob instanceof Blob,
        blurred: out?.blurred,
        facesDetected: out?.facesDetected,
        skipped: out?.skipped,
        hasError: typeof out?.error !== 'undefined',
      };
    }, Array.from(tinyJpeg));

    // A 1x1 red pixel has zero faces → pipeline ran OK → `blurred=true`
    // (nothing to redact), `facesDetected=0`, `skipped=false`.
    // If BlazeFace couldn't load at all (CDN blocked), it would land
    // in `skipped=true, blurred=false`.
    expect(result.hasBlob).toBeTruthy();
    expect(typeof result.blurred).toBe('boolean');
    expect(typeof result.facesDetected).toBe('number');
    expect(typeof result.skipped).toBe('boolean');
    if (result.skipped) {
      expect(result.blurred).toBe(false);
      expect(result.hasError).toBeTruthy();
    }
  });

  test('_blurIfPossible returns skipped:true when window.PIIBlur is not loaded', async ({ page }) => {
    const result = await page.evaluate(async () => {
      // Temporarily remove the global. _blurIfPossible must handle it.
      const saved = (window as any).PIIBlur;
      delete (window as any).PIIBlur;
      try {
        const tinyBlob = new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' });
        const out = await (window as any)._blurIfPossible(tinyBlob);
        return {
          hasBlob: out?.blob instanceof Blob,
          blurred: out?.blurred,
          skipped: out?.skipped,
          errorContainsLoaded:
            typeof out?.error === 'string' && out.error.toLowerCase().includes('piiblur'),
        };
      } finally {
        // Restore — other tests in this file will want it back.
        (window as any).PIIBlur = saved;
      }
    });

    expect(result.hasBlob).toBeTruthy();
    expect(result.blurred).toBe(false);
    expect(result.skipped).toBe(true);
    // Error message should specifically identify the PIIBlur-missing
    // failure mode so an operator can diagnose from a single line.
    expect(result.errorContainsLoaded).toBeTruthy();
  });

  test('ImageVariants.generate propagates clientBlurApplied onto the output', async ({ page }) => {
    // Wait for ImageVariants + PIIBlur to be loaded.
    await page.waitForFunction(
      () => typeof (window as any).ImageVariants === 'object'
            && typeof (window as any).ImageVariants.generate === 'function'
            && typeof (window as any).PIIBlur === 'object',
      { timeout: 15000 },
    );

    const tinyJpeg = _bytesFromBase64(TINY_RED_JPEG_B64);
    const result = await page.evaluate(async (bytesArr) => {
      const blob = new Blob([new Uint8Array(bytesArr)], { type: 'image/jpeg' });
      const out = await (window as any).ImageVariants.generate(blob);
      return {
        hasSmall: Boolean(out?.small?.blob),
        hasMedium: Boolean(out?.medium?.blob),
        hasLarge: Boolean(out?.large?.blob),
        // Parent-level flag threaded from the blur result.
        parentClientBlurApplied: out?.clientBlurApplied,
        // Per-variant — should match the parent.
        smallClientBlurApplied: out?.small?.clientBlurApplied,
        mediumClientBlurApplied: out?.medium?.clientBlurApplied,
        largeClientBlurApplied: out?.large?.clientBlurApplied,
        consistentFlag: out?.small?.clientBlurApplied === out?.medium?.clientBlurApplied
                     && out?.medium?.clientBlurApplied === out?.large?.clientBlurApplied,
      };
    }, Array.from(tinyJpeg));

    expect(result.hasSmall).toBeTruthy();
    expect(result.hasMedium).toBeTruthy();
    expect(result.hasLarge).toBeTruthy();
    expect(typeof result.parentClientBlurApplied).toBe('boolean');
    expect(typeof result.smallClientBlurApplied).toBe('boolean');
    // Whatever value the pipeline landed on, it must be consistent
    // across the three variants — they all ship from ONE blur pass.
    expect(result.consistentFlag).toBeTruthy();
    // Parent and per-variant agree.
    expect(result.smallClientBlurApplied).toBe(result.parentClientBlurApplied);
  });

  test('_blurIfPossible error-path returns skipped when blurFaces throws', async ({ page }) => {
    // Monkey-patch PIIBlur.blurFaces to throw; verify _blurIfPossible
    // catches the exception and returns the documented shape rather
    // than letting it bubble and setting `client_blur_applied: true`
    // on a silently-failed upload (the bug we're preventing).
    const result = await page.evaluate(async () => {
      const real = (window as any).PIIBlur.blurFaces;
      (window as any).PIIBlur.blurFaces = () => {
        throw new Error('simulated BlazeFace crash');
      };
      try {
        const tinyBlob = new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' });
        const out = await (window as any)._blurIfPossible(tinyBlob);
        return {
          hasBlob: out?.blob instanceof Blob,
          blurred: out?.blurred,
          skipped: out?.skipped,
          errorHasText: typeof out?.error === 'string' && out.error.length > 0,
        };
      } finally {
        (window as any).PIIBlur.blurFaces = real;
      }
    });

    expect(result.hasBlob).toBeTruthy();
    expect(result.blurred).toBe(false);
    expect(result.skipped).toBe(true);
    expect(result.errorHasText).toBeTruthy();
  });
});
