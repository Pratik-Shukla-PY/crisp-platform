/**
 * CRISP — Minimal EXIF GPS inserter for JPEGs (Sprint D, May 2026)
 * ─────────────────────────────────────────────────────────────────
 *
 * Why we wrote our own instead of vendoring piexifjs:
 *
 *   - piexifjs is ~24 KB minified and ships features we don't need
 *     (reading EXIF, parsing all IFDs, base64 in/out, etc.). We only
 *     need to WRITE the GPS IFD into a JPEG that has no EXIF yet
 *     (output of `canvas.toBlob`, which is the only path the upload
 *     pipeline sees after PII-blur runs).
 *   - Hand-rolling lets us bound exactly what fields we embed:
 *     ONLY the GPS IFD, never the 0th IFD (camera Make/Model/Software),
 *     never any free-text PII field (UserComment / Artist / Copyright).
 *     This matches the strict GPS-IFD-only safety rule from the plan.
 *   - Auditability — every byte is inspectable in this one file.
 *
 * What's embedded (subset of EXIF GPSInfo IFD, 7-9 fields):
 *
 *   GPSVersionID            (0x0000) — [2,3,0,0]
 *   GPSLatitudeRef          (0x0001) — "N" | "S"
 *   GPSLatitude             (0x0002) — DMS rational triple
 *   GPSLongitudeRef         (0x0003) — "E" | "W"
 *   GPSLongitude            (0x0004) — DMS rational triple
 *   GPSTimeStamp            (0x0007) — UTC HH/MM/SS rational triple
 *   GPSDateStamp            (0x001D) — "YYYY:MM:DD"
 *   GPSImgDirection         (0x0011) — heading * 100 / 100  (optional)
 *   GPSImgDirectionRef      (0x0010) — "T" (true north)     (optional)
 *   GPSHPositioningError    (0x001F) — accuracy m * 100 / 100 (optional)
 *
 * All multi-byte values are big-endian (TIFF "MM" byte order).
 *
 * Exposed surface:
 *
 *   window.CrispExifGps.embed(jpegBlob, locationState) -> Promise<Blob>
 *
 *   locationState = {
 *     lat:           Number,   // required, decimal degrees ±
 *     lng:           Number,   // required, decimal degrees ±
 *     accuracyMeters: Number,  // optional, GPSHPositioningError
 *     heading:       Number,   // optional, degrees CW from true north
 *   }
 *
 * If GPS state is missing or invalid the function resolves with the
 * ORIGINAL blob (additive, never destructive — the JSON payload still
 * carries the geotag).
 */
(function (root) {
    'use strict';

    // ───── Byte-write helpers ──────────────────────────────────────
    function writeU16BE(view, off, value) {
        view.setUint16(off, value & 0xFFFF, false);  // BE
        return off + 2;
    }
    function writeU32BE(view, off, value) {
        view.setUint32(off, value >>> 0, false);
        return off + 4;
    }
    function writeBytes(view, off, bytes) {
        for (let i = 0; i < bytes.length; i++) view.setUint8(off + i, bytes[i]);
        return off + bytes.length;
    }
    function writeAsciiNul(view, off, str, totalLen) {
        // Writes `str` (ASCII) and pads with NUL bytes up to `totalLen`.
        for (let i = 0; i < totalLen; i++) {
            view.setUint8(off + i, i < str.length ? str.charCodeAt(i) : 0);
        }
        return off + totalLen;
    }

    // Decimal degrees → DMS rational triple. Each pair is [numerator, denominator].
    // Format: deg as int, min as int, sec * 10000 as int (for 4-decimal-place precision).
    function degToDmsRationals(deg) {
        const absDeg = Math.abs(deg);
        const d = Math.floor(absDeg);
        const minFull = (absDeg - d) * 60;
        const m = Math.floor(minFull);
        const s = (minFull - m) * 60;
        return [
            [d, 1],
            [m, 1],
            [Math.round(s * 10000), 10000],
        ];
    }

    // EXIF TIFF type codes used here:
    //   1  = BYTE      (1 byte each)
    //   2  = ASCII     (1 byte each, NUL-terminated)
    //   3  = SHORT     (2 bytes each)
    //   4  = LONG      (4 bytes each)
    //   5  = RATIONAL  (8 bytes each: u32 numerator + u32 denominator)
    const T_BYTE = 1, T_ASCII = 2, T_SHORT = 3, T_LONG = 4, T_RATIONAL = 5;

    // Each EXIF IFD entry is 12 bytes: tag (u16) + type (u16) + count (u32)
    // + value-or-offset (u32). If the value fits in 4 bytes it's inline;
    // otherwise the u32 is an offset (from TIFF start) into the EXIF block
    // pointing at the actual value bytes.
    function buildExifApp1(loc) {
        // Build the GPS IFD entry list.
        const entries = [];
        // 1. GPSVersionID — BYTE, count 4, inline [2,3,0,0]
        entries.push({
            tag: 0x0000, type: T_BYTE, count: 4,
            data: new Uint8Array([2, 3, 0, 0]),
        });
        // 2. GPSLatitudeRef — ASCII "N\0" or "S\0", count 2
        entries.push({
            tag: 0x0001, type: T_ASCII, count: 2,
            data: new Uint8Array([(loc.lat >= 0 ? 0x4E : 0x53), 0x00]),
        });
        // 3. GPSLatitude — RATIONAL × 3 (24 bytes, OUT-OF-LINE)
        entries.push({
            tag: 0x0002, type: T_RATIONAL, count: 3,
            data: rationalsToBytes(degToDmsRationals(loc.lat)),
        });
        // 4. GPSLongitudeRef — ASCII "E\0" or "W\0"
        entries.push({
            tag: 0x0003, type: T_ASCII, count: 2,
            data: new Uint8Array([(loc.lng >= 0 ? 0x45 : 0x57), 0x00]),
        });
        // 5. GPSLongitude — RATIONAL × 3
        entries.push({
            tag: 0x0004, type: T_RATIONAL, count: 3,
            data: rationalsToBytes(degToDmsRationals(loc.lng)),
        });
        // 6. GPSTimeStamp — UTC H/M/S, RATIONAL × 3
        const now = new Date();
        entries.push({
            tag: 0x0007, type: T_RATIONAL, count: 3,
            data: rationalsToBytes([
                [now.getUTCHours(),   1],
                [now.getUTCMinutes(), 1],
                [now.getUTCSeconds(), 1],
            ]),
        });
        // 7. GPSDateStamp — ASCII "YYYY:MM:DD\0", count 11
        const dateStr =
            now.getUTCFullYear() + ':' +
            String(now.getUTCMonth() + 1).padStart(2, '0') + ':' +
            String(now.getUTCDate()).padStart(2, '0');
        entries.push({
            tag: 0x001D, type: T_ASCII, count: 11,
            data: asciiBytes(dateStr, 11),
        });
        // 8. GPSImgDirectionRef + GPSImgDirection — heading (optional).
        if (typeof loc.heading === 'number' && isFinite(loc.heading)) {
            entries.push({
                tag: 0x0010, type: T_ASCII, count: 2,
                data: new Uint8Array([0x54, 0x00]),  // "T" = True north
            });
            entries.push({
                tag: 0x0011, type: T_RATIONAL, count: 1,
                data: rationalsToBytes([
                    [Math.round(loc.heading * 100), 100],
                ]),
            });
        }
        // 9. GPSHPositioningError — accuracy m, RATIONAL (optional).
        if (typeof loc.accuracyMeters === 'number' && isFinite(loc.accuracyMeters)) {
            entries.push({
                tag: 0x001F, type: T_RATIONAL, count: 1,
                data: rationalsToBytes([
                    [Math.round(loc.accuracyMeters * 100), 100],
                ]),
            });
        }

        // EXIF tags must be written in ascending tag order per the TIFF spec.
        entries.sort((a, b) => a.tag - b.tag);

        // ─── Compute sizes + offsets ────────────────────────────
        //
        // Layout from the start of the APP1 PAYLOAD (after the marker +
        // length bytes; "Exif\0\0" is the first 6 bytes inside the
        // payload). All offsets in the EXIF body are measured from the
        // TIFF header start (i.e. from the "MM" byte, immediately AFTER
        // "Exif\0\0").
        //
        //   [Exif\0\0]                      6 bytes
        //   [TIFF header]                   8 bytes:
        //     "MM" + 0x002A + offset(IFD0)
        //   [IFD0]                          2 + 12*1 + 4 = 18 bytes:
        //     count(1) +
        //     entry (tag=0x8825 GPSIFDPointer, type=LONG, count=1, value=offset(GPSIFD)) +
        //     next-IFD pointer (0)
        //   [GPS IFD]                       2 + 12*N + 4 bytes:
        //     count(N) + N entries + next-IFD pointer (0)
        //   [GPS IFD out-of-line data]      variable
        //
        // OUT-OF-LINE: any entry whose value-or-offset doesn't fit in 4
        // bytes lives here. We pack the data blobs end-to-end starting
        // immediately after the GPS IFD.
        //
        // CAREFUL: all offsets stored INSIDE EXIF entries are measured
        // from the start of the TIFF header (the "MM" byte). That's why
        // `ifd0Offset = 8` (the IFD0 starts 8 bytes after "MM": "MM"(2)
        // + 0x002A(2) + offset(4) = 8). All variables prefixed "tiff*"
        // below are in TIFF-relative offsets; everything is converted
        // back to absolute payload offsets (TIFF-relative + 6 for the
        // "Exif\0\0" prefix) at write time.
        const ifd0Offset = 8;
        const ifd0Size = 2 + 12 * 1 + 4;       // 18
        const gpsIfdOffset = ifd0Offset + ifd0Size;  // 26
        const gpsIfdSize = 2 + 12 * entries.length + 4;
        const outOfLineStart = gpsIfdOffset + gpsIfdSize;

        // Pre-compute out-of-line offsets per entry (only for entries
        // whose `data` doesn't fit in 4 bytes — i.e. data.length > 4).
        let tiffCursor = outOfLineStart;
        for (const e of entries) {
            if (e.data.length > 4) {
                e.outOfLineOffset = tiffCursor;
                tiffCursor += e.data.length;
                // EXIF spec recommends padding to 2 byte alignment but most
                // readers tolerate unpadded. Skip the pad for simplicity.
            } else {
                e.outOfLineOffset = -1;
            }
        }
        const totalTiffSize = tiffCursor;
        // EXIF APP1 payload = "Exif\0\0" (6 bytes) + TIFF block.
        const totalExifPayloadLen = 6 + totalTiffSize;
        // APP1 segment-length field counts the 2 length bytes themselves
        // PLUS the payload, but NOT the marker.
        const app1SegmentLen = 2 + totalExifPayloadLen;
        if (app1SegmentLen > 0xFFFF) {
            // Should never happen with our GPS-only block (well under 1 KB).
            throw new Error('EXIF APP1 segment too large: ' + app1SegmentLen);
        }

        // ─── Allocate + write ──────────────────────────────────
        // Marker (2) + length (2) + payload(totalExifPayloadLen)
        const buf = new ArrayBuffer(4 + totalExifPayloadLen);
        const view = new DataView(buf);
        let off = 0;
        // FF E1 APP1 marker
        off = writeU16BE(view, off, 0xFFE1);
        // length (includes the 2 length bytes themselves; does NOT include the marker)
        off = writeU16BE(view, off, app1SegmentLen);
        // "Exif\0\0"
        off = writeBytes(view, off, [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);
        // TIFF header: "MM" big-endian + 0x002A + offset to IFD0 (8)
        off = writeBytes(view, off, [0x4D, 0x4D]);
        off = writeU16BE(view, off, 0x002A);
        off = writeU32BE(view, off, ifd0Offset);
        // IFD0: 1 entry (GPSIFDPointer 0x8825 → gpsIfdOffset)
        off = writeU16BE(view, off, 1);
        off = writeU16BE(view, off, 0x8825);       // GPSIFDPointer
        off = writeU16BE(view, off, T_LONG);       // type LONG (4)
        off = writeU32BE(view, off, 1);            // count 1
        off = writeU32BE(view, off, gpsIfdOffset); // value = offset to GPS IFD
        off = writeU32BE(view, off, 0);            // next IFD = 0 (none)
        // GPS IFD: count + N entries + next-IFD pointer (0)
        off = writeU16BE(view, off, entries.length);
        for (const e of entries) {
            off = writeU16BE(view, off, e.tag);
            off = writeU16BE(view, off, e.type);
            off = writeU32BE(view, off, e.count);
            if (e.outOfLineOffset >= 0) {
                off = writeU32BE(view, off, e.outOfLineOffset);
            } else {
                // Inline value: write the bytes, then zero-pad to 4.
                for (let i = 0; i < 4; i++) {
                    view.setUint8(off + i, i < e.data.length ? e.data[i] : 0);
                }
                off += 4;
            }
        }
        off = writeU32BE(view, off, 0);            // next IFD = 0
        // Out-of-line blobs in the order entries were emitted.
        for (const e of entries) {
            if (e.outOfLineOffset >= 0) {
                // The cursor already points here because we walked
                // entries in the same order during pre-computation.
                off = writeBytes(view, off, e.data);
            }
        }
        return new Uint8Array(buf);
    }

    function rationalsToBytes(pairs) {
        // pairs: array of [numerator, denominator] → 8 bytes per pair,
        // numerator then denominator, both big-endian u32.
        const out = new Uint8Array(pairs.length * 8);
        const view = new DataView(out.buffer);
        for (let i = 0; i < pairs.length; i++) {
            view.setUint32(i * 8,     pairs[i][0] >>> 0, false);
            view.setUint32(i * 8 + 4, pairs[i][1] >>> 0, false);
        }
        return out;
    }

    function asciiBytes(str, totalLen) {
        const out = new Uint8Array(totalLen);
        for (let i = 0; i < totalLen; i++) {
            out[i] = i < str.length ? str.charCodeAt(i) : 0;
        }
        return out;
    }

    // Insert the APP1 segment into a JPEG byte array directly after the
    // SOI marker (FF D8). Replaces any existing APP1 (FF E1) so a
    // re-embed doesn't stack EXIF blocks. JFIF (FF E0) is left alone.
    function insertExifIntoJpeg(jpegBytes, app1Bytes) {
        if (jpegBytes.length < 4 || jpegBytes[0] !== 0xFF || jpegBytes[1] !== 0xD8) {
            // Not a JPEG; return as-is.
            return jpegBytes;
        }
        // Walk markers starting at byte 2 (after SOI).
        let p = 2;
        let dropStart = -1, dropEnd = -1;
        while (p + 4 < jpegBytes.length) {
            if (jpegBytes[p] !== 0xFF) break;
            const marker = jpegBytes[p + 1];
            // SOS (FF DA) = start-of-scan → image data follows; stop walking.
            if (marker === 0xDA) break;
            // Standalone markers (no length) — uncommon in modern JPEGs;
            // we don't expect them between SOI and the EXIF slot.
            const segLen = (jpegBytes[p + 2] << 8) | jpegBytes[p + 3];
            if (marker === 0xE1) {
                // Existing APP1 — drop it.
                dropStart = p;
                dropEnd = p + 2 + segLen;
                break;
            }
            p += 2 + segLen;
        }
        // Result = SOI + APP1 + (rest with optional APP1 removed)
        const tailStart = dropStart >= 0 ? dropEnd : 2;
        const out = new Uint8Array(2 + app1Bytes.length + (jpegBytes.length - tailStart));
        out[0] = 0xFF; out[1] = 0xD8;
        out.set(app1Bytes, 2);
        out.set(jpegBytes.subarray(tailStart), 2 + app1Bytes.length);
        return out;
    }

    /**
     * Public API — embed GPS EXIF into a JPEG blob.
     * Returns a Promise<Blob>; on any failure or missing GPS state,
     * resolves with the ORIGINAL blob (additive, never destructive).
     */
    async function embed(jpegBlob, locationState) {
        if (!jpegBlob || !locationState) return jpegBlob;
        const lat = Number(locationState.lat);
        const lng = Number(locationState.lng);
        if (!isFinite(lat) || !isFinite(lng)) return jpegBlob;
        try {
            const buf = await jpegBlob.arrayBuffer();
            const bytes = new Uint8Array(buf);
            const app1 = buildExifApp1({
                lat: lat, lng: lng,
                accuracyMeters: Number(locationState.accuracyMeters),
                heading: Number(locationState.heading),
            });
            const out = insertExifIntoJpeg(bytes, app1);
            return new Blob([out], { type: 'image/jpeg' });
        } catch (e) {
            // Defensive: any error → return original. The JSON payload still
            // carries the geotag, so a failure here is a "no enhancement"
            // outcome rather than a broken upload.
            // eslint-disable-next-line no-console
            console.warn('[exif-gps] embed failed, shipping original:', e);
            return jpegBlob;
        }
    }

    root.CrispExifGps = { embed: embed };
})(typeof window !== 'undefined' ? window : globalThis);
