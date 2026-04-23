/**
 * expo-crypto stub for node-side jest. Real module uses native crypto
 * primitives; tests only need `digestStringAsync` / `randomUUID` for
 * import-time resolution.
 */
export async function digestStringAsync(_alg: string, data: string): Promise<string> {
    // Deterministic fake digest — tests that care about real hashes should
    // mock it per-test. Most don't.
    let h = 0;
    for (let i = 0; i < data.length; i++) h = ((h << 5) - h + data.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(64, '0');
}

export function randomUUID(): string {
    return '00000000-0000-4000-8000-' + Math.floor(Math.random() * 1e12).toString(16).padStart(12, '0');
}

export const CryptoDigestAlgorithm = {
    SHA256: 'SHA-256',
};

export default { digestStringAsync, randomUUID, CryptoDigestAlgorithm };
