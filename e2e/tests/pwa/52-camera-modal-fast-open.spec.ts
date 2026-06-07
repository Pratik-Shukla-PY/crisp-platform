/**
 * PWA — camera-modal fast open (perf: 1080p preview → background 4K upgrade).
 *
 * Covers the v330 change in app.js `openCameraModal()`:
 *  - getUserMedia is requested at 1080p FIRST (a cold camera paints its first
 *    frame faster at 1080p than at 4K), then the SAME track is upgraded to 4K
 *    via `applyConstraints` once the preview paints — so captures keep native
 *    fidelity while the preview appears sooner.
 *  - The "starting camera" spinner (#cam-loading) shows synchronously on open
 *    and hides on the FIRST PAINTED FRAME (loadeddata/playing), not merely when
 *    getUserMedia resolves — removing the black flash before first pixels.
 *  - The HC97 re-entrancy guard still ignores a rapid second open.
 *  - On getUserMedia rejection the modal closes and falls back to the file input.
 *
 * Real getUserMedia/MediaRecorder can't run in headless Chromium, so we install
 * a deterministic mock stream + a neutralised <video>.srcObject setter (same
 * pattern as 30-v4-bug-fixes BUG 2). The on-device first-open *speed* is verified
 * separately on a real iPhone — this spec locks the WIRING + resolution contract.
 */
import { test, expect, Page } from '@playwright/test';

async function _bootV4(page: Page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).openCameraModal === 'function'
           && !!document.getElementById('camera-modal'),
        null, { timeout: 10000 },
    );
}

// Deterministic getUserMedia mock. Records the constraints handed to
// getUserMedia + the track's applyConstraints so tests can assert the
// two-phase (1080p → 4K) resolution. Neutralises srcObject so assigning the
// mock stream to the <video> doesn't throw.
async function _installCameraMock(page: Page) {
    await page.evaluate(() => {
        const w = window as any;
        w.__cam = { gumCalls: [], applyCalls: [] };
        const track = {
            kind: 'video',
            stop() {},
            applyConstraints(c: any) { w.__cam.applyCalls.push(c); return Promise.resolve(); },
        };
        const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
        w.navigator.mediaDevices = w.navigator.mediaDevices || {};
        w.navigator.mediaDevices.getUserMedia = (constraints: any) => {
            w.__cam.gumCalls.push(constraints);
            return Promise.resolve(stream);
        };
        try {
            Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
                configurable: true, set() {}, get() { return null; },
            });
        } catch (_) {}
    });
}

test.describe('PWA — camera-modal fast open (1080p preview → background 4K)', () => {
    test.beforeEach(async ({ page }) => { await _bootV4(page); });

    test('opens at 1080p with spinner; hides spinner on first frame + upgrades to 4K', async ({ page }) => {
        await _installCameraMock(page);
        await page.evaluate(() => (window as any).openCameraModal());
        await page.waitForTimeout(120);  // let the getUserMedia promise resolve

        // Phase 1 — 1080p requested, spinner shown, NO 4K upgrade yet.
        const afterOpen = await page.evaluate(() => {
            const gum = (window as any).__cam.gumCalls;
            const loading = document.getElementById('cam-loading');
            return {
                gumCount: gum.length,
                width: gum[0]?.video?.width?.ideal,
                height: gum[0]?.video?.height?.ideal,
                spinnerShown: !!loading && getComputedStyle(loading).display !== 'none',
                applyCount: (window as any).__cam.applyCalls.length,
            };
        });
        expect(afterOpen.gumCount, 'getUserMedia called once on open').toBe(1);
        expect(afterOpen.width, 'preview should be requested at 1080p (fast first frame)').toBe(1920);
        expect(afterOpen.height).toBe(1080);
        expect(afterOpen.spinnerShown, '#cam-loading spinner should show while the camera warms up').toBe(true);
        expect(afterOpen.applyCount, '4K upgrade must NOT fire before the first painted frame').toBe(0);

        // Phase 2 — simulate the preview painting its first frame.
        await page.evaluate(() => document.getElementById('camera-stream')?.dispatchEvent(new Event('playing')));
        await page.waitForTimeout(60);
        const afterFrame = await page.evaluate(() => {
            const loading = document.getElementById('cam-loading');
            const apply = (window as any).__cam.applyCalls;
            return {
                spinnerHidden: !loading || getComputedStyle(loading).display === 'none',
                applyCount: apply.length,
                upWidth: apply[0]?.width?.ideal,
                upHeight: apply[0]?.height?.ideal,
            };
        });
        expect(afterFrame.spinnerHidden, 'spinner should hide on the first painted frame').toBe(true);
        expect(afterFrame.applyCount, 'should upgrade resolution once after the first frame').toBe(1);
        expect(afterFrame.upWidth, 'background upgrade should target 4K (native capture fidelity)').toBe(3840);
        expect(afterFrame.upHeight).toBe(2160);
    });

    test('re-entrancy guard: a rapid second open does not fire a 2nd getUserMedia', async ({ page }) => {
        await _installCameraMock(page);
        const gumCount = await page.evaluate(() => {
            (window as any).openCameraModal();   // opens (display→flex synchronously)
            (window as any).openCameraModal();   // guard: display==='flex' → early return
            return (window as any).__cam.gumCalls.length;
        });
        expect(gumCount, 'second openCameraModal while open must not start a 2nd stream').toBe(1);
    });

    test('getUserMedia rejection → modal closes and falls back to the file input', async ({ page }) => {
        await page.evaluate(() => {
            const w = window as any;
            w.navigator.mediaDevices = w.navigator.mediaDevices || {};
            w.navigator.mediaDevices.getUserMedia = () => Promise.reject(
                Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
            // Spy the SAME fallback element openCameraModal picks.
            w.__fb = 0;
            const fb = document.getElementById('v4-file-camera') || document.getElementById('file-camera');
            if (fb) fb.click = () => { w.__fb++; };
        });
        await page.evaluate(() => (window as any).openCameraModal());
        await page.waitForTimeout(120);
        const result = await page.evaluate(() => {
            const m = document.getElementById('camera-modal');
            return {
                modalHidden: !m || getComputedStyle(m).display === 'none',
                fallbackClicks: (window as any).__fb,
            };
        });
        expect(result.modalHidden, 'modal should close on getUserMedia rejection').toBe(true);
        expect(result.fallbackClicks, 'should fall back to the file input on rejection').toBeGreaterThan(0);
    });
});
