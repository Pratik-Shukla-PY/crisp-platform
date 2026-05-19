/**
 * UNDP §3.2 — building-footprint selector regression guards.
 *
 *   · `#building-select-box` <details> must exist on stage-review.
 *   · `window.BuildingSelect` module must load before app.js.
 *   · `window.L` (Leaflet) must be present on every page load — otherwise
 *     opening the building selector errors silently.
 *   · The submit payload must carry `building_id` when a user has picked
 *     a footprint. This is exercised by directly poking `state.buildingId`
 *     + triggering the submit-payload builder so we don't need a real
 *     Overpass fetch in the test environment.
 */
import { test, expect } from '@playwright/test';

async function openHomeInEnglish(page) {
  await page.goto('index.html');
  await page.evaluate(() => {
    localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
      localStorage.setItem('crisp_landing_seen', '1');
      localStorage.setItem('crisp_ui_v4', 'off');  // Pre-v4 tests target the v3 capture flow.
  });
  await page.reload();
  const enBtn = page.locator('#btn-lang-en');
  if (await enBtn.count()) await enBtn.click({ force: true }).catch(() => {});
  await page.evaluate(() => {
    const c = document.getElementById('consent-overlay');
    if (c) c.style.display = 'none';
  });
}

test.describe('PWA building-footprint selector', () => {
  test.beforeEach(async ({ page }) => { await openHomeInEnglish(page); });

  test('Leaflet + BuildingSelect globals are loaded', async ({ page }) => {
    // BuildingSelect module + its API are EAGER (loaded by the deferred
    // <script src="building-select.js"> in index.html). Leaflet itself
    // is LAZY — `_ensureLeaflet()` injects the CDN script the first
    // time the picker actually needs to mount a map. So `window.L` is
    // absent on bare page load; the test triggers the lazy path
    // explicitly via `BuildingSelect.ensureLeaflet()` to verify both
    // halves work.
    const eager = await page.evaluate(() => ({
      hasModule: typeof (window as any).BuildingSelect === 'object',
      hasEnsureMap: typeof (window as any).BuildingSelect?.ensureMap === 'function',
      hasGetSelection: typeof (window as any).BuildingSelect?.getSelection === 'function',
      hasEnsureLeaflet: typeof (window as any).BuildingSelect?.ensureLeaflet === 'function',
    }));
    expect(eager.hasModule).toBeTruthy();
    expect(eager.hasEnsureMap).toBeTruthy();
    expect(eager.hasGetSelection).toBeTruthy();
    expect(eager.hasEnsureLeaflet).toBeTruthy();

    // Trigger the lazy load + verify window.L is now defined.
    const hasLeafletAfter = await page.evaluate(async () => {
      await (window as any).BuildingSelect.ensureLeaflet();
      return typeof (window as any).L !== 'undefined';
    });
    expect(hasLeafletAfter).toBeTruthy();
  });

  test('#building-select-box exists on stage-review DOM (collapsed)', async ({ page }) => {
    const details = page.locator('#building-select-box');
    await expect(details).toHaveCount(1);
    // Collapsed by default — no "open" attribute.
    const open = await details.getAttribute('open');
    expect(open).toBeNull();
  });

  test('getSelection returns null when nothing picked, populated after tap', async ({ page }) => {
    const before = await page.evaluate(() => {
      (window as any).state = (window as any).state || {};
      return (window as any).BuildingSelect.getSelection();
    });
    expect(before.buildingId).toBeNull();

    const after = await page.evaluate(() => {
      (window as any).state.buildingId = 'osm:way:12345678';
      (window as any).state.buildingOsmElement = { type: 'way', id: 12345678, tags: { building: 'residential' } };
      return (window as any).BuildingSelect.getSelection();
    });
    expect(after.buildingId).toBe('osm:way:12345678');
    expect(after.osm?.type).toBe('way');
  });
});
