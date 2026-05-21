import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test('debug: screenshot home footer at iPhone viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });  // iPhone 14
    await page.addInitScript(() => {
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
    });
    await page.goto('index.html');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500);

    // Capture full home + the version element's properties
    const debugInfo = await page.evaluate(() => {
        const el = document.getElementById('home-utility-version');
        if (!el) return { found: false };
        const rect = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        return {
            found: true,
            text: el.textContent,
            hidden: el.hasAttribute('hidden'),
            inlineStyle: el.getAttribute('style'),
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
            display: cs.display,
            visibility: cs.visibility,
            opacity: cs.opacity,
            color: cs.color,
            fontSize: cs.fontSize,
            parent: el.parentElement?.id || el.parentElement?.className,
            parentRect: el.parentElement?.getBoundingClientRect(),
        };
    });
    console.log('VERSION PILL DEBUG:', JSON.stringify(debugInfo, null, 2));

    const shotDir = '/tmp/version-debug';
    fs.mkdirSync(shotDir, { recursive: true });
    await page.screenshot({ path: path.join(shotDir, 'iphone-home.png'), fullPage: true });
    // Also a zoomed-in shot of just the footer
    const footer = page.locator('#home-footer-row');
    if (await footer.count()) {
        await footer.screenshot({ path: path.join(shotDir, 'footer-row.png') });
    }
});
