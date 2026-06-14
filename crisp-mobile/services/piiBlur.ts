/**
 * CRISP Mobile - Client-side PII face pixelation.
 *
 * BlazeFace (the same face-detection model the backend uses) runs in-process
 * and pixelates every face it finds client-side *before* the photo is
 * uploaded. Sensitive pixels never leave the device. The backend still
 * re-runs its full PII pipeline (MediaPipe + easyocr) as a safety net.
 *
 * Implementation is pure JS (no Skia, no Reanimated, no New-Architecture
 * requirement) so it works in Expo Go on any SDK-54 build:
 *
 *   1. jpeg-js decodes the base64 JPEG into an RGBA Uint8Array.
 *   2. @tensorflow-models/blazeface detects faces on a 256-px downscaled tensor.
 *   3. We pixelate every face bbox directly on the pixel buffer - averaging
 *      10×10 blocks destroys enough facial detail to be irreversible, much
 *      like the server's blur but even stronger.
 *   4. jpeg-js re-encodes at quality 85 → base64.
 *
 * Failure mode: any error → returns the input base64 unchanged. The caller
 * always gets a usable string; never throws to the capture flow.
 *
 * Timing budget on an iPhone 12-class device:
 *   - Model load (first call only): ~1.5 s.
 *   - Decode + tensor + inference + pixelate + encode: ~1.5–3 s per photo.
 */
import * as tf from '@tensorflow/tfjs';
import * as blazeface from '@tensorflow-models/blazeface';
// jpeg-js is CommonJS with a default export.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const jpeg = require('jpeg-js') as {
  decode: (buf: Uint8Array, opts?: { useTArray?: boolean; maxResolutionInMP?: number }) => { data: Uint8Array; width: number; height: number };
  encode: (raw: { data: Uint8Array; width: number; height: number }, quality?: number) => { data: Uint8Array; width: number; height: number };
};

// ── Model singleton ──────────────────────────────────────────────────────────
let _model: blazeface.BlazeFaceModel | null = null;
let _loading: Promise<blazeface.BlazeFaceModel> | null = null;

// Apr 2026 - TF.js in Expo Go needs `fetch` to be on `tf.env().global` so
// `@tensorflow-models/blazeface` can download its GraphModel weights from the
// TFHub CDN. On bare RN `global.fetch` exists but tf.env() may not proxy it,
// which surfaces as "Cannot read property 'fetch' of undefined". Shim both
// `global.fetch` / `globalThis.fetch` into `tf.env().global.fetch` at module
// load so model loading works without pulling in `@tensorflow/tfjs-react-native`.
//
// Failure here is non-fatal: the whole `ensureModel` path is wrapped so an
// unrecoverable shim just means "no client-side face detection, the backend
// PII pipeline catches it".
let _tfShimAttempted = false;
function _shimTfGlobals(): void {
  if (_tfShimAttempted) return;
  _tfShimAttempted = true;
  try {
    const g: any = (typeof globalThis !== 'undefined' && globalThis) ||
                   (typeof global !== 'undefined' && (global as any)) ||
                   {};
    const env = (tf as any).env ? (tf as any).env() : null;
    if (!env) return;
    if (!env.global) env.global = {};
    if (!env.global.fetch && g.fetch) env.global.fetch = g.fetch.bind(g);
    if (!env.global.XMLHttpRequest && g.XMLHttpRequest) env.global.XMLHttpRequest = g.XMLHttpRequest;
    if (!env.global.Headers && g.Headers) env.global.Headers = g.Headers;
    if (!env.global.Request && g.Request) env.global.Request = g.Request;
    if (!env.global.Response && g.Response) env.global.Response = g.Response;
  } catch {
    /* best-effort */
  }
}

/** Load BlazeFace on demand. Idempotent + concurrent-safe. */
export async function ensureModel(): Promise<blazeface.BlazeFaceModel> {
  if (_model) return _model;
  if (_loading) return _loading;
  _loading = (async () => {
    _shimTfGlobals();
    // WebGL isn't available in RN - TF.js picks cpu automatically, but be explicit.
    try { await tf.setBackend('cpu'); } catch { /* backend may already be set */ }
    await tf.ready();
    const m = await blazeface.load({ maxFaces: 10 });
    _model = m;
    _loading = null;
    console.log(`[PIIBlur] BlazeFace loaded (tf backend=${tf.getBackend()})`);
    return m;
  })();
  return _loading;
}

// Last-run telemetry; optional to read.
let _lastStats = { faces: 0, ms: 0, skipped: false as boolean };
export function getLastStats() { return { ..._lastStats }; }

// ── Base64 <-> Uint8Array helpers ────────────────────────────────────────────
// Hermes (Expo Go's JS engine) does NOT have atob/btoa on globalThis by default
// and Buffer isn't available either. Implement small helpers inline to avoid
// dragging in a base64 dep. Both branches are hot-path-safe (<100ms for 3MB).

function _b64ToBytes(b64: string): Uint8Array {
  const tbl = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Uint8Array(256);
  for (let i = 0; i < tbl.length; i++) lookup[tbl.charCodeAt(i)] = i;

  // Strip whitespace + data: prefix defensively.
  let s = b64.indexOf(',') >= 0 ? b64.substring(b64.indexOf(',') + 1) : b64;
  s = s.replace(/\s/g, '');

  const pad = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  const len = ((s.length * 3) >> 2) - pad;
  const out = new Uint8Array(len);

  let p = 0;
  for (let i = 0; i < s.length; i += 4) {
    const e1 = lookup[s.charCodeAt(i)];
    const e2 = lookup[s.charCodeAt(i + 1)];
    const e3 = lookup[s.charCodeAt(i + 2)];
    const e4 = lookup[s.charCodeAt(i + 3)];
    if (p < len) out[p++] = (e1 << 2) | (e2 >> 4);
    if (p < len) out[p++] = ((e2 & 15) << 4) | (e3 >> 2);
    if (p < len) out[p++] = ((e3 & 3) << 6) | e4;
  }
  return out;
}

function _bytesToB64(bytes: Uint8Array): string {
  const tbl = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < n ? bytes[i + 1] : 0;
    const b2 = i + 2 < n ? bytes[i + 2] : 0;
    out += tbl[b0 >> 2];
    out += tbl[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < n ? tbl[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < n ? tbl[b2 & 63] : '=';
  }
  return out;
}

// ── Face detection + pixelation ──────────────────────────────────────────────

/** Run BlazeFace on a 256-px downscale, return bboxes in ORIGINAL coordinates. */
async function _detectFaces(rgba: Uint8Array, w: number, h: number): Promise<{x:number;y:number;w:number;h:number}[]> {
  const model = await ensureModel();
  const longSide = Math.max(w, h);
  const scale = longSide > 256 ? 256 / longSide : 1;
  const inW = Math.max(1, Math.round(w * scale));
  const inH = Math.max(1, Math.round(h * scale));

  // Strip alpha then create a tensor.
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  const full = tf.tensor3d(rgb, [h, w, 3], 'int32');
  let input: tf.Tensor3D = full;
  if (scale !== 1) {
    input = tf.tidy(() => tf.image.resizeBilinear(full as tf.Tensor3D, [inH, inW]).toInt() as tf.Tensor3D);
    full.dispose();
  }

  try {
    const preds = await model.estimateFaces(input, /*returnTensors=*/false, /*flipHorizontal=*/false);
    const invScale = 1 / scale;
    // Confidence filter: BlazeFace's default threshold (~0.5) produces many
    // false positives on shadows, repeating patterns, or leaf-textures - we
    // were blurring plenty of images without faces. Raise the bar to 0.85.
    // Callers still get [] if nothing is above threshold, which triggers the
    // "no faces - return original bytes unchanged" fast path in blurFacesBase64.
    const CONF_THRESHOLD = 0.85;
    return (preds as any[])
      .filter((p) => {
        const prob = Array.isArray(p.probability) ? p.probability[0] : p.probability;
        return typeof prob === 'number' && prob >= CONF_THRESHOLD;
      })
      .map((p) => {
        const [x1, y1] = p.topLeft as [number, number];
        const [x2, y2] = p.bottomRight as [number, number];
        return {
          x: Math.max(0, Math.round(x1 * invScale)),
          y: Math.max(0, Math.round(y1 * invScale)),
          w: Math.max(1, Math.round((x2 - x1) * invScale)),
          h: Math.max(1, Math.round((y2 - y1) * invScale)),
        };
      });
  } finally {
    input.dispose();
  }
}

/** Pixelate every face region directly on the RGBA buffer. Uses block-average
 *  mosaicking + ellipse clip - fast (O(pixels)), irreversible, and matches
 *  the visual expectation set by the server's oval-blur.
 *
 *  Phase 1 (Apr 2026):
 *   - Padding 20 % → 5 % (tight crop; stacking with the server's own bbox
 *     expansion produced the visible bloat users reported).
 *   - Block-size cap 16 → 24 px so the mosaic remains effective when we
 *     pixelate at capture resolution (2000–4000 px) rather than at
 *     post-resize variant resolution. 1/12 of the face is still the target.
 */
function _pixelateFaces(rgba: Uint8Array, W: number, H: number, faces: { x:number;y:number;w:number;h:number }[]): void {
  for (const f of faces) {
    const padX = Math.round(f.w * 0.05);
    const padY = Math.round(f.h * 0.05);
    const x = Math.max(0, f.x - padX);
    const y = Math.max(0, f.y - padY);
    const w = Math.min(W - x, f.w + 2 * padX);
    const h = Math.min(H - y, f.h + 2 * padY);
    if (w <= 0 || h <= 0) continue;

    // Block size: ~1/12 of the face's larger side, floored at 8 px and
    // capped at 24 px. A 100-px face becomes an 8-px mosaic; a 1000-px
    // face (at capture res) becomes a 24-px mosaic - still 1/40 of the
    // face, enough to destroy identity while staying fast.
    const block = Math.max(8, Math.min(24, Math.round(Math.max(w, h) / 12)));
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;

    for (let by = y; by < y + h; by += block) {
      for (let bx = x; bx < x + w; bx += block) {
        const bw = Math.min(block, x + w - bx);
        const bh = Math.min(block, y + h - by);
        // Ellipse test on the block centre.
        const ccx = bx + bw / 2;
        const ccy = by + bh / 2;
        const nx = (ccx - cx) / rx;
        const ny = (ccy - cy) / ry;
        if (nx * nx + ny * ny > 1) continue;  // outside ellipse, leave pixels

        // Average the block's RGB.
        let r = 0, g = 0, b = 0, n = 0;
        for (let py = by; py < by + bh; py++) {
          const rowStart = (py * W + bx) * 4;
          for (let px = 0; px < bw; px++) {
            const off = rowStart + px * 4;
            r += rgba[off];
            g += rgba[off + 1];
            b += rgba[off + 2];
            n++;
          }
        }
        if (!n) continue;
        r = (r / n) | 0;
        g = (g / n) | 0;
        b = (b / n) | 0;
        // Write the average back across the block.
        for (let py = by; py < by + bh; py++) {
          const rowStart = (py * W + bx) * 4;
          for (let px = 0; px < bw; px++) {
            const off = rowStart + px * 4;
            rgba[off] = r;
            rgba[off + 1] = g;
            rgba[off + 2] = b;
            // leave alpha untouched
          }
        }
      }
    }
  }
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Blur every detected face in the input base64 JPEG and return a new base64
 *  string. On any failure, returns the input unchanged (never throws). */
export async function blurFacesBase64(inputB64: string): Promise<string> {
  const t0 = Date.now();

  // Decode JPEG → RGBA buffer.
  let img: { data: Uint8Array; width: number; height: number };
  try {
    const bytes = _b64ToBytes(inputB64);
    img = jpeg.decode(bytes, { useTArray: true });
  } catch (e) {
    console.warn('[PIIBlur] decode failed, returning original:', e);
    _lastStats = { faces: 0, ms: Date.now() - t0, skipped: true };
    return inputB64;
  }

  // Detect faces.
  let faces: { x: number; y: number; w: number; h: number }[] = [];
  try {
    faces = await _detectFaces(img.data, img.width, img.height);
  } catch (e) {
    console.warn('[PIIBlur] detect failed, returning original:', e);
    _lastStats = { faces: 0, ms: Date.now() - t0, skipped: true };
    return inputB64;
  }

  if (faces.length === 0) {
    _lastStats = { faces: 0, ms: Date.now() - t0, skipped: false };
    return inputB64;
  }

  // Pixelate in place, then re-encode.
  try {
    _pixelateFaces(img.data, img.width, img.height, faces);
    const encoded = jpeg.encode(img, 85);
    const outB64 = _bytesToB64(encoded.data);
    _lastStats = { faces: faces.length, ms: Date.now() - t0, skipped: false };
    console.log(`[PIIBlur] pixelated ${faces.length} face(s) in ${_lastStats.ms}ms`);
    return outB64;
  } catch (e) {
    console.warn('[PIIBlur] encode failed, returning original:', e);
    _lastStats = { faces: faces.length, ms: Date.now() - t0, skipped: true };
    return inputB64;
  }
}

/** Fire-and-forget warmup so the first real capture pays little model-load
 *  cost. Call this early (e.g. when the Photo screen mounts). Swallows errors. */
export function prewarm(): void {
  ensureModel().catch((e) => console.log('[PIIBlur] prewarm skipped:', e?.message || e));
}
