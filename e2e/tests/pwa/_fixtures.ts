/**
 * Shared PWA test fixtures.
 *
 * Auto-stubs GET /crisis-forms/active → {active:false} on every page, so the
 * DEFAULT capture/classify flow is exercised deterministically regardless of
 * whatever crisis zones happen to be active in the local dev backend. (The
 * Dynamic Crisis Forms geo-gate fetches this endpoint on the location fix; a
 * real active zone at the test coordinates would otherwise skip the crisis
 * step / inject a crisispack sub-step and break default-flow assertions.)
 *
 * Specs that test the crisis-pack flow itself (e.g. 121) should NOT import this
 * `test` — they import the base `@playwright/test` and control /active directly.
 */
import { test as base, expect } from '@playwright/test';

export const test = base.extend({
    page: async ({ page }, use) => {
        await page.route('**/crisis-forms/active**', (route) =>
            route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ active: false }),
            }),
        );
        await use(page);
    },
});

export { expect };
export type { Page } from '@playwright/test';
