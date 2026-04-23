/**
 * reviewReducer — pure 3-page navigation reducer for the Apr 2026 UI v2
 * review split. Lives in components/ (not services/) because it's RN-UI
 * concern only; no storage or network side-effects.
 *
 * Contract (see __tests__/reviewStateMachine.test.ts for the pinned
 * invariants):
 *   · NEXT on the last page is a no-op — render the Submit button instead
 *     of Next on page 3 so this branch should not normally fire, but we
 *     clamp defensively.
 *   · BACK on page 1 is a no-op — callers (Android BackHandler) treat
 *     that as "let the OS pop the stack" and exit the review screen.
 *   · RESET returns 1, always. Called on entry to the review stage.
 *   · Unknown action types fall through unchanged (forward-compat guard).
 */

export type Page = 1 | 2 | 3;
export type Action = { type: 'NEXT' } | { type: 'BACK' } | { type: 'RESET' };

export function reviewReducer(page: Page, action: Action): Page {
  switch (action.type) {
    case 'NEXT':
      return (page < 3 ? ((page + 1) as Page) : page);
    case 'BACK':
      return (page > 1 ? ((page - 1) as Page) : page);
    case 'RESET':
      return 1;
    default:
      return page;
  }
}
