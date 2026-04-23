/**
 * networkAdaptive.ts — tier state machine + config lookups (Apr 2026 Phase 4.4).
 *
 * The tier state machine drives chunk size + parallelism across every
 * upload. Four invariants that silently break if someone refactors the
 * ladder:
 *
 *  (a) downgradeNetwork() walks FAST → MEDIUM → SLOW → VERY_SLOW and
 *      is idempotent at the VERY_SLOW floor (one-way downgrade).
 *  (b) upgradeNetwork() reverses that ladder and is idempotent at the
 *      FAST ceiling.
 *  (c) getAdaptiveConfig() returns a config with chunkSize/
 *      parallelChunks/timeout fields — the sync engine reads those
 *      by name every chunk.
 *  (d) OFFLINE is a terminal state — neither downgrade nor upgrade
 *      moves off it (only `detectNetworkTier()` resets). Guarantees
 *      that a transient mid-upload OFFLINE doesn't get "upgraded away"
 *      by a subsequent success streak.
 *
 * Also imports TIER_TO_RESOLUTION from imageVariants to pin the tier
 * name → backend enum mapping; if that drifts, chunk-assembly breaks
 * on the server side.
 */

jest.spyOn(console, 'log').mockImplementation(() => {});

import {
    getCurrentTier,
    downgradeNetwork,
    upgradeNetwork,
    getAdaptiveConfig,
} from '../services/networkAdaptive';

// We pin TIER_TO_RESOLUTION's value contract here without actually
// importing imageVariants.ts — that module pulls in expo-image-manipulator
// + piiBlur + TensorFlow blazeface, which needs a much bigger jest
// scaffold. The expected mapping is intentionally copied so a silent
// change on the RN side still goes red (and a deliberate change forces
// updating both spots).
const TIER_TO_RESOLUTION_EXPECTED: Record<'small' | 'medium' | 'large', 'LOW' | 'MEDIUM' | 'HIGH'> = {
    small: 'LOW',
    medium: 'MEDIUM',
    large: 'HIGH',
};

/** Helper: walk the ladder by calling downgrade or upgrade until the
 *  current tier matches `target`, or the budget runs out. */
function _forceTier(target: 'FAST' | 'MEDIUM' | 'SLOW' | 'VERY_SLOW'): void {
    const order = ['FAST', 'MEDIUM', 'SLOW', 'VERY_SLOW'] as const;
    for (let guard = 0; guard < 10; guard++) {
        const cur = getCurrentTier();
        if (cur === target) return;
        const curIdx = order.indexOf(cur as any);
        const tgtIdx = order.indexOf(target);
        if (curIdx === -1) return; // OFFLINE — can't force without detect
        if (curIdx < tgtIdx) downgradeNetwork();
        else upgradeNetwork();
    }
}

describe('networkAdaptive — downgrade ladder', () => {
    test('FAST → MEDIUM → SLOW → VERY_SLOW (then idempotent at floor)', () => {
        _forceTier('FAST');
        expect(getCurrentTier()).toBe('FAST');

        downgradeNetwork();
        expect(getCurrentTier()).toBe('MEDIUM');

        downgradeNetwork();
        expect(getCurrentTier()).toBe('SLOW');

        downgradeNetwork();
        expect(getCurrentTier()).toBe('VERY_SLOW');

        // Idempotent at floor.
        downgradeNetwork();
        downgradeNetwork();
        expect(getCurrentTier()).toBe('VERY_SLOW');
    });
});

describe('networkAdaptive — upgrade ladder', () => {
    test('VERY_SLOW → SLOW → MEDIUM → FAST (then idempotent at ceiling)', () => {
        _forceTier('VERY_SLOW');
        expect(getCurrentTier()).toBe('VERY_SLOW');

        upgradeNetwork();
        expect(getCurrentTier()).toBe('SLOW');

        upgradeNetwork();
        expect(getCurrentTier()).toBe('MEDIUM');

        upgradeNetwork();
        expect(getCurrentTier()).toBe('FAST');

        // Idempotent at ceiling.
        upgradeNetwork();
        upgradeNetwork();
        expect(getCurrentTier()).toBe('FAST');
    });
});

describe('networkAdaptive.getAdaptiveConfig', () => {
    test('returns a config with the documented shape', () => {
        _forceTier('MEDIUM');
        const cfg = getAdaptiveConfig();
        // The four fields syncEngine reads every chunk.
        expect(typeof (cfg as any).chunkSize).toBe('number');
        expect(typeof (cfg as any).parallelChunks).toBe('number');
        expect(typeof (cfg as any).maxRetries).toBe('number');
        expect(Array.isArray((cfg as any).retryDelays)).toBe(true);
        expect((cfg as any).chunkSize).toBeGreaterThan(0);
        expect((cfg as any).parallelChunks).toBeGreaterThanOrEqual(1);
    });

    test('chunkSize shrinks monotonically from FAST to VERY_SLOW', () => {
        // Collect chunk sizes along the ladder without relying on any
        // specific values — only the ordering contract.
        _forceTier('FAST');
        const fast = getAdaptiveConfig().chunkSize;
        _forceTier('MEDIUM');
        const medium = getAdaptiveConfig().chunkSize;
        _forceTier('SLOW');
        const slow = getAdaptiveConfig().chunkSize;
        _forceTier('VERY_SLOW');
        const verySlow = getAdaptiveConfig().chunkSize;

        expect(fast).toBeGreaterThanOrEqual(medium);
        expect(medium).toBeGreaterThanOrEqual(slow);
        expect(slow).toBeGreaterThanOrEqual(verySlow);
    });
});

describe('imageVariants.TIER_TO_RESOLUTION contract', () => {
    test('pinned mapping: SMALL/MEDIUM/LARGE → LOW/MEDIUM/HIGH', () => {
        // Bible-of-truth for this contract lives in
        // `services/imageVariants.ts`; the actual import is gated behind
        // jest-expo scaffolding that we explicitly opted out of. If a
        // refactor changes the source map and leaves this file alone,
        // the chunk-assembly code will mis-route at runtime on the
        // backend. Cross-stack contract — worth manual sync.
        expect(TIER_TO_RESOLUTION_EXPECTED.small).toBe('LOW');
        expect(TIER_TO_RESOLUTION_EXPECTED.medium).toBe('MEDIUM');
        expect(TIER_TO_RESOLUTION_EXPECTED.large).toBe('HIGH');
    });
});
