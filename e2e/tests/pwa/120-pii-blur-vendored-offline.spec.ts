/**
 * HC89 (Sprint 1B, May 2026) — TF.js + BlazeFace vendoring guard.
 *
 * UNDP must-have #7 (client-side PII blur) was silently violated in
 * the May operator HAR: jsdelivr.net's `blazeface.min.js` alias 404'd,
 * `tf.min.js` returned status 0 from the worker, and every uploaded
 * photo shipped with `clientBlurApplied=false` despite the server
 * still applying its own blur as safety net. UNDP rubric inspects the
 * client flag explicitly — silent regression would have been
 * disqualifying.
 *
 * HC89 vendored both TF.js (~1.4 MB) and BlazeFace UMD (~12 KB) into
 * `mobile-app/src/vendor/{tf,blazeface}/`, added them to STATIC_ASSETS
 * so they install with the SW, and rewrote both loaders (blur-worker.js
 * importScripts + pii-blur.js dynamic <script>) to try local first
 * with CDN fallback. The model weights (`vendor/blazeface/model.json`
 * + shard) were already vendored — this fixed the missing LIBRARY
 * load path.
 *
 * This spec is the regression guard. Three tests:
 *
 *   1. Vendored happy path — PIIBlur.blurFaces succeeds against a
 *      tiny test JPEG; result is { blurred: true, skipped: false,
 *      error: undefined }. Confirms the vendored libs load at all.
 *
 *   2. CDN blocked, vendored present — block every cdn.jsdelivr.net
 *      request via page.route(); call blurFaces; expect SAME success
 *      shape. This is the core HC89 invariant — offline-first capture
 *      works even when jsdelivr is unreachable.
 *
 *   3. Both vendored AND CDN blocked — block both paths; call
 *      blurFaces; expect graceful { skipped: true, blurred: false,
 *      error: <string> }. The pipeline NEVER throws unhandled; the
 *      truthful flag plumbing from HC17 ensures uploads correctly
 *      report `clientBlurApplied=false` for the server to apply
 *      its safety-net blur.
 */
import { test, expect, type Page } from '@playwright/test';

async function openPwa(page: Page) {
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
// `createImageBitmap()` succeeds in headless Chromium. Zero faces.
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

async function _runBlurAgainstTinyJpeg(page: Page) {
  const tinyJpeg = _bytesFromBase64(TINY_RED_JPEG_B64);
  return await page.evaluate(async (bytesArr) => {
    const blob = new Blob([new Uint8Array(bytesArr)], { type: 'image/jpeg' });
    const out = await (window as any).PIIBlur.blurFaces(blob);
    return {
      hasBlob: out && out.blob instanceof Blob,
      blurred: out?.blurred,
      facesDetected: out?.facesDetected,
      skipped: out?.skipped,
      error: out?.error,
    };
  }, Array.from(tinyJpeg));
}

test.describe('HC89 — PII blur vendored libs offline guard', () => {

  test('vendored happy path: blurFaces succeeds with libs loaded locally', async ({ page }) => {
    await openPwa(page);

    // Wait for PIIBlur global; libs lazy-load on first blurFaces() call.
    await page.waitForFunction(
      () => typeof (window as any).PIIBlur === 'object'
            && typeof (window as any).PIIBlur.blurFaces === 'function',
      { timeout: 15000 },
    );

    const result = await _runBlurAgainstTinyJpeg(page);

    expect(result.hasBlob).toBeTruthy();
    // Vendored libs MUST load → pipeline ran → blurred=true.
    // (skipped=true would indicate the libs failed to load — fail loud.)
    expect(result.skipped).toBe(false);
    expect(result.blurred).toBe(true);
    expect(result.facesDetected).toBe(0);    // 1x1 red pixel = no faces
    expect(result.error).toBeUndefined();
  });

  test('CDN blocked, vendored libs still work — core HC89 invariant', async ({ page, context }) => {
    // Block every jsdelivr.net request BEFORE navigation. If the
    // vendored path works correctly, blurFaces still succeeds. If the
    // loader was still routing through the CDN as primary, it'd fail
    // here and the operator HAR regression would re-emerge.
    await context.route('**/cdn.jsdelivr.net/**', (route) => {
      route.abort('failed');
    });

    await openPwa(page);

    await page.waitForFunction(
      () => typeof (window as any).PIIBlur === 'object'
            && typeof (window as any).PIIBlur.blurFaces === 'function',
      { timeout: 15000 },
    );

    const result = await _runBlurAgainstTinyJpeg(page);

    expect(result.hasBlob).toBeTruthy();
    // SAME assertions as happy path — vendored libs carry the load.
    expect(result.skipped).toBe(false);
    expect(result.blurred).toBe(true);
    expect(result.facesDetected).toBe(0);
    expect(result.error).toBeUndefined();
  });

  test('both vendored + CDN blocked: graceful degradation to skipped=true', async ({ page, context }) => {
    // Belt-and-braces: if BOTH paths are unreachable (e.g. SW failed
    // to cache the vendored bundles AND the network is offline), the
    // pipeline MUST NOT throw — it must return skipped=true so the
    // truthful clientBlurApplied flag flows to the upload metadata.
    // Server-side blur is the authoritative layer in this case.
    await context.route('**/cdn.jsdelivr.net/**', (route) => {
      route.abort('failed');
    });
    await context.route('**/vendor/tf/**', (route) => {
      route.abort('failed');
    });
    await context.route('**/vendor/blazeface/**', (route) => {
      route.abort('failed');
    });

    await openPwa(page);

    await page.waitForFunction(
      () => typeof (window as any).PIIBlur === 'object'
            && typeof (window as any).PIIBlur.blurFaces === 'function',
      { timeout: 15000 },
    );

    const result = await _runBlurAgainstTinyJpeg(page);

    expect(result.hasBlob).toBeTruthy();
    // BOTH paths blocked → libs can't load → blurFaces returns
    // skipped=true with the original blob, no exception escapes.
    expect(result.skipped).toBe(true);
    expect(result.blurred).toBe(false);
    expect(typeof result.error).toBe('string');
    expect((result.error || '').length).toBeGreaterThan(0);
  });
});
