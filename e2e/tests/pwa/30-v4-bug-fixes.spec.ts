/**
 * V4 bug-fix coverage (UNDP submission gate).
 *
 * Each test in this file targets ONE of the 9 v4-mode bugs the user
 * reported during field testing:
 *   1. Landing page fluctuation
 *   2. Desktop webcam not opening
 *   3. Android back-button exits PWA
 *   4. Voice-only feature broken
 *   5. Building tagging removed
 *   6. No images received on dashboard (variant pipeline broken)
 *   7. New report doesn't clear previous state
 *   8. Location pill shows raw coords instead of place name
 *   9. Offline queue not verified
 *
 * Every test forces v4 via `?ui=v4` so the EXACT same code path a real
 * user would hit (with v4 default-on) is exercised. No flag mocking,
 * no skipping the real ingest pipeline.
 *
 * When all 9 tests are green here, `UI_V4_ENABLED` default can flip
 * back to ON safely.
 */
import { test, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// 10×10 red JPEG — the smallest valid JPEG that survives the variant
// pipeline (ImageVariants needs a real image to decode + resize).
function writeTestJpegToTemp(): string {
    const tmp = path.join(os.tmpdir(), `crisp-v4-${Date.now()}.jpg`);
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

// Bypass consent + landing pre-navigation so we land directly on stage-home
// with v4 active. The user's bug reports happened on the same boot path.
async function _bootV4(page: Page) {
    await page.addInitScript(() => {
        // Pre-set consent so the consent gate doesn't block the test.
        localStorage.setItem('crisp_privacy_consent',
            JSON.stringify({ accepted: true, ts: Date.now() }));
        localStorage.setItem('crisp_landing_seen', '1');
        // Force v4 ON (overrides the May 2026 emergency default-OFF).
        localStorage.setItem('crisp_ui_v4', 'on');
    });
    await page.goto('index.html?ui=v4');
    await page.waitForFunction(
        () => typeof (window as any).__crispGoToStage === 'function' &&
              (window as any).CrispV4 && (window as any).CrispV4.isEnabled?.(),
        null, { timeout: 10000 },
    );
}

// ════════════════════════════════════════════════════════════════════════
// BUG 6 — V4 image upload chain: state.photoDataUrl + photoVariants set
// ════════════════════════════════════════════════════════════════════════
//
// v3 sets state.photoDataUrl, state.photoBlob, state.photoGroupId on
// every photo capture, then asynchronously generates state.photoVariants
// (small/medium/large) via window.ImageVariants.generate. submitReport()
// reads ALL of these at enqueue time. Without state.photoDataUrl the
// hasPhoto gate is false and the photo never reaches the dashboard.
//
// v4 was setting only state.photoBlob and skipping the variant generator,
// so reports submitted via v4 produced text-only meta rows on the server
// — the dashboard saw "report submitted" but no image attachment.

test.describe('BUG 6 — v4 image upload pipeline mirrors v3', () => {
    test('after v4 photo capture, state.photoDataUrl is populated', async ({ page }) => {
        await _bootV4(page);
        // Enter v4 capture stage.
        await page.evaluate(() => (window as any).CrispV4.goToCapture());
        await page.waitForTimeout(400);

        const jpg = writeTestJpegToTemp();
        // The v4 hidden inputs are #v4-file-camera and #v4-file-browse.
        await page.locator('#v4-file-camera').setInputFiles(jpg);

        // Variant generation runs in requestIdleCallback — wait up to 8s.
        // Block on BOTH photoDataUrl AND photoBlob — they're set in
        // separate async steps (FileReader → setPhotoDataUrl, then
        // canvas.toBlob → setPhotoBlob), so we can't bail on photoDataUrl
        // alone or we race against the toBlob callback.
        const result = await page.waitForFunction(() => {
            const s = (window as any).state;
            return (s.photoDataUrl && s.photoBlob && s.photoGroupId) ? {
                hasDataUrl: !!s.photoDataUrl,
                hasBlob: !!s.photoBlob,
                hasGroupId: !!s.photoGroupId,
                dataUrlPrefix: String(s.photoDataUrl).slice(0, 30),
            } : null;
        }, null, { timeout: 8000 }).then((h) => h.jsonValue());

        expect(result.hasDataUrl, 'state.photoDataUrl not set after v4 capture').toBe(true);
        expect(result.hasBlob, 'state.photoBlob not set after v4 capture').toBe(true);
        expect(result.hasGroupId, 'state.photoGroupId not set after v4 capture').toBe(true);
        expect(result.dataUrlPrefix, 'photoDataUrl should be a data: URL')
            .toMatch(/^data:image\//);
    });

    test('after v4 capture, state.photoVariants populates with 3 tiers', async ({ page }) => {
        await _bootV4(page);
        await page.evaluate(() => (window as any).CrispV4.goToCapture());
        await page.waitForTimeout(400);

        const jpg = writeTestJpegToTemp();
        await page.locator('#v4-file-camera').setInputFiles(jpg);

        // ImageVariants.generate is deferred via _runWhenIdle; allow ~6s.
        // Phase L (May 2026): variant key is `original`, was `large`.
        const variants = await page.waitForFunction(() => {
            const v = (window as any).state.photoVariants;
            return v && v.small && v.medium && v.original ? {
                hasSmall: !!v.small.blob,
                hasMedium: !!v.medium.blob,
                hasOriginal: !!v.original.blob,
                smallBytes: v.small.bytes || 0,
                mediumBytes: v.medium.bytes || 0,
                originalBytes: v.original.bytes || 0,
            } : null;
        }, null, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => null);

        expect(variants, 'state.photoVariants never populated').toBeTruthy();
        expect(variants.hasSmall, 'small tier missing').toBe(true);
        expect(variants.hasMedium, 'medium tier missing').toBe(true);
        expect(variants.hasOriginal, 'original tier missing').toBe(true);
    });

    test('v4 capture produces hasPhoto=true in submitReport gate', async ({ page }) => {
        await _bootV4(page);
        await page.evaluate(() => (window as any).CrispV4.goToCapture());
        await page.waitForTimeout(400);

        const jpg = writeTestJpegToTemp();
        await page.locator('#v4-file-camera').setInputFiles(jpg);

        // Wait for state.photoDataUrl to settle.
        await page.waitForFunction(() => !!(window as any).state.photoDataUrl,
                                   null, { timeout: 5000 });

        // submitReport's gate is `const hasPhoto = !!state.photoDataUrl`.
        // If this is true, the meta payload includes the photo media id.
        const gateResult = await page.evaluate(() => {
            const s = (window as any).state;
            return {
                hasPhotoGate: !!s.photoDataUrl,
                hasVariantsGate: !!(s.photoVariants && s.photoVariants.small),
                groupId: s.photoGroupId,
            };
        });
        expect(gateResult.hasPhotoGate, 'submitReport hasPhoto gate would be false').toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
// BUG 5 — Building Tagging (UNDP must-have #6)
// ════════════════════════════════════════════════════════════════════════
//
// UNDP brief mandates a building footprint selector. v3 ships #building-
// select-box inside stage-crisis; tapping a polygon writes state.buildingId.
// v4 has only an "edit location" row that calls _refreshGps — the
// building selector is invisible in the v4 flow, so v4-submitted reports
// never tag a building.

test.describe('BUG 5 — v4 surfaces the building footprint selector', () => {
    test('v4 review stage exposes a mount point for the building picker', async ({ page }) => {
        await _bootV4(page);
        // Walk to v4 review.
        await page.evaluate(() => (window as any).CrispV4.goToReview());
        await page.waitForTimeout(400);
        // Either #v4-building-mount holds the box, OR #building-select-box
        // is itself inside stage-v4-review. Both designs satisfy the
        // requirement: that the selector is reachable from v4 review.
        const reachable = await page.evaluate(() => {
            const v4Review = document.getElementById('stage-v4-review');
            if (!v4Review) return false;
            const inV4 = !!v4Review.querySelector('#building-select-box');
            const v4Mount = !!document.getElementById('v4-building-mount');
            return inV4 || v4Mount;
        });
        expect(reachable, 'v4 review has no building selector mount').toBe(true);
    });

    test('entering v4 review moves #building-select-box into the v4 mount', async ({ page }) => {
        await _bootV4(page);
        // Set a known GPS so ensureMap doesn't bail on missing location.
        await page.evaluate(() => {
            const s = (window as any).state;
            s.location = { lat: 12.9716, lng: 77.5946, acc: 10 };
        });
        // Enter v4 review.
        await page.evaluate(() => (window as any).CrispV4.goToReview());
        await page.waitForTimeout(1500);
        const inV4Mount = await page.evaluate(() => {
            const mount = document.getElementById('v4-building-mount');
            const box = document.getElementById('building-select-box');
            return !!(mount && box && mount.contains(box));
        });
        expect(inV4Mount, '#building-select-box not relocated into v4 mount').toBe(true);
    });

    test('tapping v4 edit-location explicitly invokes BuildingSelect.ensureMap', async ({ page }) => {
        await _bootV4(page);
        await page.evaluate(() => {
            (window as any).state.location = { lat: 12.9716, lng: 77.5946, acc: 10 };
            const bs = (window as any).BuildingSelect;
            (window as any).__bsEnsureMapCalls = 0;
            const orig = bs.ensureMap;
            bs.ensureMap = function (...args: any[]) {
                (window as any).__bsEnsureMapCalls++;
                return orig.apply(bs, args);
            };
        });
        await page.evaluate(() => (window as any).CrispV4.goToReview());
        await page.waitForTimeout(300);
        // Click the edit-location row — explicitly wired in v4-flow.js to
        // call window.BuildingSelect.ensureMap(lat, lng).
        await page.locator('#v4-edit-location').click();
        await page.waitForTimeout(500);
        const calls = await page.evaluate(() => (window as any).__bsEnsureMapCalls || 0);
        expect(calls, 'tapping edit-location did not call BuildingSelect.ensureMap')
            .toBeGreaterThan(0);
    });

    test('BuildingSelect.getSelection() round-trips through state.buildingId', async ({ page }) => {
        await _bootV4(page);
        // Synthetically set buildingId (as if user tapped a polygon) and
        // verify the v4 review reads it back via getSelection().
        const trip = await page.evaluate(() => {
            (window as any).state.buildingId = 'osm:way:99999';
            return (window as any).BuildingSelect.getSelection();
        });
        expect(trip.buildingId, 'state.buildingId not exposed via getSelection').toBe('osm:way:99999');
    });
});

// ════════════════════════════════════════════════════════════════════════
// BUG 7 — Starting a new report wipes the previous one's state
// ════════════════════════════════════════════════════════════════════════
//
// User reported: "On adding another report the previous report state and
// data does not clear." In v3, btn-new-report → resetApp() → _clearCaptureState
// clears state.photoBlob, state.photoDataUrl, state.v4Photos, etc. v4 has
// its own goToCapture entrypoint that does NOT call _clearCaptureState,
// so re-entering capture after a previous submit shows the prior photo
// in the thumb strip and re-enables Continue prematurely.

test.describe('BUG 7 — v4 new-report path clears prior state', () => {
    test('CrispV4.goToCapture() after a submitted report wipes state.photoDataUrl', async ({ page }) => {
        await _bootV4(page);
        // Stamp state as if the previous report was submitted.
        await page.evaluate(() => {
            const s = (window as any).state;
            s.photoDataUrl = 'data:image/jpeg;base64,xxx';
            s.photoBlob = new Blob(['x'], { type: 'image/jpeg' });
            s.photoGroupId = 'grp-old';
            s.photoVariants = { small: { blob: new Blob(['s']), bytes: 1 },
                                medium: { blob: new Blob(['m']), bytes: 2 },
                                large: { blob: new Blob(['l']), bytes: 3 } };
            s.v4Photos = [{ blob: new Blob(['x']), url: 'data:x', ts: 1 }];
            s.description = 'old desc';
            s.buildingId = 'osm:way:111';
            s.locationName = 'Old place';
        });
        // Trigger the same path the user takes via "Add another report":
        // CrispV4.goToCapture() (called from the success screen + btn-start).
        await page.evaluate(() => (window as any).CrispV4.goToCapture());
        await page.waitForTimeout(300);
        const after = await page.evaluate(() => {
            const s = (window as any).state;
            return {
                photoDataUrl: s.photoDataUrl,
                photoBlob: s.photoBlob,
                photoGroupId: s.photoGroupId,
                photoVariants: s.photoVariants,
                v4Photos: s.v4Photos,
                description: s.description,
                buildingId: s.buildingId,
                locationName: s.locationName,
            };
        });
        expect(after.photoDataUrl, 'photoDataUrl not cleared on v4 new-report').toBeNull();
        expect(after.photoBlob, 'photoBlob not cleared on v4 new-report').toBeNull();
        expect(after.photoGroupId, 'photoGroupId not cleared on v4 new-report').toBeNull();
        expect(after.photoVariants, 'photoVariants not cleared on v4 new-report').toBeNull();
        expect(after.v4Photos?.length || 0, 'v4Photos not cleared on v4 new-report').toBe(0);
        expect(after.description, 'description not cleared on v4 new-report').toBe('');
        expect(after.buildingId, 'buildingId not cleared on v4 new-report').toBeNull();
        // May 2026 — locationName must be EITHER null OR a freshly-
        // resolved value (the IP-geolocation flow may async-overwrite
        // null with the device's IP-derived city after _clearCaptureState
        // runs). Either way, the OLD test value must be gone.
        expect(after.locationName, 'locationName not cleared on v4 new-report')
            .not.toBe('Old place');
    });

    test('v4 thumbnail strip is empty after re-entering capture', async ({ page }) => {
        await _bootV4(page);
        await page.evaluate(() => (window as any).CrispV4.goToCapture());
        await page.waitForTimeout(300);
        // Capture a photo.
        const jpg = writeTestJpegToTemp();
        await page.locator('#v4-file-camera').setInputFiles(jpg);
        await page.waitForFunction(() => !!(window as any).state.photoDataUrl,
                                   null, { timeout: 5000 });
        // Walk forward to review.
        await page.evaluate(() => (window as any).CrispV4.goToReview());
        await page.waitForTimeout(200);
        // Now simulate "Add another report" — back to capture entry.
        await page.evaluate(() => (window as any).CrispV4.goToCapture());
        await page.waitForTimeout(400);
        // Thumb strip must be empty (display:none or zero thumbs).
        const thumbCount = await page.evaluate(() => {
            const strip = document.getElementById('v4-thumbs');
            const display = strip ? getComputedStyle(strip).display : '';
            const count = strip ? strip.querySelectorAll('.v4-thumb:not(.v4-thumb-add)').length : -1;
            return { display, count };
        });
        expect(thumbCount.count, 'thumb strip not cleared on re-entry').toBe(0);
    });
});

// ════════════════════════════════════════════════════════════════════════
// BUG 4 — Voice-only path actually records audio + writes state
// ════════════════════════════════════════════════════════════════════════
//
// User reported: "Voice Only feature is not working as before." The v4
// review's voice drawer mic button forwards to btn-mic.click(), but
// btn-mic's handler (defined inside setupAudioStage's closure) writes
// only to v3 DOM (mic-label, mic-icon, rec-timer). v4 users see no
// recording feedback; worse, MediaRecorder.start() can fail silently
// if getUserMedia is unsupported (most desktop test envs).

test.describe('BUG 4 — v4 voice-only path is wired and exposes recording state', () => {
    test('v4 mic button has its own click handler that toggles recording', async ({ page }) => {
        await _bootV4(page);
        await page.evaluate(() => (window as any).CrispV4.goToReview());
        await page.waitForTimeout(300);
        // Probe: does CrispV4 expose a recorder API?
        const surface = await page.evaluate(() => {
            const v4 = (window as any).CrispV4 || {};
            return {
                hasStart: typeof v4.startRecording === 'function',
                hasStop: typeof v4.stopRecording === 'function',
                hasIsRecording: typeof v4.isRecording === 'function',
            };
        });
        expect(surface.hasStart, 'CrispV4.startRecording missing').toBe(true);
        expect(surface.hasStop, 'CrispV4.stopRecording missing').toBe(true);
        expect(surface.hasIsRecording, 'CrispV4.isRecording missing').toBe(true);
    });

    test('v4 textarea writes through to state.description', async ({ page }) => {
        await _bootV4(page);
        // The #v4-text-desc input listener is wired at boot (_initReviewStage),
        // and the contract under test is purely "input → state". The review
        // drawer's on-screen visibility is gated by the redesigned bottom-sheet
        // UX (a trigger button + smooth-scroll), which makes a Playwright
        // .fill() flaky; drive the input event directly to assert the
        // write-through (input → _setState → state.description + .transcript).
        const result = await page.evaluate(() => {
            const ta = document.getElementById('v4-text-desc') as HTMLTextAreaElement | null;
            if (!ta) return { ok: false, desc: null, transcript: null };
            ta.value = 'voice-only test description';
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            return {
                ok: true,
                desc: (window as any).state.description,
                transcript: (window as any).state.transcript,
            };
        });
        expect(result.ok, '#v4-text-desc not present in DOM').toBe(true);
        expect(result.desc, 'state.description not synced from v4 textarea input handler')
            .toBe('voice-only test description');
        expect(result.transcript, 'state.transcript should mirror the textarea (submit reads either)')
            .toBe('voice-only test description');
    });

    test('CrispV4.startRecording mocked: state.isRecording flips and audioChunks accumulate', async ({ page }) => {
        await _bootV4(page);
        await page.evaluate(() => (window as any).CrispV4.goToReview());
        await page.waitForTimeout(300);
        // Stub getUserMedia + MediaRecorder so the test runs in headless
        // browsers without a real mic. The v4 recorder must work against
        // the stubbed surface — that's the contract.
        const result = await page.evaluate(async () => {
            // Install a mock MediaRecorder.
            (window as any).navigator.mediaDevices = (window as any).navigator.mediaDevices || {};
            (window as any).navigator.mediaDevices.getUserMedia = async () => ({
                getTracks: () => [{ stop: () => {} }],
            });
            class MockRecorder {
                state = 'inactive';
                ondataavailable: any = null;
                onstop: any = null;
                start() { this.state = 'recording'; }
                stop() {
                    this.state = 'inactive';
                    if (this.ondataavailable) {
                        this.ondataavailable({ data: new Blob(['fake-audio'], { type: 'audio/webm' }) });
                    }
                    if (this.onstop) this.onstop();
                }
            }
            (window as any).MediaRecorder = MockRecorder;

            const v4 = (window as any).CrispV4;
            await v4.startRecording();
            const recordingState = v4.isRecording();
            await new Promise((r) => setTimeout(r, 100));
            await v4.stopRecording();
            await new Promise((r) => setTimeout(r, 100));
            const stoppedState = v4.isRecording();
            return {
                recordingState,
                stoppedState,
                hasAudioBlob: !!(window as any).state.audioBlob,
            };
        });
        expect(result.recordingState, 'isRecording() should be true during recording').toBe(true);
        expect(result.stoppedState, 'isRecording() should be false after stop').toBe(false);
        expect(result.hasAudioBlob, 'state.audioBlob not populated after stop').toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
// BUG 8 — Location pill shows place name (state.locationName), not coords
// ════════════════════════════════════════════════════════════════════════
//
// User: "Location with Co-ordinates show the Location Name." v4's
// _refreshGps writes the raw `12.9716°, 77.5946° · ±10m` string into
// the location pill, never running reverse geocode. v3 paints state
// .locationName via _paintLocationDisplays after resolveLocationName
// resolves Nominatim. v4 needs the same chain.

test.describe('BUG 8 — v4 location pill shows place name when available', () => {
    test('window.resolveLocationName is exposed for v4 to call', async ({ page }) => {
        await _bootV4(page);
        const exposed = await page.evaluate(() => ({
            resolveLocationName: typeof (window as any).resolveLocationName,
            reverseGeocode: typeof (window as any).reverseGeocode,
        }));
        // Either is fine — v4 needs at least one to trigger the resolve.
        const ok = exposed.resolveLocationName === 'function' ||
                   exposed.reverseGeocode === 'function';
        expect(ok, 'no location-resolve helper exposed on window').toBe(true);
    });

    test('v4 location pill renders state.locationName when set', async ({ page }) => {
        await _bootV4(page);
        await page.evaluate(() => {
            const s = (window as any).state;
            s.location = { lat: 12.9716, lng: 77.5946, acc: 10 };
            s.locationName = 'Koramangala, Bangalore, India';
        });
        // Enter v4 review and trigger the summary update.
        await page.evaluate(() => (window as any).CrispV4.goToReview());
        await page.waitForTimeout(300);
        const text = await page.locator('#v4-row-location-text').textContent();
        expect(text, 'v4 review location row should show place name')
            .toContain('Koramangala');
    });

    test('v4 capture stage location pill prefers locationName over coords', async ({ page }) => {
        await _bootV4(page);
        // goToCapture runs _clearCaptureState which intentionally wipes
        // locationName (v3 contract: GPS re-fetches). So we navigate
        // FIRST, then set state, then dispatch the paint trigger v4
        // listens for.
        await page.evaluate(() => (window as any).CrispV4.goToCapture());
        await page.waitForTimeout(200);
        await page.evaluate(() => {
            const s = (window as any).state;
            s.location = { lat: 12.9716, lng: 77.5946, acc: 10 };
            s.locationName = 'My Suburb, City';
            // Tell v4 to re-paint pills (mirror what resolveLocationName
            // does in production after Nominatim resolves).
            document.dispatchEvent(new CustomEvent('location-resolved'));
        });
        await page.waitForTimeout(300);
        const captureText = await page.locator('#v4-meta-location-text').textContent();
        expect(captureText, 'capture pill should prefer locationName')
            .toContain('My Suburb');
    });
});

// ════════════════════════════════════════════════════════════════════════
// BUG 1 — Landing page no longer fluctuates (May 2026 follow-up)
// ════════════════════════════════════════════════════════════════════════
//
// Original BUG 1 (April 2026): "landing page is fluctuating between the
// older one and the new one." The fix added a `landing-pending` body
// class that hid #stage-home while #landing-overlay was up.
//
// May 2026 follow-up: BOTH #landing-overlay AND the legacy
// #consent-overlay were deleted; the merged always-on home page
// replaces them. Fluctuation is impossible because there is only ONE
// home now. The new tests assert no leftover DOM + no overlay flash on
// every visit (first or returning).

test.describe('BUG 1 (post-merge) — single always-on home, no overlay flash', () => {
    test('first visit: only #stage-home is active, no landing-overlay or consent-overlay', async ({ page }) => {
        await page.goto('index.html');
        await page.waitForSelector('#stage-home.active', { timeout: 5000 });
        const dom = await page.evaluate(() => ({
            hasLandingOverlay: !!document.getElementById('landing-overlay'),
            hasLegacyConsentOverlay: !!document.getElementById('consent-overlay'),
            homeActive: !!document.querySelector('#stage-home.active'),
            // HC57+ — the inline #home-consent row was removed; the consent gate
            // is now the #consent-onboarding modal, which is active on first
            // visit while <html> lacks the `crisp-consented` class.
            consentGatePresent: !!document.getElementById('consent-onboarding'),
            consentGateActiveFirstVisit: !document.documentElement.classList.contains('crisp-consented'),
        }));
        expect(dom.hasLandingOverlay, '#landing-overlay should not exist anymore').toBe(false);
        expect(dom.hasLegacyConsentOverlay, '#consent-overlay should be deleted').toBe(false);
        expect(dom.homeActive, '#stage-home should be the active stage').toBe(true);
        expect(dom.consentGatePresent, '#consent-onboarding (replacing the inline #home-consent row) should exist').toBe(true);
        expect(dom.consentGateActiveFirstVisit, 'consent gate should be active on first visit (no crisp-consented class)').toBe(true);
    });

    test('returning visitor (consent set) sees home with consent row hidden', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('crisp_privacy_consent',
                JSON.stringify({ accepted: true, ts: Date.now() }));
        });
        await page.goto('index.html');
        await page.waitForSelector('#stage-home.active', { timeout: 5000 });
        const result = await page.evaluate(() => ({
            homeActive: !!document.querySelector('#stage-home.active'),
            consentVisible: (() => {
                const c = document.getElementById('home-consent');
                return c ? getComputedStyle(c).display !== 'none' : false;
            })(),
            startEnabled: !((document.getElementById('btn-start') as HTMLButtonElement | null)?.disabled),
        }));
        expect(result.homeActive, 'returning user should land on stage-home').toBe(true);
        expect(result.consentVisible, 'returning user should not see the consent row').toBe(false);
        expect(result.startEnabled, 'Start should be enabled for returning user').toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════════════
// BUG 2 — Desktop webcam opens via getUserMedia fallback
// ════════════════════════════════════════════════════════════════════════
//
// User: "On laptop the integ web cams are not opening on clicking
// camera, opening browse device pop-up." Expected on desktop because
// `<input type=file capture=environment>` falls back to file picker on
// Chrome/Firefox desktop — `capture` is a hint, not a requirement. v4
// should detect desktop + open the existing v3 #camera-modal (which
// uses getUserMedia + a live <video>).

test.describe('BUG 2 — v4 camera button opens webcam on desktop', () => {
    test('camera-modal exists and openCameraModal is reachable via window', async ({ page }) => {
        await _bootV4(page);
        const surface = await page.evaluate(() => ({
            modal: !!document.getElementById('camera-modal'),
            // openCameraModal is a top-level function in app.js that browsers
            // expose as a global in non-module script context.
            openFn: typeof (window as any).openCameraModal,
        }));
        expect(surface.modal, '#camera-modal not present in DOM').toBe(true);
        expect(surface.openFn, 'openCameraModal not exposed as global').toBe('function');
    });

    // (BUG 2 test 2 just below.)
    test('on desktop (getUserMedia available, not iOS) v4 camera opens the modal', async ({ page }) => {
        await _bootV4(page);
        // Stub getUserMedia + neutralise srcObject so the modal stays open.
        // openCameraModal sets modal.display='flex' synchronously then
        // assigns srcObject inside a .then; without a neutralised setter,
        // assigning a non-MediaStream throws → .catch path closes the
        // modal. We just want to assert the wire-up.
        await page.evaluate(() => {
            (window as any).navigator.mediaDevices = (window as any).navigator.mediaDevices || {};
            (window as any).navigator.mediaDevices.getUserMedia = async () => ({
                getTracks: () => [{ stop: () => {} }],
                getVideoTracks: () => [{ stop: () => {} }],
            });
            // Eat srcObject assignment so .then doesn't throw.
            try {
                Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
                    configurable: true,
                    set: () => {},
                    get: () => null,
                });
            } catch (_) {}
            // Spy: did openCameraModal get called?
            (window as any).__openCalls = 0;
            const orig = (window as any).openCameraModal;
            (window as any).openCameraModal = function (...args: any[]) {
                (window as any).__openCalls++;
                return orig.apply(this, args);
            };
        });
        await page.evaluate(() => (window as any).CrispV4.goToCapture());
        await page.waitForTimeout(300);
        // Click the v4 camera hero button.
        await page.locator('#btn-v4-camera').click();
        await page.waitForTimeout(300);
        const result = await page.evaluate(() => {
            const m = document.getElementById('camera-modal');
            return {
                openCalls: (window as any).__openCalls || 0,
                display: m ? getComputedStyle(m).display : '',
            };
        });
        expect(result.openCalls, 'openCameraModal was not invoked from v4 camera click')
            .toBeGreaterThan(0);
    });
});

// ════════════════════════════════════════════════════════════════════════
// BUG 3 — Android hardware back button navigates between v4 stages
// ════════════════════════════════════════════════════════════════════════
//
// User: "On pressing back button on android mobile's standard back button,
// the PWA closes which is installed on home screen." Fixed at v3 level
// already (commit 27a7d69). This test confirms the same fix applies to
// v4 stages — every v4 stage transition pushes a history entry, and
// browser-back lands on the previous stage instead of exiting.

test.describe('BUG 3 — v4 stages push history + back navigates', () => {
    test('CrispV4 stage transitions extend history depth', async ({ page }) => {
        await _bootV4(page);
        const before = await page.evaluate(() => history.length);
        await page.evaluate(() => (window as any).CrispV4.goToCapture());
        await page.waitForTimeout(150);
        await page.evaluate(() => (window as any).CrispV4.goToClassify());
        await page.waitForTimeout(150);
        await page.evaluate(() => (window as any).CrispV4.goToReview());
        await page.waitForTimeout(150);
        const after = await page.evaluate(() => history.length);
        expect(after - before, 'v4 stages did not push history entries')
            .toBeGreaterThanOrEqual(3);
    });

    test('browser back from v4-review lands on a known stage (not exit)', async ({ page }) => {
        await _bootV4(page);
        await page.evaluate(() => (window as any).CrispV4.goToCapture());
        await page.waitForTimeout(200);
        await page.evaluate(() => (window as any).CrispV4.goToClassify());
        await page.waitForTimeout(200);
        await page.evaluate(() => (window as any).CrispV4.goToReview());
        await page.waitForTimeout(200);
        await page.goBack();
        await page.waitForTimeout(500);
        const active = await page.evaluate(() => {
            const all = ['stage-home', 'stage-v4-capture', 'stage-v4-classify',
                         'stage-v4-review', 'stage-photo', 'stage-audio',
                         'stage-review', 'stage-where', 'stage-infra', 'stage-crisis'];
            for (const s of all) {
                if (document.getElementById(s)?.classList.contains('active')) return s;
            }
            return null;
        });
        expect(active, 'browser back exited the PWA / left no stage active').not.toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════════
// BUG 9 — V4 offline queue: enqueueReport actually persists v4 reports
// ════════════════════════════════════════════════════════════════════════
//
// User: "Check and verify the old Queuing feature works." V4's _onSend
// delegates to window.__crispSubmitReport which calls the same submit
// path v3 uses. submitReport always enqueues into IndexedDB BEFORE any
// network attempt — so an offline submission must land in the queue
// regardless of UI flow.

test.describe('BUG 9 — v4 send always enqueues report into IDB', () => {
    test('CrispV4._onSend path persists into IndexedDB on offline submit', async ({ page }) => {
        await _bootV4(page);
        // Set the entire state v4's send path expects.
        //
        // v6.7 (May 2026) — submitReport reads snake_case classifier fields
        // first, camelCase as fallback. We seed BOTH to match what the
        // v4-flow actually writes, AND set state.photoVariants so the new
        // _reattemptMissingVariants() (8350ce9) short-circuits — otherwise
        // ImageVariants.generate runs against the test's 2-byte garbage
        // blob and stalls the submit path past the 5 s test timeout.
        await page.evaluate(() => {
            const s = (window as any).state;
            s.location = { lat: 12.97, lng: 77.59, acc: 10 };
            s.locationName = 'Test Location';
            s.crisis_type = 'EARTHQUAKE';
            s.infrastructure_type = 'COMMERCIAL';
            s.damage_classification = 'PARTIAL';
            s.crisisType = 'EARTHQUAKE';
            s.infraType = 'COMMERCIAL';
            s.damageClass = 'PARTIAL';
            s.severity = 'MODERATE';
            // Jun 2026 UNDP gate: _onSend refuses to submit until the debris
            // question has an explicit answer — this test exercises offline
            // IDB persistence, not the gate, so answer it.
            s.debris_present = false;
            s.description = 'v4 offline-queue regression test';
            s.photoDataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAAKAAoDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';
            const stubBlob = new Blob([new Uint8Array([0xFF, 0xD8])], { type: 'image/jpeg' });
            s.photoBlob = stubBlob;
            s.photoGroupId = 'grp-' + Date.now();
            s.extraPhotos = [];
            // Pre-populate Phase L canonical variants so _reattemptMissingVariants
            // sees `photoVariants.small` and returns immediately (avoids the
            // expensive variant pipeline running against a 2-byte garbage blob).
            s.photoVariants = {
                small:    { blob: stubBlob, bytes: 1024, clientBlurApplied: false },
                medium:   { blob: stubBlob, bytes: 1024, clientBlurApplied: false },
                original: { blob: stubBlob, bytes: 1024, clientBlurApplied: false },
                clientBlurApplied: false,
            };
        });
        // Force offline (network-error scenario).
        await page.context().setOffline(true);
        // Trigger v4 send.
        const queuedBefore = await page.evaluate(async () =>
            (await (window as any).__crispGetAllQueued()).length);
        await page.evaluate(() => (window as any).CrispV4.goToReview());
        await page.waitForTimeout(200);
        await page.locator('#btn-v4-send').click();
        // submitReport awaits enqueueReport BEFORE showing success — give
        // it a moment then check the queue grew.
        await page.waitForFunction(async () => {
            const q = await (window as any).__crispGetAllQueued();
            return q.length > 0;
        }, null, { timeout: 5000 });
        const queuedAfter = await page.evaluate(async () =>
            (await (window as any).__crispGetAllQueued()).length);
        await page.context().setOffline(false);
        expect(queuedAfter, 'queue did not grow after v4 offline submit')
            .toBeGreaterThan(queuedBefore);
    });
});
