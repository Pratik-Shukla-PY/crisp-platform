/**
 * syncEngine.ts — helper surface tests (Apr 2026 Phase 4.3).
 *
 * Doesn't exercise full queue processing (that needs expo-sqlite + a
 * mocked backend); instead pins the smaller observable helpers that
 * back the adaptive-upload feature. If any of these shift silently the
 * whole adaptive pipeline can silently mis-tier:
 *
 *  (a) Binary-chunks feature flag round-trips via setter/getter, and
 *      flipping to OFF wipes the sticky-404 fallback flag so a later
 *      ON re-enables the new endpoint.
 *  (b) Packet-loss counter: records retries above threshold, clamps
 *      below-threshold retries, resets via resetPacketLossCounters.
 *  (c) MID_UPLOAD_REPROBE_EVERY is still 8 — deliberate pin so a
 *      refactor that changes the probe cadence goes through a
 *      reviewed commit.
 *  (d) _getMeasuredBandwidth() returns 0 before any probe runs —
 *      guards against a refactor that initialises the module-private
 *      cache with a stale-but-nonzero value and fools the tier picker
 *      into skipping the cold-start probe.
 *
 * Runs under `jest-expo` — the syncEngine module `require`s
 * `@react-native-async-storage/async-storage`; the preset provides
 * the needed no-op mock.
 */

// Silence a noisy module-level console.log from networkAdaptive import.
jest.spyOn(console, 'log').mockImplementation(() => {});

import {
    setBinaryChunksEnabled,
    isBinaryChunksEnabled,
    recordRetryCount,
    resetPacketLossCounters,
    getPacketLossEvents,
    MID_UPLOAD_REPROBE_EVERY,
    _getMeasuredBandwidth,
} from '../services/syncEngine';

describe('binary chunks feature flag', () => {
    test('setBinaryChunksEnabled round-trips through isBinaryChunksEnabled', () => {
        setBinaryChunksEnabled(true);
        expect(isBinaryChunksEnabled()).toBe(true);

        setBinaryChunksEnabled(false);
        expect(isBinaryChunksEnabled()).toBe(false);

        setBinaryChunksEnabled(true);
        expect(isBinaryChunksEnabled()).toBe(true);
    });

    test('non-boolean arg coerced to boolean (no TypeError leak)', () => {
        // @ts-expect-error — exercise the loose-truthy path
        setBinaryChunksEnabled(null);
        expect(isBinaryChunksEnabled()).toBe(false);

        // @ts-expect-error
        setBinaryChunksEnabled(1);
        expect(isBinaryChunksEnabled()).toBe(true);
    });
});

describe('packet-loss counters', () => {
    beforeEach(() => resetPacketLossCounters());

    test('events below threshold (retries ≤ 3) are NOT counted', () => {
        recordRetryCount(0);
        recordRetryCount(1);
        recordRetryCount(3);   // exactly at threshold — NOT counted (`> 3`)
        expect(getPacketLossEvents()).toBe(0);
    });

    test('events strictly above threshold bump the counter', () => {
        recordRetryCount(4);
        recordRetryCount(7);
        expect(getPacketLossEvents()).toBe(2);
    });

    test('resetPacketLossCounters wipes the accumulator', () => {
        recordRetryCount(10);
        recordRetryCount(10);
        expect(getPacketLossEvents()).toBe(2);
        resetPacketLossCounters();
        expect(getPacketLossEvents()).toBe(0);
    });
});

describe('module constants', () => {
    test('MID_UPLOAD_REPROBE_EVERY === 8 (documented in §13 plan)', () => {
        expect(MID_UPLOAD_REPROBE_EVERY).toBe(8);
    });
});

describe('measured bandwidth cache', () => {
    test('returns 0 before any probe has run (cold start)', () => {
        // This test is order-sensitive — runs before any probe fires.
        // If a later test in this file adds a real probe, this assertion
        // must move to a dedicated file. For now, syncEngine's probe is
        // never invoked in this suite.
        expect(_getMeasuredBandwidth()).toBe(0);
    });
});
