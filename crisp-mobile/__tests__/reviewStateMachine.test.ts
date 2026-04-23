/**
 * reviewStateMachine — 3-page review-flow reducer (Apr 2026 UI v2).
 *
 * The review screen was collapsed from an n-way switch into a small
 * reducer so we can unit-test page transitions in isolation of the huge
 * App.tsx render tree. Only inputs here: current page (1|2|3) + an
 * action ({type: 'NEXT'|'BACK'|'RESET'}). Output: the next page.
 *
 * Invariants pinned:
 *   · NEXT clamps at the last page (3) — never advances past the end.
 *   · BACK clamps at page 1 — never goes below the floor (mirrors the
 *     Android hardware-Back semantics wired in App.tsx).
 *   · RESET always returns 1, regardless of current page. Used when
 *     the user enters the review stage so a stale page-2 from a prior
 *     draft doesn't flash on entry.
 *   · Unknown action types are a no-op (returns current page). This is
 *     a defensive guard against future action additions — prevents a
 *     typo from silently corrupting navigation state.
 *
 * Why a reducer: same pattern the PWA uses for its own 3-stage review
 * (mobile-app/src/app.js _reviewAdvance). Keeps RN + PWA in lock-step.
 */

type Page = 1 | 2 | 3;
type Action = { type: 'NEXT' } | { type: 'BACK' } | { type: 'RESET' };

// Pure reducer — exported so App.tsx can import it once the split lands.
// Duplicated here for the test so the test file is self-contained. The
// App.tsx implementation imports this exact signature.
import { reviewReducer, type Page as PageT, type Action as ActionT } from '../components/reviewReducer';

describe('reviewReducer — 3-page flow', () => {
    test('NEXT on page 1 → page 2', () => {
        expect(reviewReducer(1, { type: 'NEXT' })).toBe(2);
    });

    test('NEXT on page 2 → page 3', () => {
        expect(reviewReducer(2, { type: 'NEXT' })).toBe(3);
    });

    test('NEXT on page 3 stays on page 3 (clamp at end)', () => {
        // Last page; Submit replaces Next, but if the reducer sees NEXT
        // anyway we must not overflow to 4.
        expect(reviewReducer(3, { type: 'NEXT' })).toBe(3);
    });

    test('BACK on page 3 → page 2', () => {
        expect(reviewReducer(3, { type: 'BACK' })).toBe(2);
    });

    test('BACK on page 2 → page 1', () => {
        expect(reviewReducer(2, { type: 'BACK' })).toBe(1);
    });

    test('BACK on page 1 stays on page 1 (clamp at floor)', () => {
        // Android hardware back uses this — when already on page 1, the
        // reducer is a no-op and the App-level BackHandler lets the OS
        // default (exit screen) run.
        expect(reviewReducer(1, { type: 'BACK' })).toBe(1);
    });

    test('RESET from any page → page 1', () => {
        expect(reviewReducer(1, { type: 'RESET' })).toBe(1);
        expect(reviewReducer(2, { type: 'RESET' })).toBe(1);
        expect(reviewReducer(3, { type: 'RESET' })).toBe(1);
    });

    test('unknown action is a no-op', () => {
        // Defensive guard against future action types. Cast-through so TS
        // doesn't reject the test's deliberately-bogus payload.
        const bogus = { type: 'WARP' } as unknown as ActionT;
        expect(reviewReducer(2, bogus)).toBe(2);
    });
});
