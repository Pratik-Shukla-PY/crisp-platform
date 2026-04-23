/**
 * blurhash.ts — encoder/decoder round-trip + algorithm-correctness unit tests.
 *
 * Locks in invariants:
 *  (a) A uniform red image → a decodable hash whose decoded centre pixel is
 *      visually "red" (R > 150, G < 80, B < 80). Proves DCT + sRGB↔linear
 *      round-tripping isn't silently byte-corrupted.
 *  (b) Hash string is ASCII + conforms to the BlurHash length formula
 *      (4 + 2 * componentX * componentY).
 *  (c) Decoder rejects obviously-broken inputs (too short, bad component
 *      header) with the documented error message prefix.
 *
 * These are pure-function tests — no Expo runtime, no jest-expo preset
 * needed. Runs under plain `jest` if jest-expo is unavailable.
 */
import { encode, decode } from '../services/blurhash';

/** Generate a uniform-colour 32×32 RGBA buffer. */
function solidRGBA(r: number, g: number, b: number): Uint8Array {
    const W = 32, H = 32;
    const out = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
        out[i * 4 + 0] = r;
        out[i * 4 + 1] = g;
        out[i * 4 + 2] = b;
        out[i * 4 + 3] = 255;
    }
    return out;
}

describe('blurhash.encode', () => {
    test('uniform red image → valid ASCII hash of expected length', () => {
        const pixels = solidRGBA(220, 40, 40);
        const hash = encode(pixels, 32, 32, 4, 3);

        // Expected length = 4 + 2*4*3 = 28.
        expect(hash).toHaveLength(28);
        // Every char must be in the BASE83 alphabet — ASCII + punctuation,
        // no whitespace or high-Unicode.
        expect(hash).toMatch(/^[0-9A-Za-z#$%*+,\-.:;=?@\[\]^_{|}~]+$/);
    });

    test('rejects out-of-range component counts', () => {
        const pixels = solidRGBA(0, 0, 0);
        // componentX must be 1..9.
        expect(() => encode(pixels, 32, 32, 0, 3)).toThrow(/component/i);
        expect(() => encode(pixels, 32, 32, 4, 10)).toThrow(/component/i);
    });
});

describe('blurhash round-trip', () => {
    test('encode(red) → decode → centre pixel is clearly red', () => {
        const src = solidRGBA(230, 30, 30);
        const hash = encode(src, 32, 32, 4, 3);
        const decoded = decode(hash, 16, 16);

        // Sample the centre pixel.
        const px = (8 * 16 + 8) * 4;
        const r = decoded[px];
        const g = decoded[px + 1];
        const b = decoded[px + 2];

        expect(r).toBeGreaterThan(150);
        expect(g).toBeLessThan(80);
        expect(b).toBeLessThan(80);
    });

    test('encode(blue) → decode → centre pixel is clearly blue', () => {
        const src = solidRGBA(20, 40, 220);
        const hash = encode(src, 32, 32, 4, 3);
        const decoded = decode(hash, 16, 16);

        const px = (8 * 16 + 8) * 4;
        expect(decoded[px + 2]).toBeGreaterThan(150); // B
        expect(decoded[px + 0]).toBeLessThan(80);     // R
        expect(decoded[px + 1]).toBeLessThan(100);    // G
    });
});

describe('blurhash.decode — error handling', () => {
    test('rejects hash shorter than 6 chars', () => {
        expect(() => decode('abc', 8, 8)).toThrow(/too short/i);
    });

    test('rejects hash with wrong length for its component header', () => {
        // Build a fake 4x3 hash (expected length 28) but pass 10 chars —
        // triggers the explicit length-mismatch branch.
        const bogus = 'LEHV6nWB2yk8'; // 12 chars — header says 4x3 components
        expect(() => decode(bogus, 8, 8)).toThrow(/length mismatch/i);
    });
});
