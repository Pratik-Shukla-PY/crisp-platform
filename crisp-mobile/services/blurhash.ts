/**
 * blurhash.ts — RN port of the vendored BlurHash algorithm.
 *
 * Keep this file in byte-equivalent behaviour to `mobile-app/src/blurhash.js`
 * (the PWA vendor). Same algorithm, same output hashes for the same inputs.
 *
 * See the JS vendor's docstring for the UX rationale (time-to-first-visual
 * reduction from ~2 s to ~200 ms via meta-POST placeholder).
 *
 * RN specifics:
 *   - No canvas/DOM. Callers decode a source JPEG via `jpeg-js` (already a
 *     dependency through services/piiBlur.ts) and pass the resulting RGBA
 *     Uint8Array/Uint8ClampedArray to `encode`.
 *   - Decoding is unused here — the RN app never decodes blurhashes for
 *     display (the dashboard does that). Export the decoder anyway for
 *     symmetry + future use (e.g. device-local preview of queued reports).
 *
 * Spec: https://github.com/woltapp/blurhash/blob/master/Algorithm.md
 * License: MIT.
 */

const BASE83 =
  '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

function _encode83(value: number, length: number): string {
  let out = '';
  for (let i = 1; i <= length; i++) {
    const digit = Math.floor(value / Math.pow(83, length - i)) % 83;
    out += BASE83[digit];
  }
  return out;
}

function _decode83(str: string): number {
  let value = 0;
  for (let i = 0; i < str.length; i++) {
    const idx = BASE83.indexOf(str[i]);
    if (idx === -1) throw new Error('Invalid BlurHash character: ' + str[i]);
    value = value * 83 + idx;
  }
  return value;
}

function _sRGBToLinear(v: number): number {
  const f = v / 255;
  return f <= 0.04045 ? f / 12.92 : Math.pow((f + 0.055) / 1.055, 2.4);
}

function _linearTosRGB(v: number): number {
  const clamped = Math.max(0, Math.min(1, v));
  const f =
    clamped <= 0.0031308
      ? clamped * 12.92
      : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(f * 255);
}

function _signPow(v: number, exp: number): number {
  return Math.sign(v) * Math.pow(Math.abs(v), exp);
}

function _encodeAC(value: [number, number, number], maxAC: number): number {
  const quantR = Math.max(0, Math.min(18, Math.floor(_signPow(value[0] / maxAC, 0.5) * 9 + 9.5)));
  const quantG = Math.max(0, Math.min(18, Math.floor(_signPow(value[1] / maxAC, 0.5) * 9 + 9.5)));
  const quantB = Math.max(0, Math.min(18, Math.floor(_signPow(value[2] / maxAC, 0.5) * 9 + 9.5)));
  return quantR * 19 * 19 + quantG * 19 + quantB;
}

function _decodeAC(value: number, maxAC: number): [number, number, number] {
  const quantR = Math.floor(value / (19 * 19));
  const quantG = Math.floor(value / 19) % 19;
  const quantB = value % 19;
  return [
    _signPow((quantR - 9) / 9, 2) * maxAC,
    _signPow((quantG - 9) / 9, 2) * maxAC,
    _signPow((quantB - 9) / 9, 2) * maxAC,
  ];
}

function _encodeDC(value: [number, number, number]): number {
  const r = _linearTosRGB(value[0]);
  const g = _linearTosRGB(value[1]);
  const b = _linearTosRGB(value[2]);
  return (r << 16) + (g << 8) + b;
}

function _decodeDC(value: number): [number, number, number] {
  return [
    _sRGBToLinear((value >> 16) & 0xff),
    _sRGBToLinear((value >> 8) & 0xff),
    _sRGBToLinear(value & 0xff),
  ];
}

function _basis(
  width: number,
  height: number,
  xComp: number,
  yComp: number,
  pixels: Uint8Array | Uint8ClampedArray,
): [number, number, number] {
  let r = 0, g = 0, b = 0;
  const norm = xComp === 0 && yComp === 0 ? 1 : 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const basis =
        Math.cos((Math.PI * xComp * x) / width) *
        Math.cos((Math.PI * yComp * y) / height);
      const p = (y * width + x) * 4;
      r += basis * _sRGBToLinear(pixels[p]);
      g += basis * _sRGBToLinear(pixels[p + 1]);
      b += basis * _sRGBToLinear(pixels[p + 2]);
    }
  }
  const scale = norm / (width * height);
  return [r * scale, g * scale, b * scale];
}

/**
 * Encode RGBA pixels into a compact BlurHash string.
 * Target resolution for input: 32x32 is plenty; larger just costs CPU
 * with negligible quality gain at a 4x3 DCT.
 */
export function encode(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  componentX = 4,
  componentY = 3,
): string {
  if (componentX < 1 || componentX > 9 || componentY < 1 || componentY > 9) {
    throw new Error('BlurHash component counts must be between 1 and 9');
  }
  const factors: Array<[number, number, number]> = [];
  for (let y = 0; y < componentY; y++) {
    for (let x = 0; x < componentX; x++) {
      factors.push(_basis(width, height, x, y, pixels));
    }
  }
  const dc = factors[0];
  const ac = factors.slice(1);
  const sizeFlag = (componentX - 1) + (componentY - 1) * 9;
  let hash = _encode83(sizeFlag, 1);
  let maxAC = 0;
  for (const a of ac) {
    maxAC = Math.max(maxAC, Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2]));
  }
  const quantMaxAC = Math.max(0, Math.min(82, Math.floor(maxAC * 166 - 0.5)));
  const realMaxAC = (quantMaxAC + 1) / 166;
  hash += _encode83(quantMaxAC, 1);
  hash += _encode83(_encodeDC(dc), 4);
  for (const a of ac) hash += _encode83(_encodeAC(a, realMaxAC), 2);
  return hash;
}

export function decode(
  hash: string,
  width: number,
  height: number,
  punch = 1,
): Uint8ClampedArray {
  if (!hash || hash.length < 6) throw new Error('BlurHash too short');
  const sizeFlag = _decode83(hash[0]);
  const componentY = Math.floor(sizeFlag / 9) + 1;
  const componentX = (sizeFlag % 9) + 1;
  const quantMaxAC = _decode83(hash[1]);
  const realMaxAC = (quantMaxAC + 1) / 166;
  if (hash.length !== 4 + 2 * componentX * componentY) {
    throw new Error('BlurHash length mismatch');
  }
  const colors: Array<[number, number, number]> = [];
  colors.push(_decodeDC(_decode83(hash.substring(2, 6))));
  for (let i = 1; i < componentX * componentY; i++) {
    const start = 4 + i * 2;
    colors.push(_decodeAC(_decode83(hash.substring(start, start + 2)), realMaxAC * punch));
  }
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < componentY; j++) {
        for (let i = 0; i < componentX; i++) {
          const basis =
            Math.cos((Math.PI * x * i) / width) *
            Math.cos((Math.PI * y * j) / height);
          const c = colors[i + j * componentX];
          r += c[0] * basis;
          g += c[1] * basis;
          b += c[2] * basis;
        }
      }
      const p = (y * width + x) * 4;
      pixels[p] = _linearTosRGB(r);
      pixels[p + 1] = _linearTosRGB(g);
      pixels[p + 2] = _linearTosRGB(b);
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}
