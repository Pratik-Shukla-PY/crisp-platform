/**
 * Home audio guidance — start/STOP toggle (v353).
 *
 * The speaker icon used to start playback but never stop. Now:
 *   - 1st tap → starts + the icon goes active (orange via .is-speaking);
 *   - 2nd tap WHILE playing → stops + restores the icon;
 *   - tapping "Report an Incident" (or any nav off home) stops playback;
 *   - only one audio instance is ever active.
 *
 * Audio playback can't be heard in headless, so we drive a controllable
 * VoiceReadout stub and assert the toggle/stop wiring + the .is-speaking state.
 */
import { test, expect } from '@playwright/test';

async function boot(page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent', JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_lang_manual', 'en');
    });
    await page.goto('index.html');
    await page.evaluate(() => { const c = document.getElementById('consent-overlay'); if (c) c.style.display = 'none'; });
    await page.waitForSelector('#btn-home-voice', { timeout: 8000 });
    await page.waitForTimeout(400);
    // Controllable stub: speak() marks "playing" (no auto-end); stop() clears it.
    await page.evaluate(() => {
        const w = window as any;
        w.__speakCalls = 0; w.__stopCalls = 0; w.__playing = false;
        w.VoiceReadout = w.VoiceReadout || {};
        w.VoiceReadout.speak = (_t, _l, _onDone) => { w.__speakCalls++; w.__playing = true; };
        w.VoiceReadout.stop = () => { w.__stopCalls++; w.__playing = false; };
        w.VoiceReadout.isSpeaking = () => w.__playing;
    });
}

test('1st tap starts + goes active (orange); 2nd tap stops + restores; single instance', async ({ page }) => {
    await boot(page);
    const btn = page.locator('#btn-home-voice');

    await btn.click();
    await expect(btn).toHaveClass(/is-speaking/);
    expect(await page.evaluate(() => (window as any).__speakCalls)).toBe(1);
    // Active colour is orange (the .is-speaking rule), not the default teal.
    // Poll out the 0.15s color transition so we read the settled value, not a frame.
    await expect.poll(
        async () => btn.evaluate((el) => getComputedStyle(el).color),
        { timeout: 2000 },
    ).toMatch(/rgb\(251,\s*146,\s*60\)/);

    // 2nd tap → stop + restore.
    await btn.click();
    await expect(btn).not.toHaveClass(/is-speaking/);
    expect(await page.evaluate(() => (window as any).__stopCalls)).toBe(1);

    // 3rd tap restarts; still only one instance (speak called again, not stacked).
    await btn.click();
    await expect(btn).toHaveClass(/is-speaking/);
    expect(await page.evaluate(() => (window as any).__speakCalls)).toBe(2);
});

test('tapping "Report an Incident" while playing stops the audio + restores the icon', async ({ page }) => {
    await boot(page);
    const btn = page.locator('#btn-home-voice');
    await btn.click();
    await expect(btn).toHaveClass(/is-speaking/);
    const stopsBefore = await page.evaluate(() => (window as any).__stopCalls);

    // Navigate via the primary CTA (leaves #stage-home → goToStage stop hook).
    await page.locator('#btn-start').click();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => (window as any).__stopCalls)).toBeGreaterThan(stopsBefore);
    await expect(page.locator('#btn-home-voice')).not.toHaveClass(/is-speaking/);
});
