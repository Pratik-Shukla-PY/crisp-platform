/**
 * CRISP Mobile — Client-side image variant generator.
 *
 * For every photo captured by the RN app, produce three JPEG variants on
 * the device BEFORE any network activity:
 *
 *   SMALL   max 320 px   quality 0.40   ~20–50 KB
 *   MEDIUM  max 800 px   quality 0.60   ~100–200 KB
 *   LARGE   max 1600 px  quality 0.82   ~300–800 KB
 *
 * The sync engine uploads them in SMALL → MEDIUM → LARGE order across all
 * photos (`tier-first interleaved`) so responders see a complete SMALL
 * image within seconds even on a 30 kbps link, long before LARGE finishes.
 *
 * Each variant is individually passed through the existing client PII blur
 * (`blurFacesBase64`) so every tier that leaves the device is already
 * face-redacted. The 0.85 confidence filter added in Sprint 3 keeps this
 * cheap when the photo has no faces.
 *
 * Uses `expo-image-manipulator` which is already in package.json — no new
 * native dep required.
 */
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { blurFacesBase64 } from './piiBlur';
import { encode as blurhashEncode } from './blurhash';

// jpeg-js is CommonJS, same approach as piiBlur.ts — use require so
// Metro resolves it correctly.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jpeg = require('jpeg-js') as {
  decode: (data: Uint8Array, opts: { useTArray: boolean }) => {
    width: number; height: number; data: Uint8Array;
  };
};

export type VariantTier = 'small' | 'medium' | 'large';

export interface Variant {
  base64: string;
  bytes: number;
}

export interface PhotoVariants {
  small: Variant;
  medium: Variant;
  large: Variant;
  /**
   * Phase-1 progressive-upload placeholder. Compact DCT encoding (~28–32 chars)
   * threaded through submitReport() into the meta POST payload. Dashboard
   * decodes it for an instant time-to-first-visual placeholder, BEFORE any
   * media chunk lands. `null` on any encode failure — never breaks upload.
   */
  blurhash: string | null;
}

// Tier → backend ResolutionEnum. Kept in one place so callers never hard-code.
// Phase L (May 2026): backend ResolutionEnum was tightened to exactly
// SMALL/MEDIUM/ORIGINAL; LOW + HIGH were dropped from the Postgres enum in
// alembic 0036. Pre-Phase-L this map emitted LOW/HIGH and the backend now
// 422s those payloads — the entire RN upload pipeline was broken until the
// rename. The internal RN tier names stay 'small'/'medium'/'large' for
// historical reasons; only the WIRE name changes.
export const TIER_TO_RESOLUTION: Record<VariantTier, 'SMALL' | 'MEDIUM' | 'ORIGINAL'> = {
  small: 'SMALL',
  medium: 'MEDIUM',
  large: 'ORIGINAL',
};

// Apr 2026: LARGE is now a passthrough tier — no resize, no re-encode. The
// raw captured bytes (after PII blur) ship directly so responders get
// archival-quality source material. SMALL/MEDIUM stay downscaled for fast
// progressive delivery on narrow pipes.
const TIER_SPEC: Array<{ tier: VariantTier; maxDim?: number; quality?: number; passthrough?: boolean }> = [
  { tier: 'small',  maxDim: 320,  quality: 0.40 },
  { tier: 'medium', maxDim: 800,  quality: 0.60 },
  { tier: 'large',  passthrough: true },
];

/**
 * Generate all three variants + run PII blur ONCE on the original.
 *
 * Phase 1 (Apr 2026): blur-once-then-resize.
 *  - OLD pipeline called blurFacesBase64 per tier → BlazeFace ran 3× on
 *    three separately-decoded images and the SMALL detection often missed
 *    small faces that LARGE caught. Redaction was inconsistent across
 *    variants.
 *  - NEW pipeline runs blurFacesBase64 ONCE on the raw capture, writes the
 *    blurred base64 back to a temp file, then expo-image-manipulator resizes
 *    that single blurred source to all three tiers. Detection runs 1× and
 *    every variant shares the same redaction.
 *
 * On failure of any tier, fall back to the raw base64 for that tier so
 * the sync engine always gets three fields — the partial-delivery
 * guarantee relies on the SMALL variant always existing.
 *
 * @param rawUri The file:// URI of the original captured image. Required —
 *   expo-image-manipulator operates on URIs, not base64.
 * @param rawBase64 The raw base64 payload (used for the single blur pass
 *   and as fallback if resize fails).
 */
export async function generateVariants(rawUri: string, rawBase64: string): Promise<PhotoVariants> {
  // Step 1 — blur ONCE on the original base64. blurFacesBase64 returns
  // the input unchanged when no confident faces are detected, so this is
  // cheap on typical infrastructure-damage photos.
  let blurredB64 = rawBase64;
  try {
    blurredB64 = await blurFacesBase64(rawBase64);
  } catch (e) {
    console.warn('[imageVariants] PII blur skipped on source:', (e as Error)?.message || e);
  }

  // Step 2 — if blur produced a new base64 (faces were found and
  // redacted), write it to a temp file so expo-image-manipulator can
  // resize from URI. If nothing was blurred, reuse the original URI.
  let sourceUri = rawUri;
  if (blurredB64 !== rawBase64) {
    try {
      const FileSystem: any = require('expo-file-system');
      const tmpUri = `${FileSystem.cacheDirectory}crisp_blurred_${Date.now()}.jpg`;
      await FileSystem.writeAsStringAsync(tmpUri, blurredB64, {
        encoding: FileSystem.EncodingType?.Base64 ?? 'base64',
      });
      sourceUri = tmpUri;
    } catch (e) {
      console.warn('[imageVariants] temp-file write failed, resizing from original URI:', (e as Error)?.message || e);
      // sourceUri stays as rawUri — server-side blur is the safety net.
    }
  }

  // Step 3 — resize the (blurred or original) source to all three tiers.
  // No per-tier blur call; redaction was applied once in step 1.
  const out: Partial<PhotoVariants> = {};
  const fallback: Variant = { base64: blurredB64, bytes: blurredB64.length };

  for (const spec of TIER_SPEC) {
    // LARGE (passthrough) ships the blurred source bytes as-is. No
    // expo-image-manipulator call means no resize, no JPEG re-encode,
    // no quality loss — archival-quality copy for responders.
    if (spec.passthrough) {
      out[spec.tier] = fallback;
      continue;
    }
    try {
      const resized = await manipulateAsync(
        sourceUri,
        [{ resize: { width: spec.maxDim! } }],
        { base64: true, compress: spec.quality, format: SaveFormat.JPEG }
      );
      const b64 = resized.base64;
      if (!b64) {
        out[spec.tier] = fallback;
        continue;
      }
      out[spec.tier] = { base64: b64, bytes: b64.length };
    } catch (e) {
      console.warn(`[imageVariants] ${spec.tier} resize failed, using blurred source:`, (e as Error)?.message || e);
      out[spec.tier] = fallback;
    }
  }

  // Step 4 — blurhash placeholder (Phase-1 progressive-upload).
  //
  // Decode a 32x32 downscale via expo-image-manipulator → jpeg-js → encode
  // via the vendored TS blurhash. Best-effort: any failure falls through
  // with `blurhash=null` and never breaks upload.
  //
  // We don't reuse the 320-px SMALL variant because blurhash encode at that
  // size costs ~100 ms on low-end devices (O(w*h*numX*numY)). Downscaling
  // to 32x32 first takes ~10 ms via native image-manipulator and makes the
  // blurhash encode ~5 ms total — inside the already-deferred
  // _runAfterInteractions wrapper so the UI stays responsive.
  let blurhash: string | null = null;
  try {
    const bhSrc = await manipulateAsync(
      sourceUri,
      [{ resize: { width: 32 } }],
      { base64: true, compress: 0.4, format: SaveFormat.JPEG },
    );
    if (bhSrc.base64) {
      // Base64 → Uint8Array. We avoid Buffer here to stay portable across
      // RN runtimes (Hermes has a partial Buffer polyfill but it's safer
      // to go through atob).
      const binStr =
        typeof atob === 'function'
          ? atob(bhSrc.base64)
          : Buffer.from(bhSrc.base64, 'base64').toString('binary');
      const bytes = new Uint8Array(binStr.length);
      for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
      const decoded = jpeg.decode(bytes, { useTArray: true });
      blurhash = blurhashEncode(decoded.data, decoded.width, decoded.height, 4, 3);
    }
  } catch (e) {
    console.warn('[imageVariants] blurhash encode skipped:', (e as Error)?.message || e);
  }

  const final = { ...(out as Omit<PhotoVariants, 'blurhash'>), blurhash } as PhotoVariants;
  console.log(
    `[imageVariants] small=${Math.round(final.small.bytes / 1024)} KB, ` +
    `medium=${Math.round(final.medium.bytes / 1024)} KB, ` +
    `large=${Math.round(final.large.bytes / 1024)} KB` +
    (blurhash ? `; blurhash=${blurhash.slice(0, 8)}…(${blurhash.length} chars)` : '; blurhash=skipped')
  );
  return final;
}
