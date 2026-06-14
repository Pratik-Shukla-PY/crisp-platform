/**
 * blurhash.js - Minimal vendored implementation of the BlurHash algorithm.
 *
 * BlurHash encodes a compact ~28–32-char string representing a blurred
 * colour impression of an image (4x3 DCT). Decoding produces a low-res
 * bitmap that looks like a heavy Gaussian blur of the source.
 *
 * Use in CRISP: the reporter app encodes a blurhash at photo-capture
 * time, sends it in the meta POST payload (~30 bytes), and the dashboard
 * decodes it into a placeholder rendered as the first visual feedback
 * BEFORE any media chunk has uploaded. Closes the time-to-first-visual
 * gap from "first SMALL chunk" (~2 s) to "meta POST RTT" (~200 ms).
 *
 * Why vendor it (not npm):
 *   - No external dependency graph in a classic-script PWA.
 *   - Offline-first: the SW precaches this file; no CDN fetch required.
 *   - Dashboard shares the same file verbatim - copy on deploy, symlink
 *     in dev.
 *
 * Exposes: `window.BlurHash = { encode, decode, encodeFromCanvas }`
 *
 * Spec: https://github.com/woltapp/blurhash/blob/master/Algorithm.md
 * License: MIT (original authors + this re-implementation).
 */
(function () {
  'use strict';

  // Base-83 alphabet used by the BlurHash spec. Each character encodes 0..82.
  // Order matters - do NOT sort.
  const BASE83 =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';

  function _encode83(value, length) {
    let out = '';
    for (let i = 1; i <= length; i++) {
      const digit = Math.floor(value / Math.pow(83, length - i)) % 83;
      out += BASE83[digit];
    }
    return out;
  }

  function _decode83(str) {
    let value = 0;
    for (let i = 0; i < str.length; i++) {
      const idx = BASE83.indexOf(str[i]);
      if (idx === -1) throw new Error('Invalid BlurHash character: ' + str[i]);
      value = value * 83 + idx;
    }
    return value;
  }

  // sRGB <-> linear conversion. Blurhash operates in linear RGB so colour
  // averaging is perceptually correct; the encoded bytes are sRGB 0..255.
  function _sRGBToLinear(v) {
    const f = v / 255;
    return f <= 0.04045 ? f / 12.92 : Math.pow((f + 0.055) / 1.055, 2.4);
  }

  function _linearTosRGB(v) {
    const clamped = Math.max(0, Math.min(1, v));
    const f = clamped <= 0.0031308
      ? clamped * 12.92
      : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
    return Math.round(f * 255);
  }

  function _signPow(v, exp) {
    return Math.sign(v) * Math.pow(Math.abs(v), exp);
  }

  // Encode a single DCT coefficient triple into a 2-char base-83 value.
  function _encodeAC(value, maxAC) {
    const quantR = Math.max(0, Math.min(18, Math.floor(_signPow(value[0] / maxAC, 0.5) * 9 + 9.5)));
    const quantG = Math.max(0, Math.min(18, Math.floor(_signPow(value[1] / maxAC, 0.5) * 9 + 9.5)));
    const quantB = Math.max(0, Math.min(18, Math.floor(_signPow(value[2] / maxAC, 0.5) * 9 + 9.5)));
    return quantR * 19 * 19 + quantG * 19 + quantB;
  }

  function _decodeAC(value, maxAC) {
    const quantR = Math.floor(value / (19 * 19));
    const quantG = Math.floor(value / 19) % 19;
    const quantB = value % 19;
    return [
      _signPow((quantR - 9) / 9, 2) * maxAC,
      _signPow((quantG - 9) / 9, 2) * maxAC,
      _signPow((quantB - 9) / 9, 2) * maxAC,
    ];
  }

  function _encodeDC(value) {
    const r = _linearTosRGB(value[0]);
    const g = _linearTosRGB(value[1]);
    const b = _linearTosRGB(value[2]);
    return (r << 16) + (g << 8) + b;
  }

  function _decodeDC(value) {
    return [
      _sRGBToLinear((value >> 16) & 0xff),
      _sRGBToLinear((value >> 8) & 0xff),
      _sRGBToLinear(value & 0xff),
    ];
  }

  // Build a DCT basis function factor for one (xComp, yComp) pair. Runs in
  // O(width*height) per factor; O(componentX * componentY * W * H) total.
  function _basis(width, height, xComp, yComp, pixels) {
    let r = 0, g = 0, b = 0;
    const norm = (xComp === 0 && yComp === 0) ? 1 : 2;
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
   * Encode RGBA pixels into a BlurHash string.
   * @param {Uint8ClampedArray} pixels  RGBA byte array (length = w*h*4).
   * @param {number} width
   * @param {number} height
   * @param {number} componentX  1..9 (typical: 4)
   * @param {number} componentY  1..9 (typical: 3)
   * @returns {string} BlurHash, typically ~28–32 chars at 4x3.
   */
  function encode(pixels, width, height, componentX, componentY) {
    if (componentX < 1 || componentX > 9 || componentY < 1 || componentY > 9) {
      throw new Error('BlurHash component counts must be between 1 and 9');
    }
    const factors = [];
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
    if (ac.length > 0) {
      for (const a of ac) {
        maxAC = Math.max(maxAC, Math.abs(a[0]), Math.abs(a[1]), Math.abs(a[2]));
      }
    }
    const quantMaxAC = Math.max(0, Math.min(82, Math.floor(maxAC * 166 - 0.5)));
    const realMaxAC = (quantMaxAC + 1) / 166;
    hash += _encode83(quantMaxAC, 1);
    hash += _encode83(_encodeDC(dc), 4);
    for (const a of ac) hash += _encode83(_encodeAC(a, realMaxAC), 2);
    return hash;
  }

  /**
   * Decode a BlurHash string to RGBA pixel data.
   * @param {string} hash
   * @param {number} width   output bitmap width (e.g. 32)
   * @param {number} height
   * @param {number} [punch=1]  contrast multiplier (1 = as-encoded)
   * @returns {Uint8ClampedArray}  RGBA bytes (length = w*h*4)
   */
  function decode(hash, width, height, punch) {
    if (!hash || hash.length < 6) throw new Error('BlurHash too short');
    punch = punch || 1;
    const sizeFlag = _decode83(hash[0]);
    const componentY = Math.floor(sizeFlag / 9) + 1;
    const componentX = (sizeFlag % 9) + 1;
    const quantMaxAC = _decode83(hash[1]);
    const realMaxAC = (quantMaxAC + 1) / 166;
    if (hash.length !== 4 + 2 * componentX * componentY) {
      throw new Error('BlurHash length mismatch');
    }
    const colors = [];
    colors.push(_decodeDC(_decode83(hash.substring(2, 6))));
    for (let i = 1; i < componentX * componentY; i++) {
      const start = 4 + i * 2;
      colors.push(_decodeAC(_decode83(hash.substring(start, start + 2)), realMaxAC * punch));
    }
    const pixels = new Uint8ClampedArray(width * height * 4);
    // Precompute the cosine basis for each row and column - same as encode
    // but now per-component: ~width*componentX + height*componentY multiplies.
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0, g = 0, b = 0;
        for (let j = 0; j < componentY; j++) {
          for (let i = 0; i < componentX; i++) {
            const basis = Math.cos((Math.PI * x * i) / width) *
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

  /**
   * Convenience: encode directly from an HTMLCanvasElement or OffscreenCanvas.
   * Caller is responsible for downscaling the source image to a small
   * working canvas BEFORE calling this - encoding a 4K image at full
   * resolution costs ~2 s and blocks the main thread. A 32x32 working
   * canvas is plenty for a 4x3 DCT.
   */
  function encodeFromCanvas(canvas, componentX, componentY) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas has no 2D context');
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return encode(imgData.data, canvas.width, canvas.height, componentX, componentY);
  }

  // Public API.
  const api = { encode, decode, encodeFromCanvas };

  if (typeof window !== 'undefined') {
    window.BlurHash = api;
  }
  // Also expose via CommonJS so the dashboard build (no bundler, same
  // classic-script pattern) can `require` it in tests.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
