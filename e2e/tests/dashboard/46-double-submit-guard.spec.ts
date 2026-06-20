/**
 * D6: shared double-submit / busy guard (window.withBusy).
 *
 * Every mutating handler that was hardened in the interaction-audit remediation
 * routes through this one primitive (wizard launch, settings save/role/delete,
 * duplicate merge/unmerge, undo-claim). Testing the primitive directly is the
 * most robust regression guard - if it stops blocking the second call or stops
 * restoring the control, every call site regresses at once and this catches it.
 */
import { test, expect } from '@playwright/test';

async function boot(page) {
    await page.addInitScript(() => {
        localStorage.setItem('crisp_token', 'e2e-fake-token');
        localStorage.setItem('crisp_user', JSON.stringify({ role: 'SUPER_ADMIN', email: 'ops@undp.org', full_name: 'Ops Lead' }));
    });
    await page.route('**/api/v1/**', (route) => route.fulfill({ status: 200, json: {} }));
    await page.goto('index.html#/incidents');
    await page.waitForFunction(() => typeof (window as any).withBusy === 'function', { timeout: 8000 });
}

test('D6: a button double-click runs the action once, then restores label + enabled state', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(async () => {
        const btn = document.createElement('button');
        btn.id = '__d6btn'; btn.textContent = 'Save';
        document.body.appendChild(btn);
        let calls = 0;
        const slow = () => new Promise<void>((res) => { calls++; setTimeout(res, 250); });
        const p1 = (window as any).withBusy(btn, slow);          // first click - runs
        const duringDisabled = btn.disabled;
        const duringBusy = btn.getAttribute('aria-busy');
        const duringHasSpinner = !!btn.querySelector('.cc-busy-spin');
        const p2 = (window as any).withBusy(btn, slow);          // second click - guarded out
        await Promise.all([p1, p2]);
        return {
            calls, duringDisabled, duringBusy, duringHasSpinner,
            afterDisabled: btn.disabled, afterLabel: btn.textContent, afterBusy: btn.getAttribute('aria-busy'),
        };
    });
    expect(r.calls, 'second click must be guarded out').toBe(1);
    expect(r.duringDisabled, 'button disabled during the action').toBe(true);
    expect(r.duringBusy).toBe('true');
    expect(r.duringHasSpinner, 'spinner shown during the action').toBe(true);
    expect(r.afterDisabled, 'button re-enabled after').toBe(false);
    expect(r.afterLabel, 'original label restored').toBe('Save');
    expect(r.afterBusy, 'aria-busy cleared after').toBe(null);
});

test('D6: withBusy on a <select> disables it WITHOUT wiping its options', async ({ page }) => {
    await boot(page);
    const r = await page.evaluate(async () => {
        const sel = document.createElement('select');
        sel.innerHTML = '<option>VIEWER</option><option>ANALYST</option><option>ADMIN</option>';
        document.body.appendChild(sel);
        const p = (window as any).withBusy(sel, () => new Promise<void>((res) => setTimeout(res, 150)));
        const duringOpts = sel.options.length;
        const duringDisabled = (sel as HTMLSelectElement).disabled;
        await p;
        return { duringOpts, duringDisabled, afterOpts: sel.options.length, afterDisabled: (sel as HTMLSelectElement).disabled };
    });
    expect(r.duringOpts, 'role <select> options must survive the busy state').toBe(3);
    expect(r.duringDisabled).toBe(true);
    expect(r.afterOpts).toBe(3);
    expect(r.afterDisabled).toBe(false);
});
