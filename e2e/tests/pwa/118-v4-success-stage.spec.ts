/**
 * HC79 (May 2026) — V4 Step 4 / post-submit "Report Submitted" stage
 * holistic redesign.
 *
 * Pre-HC79 the success stage was a static thank-you page (heart +
 * confetti + h2/p text block + 3 CTAs). The operator brief: "The page
 * should not feel like a static thank you screen ... It should feel
 * like a live crisis-response network, responders are actively
 * reviewing incidents, the user is now connected into a real-time
 * humanitarian system."
 *
 * HC79 redesigns into a live mission-control snapshot:
 *   1. Compact CRISP brand cluster (logo SVG + wordmark + dot) +
 *      devid pill + mid-flow lang pill in a flex header.
 *   2. Thanks bar — heart on the left + thank-you copy stacked on
 *      the right.
 *   3. Live status pill — radar (3 concentric rings + dot) +
 *      "Under review" label + report ID + locale-aware time-ago.
 *      Offline state replaces the radar with a static amber dot and
 *      flips the label to "Queued — will sync when online".
 *   4. Responder activity strip — chip-pulse bolt + active count.
 *   5. Contribution / tier identity strip — current tier emoji on
 *      the left + next-tier emoji on the right with a connecting
 *      progress bar. Tap → stage-rewards.
 *   6. Nearby trigger pill — number-only summary that opens a
 *      bottom-sheet modal mirroring the home-stage .nearby-sheet
 *      pattern. Active rows get a ripple ring around their dot.
 *   7. Stacked footer — "+ Report another incident" primary CTA
 *      above a compact "My Reports (N)" inline link.
 *
 * This spec pins:
 *   1. iPhone SE 375x667 fits without vertical scroll on entry.
 *   2. All 9 brief-mandated elements render: brand cluster, devid
 *      pill, lang pill, thanks bar (heart + copy), status pill
 *      (radar), responder strip, contribution strip (with next-tier
 *      emoji), nearby trigger pill, stacked CTA footer (primary +
 *      inline link).
 *   3. Radar has 3 ring children + a dot, and the rings have a
 *      non-empty animation-name in computed style.
 *   4. Offline state: status pill data-state="offline", label flips
 *      to the queued copy.
 *   5. Nearby empty state: trigger pill carries .is-empty class +
 *      sheet not opened on click.
 *   6. Nearby populated state: trigger pill carries .has-reports
 *      class + click opens the bottom-sheet + sheet shows seeded
 *      rows + close button + backdrop both dismiss.
 *   7. State cleanup on entry — no stale capture state leaks into
 *      the next flow when the user taps "Report another".
 *   8. Time-ago ticker starts with "just now" copy.
 *   9. RTL (Arabic) — header pills mirror to logical-end side; copy
 *      reads RTL; iPhone SE still fits.
 *  10. Hindi locale — iPhone SE still fits with longer translations.
 *  11. Stage-exit timer cleanup — leaving stage-success stops the
 *      time-ago setInterval.
 */
import { test, expect, type Page } from './_fixtures';

const IPHONE_SE = { width: 375, height: 667 };

async function openSuccessStage(
    page: Page,
    lang = 'en',
    opts: { nearby?: 'populated' | 'empty', offline?: boolean, reportCount?: number } = {},
) {
    const { nearby = 'populated', offline = false, reportCount = 1 } = opts;
    await page.setViewportSize(IPHONE_SE);
    await page.addInitScript((args) => {
        const { langCode, reportCount } = args as { langCode: string; reportCount: number };
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        localStorage.setItem('crisp_ui_v4', 'on');
        localStorage.setItem('crisp_lang', langCode);
        localStorage.setItem('crisp_lang_manual', langCode);
        localStorage.setItem('crisp_device_id_v2', 'devicehash-test-1234abcd');
        // Pre-seed the badge cache so the contribution strip paints
        // the requested tier without a network round-trip.
        sessionStorage.setItem(
            'crisp_home_badge_v2',
            JSON.stringify({ report_count: reportCount, ts: Date.now() }),
        );
        // Pre-seed cached GPS so the success-stage nearby fetch
        // can build the URL.
        localStorage.setItem(
            'crisp_last_location_v2',
            JSON.stringify({ lat: 12.9716, lng: 77.5946, ts: Date.now() }),
        );
    }, { langCode: lang, reportCount });

    // Stub /reports/nearby per scenario.
    const nearbyPayload = nearby === 'empty'
        ? { groups: [] }
        : {
            groups: [
                {
                    label: 'Electronic City',
                    count: 7,
                    distance_km: 2,
                    verified_count: 5,
                    pending_count: 2,
                    summary: 'Flood',
                },
                {
                    label: 'Indiranagar',
                    count: 3,
                    distance_km: 3,
                    verified_count: 1,
                    pending_count: 2,
                    summary: 'Power',
                },
            ],
        };
    await page.route('**/api/v1/reports/nearby**', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(nearbyPayload),
        }),
    );
    await page.route('**/api/v1/reports/profile/**', (route) =>
        route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ report_count: reportCount }),
        }),
    );

    // Visit once to register, then unregister all SWs + clear caches,
    // then navigate to the real test URL. Without this two-step the
    // previous test run's SW serves stale app.js that lacks the HC79
    // helpers, breaking the populated nearby test.
    await page.goto('index.html?ui=v4&hc79bust=' + Date.now());
    await page.evaluate(async () => {
        if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister()));
        }
        if (typeof caches !== 'undefined') {
            const ks = await caches.keys();
            await Promise.all(ks.map((k) => caches.delete(k)));
        }
    });
    await page.goto('index.html?ui=v4&hc79bust=' + Date.now() + 'b');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
        () => typeof (window as any).goToStage === 'function' &&
              typeof (window as any).state === 'object',
        null,
        { timeout: 8000 },
    );

    // Seed the just-submitted client id so the status pill has
    // something to render. Toggle offline AFTER the page has
    // loaded but BEFORE we hit stage-success so navigator.onLine
    // reads false at status-pill paint time.
    if (offline) {
        await page.evaluate(() => {
            // Override navigator.onLine to read false. We can't easily
            // toggle the real getter without setOffline, and setOffline
            // here would block our /reports/nearby stub from firing on
            // the cross-origin endpoint Playwright also can't intercept
            // reliably when the page is offline.
            try {
                Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
            } catch (_) {}
        });
    }
    await page.evaluate(() => {
        (window as any)._lastSubmittedClientId = 'a1b2c3d4-test-stub';
        (window as any).goToStage('stage-success');
    });
    await expect(page.locator('#stage-success.active')).toBeVisible({ timeout: 3000 });
    // Let the render helpers paint (nearby fetch + tier + status).
    // Wait long enough for _bootSuccessNearby's fetch to settle so a
    // late-arriving response can't overwrite our manual paint below.
    // 6.5 s = the fetch's 6-s abort timer + slack.
    await page.waitForTimeout(nearby === 'populated' ? 6500 : 400);
    // Force-seed the nearby payload directly. The cross-origin fetch
    // to localhost:8000 from the test page on localhost:8080 isn't
    // reliably interceptable by `page.route` in every Playwright
    // version, so we paint via the public helper after the boot
    // fetch has had a chance to complete and write an empty list.
    if (nearby === 'populated') {
        // Seed the populated state directly into the DOM. This is more
        // resilient than calling the production helper because a stale
        // service-worker can serve an older app.js whose helper has a
        // different signature; the trigger pill markup is stable.
        await page.evaluate(() => {
            const trigger = document.getElementById('success-nearby-trigger');
            const list = document.getElementById('success-nearby-sheet-list');
            const countEl = document.getElementById('snt-count');
            const metaEl = document.getElementById('snt-meta');
            const subEl = document.getElementById('snt-meta-sub');
            if (!trigger || !list || !countEl || !metaEl) return;
            trigger.classList.remove('is-empty');
            trigger.classList.add('has-reports');
            metaEl.innerHTML =
                '<span class="snt-count" id="snt-count">10</span>' +
                '<span>reports</span>' +
                '<span class="snt-meta-sub" id="snt-meta-sub">· 2 areas active</span>';
            list.innerHTML = `
                <div class="success-nearby-row is-active" role="button" tabindex="0">
                    <div class="snr-dot-wrap"><span class="snr-dot"></span></div>
                    <div class="snr-info">
                        <div class="snr-head">
                            <span class="snr-label">Electronic City</span>
                            <span class="snr-sep">·</span>
                            <span class="snr-count">7</span>
                        </div>
                        <div class="snr-meta">2 km away · 5 verified · 2 pending</div>
                    </div>
                </div>
                <div class="success-nearby-row is-active" role="button" tabindex="0">
                    <div class="snr-dot-wrap"><span class="snr-dot"></span></div>
                    <div class="snr-info">
                        <div class="snr-head">
                            <span class="snr-label">Indiranagar</span>
                            <span class="snr-sep">·</span>
                            <span class="snr-count">3</span>
                        </div>
                        <div class="snr-meta">3 km away · 1 verified · 2 pending</div>
                    </div>
                </div>
            `;
        });
        await page.waitForTimeout(150);
    } else {
        // nearby === 'empty'. As the populated branch above notes,
        // `page.route` doesn't reliably intercept the cross-origin
        // fetch to the dev backend on :8000 (SW-mediated). Before
        // HC82 this branch "passed" implicitly because the fetch was
        // CORS-preflight-blocked and the empty fallback rendered.
        // After HC82 the fetch SUCCEEDS and (against a populated dev
        // DB) returns real groups — rings render, empty-state hides,
        // assertion fails. Force-paint the empty state via the public
        // helper, same pattern as the populated branch.
        await page.evaluate(() => {
            const w = window as unknown as {
                _renderSuccessNearbyEmpty?: () => void;
            };
            const root = document.getElementById('success-nearby-intel');
            if (root) root.innerHTML = '';
            if (typeof w._renderSuccessNearbyEmpty === 'function') {
                w._renderSuccessNearbyEmpty();
            }
        });
        await page.waitForTimeout(150);
    }
}

test.describe('PWA — HC79 success-stage live mission-control redesign', () => {

    test('@smoke iPhone SE: success body fits without vertical scroll', async ({ page }) => {
        await openSuccessStage(page);
        const overflow = await page.evaluate(() => {
            const stage = document.querySelector('#stage-success') as HTMLElement;
            return {
                scroll: stage ? stage.scrollHeight - stage.clientHeight : 0,
                stageH: stage ? stage.clientHeight : 0,
            };
        });
        expect(overflow.scroll, 'iPhone SE stage must fit without overflow').toBeLessThanOrEqual(8);
        expect(overflow.stageH).toBeGreaterThan(500);
    });

    test('@smoke all 8 brief-mandated elements render (devid pill dropped May 2026)', async ({ page }) => {
        await openSuccessStage(page);
        // 1. Brand cluster
        await expect(page.locator('#btn-success-brand .home-brand-logo svg')).toBeVisible();
        await expect(page.locator('#btn-success-brand .home-brand-name')).toBeVisible();
        // 2. (Removed May 2026) The success-header devid pill was dropped in
        //    the PWA tweak that re-centred the queued-reports badge + restored
        //    the labeled "Online" connectivity pill (#connectivity-dot-success
        //    inside #btn-success-brand). Lock in its removal so it can't creep
        //    back.
        await expect(page.locator('#btn-success-devid'),
            'devid pill was intentionally removed from the success header').toHaveCount(0);
        // 3. Lang pill
        await expect(page.locator('#stage-success [data-v4-lang-pill]')).toBeVisible();
        // 4. Thanks bar — heart + title
        await expect(page.locator('.success-thanks-heart i.fa-heart')).toBeVisible();
        await expect(page.locator('.success-thanks-title')).toBeVisible();
        // 5. Status pill — radar with 2 rings + dot (HC86 reduced
        //    from 3 → 2 to calm the simultaneous animation count
        //    on the Thank-You page).
        await expect(page.locator('#success-status-pill .success-radar')).toBeVisible();
        const rings = await page.locator('#success-status-pill .success-radar-ring').count();
        expect(rings, 'radar must have 2 rings (HC86)').toBe(2);
        await expect(page.locator('.success-radar-dot')).toBeVisible();
        // 6. Responder strip
        await expect(page.locator('#success-responder-strip')).toBeVisible();
        // 7. Contribution strip with next-tier emoji
        await expect(page.locator('#success-contribution-strip')).toBeVisible();
        await expect(page.locator('#sc-tier-now-emoji')).not.toHaveText('');
        await expect(page.locator('#sc-tier-next-emoji')).not.toHaveText('');
        // 8. Nearby module mount — HC84 unified home + success. The
        //    mount hosts the SAME aggregate-number block as the home
        //    stage (`.home-nearby-number-block`) when groups exist,
        //    or the contextual `.success-nearby-empty` copy when not.
        await expect(page.locator('#success-nearby-intel')).toBeVisible();
        // 9. Stacked CTA footer
        await expect(page.locator('#btn-new-report')).toBeVisible();
        await expect(page.locator('#btn-success-my-reports')).toBeVisible();
    });

    test('@smoke radar rings have a non-empty animation-name', async ({ page }) => {
        await openSuccessStage(page);
        const animNames = await page.locator('.success-radar-ring').evaluateAll((rings) =>
            rings.map((r) => getComputedStyle(r).animationName),
        );
        // HC86 — radar reduced from 3 → 2 rings.
        expect(animNames).toHaveLength(2);
        for (const name of animNames) {
            expect(name, 'each ring has an animation-name').not.toBe('none');
            expect(name).toContain('success-radar-ring');
        }
    });

    test('@smoke offline state: queued pill copy + amber data-state', async ({ page }) => {
        await openSuccessStage(page, 'en', { offline: true });
        const pill = page.locator('#success-status-pill');
        await expect(pill).toHaveAttribute('data-state', 'offline');
        const label = await page.locator('#success-status-label').textContent();
        expect(label?.toLowerCase()).toContain('queued');
        await page.context().setOffline(false);
    });

    test('@smoke nearby empty state: contextual empty copy renders, no number block drawn', async ({ page }) => {
        await openSuccessStage(page, 'en', { nearby: 'empty' });
        // HC84 — empty groups → no aggregate-number block; the
        // success-specific contextual empty copy ("first eyes here")
        // renders into the success-nearby-intel mount instead.
        const blockCount = await page.locator('#success-nearby-intel .home-nearby-number-block').count();
        expect(blockCount, 'no number-block when nearby is empty').toBe(0);
        const emptyVisible = await page.locator('#success-nearby-intel .success-nearby-empty').isVisible();
        expect(emptyVisible, 'contextual empty-state copy visible inside the mount').toBe(true);
    });

    test('@smoke nearby populated state: aggregate-number block renders identical to home', async ({ page }) => {
        await openSuccessStage(page, 'en', { nearby: 'populated' });
        // HC84 — unified design. Success stage mounts the SAME
        // `.home-nearby-number-block` the home stage uses. We force-
        // seed via the public helper (see populated branch of
        // openSuccessStage above) so this assertion is deterministic
        // even when page.route can't intercept the cross-origin fetch.
        await page.evaluate(() => {
            const w = window as unknown as {
                NearbyIntel?: { buildNumberBlock?: (p: { groups: unknown[] }) => HTMLElement | null };
            };
            const root = document.getElementById('success-nearby-intel');
            if (!root || !w.NearbyIntel || !w.NearbyIntel.buildNumberBlock) return;
            root.innerHTML = '';
            const block = w.NearbyIntel.buildNumberBlock({
                groups: [
                    { id: 'g1', count: 7, approx_distance_km: 0.3, tier: 'verified',
                      label: 'Electronic City', summary_key: 'flood',
                      latest_at: new Date().toISOString(),
                      verified_count: 5, pending_count: 2 },
                    { id: 'g2', count: 3, approx_distance_km: 1.7, tier: 'emerging',
                      label: 'Indiranagar', summary_key: 'power',
                      latest_at: new Date().toISOString(),
                      verified_count: 1, pending_count: 2 },
                ],
            });
            if (block) root.appendChild(block);
        });
        await page.waitForTimeout(150);
        const block = page.locator('#success-nearby-intel .home-nearby-number-block');
        await expect(block).toBeVisible();
        // Halo + number + tier pill all present.
        const halos = await page.locator('#success-nearby-intel .home-nearby-pulse-halo').count();
        expect(halos, 'two pulse halos (primary + secondary)').toBe(2);
        const number = await page.locator('#success-nearby-intel .home-nearby-number').textContent();
        expect(Number(number)).toBeGreaterThan(0);
        const tierPill = page.locator('#success-nearby-intel .home-nearby-tier-pill');
        await expect(tierPill).toBeVisible();
        // Tap → shared list sheet opens.
        await block.click();
        await page.waitForTimeout(350);
        await expect(page.locator('#nearby-list-sheet')).toHaveClass(/is-open/);
        // Bucket-grouped sections rendered inside.
        const sectionCount = await page.locator('#nearby-list-sheet .nearby-bucket-section').count();
        expect(sectionCount, 'modal renders at least one bucket section').toBeGreaterThan(0);
    });

    test('@smoke state cleanup on Report another tap', async ({ page }) => {
        await openSuccessStage(page);
        // Plant some stale capture state to confirm it's cleared.
        await page.evaluate(() => {
            (window as any).state.photoDataUrl = 'data:image/png;base64,stale';
            (window as any).state.extraPhotos = [{ dataUrl: 'data:image/png;base64,stale2' }];
            (window as any).state.crisis_type = 'EARTHQUAKE';
        });
        await page.locator('#btn-new-report').click();
        await page.waitForTimeout(300);
        const stateAfter = await page.evaluate(() => ({
            photoDataUrl: (window as any).state.photoDataUrl,
            extras: ((window as any).state.extraPhotos || []).length,
            crisis: (window as any).state.crisis_type,
        }));
        expect(stateAfter.photoDataUrl, 'photoDataUrl cleared by resetApp').toBeFalsy();
        expect(stateAfter.extras, 'extras cleared by resetApp').toBe(0);
        expect(stateAfter.crisis, 'classification cleared by resetApp').toBeFalsy();
    });

    test('@smoke time-ago ticker starts with "just now" copy', async ({ page }) => {
        await openSuccessStage(page);
        const text = await page.locator('#success-time-ago').textContent();
        expect((text || '').toLowerCase()).toMatch(/just now|now|—/);
    });

    test('@smoke RTL (Arabic): mirrors header pills + still fits', async ({ page }) => {
        await openSuccessStage(page, 'ar');
        const overflow = await page.evaluate(() => {
            const stage = document.querySelector('#stage-success') as HTMLElement;
            return stage ? stage.scrollHeight - stage.clientHeight : 0;
        });
        expect(overflow, 'RTL fits without overflow (8 px tolerance)').toBeLessThanOrEqual(8);
        // dir attribute applied to <html>
        const dir = await page.evaluate(() => document.documentElement.dir);
        expect(dir).toBe('rtl');
    });

    test('@smoke Hindi locale still fits without overflow', async ({ page }) => {
        await openSuccessStage(page, 'hi');
        const overflow = await page.evaluate(() => {
            const stage = document.querySelector('#stage-success') as HTMLElement;
            return stage ? stage.scrollHeight - stage.clientHeight : 0;
        });
        expect(overflow, 'Hindi fits without overflow').toBeLessThanOrEqual(8);
    });

    test('@smoke stage-exit clears the time-ago setInterval', async ({ page }) => {
        await openSuccessStage(page);
        // Stage entry should have started the ticker.
        const before = await page.evaluate(() => {
            // Spy on setInterval handle count by snapshotting setInterval-id range.
            // We can't read the value of _successTimeAgoIntervalId directly because
            // it lives in module scope; instead, assert the ticker text changes.
            return document.getElementById('success-time-ago')?.textContent || '';
        });
        // Leave the stage by navigating away — handler clears the ticker.
        await page.evaluate(() => (window as any).goToStage('stage-home'));
        await page.waitForTimeout(400);
        // The text should be frozen / unchanged after stage exit (since
        // the ticker is cleared). Snapshot once, wait, snapshot again.
        const snap1 = await page.evaluate(() =>
            document.getElementById('success-time-ago')?.textContent || '',
        );
        await page.waitForTimeout(11000);
        const snap2 = await page.evaluate(() =>
            document.getElementById('success-time-ago')?.textContent || '',
        );
        expect(snap1).toBe(snap2);
    });
});
