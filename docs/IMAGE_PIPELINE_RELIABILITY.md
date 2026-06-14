# Image-Delivery Pipeline - Reliability & Retry Architecture

Production-readiness audit of the PWA image-upload pipeline (SMALL / MEDIUM /
ORIGINAL tiers). All line references are to `mobile-app/src/app.js` unless noted.
Verified read-only against the running stack (backend `:8000`, static `:8080`).

> **Scope note on "THUMB".** The pipeline uploads exactly **three** tiers -
> `SMALL`, `MEDIUM`, `ORIGINAL`. There is **no separately-uploaded THUMB tier.**
> The backend `GET /media/{id}/thumb` route (`backend/app/api/endpoints/reports.py:6665`)
> is a per-row redirect that serves `media.thumbnail_url` **if set**, else falls
> back to `media.url`. On the normal binary-variant path `thumbnail_url` is never
> populated, so the dashboard thumbnail resolves to the **SMALL** row's bytes
> (serializer `_thumb_url`, tier preference `SMALL→MEDIUM→ORIGINAL`,
> `reports.py:2006`). **THUMB ≡ SMALL, server-derived.** Wherever this document
> says "SMALL" it covers what the reviewer called "THUMB".

---

## 1. Retry architecture (per tier)

### Drain triggers (all converge on `startRetryLoop()`, def `app.js:10835`)
| Trigger | Site |
|---|---|
| App boot (`DOMContentLoaded`) | `app.js:15251` (after `_selfHealOrphans` `:15234` + boot reconcile `:15248`) |
| `online` event | `app.js:15318` |
| Periodic sweep - **5 min** (`_PERIODIC_SWEEP_MS`) | `app.js:15356,15366` |
| Heartbeat - **30 s** (`_HEARTBEAT_INTERVAL_MS`), fires only if silent ≥ 60 s with pending work | `app.js:15406` |
| `visibilitychange` (return to foreground) | `app.js:15374` |
| SW `SW_SYNC_WAKE` message | `app.js:15344` |

The loop body sleeps **15 s between passes** (`app.js:10911`). Each pass:
`_reconcileQueueAgainstServer()` → `getAllQueued()` → `trySendQueuedReport(item)` per item.

Three concurrency guards: in-process `_retryLoopRunning` (`:10773`), cross-tab
localStorage lock `_DRAIN_LOCK_TTL_MS=120 000` (`:10798`), per-report
`_inFlightReports` set (`:10125`). A wedge-recovery resets a stuck loop after
`_RETRY_LOOP_WEDGE_THRESHOLD_MS=60 000` of no chunk POST (`:10833`) - covers iOS
Safari killing an awaited fetch on suspension.

### Tier order & granularity
- `_buildVariantWork()` (`app.js:9331`) emits work **tier-outer, photo-inner**:
  `['small','medium','original']` × every photo → **SMALL of all photos first,
  then MEDIUM of all, then ORIGINAL of all**. Responders see every photo fast.
- The **photo stage flips on SMALL only** (`allSmallDone`, `app.js:10290-10295`).
  MEDIUM/ORIGINAL keep uploading on later passes while the IDB row persists.
- **Retry is per-tier, resumed per-chunk.** Each (photo,tier) is one backend
  `Media` row with its own `mediaId`, `chunkProgress`, `complete`, `deferred`.
  A failed chunk persists `variant.chunkProgress=seq` (`:9775`) and re-throws;
  the next pass resumes that tier from its last chunk. `chunkSize`+`total` are
  **frozen on first attempt** (`:9698`) so a probe-tier shift can't recompute
  `total` below `chunkProgress` and silently skip the loop (a real past bug).
  The backend is idempotent on `(media_id, seq_num)`.

### Constants (exact)
| Constant | Value | Site |
|---|---|---|
| `MAX_SEND_ATTEMPTS` | **20** | `app.js:10137` |
| `PAUSE_AFTER_EXHAUSTED_MS` (HC90 pause) | **1 h** | `app.js:10138` |
| Retry-loop interval | **15 s** | `app.js:10911` |
| Heartbeat | **30 s** | `app.js:15406` |
| Periodic sweep | **5 min** | `app.js:15356` |
| `CHUNK_HARD_FAIL_K` | **3** | `app.js:9382` |
| `CHUNK_MEDIAID_REGEN_R` | **2** | `app.js:9383` |
| Hard-4xx set | `{400,409,410,422}` | `app.js:9384` |
| `sendWithRetry` retries / timeout | 7 / 30 s | `app.js:8343` |
| `sendBinaryChunkWithRetry` retries / timeout | 5 / 30 s | `app.js:8453` |
| Backoff | `min(2000·2^(n-1), 30000)` + 0-999 ms jitter → 2/4/8/16/30/30… s | `app.js:8336` |
| Per-tier 24 h give-up cap (`_ONE_DAY_MS`) | **24 h** | `app.js:9614` |
| Deferred-tier 14-day cap (`_DEFERRED_TIMEOUT_MS`) | **14 d** | `app.js:11893` |

**HC90 (attempts-exhausted):** after **20 consecutive *progress-free* passes
(~5 min)** a report pauses **1 h**, then auto-resumes (`:10146-10160`). The
counter **resets on any stage progress** (`:10744-10763`), so a slow-but-advancing
report never trips it. After ≥3 pause cycles it raises a **calm needs-attention
flag** (`:10173`) but never stops delivery.

**Stuck-chunk recovery (`_maybeRecoverStuckChunk`, `:9430`)** fires only on a hard
4xx: retry same row `<K`, then regenerate `mediaId` `<R` times, then give up *that
tier* (`chunkRejectedGiveUp` sticky). Transient 5xx/timeout never trigger it.

### Deferred reasons (client → backend)
`orphan_no_source`; `24h_timeout`→`bandwidth_tier_deferred`;
`chunk_rejected`→`encode_failed`; reconcile soft-drain→`bandwidth_tier_deferred`.
Backend accepts exactly `{bandwidth_tier_deferred, encode_failed, orphan_no_source}`
(`reports.py:4663`). **`deferred` is a hint, not a stop** - every pass re-attempts a
deferred tier and clears the flag on resume (`:9648`), EXCEPT the two sticky
terminals: client `chunkRejectedGiveUp`, and backend **410 hard-abandon**
(`checksum_mismatch`, `original_too_large` > 5 MB).

---

## 2. How long uploads retry when offline

- **While offline:** the sweep/heartbeat are gated on `navigator.onLine`
  (`:15360,15411`), so a fully-offline report simply **sits queued** - HC90's
  counter does not accrue (no upload attempts complete), and **no time-cap fires
  while offline** (the 24 h/14 d caps execute inside the upload path, only on an
  actual attempt).
- **A never-sent report has an *unbounded* client retry horizon.** There is **no
  client TTL that deletes a queued-but-never-sent report** - `_reconcileQueueAgainstServer`
  only arms the 14-day deferred timer *after SMALL has landed server-side*
  (`_deferredSince`, `app.js:11900`). So an offline report waits **indefinitely**
  for connectivity and is attempted on the next online drain.
- **Per-attempt bound once online:** HC90 pauses 1 h after ~5 min of progress-free
  failures, then auto-resumes - cyclically, forever, never terminal.
- **Time caps that *do* drop higher tiers** (measured from submit, not from
  reconnect): a non-SMALL tier still incomplete **24 h** after submit is deferred
  (`:9614`); a SMALL-landed-but-higher-tier-deferred report is dequeued at **14 d**
  (`:11911`, logged "Originals permanently lost on this device").

**Net:** offline retry is effectively **forever for SMALL**; MEDIUM/ORIGINAL are
retried until they land or until the **24 h** (per tier) / **14 d** (post-SMALL)
caps.

---

## 3. Lifecycle behavior

Queue = IndexedDB `crisp-offline` / store `pending-reports` (`app.js:459-461`;
SW confirms same DB `sw.js:2537-2541`). IndexedDB is durable + origin-scoped.

| Event | Queue survives? | Drain resumes? | Notes |
|---|---|---|---|
| **Browser restart** | **Yes (guaranteed)** - only manual reset clears it (`:15614`) | Yes - boot path `DOMContentLoaded:15146 → startRetryLoop:15251` | resumes from persisted `chunkProgress` |
| **Device restart** | **Yes** (on-disk IDB) | Yes - same boot path; SW re-registers on `window load` (`:84`) | in-RAM-only state (`_inFlightReports`, tier) rebuilt; no data risk |
| **SW update (CACHE_NAME bump)** | **Yes - IDB untouched.** `activate` deletes only Cache-Storage keys ≠ CACHE_NAME (`sw.js:2196-2204`); no `deleteDatabase`/`clear` anywhere in install/activate | Yes - page reload after `controllerchange` re-runs boot path | uploads run **page-side**, not in the SW; SW skips modern variant items (`sw.js:2423`) and just wakes the page; an interrupted chunk re-sends idempotently |
| **24 h offline** | Yes | On reconnect | **SMALL kept**; MEDIUM/ORIGINAL hit the 24 h cap (`:9614`) → deferred + `needs-attention` + honest dashboard chip (not silent) |
| **7 d offline** | Yes (never-sent horizon is unbounded) | On reconnect | **SMALL lands**; MEDIUM/ORIGINAL are **>24 h old → 24 h cap fires on the first attempt** → deferred immediately. Report ends **SYNCED on SMALL** |

Backend daemon (`backend/app/main.py`, all env-overridable): sweep **300 s**
(`:705`), abandon-stale **30 m** (`:706`), assemble-deadline **30 m** (`:707`),
assembler-wedged **60 m** (`:717`), partial-promote-idle **60 s** (`:728`),
hard-abandon **30 d** (`:737`).

---

## 4. Mode B - variants absent at submit  *(FIXED)*

**Problem.** When a photo's async `ImageVariants.generate()` had not finished
within the submit budget (`SUBMIT_BLUR_WAIT_MS=500` `app.js:8736` +
`_reattemptMissingVariants` deadline `1500 ms` `app.js:6716`, **shared across all
photos, processed sequentially** - so the *last* photos of a multi-capture were
starved), that photo was enqueued with **null variants**. The ORIGINAL tier is
not cheap to produce (a full-res q=0.95 EXIF-strip re-encode, `image-variants.js:128`),
so this race is real on slow devices / large captures. Consequences:
- **All-null report** → delivered via the legacy untiered path (one MEDIUM-tagged
  row, adaptive-quality preview, no SMALL/ORIGINAL tiering).
- **MIXED multi-photo report** → the null-variant photo was **silently dropped
  entirely**: the drain dispatch is `if (workUnits) {…} else if (item.photo)
  {legacy}` (`app.js:10258/10425`), so the legacy branch is skipped whenever any
  *sibling* photo has variants, and the null-variant photo's bytes (held only in
  `item.extraPhotos[i]`) were uploaded by **no** path.
- **Permanent** - there was no post-submit regeneration (`pre_encode_pending` is
  referenced only in comments; never implemented).

**Fix (implemented).** Retain the full-res source blob on the queue row and
regenerate tiers in the drain:
1. **Submit** (`app.js` construction) now stores `photoSourceBlob` (when the main
   lacks variants) and `extraSourceBlobs[]` (per extra lacking variants), copied
   from `state.photoBlob`/`ep.blob` **before** `_clearCaptureState` wipes them.
   Retained ONLY when variants are absent → zero footprint on normal reports.
2. **Drain** calls new `_regenerateMissingVariants(item)` **before**
   `_buildVariantWork` (`trySendQueuedReport`). For any photo with null variants +
   a retained source blob it runs `ImageVariants.generate()` (unbounded time, off
   the submit critical path), builds the variant struct via
   `_queueVariantStructFromGenerated` (SMALL/MEDIUM base64, ORIGINAL kept as a
   Blob per §6), assigns a group id, clears the source blob, and persists.
3. Because `generate()` returns all tiers for any decodable blob (internal
   `blurredSrc` fallbacks), after one drain pass **no null-variant photo with a
   source blob remains** → the mixed-drop is **structurally closed**, and the
   raced photo recovers full SMALL/MEDIUM/ORIGINAL tiering + archival fidelity.

`expected_media` is intentionally **not** bumped for source-blob photos
(over-delivery - received ≥ expected - is benign and SYNCs; bumping would risk an
expected>received stall if `generate()` ever returned null). The submit budget is
unchanged (instant-return preserved); regeneration is purely a drain-time
recovery. **Tested:** `e2e/tests/pwa/93-modeb-variant-regeneration.spec.ts` (mixed
extra regenerated-not-dropped; all-null main regenerated; idempotent no-op) +
happy-path `99-validation-01` regression (5/5) + `node -c`.

**Residual (documented, negligible):** a photo whose source blob is itself
undecodable AND in a mixed report could still be dropped - but that requires
`generate()` to throw past its internal fallbacks (≈never when `ImageVariants` is
present; when it's absent, NO photo gets variants → all-null → legacy path covers
all). Pre-existing corrupt-row backstops (`_backstopPhotoIntendedNoBytes`,
`_isOrphanQueueRow`) cover byte-less rows.

---

## 5. Real-device HEIC testing under poor network  *(automated proxy done; physical device = operator)*

Automated proxy (desktop Chromium + emulated network + **real iPhone HEIC
fixtures**, asserting against the **real backend DB**):
| Spec | Condition | Result (repeated) |
|---|---|---|
| `99-validation-01` | online happy, 5 HEIC fixtures | 12/12 - tiers `['MEDIUM','ORIGINAL','SMALL']` all `complete` |
| `99-validation-10` | 30 % packet loss | **4/4** after de-flake (see below) - SYNCED, 3 tiers, no dup rows |
| `99-validation-03` | 2 kbps sustained | SMALL lands < 90 s; MEDIUM/ORIGINAL complete-or-deferred (graceful) |
| `99-validation-04` | 3× wifi flaps | 2/2 - SYNCED, no duplicate rows |

**De-flake:** the packet-loss spec was *self*-flaky - it asserted its own
`Math.random()` dropped > 15 % of chunks (`actualDropRate > DROP_RATE - 0.15`),
which has high variance on a low chunk count and fired **after** the app
assertions passed. Replaced with: always drop the first POST (deterministic
retry-through-loss exercise) + assert `drops > 0`. App assertions (SYNCED + 3
tiers complete + no duplicate Media rows) were never the failure. → packet-loss
now **4/4 stable**.

**Limitations (require the operator's physical device):**
1. Desktop Chromium has ample RAM, so these **cannot reproduce the device-specific
   ORIGINAL `readAsDataURL` OOM** the Blob fix targets (§6). The fix is validated
   by the deterministic memory benchmark + the blob-upload unit spec, not by an
   on-device OOM repro.
2. The validation suite is **single-photo per spec**; the *multi-photo* ORIGINAL
   path is covered by mocked specs (`93-original-blob-upload`,
   `93-modeb-variant-regeneration`), not by a real-HEIC-multi-photo-under-throttle
   e2e.

**Operator protocol (physical iPhone, ≥2 reports each):** Safari PWA on a
memory-constrained iPhone (e.g. SE/mini) → capture **3-5 large HEIC photos** in
one report under (a) good wifi, (b) Network Link Conditioner "3G"/"Edge",
(c) airplane-mode-then-reconnect. After each, confirm on the dashboard that
**every** photo shows a full-res ORIGINAL (not just a thumbnail). Repeat 3-5×
to surface the intermittent OOM. Check the PWA console for
`[submitReport] failed to encode … variant` (should be gone) and `[regen] …`
(Mode B recovery firing).

---

## 6. Memory: base64-dataUrl vs retained-Blob ORIGINAL

The pre-fix `_encodeVariants` ran `FileReader.readAsDataURL` over **every** tier,
including the multi-MB ORIGINAL, and held the base64 string in the queue item +
wrote it to IDB. base64 is ASCII → V8 one-byte string ~**1.333×** the source
bytes on the heap. The fix keeps ORIGINAL as a **Blob** (browser-managed, off the
JS heap). Measured (`e2e/bench/original-blob-memory.cjs`):

| Config | OLD heap (base64) | NEW heap | Heap saved | IDB saved |
|---|---|---|---|---|
| 1 photo × 3.5 MB | 5.25 MB | 0.59 MB | **4.7 MB** | 1.2 MB |
| 3 photos × 3.5 MB | 15.76 MB | 1.76 MB | **14 MB** | 3.5 MB |
| 3 photos × 5 MB | 21.76 MB | 1.76 MB | **20 MB** | 5 MB |
| 5 photos × 5 MB | 36.26 MB | 2.93 MB | **33 MB** | 8.3 MB |

RSS corroboration (5×5 MB, high-entropy, forced page-in): renderer holding base64
strings **32.4 MB** vs holding Blobs **1.8 MB**. (Note: V8 heap *counters* exclude
large strings/buffers - large-object space - so `performance.memory`/CDP read ~0;
the deterministic base64-length measurement is the authoritative figure.)

The OOM mechanism removed: a synchronous 15-36 MB one-byte-string spike during
submit→IDB-write on a memory-constrained device → `readAsDataURL` throws → caught
at `app.js:9093` → `original.dataUrl=null` → ORIGINAL never uploads.

---

## 7. Delivery guarantee - precise statement

**The system guarantees eventual delivery of the SMALL tier per photo group
only.** MEDIUM and ORIGINAL are **best-effort progressive enhancement.** A report
**always converges to SYNCED on SMALL alone**; a lost higher tier is surfaced as
an honest dashboard chip + needs-attention flag, **never silently absent**.

SMALL is the only hard gate: `_reconcileBeforeDequeue` rolls back + re-queues if
SMALL is missing server-side (`app.js:10618`), and backend Action ④ refuses to
promote a group with no complete tier. `mark-deferred` floors `expected_media` at
`received_media` and refuses to abandon an already-`complete` tier, so a landed
tier is never falsely dropped.

**Conditions under which MEDIUM/ORIGINAL are permanently dropped while the report
reads SYNCED** (9 paths): 24 h cap (`:9614`); 14-day deferred cap (`:11911`);
reconcile soft-drain when no server row exists (`:10520`); reconcile
wait-exhausted (>3 min, `:10669`); per-chunk hard-fail after K×R (`:9463`);
orphan-no-source (`:9532`); zero-bytes backstop (`:9895`); backend hard-abandon GC
30 d (`main.py:1120`); backend abandon-stale/assemble-deadline/wedged
(`main.py:706-717`). In every case `expected_media` is decremented to match the
delivered reality so the SYNCED gate (`received≥expected`) holds.

> This is a deliberate design choice (fast SMALL on poor pipes; higher tiers when
> bandwidth/time allow). The ORIGINAL **Blob fix** + **Mode B fix** (§4) raise the
> *probability* that MEDIUM/ORIGINAL land, but do **not** convert them into hard
> guarantees. If a hard ORIGINAL guarantee is required, the 24 h cap (`:9614`)
> would need to be removed/extended and the partial-promote (`main.py` Action ④)
> gated on all-tiers-complete - a product decision with offline-UX tradeoffs.

---

## 8. Reconnect double-upload fix (wedge-recovery) - Jun 2026

**Symptom (found on a real iPhone, airplane-mode test):** after a >60 s offline
gap, on reconnect the retry loop ran **two concurrent passes** and re-uploaded
in-progress tiers from chunk 0 (~2× bandwidth). Correctness held (backend
idempotent on `(media_id, seq)`; stable media ids → no dupe rows, report SYNCED),
but it doubled upload volume on the worst networks.

**Root cause:** `startRetryLoop`'s wedge-recovery (`app.js`) decided "loop is
wedged" from `_lastChunkPostAt` - the *last successful POST*. An offline stretch
lands zero successful POSTs, so the loop looked wedged even though it was alive
and cycling. On reconnect a trigger (`online`/heartbeat) fired the wedge, cleared
the concurrency guards (`_retryLoopRunning`, drain lock, `_inFlightReports`), and
a second pass ran alongside the first. "No successful POST in 60 s" couldn't
distinguish a *frozen* loop from an *alive-but-offline* one.

**Fix (3 parts, all in `app.js`):**
1. **Liveness clock** - renamed `_lastChunkPostAt` → `_lastDrainTickAt`, now
   stamped on **every loop iteration + per item + successful POST**. The wedge
   reads loop *liveness*, not POST *success*.
2. **Offline-skip** - when `navigator.onLine === false` the loop skips doomed
   upload attempts (it still ticks + exits on empty queue), so it stays "fresh"
   and doesn't waste battery; it resumes seamlessly on reconnect from each tier's
   persisted `chunkProgress` (resume-from-offset unchanged).
3. **Explicit online guard** - the wedge decision (extracted to the pure,
   testable `_isLoopWedged(...)`) requires `navigator.onLine`. Offline ⇒ never
   wedged. A genuinely frozen loop (iOS killed an awaited fetch while ONLINE)
   still goes stale + is still recovered - preserved.

**Validation (`e2e/tests/pwa/97-wedge-recovery-offline.spec.ts`):**
- Decision (pure, deterministic): airplane-30s, offline-90s, genuine-wedge,
  reconnect, browser/device-restart, empty-queue - all assert correctly.
- Resume-from-offset: a tier resumes from `chunkProgress` and never re-POSTs
  delivered chunks (no duplicate uploads).
- End-to-end (real backend): 75 s offline → reconnect → **SYNCED, every chunk
  POSTed exactly once, zero duplicate media rows**.
- Bug-catch proof: removing the online guard makes the offline-90s test fail.
- Regression: `94-drain-mutex`, `96-reconcile`, `99-validation-01/02` green.
