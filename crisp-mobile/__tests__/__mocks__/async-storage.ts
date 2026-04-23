/**
 * In-memory AsyncStorage replacement for jest.
 *
 * jest-expo ships a mock for this package but it's been unreliable
 * across expo SDK bumps — easier to own the surface ourselves. Covers
 * the subset of AsyncStorage the codebase uses (getItem/setItem/
 * removeItem/clear/multiGet); anything else throws so a gap in our
 * mock surfaces at test-authoring time rather than silently returning
 * undefined.
 */
const _store = new Map<string, string>();

export default {
    async getItem(k: string): Promise<string | null> {
        return _store.has(k) ? (_store.get(k) as string) : null;
    },
    async setItem(k: string, v: string): Promise<void> {
        _store.set(k, String(v));
    },
    async removeItem(k: string): Promise<void> {
        _store.delete(k);
    },
    async clear(): Promise<void> {
        _store.clear();
    },
    async multiGet(keys: string[]): Promise<Array<[string, string | null]>> {
        return keys.map((k) => [k, _store.has(k) ? (_store.get(k) as string) : null]);
    },
    async multiSet(pairs: Array<[string, string]>): Promise<void> {
        for (const [k, v] of pairs) _store.set(k, String(v));
    },
    async getAllKeys(): Promise<string[]> {
        return Array.from(_store.keys());
    },
};

// Test-only utility so a suite can force-reset the store between tests
// without wiring a `beforeEach` in every file.
export function __resetAsyncStorageMock(): void {
    _store.clear();
}
