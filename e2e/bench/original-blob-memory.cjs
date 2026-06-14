/**
 * Memory benchmark - base64-dataUrl vs retained-Blob for the ORIGINAL tier.
 *
 * Why deterministic, not a live-memory probe: V8's JS-heap counters
 * (performance.memory AND CDP JSHeapUsedSize) EXCLUDE large strings/ArrayBuffers
 * (large-object space) - a held 50 MB string reads as ~0. And macOS RSS is
 * confounded by memory compression (a 50 MB run of one byte compresses to ~KB).
 * So we measure the EXACT, reproducible quantity that matters: the byte length
 * of the base64 data URL that the OLD `_encodeVariants` materialized on the JS
 * heap AND wrote to IndexedDB for the ORIGINAL tier - vs the Blob the NEW path
 * keeps (off-heap; ~0 JS-heap cost). base64 is ASCII ⇒ V8 stores it as a
 * one-byte string, so its char length == its JS-heap byte cost.
 *
 * A high-entropy RSS corroboration (incompressible bytes, forced page-in) is
 * reported too, clearly labelled approximate.
 *
 * Run:  node e2e/bench/original-blob-memory.cjs
 */
const { chromium } = require('@playwright/test');
const { execSync } = require('child_process');

const rssMB = () => {
  try {
    const out = execSync("ps -axo rss=,command= | grep -i 'ms-playwright' | grep -v grep", { encoding: 'utf8' });
    let kb = 0; for (const l of out.trim().split('\n')) { const m = l.trim().match(/^(\d+)/); if (m) kb += +m[1]; }
    return kb / 1024;
  } catch (_) { return 0; }
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('about:blank');
  const settle = () => new Promise((r) => setTimeout(r, 500));

  // ---- Part 1: deterministic base64-size measurement (real FileReader) ----
  const det = await page.evaluate(async () => {
    const KB = 1024, MB = 1024 * 1024;
    const mkBlob = (bytes) => {
      const u8 = new Uint8Array(bytes);
      let x = 123456789;
      for (let i = 0; i < bytes; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; u8[i] = x & 0xff; }
      return new Blob([u8], { type: 'image/jpeg' });
    };
    const toDataUrl = (b) => new Promise((res, rej) => {
      const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(b);
    });
    // Measured base64 dataUrl length per ORIGINAL size (== one-byte-string heap bytes + IDB text bytes).
    const perTier = [];
    for (const mb of [1, 2, 3.5, 5]) {
      const blobBytes = Math.round(mb * MB);
      const du = await toDataUrl(mkBlob(blobBytes));
      perTier.push({ origMB: mb, blobBytes, base64Chars: du.length, inflation: +(du.length / blobBytes).toFixed(3) });
    }
    // Per-report OLD vs NEW (heap-resident base64 + IDB-persisted bytes).
    // small=50KB, medium=400KB, original=origMB. OLD base64s all three; NEW base64s small+medium, keeps original Blob.
    const b64len = (bytes) => 23 + Math.ceil(bytes / 3) * 4; // data:image/jpeg;base64, + 4/3 expansion
    const report = [];
    for (const [n, oMB] of [[1, 3.5], [3, 3.5], [5, 5], [3, 5]]) {
      const o = Math.round(oMB * MB), s = 50 * KB, m = 400 * KB;
      const smMedB64 = n * (b64len(s) + b64len(m));
      const oldHeap = smMedB64 + n * b64len(o);   // all tiers as base64 strings on heap
      const newHeap = smMedB64;                   // original is a Blob (off-heap)
      const oldIdb = oldHeap;                      // base64 text persisted
      const newIdb = smMedB64 + n * o;             // small/medium base64 text + original raw bytes
      report.push({
        config: `${n} photo(s) x ${oMB}MB original`,
        oldHeapBase64MB: +(oldHeap / MB).toFixed(2),
        newHeapBase64MB: +(newHeap / MB).toFixed(2),
        heapSavedMB: +((oldHeap - newHeap) / MB).toFixed(2),
        oldIdbMB: +(oldIdb / MB).toFixed(2),
        newIdbMB: +(newIdb / MB).toFixed(2),
        idbSavedMB: +((oldIdb - newIdb) / MB).toFixed(2),
      });
    }
    return { perTier, report };
  });

  // ---- Part 2: RSS corroboration (high-entropy, forced page-in) ----
  // Hold N incompressible ORIGINAL base64 strings vs N Blobs; measure ms-playwright RSS delta.
  async function rssHold(mode, n, origMB) {
    await settle(); const base = rssMB();
    await page.evaluate(async ({ mode, n, origMB }) => {
      const MB = 1024 * 1024;
      const mkBlob = (bytes) => { const u8 = new Uint8Array(bytes); let x = 99; for (let i = 0; i < bytes; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; u8[i] = x & 0xff; } return new Blob([u8], { type: 'image/jpeg' }); };
      const toDataUrl = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
      const o = Math.round(origMB * MB);
      window.__hold = [];
      for (let i = 0; i < n; i++) {
        if (mode === 'old') { const du = await toDataUrl(mkBlob(o)); let c = 0; for (let k = 0; k < du.length; k += 4096) c += du.charCodeAt(k); window.__hold.push(du); window.__c = c; }
        else { window.__hold.push(mkBlob(o)); }
      }
    }, { mode, n, origMB });
    await settle(); const held = rssMB();
    await page.evaluate(() => { window.__hold = null; });
    return held - base;
  }
  const rssOld = await rssHold('old', 5, 5);
  const rssNew = await rssHold('new', 5, 5);

  console.log(JSON.stringify({
    deterministic_base64_per_original: det.perTier,
    deterministic_per_report: det.report,
    rss_corroboration_5x5MB: {
      oldHoldsBase64StringsMB: +rssOld.toFixed(1),
      newHoldsBlobsMB: +rssNew.toFixed(1),
      note: 'Approximate (macOS compression/paging). High-entropy bytes used to resist compression.',
    },
  }, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
